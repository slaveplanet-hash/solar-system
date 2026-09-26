// =============================================================================
// moons.js — Major planetary satellites.
//
// Positions come from mean elements FITTED to JPL Horizons planetocentric vectors
// over 1850–2050 (tools/fit-moons.mjs → js/data/moonElements.js). The published
// JPL SSD mean elements (https://ssd.jpl.nasa.gov/sats/elem/, epoch J2000, table
// below) seed the fit and supply the apsidal/nodal precession rates; the fit adds
// the true mean-longitude rate, tidal acceleration (Phobos), the Mimas–Tethys
// libration and Laplace-resonance terms for Io/Europa/Ganymede.
//
// Reference planes: satellite Laplace plane or the planet's equator (right-hand-rule
// pole); node measured from that plane's ascending node on the ICRF equator.
// Earth's Moon stays on the Meeus theory in ephemeris.js. Pure JS, Node-testable.
// =============================================================================
import { DEG, ellipticPosition } from './kepler.js';
import { J2000 } from './time.js';
import { OBLIQUITY_J2000 } from './ephemeris.js';
import { MOON_ELEMENTS } from './data/moonElements.js';

// JPL SSD table columns (fit seed): parent, frame ('L' Laplace | 'E' equatorial), a (km), e, ω, M, i, node (deg),
//          P (days), P_apsis (yr), P_node (yr), Laplace pole α, δ (deg)
// Physical: radius (km, mean; `shape` = triaxial semi-axes for irregular moons), mass (kg), color, surface style.
export const MOON_DATA = [
  { key: 'phobos',    name: 'Phobos',    parent: 'mars',    frame: 'L', a: 9375,    e: 0.015, w: 216.3, M: 189.7, i: 1.1,   node: 169.2, P: 0.3187,    Pw: 1.1,     Pn: 2.3,     ra: 317.7, dec: 52.9, radius: 11.08,  shape: [13.0, 11.4, 9.1], mass: 1.0659e16, color: '#9a8d80', proc: 'phobos' },
  { key: 'deimos',    name: 'Deimos',    parent: 'mars',    frame: 'L', a: 23457,   e: 0.000, w: 0.0,   M: 205.0, i: 1.8,   node: 54.3,  P: 1.2625,    Pw: 0,       Pn: 56.2,    ra: 316.6, dec: 53.5, radius: 6.2,    shape: [7.8, 6.0, 5.1],   mass: 1.4762e15, color: '#a89a88', proc: 'phobos' },
  { key: 'io',        name: 'Io',        parent: 'jupiter', frame: 'L', a: 421800,  e: 0.004, w: 49.1,  M: 330.9, i: 0.0,   node: 0.0,   P: 1.762732,  Pw: 1.333,   Pn: 0,       ra: 268.1, dec: 64.5, radius: 1821.6, mass: 8.9319e22, color: '#e8d25a', proc: 'io' },
  { key: 'europa',    name: 'Europa',    parent: 'jupiter', frame: 'L', a: 671100,  e: 0.009, w: 45.0,  M: 345.4, i: 0.5,   node: 184.0, P: 3.525463,  Pw: 1.394,   Pn: 30.202,  ra: 268.1, dec: 64.5, radius: 1560.8, mass: 4.7998e22, color: '#d9cdb4', proc: 'europa' },
  { key: 'ganymede',  name: 'Ganymede',  parent: 'jupiter', frame: 'L', a: 1070400, e: 0.001, w: 198.3, M: 324.8, i: 0.2,   node: 58.5,  P: 7.155588,  Pw: 68.301,  Pn: 137.812, ra: 268.2, dec: 64.6, radius: 2631.2, mass: 1.4819e23, color: '#a99e8e', proc: 'ganymede' },
  { key: 'callisto',  name: 'Callisto',  parent: 'jupiter', frame: 'L', a: 1882700, e: 0.007, w: 43.8,  M: 87.4,  i: 0.3,   node: 309.1, P: 16.690440, Pw: 277.921, Pn: 577.264, ra: 268.7, dec: 64.8, radius: 2410.3, mass: 1.0759e23, color: '#7d7163', proc: 'callisto' },
  { key: 'mimas',     name: 'Mimas',     parent: 'saturn',  frame: 'L', a: 186000,  e: 0.020, w: 160.4, M: 275.3, i: 1.6,   node: 66.2,  P: 0.942422,  Pw: 0.493,   Pn: 0.986,   ra: 40.6,  dec: 83.5, radius: 198.2,  mass: 3.75e19,   color: '#c8c6c2', proc: 'icy' },
  { key: 'enceladus', name: 'Enceladus', parent: 'saturn',  frame: 'L', a: 238400,  e: 0.005, w: 119.5, M: 57.0,  i: 0.0,   node: 0.0,   P: 1.370218,  Pw: 2.916,   Pn: 0,       ra: 40.6,  dec: 83.5, radius: 252.1,  mass: 1.08e20,   color: '#f4f7fa', proc: 'enceladus' },
  { key: 'tethys',    name: 'Tethys',    parent: 'saturn',  frame: 'L', a: 295000,  e: 0.001, w: 335.3, M: 0.0,   i: 1.1,   node: 273.0, P: 1.887802,  Pw: 0.005,   Pn: 4.982,   ra: 40.6,  dec: 83.5, radius: 531.1,  mass: 6.17e20,   color: '#e3e1dc', proc: 'icy' },
  { key: 'dione',     name: 'Dione',     parent: 'saturn',  frame: 'L', a: 377700,  e: 0.002, w: 116.0, M: 212.0, i: 0.0,   node: 0.0,   P: 2.736916,  Pw: 11.698,  Pn: 0,       ra: 40.6,  dec: 83.5, radius: 561.4,  mass: 1.095e21,  color: '#d8d6d1', proc: 'icy' },
  { key: 'rhea',      name: 'Rhea',      parent: 'saturn',  frame: 'L', a: 527200,  e: 0.001, w: 44.3,  M: 31.5,  i: 0.3,   node: 133.7, P: 4.517503,  Pw: 33.939,  Pn: 35.775,  ra: 40.6,  dec: 83.5, radius: 763.8,  mass: 2.307e21,  color: '#cfccc6', proc: 'icy' },
  { key: 'titan',     name: 'Titan',     parent: 'saturn',  frame: 'L', a: 1221900, e: 0.029, w: 78.3,  M: 11.7,  i: 0.3,   node: 78.6,  P: 15.945448, Pw: 346.680, Pn: 687.370, ra: 36.4,  dec: 84.0, radius: 2574.7, mass: 1.3452e23, color: '#e0a44a', proc: 'titan' },
  { key: 'iapetus',   name: 'Iapetus',   parent: 'saturn',  frame: 'L', a: 3561700, e: 0.028, w: 254.5, M: 74.8,  i: 7.6,   node: 86.5,  P: 79.331002, Pw: 1662.900,Pn: 3130.302,ra: 288.7, dec: 78.9, radius: 734.5,  mass: 1.806e21,  color: '#b9a98f', proc: 'iapetus' },
  { key: 'miranda',   name: 'Miranda',   parent: 'uranus',  frame: 'E', a: 129846,  e: 0.001, w: 154.8, M: 73.0,  i: 4.4,   node: 100.9, P: 1.413479,  Pw: 8.939,   Pn: 17.787,  radius: 235.8,  mass: 6.4e19,    color: '#bfbdb8', proc: 'miranda' },
  { key: 'ariel',     name: 'Ariel',     parent: 'uranus',  frame: 'E', a: 190929,  e: 0.001, w: 9.6,   M: 193.5, i: 0.0,   node: 0.0,   P: 2.520379,  Pw: 28.901,  Pn: 0,       radius: 578.9,  mass: 1.251e21,  color: '#cfcbc4', proc: 'icy' },
  { key: 'umbriel',   name: 'Umbriel',   parent: 'uranus',  frame: 'E', a: 265986,  e: 0.004, w: 183.4, M: 253.0, i: 0.1,   node: 174.8, P: 4.144177,  Pw: 64.126,  Pn: 129.745, radius: 584.7,  mass: 1.275e21,  color: '#7c7a78', proc: 'dark' },
  { key: 'titania',   name: 'Titania',   parent: 'uranus',  frame: 'E', a: 436298,  e: 0.002, w: 184.0, M: 68.1,  i: 0.1,   node: 29.5,  P: 8.705869,  Pw: 579.928, Pn: 1644.649,radius: 788.9,  mass: 3.4e21,    color: '#bdb3a8', proc: 'icy' },
  { key: 'oberon',    name: 'Oberon',    parent: 'uranus',  frame: 'E', a: 583511,  e: 0.002, w: 132.2, M: 143.6, i: 0.1,   node: 76.8,  P: 13.463237, Pw: 158.604, Pn: 192.798, radius: 761.4,  mass: 3.076e21,  color: '#a99e93', proc: 'dark' },
  { key: 'triton',    name: 'Triton',    parent: 'neptune', frame: 'L', a: 354800,  e: 0.000, w: 0.0,   M: 63.0,  i: 157.3, node: 178.1, P: 5.876994,  Pw: 0,       Pn: 340.379, ra: 299.8, dec: 43.1, radius: 1353.4, mass: 2.139e22,  color: '#dcc9c0', proc: 'triton' },
  { key: 'charon',    name: 'Charon',    parent: 'pluto',   frame: 'E', a: 19600,   e: 0.000, w: 0.0,   M: 304.1, i: 0.0,   node: 0.0,   P: 6.387222,  Pw: 0,       Pn: 0,       radius: 606.0,  mass: 1.586e21,  color: '#a8a39c', proc: 'charon' },
];
export const MOON_BY_KEY = Object.fromEntries(MOON_DATA.map((m) => [m.key, m]));

