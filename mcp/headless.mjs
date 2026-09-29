// =============================================================================
// mcp/headless.mjs — Simulation tools that run in Node, without a browser: the same
// ephemerides, eclipse/conjunction search and SGP4 satellite code the simulator uses.
// Every function takes plain arguments and returns a plain object (the MCP server
// serialises it). Times in and out are UTC (ISO 8601); errors are thrown as Error.
// =============================================================================
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { computeSystemState, bodyToEclipticMatrix, gmstDeg, AU_KM, C_KM_S, OBLIQUITY_J2000, PLANET_KEYS } from '../js/ephemeris.js';
import { computeMoonStates, MOON_DATA } from '../js/moons.js';
import { utcToTDB, tdbToUTC, unixMsToJD, jdToUnixMs } from '../js/time.js';
import { solarEclipses, lunarEclipses, conjunctions, computeEvents, PLANET_NAMES } from '../js/events.js';
import { DataStore } from '../js/datastore.js';
import { satRecords, satPosition, temeToEclipticMatrix, satValidity, satOrbitSummary, SAT_GROUPS, FRESH_DAYS, MAX_DAYS } from '../js/satcore.js';
import { sgp4 } from '../js/vendor/satellite/index.js';

const DEG = Math.PI / 180;
const MIN_JD = 2378496.5, MAX_JD = 2470172.5;              // 1800-01-01 … 2050-12-31 (validity of the planetary elements)
const WGS84_A = 6378.137, WGS84_F = 1 / 298.257223563, WGS84_E2 = WGS84_F * (2 - WGS84_F);

// --- time ------------------------------------------------------------------------
/** 'now' or an ISO date/time (UTC unless a zone is given) → JD UTC, range-checked. */
export function parseTime(s, name = 'time') {
  if (s == null || s === '' || s === 'now') return unixMsToJD(Date.now());
  let t = String(s).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00';
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z';
  const ms = Date.parse(t);
  if (!isFinite(ms)) throw new Error(`${name}: cannot read "${s}" — use ISO 8601 UTC, e.g. 2026-08-12T17:45 or "now"`);
  const jd = unixMsToJD(ms);
  if (jd < MIN_JD || jd > MAX_JD) throw new Error(`${name}: ${s} is outside 1800–2050, the range of the planetary model`);
  return jd;
}
export const iso = (jdUTC) => new Date(jdToUnixMs(jdUTC)).toISOString().replace(/\.\d{3}Z$/, 'Z');
const r2 = (x, d = 2) => (x == null || !isFinite(x) ? null : Number(x.toFixed(d)));

// --- bodies ------------------------------------------------------------------------
const MOON_PARENT = Object.fromEntries(MOON_DATA.map((m) => [m.key, m.parent]));
const NAMES = { sun: 'Sun', moon: 'Moon', earth: 'Earth', pluto: 'Pluto', ...PLANET_NAMES, ...Object.fromEntries(MOON_DATA.map((m) => [m.key, m.name])) };
export const BODY_KEYS = ['sun', ...PLANET_KEYS, 'moon', ...MOON_DATA.map((m) => m.key)];

export function bodyKey(name) {
  const k = String(name || '').trim().toLowerCase();
  if (NAMES[k]) return k;
  const hit = Object.entries(NAMES).find(([, n]) => n.toLowerCase() === k);
  if (hit) return hit[0];
  throw new Error(`Unknown body "${name}". Known: ${BODY_KEYS.join(', ')} (small bodies and spacecraft: use the browser tools; satellites: satellite_find)`);
}

