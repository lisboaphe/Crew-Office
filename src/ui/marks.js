// Source marks for the office picker, the switcher rows and the title-bar pill.
//
// Two kinds live here, and the difference matters:
//
//   - **Real brand marks** (`brandMark`) are each vendor's own official asset,
//     verbatim. A logo is the fastest thing to recognise in a row of five, so
//     where a usable vector exists it beats anything drawn by hand.
//   - **Stylised glyphs** (`mark`) are in-house geometry for sources with no
//     vector to hand. Monochrome, tinted from the source's accent colour.
//
// Everything is inline SVG: no asset fetch, no build step, and no second network
// round-trip before the picker can paint. Stylised glyphs are drawn in a 24×24
// box; brand marks keep their own paths and are sized by CSS.
//
// **A brand mark's viewBox has to be the artwork, not the canvas it shipped on.**
// One CSS rule sizes every mark in the row, so the box is the unit of size and any
// padding baked into a vendor's file comes straight off the mark's visual weight.
// OpenAI's Blossom ships in a 716 box with its ink spanning 355 of it — under half —
// and next to the Claude Spark, which fills 99.6% of its own 94 box, it landed at
// roughly half the weight and read as a grey speck on a name tag. So each viewBox
// below is the artwork's measured bounds. Measure, never guess: `getBBox()` on the
// rendered path in a browser is the only honest answer, because curves bulge past
// their control points (the Blossom's do, by three units).
//
// **The paths themselves are copied as published, and never recoloured, rescaled or
// otherwise adjusted.** Every vendor here requires its mark unaltered, and a
// tempting tweak — dropping a tile that sits heavy, tinting a black mark to match
// a panel — is the thing their guidelines name. Trimming empty canvas off a viewBox
// is not one of those: no ink moves relative to any other ink, and the mark is
// reproduced whole. Where a vendor publishes several official variants, pick the one
// that suits the surface (both surfaces these appear on are near-white, so the
// light-background variants are the right ones) rather than editing one. Each mark's
// provenance and release basis is recorded in docs/developer/visual-assets.md; all
// but OpenClaw's are
// excluded from the Apache-2.0 grant, per NOTICE.

// src/rovo-mark.js and nothing heavier: this module is reachable from
// debuglog.html, which never loads three.js. Its header has the whole reason.
import { ROVO_SHAPES } from '../rovo-mark.js';
import { node } from './dom.js';

/** Wrap path markup in a 24×24 svg that inherits colour and size from CSS. */
function mark(inner) {
  return `<svg class="src-mark" viewBox="0 0 24 24" role="img" aria-hidden="true"
    fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round"
    xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

/**
 * Wrap a brand logo's own paths, colours intact.
 *
 * `color` from CSS is deliberately ignored: these fills *are* the brand, and
 * tinting them would misrepresent it.
 */
function brandMark(viewBox, inner) {
  // `fill="none"` matters: stroke-only paths (OpenClaw's antennae) would
  // otherwise take the default black fill and blob over the artwork.
  //
  // No `fill-rule` here, deliberately. SVG's default is `nonzero` and every
  // asset below is copied from a vendor file whose own root sets none, so
  // imposing `evenodd` on the wrapper would silently redraw them — OpenAI's
  // Blossom is eight subpaths and its interior reads as solid under one rule and
  // hollow under the other. Each path keeps whatever rule its source file gave it.
  return `<svg class="src-mark src-mark-brand" viewBox="${viewBox}" role="img" aria-hidden="true"
    fill="none" stroke-linejoin="round" stroke-miterlimit="2"
    xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;
}

let uid = 0;

/**
 * Stamp a mark template with fresh ids, ready to insert.
 *
 * A mark can be on screen three times at once — picker button, switcher row and
 * title-bar pill — and any `<defs>` inside it (OpenClaw has a gradient) would
 * then share one id across all three copies. Whichever copy the browser resolved
 * against could later be removed from the DOM, leaving the survivors painting
 * with a dangling `url(#…)`. So every insertion gets its own id.
 *
 * Marks with no ids pass through untouched.
 */
