// Minimal static file server for the simulator (ES modules need http://, not file://).
// Usage: node tools/serve.mjs [port] [--data <folder>]
//   --data serves /data/* from another folder (e.g. when Windows "Controlled folder access"
//   stops fetch-data from writing inside Documents). PowerShell:
//     node fetch-data.mjs --out "$env:LOCALAPPDATA\sol-data"
//     node tools/serve.mjs 8130 --data "$env:LOCALAPPDATA\sol-data"
//   (Command Prompt: "%LOCALAPPDATA%\sol-data").
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const di = args.indexOf('--data');
const dataDir = di >= 0 && args[di + 1] ? resolve(args[di + 1]) : null;
const port = +args.find((a, i) => /^\d+$/.test(a) && args[i - 1] !== '--data') || 8130;
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.ktx2': 'image/ktx2', '.svg': 'image/svg+xml', '.md': 'text/plain; charset=utf-8' };

createServer(async (req, res) => {
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
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
}).listen(port, () => console.log(`Sol simulator: http://localhost:${port}/${dataDir ? `  (data from ${dataDir})` : ''}`));
