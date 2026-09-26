// =============================================================================
// verify.js — Accuracy self-checks (spec §7 plus solver/rotation checks).
// Pure JS: runs identically in the browser (Verify button) and in Node.
// Each check returns { name, status: 'PASS'|'FAIL'|'PENDING'|'SKIP', detail }.
// =============================================================================
import { computeSystemState, subSolarPoint, bodyToEclipticMatrix, AU_KM, eclLonDeg } from './ephemeris.js';
import { utcToTDB, utcStringToJD, unixMsToJD, jdToUTCString, tdbToUTC } from './time.js';
import { propagateUniversal, ellipticPosition, hyperbolicPosition, GM_SUN_AU_D, wrapPi, DEG } from './kepler.js';
import { horizonsLon } from './data/horizonsRef.js';
import { moonPlanetocentricKm, computeMoonStates, MOON_BY_KEY } from './moons.js';
import { MOON_REF, MOON_REF_JD } from './data/moonRef.js';
import { MOON_ELEMENTS } from './data/moonElements.js';
import { sunlightFactor } from './eclipse.js';
import { hermiteSelfCheck } from './tracks.js';
import { planetElements } from './ephemeris.js';
import { DART, dimorphosAngle } from './dart.js';
import { SHOWERS, parentElements, earthCrossing, angSep } from './showers.js';
import { solarEclipses, lunarEclipses } from './events.js';
import { vInfinity, asymptotes, eclipticToRaDec, dustGrid, conicPos, stateFrom, DUST_AGES } from './cometphysics.js';

const R_EARTH = 6378.137, R_SUN = 695700, R_MOON = 1737.4;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Perpendicular distance of point p from the line through o with unit direction d; also the along-axis coordinate. */
function axisOffset(p, o, d) { const r = sub(p, o), t = dot(r, d); return { perp: norm([r[0] - t * d[0], r[1] - t * d[1], r[2] - t * d[2]]), t }; }

/** The Upcoming-Events engine must find both eclipses above on its own (search, not a fixed date). */
function eventsEngineCheck() {
  const name = 'Events engine finds the 2024-04-08 total solar & 2025-03-14 total lunar eclipses';
  const tdb = (u) => utcToTDB(utcStringToJD(u));
  const se = solarEclipses(tdb('2024-03-25 00:00'), tdb('2024-04-20 00:00'));
  const le = lunarEclipses(tdb('2025-03-01 00:00'), tdb('2025-03-25 00:00'));
  const s = se.find((e) => e.type === 'total'), l = le.find((e) => e.type === 'total');
  const ds = s ? (s.jd - tdb('2024-04-08 18:17:18')) * 1440 : NaN;    // NASA greatest eclipse 18:18:29 TD = 18:17:18 UTC
  const dl = l ? (l.jd - tdb('2025-03-14 06:58:47')) * 1440 : NaN;    // NASA 06:59:56 TD = 06:58:47 UTC
  const ok = s && l && Math.abs(ds) < 10 && Math.abs(dl) < 10;
  return { name, status: ok ? 'PASS' : 'FAIL',
    detail: `found ${se.map((e) => e.type + ' solar').join(', ') || 'no solar'} (${Number.isFinite(ds) ? (ds >= 0 ? '+' : '') + ds.toFixed(1) + ' min vs NASA' : '—'}), ${le.map((e) => e.type + ' lunar').join(', ') || 'no lunar'} (${Number.isFinite(dl) ? (dl >= 0 ? '+' : '') + dl.toFixed(1) + ' min' : '—'}); tests/events.test.mjs checks all 44 eclipses of 2021–2030` };
}

function solarEclipse2024() {
  const utc = '2024-04-08 18:18';
  const s = computeSystemState(utcToTDB(utcStringToJD(utc)));
  const dM = norm(s.moon), d = s.moon.map((v) => v / dM);            // Sun → Moon axis (Sun at origin)
  const { perp, t } = axisOffset(s.earth, [0, 0, 0], d);
  const gamma = perp / R_EARTH;
  const between = t > dM;                                             // Earth lies beyond the Moon along the axis
  const ok = between && Math.abs(gamma - 0.3431) < 0.05;
  return { name: 'Total solar eclipse 2024-04-08 18:18 UTC', status: ok ? 'PASS' : 'FAIL',
    detail: `Moon between Sun & Earth: ${between ? 'yes' : 'NO'}; shadow-axis γ = ${gamma.toFixed(4)} R⊕ (NASA 0.3431 at greatest eclipse 18:17:16)` };
}

function lunarEclipse2025() {
  const utc = '2025-03-14 06:58';
  const s = computeSystemState(utcToTDB(utcStringToJD(utc)));
  const dES = norm(s.earth), d = s.earth.map((v) => v / dES);         // anti-solar axis through Earth
  const { perp, t } = axisOffset(s.moon, s.earth, d);
  // Umbral cone radius at the Moon's distance, enlarged 2% for Earth's atmosphere (Chauvenet).
  const umbra = 1.02 * R_EARTH - t * (R_SUN - R_EARTH) / dES;
  const inUmbra = t > 0 && perp < umbra;
  const total = perp + R_MOON < umbra;
  return { name: 'Total lunar eclipse 2025-03-14 06:58 UTC', status: inUmbra && total ? 'PASS' : 'FAIL',
    detail: `Moon centre ${perp.toFixed(0)} km from shadow axis (γ ${(perp / R_EARTH).toFixed(4)}, NASA 0.3485); umbra radius ${umbra.toFixed(0)} km → ${total ? 'fully inside umbra (total)' : inUmbra ? 'partially in umbra' : 'NOT in umbra'}` };
}

