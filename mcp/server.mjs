#!/usr/bin/env node
// =============================================================================
// mcp/server.mjs — MCP server for the Sol simulator (stdio, zero dependencies).
//
//   • Calculation tools run right here in Node with the simulator's own code (ephemerides,
//     eclipse search, SGP4 satellites): exact, and no browser needed.
//   • sim_* tools drive the simulator open in a browser tab: time, camera, scale, layers,
//     events, screenshots, self-checks, and a JavaScript escape hatch. They go through the
//     bridge in tools/serve.mjs, which this server starts on http://localhost:8130 if it isn't
//     running (token in logs/bridge.json; the server only listens on 127.0.0.1).
//
// Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. NOTHING else may be written to
// stdout — diagnostics go to stderr.
// Register with AI apps: node mcp/install.mjs (or install-mcp.bat). Details in INSTALL.md.
// =============================================================================
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as H from './headless.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +(process.env.SOL_PORT || 8130);
const BASE = `http://127.0.0.1:${PORT}`;
const VERSION = '1.0.0';
const log = (...a) => process.stderr.write(`[sol-mcp] ${a.join(' ')}\n`);

// --- bridge client ------------------------------------------------------------------------
let child = null, busy = Promise.resolve();
async function token() {
  try { return JSON.parse(await readFile(join(ROOT, 'logs', 'bridge.json'), 'utf8')).token; } catch { return null; }
}
async function status() {
  const t = await token();
  try {
    const r = await fetch(`${BASE}/__bridge/status`, { headers: { 'x-bridge-token': t || '' }, signal: AbortSignal.timeout(1500) });
    if (r.status === 403) return { up: true, ours: false };
    if (r.status === 404) return { up: true, ours: false, old: true };
    return { up: true, ours: true, ...(await r.json()) };
  } catch { return { up: false }; }
}
/** Make sure tools/serve.mjs (with the bridge) is running; start it if nothing listens on the port. */
async function ensureServer() {
  let s = await status();
  if (s.up && s.ours) return s;
  if (s.up && !s.ours) {
    // Something else (or an older serve.mjs without the bridge, or a stale token) holds the port.
    throw new Error(s.old
      ? `A simulator server without the MCP bridge is running on port ${PORT}. Stop it (close its window or Ctrl+C) so the MCP server can start the current one, then retry.`
      : `Port ${PORT} is in use and its bridge token doesn't match logs/bridge.json. Restart "npm run serve" (it rewrites the token) or stop that process, then retry.`);
  }
  log(`starting tools/serve.mjs on port ${PORT}`);
  child = spawn(process.execPath, [join(ROOT, 'tools', 'serve.mjs'), String(PORT)], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  child.stderr.on('data', (d) => process.stderr.write(`[serve] ${d}`));      // never onto our stdout
  child.on('exit', (c) => { log(`serve.mjs exited (${c})`); child = null; });
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150));
    s = await status();
    if (s.up && s.ours) return s;
  }
  throw new Error('Could not start tools/serve.mjs (see the MCP server log).');
}
process.on('exit', () => { try { child?.kill(); } catch { /* already gone */ } });

/** Send a command to the connected simulator tab (one at a time). */
function page(cmd, args = {}, timeoutMs = 30000) {
  const run = async () => {
    await ensureServer();
    const r = await fetch(`${BASE}/__bridge/cmd`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-token': (await token()) || '' },
      body: JSON.stringify({ cmd, args, timeoutMs }), signal: AbortSignal.timeout(timeoutMs + 5000) });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `bridge error (HTTP ${r.status})`);
    return j.result;
  };
  const p = busy.then(run, run);
  busy = p.catch(() => {});
  return p;
}

function openBrowser(url) {
  // Windows: rundll32, not "cmd /c start" — cmd would split the URL at every "&".
  const cmd = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
}

