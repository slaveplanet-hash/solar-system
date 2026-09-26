// =============================================================================
// fit-moons.mjs — Derive mean orbital elements for the major moons by fitting
// JPL Horizons planetocentric vectors (1850–2050), then write js/data/moonElements.js.
//
// Why: the tabulated JPL mean elements are fine near their epoch but their periods
// are not the mean-longitude rates, and resonant moons (e.g. Mimas, ±44°/70 yr)
// drift badly over decades. A direct fit over the whole 1850–2050 span fixes that.
//
// Model (in each moon's reference frame: Laplace plane or planet equator):
//   orbit plane:  inclination i (fixed), node Ω(t) = Ω0 + Ω̇·t     (Ω̇ from the JPL table)
//   in-plane:     mean longitude λ(t) = λ0 + n·t + Σ libration sinusoids
//                 periapsis ϖ(t) = ϖ0 + ϖ̇·t (ϖ̇ from the JPL table), eccentricity e
//   position:     standard ellipse with M = λ − ϖ, ω = ϖ − Ω.
// Run: node tools/fit-moons.mjs            (≈ 1 minute, 20 Horizons requests)
// =============================================================================
import { writeFileSync } from 'node:fs';
import { MOON_DATA } from '../js/moons.js';
import { OBLIQUITY_J2000, ROTATION_MODELS } from '../js/ephemeris.js';

const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEG = Math.PI / 180, J2000 = 2451545.0, YR = 365.25;
const IDS = { phobos: 401, deimos: 402, io: 501, europa: 502, ganymede: 503, callisto: 504, mimas: 601, enceladus: 602, tethys: 603,
  dione: 604, rhea: 605, titan: 606, iapetus: 608, miranda: 705, ariel: 701, umbriel: 702, titania: 703, oberon: 704, triton: 801, charon: 901 };
const CENTER = { mars: 499, jupiter: 599, saturn: 699, uranus: 799, neptune: 899, pluto: 999 };

// Reference-frame pole (ICRF α, δ). Uranus moons use the right-hand-rule pole (IAU "north" pole flipped);
// Triton uses the flipped Laplace pole so that its orbit is prograde (i ≈ 23°) in the fit frame.
function framePole(m) {
  if (m.frame === 'L') return m.key === 'triton' ? [m.ra + 180, -m.dec] : [m.ra, m.dec];
  const [a0, d0] = ROTATION_MODELS[m.parent](0, 0);
  return m.parent === 'uranus' ? [a0 + 180, -d0] : [a0, d0];
}
function eclToFrame(v, [alpha, delta]) {
  const ce = Math.cos(OBLIQUITY_J2000), se = Math.sin(OBLIQUITY_J2000);
  const q = [v[0], ce * v[1] - se * v[2], se * v[1] + ce * v[2]];
  const A = (alpha + 90) * DEG, B = (90 - delta) * DEG, cA = Math.cos(A), sA = Math.sin(A), cB = Math.cos(B), sB = Math.sin(B);
  const m = [cA, -sA * cB, sA * sB, sA, cA * cB, -cA * sB, 0, sB, cB];
  return [m[0] * q[0] + m[3] * q[1] + m[6] * q[2], m[1] * q[0] + m[4] * q[1] + m[7] * q[2], m[2] * q[0] + m[5] * q[1] + m[8] * q[2]];
}