/** Golden-section search for an extremum of Earth–Sun distance in [a,b] (JD UTC). */
function extremum(a, b, sign) {
  const f = (jd) => sign * norm(computeSystemState(utcToTDB(jd)).earth);
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  for (let i = 0; i < 60; i++) { if (f(c) < f(d)) b = d; else a = c; c = b - g * (b - a); d = a + g * (b - a); }
  const jd = (a + b) / 2;
  return { jd, au: sign * f(jd) / AU_KM };
}

function perihelionAphelion(year) {
  const per = extremum(utcStringToJD(`${year - 1}-12-20`), utcStringToJD(`${year}-01-20`), 1);
  const aph = extremum(utcStringToJD(`${year}-06-20`), utcStringToJD(`${year}-07-20`), -1);
  const pd = new Date((per.jd - 2440587.5) * 864e5), ad = new Date((aph.jd - 2440587.5) * 864e5);
  const perOk = Math.abs(per.au - 0.9833) < 0.0015 && pd.getUTCMonth() === 0 && pd.getUTCDate() >= 1 && pd.getUTCDate() <= 6;
  const aphOk = Math.abs(aph.au - 1.0167) < 0.0015 && ad.getUTCMonth() === 6 && ad.getUTCDate() >= 2 && ad.getUTCDate() <= 7;
  return [
    { name: `Earth perihelion ${year}`, status: perOk ? 'PASS' : 'FAIL', detail: `${per.au.toFixed(5)} AU on ${jdToUTCString(per.jd, false)} UTC (expect ≈0.983 AU near Jan 3)` },
    { name: `Earth aphelion ${year}`, status: aphOk ? 'PASS' : 'FAIL', detail: `${aph.au.toFixed(5)} AU on ${jdToUTCString(aph.jd, false)} UTC (expect ≈1.017 AU near Jul 4)` },
  ];
}

function horizonsCheck(key, jdUTC) {
  const jd = utcToTDB(jdUTC);
  const ref = horizonsLon(key, jd);
  const name = `${key[0].toUpperCase() + key.slice(1)} heliocentric longitude vs JPL Horizons`;
  if (ref == null) return { name, status: 'SKIP', detail: `date ${jdToUTCString(jdUTC, false)} outside embedded Horizons table (2024–2030); Phase 3 data script extends this` };
  const ours = eclLonDeg(computeSystemState(jd)[key]);
  let dl = Math.abs(ours - ref); if (dl > 180) dl = 360 - dl;
  return { name, status: dl < 1 ? 'PASS' : 'FAIL', detail: `${jdToUTCString(jdUTC, false)} UTC: sim ${ours.toFixed(3)}°, Horizons ${ref.toFixed(3)}°, Δ ${dl.toFixed(4)}° (limit 1°)` };
}

/** Mean synodic month from successive new moons (geocentric Sun–Moon elongation = 0). */
function synodicMonth(jdStartUTC, lunations = 37) {
  const elong = (jd) => {
    const s = computeSystemState(utcToTDB(jd));
    const sunGeo = s.earth.map((v) => -v);
    return wrapPi((eclLonDeg(s.moonGeo) - eclLonDeg(sunGeo)) * DEG);
  };
  const news = [];
  let jd = jdStartUTC, prev = elong(jd);
  while (news.length < lunations + 1) {
    const nj = jd + 1, cur = elong(nj);
    if (prev < 0 && cur >= 0) {                     // crossing from waning to waxing = new moon
      let a = jd, b = nj;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (elong(m) < 0) a = m; else b = m; }
      news.push((a + b) / 2);
    }
    jd = nj; prev = cur;
  }
  const intervals = news.slice(1).map((t, i) => t - news[i]);
  const mean = (news[news.length - 1] - news[0]) / lunations;
  const ok = Math.abs(mean - 29.530589) < 0.03;
  return { name: 'Synodic month (Moon)', status: ok ? 'PASS' : 'FAIL',
    detail: `mean of ${lunations} lunations = ${mean.toFixed(4)} d (expect 29.5306); individual ${Math.min(...intervals).toFixed(2)}–${Math.max(...intervals).toFixed(2)} d; next new moon ${jdToUTCString(news[0], false)} UTC` };
}

