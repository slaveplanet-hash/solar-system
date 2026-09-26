// =============================================================================
// ephemeris.js — Positions and orientations of the Sun, planets, Pluto and Moon.
//
// Data sources (all inline):
//  • Planets + Pluto: E.M. Standish, "Keplerian Elements for Approximate Positions
//    of the Major Planets", JPL SSD, Table 1 (valid 1800–2050 AD).
//  • Moon: Meeus, "Astronomical Algorithms" 2nd ed., ch. 47 (ELP-2000/82 truncated,
//    Tables 47.A and 47.B; ≈10″ in longitude, ≈4″ latitude).
//  • Rotation: IAU WGCCRE 2009/2015 reports (pole α0, δ0 and prime meridian W).
//  • Earth rotation: GMST (IAU 1982 / Meeus 12.4).
//
// Frames:  "ecliptic" = heliocentric ecliptic & mean equinox of J2000 (km).
//          three.js world axes: X = ecl X, Y = ecl Z (north), Z = −ecl Y.
// Pure JS — no three.js import — so the math can be unit-tested in Node.
// =============================================================================
import { DEG, wrap360, ellipticPosition } from './kepler.js';
import { J2000, centuries } from './time.js';

export const AU_KM = 149597870.7;
export const C_KM_S = 299792.458;
export const OBLIQUITY_J2000 = 23.4392911 * DEG;
export const EARTH_MOON_MASS_RATIO = 81.30056;

// --- Standish Table 1 (1800–2050) -------------------------------------------
// [a (AU), e, I (deg), L (deg), ϖ long.peri (deg), Ω long.node (deg)] and rates per Julian century.
export const PLANET_ELEMENTS = {
  mercury: [[0.38709927, 0.20563593, 7.00497902, 252.25032350, 77.45779628, 48.33076593],
            [0.00000037, 0.00001906, -0.00594749, 149472.67411175, 0.16047689, -0.12534081]],
  venus:   [[0.72333566, 0.00677672, 3.39467605, 181.97909950, 131.60246718, 76.67984255],
            [0.00000390, -0.00004107, -0.00078890, 58517.81538729, 0.00268329, -0.27769418]],
  emb:     [[1.00000261, 0.01671123, -0.00001531, 100.46457166, 102.93768193, 0.0],
            [0.00000562, -0.00004392, -0.01294668, 35999.37244981, 0.32327364, 0.0]],
  mars:    [[1.52371034, 0.09339410, 1.84969142, -4.55343205, -23.94362959, 49.55953891],
            [0.00001847, 0.00007882, -0.00813131, 19140.30268499, 0.44441088, -0.29257343]],
  jupiter: [[5.20288700, 0.04838624, 1.30439695, 34.39644051, 14.72847983, 100.47390909],
            [-0.00011607, -0.00013253, -0.00183714, 3034.74612775, 0.21252668, 0.20469106]],
  saturn:  [[9.53667594, 0.05386179, 2.48599187, 49.95424423, 92.59887831, 113.66242448],
            [-0.00125060, -0.00050991, 0.00193609, 1222.49362201, -0.41897216, -0.28867794]],
  uranus:  [[19.18916464, 0.04725744, 0.77263783, 313.23810451, 170.95427630, 74.01692503],
            [-0.00196176, -0.00004397, -0.00242939, 428.48202785, 0.40805281, 0.04240589]],
  neptune: [[30.06992276, 0.00859048, 1.77004347, -55.12002969, 44.96476227, 131.78422574],
            [0.00026291, 0.00005105, 0.00035372, 218.45945325, -0.32241464, -0.00508664]],
  pluto:   [[39.48211675, 0.24882730, 17.14001206, 238.92903833, 224.06891629, 110.30393684],
            [-0.00031596, 0.00005170, 0.00004818, 145.20780515, -0.04062942, -0.01183482]],
};

/** Osculating-ish elements for the date: {a, e, i, node, argPeri, M} (AU, radians). */
export function planetElements(key, jdTDB) {
  const [el0, rate] = PLANET_ELEMENTS[key];
  const T = centuries(jdTDB);
  const a = el0[0] + rate[0] * T;
  const e = el0[1] + rate[1] * T;
  const I = el0[2] + rate[2] * T;
  const L = el0[3] + rate[3] * T;
  const varpi = el0[4] + rate[4] * T;
  const Om = el0[5] + rate[5] * T;
  const w = varpi - Om;
  const M = wrap360(L - varpi);
  return { a, e, i: I * DEG, node: Om * DEG, argPeri: w * DEG, M: M * DEG };
}

