// polygon-resolver.js — region resolution by polygon containment.
//
// Replaces the additively-weighted-Voronoi seed ranking from the upstream
// Pacific Northwest tools (Adam Gessaman, https://gessaman.com/) with a
// polygon layer, for a mesh whose coverage is valley-constrained and does not
// approximate well as circles around seeds.
//
// Resolution rules:
//   1. Find every polygon containing the point.
//   2. Primary is the DEEPEST one in the hierarchy. Depth beats geometry, so a
//      sliver of `ida` poking outside `e-id` after simplification still yields a
//      coherent ancestry chain — the tree supplies ancestry, not containment.
//   3. Ties within the deepest tier (intentional dual-carry overlaps) break by
//      FURTHEST INSIDE: the polygon whose boundary is farthest away wins.
//   4. Everything else ranks by distance to boundary, giving `secondary`,
//      `top5`, `gapKm` and `overlapLikely` — the same signals the config wizard
//      and map already consume.
//
// No dependencies. Distances use a local equirectangular approximation, which
// is well under 0.1% error at Intermountain West latitudes and spans.

const KM_PER_DEG = 111.32;

/* ---------- geometry helpers ---------- */

// Project lon/lat to local km-ish planar coords around an origin latitude.
function proj(lon, lat, cosLat) {
  return [lon * cosLat * KM_PER_DEG, lat * KM_PER_DEG];
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) &&
        lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

// polygon = [outerRing, hole1, hole2, ...]
function pointInPolygon(lon, lat, polygon) {
  if (!pointInRing(lon, lat, polygon[0])) return false;
  for (let h = 1; h < polygon.length; h++) {
    if (pointInRing(lon, lat, polygon[h])) return false;
  }
  return true;
}

function segDistKm(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// Shortest distance from point to any ring edge, in km.
function distToBoundaryKm(lon, lat, polygons) {
  const cosLat = Math.cos((lat * Math.PI) / 180);
  const [px, py] = proj(lon, lat, cosLat);
  let best = Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [ax, ay] = proj(ring[j][0], ring[j][1], cosLat);
        const [bx, by] = proj(ring[i][0], ring[i][1], cosLat);
        const d = segDistKm(px, py, ax, ay, bx, by);
        if (d < best) best = d;
      }
    }
  }
  return best;
}

function bboxOf(polygons) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const polygon of polygons) {
    for (const [lon, lat] of polygon[0]) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  }
  return [w, s, e, n];
}

/* ---------- index ---------- */

// Normalise a FeatureCollection into a flat array of {tag, polygons, bbox}.
// `polygons` is always an array of polygons, so Polygon and MultiPolygon are
// handled identically downstream.
export function buildPolygonIndex(geojson, opts = {}) {
  const tagProp = opts.tagProperty || 'region';
  const entries = [];
  for (const f of geojson.features || []) {
    const tag = f.properties && f.properties[tagProp];
    if (!tag || !f.geometry) continue;
    const g = f.geometry;
    const polygons =
      g.type === 'Polygon' ? [g.coordinates]
      : g.type === 'MultiPolygon' ? g.coordinates
      : null;
    if (!polygons) continue;
    entries.push({ tag: String(tag).trim(), polygons, bbox: bboxOf(polygons) });
  }
  return entries;
}

/* ---------- hierarchy helpers ---------- */

export function depthOf(tag, hierarchy) {
  let d = 0, cur = tag, guard = 0;
  while (hierarchy[cur] && hierarchy[cur].parent && guard++ < 64) {
    cur = hierarchy[cur].parent;
    d++;
  }
  return d;
}

export function ancestryFor(tag, hierarchy) {
  const chain = [];
  let cur = tag, guard = 0;
  while (cur && guard++ < 64) {
    chain.unshift(cur);
    cur = hierarchy[cur] ? hierarchy[cur].parent : null;
  }
  return chain;
}

function isRelated(a, b, hierarchy) {
  return ancestryFor(a, hierarchy).includes(b) ||
         ancestryFor(b, hierarchy).includes(a);
}