function solverChecks() {
  const out = [];
  const mu = GM_SUN_AU_D;
  { const q = 1.2, e = 0.5, a = q / (1 - e), n = Math.sqrt(mu / a ** 3); let w = 0;
    for (const dt of [-900, -10, 0, 37, 400, 1234.5, 5000]) { const u = propagateUniversal(q, e, mu, dt), p = ellipticPosition(a, e, 0, 0, 0, n * dt, [0, 0, 0]); w = Math.max(w, Math.hypot(u.x - p[0], u.y - p[1])); }
    out.push({ name: 'Kepler solver: universal vs elliptic (e = 0.5)', status: w < 1e-9 ? 'PASS' : 'FAIL', detail: `max |Δ| ${w.toExponential(2)} AU` }); }
  { const q = 0.8, e = 1.5, a = q / (1 - e), n = Math.sqrt(mu / Math.abs(a) ** 3); let w = 0;
    for (const dt of [-3000, -100, 0, 5, 250, 4000]) { const u = propagateUniversal(q, e, mu, dt), p = hyperbolicPosition(a, e, 0, 0, 0, n * dt, [0, 0, 0]); w = Math.max(w, Math.hypot(u.x - p[0], u.y - p[1]) / Math.max(1, Math.hypot(p[0], p[1]))); }
    out.push({ name: 'Kepler solver: universal vs hyperbolic (e = 1.5)', status: w < 1e-9 ? 'PASS' : 'FAIL', detail: `max relative |Δ| ${w.toExponential(2)}` }); }
  { let w = 0;
    for (const dt of [-200, -20, 3, 60, 300]) { const lo = propagateUniversal(0.5, 0.9999, mu, dt), m = propagateUniversal(0.5, 1, mu, dt), hi = propagateUniversal(0.5, 1.0001, mu, dt); w = Math.max(w, Math.hypot(lo.x - m.x, lo.y - m.y), Math.hypot(hi.x - m.x, hi.y - m.y)); }
    out.push({ name: 'Kepler solver: near-parabolic continuity (e = 0.9999 / 1 / 1.0001)', status: w < 1e-3 ? 'PASS' : 'FAIL', detail: `max |Δ| ${w.toExponential(2)} AU` }); }
  return out;
}

/** Spin sense relative to orbital motion: Venus & Uranus must be retrograde. */
function spinSenseCheck(jdUTC) {
  const jd = utcToTDB(jdUTC), dtd = 0.01;
  const s0 = computeSystemState(jd), s1 = computeSystemState(jd + dtd);
  const res = [];
  for (const k of ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
    const h = cross(s0[k], sub(s1[k], s0[k]));                      // orbital angular momentum
    const M0 = bodyToEclipticMatrix(k, jd, tdbToUTC(jd)), M1 = bodyToEclipticMatrix(k, jd + dtd, tdbToUTC(jd + dtd));
    const x0 = [M0[0], M0[3], M0[6]], x1 = [M1[0], M1[3], M1[6]];   // prime-meridian axis
    const w = cross(x0, x1);                                        // spin direction
    res.push({ k, retro: dot(w, h) < 0 });
  }
  const retro = res.filter((r) => r.retro).map((r) => r.k);
  const ok = retro.length === 2 && retro.includes('venus') && retro.includes('uranus');
  return { name: 'Rotation sense (retrograde rotators)', status: ok ? 'PASS' : 'FAIL', detail: `retrograde: ${retro.join(', ') || 'none'} (expect venus, uranus)` };
}

/** Earth texture orientation: at the June solstice ~12:00 UTC the Sun is overhead near 0° lon, +23.44° lat. */
function earthDaylightCheck() {
  const jdU = utcStringToJD('2026-06-21 12:00');
  const jd = utcToTDB(jdU);
  const s = computeSystemState(jd);
  const p = subSolarPoint('earth', s.earth, jd, jdU);
  const lon = ((p.lon + 540) % 360) - 180;
  // Equation of time on Jun 21 ≈ −1.6 min: the Sun transits Greenwich at ≈12:01.6 UTC,
  // so at 12:00 the sub-solar point is still ≈0.4° EAST of Greenwich.
  const ok = Math.abs(p.lat - 23.43) < 0.1 && Math.abs(lon - 0.4) < 0.5;
  return { name: 'Earth daylight / GMST alignment (2026-06-21 12:00 UTC)', status: ok ? 'PASS' : 'FAIL',
    detail: `sub-solar point ${p.lat.toFixed(2)}°N, ${lon.toFixed(2)}°E (expect ≈23.43°N, +0.4°E)` };
}

/** Io's sidereal period measured from the simulation: successive crossings of a fixed ecliptic longitude. */
function ioPeriod(jdStartUTC) {
  const jd0 = utcToTDB(jdStartUTC);
  const lon = (jd) => { const p = moonPlanetocentricKm('io', jd); return Math.atan2(p[1], p[0]); };
  const crossings = [];
  let t = jd0, prev = lon(t);
  const step = 0.05;
  while (crossings.length < 51) {
    const cur = lon(t + step);
    if (prev < 0 && cur >= 0 && cur - prev < Math.PI) {          // crossing longitude 0 going east
      let a = t, b = t + step;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (lon(m) < 0) a = m; else b = m; }
      crossings.push((a + b) / 2);
    }
    t += step; prev = cur;
  }
  const P = (crossings[crossings.length - 1] - crossings[0]) / (crossings.length - 1);
  return { name: 'Io orbital period', status: Math.abs(P - 1.769) < 0.001 ? 'PASS' : 'FAIL',
    detail: `mean of 50 orbits = ${P.toFixed(5)} d (expect 1.769 d; IAU 1.769138 d)` };
}

