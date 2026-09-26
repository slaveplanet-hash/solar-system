// =============================================================================
// report.js — Turn Verify results (and optional Node test-suite output) into a
// Markdown pass/fail report grouped by where each check comes from in the spec.
// Pure JS: used by the browser Verify panel ("Copy report") and tools/report.mjs.
// =============================================================================

const SECTION7 = [/Total solar eclipse 2024/, /Total lunar eclipse 2025/, /Earth perihelion/, /Earth aphelion/,
  /Jupiter heliocentric longitude/, /Mars heliocentric longitude/, /Io orbital period/, /Synodic month/];
const SECTION8 = [/Halley's Comet perihelion/, /Hale-Bopp perihelion/, /Oumuamua perihelion/, /Apophis closest approach/, /Perseids/];
// Rows whose inputs depend on today's date or on the age of the downloaded data.
const DATED = [/Earth perihelion/, /Earth aphelion/, /heliocentric longitude vs JPL Horizons/, /Io orbital period/, /Synodic month/,
  /Small-body data present and fresh/, /Perseids|Orionids|Eta Aquariids|Leonids|Geminids/, /Rotation sense/];

const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

export function groupResults(results) {
  const g = { s7: [], s8: [], phase: [] };
  for (const r of results) {
    if (SECTION7.some((re) => re.test(r.name))) g.s7.push(r);
    else if (SECTION8.some((re) => re.test(r.name))) g.s8.push(r);
    else g.phase.push(r);
  }
  return g;
}

/**
 * results: [{ name, status, detail }] from runVerify(); tests: [{ suite, lines:[{status, text}], ok }] (Node only).
 * env: free-form lines (where/when it ran).
 */
export function buildReport(results, { tests = [], env = [], title = 'Sol Simulator — self-check report' } = {}) {
  const n = (arr, s) => arr.filter((r) => r.status === s).length;
  const g = groupResults(results);
  const out = [`# ${title}`, ''];
  for (const e of env) out.push(`- ${e}`);
  const tPass = tests.reduce((a, t) => a + t.lines.filter((l) => l.status === 'PASS').length, 0);
  const tFail = tests.reduce((a, t) => a + t.lines.filter((l) => l.status === 'FAIL').length, 0) + tests.filter((t) => !t.ok && !t.lines.some((l) => l.status === 'FAIL')).length;
  out.push(`- **Verify:** ${n(results, 'PASS')} pass · ${n(results, 'FAIL')} fail · ${n(results, 'SKIP')} skipped · ${n(results, 'PENDING')} pending`);
  if (tests.length) out.push(`- **Test suites:** ${tests.length} (${tests.filter((t) => t.ok).length} passed) — ${tPass} PASS lines, ${tFail} FAIL`);
  out.push('- ⏱ = depends on today\'s date or the data download date, so its numbers change from day to day.', '');
  const table = (rows) => {
    out.push('| Status | Check | Result |', '|---|---|---|');
    for (const r of rows) out.push(`| ${r.status === 'PASS' ? '✅ PASS' : r.status === 'FAIL' ? '❌ FAIL' : '➖ ' + r.status} | ${esc(r.name)}${DATED.some((re) => re.test(r.name)) ? ' ⏱' : ''} | ${esc(r.detail)} |`);
    out.push('');
  };
  out.push('## Spec §7 — core accuracy checks'); table(g.s7);
  out.push('## Spec §8 — additional self-checks'); table(g.s8);
  out.push('## Phase-specific checks (data, moons, rendering, small bodies, comets, events)'); table(g.phase);
  if (tests.length) {
    out.push('## Node test suites (`npm test`)');
    for (const t of tests) {
      out.push(`### ${t.suite} — ${t.ok ? 'passed' : 'FAILED'}`);
      for (const l of t.lines) out.push(`- ${l.status === 'PASS' ? '✅' : l.status === 'FAIL' ? '❌' : '➖'} ${esc(l.text)}`);
      out.push('');
    }
  }
  return out.join('\n');
}
