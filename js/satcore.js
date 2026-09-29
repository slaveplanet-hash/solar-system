// =============================================================================
// satcore.js — Earth satellites from CelesTrak GP data (OMM mean elements), pure JS
// (Node-testable; the three.js layer is satellites.js).
//
// Chain, verified against JPL Horizons' ISS track (tests/satellites.test.mjs):
//   1. SGP4/SDP4 (vendored satellite.js) at minutes since the element epoch, in UTC:
//      the sim clock is TDB, ~69 s ahead — passing it unconverted misplaces LEO by ~500 km.
//   2. SGP4 output is TEME (true equator, "uniform" equinox). Rotating by GMST (the
//      same IAU-82 angle TEME is defined with) gives Earth-fixed coordinates;
//   3. the simulator's own Earth orientation (bodyToEclipticMatrix: IAU pole + GMST)
//      takes them to ecliptic J2000. The GMST terms cancel, so one matrix per frame
//      maps TEME → ecliptic, and every satellite sits over exactly the ground point of
//      the drawn globe. Left out: nutation and polar motion (≲ 0.3 km in LEO, ≲ 2 km at GEO).
//
// Accuracy of the elements themselves: ~1 km at epoch, growing ~1–3 km/day in LEO
// (drag); much slower for GNSS/GEO. Hence the validity window below.
// =============================================================================
import { json2satrec, sgp4 } from './vendor/satellite/index.js';
import { bodyToEclipticMatrix, gmstDeg } from './ephemeris.js';

const DEG = Math.PI / 180;
export const R_EARTH = 6378.137;

// CelesTrak groups, in PRIORITY order: an object listed in several groups keeps the first
// ("visual" = the ~150 brightest objects, many of them rocket bodies, goes last).
export const SAT_GROUPS = [
  { key: 'stations', name: 'Space stations', celestrak: 'stations', color: '#ffd166' },
  { key: 'gps', name: 'GPS', celestrak: 'gps-ops', color: '#6fcf97' },
  { key: 'galileo', name: 'Galileo', celestrak: 'galileo', color: '#56ccf2' },
  { key: 'glonass', name: 'GLONASS', celestrak: 'glo-ops', color: '#ff7a7a' },
  { key: 'beidou', name: 'BeiDou', celestrak: 'beidou', color: '#f2a65a' },
  { key: 'weather', name: 'Weather', celestrak: 'weather', color: '#c38bff' },
  { key: 'science', name: 'Science', celestrak: 'science', color: '#2dd4bf' },
  { key: 'geo', name: 'Geostationary', celestrak: 'geo', color: '#7fb8ff' },
  { key: 'visual', name: 'Brightest (naked-eye)', celestrak: 'visual', color: '#d8d8d8' },
];

/** OMM keywords stored per row (plus our group key), in this order. */
export const SAT_COLUMNS = ['OBJECT_NAME', 'OBJECT_ID', 'NORAD_CAT_ID', 'EPOCH', 'MEAN_MOTION', 'ECCENTRICITY', 'INCLINATION',
  'RA_OF_ASC_NODE', 'ARG_OF_PERICENTER', 'MEAN_ANOMALY', 'BSTAR', 'MEAN_MOTION_DOT', 'MEAN_MOTION_DDOT', 'group'];

// Validity: full brightness within FRESH_DAYS of the element epoch, dimmed ("approximate")
// up to MAX_DAYS, hidden beyond (LEO predictions are then off by tens to hundreds of km).
export const FRESH_DAYS = 3;
export const MAX_DAYS = 30;
export const ISS_NORAD = 25544;

/** CelesTrak OMM objects (group key → array) → table rows, de-duplicated by NORAD id in group priority order. */
export function buildSatTable(byGroup) {
  const seen = new Set(), rows = [];
  for (const g of SAT_GROUPS) {
    for (const o of byGroup[g.key] || []) {
      if (seen.has(o.NORAD_CAT_ID)) continue;
      seen.add(o.NORAD_CAT_ID);
      rows.push(SAT_COLUMNS.map((c) => (c === 'group' ? g.key : o[c] ?? null)));
    }
  }
  return rows;
}

/** UTC Julian date of an OMM epoch string ("2026-09-29T02:38:28.580928", UTC). */
export function ommEpochJD(s) { return Date.parse(s.endsWith('Z') ? s : s + 'Z') / 864e5 + 2440587.5; }

/**
 * Table → satellite records { name, intl, norad, group (index), rec (satrec), epoch (JD UTC), periodMin, omm }.
 * Objects whose elements SGP4 rejects are skipped.
 */
