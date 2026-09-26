// =============================================================================
// showers.js — Meteor showers from their parent bodies' orbits. Pure JS.
//
// For each shower we take the parent's orbit (JPL SBDB elements from /data/), find when Earth passes
// closest to that orbit during a year (the shower date emerges from the geometry — nothing is scripted),
// and compute the radiant and geocentric speed from the meteoroid velocity at that point:
// v_g = v_meteoroid − v_Earth; the radiant is the direction the meteors come FROM (−v_g).
// Zenith attraction and Earth's gravitational focusing are ignored (≲ a few degrees, ~1 km/s).
// =============================================================================
import { DEG, TAU, GM_SUN_AU_D, perifocalToFrame } from './kepler.js';
import { AU_KM, computeSystemState } from './ephemeris.js';
import { eclipticToRaDec } from './cometphysics.js';
import { utcToTDB, utcStringToJD } from './time.js';

// peak = typical maximum date; radiant/vg = IMO catalogue values (for comparison in Verify);
// tube = half-width of the drawn stream tube (AU); zhr = peak zenithal hourly rate.
export const SHOWERS = [
  { key: 'perseids', name: 'Perseids', parent: '109P', parentKind: 'comet', peak: '08-12', radiant: [48, 58], vg: 59, zhr: 100, tube: 0.03, color: '#9fd1ff' },
  // Halley's present orbit passes 0.15 AU (Orionid node) / 0.075 AU (η Aqr node) from Earth's: its much older
  // meteoroid streams have spread well away from the comet's orbit, hence the wide tube.
  { key: 'orionids', name: 'Orionids', parent: '1P', parentKind: 'comet', peak: '10-21', radiant: [95, 16], vg: 66, zhr: 20, tube: 0.18, color: '#ffc9a0' },
  { key: 'etaaquariids', name: 'Eta Aquariids', parent: '1P', parentKind: 'comet', peak: '05-06', radiant: [338, -1], vg: 66, zhr: 50, tube: 0.18, color: '#ffc9a0' },
  { key: 'leonids', name: 'Leonids', parent: '55P', parentKind: 'comet', peak: '11-17', radiant: [152, 22], vg: 71, zhr: 15, tube: 0.02, color: '#c4ffb0' },
  { key: 'geminids', name: 'Geminids', parent: '3200', parentKind: 'asteroid', peak: '12-14', radiant: [112, 33], vg: 35, zhr: 150, tube: 0.04, color: '#ffe6a0' },
];

/** Parent orbit elements {q, e, i, node, peri, tp} (AU, deg, JD) from the loaded data, or null. */
export function parentElements(data, shower) {
  if (shower.parentKind === 'comet') {
    const t = data?.files?.comets;
    if (!t) return null;
    const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
    const r = t.rows.find((x) => x[c.pdes] === shower.parent);
    return r ? { q: r[c.q], e: r[c.e], i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.tp] } : null;
  }
  const o = (data?.files?.asteroids?.named || []).find((x) => x.pdes === shower.parent);
  if (!o) return null;
  const n = Math.sqrt(GM_SUN_AU_D) / o.a ** 1.5;
  return { q: o.a * (1 - o.e), e: o.e, i: o.i, node: o.om, peri: o.w, tp: o.epoch - (o.ma * DEG) / n };
}

/** Point and velocity on the orbit at true anomaly ν (AU, AU/day, ecliptic). */
export function orbitPointVel(el, nu) {
  const p = el.q * (1 + el.e), r = p / (1 + el.e * Math.cos(nu));
  const w = el.peri * DEG, i = el.i * DEG, O = el.node * DEG;
  const pos = perifocalToFrame(r * Math.cos(nu), r * Math.sin(nu), w, i, O, [0, 0, 0]);
  const k = Math.sqrt(GM_SUN_AU_D / p);
  const vel = perifocalToFrame(-k * Math.sin(nu), k * (el.e + Math.cos(nu)), w, i, O, [0, 0, 0]);
  return { pos, vel };
}