/** Heliocentric ecliptic J2000 position of a Table-1 body in km. */
export function planetHelioKm(key, jdTDB, out = [0, 0, 0]) {
  const el = planetElements(key, jdTDB);
  ellipticPosition(el.a * AU_KM, el.e, el.i, el.node, el.argPeri, el.M, out);
  return out;
}

// --- Moon: Meeus ch. 47 -------------------------------------------------------
// Table 47.A rows: D, M, M', F, Σl (1e-6 deg, sine), Σr (1e-3 km, cosine)
const MOON_LR = [
  [0,0,1,0,6288774,-20905355],[2,0,-1,0,1274027,-3699111],[2,0,0,0,658314,-2955968],[0,0,2,0,213618,-569925],
  [0,1,0,0,-185116,48888],[0,0,0,2,-114332,-3149],[2,0,-2,0,58793,246158],[2,-1,-1,0,57066,-152138],
  [2,0,1,0,53322,-170733],[2,-1,0,0,45758,-204586],[0,1,-1,0,-40923,-129620],[1,0,0,0,-34720,108743],
  [0,1,1,0,-30383,104755],[2,0,0,-2,15327,10321],[0,0,1,2,-12528,0],[0,0,1,-2,10980,79661],
  [4,0,-1,0,10675,-34782],[0,0,3,0,10034,-23210],[4,0,-2,0,8548,-21636],[2,1,-1,0,-7888,24208],
  [2,1,0,0,-6766,30824],[1,0,-1,0,-5163,-8379],[1,1,0,0,4987,-16675],[2,-1,1,0,4036,-12831],
  [2,0,2,0,3994,-10445],[4,0,0,0,3861,-11650],[2,0,-3,0,3665,14403],[0,1,-2,0,-2689,-7003],
  [2,0,-1,2,-2602,0],[2,-1,-2,0,2390,10056],[1,0,1,0,-2348,6322],[2,-2,0,0,2236,-9884],
  [0,1,2,0,-2120,5751],[0,2,0,0,-2069,0],[2,-2,-1,0,2048,-4950],[2,0,1,-2,-1773,4130],
  [2,0,0,2,-1595,0],[4,-1,-1,0,1215,-3958],[0,0,2,2,-1110,0],[3,0,-1,0,-892,3258],
  [2,1,1,0,-810,2616],[4,-1,-2,0,759,-1897],[0,2,-1,0,-713,-2117],[2,2,-1,0,-700,2354],
  [2,1,-2,0,691,0],[2,-1,0,-2,596,0],[4,0,1,0,549,-1423],[0,0,4,0,537,-1117],
  [4,-1,0,0,520,-1571],[1,0,-2,0,-487,-1739],[2,1,0,-2,-399,0],[0,0,2,-2,-381,-4421],
  [1,1,1,0,351,0],[3,0,-2,0,-340,0],[4,0,-3,0,330,0],[2,-1,2,0,327,0],
  [0,2,1,0,-323,1165],[1,1,-1,0,299,0],[2,0,3,0,294,0],[2,0,-1,-2,0,8752],
];
// Table 47.B rows: D, M, M', F, Σb (1e-6 deg, sine)
const MOON_B = [
  [0,0,0,1,5128122],[0,0,1,1,280602],[0,0,1,-1,277693],[2,0,0,-1,173237],[2,0,-1,1,55413],
  [2,0,-1,-1,46271],[2,0,0,1,32573],[0,0,2,1,17198],[2,0,1,-1,9266],[0,0,2,-1,8822],
  [2,-1,0,-1,8216],[2,0,-2,-1,4324],[2,0,1,1,4200],[2,1,0,-1,-3359],[2,-1,-1,1,2463],
  [2,-1,0,1,2211],[2,-1,-1,-1,2065],[0,1,-1,-1,-1870],[4,0,-1,-1,1828],[0,1,0,1,-1794],
  [0,0,0,3,-1749],[0,1,-1,1,-1565],[1,0,0,1,-1491],[0,1,1,1,-1475],[0,1,1,-1,-1410],
  [0,1,0,-1,-1344],[1,0,0,-1,-1335],[0,0,3,1,1107],[4,0,0,-1,1021],[4,0,-1,1,833],
  [0,0,1,-3,777],[4,0,-2,1,671],[2,0,0,-3,607],[2,0,2,-1,596],[2,-1,1,-1,491],
  [2,0,-2,1,-451],[0,0,3,-1,439],[2,0,2,1,422],[2,0,-3,-1,421],[2,1,-1,1,-366],
  [2,1,0,1,-351],[4,0,0,1,331],[2,-1,1,1,315],[2,-2,0,-1,302],[0,0,1,3,-283],
  [2,1,1,-1,-229],[1,1,0,-1,223],[1,1,0,1,223],[0,1,-2,-1,-220],[2,1,-1,-1,-220],
  [1,0,1,1,-185],[2,-1,-2,-1,181],[0,1,2,1,-177],[4,0,-2,-1,176],[4,-1,-1,-1,166],
  [1,0,1,-1,-164],[4,0,1,-1,132],[1,0,-1,-1,-119],[4,-1,0,-1,115],[2,-2,0,1,107],
];

