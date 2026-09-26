// =============================================================================
// cometphysics.js — Comet activity, brightness, dust-tail (syndyne/synchrone) model
// and hyperbolic-orbit quantities. Pure JS (Node-testable).
// =============================================================================
import { DEG, GM_SUN_AU_D, conicPosition, propagateState } from './kepler.js';
import { AU_KM, OBLIQUITY_J2000 } from './ephemeris.js';

export const GM_SUN_KM3_S2 = 1.32712440018e11;

/**
 * Activity 0…1 vs heliocentric distance r (AU): water-ice sublimation switches on inside ~3 AU and the
 * coma/tails fade in around 3–5 AU, peaking near perihelion. A(r) = 1 / (1 + (r / 2.5)^5).
 */
export function activity(r) { return 1 / (1 + (r / 2.5) ** 5); }

/** Total visual magnitude (IAU/MPC comet law): m = M1 + 5 log10 Δ + K1 log10 r. */
export function cometMagnitude(M1, K1, r, delta) { return M1 + 5 * Math.log10(delta) + K1 * Math.log10(r); }

/**
 * Intrinsic brightness factor used to size and light the coma and tails, relative to a comet with
 * M1 = 8 at r = 1 AU: B = 10^(−0.4 (M1 + K1 log10 r − 8)). (Δ-independent: it describes the comet itself.)
 */
export function intrinsicBrightness(M1, K1, r) {
  const m = (M1 ?? 12) + (K1 ?? 10) * Math.log10(Math.max(r, 0.05));
  return Math.pow(10, -0.4 * (m - 8));
}

/** Hyperbolic excess speed v∞ (km/s) for q (AU), e > 1. */
export function vInfinity(q, e) {
  const aKm = Math.abs((q / (1 - e)) * AU_KM);
  return Math.sqrt(GM_SUN_KM3_S2 / aKm);
}

/** Unit vectors (ecliptic J2000) of the incoming (where it came FROM) and outgoing asymptotes. */
export function asymptotes(el) {
  const nuInf = Math.acos(-1 / el.e);
  const dir = (nu) => {
    const w = el.peri * DEG, O = el.node * DEG, i = el.i * DEG;
    const u = w + nu;
    return [Math.cos(O) * Math.cos(u) - Math.sin(O) * Math.sin(u) * Math.cos(i),
      Math.sin(O) * Math.cos(u) + Math.cos(O) * Math.sin(u) * Math.cos(i), Math.sin(u) * Math.sin(i)];
  };
  // Far in the past the object was along ν → −ν∞ (it arrived from that direction).
  return { inbound: dir(-nuInf + 1e-9), outbound: dir(nuInf - 1e-9), nuInf };
}

/** Ecliptic unit vector → equatorial J2000 RA/Dec (deg). */
export function eclipticToRaDec(v) {
  const c = Math.cos(OBLIQUITY_J2000), s = Math.sin(OBLIQUITY_J2000);
  const x = v[0], y = c * v[1] - s * v[2], z = s * v[1] + c * v[2];
  let ra = Math.atan2(y, x) / DEG; if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, z / Math.hypot(x, y, z)))) / DEG };
}

/** Heliocentric state (AU, AU/day) from a position function pos(jd) by central differences. */
export function stateFrom(pos, jd, h = 0.01) {
  const r = pos(jd), a = pos(jd + h), b = pos(jd - h);
  return { r, v: [(a[0] - b[0]) / (2 * h), (a[1] - b[1]) / (2 * h), (a[2] - b[2]) / (2 * h)] };
}

// Dust tail: syndyne (constant β) × synchrone (constant emission time) grid, zero ejection velocity.
export const DUST_BETAS = [0.02, 0.035, 0.06, 0.1, 0.17, 0.28, 0.45, 0.7, 1.0];     // β = F_rad / F_grav
export const DUST_AGES = Array.from({ length: 32 }, (_, j) => 60 * Math.pow(j / 31, 1.6));   // days before "now"

/**
 * Dust-grain positions (heliocentric AU) for every (β, age) pair: each grain leaves the nucleus at
 * jd − age with the nucleus' velocity and then moves in the reduced solar gravity μ(1−β).
 * pos(jd) → heliocentric AU of the nucleus. Returns { points: Float64Array (nβ × nAge × 3), weight }.
 */
export function dustGrid(pos, jd, betas = DUST_BETAS, ages = DUST_AGES) {
  const nb = betas.length, na = ages.length;
  const points = new Float64Array(nb * na * 3);
  const weight = new Float32Array(nb * na);
  const out = [0, 0, 0];
  for (let j = 0; j < na; j++) {
    const age = ages[j];
    const s = stateFrom(pos, jd - age);
    const rEmit = Math.hypot(...s.r);
    const act = activity(rEmit);
    for (let k = 0; k < nb; k++) {
      const idx = k * na + j;
      if (age === 0) { points.set(s.r, idx * 3); weight[idx] = act; continue; }
      propagateState(s.r, s.v, age, GM_SUN_AU_D * (1 - betas[k]), out);
      points[idx * 3] = out[0]; points[idx * 3 + 1] = out[1]; points[idx * 3 + 2] = out[2];
      weight[idx] = act;
    }
  }
  return { points, weight, nb, na };
}

/** Nucleus position function from conic elements {q, e, i, node, peri, tp} (heliocentric AU). */
export function conicPos(el) { return (jd) => conicPosition(el, jd, GM_SUN_AU_D, [0, 0, 0]); }
