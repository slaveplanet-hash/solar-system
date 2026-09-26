// =============================================================================
// shapes.js — Procedural shape models for small bodies.
//
// Each style deforms an icosphere direction-by-direction, then the triaxial
// semi-axes (a ≥ b ≥ c, km) are applied and everything is normalised to the
// body's MEAN radius (the mesh is scaled by the mean radius at render time).
// Mesh axes: local X = body x (long axis a), local Y = spin pole (c), local Z = −body y (b).
// Styles are qualitative: they reproduce each body's published overall shape
// (spinning-top, contact-binary peanut, banana, giant south-polar basin …), not
// the real topography.
// =============================================================================
import * as THREE from 'three';
import { fbm } from './surfaces.js';

const clamp01 = (t) => Math.max(0, Math.min(1, t));
const gauss = (u) => Math.exp(-u * u);

/** Radius multiplier for unit direction (x, y, z) with y = pole, per style. */
const STYLES = {
  // Rubble-pile "spinning top" with an equatorial ridge (Bennu, Ryugu, Didymos).
  top(x, y, z, s) {
    const lat = Math.abs(y);
    const ridge = 0.1 * Math.pow(1 - lat, 6);                       // equatorial bulge
    const cone = -0.12 * lat * lat;                                  // flattened, faceted poles
    return 1 + ridge + cone + boulders(x, y, z, s, 0.05);
  },
  // Contact binary "peanut/sea-otter" (Itokawa): a neck pinched around the long axis centre.
  peanut(x, y, z, s) {
    const neck = -0.17 * gauss((x + 0.12) / 0.3);
    const head = 0.08 * gauss((x + 0.7) / 0.3);                      // smaller "head" lobe
    return 1 + neck - head + boulders(x, y, z, s, 0.04);
  },
  // Elongated, bent "banana" (Eros): the ends curve toward −z, with a saddle on one side.
  banana(x, y, z, s) {
    const saddle = -0.14 * gauss(x / 0.35) * clamp01(z + 0.3);
    return 1 + saddle + craters(x, y, z, s, 0.05);
  },
  // Large differentiated body with a giant south-polar basin (Vesta: Rheasilvia + central peak).
  basin(x, y, z, s) {
    const d = Math.acos(Math.max(-1, Math.min(1, -y)));             // angle from the south pole
    const basin = -0.09 * gauss((d - 0.35) / 0.35) + 0.05 * gauss(d / 0.12);
    return 1 + basin + craters(x, y, z, s, 0.025);
  },
  // Generic cratered, lumpy asteroid (Psyche, Pallas, Hygiea, Apophis, Phaethon, Dimorphos).
  lumpy(x, y, z, s) { return 1 + (fbm(x * 2.2, y * 2.2, z * 2.2, 4, s) - 0.5) * 0.18 + craters(x, y, z, s, 0.04); },
  // Smooth (large, relaxed bodies: Haumea's ellipsoid, dwarf planets).
  smooth(x, y, z, s) { return 1 + (fbm(x * 3, y * 3, z * 3, 3, s) - 0.5) * 0.01; },
};

function boulders(x, y, z, s, amp) {
  return (fbm(x * 3, y * 3, z * 3, 4, s) - 0.5) * amp * 2 + Math.max(0, fbm(x * 12, y * 12, z * 12, 2, s + 5) - 0.72) * amp * 3;
}
function craters(x, y, z, s, amp) {
  // Soft-edged shallow depressions (the surface texture carries the fine crater detail).
  const n = 1 - Math.abs(fbm(x * 4, y * 4, z * 4, 2, s + 11) * 2 - 1);
  const t = clamp01((n - 0.78) / 0.2);
  return -amp * 0.6 * t * t * (3 - 2 * t) + (fbm(x * 2, y * 2, z * 2, 3, s) - 0.5) * amp;
}

/**
 * Build a shape model. axes = [a, b, c] semi-axes in km; meanR = mean radius (km).
 * Returns a BufferGeometry in units of the mean radius, with UVs from the undeformed sphere.
 */
export function shapeGeometry(style, axes, meanR, seed = 7, detail = 5) {
  // Indexed UV sphere → shared vertices → smooth normals, and UVs that match the equirectangular maps.
  const seg = detail >= 6 ? 192 : 128;
  const g = new THREE.SphereGeometry(1, seg, seg / 2);
  const p = g.attributes.position;
  const fn = STYLES[style] || STYLES.lumpy;
  const [a, b, c] = axes;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i).normalize();
    const k = fn(v.x, v.y, v.z, seed);
    let X = v.x * k * a, Y = v.y * k * c, Z = v.z * k * b;
    if (style === 'banana') Z -= 0.28 * b * (v.x * v.x - 0.35);           // bend the long axis
    p.setXYZ(i, X / meanR, Y / meanR, Z / meanR);
  }
  g.computeVertexNormals();
  // SphereGeometry duplicates vertices along the UV seam and at the poles; give coincident vertices one
  // shared (averaged) normal so no seam line or polar "star" shows in the shading.
  const nrm = g.attributes.normal, groups = new Map();
  for (let i = 0; i < p.count; i++) {
    // Integer keys: toFixed would print −0.00000 vs 0.00000 for seam vertices at ±1e-16.
    const key = `${Math.round(p.getX(i) * 1e5)},${Math.round(p.getY(i) * 1e5)},${Math.round(p.getZ(i) * 1e5)}`;
    let arr = groups.get(key); if (!arr) groups.set(key, (arr = []));
    arr.push(i);
  }
  for (const idx of groups.values()) {
    if (idx.length < 2) continue;
    let x = 0, y = 0, z = 0;
    for (const i of idx) { x += nrm.getX(i); y += nrm.getY(i); z += nrm.getZ(i); }
    const l = Math.hypot(x, y, z) || 1;
    for (const i of idx) nrm.setXYZ(i, x / l, y / l, z / l);
  }
  g.computeBoundingSphere();
  return g;
}