/** Major moons vs JPL Horizons planetocentric positions at 2026-09-25 00:00 TDB. */
function moonsVsHorizons() {
  let worst = 0, worstKey = '', worstKm = 0, fails = [];
  const lines = [];
  for (const [key, ref] of Object.entries(MOON_REF)) {
    const p = moonPlanetocentricKm(key, MOON_REF_JD);
    const ang = Math.acos(Math.min(1, dot(p, ref) / (norm(p) * norm(ref)))) / DEG;
    // Per-moon limit from its fit residual over 1850–2050 (Mimas's resonance libration is the loosest).
    const limit = Math.max(1, 4 * MOON_ELEMENTS[key].rms + 0.3);
    if (ang > limit) fails.push(key);
    if (ang > worst) { worst = ang; worstKey = key; worstKm = norm(sub(p, ref)); }
    lines.push(`${key} ${ang.toFixed(2)}°`);
  }
  return { name: `20 major moons vs JPL Horizons (2026-09-25)`, status: fails.length ? 'FAIL' : 'PASS',
    detail: `${fails.length ? 'outside limit: ' + fails.join(', ') + '; ' : ''}worst ${worstKey} ${worst.toFixed(3)}° (${worstKm.toFixed(0)} km); ${lines.join(', ')}` };
}

/** Lunar eclipse rendering: the Moon's center gets only refracted (red) light in totality. */
function lunarEclipseColor() {
  const jd = utcToTDB(utcStringToJD('2025-03-14 06:58'));
  const s = computeSystemState(jd);
  const f = sunlightFactor(s.moon, [{ helio: s.earth, radius: R_EARTH, atmo: true }]);
  const [r, g, b] = f.rgb;
  const red = r > 2 * g && g > b && f.visible < 0.01;
  return { name: 'Lunar eclipse shading (Moon turns red)', status: red ? 'PASS' : 'FAIL',
    detail: `solar disc visible from Moon center ${(f.visible * 100).toFixed(2)}%; light rgb (${r.toFixed(4)}, ${g.toFixed(4)}, ${b.toFixed(4)}) — red-dominant` };
}

/** Solar eclipse shading: point on Earth's surface on the Sun–Moon axis is in the Moon's umbra. */
function solarEclipseShadow() {
  const jd = utcToTDB(utcStringToJD('2024-04-08 18:17'));
  const s = computeSystemState(jd);
  const dM = norm(s.moon), d = s.moon.map((v) => v / dM);
  // Intersect the Sun→Moon axis with Earth's sphere (near side).
  const oc = s.earth, b = dot(d, oc), c = dot(oc, oc) - R_EARTH * R_EARTH, disc = b * b - c;
  if (disc < 0) return { name: 'Solar eclipse shading (Moon umbra on Earth)', status: 'FAIL', detail: 'axis misses Earth' };
  const t = b - Math.sqrt(disc);
  const p = d.map((v) => v * t);
  const f = sunlightFactor(p, [{ helio: s.moon, radius: R_MOON }]);
  return { name: 'Solar eclipse shading (Moon umbra on Earth)', status: f.visible < 0.01 ? 'PASS' : 'FAIL',
    detail: `solar disc visible at the shadow-axis point on Earth: ${(f.visible * 100).toFixed(3)}% (total → 0%)` };
}

// -----------------------------------------------------------------------------
// Data-pipeline checks (need the /data/ files; SKIP when absent)
// -----------------------------------------------------------------------------
const SKIP_NO_DATA = (name) => ({ name, status: 'SKIP', detail: 'no /data/ — run node fetch-data.mjs' });
const jdToDate = (jd) => jdToUTCString(tdbToUTC(jd), false);

function dataManifestCheck(data) {
  const name = 'Small-body data present and fresh (< 6 months)';
  if (!data?.available) return SKIP_NO_DATA(name);
  const c = data.manifest.counts;
  return { name, status: data.stale ? 'FAIL' : 'PASS',
    detail: `updated ${data.manifest.date} (${data.ageDays.toFixed(1)} d ago, ${data.manifest.mode}); ${c.asteroids} asteroids, ${c.neos} NEOs (${c.phas} PHA), ${c.comets} comets, ${c.interstellar} interstellar, ${c.dwarfs} dwarfs, ${c.close_approaches} close approaches, ${c.horizons_tracks} Horizons tracks` };
}

function gpuKeplerCheck(ctx) {
  const name = 'GPU Kepler solver vs float64 CPU (render-target readback)';
  if (!ctx?.data?.available) return SKIP_NO_DATA(name);
  if (!ctx.renderer || !ctx.smallBodies?.count) return { name, status: 'SKIP', detail: 'needs WebGL (runs in the browser Verify panel)' };
  const jd = utcToTDB(unixMsToJD(Date.now()));
  const r = ctx.smallBodies.gpuSelfTest(ctx.renderer, jd);          // every GPU-propagated object
  if (!r) return { name, status: 'SKIP', detail: 'float render targets unsupported' };
  // float32 (and GPU trig, ~5e-7) error scales with distance and with 1/(1−e) near perihelion, so judge it
  // relatively. Orbits with e ≥ 0.8 run on the float64 CPU path. 2e-5 ≈ 0.001° seen from the Sun.
  return { name, status: r.worstRel < 2e-5 ? 'PASS' : 'FAIL',
    detail: `all ${r.n.toLocaleString()} GPU objects: worst relative error ${r.worstRel.toExponential(2)} (${r.worstRelName}; limit 2e-5 ≈ 0.001° from the Sun); worst absolute ${r.worstKm.toFixed(0)} km (${r.worstName})` };
}