// --- tool definitions ---------------------------------------------------------------------------
const TIME = { type: 'string', description: 'UTC time, ISO 8601 (e.g. "2026-08-12T17:45" or "2026-08-12"), or "now". Range 1800–2050.' };
const LAT = { type: 'number', description: 'Observer latitude, degrees (north positive).' };
const LON = { type: 'number', description: 'Observer longitude, degrees (EAST positive; New York is −74).' };
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TOOLS = [
  // ---- calculations (no browser) ----
  { name: 'body_position', description: 'Where a Sun/planet/moon is at a time: distances from the Sun and Earth, light time, RA/Dec (J2000), elongation, phase; with lat/lon also its altitude/azimuth from that place. Computed with the simulator\'s own ephemerides (no browser needed).',
    inputSchema: obj({ body: { type: 'string', description: 'sun, moon, mercury … pluto, or a major moon (io, europa, titan, triton, charon, …).' }, time: TIME, lat: LAT, lon: LON, elevation_m: { type: 'number' } }, ['body']),
    run: (a) => H.bodyPosition(a) },
  { name: 'sky_at', description: 'What is up in the sky from a place at a time: altitude/azimuth of the Sun, Moon and planets, day/twilight/night, Moon illumination. Use for "is Jupiter visible tonight from X".',
    inputSchema: obj({ lat: LAT, lon: LON, time: TIME, elevation_m: { type: 'number' } }, ['lat', 'lon']),
    run: (a) => H.skyAt(a) },
  { name: 'find_eclipses', description: 'Solar and/or lunar eclipses between two dates (greatest-eclipse time UTC, type, gamma). Verified against NASA\'s catalogue. Max 50 years per call.',
    inputSchema: obj({ from: TIME, to: TIME, kind: { type: 'string', enum: ['solar', 'lunar', 'both'] } }),
    run: (a) => H.findEclipses(a) },
  { name: 'find_conjunctions', description: 'Planet–planet conjunctions (closest geocentric approaches) between two dates, with separation and distance from the Sun. Max 20 years per call.',
    inputSchema: obj({ from: TIME, to: TIME, max_separation_deg: { type: 'number', description: 'Default 1.5.' } }),
    run: (a) => H.findConjunctions(a) },
  { name: 'upcoming_events', description: 'All events in a window: eclipses, conjunctions, meteor-shower peaks, asteroid close approaches (JPL), comet and interstellar-object perihelia.',
    inputSchema: obj({ from: TIME, days: { type: 'number', description: '1–1826 (default 365).' }, types: { type: 'array', items: { type: 'string', enum: ['solar-eclipse', 'lunar-eclipse', 'conjunction', 'meteor-shower', 'close-approach', 'comet-perihelion', 'interstellar-perihelion'] } } }),
    run: (a) => H.upcomingEvents(a, ROOT) },
  { name: 'satellite_find', description: 'Search the Earth-satellite snapshot (~960: space stations, GPS/Galileo/GLONASS/BeiDou, weather, science, geostationary, brightest) by name, NORAD number or COSPAR id, or list a group. Aliases: ISS, Hubble, Tiangong.',
    inputSchema: obj({ query: { type: 'string' }, group: { type: 'string', description: 'stations, gps, galileo, glonass, beidou, weather, science, geo, visual' }, limit: { type: 'number' } }),
    run: (a) => H.satelliteFind(a, ROOT) },
  { name: 'satellite_state', description: 'An Earth satellite at a time (SGP4): ground point lat/lon, altitude, speed, sunlit or in Earth\'s shadow, orbit; with lat/lon also azimuth/elevation/range from that place. Only within ±30 days of the element snapshot.',
    inputSchema: obj({ satellite: { type: 'string', description: 'Name, alias or NORAD number (e.g. "ISS", "Hubble", "25544").' }, time: TIME, lat: LAT, lon: LON, elevation_m: { type: 'number' } }, ['satellite']),
    run: (a) => H.satelliteState(a, ROOT) },
  { name: 'satellite_passes', description: 'Predict passes of a satellite over a place: rise/max/set times (UTC), directions, max elevation, and whether it is visible to the naked eye (sunlit while the sky is dark). Up to 10 days; must be within ±30 days of the element snapshot (best within 3).',
    inputSchema: obj({ satellite: { type: 'string' }, lat: LAT, lon: LON, elevation_m: { type: 'number' }, from: TIME, days: { type: 'number', description: '0.1–10 (default 3).' },
      min_elevation_deg: { type: 'number', description: 'Default 10.' }, visible_only: { type: 'boolean' } }, ['satellite', 'lat', 'lon']),
    run: (a) => H.satellitePasses(a, ROOT) },

  // ---- the simulator in the browser ----
  { name: 'sim_open', description: 'Start the local simulator server if needed and open the simulator in the default browser. Optional URL options (e.g. {"focus":"saturn","t":"2017-06-15T00:00"}). Other sim_* tools need an open simulator tab.',
    inputSchema: obj({ params: { type: 'object', description: 'Query parameters: t, focus, scale ("true"), rate, sat (NORAD), surface, lat, lon, az, alt, instant.', additionalProperties: { type: 'string' } } }),
    run: async (a) => {
      const before = (await ensureServer()).tabs || 0;
      const q = new URLSearchParams(a.params || {}).toString();
      const url = `http://localhost:${PORT}/${q ? '?' + q : ''}`;
      openBrowser(url);
      // Wait for THIS tab (commands go to the newest one); loading the data takes a few seconds.
      for (let i = 0; i < 60; i++) { await new Promise((r) => setTimeout(r, 500)); if ((await status()).tabs > before) return { opened: url, connected: true, tabs: before + 1 }; }
      return { opened: url, connected: false, note: 'Opened, but the tab has not connected yet (still loading?). Try sim_status in a few seconds.' };
    } },
  { name: 'sim_status', description: 'What the open simulator shows now: UTC time, time rate, paused, scale, camera mode, target and distance, surface position, data/satellite status.',
    inputSchema: obj({}), run: () => page('status') },
  { name: 'sim_set_time', description: 'Set the simulated time and/or speed. rate = simulated seconds per real second (1 = real time, 3600 = 1 h/s, negative = backwards).',
    inputSchema: obj({ utc: TIME, rate: { type: 'number' }, paused: { type: 'boolean' }, now: { type: 'boolean', description: 'Jump to the current real time.' } }),
    run: (a) => page('set_time', a) },
  { name: 'sim_focus', description: 'Fly the camera to a body or satellite and orbit it: planet, moon, dwarf planet, named asteroid, comet, spacecraft (voyager1, jwst, …), or an Earth satellite by name/NORAD number.',
    inputSchema: obj({ target: { type: 'string' }, instant: { type: 'boolean', description: 'Default true (a background tab cannot animate a flight).' } }, ['target']),
    run: (a) => page('focus', a) },
  { name: 'sim_camera', description: 'Camera mode (orbit, free, chase, cockpit) and, in orbit mode, the view: distance from the target centre (km or target radii), azimuth and elevation around it.',
    inputSchema: obj({ mode: { type: 'string', enum: ['orbit', 'free', 'chase', 'cockpit'] }, distance_km: { type: 'number' }, radii: { type: 'number' }, azimuth_deg: { type: 'number' }, elevation_deg: { type: 'number' } }),
    run: (a) => page('camera', a) },
  { name: 'sim_surface', description: 'Stand on a body\'s surface at lat/lon and look in a direction (azimuth from north, altitude above the horizon, field of view). Switches to true scale.',
    inputSchema: obj({ body: { type: 'string', description: 'Default earth.' }, lat: { type: 'number' }, lon: { type: 'number' }, azimuth_deg: { type: 'number' }, altitude_deg: { type: 'number' }, fov_deg: { type: 'number' } }),
    run: (a) => page('surface', a) },
  { name: 'sim_leave_surface', description: 'Leave the surface view (back to orbiting the body).', inputSchema: obj({}), run: () => page('leave_surface') },
  { name: 'sim_scale', description: 'true = real sizes and distances; visual = bodies enlarged ×200 and distances compressed so everything is visible.',
    inputSchema: obj({ mode: { type: 'string', enum: ['true', 'visual'] } }, ['mode']), run: (a) => page('scale', a) },
  { name: 'sim_display', description: 'Show/hide layers: orbits, moon_orbits, labels, axes, markers, atmospheres, clouds, rings, spacecraft, named_small_bodies, small_body_orbits, stars, milky_way, sensor_overlay, ui_hidden, quality (Low/Medium/High); satellites {paths, points, labels, path_opacity, groups {stations, gps, …: bool}}; small_body_groups {mba, neo groups, comet, …: bool}.',
    inputSchema: { type: 'object', additionalProperties: true, properties: {} }, run: (a) => page('display', a) },
  { name: 'sim_list_bodies', description: 'Bodies the simulator knows (keys for sim_focus): planets, moons, dwarf planets, named asteroids, comets, spacecraft.',
    inputSchema: obj({ kind: { type: 'string', description: 'planet, moon, dwarf, asteroid, comet, interstellar, spacecraft' }, query: { type: 'string' } }), run: (a) => page('list_bodies', a) },
  { name: 'sim_body_info', description: 'Live details of a body or satellite at the simulator\'s current time (distances, notes; spacecraft/satellites: speed, altitude, data coverage).',
    inputSchema: obj({ body: { type: 'string' } }, ['body']), run: (a) => page('body_info', a) },
  { name: 'sim_show_event', description: 'Stage an event the way the Events panel does (time, place, camera): e.g. stand on the central line of a solar eclipse, watch a lunar eclipse, a conjunction, a meteor shower, an asteroid flyby. Picks the event of that type nearest to near_utc (or the next one).',
    inputSchema: obj({ type: { type: 'string', enum: ['solar-eclipse', 'lunar-eclipse', 'conjunction', 'meteor-shower', 'close-approach', 'comet-perihelion', 'interstellar-perihelion'] }, near_utc: TIME, index: { type: 'number' } }),
    run: (a) => page('show_event', a, 60000) },
  { name: 'sim_screenshot', description: 'Picture of the simulator\'s 3-D view (JPEG). Check what the user would see after changing something.',
    inputSchema: obj({ width: { type: 'number', description: 'Default 1280.' }, quality: { type: 'number' }, hide_ui: { type: 'boolean' } }),
    run: async (a) => { const r = await page('screenshot', a, 60000); return { __image: r }; } },
  { name: 'sim_verify', description: 'Run the simulator\'s accuracy self-checks (eclipses, ephemerides vs JPL, moons, data) and return pass/fail.', inputSchema: obj({}), run: () => page('verify', {}, 120000) },
  { name: 'sim_errors', description: 'Recent errors: the page\'s own error log plus the last lines of logs/errors.log (server 404s, page errors).',
    inputSchema: obj({ lines: { type: 'number' } }),
    run: async (a) => {
      let file = '';
      try {
        // Real problems only: page-load info lines and their wrapped user-agent continuation are skipped.
        const lines = (await readFile(join(ROOT, 'logs', 'errors.log'), 'utf8')).split('\n').filter((l) => /\[(page|server):(error|warn|rejection|resource|404)\]|^ {4}/.test(l));
        file = lines.slice(-(+a.lines || 40)).join('\n') || '(no errors logged)';
      } catch { file = '(no logs/errors.log yet)'; }
      let pageLog = null;
      try { pageLog = (await page('errors')).entries.filter((x) => x.level !== 'info'); } catch (e) { pageLog = `(no tab: ${e.message})`; }
      return { logs_errors_log: file, page: pageLog };
    } },
  { name: 'sim_eval', description: 'Full control: run JavaScript in the simulator page. `app` is the running App (app.clock, app.cam, app.system.byKey.<key>, app.scale, app.satLayer, app.ui, …). An expression returns its value; statements need `return`. The simulation is stepped afterwards. Use the other tools first; this is for anything they don\'t cover.',
    inputSchema: obj({ code: { type: 'string' } }, ['code']), run: (a) => page('eval', a, 60000) },
];

