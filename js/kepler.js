// =============================================================================
// kepler.js — Two-body orbit solvers for every conic section.
//   • solveKeplerElliptic   E − e·sin E = M         (Newton–Raphson, tol 1e-12)
//   • solveKeplerHyperbolic e·sinh H − H = M        (Newton–Raphson)
//   • propagateUniversal    universal variable χ with Stumpff functions — valid
//                            for e<1, e≈1 and e>1 (used for near-parabolic comets)
// Pure JS so it can be unit-tested in Node. Angles in radians unless noted.
// =============================================================================

export const DEG = Math.PI / 180;
export const TAU = 2 * Math.PI;
/** Gaussian gravitational constant² → GM_sun in AU³/day². */
export const GM_SUN_AU_D = 0.01720209895 ** 2;

export function wrapPi(x) { x = (x + Math.PI) % TAU; if (x < 0) x += TAU; return x - Math.PI; }
export function wrap360(x) { x %= 360; return x < 0 ? x + 360 : x; }

/** Solve Kepler's equation for an ellipse. M in radians, returns E. */
export function solveKeplerElliptic(M, e, tol = 1e-12) {
  M = wrapPi(M);
  let E = e < 0.8 ? M : (M >= 0 ? Math.PI : -Math.PI) * 0.85 + M * 0.15; // robust start for high e
  for (let k = 0; k < 60; k++) {
    const f = E - e * Math.sin(E) - M;
    const dE = f / (1 - e * Math.cos(E));
    E -= dE;
    if (Math.abs(dE) < tol) break;
  }
  return E;
}

/** Solve the hyperbolic Kepler equation e·sinh H − H = M. */
export function solveKeplerHyperbolic(M, e, tol = 1e-12) {
  let H = Math.abs(M) < 6 * e ? Math.asinh(M / e) : Math.sign(M) * Math.log(2 * Math.abs(M) / e + 1.8);
  for (let k = 0; k < 100; k++) {
    const dH = (e * Math.sinh(H) - H - M) / (e * Math.cosh(H) - 1);
    H -= dH;
    if (Math.abs(dH) < tol * Math.max(1, Math.abs(H))) break;
  }
  return H;
}

// --- Stumpff functions, with series near z = 0 to avoid cancellation --------
export function stumpffC(z) {
  if (Math.abs(z) < 0.1) return 1 / 2 - z / 24 + z * z / 720 - z ** 3 / 40320 + z ** 4 / 3628800 - z ** 5 / 479001600;
  if (z > 0) return (1 - Math.cos(Math.sqrt(z))) / z;
  const s = Math.sqrt(-z); return (Math.cosh(s) - 1) / -z;
}
export function stumpffS(z) {
  if (Math.abs(z) < 0.1) return 1 / 6 - z / 120 + z * z / 5040 - z ** 3 / 362880 + z ** 4 / 39916800 - z ** 5 / 6227020800;
  if (z > 0) { const s = Math.sqrt(z); return (s - Math.sin(s)) / (s * s * s); }
  const s = Math.sqrt(-z); return (Math.sinh(s) - s) / (s * s * s);
}

/**
 * Universal-variable propagation from periapsis.
 * @param q  periapsis distance, e eccentricity (any ≥ 0), mu GM, dt time since periapsis
 * @returns {x,y,vx,vy} in the perifocal plane (x toward periapsis).
 */
