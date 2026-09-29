// Minimal static file server for the simulator (ES modules need http://, not file://).
// Usage: node tools/serve.mjs [port] [--data <folder>]
//   --data serves /data/* from another folder (e.g. when Windows "Controlled folder access"
//   stops fetch-data from writing inside Documents). PowerShell:
//     node fetch-data.mjs --out "$env:LOCALAPPDATA\sol-data"
//     node tools/serve.mjs 8130 --data "$env:LOCALAPPDATA\sol-data"
//   (Command Prompt: "%LOCALAPPDATA%\sol-data").
// Errors reported by js/errorlog.js (POST /__log) and 404s are appended to logs/errors.log
// (override with --log <file>). Follow it live: Get-Content logs\errors.log -Wait
// Bridge for the MCP server (mcp/server.mjs), so an AI assistant can drive the open simulator tab:
//   GET  /__bridge/events   the page listens here (Server-Sent Events) for commands  — same-origin only
//   POST /__bridge/result   the page posts each command's result                     — same-origin only
//   POST /__bridge/cmd      the MCP server sends a command and waits for the result  — needs the token
//   GET  /__bridge/status   connected tabs                                           — needs the token
// The token is random per run and written to logs/bridge.json (git-ignored). The server only listens
// on 127.0.0.1, so nothing else on the network can reach it.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, stat, appendFile, mkdir } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const di = args.indexOf('--data');
const dataDir = di >= 0 && args[di + 1] ? resolve(args[di + 1]) : null;
const li = args.indexOf('--log');
const logFile = li >= 0 && args[li + 1] ? resolve(args[li + 1]) : join(root, 'logs', 'errors.log');
const port = +args.find((a, i) => /^\d+$/.test(a) && !['--data', '--log'].includes(args[i - 1])) || 8130;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

async function log(source, level, msg) {
  const line = `${new Date().toISOString()} [${source}:${level}] ${String(msg).replace(/\n/g, '\n    ')}`;
  (level === 'info' ? console.log : console.error)(line);
  try { await mkdir(dirname(logFile), { recursive: true }); await appendFile(logFile, line + '\n'); }
  catch (e) { console.error(`(could not write ${logFile}: ${e.message})`); }
}

// --- MCP bridge ------------------------------------------------------------------------
const token = randomBytes(24).toString('hex');
const bridgeFile = join(root, 'logs', 'bridge.json');
const tabs = [];                         // connected simulator tabs (SSE responses); commands go to the newest
const pending = new Map();               // command id → { resolve, timer }
let seq = 0;

/** Request from our own page (not another website, not a DNS-rebinding host name). */
function sameOrigin(req) {
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin') return false;
  const origin = req.headers.origin;
  if (origin) { try { if (new URL(origin).host !== host) return false; } catch { return false; } }
  return true;
}
function readBody(req, max = 32e6) {
  return new Promise((ok, fail) => {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > max) { fail(new Error('body too large')); req.destroy(); } });
    req.on('end', () => ok(body));
    req.on('error', fail);
  });
}
const json = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));

async function bridge(req, res, path) {
  if (path === '/__bridge/events' && req.method === 'GET') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 3000\n\n');
    const tab = { res, since: Date.now(), ping: setInterval(() => res.write(': ping\n\n'), 20000) };
    tabs.push(tab);
    req.on('close', () => { clearInterval(tab.ping); const i = tabs.indexOf(tab); if (i >= 0) tabs.splice(i, 1); });
    return;
  }
  if (path === '/__bridge/result' && req.method === 'POST') {
    if (!sameOrigin(req)) return json(res, 403, { error: 'forbidden' });
    try {
      const r = JSON.parse(await readBody(req)), p = pending.get(r.id);
      if (p) { clearTimeout(p.timer); pending.delete(r.id); p.resolve(r); }
      res.writeHead(204).end();
    } catch (e) { json(res, 400, { error: e.message }); }
    return;
  }
  // Commands and status: only with the token, so no website can drive the simulator.
  if (req.headers['x-bridge-token'] !== token) return json(res, 403, { error: 'bad or missing bridge token' });
  if (path === '/__bridge/status') return json(res, 200, { ok: true, tabs: tabs.length, port });
  if (path === '/__bridge/cmd' && req.method === 'POST') {
    let cmd;
    try { cmd = JSON.parse(await readBody(req, 1e6)); } catch (e) { return json(res, 400, { ok: false, error: e.message }); }
    const tab = tabs[tabs.length - 1];
    if (!tab) return json(res, 503, { ok: false, error: `No simulator tab is connected. Open http://localhost:${port}/ in a browser (or use sim_open), then try again.` });
    const id = ++seq, timeout = Math.min(Math.max(+cmd.timeoutMs || 30000, 1000), 180000);
    const result = await new Promise((done) => {
      pending.set(id, { resolve: done, timer: setTimeout(() => { pending.delete(id); done({ id, ok: false, error: `The simulator tab did not answer within ${timeout / 1000} s.` }); }, timeout) });
      tab.res.write(`data: ${JSON.stringify({ id, cmd: cmd.cmd, args: cmd.args || {} })}\n\n`);
    });
    return json(res, 200, result);
  }
  json(res, 404, { error: 'unknown bridge endpoint' });
}

createServer(async (req, res) => {
  // Only requests addressed to this machine by name (a DNS-rebinding site arrives with its own Host).
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) { res.writeHead(403).end(); return; }
  const reqPath = req.url.split('?')[0];
  // Never serve the logs (bridge token) or dot-folders (.git, .claude, …).
  if (/^\/logs(\/|$)/i.test(decodeURIComponent(reqPath)) || /(^|\/)\./.test(decodeURIComponent(reqPath))) { res.writeHead(404).end('Not found'); return; }
  if (reqPath.startsWith('/__bridge/')) {
    bridge(req, res, reqPath).catch((e) => { try { json(res, 500, { ok: false, error: e.message }); } catch { /* connection closed */ } });
    return;
  }
  if (req.method === 'POST' && req.url === '/__log') {
    if (!sameOrigin(req)) { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (c) => { if (body.length < 65536) body += c; });
    req.on('end', async () => {
      try { const e = JSON.parse(body); await log('page', e.level, `${e.msg}  <${e.url}>`); }
      catch { await log('page', 'error', body.slice(0, 2000)); }
      res.writeHead(204).end();
    });
    return;
  }
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    let base = root;
    if (dataDir && path.startsWith('/data/')) { base = dataDir; path = path.slice('/data'.length); }
    const file = normalize(join(base, path));
    if (file !== base && !file.startsWith(base + sep)) { res.writeHead(403).end(); return; }
    const st = await stat(file);
    if (st.isDirectory()) { res.writeHead(302, { Location: req.url + '/' }).end(); return; }
    res.writeHead(200, { 'Content-Type': types[extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    if (!req.url.endsWith('favicon.ico')) log('server', '404', req.url);
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, '127.0.0.1', async () => {
  console.log(`Sol simulator: http://localhost:${port}/${dataDir ? `  (data from ${dataDir})` : ''}\n  error log: ${logFile}`);
  try { await mkdir(dirname(bridgeFile), { recursive: true }); await writeFile(bridgeFile, JSON.stringify({ port, token, pid: process.pid, started: new Date().toISOString() })); }
  catch (e) { console.error(`(could not write ${bridgeFile}: ${e.message} — the MCP bridge will not work)`); }
}).on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use (is the simulator server already running?).` : e.message);
  process.exit(1);
});
