// Node test: Earth satellites — SGP4 (vendored satellite.js) + UTC time + TEME → ecliptic J2000,
// against a frozen JPL Horizons ISS track (tests/fixtures/iss_sgp4.json), plus the near-Earth
// scene mapping and the data-table rules.
import { readFileSync } from 'node:fs';
import { satRecords, satPosition, temeToEclipticMatrix, satValidity, nearEarthToScene, buildSatTable, SAT_COLUMNS, R_EARTH } from '../js/satcore.js';
import { tdbToUTC } from '../js/time.js';
import { ScaleSystem } from '../js/scale.js';

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };

const fx = JSON.parse(readFileSync(new URL('./fixtures/iss_sgp4.json', import.meta.url), 'utf8'));
const [iss] = satRecords({ columns: SAT_COLUMNS, rows: [SAT_COLUMNS.map((c) => (c === 'group' ? 'stations' : fx.omm[c]))] });

// 1. Full chain vs Horizons (JPL applies its own TEME → ICRF reduction with Earth-orientation data).
{
  let worst = 0, sum = 0;
  const p = [0, 0, 0];
  for (const [jdT, x, y, z] of fx.horizons.rows) {
    const jdU = tdbToUTC(jdT);
    satPosition(iss, jdU, temeToEclipticMatrix(jdT, jdU), p);
    const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
    worst = Math.max(worst, d); sum += d;
  }
  const n = fx.horizons.rows.length;
  check('ISS: SGP4 + TEME→ecliptic vs JPL Horizons', worst < 1, `mean ${(sum / n).toFixed(3)} km, worst ${worst.toFixed(3)} km over ${n} states (±1.3 d from the element epoch)`);
}

// 2. The clock is TDB: feeding it to SGP4 unconverted must be caught (≈ 69 s ≈ 500 km along-track).
{
  const [jdT, x, y, z] = fx.horizons.rows[60], p = [0, 0, 0];
  satPosition(iss, jdT, temeToEclipticMatrix(jdT, tdbToUTC(jdT)), p);
  const d = Math.hypot(p[0] - x, p[1] - y, p[2] - z);
  check('TDB passed as UTC is detectably wrong', d > 300, `${d.toFixed(0)} km off — the layer must convert TDB → UTC`);
}

// 3. TEME → ecliptic is a rotation (orthonormal, det +1).
{
  const T = temeToEclipticMatrix(2461313.0, 2461313.0 - 69.2 / 86400);
  let err = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const dot = T[i * 3] * T[j * 3] + T[i * 3 + 1] * T[j * 3 + 1] + T[i * 3 + 2] * T[j * 3 + 2];
    err = Math.max(err, Math.abs(dot - (i === j ? 1 : 0)));
  }
  const det = T[0] * (T[4] * T[8] - T[5] * T[7]) - T[1] * (T[3] * T[8] - T[5] * T[6]) + T[2] * (T[3] * T[7] - T[4] * T[6]);
  check('TEME→ecliptic matrix is a proper rotation', err < 1e-12 && Math.abs(det - 1) < 1e-12, `max |TTᵀ − I| ${err.toExponential(1)}, det ${det.toFixed(12)}`);
}

// 4. Scene mapping near Earth: exact in TRUE scale (the moon mapping clamps at 1.15 radii, which would lift
//    the ISS ~550 km), outside the enlarged globe in VISUAL scale.
{
  const sc = new ScaleSystem(), rel = [6790, 0, 0];
  sc.snap('true');
  const t = nearEarthToScene(rel, sc);
  check('True scale: ISS altitude preserved', Math.abs(Math.hypot(...t) - 6790) < 1e-9, `|scene| = ${Math.hypot(...t).toFixed(3)} km for |rel| = 6790 km`);
  sc.snap('visual');
  const v = nearEarthToScene(rel, sc);
  check('Visual scale: satellite outside the enlarged Earth', Math.hypot(...v) > R_EARTH * sc.radiusFactor('planet'), `|scene| = ${(Math.hypot(...v) / (R_EARTH * sc.radiusFactor('planet'))).toFixed(3)} × the drawn radius`);
}

// 5. De-duplication keeps the higher-priority group; validity windows.
{
  const o = { ...fx.omm };
  const rows = buildSatTable({ visual: [o], stations: [o] });
  check('Duplicate object keeps the priority group', rows.length === 1 && rows[0][SAT_COLUMNS.indexOf('group')] === 'stations', `group = ${rows[0][SAT_COLUMNS.indexOf('group')]}`);
  const v = [0, 2, 10, -40].map((d) => satValidity(iss, iss.epoch + d));
  check('Validity window (fresh ≤ 3 d, approximate ≤ 30 d, hidden beyond)', v.join() === 'fresh,fresh,approx,expired', v.join(', '));
}

// 6. The live data file, if present, parses and propagates.
try {
  const d = JSON.parse(readFileSync(new URL('../data/satellites.json', import.meta.url), 'utf8'));
  const recs = satRecords(d), p = [0, 0, 0];
  let bad = 0;
  for (const s of recs) {
    const T = temeToEclipticMatrix(s.epoch + 69.2 / 86400, s.epoch);
    const r = satPosition(s, s.epoch, T, p);
    if (!r || !(Math.hypot(...r) > R_EARTH)) bad++;
  }
  check('data/satellites.json: every object propagates at its epoch', bad === 0 && recs.length > 0, `${recs.length} / ${d.rows.length} records, ${bad} failed`);
} catch (e) {
  console.log(`SKIP  data/satellites.json  ${e.code === 'ENOENT' ? 'not downloaded (node fetch-data.mjs --satellites)' : e.message}`);
}

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
