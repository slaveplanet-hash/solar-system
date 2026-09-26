// =============================================================================
// eclipse.js — Shadow geometry shared by the shaders and the CPU.
//
// For each receiving body, pick up to 4 occluders whose shadow (umbra + penumbra)
// can touch it, using TRUE heliocentric geometry (km). The shader then evaluates
// the exact partial-disc overlap per pixel. In VISUAL scale the scene is distorted
// (radii exaggerated, distances compressed), so each occluder also gets a factor
// K = (true angular radius) / (scene angular radius) and the true/scene separations
// at the receiver's center; the shader rescales per-pixel offsets with them. In
// TRUE scale K = 1 and the math is exact.
//
// `sunlightFactor()` is the CPU twin of the GLSL `sunlight()` (used by Verify and
// by auto-exposure), evaluated at a point in true km coordinates.
// =============================================================================
const R_SUN = 695700;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function len(a) { return Math.hypot(a[0], a[1], a[2]); }
function angle(a, b) {
  const c = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  return Math.atan2(len(c), a[0] * b[0] + a[1] * b[1] + a[2] * b[2]);
}

/** Fraction of a unit disc covered by a disc of radius r at center distance d (same as GLSL). */
export function discOverlap(r, d) {
  if (d >= 1 + r) return 0;
  if (d <= Math.abs(1 - r)) return Math.min(r * r, 1);
  const r2 = r * r, d2 = d * d;
  const a1 = Math.acos(Math.max(-1, Math.min(1, (d2 + 1 - r2) / (2 * d))));
  const a2 = Math.acos(Math.max(-1, Math.min(1, (d2 + r2 - 1) / (2 * d * r))));
  const k = Math.sqrt(Math.max(0, (-d + r + 1) * (d + r - 1) * (d - r + 1) * (d + r + 1)));
  return (a1 + r2 * a2 - 0.5 * k) / Math.PI;
}

/**
 * Sunlight (rgb) at a point p (true heliocentric km) given occluder bodies {helio, radius, atmo}.
 * Returns { rgb:[r,g,b], visible: fraction of the solar disc visible }.
 */
export function sunlightFactor(p, occluders) {
  const toSun = [-p[0], -p[1], -p[2]];
  const dS = len(toSun);
  const rs = Math.asin(R_SUN / dS);
  let rgb = [1, 1, 1], visible = 1;
  for (const o of occluders) {
    const toO = sub(o.helio, p);
    const dO = len(toO);
    if (dO >= dS || (toO[0] * toSun[0] + toO[1] * toSun[1] + toO[2] * toSun[2]) <= 0) continue;
    const ro = Math.asin(Math.min(1, o.radius / dO));
    const sep = angle(toO, toSun);
    const f = 1 - discOverlap(ro / rs, sep / rs);
    visible *= f;
    if (o.atmo) {
      const depth = Math.max(0, Math.min(1, 1 - sep / ro));
      const red = [0.95, 0.32, 0.1].map((c) => c * 0.05 * (0.5 + 0.5 * depth));
      rgb = rgb.map((c, i) => c * f + (1 - f) * red[i]);
    } else rgb = rgb.map((c) => c * f);
  }
  return { rgb, visible };
}

/**
 * Select occluders for every body and fill the per-body shadow uniforms.
 * bodies: [{ key, helio(km), scenePos, radius(km), rScene, parent, atmoRefract }]
 * Returns Map(key → [{ body, K, sepTrue, sepScene }]) sorted by relevance.
 */
export function selectOccluders(bodies) {
  const out = new Map();
  for (const B of bodies) {
    if (B.kind === 'sun') continue;
    const dSun = len(B.helio);
    const sunDirT = B.helio.map((v) => -v / dSun);
    const sunDirS = [-B.scenePos[0], -B.scenePos[1], -B.scenePos[2]];
    const rsT = Math.asin(R_SUN / dSun);
    const cands = [];
    for (const O of bodies) {
      if (O === B || O.kind === 'sun') continue;
      // Only bodies of the same local system can shadow each other meaningfully.
      const sameSystem = O.parent === B.key || B.parent === O.key || (O.parent && O.parent === B.parent && O.parent !== 'sun');
      if (!sameSystem) continue;
      const toOT = sub(O.helio, B.helio);
      const dT = len(toOT);
      if (toOT[0] * sunDirT[0] + toOT[1] * sunDirT[1] + toOT[2] * sunDirT[2] <= 0) continue;   // not sunward
      const roT = Math.asin(Math.min(1, O.radius / dT));
      const sepT = angle(toOT, sunDirT);
      const reach = roT + rsT + Math.atan(B.radius / dT) * 1.1;   // receiver's own extent (parallax)
      if (sepT > reach) continue;
      const toOS = sub(O.scenePos, B.scenePos);
      const dS = len(toOS);
      const roS = Math.asin(Math.min(1, O.rScene / dS));
      const sepS = angle(toOS, sunDirS);
      cands.push({ body: O, K: roT / Math.max(roS, 1e-12), sepTrue: sepT, sepScene: sepS, score: sepT - roT - rsT });
    }
    cands.sort((a, b) => a.score - b.score);
    out.set(B.key, { list: cands.slice(0, 4), sunAng: rsT });
  }
  return out;
}
