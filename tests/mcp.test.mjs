// Node test: the MCP server over stdio, as a client sees it — handshake, tool list, calculation
// tools (no browser), error handling, and that stdout carries nothing but JSON-RPC lines.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };

const srv = spawn(process.execPath, [fileURLToPath(new URL('../mcp/server.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] });
let buf = '', stray = [];
const waiting = new Map();
srv.stdout.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { stray.push(line); continue; }
    if (m.jsonrpc !== '2.0') stray.push(line);
    waiting.get(m.id)?.(m); waiting.delete(m.id);
  }
});
let nextId = 1;
const call = (method, params) => new Promise((ok) => { const id = nextId++; waiting.set(id, ok); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const tool = async (name, args) => { const r = await call('tools/call', { name, arguments: args }); return { err: r.result?.isError, text: r.result?.content?.[0]?.text || '', r }; };

const init = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
check('initialize', init.result?.protocolVersion === '2025-06-18' && init.result?.capabilities?.tools && init.result?.serverInfo?.name === 'sol-simulator',
  `protocol ${init.result?.protocolVersion}, server ${init.result?.serverInfo?.name}, instructions ${init.result?.instructions?.length} chars`);
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const list = await call('tools/list', {});
const names = list.result?.tools?.map((t) => t.name) || [];
check('tools/list', names.length >= 20 && names.includes('satellite_passes') && names.includes('sim_eval') && list.result.tools.every((t) => t.inputSchema?.type === 'object' && t.description),
  `${names.length} tools`);

const ecl = await tool('find_eclipses', { from: '2026-01-01', to: '2026-12-31', kind: 'solar' });
const e = JSON.parse(ecl.text || '{}');
check('find_eclipses: 2026-08-12 total solar eclipse', !ecl.err && e.eclipses?.some((x) => x.type === 'total' && x.greatest_eclipse_utc.startsWith('2026-08-12T17:4')),
  e.eclipses?.map((x) => `${x.type} ${x.greatest_eclipse_utc}`).join(', '));

const iss = await tool('satellite_state', { satellite: 'ISS' });
const s = JSON.parse(iss.text.startsWith('{') ? iss.text : '{}');
check('satellite_state ISS', (!iss.err && s.altitude_km > 350 && s.altitude_km < 470) || /No satellite data|days from its element epoch/.test(iss.text),
  iss.err ? iss.text.slice(0, 120) : `${s.name} at ${s.altitude_km} km over ${s.subpoint?.lat}, ${s.subpoint?.lon}`);

const bad = await tool('body_position', { body: 'Vulcan' });
check('tool error → isError result (not a protocol error)', bad.err === true && /Unknown body/.test(bad.text), bad.text.slice(0, 60));

const unknown = await call('no/such/method', {});
check('unknown method → JSON-RPC −32601', unknown.error?.code === -32601, unknown.error?.message);

const ping = await call('ping', {});
check('ping', ping.result && !ping.error, JSON.stringify(ping.result));

check('stdout carries only JSON-RPC', stray.length === 0, stray.length ? `stray: ${stray[0].slice(0, 80)}` : 'clean');
srv.stdin.end();
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