function hermiteCheck(data) {
  const name = 'Horizons vector interpolation (cubic Hermite, leave-one-out)';
  const t = data?.tracks?.apophis;
  if (!t) return SKIP_NO_DATA(name);
  const parts = t.segments.map((s) => `${s.center === 399 ? 'geocentric' : 'heliocentric'} ${(s.step * 1440).toFixed(0)} min: ≤ ${hermiteSelfCheck(s).toFixed(2)} km`);
  const worstDense = hermiteSelfCheck(t.segments[0]);
  return { name, status: worstDense < 5 ? 'PASS' : 'FAIL', detail: `Apophis, predicting each sample from neighbours 2 steps apart (an upper bound): ${parts.join('; ')}` };
}

/** Find the minimum of f over [a,b] by scanning then golden-section refining. */
function minimize(f, a, b, n = 400) {
  let best = a, bv = Infinity;
  for (let k = 0; k <= n; k++) { const x = a + ((b - a) * k) / n, v = f(x); if (v < bv) { bv = v; best = x; } }
  let lo = Math.max(a, best - (b - a) / n), hi = Math.min(b, best + (b - a) / n);
  const g = (Math.sqrt(5) - 1) / 2;
  for (let i = 0; i < 60; i++) { const c = hi - g * (hi - lo), d = lo + g * (hi - lo); if (f(c) < f(d)) hi = d; else lo = c; }
  const x = (lo + hi) / 2;
  return { x, v: f(x) };
}

function halleyCheck(data) {
  const name = "Halley's Comet perihelion 1986-02-09, ~0.586 AU";
  const t = data?.tracks?.halley;
  if (!t) return SKIP_NO_DATA(name);
  const st = { pos: [0, 0, 0], vel: [0, 0, 0] };
  const r = (jd) => { t.stateAt(jd, st); return norm(st.pos) / AU_KM; };
  const m = minimize(r, utcStringToJD('1986-01-15'), utcStringToJD('1986-03-05'));
  const ok = Math.abs(m.x - utcToTDB(utcStringToJD('1986-02-09 11:00'))) < 1 && Math.abs(m.v - 0.586) < 0.003;
  return { name, status: ok ? 'PASS' : 'FAIL', detail: `Horizons vectors: perihelion ${jdToDate(m.x)} UTC at ${m.v.toFixed(4)} AU` };
}

function cometPerihelion(data, name, match, dateStr, qExp, qTol, source, trackId = null) {
  if (!data?.available) return SKIP_NO_DATA(name);
  const expected = utcToTDB(utcStringToJD(dateStr));
  // Prefer Horizons vectors where available (they include planetary perturbations).
  const t = trackId && data.tracks?.[trackId];
  if (t && t.covers(expected)) {
    const st = { pos: [0, 0, 0], vel: [0, 0, 0] };
    const m = minimize((jd) => { t.stateAt(jd, st); return norm(st.pos) / AU_KM; }, expected - 30, expected + 30);
    const ok = Math.abs(m.x - expected) < 1.5 && Math.abs(m.v - qExp) < qTol;
    return { name, status: ok ? 'PASS' : 'FAIL', detail: `Horizons vectors: perihelion ${jdToDate(m.x)} UTC at ${m.v.toFixed(4)} AU` };
  }
  let o = null;
  if (source === 'comets' && data.files.comets) {
    const c = Object.fromEntries(data.files.comets.columns.map((k, i) => [k, i]));
    const r = data.files.comets.rows.find((x) => match.test(x[c.name]));
    if (r) o = { tp: r[c.tp], q: r[c.q], e: r[c.e], name: r[c.name] };
  } else if (source === 'interstellar') {
    const r = (data.files.interstellar?.objects || []).find((x) => match.test(x.name));
    if (r) o = { tp: r.tp, q: r.q, e: r.e, name: r.name };
  }
  if (!o) return { name, status: 'FAIL', detail: 'object not found in the downloaded data' };
  const ok = Math.abs(o.tp - expected) < 1.5 && Math.abs(o.q - qExp) < qTol;
  const hint = trackId && !ok ? 'no Horizons track for this apparition in this data/ — re-run node fetch-data.mjs; ' : '';
  return { name, status: ok ? 'PASS' : 'FAIL', detail: `${hint}${o.name}: two-body perihelion from current elements ${jdToDate(o.tp)} UTC at q = ${o.q.toFixed(4)} AU (e = ${o.e.toFixed(4)})` };
}

function apophisCheck(data) {
  const name = 'Apophis closest approach 2029-04-13, ~38,000 km (inside GEO)';
  const t = data?.tracks?.apophis;
  if (!t) return SKIP_NO_DATA(name);
  const st = { center: 10, pos: [0, 0, 0], vel: [0, 0, 0] };
  const d = (jd) => {
    t.stateAt(jd, st);
    if (st.center === 399) return norm(st.pos);
    const e = computeSystemState(jd).earth;
    return norm(sub(st.pos, e));
  };
  const m = minimize(d, utcStringToJD('2029-04-12'), utcStringToJD('2029-04-15'), 1200);
  const ok = Math.abs(m.v - 38000) < 1500 && jdToDate(m.x).startsWith('2029-04-13') && m.v < 42164;
  return { name, status: ok ? 'PASS' : 'FAIL', detail: `Horizons vectors: ${m.v.toFixed(0)} km from Earth's center at ${jdToDate(m.x)} UTC (GEO radius 42,164 km)` };
}