function stateAt(jdTDB) {
  const s = computeSystemState(jdTDB, {});
  computeMoonStates(jdTDB, s);
  return s;
}
function helioOf(key, s) {
  if (key === 'sun') return [0, 0, 0];
  if (key === 'moon') return s.moon;
  if (MOON_PARENT[key]) { const p = s[MOON_PARENT[key]], m = s.moons[key]; return [p[0] + m[0], p[1] + m[1], p[2] + m[2]]; }
  return s[key];
}
/** Geocentric ecliptic-J2000 vector (km) of a body, light-time corrected (one iteration). */
function geocentric(key, jdTDB) {
  const s = stateAt(jdTDB), e = s.earth;
  if (key === 'earth') return { g: [0, 0, 0], s };
  let h = helioOf(key, s), g = [h[0] - e[0], h[1] - e[1], h[2] - e[2]];
  const lt = Math.hypot(...g) / C_KM_S / 86400;
  h = helioOf(key, stateAt(jdTDB - lt));
  g = [h[0] - e[0], h[1] - e[1], h[2] - e[2]];
  return { g, s };
}
function eclToEqu(v) {
  const c = Math.cos(OBLIQUITY_J2000), sn = Math.sin(OBLIQUITY_J2000);
  return [v[0], c * v[1] - sn * v[2], sn * v[1] + c * v[2]];
}
function raDec(v) {
  const q = eclToEqu(v), r = Math.hypot(...q);
  return { ra: ((Math.atan2(q[1], q[0]) / DEG) + 360) % 360, dec: Math.asin(q[2] / r) / DEG };
}
const fmtRA = (deg) => { const h = deg / 15, H = Math.floor(h), m = (h - H) * 60, M = Math.floor(m); return `${H}h ${String(M).padStart(2, '0')}m ${((m - M) * 60).toFixed(1)}s`; };
const fmtDec = (deg) => { const a = Math.abs(deg), D = Math.floor(a), m = (a - D) * 60; return `${deg < 0 ? '−' : '+'}${D}° ${Math.floor(m)}′ ${((m - Math.floor(m)) * 60).toFixed(0)}″`; };

// --- observer geometry (WGS84, Earth-fixed = the simulator's Earth orientation) ---
function observerECEF(latDeg, lonDeg, hM = 0) {
  const la = latDeg * DEG, lo = lonDeg * DEG, h = hM / 1000;
  const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(la) ** 2);
  return [(N + h) * Math.cos(la) * Math.cos(lo), (N + h) * Math.cos(la) * Math.sin(lo), (N * (1 - WGS84_E2) + h) * Math.sin(la)];
}
function enuBasis(latDeg, lonDeg) {
  const la = latDeg * DEG, lo = lonDeg * DEG;
  return { e: [-Math.sin(lo), Math.cos(lo), 0], n: [-Math.sin(la) * Math.cos(lo), -Math.sin(la) * Math.sin(lo), Math.cos(la)],
    u: [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)] };
}
/** Earth-fixed vector (km) seen from the observer → { az (deg from N through E), alt (deg), range (km) } (geometric, no refraction). */
function lookAngles(ecefTarget, obs) {
  const d = [ecefTarget[0] - obs.p[0], ecefTarget[1] - obs.p[1], ecefTarget[2] - obs.p[2]];
  const E = d[0] * obs.b.e[0] + d[1] * obs.b.e[1] + d[2] * obs.b.e[2];
  const N = d[0] * obs.b.n[0] + d[1] * obs.b.n[1] + d[2] * obs.b.n[2];
  const U = d[0] * obs.b.u[0] + d[1] * obs.b.u[1] + d[2] * obs.b.u[2];
  const range = Math.hypot(E, N, U);
  return { az: ((Math.atan2(E, N) / DEG) + 360) % 360, alt: Math.asin(U / range) / DEG, range };
}
function makeObserver(lat, lon, elevation_m = 0) {
  if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 360)) throw new Error('lat must be −90…90 and lon −180…180 (degrees, east positive)');
  return { lat, lon, p: observerECEF(lat, lon, elevation_m), b: enuBasis(lat, lon) };
}
/** Ecliptic-J2000 geocentric vector → Earth-fixed (the simulator's Earth rotation model: IAU pole + GMST). */
function eclToECEF(v, jdTDB, jdUTC) {
  const M = bodyToEclipticMatrix('earth', jdTDB, jdUTC);      // body → ecliptic (row-major); transpose for ecliptic → body
  return [M[0] * v[0] + M[3] * v[1] + M[6] * v[2], M[1] * v[0] + M[4] * v[1] + M[7] * v[2], M[2] * v[0] + M[5] * v[1] + M[8] * v[2]];
}
function compass(az) { return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round(az / 22.5) % 16]; }
function sunAltAt(obs, jdUTC) {
  const jdT = utcToTDB(jdUTC), s = computeSystemState(jdT, {});
  return lookAngles(eclToECEF([-s.earth[0], -s.earth[1], -s.earth[2]], jdT, jdUTC), obs).alt;
}

