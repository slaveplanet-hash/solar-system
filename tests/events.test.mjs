// Events engine vs NASA's eclipse decade tables 2021–2030 (tests/fixtures/eclipses_2021_2030.json).
// Every eclipse must be found, within 10 minutes of NASA's greatest-eclipse time, with the right type
// (NASA "hybrid" accepts total or annular), and no extra eclipses may appear.
import { readFileSync } from 'node:fs';
import { solarEclipses, lunarEclipses, conjunctions } from '../js/events.js';
import { utcStringToJD } from '../js/time.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/eclipses_2021_2030.json', import.meta.url), 'utf8'));
const jd0 = utcStringToJD('2021-01-01 00:00'), jd1 = utcStringToJD('2031-01-01 00:00');   // TD ≈ these ± 69 s (irrelevant)
let fails = 0;
const t0 = performance.now();
const found = { solar: solarEclipses(jd0, jd1), lunar: lunarEclipses(jd0, jd1) };
const ms = performance.now() - t0;

for (const kind of ['solar', 'lunar']) {
  const got = found[kind];
  let worst = 0;
  const used = new Set();
  for (const [td, type] of fx[kind]) {
    const jd = utcStringToJD(td);                  // the fixture is in TD: compare TD with TD
    const m = got.map((g, i) => ({ g, i, dt: Math.abs(g.jd - jd) * 1440 })).sort((a, b) => a.dt - b.dt)[0];
    const typeOk = m && (m.g.type === type || (type === 'hybrid' && (m.g.type === 'total' || m.g.type === 'annular')));
    if (!m || m.dt > 10 || !typeOk) {
      fails++;
      console.log(`FAIL  ${kind} ${td} ${type}: ${m ? `nearest ${m.g.type} ${m.dt.toFixed(1)} min away` : 'not found'}`);
    } else { worst = Math.max(worst, m.dt); used.add(m.i); }
  }
  const extra = got.filter((_, i) => !used.has(i));
  for (const e of extra) { fails++; console.log(`FAIL  extra ${kind} eclipse at JD ${e.jd.toFixed(3)} (${e.type})`); }
  console.log(`${extra.length || worst > 10 ? 'FAIL' : 'PASS'}  ${kind} eclipses 2021–2030: ${fx[kind].length} in NASA's table, ${got.length} found; worst timing error ${worst.toFixed(1)} min`);
}
console.log(`      (eclipse search over 10 years: ${ms.toFixed(0)} ms)`);

// Known conjunction: the 2020-12-21 Jupiter–Saturn "great conjunction", 0.1° apart.
const cj = conjunctions(utcStringToJD('2020-12-01 00:00'), utcStringToJD('2021-01-10 00:00'));
const js = cj.find((c) => (c.a === 'jupiter' && c.b === 'saturn'));
const cjOk = js && Math.abs(js.jd - utcStringToJD('2020-12-21 18:00')) < 1 && js.sepDeg < 0.15;
if (!cjOk) fails++;
console.log(`${cjOk ? 'PASS' : 'FAIL'}  Jupiter–Saturn great conjunction 2020-12-21 (0.10°): ${js ? `JD ${js.jd.toFixed(2)}, ${(js.sepDeg * 60).toFixed(1)}′` : 'not found'}`);

if (fails) { console.log(`\n${fails} FAILED`); process.exit(1); }
