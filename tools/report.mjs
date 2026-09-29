// =============================================================================
// tools/report.mjs — Run ALL self-checks that work in Node (the Verify checks + every
// test suite) and write VERIFY-REPORT.md next to package.json.
//   npm run report                 (uses ./data)
//   node tools/report.mjs --data <folder>
// The GPU check ("GPU Kepler solver vs float64 CPU") and "Named asteroids & dwarf planets
// modelled" need the browser: use ✓ Verify → "Copy report" there for those rows.
// =============================================================================
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { DataStore } from '../js/datastore.js';
import { runVerify } from '../js/verify.js';
import { buildReport } from '../js/report.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argi = process.argv.indexOf('--data');
const dataDir = argi > 0 ? path.resolve(process.argv[argi + 1]) : path.join(root, 'data');

const data = await new DataStore(dataDir + path.sep, async (p) => JSON.parse(await readFile(p, 'utf8'))).load();
const results = runVerify({ data });

const suites = ['ephemeris.test.mjs', 'kepler-state.test.mjs', 'events.test.mjs', 'photometry.test.mjs', 'data.test.mjs', 'satellites.test.mjs', 'mcp.test.mjs'];
const tests = suites.map((s) => {
  const r = spawnSync(process.execPath, [path.join(root, 'tests', s)], { cwd: root, encoding: 'utf8', env: { ...process.env, SOL_DATA: dataDir } });
  const lines = (r.stdout || '').split('\n').map((l) => l.trimEnd()).filter((l) => /^(PASS|FAIL|SKIP)\b/.test(l))
    .map((l) => ({ status: l.slice(0, 4), text: l.slice(4).trim().replace(/\s{2,}/g, ' — ') }));
  return { suite: s, ok: r.status === 0, lines };
});

const env = [
  `Generated ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC with Node ${process.version}`,
  `Data: ${dataDir} (${data.available ? `downloaded ${data.manifest.date}, ${data.manifest.mode}` : 'missing'})`,
  'Browser-only rows (GPU solver readback, named-body models) are SKIP here — run ✓ Verify in the app and use "Copy report".',
];
const md = buildReport(results, { tests, env });
const out = path.join(root, 'VERIFY-REPORT.md');
await writeFile(out, md + '\n', 'utf8');
const fails = results.filter((r) => r.status === 'FAIL').length + tests.filter((t) => !t.ok).length;
console.log(`Wrote ${out}\nVerify: ${results.filter((r) => r.status === 'PASS').length} pass, ${results.filter((r) => r.status === 'FAIL').length} fail, ${results.filter((r) => r.status === 'SKIP').length} skipped · test suites: ${tests.filter((t) => t.ok).length}/${tests.length} passed`);
process.exit(fails ? 1 : 0);