// =============================================================================
// Tools
// =============================================================================
export function bodyPosition({ body, time, lat, lon, elevation_m }) {
  const key = bodyKey(body), jdU = parseTime(time), jdT = utcToTDB(jdU);
  const { g, s } = geocentric(key, jdT);
  const h = helioOf(key, s), rS = Math.hypot(...h), dE = Math.hypot(...g);
  const out = { body: NAMES[key], time_utc: iso(jdU), time_tdb_jd: r2(jdT, 6),
    distance_from_sun: { km: Math.round(rS), au: r2(rS / AU_KM, 6) } };
  if (key !== 'earth') {
    const sun = [-s.earth[0], -s.earth[1], -s.earth[2]];
    const elong = Math.acos((g[0] * sun[0] + g[1] * sun[1] + g[2] * sun[2]) / (dE * Math.hypot(...sun))) / DEG;
    const { ra, dec } = raDec(g);
    Object.assign(out, { distance_from_earth: { km: Math.round(dE), au: r2(dE / AU_KM, 8) }, light_time_s: r2(dE / C_KM_S, 3),
      ra_dec_j2000: { ra_deg: r2(ra, 5), dec_deg: r2(dec, 5), ra: fmtRA(ra), dec: fmtDec(dec) }, elongation_from_sun_deg: r2(elong, 3) });
    if (key !== 'sun') {
      // Illuminated fraction from the Sun–body–Earth phase angle.
      const toSun = [-h[0], -h[1], -h[2]], toEarth = [-g[0], -g[1], -g[2]];
      const ph = Math.acos((toSun[0] * toEarth[0] + toSun[1] * toEarth[1] + toSun[2] * toEarth[2]) / (Math.hypot(...toSun) * dE));
      out.phase_angle_deg = r2(ph / DEG, 2); out.illuminated_fraction = r2((1 + Math.cos(ph)) / 2, 3);
    }
  }
  if (lat != null && lon != null && key !== 'earth') {
    const obs = makeObserver(+lat, +lon, +(elevation_m || 0));
    const la = lookAngles(eclToECEF(g, jdT, jdU), obs);
    out.from_observer = { lat: +lat, lon: +lon, azimuth_deg: r2(la.az, 2), direction: compass(la.az), altitude_deg: r2(la.alt, 2), above_horizon: la.alt > 0,
      note: 'Topocentric, geometric (no atmospheric refraction: near the horizon objects appear ~0.5° higher).' };
  }
  out.accuracy = key === 'moon' ? 'Moon: Meeus series, ~10″ (a few km).' : MOON_PARENT[key] ? 'Mean elements fitted to JPL Horizons (see npm test).' : 'JPL Standish elements: arcsecond-level for 1800–2050 (checked against Horizons in npm test).';
  return out;
}

export function skyAt({ lat, lon, time, elevation_m }) {
  const obs = makeObserver(+lat, +lon, +(elevation_m || 0));
  const jdU = parseTime(time), jdT = utcToTDB(jdU);
  const rows = [];
  for (const key of ['sun', 'moon', 'mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune']) {
    const { g } = geocentric(key, jdT);
    const la = lookAngles(eclToECEF(g, jdT, jdU), obs);
    rows.push({ body: NAMES[key], altitude_deg: r2(la.alt, 1), azimuth_deg: r2(la.az, 1), direction: compass(la.az), up: la.alt > 0 });
  }
  const sunAlt = rows[0].altitude_deg;
  const moon = bodyPosition({ body: 'moon', time: iso(jdU) });
  return { observer: { lat: +lat, lon: +lon }, time_utc: iso(jdU),
    sky: sunAlt > 0 ? 'day' : sunAlt > -6 ? 'civil twilight' : sunAlt > -12 ? 'nautical twilight' : sunAlt > -18 ? 'astronomical twilight' : 'night',
    moon_illuminated_fraction: moon.illuminated_fraction, bodies: rows,
    note: 'Geometric altitudes (no refraction). Planets are visible to the eye when up and the Sun is well below the horizon; Venus/Jupiter even in twilight.' };
}

