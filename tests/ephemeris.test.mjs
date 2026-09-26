// Node test: compare ephemeris.js / kepler.js against JPL Horizons fixtures.
// Run:  node tests/ephemeris.test.mjs
import { readFileSync } from 'node:fs';
import { planetHelioKm, moonGeoKm, computeSystemState, AU_KM, C_KM_S, eclLonDeg, subSolarPoint } from '../js/ephemeris.js';
import { propagateUniversal, ellipticPosition, hyperbolicPosition, GM_SUN_AU_D, DEG, conicPosition } from '../js/kepler.js';
import { utcToTDB, tdbToUTC } from '../js/time.js';
import { moonPlanetocentricKm } from '../js/moons.js';
import { MOON_ELEMENTS } from '../js/data/moonElements.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/horizons.json', import.meta.url)));
let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };
const angle = (a, b) => {
  const d = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));
  return Math.acos(Math.min(1, Math.max(-1, d))) / DEG;
};
const names = { 199: 'mercury', 299: 'venus', 399: 'earth', 499: 'mars', 599: 'jupiter', 699: 'saturn', 799: 'uranus', 899: 'neptune', 999: 'pluto' };
// Standish Table 1 quoted max errors (arcsec) are ~ 15–400″ over 1800–2050; allow generous 0.5° except Pluto.
for (const [id, rows] of Object.entries(fx.planets)) {
  let worst = 0, worstR = 0;
  for (const r of rows) {
    const st = computeSystemState(r.jd);
    const p = st[names[id]];
    const ref = [r.x, r.y, r.z];
    worst = Math.max(worst, angle(p, ref));
    worstR = Math.max(worstR, Math.abs(Math.hypot(...p) - Math.hypot(...ref)) / AU_KM);
  }
  // Standish quotes Table-1 errors up to ~600″ for Jupiter/Saturn (Great Inequality) — allow 0.2° there.
  const tol = (id === '599' || id === '699') ? 0.2 : 0.1;
  check(`${names[id]} helio direction`, worst < tol,`worst ${(worst * 3600).toFixed(1)}″, |Δr| ${worstR.toExponential(2)} AU`);
}
// Moon geocentric
for (const r of fx.moon) {
  const m = moonGeoKm(r.jd);
  const ref = [r.x, r.y, r.z];
  const ang = angle(m, ref) * 3600;
  const dr = Math.hypot(...m) - Math.hypot(...ref);
  check(`moon @JD ${r.jd.toFixed(4)}`, ang < 60 && Math.abs(dr) < 50, `Δθ ${ang.toFixed(1)}″  Δr ${dr.toFixed(1)} km  |Δ| ${Math.hypot(m[0]-r.x,m[1]-r.y,m[2]-r.z).toFixed(0)} km`);
}
// Mars/Jupiter table
for (const id of ['499', '599']) {
  let worst = 0;
  for (const r of fx.table[id]) {
    const p = planetHelioKm(names[id], r.jd);
    let d = Math.abs(eclLonDeg(p) - eclLonDeg([r.x, r.y, r.z])); if (d > 180) d = 360 - d;
    worst = Math.max(worst, d);
  }
  check(`${names[id]} longitude 2024–2030 vs Horizons`, worst < 1, `worst ${worst.toFixed(4)}°`);
}
// Solver cross-checks
{
  const mu = GM_SUN_AU_D, q = 1.2, e = 0.5, a = q / (1 - e), n = Math.sqrt(mu / a ** 3);
  let worst = 0;
  for (const dt of [-900, -10, 0, 37, 400, 1234.5, 5000]) {
    const u = propagateUniversal(q, e, mu, dt);
    const p = ellipticPosition(a, e, 0, 0, 0, n * dt, [0, 0, 0]);
    worst = Math.max(worst, Math.hypot(u.x - p[0], u.y - p[1]));
  }
  check('universal vs elliptic (e=0.5)', worst < 1e-9, `max |Δ| ${worst.toExponential(2)} AU`);
}
{
  const mu = GM_SUN_AU_D, q = 0.8, e = 1.5, a = q / (1 - e), n = Math.sqrt(mu / Math.abs(a) ** 3);
  let worst = 0;
  for (const dt of [-3000, -100, 0, 5, 250, 4000]) {
    const u = propagateUniversal(q, e, mu, dt);
    const p = hyperbolicPosition(a, e, 0, 0, 0, n * dt, [0, 0, 0]);
    worst = Math.max(worst, Math.hypot(u.x - p[0], u.y - p[1]) / Math.max(1, Math.hypot(p[0], p[1])));
  }
  check('universal vs hyperbolic (e=1.5)', worst < 1e-9, `max rel |Δ| ${worst.toExponential(2)}`);
}
{
  const mu = GM_SUN_AU_D; let worst = 0;
  for (const dt of [-200, -20, 3, 60, 300]) {
    const lo = propagateUniversal(0.5, 0.9999, mu, dt), mid = propagateUniversal(0.5, 1.0, mu, dt), hi = propagateUniversal(0.5, 1.0001, mu, dt);
    worst = Math.max(worst, Math.hypot(lo.x - mid.x, lo.y - mid.y), Math.hypot(hi.x - mid.x, hi.y - mid.y));
  }
  check('near-parabolic continuity e=0.9999/1/1.0001', worst < 1e-3, `max |Δ| ${worst.toExponential(2)} AU`);
}
{ // Halley-like check using conicPosition energy consistency: r at tp == q
  const el = { q: 0.586, e: 0.967, i: 162.2, node: 58.4, peri: 111.3, tp: 2446470.5 };
  const p = conicPosition(el, el.tp);
  check('conicPosition r(tp) = q', Math.abs(Math.hypot(...p) - el.q) < 1e-10, `r=${Math.hypot(...p).toFixed(12)}`);
}
// Eclipse geometry at the check instants
{
  const jd = utcToTDB(2460409.2625); // 2024-04-08 18:18 UTC
  const s = computeSystemState(jd);
  const E = s.earth, M = s.moon;
  const u = M.map((v, i) => v - 0); // Sun at origin: axis direction Sun→Moon
  const un = Math.hypot(...u); const d = u.map(v => v / un);
  const t = E[0] * d[0] + E[1] * d[1] + E[2] * d[2];
  const perp = Math.hypot(E[0] - t * d[0], E[1] - t * d[1], E[2] - t * d[2]);
  const gamma = perp / 6378.137;
  check('2024-04-08 solar eclipse gamma', Math.abs(gamma - 0.3431) < 0.05, `γ=${gamma.toFixed(4)} (NASA 0.3431 at 18:17:16)`);
}
{
  const jd = utcToTDB(2460748.790278); // 2025-03-14 06:58 UTC
  const s = computeSystemState(jd);
  const E = s.earth, M = s.moon;
  const dE = Math.hypot(...E); const d = E.map(v => v / dE);            // anti-solar axis
  const rel = M.map((v, i) => v - E[i]);
  const t = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2];
  const perp = Math.hypot(rel[0] - t * d[0], rel[1] - t * d[1], rel[2] - t * d[2]);
  console.log(`      lunar eclipse offset ${perp.toFixed(0)} km = ${(perp / 6378.137).toFixed(4)} R⊕ (NASA γ 0.3485); along-axis ${t.toFixed(0)} km`);
  check('2025-03-14 lunar eclipse gamma', Math.abs(perp / 6378.137 - 0.3485) < 0.05, '');
}
// Rotation: sub-solar point vs Horizons QUANTITIES=15 (observer = Sun) at 2026-09-25 00:00 TT.
// Horizons retards the target by light time and reports planetographic lat; W-lon for prograde
// planets, E-lon for retrograde ones and Pluto.
{
  const ref = { mercury: [81.889768, -0.023151], venus: [64.591961, 2.533379], earth: [180.336035, -0.779585], mars: [126.571482, -1.157518],
    jupiter: [184.107547, 0.408598], saturn: [81.140641, -9.265765], uranus: [257.481899, 73.905022], neptune: [53.677344, -19.557126], pluto: [313.375493, 60.050078] };
  const flat = { mercury: 0, venus: 0, earth: 0.003353, mars: 0.00589, jupiter: 0.06487, saturn: 0.09796, uranus: 0.02293, neptune: 0.01708, pluto: 0 };
  const eastPos = { venus: 1, earth: 1, uranus: 1, pluto: 1 };
  const jdTT = 2461308.5;
  for (const [k, [lon, lat]] of Object.entries(ref)) {
    let s = computeSystemState(jdTT);
    const lt = Math.hypot(...s[k]) / C_KM_S / 86400;
    const jd = jdTT - lt, jdU = tdbToUTC(jd);
    s = computeSystemState(jd);
    const p = subSolarPoint(k, s[k], jd, jdU);
    const latg = Math.atan(Math.tan(p.lat * DEG) / (1 - flat[k]) ** 2) / DEG;
    const L = eastPos[k] ? p.lon : (360 - p.lon) % 360;
    const dl = ((L - lon + 540) % 360) - 180;
    if (k === 'neptune') {
      console.log(`INFO  neptune rotation phase Δ ${dl.toFixed(1)}° — IAU 16.11 h model vs Horizons' Karkoschka 15.966 h; pole Δlat ${(latg - lat).toFixed(3)}°`);
      check('neptune pole', Math.abs(latg - lat) < 0.1, '');
      continue;
    }
    check(`${k} rotation (sub-solar point)`, Math.abs(dl) < 0.2 && Math.abs(latg - lat) < 0.1, `Δlon ${dl.toFixed(3)}°  Δlat ${(latg - lat).toFixed(3)}°`);
  }
}
// Major moons vs Horizons planetocentric vectors (1990, 2000, 2026, 2040)
{
  const mf = JSON.parse(readFileSync(new URL('./fixtures/moons.json', import.meta.url)));
  const ids = { phobos: 401, deimos: 402, io: 501, europa: 502, ganymede: 503, callisto: 504, mimas: 601, enceladus: 602, tethys: 603, dione: 604,
    rhea: 605, titan: 606, iapetus: 608, ariel: 701, umbriel: 702, titania: 703, oberon: 704, miranda: 705, triton: 801, charon: 901 };
  for (const [key, id] of Object.entries(ids)) {
    let worst = 0, worstKm = 0;
    for (const r of mf[id]) {
      const p = moonPlanetocentricKm(key, r.jd);
      worst = Math.max(worst, angle(p, [r.x, r.y, r.z]));
      worstKm = Math.max(worstKm, Math.hypot(p[0] - r.x, p[1] - r.y, p[2] - r.z));
    }
    const tol = MOON_ELEMENTS[key].rms * 4 + 0.3;   // fit residual scale + margin
    check(`${key.padEnd(9)} vs Horizons`, worst < tol, `worst ${worst.toFixed(3)}° (${worstKm.toFixed(0)} km), fit rms ${MOON_ELEMENTS[key].rms}°`);
  }
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
