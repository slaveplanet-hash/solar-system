// Dev-only: fetch reference vectors from JPL Horizons into tests/fixtures/*.json
import { writeFileSync } from 'node:fs';
const API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function vectors(cmd, center, extra) {
  const p = new URLSearchParams({ format: 'json', COMMAND: `'${cmd}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'",
    EPHEM_TYPE: "'VECTORS'", CENTER: `'${center}'`, REF_PLANE: "'ECLIPTIC'", REF_SYSTEM: "'J2000'",
    VEC_TABLE: "'1'", OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'", VEC_LABELS: "'NO'", ...extra });
  const r = await fetch(`${API}?${p}`); const j = await r.json();
  const body = j.result.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n');
  await sleep(400);
  return body.map(l => { const c = l.split(',').map(s => s.trim()); return { jd: +c[0], x: +c[2], y: +c[3], z: +c[4] }; });
}
const epochs = [2396758.5, 2433447.5, 2451545.0, 2461308.5, 2469000.5, 2378860.5]; // 1850,1950,2000,2026-09-25,~2047,1800
const out = { planets: {}, moon: [], table: {} };
for (const id of ['199','299','399','499','599','699','799','899','999']) {
  out.planets[id] = await vectors(id, '500@10', { TLIST: `'${epochs.join("','")}'` });
  console.log('planet', id);
}
// Moon geocentric: eclipse instants (UTC -> TDB via deltaT ~69.2s) + others
const moonJD = [2460409.262500 + 69.18/86400, 2460748.790278 + 69.2/86400, 2451545.0, 2461308.5, 2440000.5, 2466000.5];
out.moon = await vectors('301', '500@399', { TLIST: `'${moonJD.join("','")}'` });
console.log('moon');
for (const id of ['499','599']) {
  out.table[id] = await vectors(id, '500@10', { START_TIME: "'2024-01-01'", STOP_TIME: "'2031-01-01'", STEP_SIZE: "'5d'" });
  console.log('table', id, out.table[id].length);
}
writeFileSync('fixtures/horizons.json', JSON.stringify(out));