export function findEclipses({ from, to, kind = 'both' }) {
  const j0 = parseTime(from, 'from'), j1 = to ? parseTime(to, 'to') : j0 + 3 * 365.25;
  if (j1 <= j0) throw new Error('"to" must be after "from"');
  if (j1 - j0 > 50 * 365.25) throw new Error('Search at most 50 years at a time');
  const t0 = utcToTDB(j0), t1 = utcToTDB(j1), out = [];
  if (kind !== 'lunar') for (const e of solarEclipses(t0, t1)) out.push({ kind: 'solar', type: e.type, greatest_eclipse_utc: iso(tdbToUTC(e.jd)), gamma: r2(e.gamma, 4) });
  if (kind !== 'solar') for (const e of lunarEclipses(t0, t1)) out.push({ kind: 'lunar', type: e.type, greatest_eclipse_utc: iso(tdbToUTC(e.jd)), gamma: r2(e.gamma, 4), umbral_magnitude: r2(e.umbralMag, 3) });
  out.sort((a, b) => a.greatest_eclipse_utc.localeCompare(b.greatest_eclipse_utc));
  return { from_utc: iso(j0), to_utc: iso(j1), count: out.length, eclipses: out,
    accuracy: 'Every eclipse of 2021–2030 matches NASA’s catalogue (type, and time within 10 min — usually far less). γ = closest approach of the shadow axis to Earth’s centre in Earth radii. To watch one: sim_show_event or sim_set_time + sim_focus.' };
}

export function findConjunctions({ from, to, max_separation_deg = 1.5 }) {
  const j0 = parseTime(from, 'from'), j1 = to ? parseTime(to, 'to') : j0 + 365.25;
  if (j1 <= j0) throw new Error('"to" must be after "from"');
  if (j1 - j0 > 20 * 365.25) throw new Error('Search at most 20 years at a time');
  const list = conjunctions(utcToTDB(j0), utcToTDB(j1), Math.min(10, +max_separation_deg || 1.5)).sort((a, b) => a.jd - b.jd);
  return { from_utc: iso(j0), to_utc: iso(j1), count: list.length,
    conjunctions: list.map((c) => ({ time_utc: iso(tdbToUTC(c.jd)), bodies: [PLANET_NAMES[c.a], PLANET_NAMES[c.b]], separation_deg: r2(c.sepDeg, 3),
      separation: c.sepDeg < 1 ? `${(c.sepDeg * 60).toFixed(1)}′` : `${c.sepDeg.toFixed(2)}°`, elongation_from_sun_deg: r2(c.elongDeg, 1), observable: c.elongDeg >= 15 })),
    note: 'Geocentric separation minima between planets. "observable" = at least 15° from the Sun.' };
}

// --- data-backed tools (lazy: loads ./data once) -----------------------------------
let _data = null;
async function data(root) {
  if (!_data) _data = await new DataStore(join(root, 'data') + '/', async (p) => JSON.parse(await readFile(p, 'utf8'))).load();
  return _data;
}
export function reloadData() { _data = null; _sats = null; }

export async function upcomingEvents({ from, days = 365, types }, root) {
  const d = await data(root), j0 = parseTime(from, 'from');
  days = Math.max(1, Math.min(5 * 365, +days || 365));
  let ev = computeEvents(d, utcToTDB(j0), days);
  if (types?.length) ev = ev.filter((e) => types.includes(e.type));
  return { from_utc: iso(j0), days, data_available: d.available, count: ev.length,
    events: ev.map((e) => ({ time_utc: iso(tdbToUTC(e.jd)), type: e.type, title: e.title, detail: e.detail })),
    types: ['solar-eclipse', 'lunar-eclipse', 'conjunction', 'meteor-shower', 'close-approach', 'comet-perihelion', 'interstellar-perihelion'],
    note: d.available ? 'Close approaches come from JPL’s CAD table (their times/distances); comet magnitudes are rough.' : 'No data/ folder: only eclipses, conjunctions and meteor showers. Run update.bat.' };
}