/** Sample the orbit as a polyline of true anomalies (restricted to r < rMax AU for long orbits). */
export function orbitSamples(el, n = 2000, rMax = 6) {
  const p = el.q * (1 + el.e);
  const cosMin = el.e > 0 ? Math.max(-1, (p / rMax - 1) / el.e) : -1;
  const nuMax = el.e >= 1 || cosMin > -1 ? Math.acos(cosMin) : Math.PI;
  const out = [];
  for (let k = 0; k < n; k++) out.push(-nuMax + (2 * nuMax * k) / (n - 1));
  return out;
}

/** Distance (AU) from point x to the orbit, with the true anomaly of the closest orbit point. */
export function distanceToOrbit(el, x, nus) {
  let best = Infinity, bestNu = 0;
  for (const nu of nus) {
    const { pos } = orbitPointVel(el, nu);
    const d = Math.hypot(pos[0] - x[0], pos[1] - x[1], pos[2] - x[2]);
    if (d < best) { best = d; bestNu = nu; }
  }
  // Refine by golden section around the best sample.
  const step = nus.length > 1 ? Math.abs(nus[1] - nus[0]) : 0.01;
  let a = bestNu - step, b = bestNu + step;
  const f = (nu) => { const { pos } = orbitPointVel(el, nu); return Math.hypot(pos[0] - x[0], pos[1] - x[1], pos[2] - x[2]); };
  const g = (Math.sqrt(5) - 1) / 2;
  for (let it = 0; it < 40; it++) { const c = b - g * (b - a), d = a + g * (b - a); if (f(c) < f(d)) b = d; else a = c; }
  const nu = (a + b) / 2;
  return { dist: f(nu), nu };
}

/**
 * Earth's closest passage to the parent orbit near the expected date (±40 days) in a given year.
 * Returns { jd, dist (AU), radiant: {ra, dec}, vg (km/s), nu }.
 */
export function earthCrossing(el, shower, year) {
  const nus = orbitSamples(el, 1500);
  const center = utcToTDB(utcStringToJD(`${year}-${shower.peak} 00:00`));
  const earthAU = (jd) => computeSystemState(jd).earth.map((v) => v / AU_KM);
  let best = { dist: Infinity };
  for (let jd = center - 40; jd <= center + 40; jd += 0.5) {
    const d = distanceToOrbit(el, earthAU(jd), nus);
    if (d.dist < best.dist) best = { jd, ...d };
  }
  // Refine the date.
  let a = best.jd - 0.5, b = best.jd + 0.5;
  const g = (Math.sqrt(5) - 1) / 2, f = (jd) => distanceToOrbit(el, earthAU(jd), nus).dist;
  for (let it = 0; it < 30; it++) { const c = b - g * (b - a), d = a + g * (b - a); if (f(c) < f(d)) b = d; else a = c; }
  const jd = (a + b) / 2;
  const { dist, nu } = distanceToOrbit(el, earthAU(jd), nus);
  const { vel } = orbitPointVel(el, nu);
  const e1 = earthAU(jd + 0.01), e0 = earthAU(jd - 0.01);
  const vE = [(e1[0] - e0[0]) / 0.02, (e1[1] - e0[1]) / 0.02, (e1[2] - e0[2]) / 0.02];
  const vg = [vel[0] - vE[0], vel[1] - vE[1], vel[2] - vE[2]];          // AU/day
  const speed = (Math.hypot(...vg) * AU_KM) / 86400;
  const radiant = eclipticToRaDec([-vg[0], -vg[1], -vg[2]]);
  return { jd, dist, radiant, vg: speed, nu, vgVec: vg };
}

/** Angular separation (deg) of two RA/Dec positions. */
export function angSep(ra1, de1, ra2, de2) {
  const a = ra1 * DEG, b = de1 * DEG, c = ra2 * DEG, d = de2 * DEG;
  return Math.acos(Math.min(1, Math.sin(b) * Math.sin(d) + Math.cos(b) * Math.cos(d) * Math.cos(a - c))) / DEG;
}

export { TAU };