/**
 * Geocentric Moon, ecliptic J2000 (km). Meeus ch. 47 gives mean-ecliptic-of-date
 * coordinates; we rotate them to J2000 with the IAU 1976 ecliptic precession angles.
 */
export function moonGeoKm(jdTDB, out = [0, 0, 0]) {
  const T = centuries(jdTDB);
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  const Lp = wrap360(218.3164477 + 481267.88123421 * T - 0.0015786 * T2 + T3 / 538841 - T4 / 65194000);
  const D  = wrap360(297.8501921 + 445267.1114034 * T - 0.0018819 * T2 + T3 / 545868 - T4 / 113065000);
  const M  = wrap360(357.5291092 + 35999.0502909 * T - 0.0001536 * T2 + T3 / 24490000);
  const Mp = wrap360(134.9633964 + 477198.8675055 * T + 0.0087414 * T2 + T3 / 69699 - T4 / 14712000);
  const F  = wrap360(93.2720950 + 483202.0175233 * T - 0.0036539 * T2 - T3 / 3526000 + T4 / 863310000);
  const A1 = wrap360(119.75 + 131.849 * T), A2 = wrap360(53.09 + 479264.290 * T), A3 = wrap360(313.45 + 481266.484 * T);
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const Ef = [1, E, E * E];
  let sl = 0, sr = 0, sb = 0;
  for (const [d, m, mp, f, l, r] of MOON_LR) {
    const arg = (d * D + m * M + mp * Mp + f * F) * DEG;
    const k = Ef[Math.abs(m)];
    sl += l * k * Math.sin(arg);
    sr += r * k * Math.cos(arg);
  }
  for (const [d, m, mp, f, b] of MOON_B) {
    sb += b * Ef[Math.abs(m)] * Math.sin((d * D + m * M + mp * Mp + f * F) * DEG);
  }
  sl += 3958 * Math.sin(A1 * DEG) + 1962 * Math.sin((Lp - F) * DEG) + 318 * Math.sin(A2 * DEG);
  sb += -2235 * Math.sin(Lp * DEG) + 382 * Math.sin(A3 * DEG) + 175 * Math.sin((A1 - F) * DEG)
      + 175 * Math.sin((A1 + F) * DEG) + 127 * Math.sin((Lp - Mp) * DEG) - 115 * Math.sin((Lp + Mp) * DEG);
  const lam = (Lp + sl / 1e6) * DEG;
  const bet = (sb / 1e6) * DEG;
  const dist = 385000.56 + sr / 1000;
  // Vector in the mean ecliptic & equinox of date
  const x = dist * Math.cos(bet) * Math.cos(lam);
  const y = dist * Math.cos(bet) * Math.sin(lam);
  const z = dist * Math.sin(bet);
  return eclipticOfDateToJ2000(x, y, z, jdTDB, out);
}

/**
 * Rotate from mean ecliptic/equinox of date to ecliptic J2000 (Lieske 1977 angles, Meeus 21.5).
 * v_J2000 = Rz(Π) · Rx(−π) · Rz(−(p + Π)) · v_date, where π = inclination of the date
 * ecliptic on the J2000 ecliptic, Π = longitude of its node, p = general precession in longitude.
 */