/* ---------- resolution ---------- */

/**
 * @param {number} lat
 * @param {number} lon
 * @param {Array}  index      from buildPolygonIndex()
 * @param {Object} hierarchy  regions.json `hierarchy`
 * @param {Object} opts
 *   extentTag   tag used as the in-area mask, never a primary   (default 'imw')
 *   snapKm      snap to nearest region within this distance      (default 50)
 *   overlapKm   secondary this close sets overlapLikely          (default 8)
 *   topN        length of the override list                      (default 5)
 * @returns {{
 *   outOfArea: boolean,
 *   snapped: boolean,
 *   primary: ?Object, secondary: ?Object, top5: Array,
 *   containing: Array, gapKm: ?number, overlapLikely: boolean
 * }}
 */
export function resolveByPolygon(lat, lon, index, hierarchy, opts = {}) {
  const extentTag = opts.extentTag || 'imw';
  const snapKm    = opts.snapKm    ?? 50;
  const overlapKm = opts.overlapKm ?? 8;
  const topN      = opts.topN      ?? 5;

  const EMPTY = {
    outOfArea: true, snapped: false, primary: null, secondary: null,
    top5: [], containing: [], gapKm: null, overlapLikely: false,
  };

  const label = (t) => (hierarchy[t] && hierarchy[t].label) || t;

  // Score every polygon once.
  const scored = [];
  let insideExtent = false;
  for (const entry of index) {
    const [w, s, e, n] = entry.bbox;
    // A point more than `margin` degrees outside the bbox cannot be inside the
    // polygon, and is too far to be a useful neighbour in the override list.
    const margin = opts.neighbourMarginDeg ?? 2;
    const near = lon >= w - margin && lon <= e + margin &&
                 lat >= s - margin && lat <= n + margin;
    const inBox = lon >= w && lon <= e && lat >= s && lat <= n;
    const inside = inBox && entry.polygons.some((p) => pointInPolygon(lon, lat, p));

    if (entry.tag === extentTag) { insideExtent = inside; continue; }
    if (!near) continue;

    const d = distToBoundaryKm(lon, lat, entry.polygons);
    scored.push({
      tag: entry.tag,
      label: label(entry.tag),
      ancestry: ancestryFor(entry.tag, hierarchy),
      depth: depthOf(entry.tag, hierarchy),
      inside,
      insetKm: inside ? d : 0,   // how far inside the boundary
      km: inside ? 0 : d,        // distance to the region (0 when inside)
    });
  }

  if (!scored.length) return EMPTY;

  const insideSet  = scored.filter((r) => r.inside);
  const outsideSet = scored.filter((r) => !r.inside);

  // Deepest first; within a tier, furthest inside wins.
  insideSet.sort((a, b) => (b.depth - a.depth) || (b.insetKm - a.insetKm));
  outsideSet.sort((a, b) => a.km - b.km);

  let ranked = [...insideSet, ...outsideSet];
  let snapped = false;

  if (!insideSet.length) {
    // In a gap, or outside the mesh entirely.
    const nearest = outsideSet[0];
    if (!insideExtent && (!nearest || nearest.km > snapKm)) return EMPTY;
    if (!nearest || nearest.km > snapKm) return { ...EMPTY, outOfArea: false };
    snapped = true;
  }

  const primary = ranked[0];

  // The override list shows peers, not the primary's own ancestors.
  const top5 = ranked
    .filter((r) => r.tag === primary.tag || !isRelated(r.tag, primary.tag, hierarchy))
    .slice(0, topN);

  const secondary = ranked.find(
    (r) => r.tag !== primary.tag && !isRelated(r.tag, primary.tag, hierarchy)
  ) || null;

  return {
    outOfArea: false,
    snapped,
    primary,
    secondary,
    top5,
    containing: insideSet,
    gapKm: secondary ? Number(secondary.km.toFixed(2)) : null,
    overlapLikely: !!secondary && secondary.km <= overlapKm,
  };
}