// --- Phase 4: structure that must EMERGE from the real orbital elements ---------------------------------
function colIndex(t) { return Object.fromEntries(t.columns.map((k, i) => [k, i])); }

function kirkwoodCheck(data) {
  const name = 'Kirkwood gaps emerge in the main-belt semi-major axes';
  const t = data?.files?.asteroids;
  if (!t) return SKIP_NO_DATA(name);
  const c = colIndex(t);
  const a = t.rows.filter((r) => ['MBA', 'IMB', 'OMB'].includes(r[c.class])).map((r) => r[c.a]);
  const dens = (lo, hi) => a.filter((x) => x >= lo && x < hi).length / (hi - lo);
  // Resonances with Jupiter (a_J = 5.2026 AU): 3:1 → 2.502, 5:2 → 2.825, 7:3 → 2.958, 2:1 → 3.279 AU.
  const gaps = [['3:1', 2.502], ['5:2', 2.825], ['7:3', 2.958], ['2:1', 3.279]];
  // Deepest 0.004-AU bin within ±0.012 AU of each resonance (osculating a scatters the gap edges slightly)
  // compared with the mean density 0.03–0.06 AU away on both sides.
  const parts = gaps.map(([lab, g]) => {
    let inGap = Infinity;
    for (let x = g - 0.012; x < g + 0.012; x += 0.002) inGap = Math.min(inGap, dens(x, x + 0.004));
    const around = (dens(g - 0.06, g - 0.03) + dens(g + 0.03, g + 0.06)) / 2;
    return { lab, ratio: inGap / Math.max(around, 1e-9) };
  });
  const ok = parts.every((p) => p.ratio < 0.35);
  return { name, status: ok ? 'PASS' : 'FAIL',
    detail: `${a.length.toLocaleString()} main-belt asteroids; density in gap ÷ neighbours: ${parts.map((p) => `${p.lab} ${p.ratio.toFixed(2)}`).join(', ')} (gap if < 0.35)` };
}

