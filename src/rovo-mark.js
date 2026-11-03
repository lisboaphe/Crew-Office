// A four-facet diamond: flat polygons, one per facet, original to this fork.
//
// Upstream, this module held Atlassian's Rovo mark, which NOTICE excludes from the
// Apache-2.0 grant and which a redistributor may not carry without Atlassian's own
// permission. The diamond keeps the module's job — one artwork that both the sill
// standee (src/scene/standees.js) and the 2D source tile (src/ui/marks.js) draw from —
// with geometry anyone may reuse. The export keeps its old name so the two importers
// are untouched.
//
// **Its own module, importing nothing**: marks.js is reachable from debuglog.html, which
// carries no import map and must never load three.js.

export const ROVO_SHAPES = [
  { color: '#3d85c6', points: [[24, 2], [24, 24], [2, 24]] },
  { color: '#9b5de5', points: [[24, 2], [46, 24], [24, 24]] },
  { color: '#f2a541', points: [[2, 24], [24, 24], [24, 46]] },
  { color: '#81b29a', points: [[24, 24], [46, 24], [24, 46]] },
];