// --- satellites -----------------------------------------------------------------------
let _sats = null, _satMtime = 0;
async function sats(root) {
  // Pick up a newer snapshot (update.bat) without restarting the MCP server.
  const { mtimeMs } = await stat(join(root, 'data', 'satellites.json')).catch(() => ({ mtimeMs: 0 }));
  if (_sats && mtimeMs !== _satMtime) { _sats = null; _data = null; }
  _satMtime = mtimeMs;
  if (!_sats) {
    const d = await data(root);
    if (!d.satellites) throw new Error('No satellite data — run update.bat (or node fetch-data.mjs --satellites)');
    _sats = { list: satRecords(d.satellites), generated: d.satellites.generated };
  }
  return _sats;
}
// Common names that differ from the catalogue's OBJECT_NAME.
const SAT_ALIASES = { HUBBLE: 20580, 'HUBBLE SPACE TELESCOPE': 20580, ISS: 25544, 'SPACE STATION': 25544, 'INTERNATIONAL SPACE STATION': 25544, TIANGONG: 48274, 'CHINESE SPACE STATION': 48274 };
function findSat(list, q) {
  let s = String(q ?? '').trim();
  if (SAT_ALIASES[s.toUpperCase()]) s = String(SAT_ALIASES[s.toUpperCase()]);
  if (/^\d+$/.test(s)) { const x = list.find((o) => o.norad === +s); if (x) return x; }
  const u = s.toUpperCase();
  const exact = list.find((o) => o.name.toUpperCase() === u || o.intl === u);
  if (exact) return exact;
  const part = list.filter((o) => o.name.toUpperCase().includes(u));
  if (part.length === 1) return part[0];
  if (part.length > 1) {
    const iss = u === 'ISS' ? part.find((o) => o.norad === 25544) : null;
    if (iss) return iss;
    throw new Error(`"${q}" matches ${part.length} satellites (${part.slice(0, 8).map((o) => `${o.name} [${o.norad}]`).join(', ')}${part.length > 8 ? ', …' : ''}) — use the NORAD number`);
  }
  throw new Error(`No satellite "${q}" in the snapshot (${list.length} objects: stations, GNSS, weather, science, geostationary, brightest). Try satellite_find.`);
}

export async function satelliteFind({ query = '', group, limit = 25 }, root) {
  const { list, generated } = await sats(root);
  let u = String(query).toUpperCase();
  if (SAT_ALIASES[u]) u = String(SAT_ALIASES[u]);
  const gi = group ? SAT_GROUPS.findIndex((g) => g.key === group || g.name.toLowerCase() === String(group).toLowerCase()) : -1;
  if (group && gi < 0) throw new Error(`Unknown group "${group}". Groups: ${SAT_GROUPS.map((g) => g.key).join(', ')}`);
  const hits = list.filter((o) => (gi < 0 || o.group === gi) && (!u || o.name.toUpperCase().includes(u) || String(o.norad) === u || o.intl === u));
  return { snapshot: generated, total: hits.length, groups: SAT_GROUPS.map((g, i) => ({ key: g.key, name: g.name, count: list.filter((o) => o.group === i).length })),
    satellites: hits.slice(0, Math.min(200, +limit || 25)).map((o) => ({ name: o.name, norad: o.norad, cospar: o.intl, group: SAT_GROUPS[o.group].key,
      period_min: r2(o.periodMin, 1), element_epoch_utc: iso(o.epoch) })) };
}