/** Rotation taking reference-plane coordinates (x → plane's node on ICRF equator, z → pole) to ICRF, then to ecliptic J2000. */
function planeToEcliptic(alpha, delta) {
  const A = (alpha + 90) * DEG, B = (90 - delta) * DEG;
  const cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
  // Rz(A)·Rx(B) (active), row-major
  const m = [cA, -sA * cB, sA * sB, sA, cA * cB, -cA * sB, 0, sB, cB];
  const ce = Math.cos(OBLIQUITY_J2000), se = Math.sin(OBLIQUITY_J2000);
  // equatorial → ecliptic: y' = c·y + s·z, z' = −s·y + c·z
  return [m[0], m[1], m[2],
    ce * m[3] + se * m[6], ce * m[4] + se * m[7], ce * m[5] + se * m[8],
    -se * m[3] + ce * m[6], -se * m[4] + ce * m[7], -se * m[5] + ce * m[8]];
}
const _frameCache = new Map();
function frameMatrix(key) {
  let R = _frameCache.get(key);
  if (!R) { const [a, d] = MOON_ELEMENTS[key].pole; R = planeToEcliptic(a, d); _frameCache.set(key, R); }
  return R;
}

/** Mean longitude (deg) without periodic terms — the argument used by resonance terms. */
function meanLongitude(el, t) { return el.lam0 + el.n * t + 0.5 * el.ndot * t * t; }