function trojanCheck(data) {
  const name = 'Jupiter Trojans cluster at L4/L5 (±60° from Jupiter)';
  const t = data?.files?.asteroids;
  if (!t) return SKIP_NO_DATA(name);
  const c = colIndex(t);
  const jd = utcToTDB(unixMsToJD(Date.now()));
  const J = planetElements('jupiter', jd);
  const lamJ = (J.node + J.argPeri + J.M) / DEG;
  const K = Math.sqrt(GM_SUN_AU_D);
  const d = t.rows.filter((r) => r[c.class] === 'TJN').map((r) => {
    const n = K / r[c.a] ** 1.5;
    const lam = r[c.om] + r[c.w] + r[c.ma] + (n * (jd - r[c.epoch])) / DEG;
    return ((lam - lamJ + 540) % 360) - 180;
  });
  if (!d.length) return { name, status: 'FAIL', detail: 'no Trojans (class TJN) in the data' };
  const median = (xs) => { const s = [...xs].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
  const l4 = d.filter((x) => x > 0), l5 = d.filter((x) => x < 0);
  const inLobes = d.filter((x) => Math.abs(Math.abs(x) - 60) < 40).length / d.length;
  const m4 = median(l4), m5 = median(l5);
  const ok = Math.abs(m4 - 60) < 8 && Math.abs(m5 + 60) < 8 && inLobes > 0.95;
  return { name, status: ok ? 'PASS' : 'FAIL',
    detail: `${d.length.toLocaleString()} Trojans: L4 (leading) ${l4.length} with median Δλ = ${m4.toFixed(1)}°, L5 (trailing) ${l5.length} with median ${m5.toFixed(1)}°; ${(inLobes * 100).toFixed(1)}% within 20–100° of Jupiter` };
}

function plutinoCheck(data) {
  const name = 'Plutinos pile up in the 3:2 Neptune resonance (a ≈ 39.4 AU)';
  const t = data?.files?.kuiper;
  if (!t) return { name, status: 'SKIP', detail: 'no kuiper.json in this data/ — re-run node fetch-data.mjs' };
  const c = colIndex(t);
  const a = t.rows.map((r) => r[c.a]);
  const dens = (lo, hi) => a.filter((x) => x >= lo && x < hi).length / (hi - lo);
  const peak = dens(39.2, 39.7), side = (dens(37.5, 38.5) + dens(40.3, 41.3)) / 2;
  return { name, status: peak / side > 3 ? 'PASS' : 'FAIL',
    detail: `${a.length.toLocaleString()} TNOs/Centaurs; density at 39.2–39.7 AU is ${(peak / side).toFixed(1)}× the neighbouring bins (resonance if > 3)` };
}

function dartCheck() {
  const name = "DART changed Dimorphos' orbital period (−33 min)";
  // Measure the simulated period: time for the in-plane angle to advance one full turn (10-s steps).
  const period = (t0) => {
    const step = 10 / 86400;
    let t = t0, prev = dimorphosAngle(t), turned = 0;
    for (let k = 0; k < 20000; k++) {
      const nt = t + step, cur = dimorphosAngle(nt);
      let da = cur - prev; if (da > Math.PI) da -= 2 * Math.PI; if (da < -Math.PI) da += 2 * Math.PI;
      if (Math.abs(turned + da) >= 2 * Math.PI) return (t + step * ((2 * Math.PI - Math.abs(turned)) / Math.abs(da)) - t0) * 1440;
      turned += da; t = nt; prev = cur;
    }
    return NaN;
  };
  const pre = period(DART.impactJD - 3), post = period(DART.impactJD + 3);
  const dm = post - pre;
  const ok = Math.abs(dm + 33.24) < 2;
  return { name, status: ok ? 'PASS' : 'FAIL',
    detail: `sim period ${(pre / 60).toFixed(3)} h before → ${(post / 60).toFixed(3)} h after the 2022-09-26 impact: Δ = ${dm.toFixed(1)} min (published −33.24 ± 1.6 min, Naidu 2024)` };
}

function namedBodiesCheck(ctx) {
  const name = 'Named asteroids & dwarf planets modelled';
  if (!ctx?.data?.available) return SKIP_NO_DATA(name);
  const sys = ctx.system;
  if (!sys) return { name, status: 'SKIP', detail: 'browser only' };
  const minor = sys.bodies.filter((b) => b.minor && (b.minorType === 'asteroid' || b.minorType === 'dwarf' || (b.kind === 'moon' && ['asteroid', 'dwarf'].includes(sys.byKey[b.parent]?.minorType))));
  const want = ['ceres', 'vesta', 'pallas', 'hygiea', 'psyche', 'eros', 'bennu', 'ryugu', 'itokawa', 'didymos', 'dimorphos', 'apophis',
    'eris', 'dysnomia', 'haumea', 'makemake', 'gonggong', 'quaoar', 'sedna'];
  const missing = want.filter((k) => !sys.byKey[k]);
  if (missing.length === 1 && missing[0] === 'dysnomia' && !ctx.data.tracks?.dysnomia) {
    return { name, status: 'SKIP', detail: `${minor.length} bodies modelled; Dysnomia needs the Phase 4 data (Horizons track) — re-run node fetch-data.mjs` };
  }
  return { name, status: missing.length ? 'FAIL' : 'PASS',
    detail: `${minor.length} bodies with shape models and spin states${missing.length ? `; missing: ${missing.join(', ')} (Dysnomia needs the Phase 4 data)` : ''}` };
}

// --- Phase 5: comets, interstellar objects, meteor showers ---------------------------------------------
function showerCheck(data, sh) {
  const name = `${sh.name}: Earth crosses the ${sh.parent === '3200' ? 'Phaethon' : sh.parent} stream ~${sh.peak.replace('-', '/')}`;
  const el = data?.available ? parentElements(data, sh) : null;
  if (!el) return data?.available ? { name, status: 'FAIL', detail: 'parent orbit not found in the data' } : SKIP_NO_DATA(name);
  const year = new Date().getUTCFullYear();
  const c = earthCrossing(el, sh, year);
  const peak = utcToTDB(utcStringToJD(`${year}-${sh.peak} 12:00`));
  const dDays = c.jd - peak, sep = angSep(c.radiant.ra, c.radiant.dec, sh.radiant[0], sh.radiant[1]), dv = c.vg - sh.vg;
  const ok = Math.abs(dDays) <= 5 && sep < 6 && Math.abs(dv) < 3;
  return { name, status: ok ? 'PASS' : 'FAIL',
    detail: `closest ${jdToDate(c.jd)} UTC (${dDays >= 0 ? '+' : ''}${dDays.toFixed(1)} d vs peak) at ${c.dist.toFixed(4)} AU from the parent orbit; radiant RA ${c.radiant.ra.toFixed(1)}°, Dec ${c.radiant.dec.toFixed(1)}° (${sep.toFixed(1)}° from IMO ${sh.radiant[0]}°, ${sh.radiant[1]}°); v_g ${c.vg.toFixed(1)} km/s (IMO ${sh.vg})` };
}

function interstellarCheck(data) {
  const name = 'Interstellar objects: hyperbolic excess speed v∞ and ʻOumuamua radiant';
  const objs = data?.files?.interstellar?.objects;
  if (!objs) return SKIP_NO_DATA(name);
  const expect = [[/Oumuamua/, 26.3, 0.6], [/Borisov/, 32.3, 0.6], [/2025 N1/, 58.0, 1.5]];
  const parts = [], bad = [];
  for (const [re, v, tol] of expect) {
    const o = objs.find((x) => re.test(x.name));
    if (!o) { bad.push(String(re)); continue; }
    const vi = vInfinity(o.q, o.e);
    parts.push(`${o.name.split(' (')[0]} ${vi.toFixed(1)} km/s (expect ${v})`);
    if (Math.abs(vi - v) > tol) bad.push(o.name);
  }
  const ou = objs.find((x) => /Oumuamua/.test(x.name));
  if (ou) {
    const rad = eclipticToRaDec(asymptotes({ q: ou.q, e: ou.e, i: ou.i, node: ou.om, peri: ou.w }).inbound);
    const sep = angSep(rad.ra, rad.dec, 279.8, 33.9);
    parts.push(`ʻOumuamua came from RA ${rad.ra.toFixed(1)}°, Dec ${rad.dec.toFixed(1)}° (${sep.toFixed(1)}° from the published 279.8°, +33.9°, near Vega)`);
    if (sep > 2) bad.push('radiant');
  }
  return { name, status: bad.length ? 'FAIL' : 'PASS', detail: parts.join('; ') + (objs.length > 3 ? `; +${objs.length - 3} newer` : '') };
}

function dustLagCheck(data) {
  const name = 'Dust tail curves behind the orbital motion (syndyne/synchrone model)';
  const t = data?.files?.comets;
  if (!t) return SKIP_NO_DATA(name);
  const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
  const r = t.rows.find((x) => x[c.pdes] === '2020 F3');
  if (!r) return { name, status: 'SKIP', detail: 'C/2020 F3 (NEOWISE) not in this data/' };
  const el = { q: r[c.q], e: r[c.e], i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.tp] };
  const pos = conicPos(el);
  const jd = utcToTDB(utcStringToJD('2020-07-20 00:00'));
  const g = dustGrid(pos, jd);
  const s = stateFrom(pos, jd), n = s.r, rn = norm(n), anti = n.map((x) => x / rn);
  // Lag is measured against the transverse velocity (v minus its radial part): the side the tail bends toward.
  const vr = dot(s.v, anti), vT = s.v.map((x, k) => x - vr * anti[k]), vHat = vT.map((x) => x / norm(vT));
  // Synchrone j (all β emitted at one time) is a straight ray from the nucleus; a curved, lagging tail
  // means the ray angle from anti-sunward grows with age and older rays sit on the −v (trailing) side.
  const ray = (j) => {
    let d = [0, 0, 0];
    for (let k = 0; k < g.nb; k++) { const i = (k * g.na + j) * 3; for (let m = 0; m < 3; m++) d[m] += g.points[i + m] - n[m]; }
    const l = norm(d); d = d.map((x) => x / l);
    return { ang: Math.acos(Math.max(-1, Math.min(1, dot(d, anti)))) / DEG, behind: -dot(d, vHat), age: DUST_AGES[j] };
  };
  const rays = [6, 12, 20, 31].map(ray);
  const monotonic = rays.every((r, k) => k === 0 || r.ang > rays[k - 1].ang);
  const ok = monotonic && rays[0].ang > 2 && rays[0].ang < 30 && rays.every((r) => r.behind > 0);
  return { name, status: ok ? 'PASS' : 'FAIL',
    detail: `NEOWISE on 2020-07-20 (17 d after perihelion): synchrone angle from the anti-sunward ion-tail axis ` +
      rays.map((r) => `${r.age.toFixed(0)} d → ${r.ang.toFixed(0)}°${r.behind > 0 ? ' trailing' : ''}`).join(', ') +
      ` — ${monotonic ? 'curves steadily' : 'NOT monotonic'} toward −v` };
}