/** Satellite position → Earth-fixed km (TEME rotated by GMST, like the simulator). */
function satECEF(sat, jdUTC, out = [0, 0, 0]) {
  const s = sgp4(sat.rec, (jdUTC - sat.epoch) * 1440);
  if (!s) return null;
  const g = gmstDeg(jdUTC) * DEG, c = Math.cos(g), sn = Math.sin(g), p = s.position;
  out[0] = c * p.x + sn * p.y; out[1] = -sn * p.x + c * p.y; out[2] = p.z;
  return out;
}
function geodetic(p) {                                      // ECEF km → WGS84 lat/lon (deg), height (km)
  const lon = Math.atan2(p[1], p[0]), rxy = Math.hypot(p[0], p[1]);
  let lat = Math.atan2(p[2], rxy * (1 - WGS84_E2)), h = 0;
  for (let i = 0; i < 6; i++) {
    const N = WGS84_A / Math.sqrt(1 - WGS84_E2 * Math.sin(lat) ** 2);
    h = rxy / Math.cos(lat) - N;
    lat = Math.atan2(p[2], rxy * (1 - WGS84_E2 * N / (N + h)));
  }
  return { lat: lat / DEG, lon: lon / DEG, h };
}
function sunlit(satEcl, jdTDB) {                             // cylindrical Earth shadow
  const e = computeSystemState(jdTDB, {}).earth, n = Math.hypot(...e), sd = [-e[0] / n, -e[1] / n, -e[2] / n];
  const along = satEcl[0] * sd[0] + satEcl[1] * sd[1] + satEcl[2] * sd[2];
  return along > 0 || Math.sqrt(Math.max(0, satEcl[0] ** 2 + satEcl[1] ** 2 + satEcl[2] ** 2 - along * along)) > 6378.137;
}
function validityNote(sat, jdU) {
  const v = satValidity(sat, jdU), d = Math.abs(jdU - sat.epoch);
  if (v === 'expired') throw new Error(`${sat.name}: the date is ${d.toFixed(0)} days from its element epoch (${iso(sat.epoch)}); SGP4 is only used within ±${MAX_DAYS} days. Run update.bat for fresh elements (or pick a date near the snapshot).`);
  return v === 'fresh' ? `Elements ${d < 1 ? (d * 24).toFixed(1) + ' h' : d.toFixed(1) + ' d'} from epoch: typically ~1 km, growing ~1–3 km/day in low orbit.`
    : `⚠ ${d.toFixed(1)} days from the element epoch (> ${FRESH_DAYS}): approximate — low-orbit positions can be off by tens of km (pass times by a minute or more).`;
}

export async function satelliteState({ satellite, time, lat, lon, elevation_m }, root) {
  const { list } = await sats(root), sat = findSat(list, satellite);
  const jdU = parseTime(time), jdT = utcToTDB(jdU), note = validityNote(sat, jdU);
  const ecl = [0, 0, 0], vel = [0, 0, 0];
  if (!satPosition(sat, jdU, temeToEclipticMatrix(jdT, jdU), ecl, vel)) throw new Error(`SGP4 failed for ${sat.name} at ${iso(jdU)} (decayed?)`);
  const ecef = satECEF(sat, jdU), geo = geodetic(ecef), o = satOrbitSummary(sat);
  const out = { name: sat.name, norad: sat.norad, cospar: sat.intl, group: SAT_GROUPS[sat.group].name, time_utc: iso(jdU),
    subpoint: { lat: r2(geo.lat, 4), lon: r2(geo.lon, 4) }, altitude_km: r2(geo.h, 2), speed_km_s: r2(Math.hypot(...vel), 3),
    sunlit: sunlit(ecl, jdT), orbit: { perigee_km: Math.round(o.perigee), apogee_km: Math.round(o.apogee), inclination_deg: r2(o.incl, 3), period_min: r2(o.periodMin, 2) },
    element_epoch_utc: iso(sat.epoch), accuracy: note };
  if (lat != null && lon != null) {
    const obs = makeObserver(+lat, +lon, +(elevation_m || 0)), la = lookAngles(ecef, obs);
    out.from_observer = { azimuth_deg: r2(la.az, 2), direction: compass(la.az), elevation_deg: r2(la.alt, 2), range_km: r2(la.range, 1), above_horizon: la.alt > 0 };
  }
  return out;
}