/**
 * Orbital elements of a moon at jdTDB in its reference frame:
 * { a, e, i, node, argPeri, M } (km, radians) plus the frame→ecliptic matrix R.
 */
export function moonElementsAt(key, jdTDB) {
  const el = MOON_ELEMENTS[key];
  const t = jdTDB - J2000;
  const lamMean = meanLongitude(el, t);
  let lam = lamMean;
  for (const q of el.res) {   // arguments use MEAN longitudes (as in the fit)
    const arg = q.k * (lamMean - meanLongitude(MOON_ELEMENTS[q.with], t)) * DEG;
    lam += q.s * Math.sin(arg) + q.c * Math.cos(arg);
  }
  if (el.lib) {
    const a = (2 * Math.PI * t) / el.lib.P;
    el.lib.h.forEach(([s, c], k) => { lam += s * Math.sin((k + 1) * a) + c * Math.cos((k + 1) * a); });
  }
  if (el.lib2) { const a = (2 * Math.PI * t) / el.lib2.P; lam += el.lib2.s * Math.sin(a) + el.lib2.c * Math.cos(a); }
  const varpi = el.varpi0 + el.varpiRate * t;
  const node = el.node0 + el.nodeRate * t;
  return { a: el.a, e: el.e, i: el.i * DEG, node: node * DEG, argPeri: (varpi - node) * DEG, M: (lam - varpi) * DEG, R: frameMatrix(key) };
}

/** Rotate a frame vector to ecliptic J2000. */
export function frameToEcliptic(R, p, out = [0, 0, 0]) {
  out[0] = R[0] * p[0] + R[1] * p[1] + R[2] * p[2];
  out[1] = R[3] * p[0] + R[4] * p[1] + R[5] * p[2];
  out[2] = R[6] * p[0] + R[7] * p[1] + R[8] * p[2];
  return out;
}

const _p = [0, 0, 0];
/** Planetocentric ecliptic-J2000 position (km) of a moon at jdTDB. */
export function moonPlanetocentricKm(key, jdTDB, out = [0, 0, 0]) {
  const o = moonElementsAt(key, jdTDB);
  ellipticPosition(o.a, o.e, o.i, o.node, o.argPeri, o.M, _p);
  return frameToEcliptic(o.R, _p, out);
}

/** Charon's share of the Pluto–Charon mass: Standish's "Pluto" is the system barycenter. */
export const CHARON_MASS_FRACTION = 1.586e21 / (1.303e22 + 1.586e21);

/**
 * All moons' planetocentric positions (km, ecliptic J2000) into `state.moons[key]`.
 * Call right after computeSystemState(): it also moves Pluto from the Pluto–Charon
 * barycenter to Pluto's own center (≈ 2,130 km wobble).
 */
export function computeMoonStates(jdTDB, state) {
  state.moons = state.moons || {};
  for (const m of MOON_DATA) state.moons[m.key] = moonPlanetocentricKm(m.key, jdTDB, state.moons[m.key]);
  if (state.pluto) {
    const c = state.moons.charon;
    for (let i = 0; i < 3; i++) state.pluto[i] -= c[i] * CHARON_MASS_FRACTION;
  }
  return state;
}
