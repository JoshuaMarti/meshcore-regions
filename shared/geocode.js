"use strict";

// ── Geocoding ───────────────────────────────────────────────────────────────
// Shared address/ZIP geocoder used by both /config and /map so a typed location
// resolves to lat/lon + state identically in both tools.
//
// US-only in this fork. Upstream also handled Canadian postal codes via a
// geocoder.ca fallback; that path is removed along with the BC regions.

import { META } from "./region-engine.js";

function parseNominatimHit(hit) {
  const parts = hit.display_name.split(",").map(s => s.trim());
  const name  = parts.slice(0, Math.min(3, parts.length)).join(", ");
  const addr  = hit.address ?? {};
  return {
    lat: parseFloat(hit.lat),
    lon: parseFloat(hit.lon),
    name,
    stateOrProvince: addr.state ?? addr.province ?? null
  };
}

export async function nominatimSearch(params) {
  // Nominatim's usage policy asks for an identifying contact on every request.
  // Browsers forbid setting User-Agent from fetch(), so the documented alternative
  // is the `email` query parameter — set meta.geocoderContact in regions.json.
  const contact = META.geocoderContact;
  const url = "https://nominatim.openstreetmap.org/search?" + new URLSearchParams({
    format: "json", limit: "1", addressdetails: "1",
    ...(contact ? { email: contact } : {}),
    ...params
  });
  const res = await fetch(url, { headers: { "Accept-Language": "en-US,en" } });
  if (!res.ok) throw new Error("Geocoding service error");
  const data = await res.json();
  return data.length ? parseNominatimHit(data[0]) : null;
}

// A bare 5-digit ZIP is ambiguous as free text (Nominatim often returns a street
// number), so route it through the postalcode field first.
function parseUsZip(query) {
  const m = query.trim().match(/^(\d{5})(?:-\d{4})?$/);
  return m ? m[1] : null;
}

export async function geocode(query, countryCodes = "us") {
  const zip = parseUsZip(query);
  if (zip) {
    const fromZip = await nominatimSearch({ postalcode: zip, countrycodes: countryCodes });
    if (fromZip) return fromZip;
  }

  const hit = await nominatimSearch({ q: query, countrycodes: countryCodes });
  if (hit) return hit;
  throw new Error("No matching location found");
}