async function fetchVectors(id, center, jds) {
  const out = [];
  for (let k = 0; k < jds.length; k += 60) {   // chunk TLIST
    const chunk = jds.slice(k, k + 60);
    const p = new URLSearchParams({ format: 'json', COMMAND: `'${id}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'VECTORS'",
      CENTER: `'500@${center}'`, REF_PLANE: "'ECLIPTIC'", REF_SYSTEM: "'J2000'", VEC_TABLE: "'1'", OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'",
      VEC_LABELS: "'NO'", TLIST: `'${chunk.map((j) => j.toFixed(6)).join("','")}'` });
    let ok = false;
    for (let attempt = 0; attempt < 5 && !ok; attempt++) {
      try {
        const j = await (await fetch(`${API}?${p}`)).json();
        if (!j.result.includes('$$SOE')) throw new Error(j.result.slice(0, 200));
        for (const l of j.result.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n')) {
          const c = l.split(',').map((s) => s.trim());
          out.push({ jd: +c[0], v: [+c[2], +c[3], +c[4]] });
        }
        ok = true;
      } catch (e) { console.warn(`  retry ${id}: ${e.message.slice(0, 120)}`); await sleep(1500 * (attempt + 1)); }
    }
    if (!ok) throw new Error(`Horizons failed for ${id}`);
    await sleep(300);
  }
  return out;
}

/** Linear least squares: minimise |A x − b|² via normal equations (small systems). */
function lsq(rows, b) {
  const n = rows[0].length, N = Array.from({ length: n }, () => new Float64Array(n)), y = new Float64Array(n);
  rows.forEach((r, k) => { for (let i = 0; i < n; i++) { y[i] += r[i] * b[k]; for (let j = 0; j < n; j++) N[i][j] += r[i] * r[j]; } });
  // Gaussian elimination with partial pivoting
  const M = N.map((row, i) => [...row, y[i]]);
  for (let c = 0; c < n; c++) {
    let p = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((row, i) => row[n] / row[i]);
}
const wrap180 = (x) => ((x % 360) + 540) % 360 - 180;

async function fitMoon(m, cache = null) {
  const pole = framePole(m);
  const P = m.P;
  // Sample times: dense over a few orbits at J2000 (for the orbit plane), geometric ladder both ways
  // (for unwrapping λ), plus a uniform grid over 1850–2050 (for e, ϖ, libration).
  const t = new Set();
  for (let k = 0; k < 48; k++) t.add(J2000 + (k / 48) * 4 * P);
  for (let s = P / 12; s < 150 * YR; s *= 1.5) { t.add(J2000 + s); t.add(J2000 - s); }
  for (let k = 0; k <= 160; k++) t.add(J2000 - 150 * YR + (k / 160) * 200 * YR + (k % 7) * P * 0.137);
  const jds = [...t].filter((j) => j >= J2000 - 150 * YR && j <= J2000 + 50.9 * YR).sort((a, b) => a - b);
  // Re-use downloaded vectors across resonance rounds (fresh objects each time: the fit annotates them).
  let raw = cache && cache[m.key];
  if (!raw) { raw = await fetchVectors(IDS[m.key], CENTER[m.parent], jds); if (cache) cache[m.key] = raw; }
  const data = raw.map((d) => ({ t: d.jd - J2000, p: eclToFrame(d.v, pole) }));

  // 1) Orbit plane at J2000 from the dense samples (mean angular momentum direction).
  const dense = data.filter((d) => d.t >= 0 && d.t <= 4 * P).sort((a, b) => a.t - b.t);
  const h = [0, 0, 0];
  for (let k = 0; k + 1 < dense.length; k++) {
    const a = dense[k].p, b = dense[k + 1].p;
    h[0] += a[1] * b[2] - a[2] * b[1]; h[1] += a[2] * b[0] - a[0] * b[2]; h[2] += a[0] * b[1] - a[1] * b[0];
  }
  const hn = Math.hypot(...h);
  const inc = Math.acos(h[2] / hn) / DEG;
  const node0 = Math.atan2(h[0], -h[1]) / DEG;
  const sgnI = Math.sign(Math.cos(inc * DEG)) || 1;
  // Nodal precession rate: start from the JPL table and refine by minimising the out-of-plane
  // (latitude) residual over all samples, 1850–2050. Near-equatorial orbits (i < 0.05°) keep the table rate.
  const baseRate = m.Pn ? (-sgnI * 360) / (m.Pn * YR) : 0;
  const planeRms = (rate) => {
    let ss = 0;
    for (const d of data) {
      const O = (node0 + rate * d.t) * DEG, I = inc * DEG;
      const nrm = [Math.sin(I) * Math.sin(O), -Math.sin(I) * Math.cos(O), Math.cos(I)];
      ss += Math.asin((d.p[0] * nrm[0] + d.p[1] * nrm[1] + d.p[2] * nrm[2]) / Math.hypot(...d.p)) ** 2;
    }
    return Math.sqrt(ss / data.length) / DEG;
  };
  let nodeRate = baseRate;
  if (baseRate && inc > 0.05) {
    let best = planeRms(baseRate);
    for (let f = -0.5; f <= 2.5; f += 0.0025) { const r = planeRms(baseRate * f); if (r < best) { best = r; nodeRate = baseRate * f; } }
  }
  const planeResidual = planeRms(nodeRate);
  let wRate = m.Pw ? 360 / (m.Pw * YR) : 0;

  // True longitude in the orbit plane (λ_true = Ω + u) for each sample, radius r.
  for (const d of data) {
    const O = (node0 + nodeRate * d.t) * DEG, I = inc * DEG;
    const x = d.p[0] * Math.cos(O) + d.p[1] * Math.sin(O);
    const y = (-d.p[0] * Math.sin(O) + d.p[1] * Math.cos(O)) * Math.cos(I) + d.p[2] * Math.sin(I);
    d.lamTrue = (O / DEG + Math.atan2(y, x) / DEG);
    d.r = Math.hypot(...d.p);
  }
  // 2) Unwrap λ by growing |t| and refitting λ0 + n t.
  let n = 360 / P, lam0 = data.reduce((best, d) => (Math.abs(d.t) < Math.abs(best.t) ? d : best)).lamTrue;
  const order = [...data].sort((a, b) => Math.abs(a.t) - Math.abs(b.t));
  const used = [];
  for (const d of order) {
    const pred = lam0 + n * d.t;
    d.lam = pred + wrap180(d.lamTrue - pred);
    used.push(d);
    if (used.length >= 3) [lam0, n] = lsq(used.map((u) => [1, u.t]), used.map((u) => u.lam));
  }
  // 3) Full fit: λ_true − (λ0 + n t + ½ṅ t²) ≈ 2e sin(λ − ϖ) + (5/4)e² sin 2(λ − ϖ) + resonance terms + libration.
  //    Columns: [1, t, t²/2 (in centuries² to keep conditioning), e-terms…, resonance s/c…, libration s/c].
  const res = RESONANCE[m.key] || [];
  const C2 = (36525 * 36525);
  // Apsidal precession: for noticeably eccentric orbits, scan the rate (quick fit without libration).
  if (m.e > 0.01 && wRate) {
    const quick = (rate) => {
      const rows = data.map((d) => { const arg = (lam0 + n * d.t - rate * d.t) * DEG;
        return [1, d.t, (d.t * d.t) / C2, 2 * Math.sin(arg), -2 * Math.cos(arg), 1.25 * Math.sin(2 * arg), -1.25 * Math.cos(2 * arg)]; });
      const b = data.map((d) => d.lam * DEG), x = lsq(rows, b);
      let ss = 0; rows.forEach((r, k) => { let v = 0; for (let i = 0; i < r.length; i++) v += r[i] * x[i]; ss += (v - b[k]) ** 2; });
      return ss;
    };
    let best = quick(wRate), bestRate = wRate;
    for (let f = 0.2; f <= 3; f += 0.005) { const s = quick(wRate * f); if (s < best) { best = s; bestRate = wRate * f; } }
    wRate = bestRate;
  }
  let e = m.e, varpi0 = (m.node + m.w), lib = null, lib2 = null, rms = 0, ndot = 0, resTerms = [];
  for (let iter = 0; iter < 4; iter++) {
    const best = { rms: Infinity };
    const periods = [null, ...Array.from({ length: 141 }, (_, k) => (10 + k) * YR)];
    for (const Pl of periods) {
      const rows = data.map((d) => {
        const lm = lam0 + n * d.t, arg = (lm - wRate * d.t) * DEG;
        const r = [1, d.t, (d.t * d.t) / C2, 2 * Math.sin(arg), -2 * Math.cos(arg), 1.25 * Math.sin(2 * arg), -1.25 * Math.cos(2 * arg)];
        for (const q of res) { const a = resonanceArg(q, lm, d.t); r.push(Math.sin(a), Math.cos(a)); }
        // Libration: fundamental + 2nd/3rd harmonics (resonant librations are not pure sinusoids).
        if (Pl) for (let hmn = 1; hmn <= 3; hmn++) r.push(Math.sin((2 * Math.PI * hmn * d.t) / Pl), Math.cos((2 * Math.PI * hmn * d.t) / Pl));
        return r;
      });
      const b = data.map((d) => d.lam * DEG);
      const x = lsq(rows, b);
      let ss = 0; rows.forEach((r, k) => { let v = 0; for (let i = 0; i < r.length; i++) v += r[i] * x[i]; ss += (v - b[k]) ** 2; });
      const rr = Math.sqrt(ss / data.length) / DEG;
      if (rr < best.rms * (Pl ? 0.8 : 1)) Object.assign(best, { rms: rr, x, Pl });
    }
    // Refine the libration period around the best grid value (0.02-yr steps).
    if (best.Pl) {
      for (let Pl = best.Pl - YR; Pl <= best.Pl + YR; Pl += 0.02 * YR) {
        const rows = data.map((d) => {
          const lm = lam0 + n * d.t, arg = (lm - wRate * d.t) * DEG;
          const r = [1, d.t, (d.t * d.t) / C2, 2 * Math.sin(arg), -2 * Math.cos(arg), 1.25 * Math.sin(2 * arg), -1.25 * Math.cos(2 * arg)];
          for (const q of res) { const a = resonanceArg(q, lm, d.t); r.push(Math.sin(a), Math.cos(a)); }
          for (let hmn = 1; hmn <= 3; hmn++) r.push(Math.sin((2 * Math.PI * hmn * d.t) / Pl), Math.cos((2 * Math.PI * hmn * d.t) / Pl));
          return r;
        });
        const b = data.map((d) => d.lam * DEG);
        const x = lsq(rows, b);
        let ss = 0; rows.forEach((r, k) => { let v = 0; for (let i = 0; i < r.length; i++) v += r[i] * x[i]; ss += (v - b[k]) ** 2; });
        const rr = Math.sqrt(ss / data.length) / DEG;
        if (rr < best.rms) Object.assign(best, { rms: rr, x, Pl });
      }
    }
    // Optional second periodic term (log-spaced period scan 0.3–150 yr). Disabled: on Mimas it lowered the
    // fit residual but raised the error at independent Horizons epochs (over-fitting). Set to true to try.
    const SECOND_TERM = false;
    best.P2 = null;
    if (SECOND_TERM && best.rms > 0.3) {
      const baseCols = (d, Pl) => {
        const lm = lam0 + n * d.t, arg = (lm - wRate * d.t) * DEG;
        const r = [1, d.t, (d.t * d.t) / C2, 2 * Math.sin(arg), -2 * Math.cos(arg), 1.25 * Math.sin(2 * arg), -1.25 * Math.cos(2 * arg)];
        for (const q of res) { const a = resonanceArg(q, lm, d.t); r.push(Math.sin(a), Math.cos(a)); }
        if (Pl) for (let hmn = 1; hmn <= 3; hmn++) r.push(Math.sin((2 * Math.PI * hmn * d.t) / Pl), Math.cos((2 * Math.PI * hmn * d.t) / Pl));
        return r;
      };
      const b = data.map((d) => d.lam * DEG);
      for (let k = 0; k < 400; k++) {
        const P2 = 0.3 * YR * Math.pow(500, k / 399);
        const rows = data.map((d) => [...baseCols(d, best.Pl), Math.sin((2 * Math.PI * d.t) / P2), Math.cos((2 * Math.PI * d.t) / P2)]);
        const x = lsq(rows, b);
        let ss = 0; rows.forEach((r, j) => { let v = 0; for (let i = 0; i < r.length; i++) v += r[i] * x[i]; ss += (v - b[j]) ** 2; });
        const rr = Math.sqrt(ss / data.length) / DEG;
        if (rr < best.rms * 0.8) Object.assign(best, { rms: rr, x, P2 });
      }
    }
    lam0 = best.x[0] / DEG; n = best.x[1] / DEG; ndot = (2 * best.x[2]) / C2 / DEG;   // λ = … + ½ ṅ t²
    // e·cosϖ0 = x3, e·sinϖ0 = x4
    e = Math.hypot(best.x[3], best.x[4]); varpi0 = Math.atan2(best.x[4], best.x[3]) / DEG;
    resTerms = res.map((q, k) => ({ ...q, s: best.x[7 + 2 * k] / DEG, c: best.x[8 + 2 * k] / DEG }));
    const li = 7 + 2 * res.length;
    lib = best.Pl ? { P: best.Pl, h: [0, 1, 2].map((k) => [best.x[li + 2 * k] / DEG, best.x[li + 2 * k + 1] / DEG]) } : null;
    const i2 = li + (best.Pl ? 6 : 0);
    lib2 = best.P2 ? { P: best.P2, s: best.x[i2] / DEG, c: best.x[i2 + 1] / DEG } : null;
    rms = best.rms;
  }
  const aFit = data.reduce((s, d) => s + d.r, 0) / data.length / (1 + e * e / 2);
  const out = { key: m.key, a: +aFit.toFixed(1), e: +e.toFixed(5), i: +inc.toFixed(4), node0: +((node0 % 360 + 360) % 360).toFixed(4), nodeRate,
    varpi0: +((varpi0 % 360 + 360) % 360).toFixed(4), varpiRate: wRate, lam0: +((lam0 % 360 + 360) % 360).toFixed(6), n: +n.toFixed(10),
    ndot: +ndot.toExponential(6), res: resTerms.map((q) => ({ with: q.with, k: q.k, s: +q.s.toFixed(5), c: +q.c.toFixed(5) })),
    lib: lib && { P: +lib.P.toFixed(3), h: lib.h.map(([s, c]) => [+s.toFixed(5), +c.toFixed(5)]) },
    lib2: lib2 && { P: +lib2.P.toFixed(3), s: +lib2.s.toFixed(5), c: +lib2.c.toFixed(5) }, pole: pole.map((v) => +v.toFixed(4)), rms: +rms.toFixed(3),
    planeRms: +planeResidual.toFixed(3), samples: data.length };
  FITTED[m.key] = out;
  return out;
}

// Laplace-resonance terms for the inner Galilean moons: sin/cos of k·(λ_self − λ_other), using the
// other moon's first-pass mean longitude. (Io–Europa–Ganymede are locked in a 1:2:4 resonance.)
const RESONANCE = {};
const FITTED = {};
function resonanceArg(q, lamSelf, t) {
  const o = FITTED[q.with];
  const lamOther = o.lam0 + o.n * t + 0.5 * o.ndot * t * t;
  return q.k * (lamSelf - lamOther) * DEG;
}

let results = [];
const report = (r) => console.log(`n=${r.n.toFixed(6)}°/d (P=${(360 / r.n).toFixed(6)} d) e=${r.e} i=${r.i}° rms=${r.rms}° plane=${r.planeRms}°${r.lib ? ` lib ${(r.lib.P / YR).toFixed(2)} yr amp ${Math.hypot(...r.lib.h[0]).toFixed(2)}°` : ''}${r.lib2 ? ` + ${(r.lib2.P / YR).toFixed(3)} yr amp ${Math.hypot(r.lib2.s, r.lib2.c).toFixed(2)}°` : ''}${r.res.length ? ` +${r.res.length} resonance terms` : ''}`);
for (const m of MOON_DATA) {
  process.stdout.write(`${m.name.padEnd(10)} `);
  const r = await fitMoon(m);
  results.push(r);
  report(r);
}
// Second pass for the Laplace-resonance trio, now that every moon has a first-pass mean longitude.
RESONANCE.io = [{ with: 'europa', k: 2 }, { with: 'europa', k: 1 }];
RESONANCE.europa = [{ with: 'ganymede', k: 2 }, { with: 'io', k: 1 }, { with: 'ganymede', k: 1 }];
RESONANCE.ganymede = [{ with: 'callisto', k: 1 }, { with: 'europa', k: 1 }, { with: 'callisto', k: 2 }];
// Iterate so each moon's resonance arguments use the other moons' FINAL mean longitudes.
const cache = {};
for (let round = 1; round <= 3; round++) {
  for (const key of ['io', 'europa', 'ganymede']) {
    const m = MOON_DATA.find((x) => x.key === key);
    process.stdout.write(`${m.name.padEnd(10)} (resonance round ${round}) `);
    const r = await fitMoon(m, cache);
    results = results.map((x) => (x.key === key ? r : x));
    report(r);
  }
}
const body = results.map((r) => `  ${r.key}: ${JSON.stringify({ ...r, key: undefined, samples: undefined })},`).join('\n');
writeFileSync(new URL('../js/data/moonElements.js', import.meta.url),
`// Mean orbital elements for the major moons, least-squares fitted to JPL Horizons planetocentric
// vectors over 1850–2050 by tools/fit-moons.mjs (generated ${new Date().toISOString().slice(0, 10)}).
// Frame: pole (α, δ ICRF) = Laplace plane or planet equator (right-hand rule); angles in degrees,
// rates in deg/day, t = days since J2000 TDB. rms = fit residual in longitude (deg).
export const MOON_ELEMENTS = {
${body}
};
`);
console.log('wrote js/data/moonElements.js');
