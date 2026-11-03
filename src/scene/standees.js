// Brand-mark standees: the Atlassian ace and the Rovo mark, extruded from their
// own vector artwork rather than kit-bashed from boxes like the rest of the room.
// Both are flat logos in source, so what makes them stand up on a shelf rather
// than lie there like a sticker is depth — a third of the mark's own height,
// enough for the standee to hold its own edge with no separate stand or base.
//
// The ace's artwork is below; the Rovo mark's is in src/rovo-mark.js, because the
// picker tile is the same mark and one set of points is the only way the statue
// and the tile cannot drift apart. That module's own header says why it imports
// nothing.
//
// The artwork is plain point data, not SVG. This app has no build step and
// loads nothing from disk (see docs/user/the-kit.md), and an SVG parser would also be
// a DOM dependency this module cannot carry: the coplanar probe and the prop
// portrait tool both build the whole prop catalogue in Node, headless — see
// bin/lib/headless-scene.js, which stubs `document` just enough for a canvas
// texture and nothing more. So each mark's curves were flattened once, offline,
// into the polygons below (bin/lib is for tools that run *in* this repo; the
// one-off flattening script that produced these points did not need to). A
// THREE.Shape built from a literal array needs nothing but three's own core,
// which is the same reason the rest of the room is boxes and cylinders rather
// than loaded models.
//
// Both marks are Atlassian's own, and both are excluded from the Apache-2.0
// grant — see NOTICE and docs/developer/visual-assets.md, which record where each
// one came from.
//
// Source: the Atlassian ace is the mark from
// https://atlassian.design/assets/c117b4e25b80/logos/atlassian_logo.zip (the icon
// to the left of the wordmark, not the horizontal lockup). The Rovo mark's four
// facets are traced from UXWing's rendering of the same mark
// (https://uxwing.com/atlassian-rovo-icon/) rather than lifted out of a kit SVG —
// flat polygons in four Atlassian brand colours; src/rovo-mark.js has the detail.

import * as THREE from 'three';
import { ROVO_SHAPES } from '../rovo-mark.js';

// An original hexagon badge, standing in for the Atlassian logo the upstream drew here
// (excluded from the Apache-2.0 grant by NOTICE, so a fork may not carry it).
const ACE_SHAPES = [
  { color: '#3d6fd6', points: [[24, 2], [43, 13], [43, 35], [24, 46], [5, 35], [5, 13]] },
];

/** A closed polygon, straight off the flattened point list — SVG's y-down. */
function shapeFrom(points) {
  return new THREE.Shape(points.map(([x, y]) => new THREE.Vector2(x, y)));
}

/**
 * Extrude a flat brand mark into a standee thick enough to stand up on its own
 * edge rather than lie flat like a sticker: depth is a third of the height, per
 * the brief this was built against. Every shape becomes its own full-depth mesh
 * in its own colour — this only looks right because the shapes tile edge to
 * edge with no overlap (see src/rovo-mark.js); overlapping source shapes
 * extruded the same way would fight over the same depth.
 *
 * @param {Array<{color: string, points: number[][]}>} shapeSpecs
 * @param {object} [opts]
 * @param {number} [opts.height]  world-space height the standee should read as
 * @returns {{obj: THREE.Group, width: number, height: number, depth: number}}
 *   `obj`'s local origin is centred left-right and front-back and sits on its
 *   base, the same convention as everything else that stands on a floor or sill.
 */
function buildLogoStandee(shapeSpecs, { height = 0.6 } = {}) {
  // Every shape, extruded one unit deep, still in the source's own y-down space
  // and still at a placeholder scale, so a Box3 over the lot gives the
  // artwork's true extent to scale and centre against.
  const raw = new THREE.Group();
  const matFor = new Map();
  for (const { color, points } of shapeSpecs) {
    if (!matFor.has(color)) {
      matFor.set(color, new THREE.MeshStandardMaterial({
        color: new THREE.Color(color), roughness: 0.45, metalness: 0.05,
        // The y-flip below (source y-down to world y-up) mirrors the geometry,
        // which otherwise turns every front face into a culled back face.
        side: THREE.DoubleSide,
      }));
    }
    const geo = new THREE.ExtrudeGeometry(shapeFrom(points), { depth: 1, bevelEnabled: false });
    const mesh = new THREE.Mesh(geo, matFor.get(color));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    raw.add(mesh);
  }

  const bounds = new THREE.Box3().setFromObject(raw);
  const artH = bounds.max.y - bounds.min.y;
  const scaleXY = height / artH;
  const depth = height / 3;

  // Centre the artwork on the origin in its own local space, on all three axes,
  // so the flip-and-scale below leaves it centred rather than pushing it aside.
  const center = bounds.getCenter(new THREE.Vector3());
  raw.position.set(-center.x, -center.y, -center.z);

  const inner = new THREE.Group();
  inner.add(raw);
  inner.scale.set(scaleXY, -scaleXY, depth);
  // Lift so the outer object's own origin — where a caller sets position — is
  // the base, the same convention as every other standing prop in the room.
  inner.position.y = height / 2;

  const obj = new THREE.Group();
  obj.add(inner);
  return { obj, width: (bounds.max.x - bounds.min.x) * scaleXY, height, depth };
}

/** The hexagon badge, standing on its edge. */
export function buildAceLogo(height = 0.6) {
  return buildLogoStandee(ACE_SHAPES, { height });
}

/** The four-facet diamond, standing on its edge. */
export function buildRovoLogo(height = 0.6) {
  return buildLogoStandee(ROVO_SHAPES, { height });
}
