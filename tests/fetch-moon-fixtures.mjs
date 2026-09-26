// Dev-only: planetocentric ecliptic-J2000 vectors for the major moons from JPL Horizons,
// written to tests/fixtures/moons.json. Run: node tests/fetch-moon-fixtures.mjs
import { writeFileSync } from 'node:fs';
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MOONS = { 401: 499, 402: 499, 501: 599, 502: 599, 503: 599, 504: 599, 601: 699, 602: 699, 603: 699, 604: 699, 605: 699, 606: 699, 608: 699,
  701: 799, 702: 799, 703: 799, 704: 799, 705: 799, 801: 899, 901: 999 };
const EPOCHS = [2448044.5, 2451545.0, 2461308.5, 2466154.5];   // 1990-06-01, J2000, 2026-09-25, 2040-01-01
const out = {};
for (const [id, center] of Object.entries(MOONS)) {
  const p = new URLSearchParams({ format: 'json', COMMAND: `'${id}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'VECTORS'",
    CENTER: `'500@${center}'`, REF_PLANE: "'ECLIPTIC'", REF_SYSTEM: "'J2000'", VEC_TABLE: "'1'", OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'",
    VEC_LABELS: "'NO'", TLIST: `'${EPOCHS.join("','")}'` });
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const j = await (await fetch(`${API}?${p}`)).json();
      out[id] = j.result.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n').map((l) => {
        const c = l.split(',').map((s) => s.trim()); return { jd: +c[0], x: +c[2], y: +c[3], z: +c[4] }; });
      break;
    } catch (e) { console.warn(id, 'retry', e.message); await sleep(1500 * (attempt + 1)); }
  }
  console.log(id, out[id]?.length);
  await sleep(350);
}
writeFileSync(new URL('./fixtures/moons.json', import.meta.url), JSON.stringify(out));