export async function satellitePasses({ satellite, lat, lon, elevation_m = 0, from, days = 3, min_elevation_deg = 10, visible_only = false }, root) {
  const { list } = await sats(root), sat = findSat(list, satellite);
  const obs = makeObserver(+lat, +lon, +elevation_m);
  const j0 = parseTime(from, 'from');
  days = Math.max(0.1, Math.min(10, +days || 3));
  const j1 = j0 + days;
  validityNote(sat, j0); validityNote(sat, j1);
  if (sat.periodMin > 600) {
    const la = lookAngles(satECEF(sat, j0), obs);
    return { name: sat.name, norad: sat.norad, note: `Period ${(sat.periodMin / 60).toFixed(1)} h: this satellite barely moves across the sky, so it has no passes. Right now it is at azimuth ${la.az.toFixed(1)}° (${compass(la.az)}), elevation ${la.alt.toFixed(1)}°.`, passes: [] };
  }
  const p = [0, 0, 0];
  const elev = (jd) => (satECEF(sat, jd, p) ? lookAngles(p, obs).alt : -90);
  const step = 20 / 86400, passes = [];
  let prevT = j0, prevE = elev(j0);
  for (let t = j0 + step; t <= j1 + step; t += step) {
    const e = elev(t);
    if (prevE < 0 && e >= 0) {                                            // rise
      const bis = (a, b, up) => { for (let i = 0; i < 30; i++) { const m = (a + b) / 2; if ((elev(m) >= 0) === up) b = m; else a = m; } return (a + b) / 2; };
      const rise = bis(prevT, t, true);
      let u = t; while (elev(u) >= 0 && u < rise + 0.05) u += step;          // up to 72 min above the horizon
      const set = bis(u - step, u, false);
      // Peak: golden-section on the elevation.
      let a = rise, b = set; const g = (Math.sqrt(5) - 1) / 2;
      for (let i = 0; i < 40; i++) { const c = b - g * (b - a), d = a + g * (b - a); if (elev(c) > elev(d)) b = d; else a = c; }
      const peak = (a + b) / 2, maxE = elev(peak);
      if (maxE >= min_elevation_deg) {
        const lk = (jd) => { satECEF(sat, jd, p); return lookAngles(p, obs); };
        // Visible to the eye: satellite sunlit while the observer's Sun is below −6° (sampled every 10 s).
        let vis0 = null, vis1 = null;
        for (let tt = rise; tt <= set; tt += 10 / 86400) {
          const jdT = utcToTDB(tt), ecl = [0, 0, 0];
          satPosition(sat, tt, temeToEclipticMatrix(jdT, tt), ecl);
          if (sunlit(ecl, jdT) && sunAltAt(obs, tt) < -6) { vis0 ??= tt; vis1 = tt; }
        }
        const R = lk(rise), P = lk(peak), S = lk(set);
        const pass = { rise_utc: iso(rise), rise_azimuth_deg: r2(R.az, 1), rise_direction: compass(R.az),
          max_utc: iso(peak), max_elevation_deg: r2(maxE, 1), max_azimuth_deg: r2(P.az, 1), max_direction: compass(P.az), min_range_km: Math.round(P.range),
          set_utc: iso(set), set_azimuth_deg: r2(S.az, 1), set_direction: compass(S.az), duration_s: Math.round((set - rise) * 86400),
          visible_to_eye: vis0 != null, ...(vis0 != null ? { visible_from_utc: iso(vis0), visible_until_utc: iso(vis1) } : {}) };
        if (!visible_only || pass.visible_to_eye) passes.push(pass);
      }
      t = set; prevT = set; prevE = elev(set + 1e-7);
      continue;
    }
    prevT = t; prevE = e;
  }
  return { name: sat.name, norad: sat.norad, observer: { lat: +lat, lon: +lon, elevation_m: +elevation_m }, from_utc: iso(j0), to_utc: iso(j1),
    min_elevation_deg: +min_elevation_deg, count: passes.length, passes,
    accuracy: validityNote(sat, j0) + ' Elevations are geometric (no refraction). "visible_to_eye" = sunlit satellite and the Sun at least 6° below your horizon.' };
}