export function satRecords(table) {
  if (!table?.rows) return [];
  const cols = table.columns || SAT_COLUMNS;
  const gi = Object.fromEntries(SAT_GROUPS.map((g, i) => [g.key, i]));
  const out = [];
  for (const r of table.rows) {
    const omm = Object.fromEntries(cols.map((c, i) => [c, r[i]]));
    if (!(omm.MEAN_MOTION > 0) || gi[omm.group] === undefined) continue;
    let rec;
    try { rec = json2satrec(omm); } catch { continue; }
    if (!rec || rec.error) continue;
    out.push({ name: omm.OBJECT_NAME, intl: omm.OBJECT_ID, norad: omm.NORAD_CAT_ID, group: gi[omm.group], rec,
      epoch: ommEpochJD(omm.EPOCH), periodMin: 1440 / omm.MEAN_MOTION, omm });
  }
  return out;
}

/**
 * TEME → ecliptic J2000 (row-major 3×3) at the given time: Earth-fixed (TEME rotated by GMST),
 * then the simulator's Earth body→ecliptic matrix.
 */
export function temeToEclipticMatrix(jdTDB, jdUTC, out = new Array(9)) {
  const M = bodyToEclipticMatrix('earth', jdTDB, jdUTC);
  const g = gmstDeg(jdUTC) * DEG, c = Math.cos(g), s = Math.sin(g);
  // ecl = M · R3(g) · teme, R3(g) = [[c, s, 0], [−s, c, 0], [0, 0, 1]]
  for (let i = 0; i < 3; i++) {
    const a = M[i * 3], b = M[i * 3 + 1];
    out[i * 3] = a * c - b * s;
    out[i * 3 + 1] = a * s + b * c;
    out[i * 3 + 2] = M[i * 3 + 2];
  }
  return out;
}

/**
 * Geocentric ecliptic-J2000 position (km) at jdUTC with the TEME→ecliptic matrix T, or null
 * (SGP4 error, e.g. decayed). vel (optional) receives km/s in the same frame.
 */
export function satPosition(sat, jdUTC, T, out = [0, 0, 0], vel = null) {
  const s = sgp4(sat.rec, (jdUTC - sat.epoch) * 1440);
  if (!s) return null;                               // sgp4 clears satrec.error itself on the next call
  const p = s.position;
  out[0] = T[0] * p.x + T[1] * p.y + T[2] * p.z;
  out[1] = T[3] * p.x + T[4] * p.y + T[5] * p.z;
  out[2] = T[6] * p.x + T[7] * p.y + T[8] * p.z;
  if (vel) {
    const v = s.velocity;
    vel[0] = T[0] * v.x + T[1] * v.y + T[2] * v.z;
    vel[1] = T[3] * v.x + T[4] * v.y + T[5] * v.z;
    vel[2] = T[6] * v.x + T[7] * v.y + T[8] * v.z;
  }
  return out;
}

/** 'fresh' | 'approx' | 'expired' for a date (JD UTC). */
export function satValidity(sat, jdUTC) {
  const d = Math.abs(jdUTC - sat.epoch);
  return d <= FRESH_DAYS ? 'fresh' : d <= MAX_DAYS ? 'approx' : 'expired';
}

/** Mean-element summary for the info panel: perigee/apogee altitude (km), inclination, period. */
export function satOrbitSummary(sat) {
  const n = sat.omm.MEAN_MOTION * 2 * Math.PI / 86400;          // rad/s
  const a = Math.cbrt(398600.4418 / (n * n)), e = sat.omm.ECCENTRICITY;
  return { perigee: a * (1 - e) - R_EARTH, apogee: a * (1 + e) - R_EARTH, incl: sat.omm.INCLINATION, periodMin: sat.periodMin, a };
}

/**
 * Earth-relative offset (ecliptic km) → scene offset (three.js axes). Identical to what
 * SolarSystem.mapHelioToScene does near a planet: exact in TRUE scale (no clamping), the
 * moon mapping (kept outside the enlarged globe) as soon as the visual blend starts.
 * `scale` is a ScaleSystem.
 */
export function nearEarthToScene(rel, scale, out = [0, 0, 0], bodyR = 0.01) {
  if (scale.s <= 0) { out[0] = rel[0]; out[1] = rel[2]; out[2] = -rel[1]; return out; }
  return scale.moonOffsetToScene(rel, R_EARTH, bodyR, out);
}