const INSTRUCTIONS = `Sol is a scientifically accurate Solar System simulator (planets 1800–2050 from JPL elements, moons fitted to JPL Horizons, eclipses verified against NASA, ~960 Earth satellites via SGP4).
- For NUMBERS (positions, eclipse times, satellite passes, what's in the sky) use the calculation tools: body_position, sky_at, find_eclipses, find_conjunctions, upcoming_events, satellite_find/state/passes. They need no browser.
- To SHOW something, use the sim_* tools: sim_open first if no tab is connected, then sim_set_time / sim_focus / sim_camera / sim_surface / sim_show_event, and sim_screenshot to check the view.
- All times are UTC ISO 8601. Longitudes are east-positive. Satellite predictions are only valid near the snapshot date (±30 days; best within 3) — say so when relevant.
- sim_eval gives full JavaScript control of the page as a last resort.`;

// --- JSON-RPC over stdio ----------------------------------------------------------------------
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

async function callTool(id, name, args) {
  const t = TOOLS.find((x) => x.name === name);
  if (!t) return fail(id, -32602, `Unknown tool: ${name}`);
  try {
    const r = await t.run(args || {});
    if (r && r.__image) {
      const { data, mimeType, ...meta } = r.__image;
      return reply(id, { content: [{ type: 'image', data, mimeType }, { type: 'text', text: JSON.stringify(meta) }] });
    }
    reply(id, { content: [{ type: 'text', text: JSON.stringify(r, null, 1) }] });
  } catch (e) {
    reply(id, { content: [{ type: 'text', text: `Error: ${e?.message || e}` }], isError: true });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
  const { id, method, params } = msg;
  if (id === undefined || id === null) return;                      // notifications (initialized, cancelled, …)
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: params?.protocolVersion || '2025-06-18', capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'sol-simulator', version: VERSION }, instructions: INSTRUCTIONS });
    case 'ping': return reply(id, {});
    case 'tools/list': return reply(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': return callTool(id, params?.name, params?.arguments);
    default: return fail(id, -32601, `Method not found: ${method}`);
  }
});
// Client gone: stop the web server we started, then exit once pending I/O has settled
// (exiting synchronously here trips a libuv assertion on Windows).
rl.on('close', () => { try { child?.kill(); } catch { /* gone */ } setTimeout(() => process.exit(0), 100); });
log(`ready (${TOOLS.length} tools, root ${ROOT})`);
