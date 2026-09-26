// =============================================================================
// dart.js — Didymos–Dimorphos orbit before and after NASA's DART impact. Pure JS.
//
// Impact: 2022-09-26 23:14:24 UTC. Period 11.921473 h before → 11.3675 h after (−33.24 min;
// Naidu et al. 2024, Scheirich et al. 2024). Pre-impact a = 1.206 km, circular. Post-impact e ≈ 0.028 with
// the impact point at apocentre (DART slowed Dimorphos); a_post follows from Kepler's third law.
// Orbit plane = Didymos' equator (spin pole λ = 310°, β = −84°, Naidu et al. 2020). The inertial orbital
// PHASE is illustrative (angle 0 = ascending node of the orbit on the ecliptic at impact time).
// =============================================================================
import { DEG, TAU, solveKeplerElliptic } from './kepler.js';
import { utcToTDB, utcStringToJD } from './time.js';

export const DART = {
  impactJD: utcToTDB(utcStringToJD('2022-09-26 23:14:24')),
  pre: { P: 11.921473 / 24, a: 1.206, e: 0 },
  post: { P: 11.3675 / 24, e: 0.028 },
  pole: { lam: 310, bet: -84 },
};
DART.post.a = DART.pre.a * Math.pow(DART.post.P / DART.pre.P, 2 / 3);

const n = (() => {
  const l = DART.pole.lam * DEG, b = DART.pole.bet * DEG;
  return [Math.cos(b) * Math.cos(l), Math.cos(b) * Math.sin(l), Math.sin(b)];   // ecliptic unit vector
})();
// In-plane basis: x = ascending node (ẑ_ecl × n), y = n × x.
const X = (() => { const v = [-n[1], n[0], 0]; const l = Math.hypot(...v); return v.map((c) => c / l); })();
const Y = [n[1] * X[2] - n[2] * X[1], n[2] * X[0] - n[0] * X[2], n[0] * X[1] - n[1] * X[0]];

/** Dimorphos relative to Didymos (km, ecliptic J2000). forcePre: evaluate the pre-impact orbit at any date. */
export function dimorphosRel(jdTDB, out = [0, 0, 0], forcePre = false) {
  const post = !forcePre && jdTDB >= DART.impactJD;
  const o = post ? DART.post : DART.pre;
  const dt = jdTDB - DART.impactJD;
  let theta, r = o.a;
  if (!post) theta = (TAU * dt) / o.P;
  else {
    const M = Math.PI + (TAU * dt) / o.P;                      // apocentre (ν = π) at the impact
    const E = solveKeplerElliptic(M, o.e);
    const nu = 2 * Math.atan2(Math.sqrt(1 + o.e) * Math.sin(E / 2), Math.sqrt(1 - o.e) * Math.cos(E / 2));
    r = o.a * (1 - o.e * Math.cos(E));
    theta = nu - Math.PI;
  }
  for (let k = 0; k < 3; k++) out[k] = r * (Math.cos(theta) * X[k] + Math.sin(theta) * Y[k]);
  return out;
}

/** One full orbit (current or pre-impact) as parent-relative points, starting at the body. */
export function dimorphosOrbit(jdTDB, N, pre = false) {
  const o = !pre && jdTDB >= DART.impactJD ? DART.post : DART.pre;
  const pts = [];
  for (let k = 0; k < N; k++) pts.push(dimorphosRel(jdTDB - (k / (N - 1)) * o.P, [0, 0, 0], pre));
  return pts;
}

/** In-plane angle of Dimorphos (radians) — used by the Verify period measurement. */
export function dimorphosAngle(jdTDB) {
  const p = dimorphosRel(jdTDB);
  return Math.atan2(p[0] * Y[0] + p[1] * Y[1] + p[2] * Y[2], p[0] * X[0] + p[1] * X[1] + p[2] * X[2]);
}