export function renderMark(markup) {
  return String(markup ?? '').split('__UID__').join(`m${++uid}`);
}

/**
 * The HTML for a source's visual in 2D chrome: a portrait `<img>` where the
 * source record carries one, otherwise the vector mark. The 3D name-tag
 * (Agent.js) and the debug log keep the vector mark in all cases — a raster
 * portrait cannot be stamped onto a canvas texture the way an SVG string can.
 */
export function sourceVisual(def) {
  if (def.image) {
    const label = String(def.label ?? '').replace(/"/g, '&quot;');
    return `<img class="src-visual-img" src="${def.image}" alt="${label} portrait" draggable="false">`;
  }
  return renderMark(def.mark);
}

/**
 * A span carrying a source's mark, in the source's own colours.
 *
 * `color` is set for the sake of the in-house glyphs, which paint in
 * `currentColor` — Cursor's chevron and the Test Data die; the brand marks carry
 * their own fills and ignore it. The title is there because a logo at 12px is a
 * hint, not a label.
 *
 * Shared rather than per-panel: the roster row and the First Person panel both put
 * this glyph before an agent's name, and one agent should not be able to look like
 * two different agents depending on which panel you read.
 *
 * @param {object} def        source definition, from data/sources.js
 * @param {string} className  class for the wrapper, so each panel can size it
 */
export function markSpan(def, className) {
  const el = node('span', className);
  el.innerHTML = sourceVisual(def);
  el.style.color = def.accent;
  el.title = `Source: ${def.label}`;
  return el;
}

/**
 * The viewBox enclosing a list of flat polygon shapes, with room to breathe.
 *
 * @param {Array<{points: number[][]}>} shapes
 * @param {number} [inset] fraction of the artwork's own size to leave as padding
 *   on every side, when a dense mark needs an optical trim to stop reading heavy
 *   (the Blossom takes 4%; the hexagon needs none — see below)
 */
function boundsViewBox(shapes, inset = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const { points } of shapes) {
    for (const [x, y] of points) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  const px = (x1 - x0) * inset, py = (y1 - y0) * inset;
  return [x0 - px, y0 - py, (x1 - x0) + 2 * px, (y1 - y0) + 2 * py]
    .map((n) => Math.round(n * 100) / 100).join(' ');
}

/** One closed `<path>` per flat polygon, in its own colour. Straight lines only. */
function polygonPaths(shapes) {
  return shapes
    .map(({ color, points }) => `<path d="M${points.map((p) => p.join(' ')).join('L')}Z" fill="${color}"/>`)
    .join('\n  ');
}

/**
 * Rovo CLI — the four-facet diamond from src/rovo-mark.js, the same artwork the sill
 * standee is extruded from. An original shape: this fork does not carry the Rovo mark.
 */
export const rovoMark = brandMark(boundsViewBox(ROVO_SHAPES), `
  ${polygonPaths(ROVO_SHAPES)}
`);

/** Claude Code — named in letters (see `letterMark`). */
export const claudeMark = letterMark('Cl');

/** Codex — named in letters (see `letterMark`). */
export const codexMark = letterMark('Cx');

/** Cursor — a simple cursor chevron; the picker supplies Cursor violet. */
export const cursorMark = mark('<path d="M7 5 L15 12 L7 19" /><circle cx="17.5" cy="12" r="1.5" fill="currentColor" stroke="none" />');

/**
 * OpenClaw — the project's own lobster mascot.
 *
 * `ui/public/favicon.svg` from openclaw/openclaw at tag v2026.9.3 — the static
 * frame of it. That repository is MIT licensed, so this is the one mark here that
 * ships under a licence permitting redistribution; the notice travels with it in
 * THIRD_PARTY_NOTICES.txt, as MIT requires. The upstream file wraps the same
 * geometry in SMIL animation for the app's own surfaces, which a picker tile has
 * no use for; every path, gradient stop, circle and stroke below is byte-identical
 * to it. `__UID__` stands in for the gradient id so `renderMark()` can keep
 * concurrent copies apart.
 */
export const openclawMark = brandMark('0 0 120 120', `
  <defs>
    <linearGradient id="oc-shell-__UID__" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#ff4d4d"/>
      <stop offset="100%" stop-color="#991b1b"/>
    </linearGradient>
  </defs>
  <path d="M60 10 C30 10 15 35 15 55 C15 75 30 95 45 100 L45 110 L55 110 L55 100 C55 100 60 102 65 100 L65 110 L75 110 L75 100 C90 95 105 75 105 55 C105 35 90 10 60 10Z" fill="url(#oc-shell-__UID__)"/>
  <path d="M20 45 C5 40 0 50 5 60 C10 70 20 65 25 55 C28 48 25 45 20 45Z" fill="url(#oc-shell-__UID__)"/>
  <path d="M100 45 C115 40 120 50 115 60 C110 70 100 65 95 55 C92 48 95 45 100 45Z" fill="url(#oc-shell-__UID__)"/>
  <path d="M45 15 Q35 5 30 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
  <path d="M75 15 Q85 5 90 8" stroke="#ff4d4d" stroke-width="3" stroke-linecap="round"/>
  <circle cx="45" cy="35" r="6" fill="#050810"/>
  <circle cx="75" cy="35" r="6" fill="#050810"/>
  <circle cx="46" cy="34" r="2.5" fill="#00e5cc"/>
  <circle cx="76" cy="34" r="2.5" fill="#00e5cc"/>
`);

/** Test Data — a die, because this source is honest about rolling for it. */
export const testDataMark = mark(`
  <rect x="4.2" y="4.2" width="15.6" height="15.6" rx="3.4" />
  <g fill="currentColor" stroke="none">
    <circle cx="8.6" cy="8.6" r="1.25" />
    <circle cx="15.4" cy="8.6" r="1.25" />
    <circle cx="12" cy="12" r="1.25" />
    <circle cx="8.6" cy="15.4" r="1.25" />
    <circle cx="15.4" cy="15.4" r="1.25" />
  </g>
`);

/**
 * Muse — a laptop wearing headphones: the assistant at its desk.
 *
 * An in-house glyph, drawn for this source; there is no vendor vector to
 * reproduce. Monochrome, so the picker's `--accent` (teal #2fa39a) tints it.
 * The 2D chrome shows the source's portrait image instead (see `sourceVisual`);
 * this glyph survives for the 3D name-tag and the debug log, which need vector
 * artwork.
 */
export const museMark = mark(`
  <path d="M6.2 11.6 C6.2 5.6 17.8 5.6 17.8 11.6" />
  <rect x="4.9" y="9.4" width="2.7" height="5.4" rx="1.35" />
  <rect x="16.4" y="9.4" width="2.7" height="5.4" rx="1.35" />
  <rect x="8.6" y="11.2" width="6.8" height="4.9" rx="0.9" />
  <path d="M6.4 18.4 H17.6" />
`);

/** A plus, for the switcher's "New Office" row. */
export const plusMark = mark('<path d="M12 5.5 V18.5" /><path d="M5.5 12 H18.5" />');

/**
 * A lettered tile. The upstream showed the Claude Spark and the OpenAI Blossom here;
 * NOTICE excludes both from the Apache-2.0 grant, and both owners' guidelines allow the
 * product name in plain text instead, so this fork names the source rather than drawing
 * its logo.
 */
function letterMark(letters) {
  return mark(`
  <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
  <text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" font-family="system-ui, sans-serif" fill="currentColor" stroke="none">${letters}</text>
`);
}

/** Shared office: two people side by side — the multiplayer crew feed. */
export const crewMark = mark(`
  <circle cx="8.5" cy="8.5" r="3" />
  <circle cx="15.5" cy="8.5" r="3" />
  <path d="M3.5 19c0-3 2.2-5 5-5s5 2 5 5" />
  <path d="M10.5 19c0-3 2.2-5 5-5s5 2 5 5" />
`);
