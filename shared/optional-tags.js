// optional-tags.js — operator-selectable overlay tags (e.g. `erc`).
//
// Renders the checkbox list defined by `optionalTags` in regions.json, with an
// accessible info bubble per entry. Self-contained: injects its own CSS once, so
// both the config wizard (inline <style>) and the map (public/styles.css) can use
// it without duplicating rules.
//
// Overlay tags are never geographic. They have no polygon, never appear as a
// resolution result, and are only added because the operator asked for them.
//
// Usage:
//   import { mountOptionalTags } from "../shared/optional-tags.js";
//   const optTags = mountOptionalTags({
//     container: document.getElementById("opt-tags"),
//     defs: OPTIONAL_TAGS,
//     hierarchy: HIERARCHY,
//     onChange: (tags) => { S.optionalTags = tags; recompute(); },
//   });
//   optTags.selected();   // -> ["erc"]
//   optTags.reset();      // back to each entry's `default`

const STYLE_ID = "optional-tags-styles";

const CSS = `
.opt-tags { margin-top: 1.1rem; }
.opt-tags-divider { border: none; border-top: 1px solid var(--border, #d8e3dc); margin: 1.1rem 0; }
.opt-row { display: flex; align-items: center; gap: 0.5rem; position: relative; }
.opt-row[hidden] { display: none; }
.opt-tags-divider[hidden] { display: none; }
.opt-row + .opt-row { margin-top: 0.55rem; }
.opt-label {
  display: inline-flex; align-items: center; gap: 0.5rem;
  font-size: 0.9rem; color: var(--text, #1b2b22);
  cursor: pointer; user-select: none; line-height: 1.35;
}
.opt-label input[type="checkbox"] {
  width: 15px; height: 15px; flex-shrink: 0; margin: 0;
  accent-color: var(--green, #2d6a4f); cursor: pointer;
}
.opt-info-btn {
  width: 17px; height: 17px; flex-shrink: 0; padding: 0;
  border-radius: 50%; border: 1.5px solid var(--border, #d8e3dc);
  background: var(--surface, #fff); color: var(--text-muted, #6b8177);
  font-family: inherit; font-size: 0.7rem; font-weight: 700; line-height: 1;
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; transition: border-color 0.12s, color 0.12s;
}
.opt-info-btn:hover, .opt-info-btn:focus-visible {
  border-color: var(--green, #2d6a4f); color: var(--green-dark, #1b4332); outline: none;
}
.opt-info-pop {
  position: absolute; left: 0; top: calc(100% + 0.45rem); z-index: 30;
  max-width: 30rem;
  background: var(--surface, #fff);
  border: 1px solid var(--border, #d8e3dc);
  border-radius: 9px;
  box-shadow: var(--shadow, 0 4px 16px rgba(0,0,0,0.10));
  padding: 0.7rem 0.85rem;
  font-size: 0.82rem; line-height: 1.45; color: var(--text-muted, #6b8177);
}
.opt-info-pop[hidden] { display: none; }
@media (max-width: 560px) { .opt-info-pop { max-width: none; right: 0; } }
`;

function injectStyles(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const el = doc.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  doc.head.appendChild(el);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

let uid = 0;

/**
 * @param {Object}      o
 * @param {HTMLElement} o.container   element to render into
 * @param {Array}       o.defs        regions.json `optionalTags`
 * @param {Object}      o.hierarchy   regions.json `hierarchy`
 * @param {Function}   [o.onChange]   called with the selected tag array
 * @param {boolean}    [o.divider]    draw a top divider (default true)
 * @returns {{selected: Function, reset: Function, count: number}}
 */
export function mountOptionalTags({ container, defs, hierarchy, onChange, divider = true }) {
  if (!container) throw new Error("mountOptionalTags: container is required");
  const doc = container.ownerDocument;
  injectStyles(doc);

  // Silently drop entries whose tag isn't in the hierarchy — a typo in
  // regions.json shouldn't emit a tag no node will ever match.
  const entries = (defs || []).filter((d) => d && d.tag && hierarchy[d.tag]);

  container.classList.add("opt-tags");
  if (!entries.length) {
    container.innerHTML = "";
    container.hidden = true;
    return { selected: () => [], reset: () => {}, refresh: () => 0, count: 0 };
  }
  container.hidden = false;

  const ns = `opt${uid++}`;
  container.innerHTML =
    (divider ? '<hr class="opt-tags-divider">' : "") +
    entries
      .map((d, i) => {
        const popId = `${ns}-pop-${i}`;
        const label = d.label || hierarchy[d.tag].label || d.tag;
        // Screen readers get the full region name rather than the checkbox's short
        // call to action ("About Emergency Response Communications", not
        // "About Support ERC Region").
        const infoName = hierarchy[d.tag].label || label;
        const info = d.info
          ? `<button type="button" class="opt-info-btn" data-pop="${popId}"
                     aria-expanded="false" aria-controls="${popId}"
                     aria-label="About ${esc(infoName)}">i</button>
             <div class="opt-info-pop" id="${popId}" role="note" hidden>${esc(d.info)}</div>`
          : "";
        return `<div class="opt-row" data-tag="${esc(d.tag)}">
            <label class="opt-label">
              <input type="checkbox" value="${esc(d.tag)}"${d.default ? " checked" : ""}>
              ${esc(label)}
            </label>${info}
          </div>`;
      })
      .join("");

  const boxes = () => [...container.querySelectorAll('input[type="checkbox"]')];
  const rowOf = (box) => box.closest(".opt-row");
  // A hidden row's state is irrelevant to the current repeater type, so it is not
  // reported as selected.
  const selected = () =>
    boxes().filter((b) => b.checked && !rowOf(b).hidden).map((b) => b.value);

  container.addEventListener("change", () => {
    if (typeof onChange === "function") onChange(selected());
  });

  // ── Info bubbles ──────────────────────────────────────────────────────────
  const closeAll = () => {
    container.querySelectorAll(".opt-info-pop").forEach((p) => { p.hidden = true; });
    container.querySelectorAll(".opt-info-btn").forEach((b) =>
      b.setAttribute("aria-expanded", "false")
    );
  };

  container.querySelectorAll(".opt-info-btn").forEach((btn) => {
    const pop = doc.getElementById(btn.dataset.pop);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const wasOpen = btn.getAttribute("aria-expanded") === "true";
      closeAll();
      if (!wasOpen) {
        pop.hidden = false;
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });

  container.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });
  doc.addEventListener("click", (e) => { if (!container.contains(e.target)) closeAll(); });

  // Show only the rows whose `showFor` includes this repeater type (entries with
  // no showFor are always visible). Checked state survives a refresh.
  const refresh = (repeaterType) => {
    let visible = 0;
    for (const row of container.querySelectorAll(".opt-row")) {
      const def = entries.find((d) => d.tag === row.dataset.tag);
      const show = !def || !Array.isArray(def.showFor) || def.showFor.includes(repeaterType);
      row.hidden = !show;
      if (show) visible++;
    }
    const divider = container.querySelector(".opt-tags-divider");
    if (divider) divider.hidden = visible === 0;
    container.hidden = visible === 0;
    closeAll();
    if (typeof onChange === "function") onChange(selected());
    return visible;
  };

  const reset = () => {
    boxes().forEach((b) => {
      const def = entries.find((d) => d.tag === b.value);
      b.checked = !!(def && def.default);
    });
    closeAll();
    if (typeof onChange === "function") onChange(selected());
  };

  if (typeof onChange === "function") onChange(selected());

  return { selected, reset, refresh, count: entries.length };
}
