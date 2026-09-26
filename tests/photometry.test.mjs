// Apparent magnitudes (sensor.js, Mallama & Hilton 2018) vs JPL Horizons observer tables (APmag, quantity 9),
// geocentric, 2026-09-25 00:00 UTC. Fetched 2026-09-25 from https://ssd.jpl.nasa.gov/api/horizons.api.
import { computeSystemState, bodyToEclipticMatrix } from '../js/ephemeris.js';
import { utcToTDB, utcStringToJD } from '../js/time.js';
import { apparentMagnitude } from '../js/sensor.js';

const HORIZONS = { mercury: -0.202, venus: -4.804, mars: 1.069, jupiter: -1.854, saturn: 0.375, uranus: 5.662, neptune: 7.679, moon: -12.152 };
const jdU = utcStringToJD('2026-09-25 00:00'), jd = utcToTDB(jdU);
const s = computeSystemState(jd);
let fails = 0, worst = 0;
for (const [k, ref] of Object.entries(HORIZONS)) {
  const b = { key: k, helio: s[k], eclMatrix: k === 'moon' ? null : bodyToEclipticMatrix(k, jd, jdU) };
  const V = apparentMagnitude(b, s.earth).V, d = V - ref;
  worst = Math.max(worst, Math.abs(d));
  const ok = Math.abs(d) < 0.1;
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${k.padEnd(8)} V ${V.toFixed(2).padStart(7)}  Horizons ${ref.toFixed(3).padStart(7)}  Δ ${d >= 0 ? '+' : ''}${d.toFixed(3)}`);
}
console.log(`      worst |Δ| ${worst.toFixed(3)} mag (limit 0.1; Mars' seasonal and Uranus' sub-latitude terms are omitted)`);
if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