export function propagateUniversal(q, e, mu, dt) {
  const alpha = (1 - e) / q;                 // 1/a  (>0 ellipse, <0 hyperbola, 0 parabola)
  const sqmu = Math.sqrt(mu);
  // For ellipses, reduce dt to within ±½ period so χ stays small.
  if (alpha > 1e-12) {
    const P = TAU / Math.sqrt(mu * alpha ** 3);
    dt = dt - P * Math.round(dt / P);
  }
  // Initial guess
  let chi;
  if (alpha > 1e-6) chi = sqmu * dt * alpha;
  else if (alpha < -1e-6) {
    const a = 1 / alpha;
    const arg = (2 * mu * -alpha * Math.abs(dt)) / (Math.sqrt(-mu * a) * e);
    chi = arg > 1 ? Math.sign(dt) * Math.sqrt(-a) * Math.log(arg) : sqmu * dt / q;
  } else {
    // Barker's equation for the parabola as a starting point
    const p = 2 * q;
    const s = 0.5 * Math.atan(1 / (3 * Math.sqrt(mu / p ** 3) * dt)) ;
    const w = Math.atan(Math.cbrt(Math.tan(s)));
    chi = Math.sqrt(p) * 2 / Math.tan(2 * w);
    if (!isFinite(chi)) chi = sqmu * dt / q;
  }
  // Laguerre–Conway iteration (n = 5): converges from almost any start.
  const n = 5;
  for (let k = 0; k < 200; k++) {
    const z = alpha * chi * chi;
    const C = stumpffC(z), S = stumpffS(z);
    const F = e * chi ** 3 * S + q * chi - sqmu * dt;
    const dF = e * chi * chi * C + q;
    const ddF = e * chi * (1 - z * S);
    const disc = Math.sqrt(Math.abs((n - 1) ** 2 * dF * dF - n * (n - 1) * F * ddF));
    const denom = dF + Math.sign(dF) * disc;
    const dchi = n * F / denom;
    chi -= dchi;
    if (Math.abs(dchi) < 1e-13 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi;
  const C = stumpffC(z), S = stumpffS(z);
  const v0 = Math.sqrt(mu * (1 + e) / q);
  const f = 1 - (chi * chi / q) * C;
  const g = dt - (chi ** 3 * S) / sqmu;
  const x = f * q, y = g * v0;
  const r = Math.hypot(x, y);
  const fdot = (sqmu / (r * q)) * (alpha * chi ** 3 * S - chi);
  const gdot = 1 - (chi * chi / r) * C;
  return { x, y, vx: fdot * q, vy: gdot * v0 };
}

/**
 * Universal-variable propagation from an arbitrary state (Curtis, Algorithms 3.3–3.4): any conic.
 * r0, v0: position/velocity (any consistent units with mu, e.g. AU, AU/day, AU³/day²); dt: time.
 * Used for comet dust grains (reduced gravity μ(1−β) from radiation pressure).
 */
export function propagateState(r0, v0, dt, mu, outR = [0, 0, 0], outV = [0, 0, 0]) {
  if (mu <= 1e-14) {                        // no net force (β = 1 dust): straight line
    for (let k = 0; k < 3; k++) { outR[k] = r0[k] + v0[k] * dt; outV[k] = v0[k]; }
    return outR;
  }
  const r0n = Math.hypot(r0[0], r0[1], r0[2]);
  const v0n2 = v0[0] * v0[0] + v0[1] * v0[1] + v0[2] * v0[2];
  const vr0 = (r0[0] * v0[0] + r0[1] * v0[1] + r0[2] * v0[2]) / r0n;
  const alpha = 2 / r0n - v0n2 / mu;
  const sqmu = Math.sqrt(mu);
  const A = (r0n * vr0) / sqmu, B = 1 - alpha * r0n;
  let chi = Math.abs(alpha) > 1e-6 ? sqmu * Math.abs(alpha) * dt : (sqmu * dt) / r0n;
  const n = 5;
  for (let k = 0; k < 100; k++) {
    const z = alpha * chi * chi, C = stumpffC(z), S = stumpffS(z);
    const F = A * chi * chi * C + B * chi ** 3 * S + r0n * chi - sqmu * dt;
    const dF = A * chi * (1 - z * S) + B * chi * chi * C + r0n;
    const ddF = A * (1 - z * C) + B * chi * (1 - z * S);
    const disc = Math.sqrt(Math.abs((n - 1) ** 2 * dF * dF - n * (n - 1) * F * ddF));
    const dchi = (n * F) / (dF + Math.sign(dF) * disc);
    chi -= dchi;
    if (Math.abs(dchi) < 1e-12 * Math.max(1, Math.abs(chi))) break;
  }
  const z = alpha * chi * chi, C = stumpffC(z), S = stumpffS(z);
  const f = 1 - ((chi * chi) / r0n) * C, g = dt - (chi ** 3 * S) / sqmu;
  for (let k = 0; k < 3; k++) outR[k] = f * r0[k] + g * v0[k];
  const rn = Math.hypot(outR[0], outR[1], outR[2]);
  const fd = (sqmu / (rn * r0n)) * (alpha * chi ** 3 * S - chi), gd = 1 - ((chi * chi) / rn) * C;
  for (let k = 0; k < 3; k++) outV[k] = fd * r0[k] + gd * v0[k];
  return outR;
}

/** Rotate a perifocal (x,y) vector into the reference frame by ω, i, Ω (radians). */
export function perifocalToFrame(x, y, argPeri, inc, node, out = [0, 0, 0]) {
  const cw = Math.cos(argPeri), sw = Math.sin(argPeri);
  const ci = Math.cos(inc), si = Math.sin(inc);
  const cO = Math.cos(node), sO = Math.sin(node);
  const xp = x * cw - y * sw, yp = x * sw + y * cw;   // rotate by ω in the orbit plane
  out[0] = xp * cO - yp * ci * sO;
  out[1] = xp * sO + yp * ci * cO;
  out[2] = yp * si;
  return out;
}

/**
 * Position from classical elements (elliptic, e < 1) via the elliptic solver.
 * a in any length unit, angles radians; M mean anomaly.
 */
export function ellipticPosition(a, e, inc, node, argPeri, M, out) {
  const E = solveKeplerElliptic(M, e);
  const x = a * (Math.cos(E) - e);
  const y = a * Math.sqrt(1 - e * e) * Math.sin(E);
  return perifocalToFrame(x, y, argPeri, inc, node, out);
}

/** Hyperbolic position (e > 1) using the sinh solver. a < 0. */
export function hyperbolicPosition(a, e, inc, node, argPeri, M, out) {
  const H = solveKeplerHyperbolic(M, e);
  const x = -a * (e - Math.cosh(H));   // = |a|(e − cosh H)
  const y = -a * Math.sqrt(e * e - 1) * Math.sinh(H);
  return perifocalToFrame(x, y, argPeri, inc, node, out);
}

/**
 * Generic conic propagation for any e (used by comets/asteroids/interstellar objects).
 * el: { q (AU), e, i, node, peri (deg), tp (JD TDB) } → heliocentric ecliptic J2000 (AU).
 * Chooses the fastest robust solver for the regime.
 */
export function conicPosition(el, jdTDB, mu = GM_SUN_AU_D, out = [0, 0, 0]) {
  const i = el.i * DEG, O = el.node * DEG, w = el.peri * DEG;
  const dt = jdTDB - el.tp;
  const e = el.e;
  if (Math.abs(1 - e) < 0.02) {            // near-parabolic → universal variables
    const s = propagateUniversal(el.q, e, mu, dt);
    return perifocalToFrame(s.x, s.y, w, i, O, out);
  }
  const a = el.q / (1 - e);
  const n = Math.sqrt(mu / Math.abs(a) ** 3);
  const M = n * dt;
  return e < 1 ? ellipticPosition(a, e, i, O, w, M, out) : hyperbolicPosition(a, e, i, O, w, M, out);
}

/** Sample an orbit path (for drawing). Returns Float64Array of xyz in AU. */
export function sampleConic(el, jdCenter, nPts = 512, hyperSpanDays = 3650, mu = GM_SUN_AU_D) {
  const pts = new Float64Array(nPts * 3);
  const tmp = [0, 0, 0];
  const i = el.i * DEG, O = el.node * DEG, w = el.peri * DEG, e = el.e;
  if (e < 1) {
    const a = el.q / (1 - e);
    for (let k = 0; k < nPts; k++) {
      const E = (k / (nPts - 1)) * TAU;         // uniform in eccentric anomaly → dense near perihelion
      perifocalToFrame(a * (Math.cos(E) - e), a * Math.sqrt(1 - e * e) * Math.sin(E), w, i, O, tmp);
      pts.set(tmp, k * 3);
    }
  } else {
    for (let k = 0; k < nPts; k++) {
      const dt = (k / (nPts - 1) - 0.5) * 2 * hyperSpanDays;
      const s = propagateUniversal(el.q, e, mu, dt);
      perifocalToFrame(s.x, s.y, w, i, O, tmp);
      pts.set(tmp, k * 3);
    }
  }
  return pts;
}
