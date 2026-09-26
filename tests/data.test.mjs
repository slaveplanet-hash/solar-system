// Node tests for the data pipeline: Hermite interpolation on a synthetic Kepler orbit,
// and (when ./data exists) the data-dependent Verify checks.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hermite } from '../js/tracks.js';
import { ellipticPosition, DEG, GM_SUN_AU_D } from '../js/kepler.js';
import { AU_KM } from '../js/ephemeris.js';
import { DataStore } from '../js/datastore.js';
import { runDataChecks } from '../js/verify.js';

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };

// Hermite on an Earth-like orbit sampled daily vs the exact two-body position.
{
  const a = 1, e = 0.0167, n = Math.sqrt(GM_SUN_AU_D / a ** 3);
  const state = (t) => {
    const p = ellipticPosition(a, e, 0, 0, 0, n * t, [0, 0, 0]);
    const q = ellipticPosition(a, e, 0, 0, 0, n * (t + 1e-4), [0, 0, 0]);
    const r = ellipticPosition(a, e, 0, 0, 0, n * (t - 1e-4), [0, 0, 0]);
    return [t, ...p.map((v) => v * AU_KM), ...q.map((v, k) => ((v - r[k]) * AU_KM) / (2e-4 * 86400))];
  };
  let worst = 0;
  const out = { pos: [0, 0, 0], vel: [0, 0, 0] };
  for (let t = 0; t < 365; t += 1) {
    const r0 = state(t), r1 = state(t + 1);
    for (const f of [0.25, 0.5, 0.75]) {
      hermite(r0, r1, f, 86400, out);
      const ex = state(t + f);
      worst = Math.max(worst, Math.hypot(out.pos[0] - ex[1], out.pos[1] - ex[2], out.pos[2] - ex[3]));
    }
  }
  check('Hermite interpolation, daily samples, Earth-like orbit', worst < 1, `worst ${worst.toFixed(3)} km`);
}

// Data-dependent checks (SKIP if ./data is missing).
const data = await new DataStore(fileURLToPath(new URL('../data/', import.meta.url)),
  async (p) => JSON.parse(await readFile(p, 'utf8'))).load();
if (!data.available) console.log('SKIP  data checks — run node fetch-data.mjs first');
for (const r of runDataChecks({ data })) {
  if (r.status === 'SKIP' || r.status === 'PENDING') { console.log(`${r.status.padEnd(4)}  ${r.name}  ${r.detail}`); continue; }
  check(r.name, r.status === 'PASS', r.detail);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