export function eclipticOfDateToJ2000(x, y, z, jdTDB, out = [0, 0, 0]) {
  const t = centuries(jdTDB);
  const eta = (47.0029 * t - 0.03302 * t * t) / 3600 * DEG;                        // π
  const Pi = (174.876384 * 3600 - 869.8089 * t + 0.03536 * t * t) / 3600 * DEG;    // Π
  const p = (5029.0966 * t + 1.11113 * t * t) / 3600 * DEG;                         // p
  // Rz(−(p+Π)): longitude measured from the node
  let a = -(p + Pi), c = Math.cos(a), s = Math.sin(a);
  let x1 = c * x - s * y, y1 = s * x + c * y, z1 = z;
  // Rx(−π): tilt from date ecliptic to J2000 ecliptic
  c = Math.cos(-eta); s = Math.sin(-eta);
  const y2 = c * y1 - s * z1, z2 = s * y1 + c * z1;
  // Rz(Π)
  c = Math.cos(Pi); s = Math.sin(Pi);
  out[0] = c * x1 - s * y2; out[1] = s * x1 + c * y2; out[2] = z2;
  return out;
}

// --- Composite: all positions for a date --------------------------------------
export const PLANET_KEYS = ['mercury', 'venus', 'earth', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune', 'pluto'];

/**
 * Heliocentric ecliptic J2000 positions (km) for Sun, planets, Pluto and Moon.
 * Earth and Moon are split from the Earth–Moon barycenter with the mass ratio.
 */
export function computeSystemState(jdTDB, state = {}) {
  state.sun = state.sun || [0, 0, 0];
  for (const k of PLANET_KEYS) {
    if (k === 'earth') continue;
    state[k] = planetHelioKm(k, jdTDB, state[k]);
  }
  const emb = planetHelioKm('emb', jdTDB, [0, 0, 0]);
  const moonGeo = moonGeoKm(jdTDB, state.moonGeo);
  state.moonGeo = moonGeo;
  const f = 1 / (1 + EARTH_MOON_MASS_RATIO);
  state.earth = state.earth || [0, 0, 0];
  state.moon = state.moon || [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    state.earth[i] = emb[i] - moonGeo[i] * f;
    state.moon[i] = state.earth[i] + moonGeo[i];
  }
  return state;
}

// --- Rotation ------------------------------------------------------------------
/** Greenwich Mean Sidereal Time (degrees) for a UT1≈UTC Julian date (Meeus 12.4). */
export function gmstDeg(jdUT) {
  const T = (jdUT - J2000) / 36525;
  return wrap360(280.46061837 + 360.98564736629 * (jdUT - J2000) + 0.000387933 * T * T - T * T * T / 38710000);
}

/**
 * IAU WGCCRE rotation models. α0, δ0 (deg, ICRF) and W (deg) as functions of
 * d = days since J2000 TDB and T = Julian centuries. Earth uses GMST instead of W.
 * Negative W rates are retrograde rotators (Venus, Uranus, Pluto).
 */
export const ROTATION_MODELS = {
  sun:     (d, T) => [286.13, 63.87, 84.176 + 14.1844000 * d],
  mercury: (d, T) => [281.0103 - 0.0328 * T, 61.4155 - 0.0049 * T, 329.5988 + 6.1385108 * d],
  venus:   (d, T) => [272.76, 67.16, 160.20 - 1.4813688 * d],
  earth:   (d, T) => [0.00 - 0.641 * T, 90.00 - 0.557 * T, 190.147 + 360.9856235 * d], // W replaced by GMST
  // Moon: IAU mean rotation (synchronous → tidally locked; physical libration terms omitted, ≤ ~1.5°)
  moon:    (d, T) => [269.9949 + 0.0031 * T, 66.5392 + 0.0130 * T, 38.3213 + 13.17635815 * d - 1.4e-12 * d * d],
  mars:    (d, T) => [317.68143 - 0.1061 * T, 52.88650 - 0.0609 * T, 176.630 + 350.89198226 * d],
  jupiter: (d, T) => [268.056595 - 0.006499 * T, 64.495303 + 0.002413 * T, 284.95 + 870.5360000 * d],
  saturn:  (d, T) => [40.589 - 0.036 * T, 83.537 - 0.004 * T, 38.90 + 810.7939024 * d],
  uranus:  (d, T) => [257.311, -15.175, 203.81 - 501.1600928 * d],
  neptune: (d, T) => {
    const N = (357.85 + 52.316 * T) * DEG;
    return [299.36 + 0.70 * Math.sin(N), 43.46 - 0.51 * Math.cos(N), 253.18 + 536.3128492 * d - 0.48 * Math.sin(N)];
  },
  pluto:   (d, T) => [132.993, -6.163, 302.695 + 56.3625225 * d],
};

/**
 * Body-fixed → ecliptic-J2000 rotation matrix (row-major 3×3, columns = body axes).
 * Body frame: x → prime meridian, z → north pole, y → 90° E.
 */
export function bodyToEclipticMatrix(key, jdTDB, jdUTC) {
  const model = ROTATION_MODELS[key];
  if (!model) return null;
  const d = jdTDB - J2000, T = d / 36525;
  let [a0, d0, W] = model(d, T);
  if (key === 'earth') {
    // Earth's prime meridian: GMST is the hour angle of Greenwich from the mean equinox
    // OF DATE. W is measured from the node of the date equator on the ICRF equator; along
    // the date equator that node lies 90° + z before the equinox of date (z = IAU 1976
    // precession angle), so W = GMST − 90° − z.
    const z = (2306.2181 * T + 1.09468 * T * T) / 3600;
    W = gmstDeg(jdUTC) - 90 - z;
  }
  return iauMatrix(a0, d0, W);
}

/**
 * Body→ecliptic-J2000 matrix from an IAU-style pole (α0, δ0, ICRF degrees) and prime-meridian angle W (deg).
 * Columns = body axes (x → prime meridian, z → north/positive pole), row-major.
 */
export function iauMatrix(a0, d0, W) {
  const A = (a0 + 90) * DEG, B = (90 - d0) * DEG, Wr = wrap360(W) * DEG;
  // ICRF → body: R = Rz(W)·Rx(90°−δ0)·Rz(90°+α0). We need body → ICRF = Rᵀ.
  const R = matMul(rotZ(Wr), matMul(rotX(B), rotZ(A)));
  const Rt = transpose(R);
  // ICRF (equatorial J2000) → ecliptic J2000 is Rx(+ε) in the passive sense.
  return matMul(rotX(OBLIQUITY_J2000), Rt);
}

/** Ecliptic J2000 direction (λ, β deg) → equatorial J2000 (α, δ deg): converts published spin poles. */
export function eclipticToEquatorial(lamDeg, betDeg) {
  const l = lamDeg * DEG, b = betDeg * DEG, e = OBLIQUITY_J2000;
  const x = Math.cos(b) * Math.cos(l), y = Math.cos(b) * Math.sin(l), z = Math.sin(b);
  const ye = Math.cos(e) * y - Math.sin(e) * z, ze = Math.sin(e) * y + Math.cos(e) * z;
  return [wrap360(Math.atan2(ye, x) / DEG), Math.asin(ze) / DEG];
}

// Passive (frame) rotation matrices, row-major.
function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, c, s, 0, -s, c]; }
function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, s, 0, -s, c, 0, 0, 0, 1]; }
function transpose(m) { return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]; }
function matMul(a, b) {
  const r = new Array(9);
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
    r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
export function matVec(m, v) {
  return [m[0] * v[0] + m[1] * v[1] + m[2] * v[2], m[3] * v[0] + m[4] * v[1] + m[5] * v[2], m[6] * v[0] + m[7] * v[1] + m[8] * v[2]];
}

/** Equatorial J2000 → ecliptic J2000 (vector). */
export function equToEcl(v) {
  const c = Math.cos(OBLIQUITY_J2000), s = Math.sin(OBLIQUITY_J2000);
  return [v[0], c * v[1] + s * v[2], -s * v[1] + c * v[2]];
}

/**
 * Sub-solar point on a body (planetographic-style lon/lat, degrees; east-positive longitude
 * measured in the body frame). Used by self-tests of rotation phase.
 */
export function subSolarPoint(key, bodyHelioKm, jdTDB, jdUTC) {
  const M = bodyToEclipticMatrix(key, jdTDB, jdUTC);
  const s = [-bodyHelioKm[0], -bodyHelioKm[1], -bodyHelioKm[2]];
  // body = Mᵀ · ecl
  const b = [M[0] * s[0] + M[3] * s[1] + M[6] * s[2], M[1] * s[0] + M[4] * s[1] + M[7] * s[2], M[2] * s[0] + M[5] * s[1] + M[8] * s[2]];
  const r = Math.hypot(...b);
  return { lon: wrap360(Math.atan2(b[1], b[0]) / DEG), lat: Math.asin(b[2] / r) / DEG };
}

/** Ecliptic longitude (deg) of a heliocentric vector. */
export function eclLonDeg(v) { return wrap360(Math.atan2(v[1], v[0]) / DEG); }