export function runDataChecks(ctx = {}) {
  const data = ctx.data;
  const out = [];
  const safe = (fn) => { try { out.push(fn()); } catch (e) { out.push({ name: fn.name || 'data check', status: 'FAIL', detail: 'exception: ' + e.message }); } };
  safe(() => dataManifestCheck(data));
  safe(() => gpuKeplerCheck(ctx));
  safe(() => hermiteCheck(data));
  safe(() => halleyCheck(data));
  safe(() => cometPerihelion(data, 'Hale-Bopp perihelion 1997-04-01, ~0.914 AU', /Hale-Bopp/, '1997-04-01 05:00', 0.914, 0.003, 'comets', 'halebopp'));
  safe(() => cometPerihelion(data, "ʻOumuamua perihelion 2017-09-09, ~0.256 AU", /Oumuamua/, '2017-09-09 12:00', 0.256, 0.002, 'interstellar'));
  safe(() => apophisCheck(data));
  safe(() => kirkwoodCheck(data));
  safe(() => trojanCheck(data));
  safe(() => plutinoCheck(data));
  safe(() => dartCheck());
  safe(() => namedBodiesCheck(ctx));
  for (const sh of SHOWERS) safe(() => showerCheck(data, sh));
  safe(() => interstellarCheck(data));
  safe(() => dustLagCheck(data));
  return out;
}

export function runVerify(ctx = {}) {
  const nowUTC = unixMsToJD(Date.now());
  const year = new Date().getUTCFullYear();
  const results = [];
  const safe = (fn) => { try { const r = fn(); results.push(...(Array.isArray(r) ? r : [r])); } catch (e) { results.push({ name: fn.name, status: 'FAIL', detail: 'exception: ' + e.message }); } };
  safe(solarEclipse2024);
  safe(lunarEclipse2025);
  safe(eventsEngineCheck);
  safe(() => perihelionAphelion(year));
  safe(() => horizonsCheck('jupiter', nowUTC));
  safe(() => horizonsCheck('mars', nowUTC));
  safe(() => ioPeriod(nowUTC));
  safe(() => synodicMonth(nowUTC));
  safe(moonsVsHorizons);
  safe(solarEclipseShadow);
  safe(lunarEclipseColor);
  safe(solverChecks);
  safe(() => spinSenseCheck(nowUTC));
  safe(earthDaylightCheck);
  results.push(...runDataChecks(ctx));
  return results;
}
