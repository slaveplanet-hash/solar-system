// =============================================================================
// bridge.js — Lets the MCP server (mcp/server.mjs) drive this tab, through tools/serve.mjs:
// commands arrive as Server-Sent Events on /__bridge/events, results are POSTed to
// /__bridge/result. Loaded only when the page is served from localhost (see main.js).
//
// A background tab gets no animation frames, so every command applies its change and then
// steps the simulation itself (_stepSimulation / _frame) before reading anything back.
// =============================================================================
import { utcToTDB, tdbToUTC, jdToUTCString, unixMsToJD, jdToUnixMs } from './time.js';
import { computeEvents } from './events.js';
import { SAT_GROUPS, satValidity, MAX_DAYS } from './satcore.js';
import { AU_KM } from './ephemeris.js';

const MIN_JD = 2378496.5, MAX_JD = 2470172.5;
const iso = (jdUTC) => new Date(jdToUnixMs(jdUTC)).toISOString().replace(/\.\d{3}Z$/, 'Z');
const $ = (id) => document.getElementById(id);

export function startBridge(app) {
  let es = null;
  const connect = () => {
    es = new EventSource('/__bridge/events');
    es.onmessage = async (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      let reply;
      try {
        const fn = COMMANDS[msg.cmd];
        if (!fn) throw new Error(`Unknown command "${msg.cmd}"`);
        reply = { id: msg.id, ok: true, result: await fn(app, msg.args || {}) };
      } catch (e) {
        reply = { id: msg.id, ok: false, error: e?.message || String(e) };
      }
      try { await fetch('/__bridge/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: safeJSON(reply) }); }
      catch { /* server gone */ }
    };
    // EventSource reconnects by itself (retry: 3 s); a server that was restarted is picked up again.
    es.onerror = () => {};
  };
  connect();
  app.bridge = { get connected() { return es?.readyState === 1; } };
}

/** JSON with cycles, three.js objects and typed arrays tamed, capped in size (for eval results). */
function safeJSON(v, cap = 2e6) {
  const seen = new WeakSet();
  const s = JSON.stringify(v, (k, x) => {
    if (typeof x === 'bigint') return String(x);
    if (typeof x === 'function') return `[function ${x.name || ''}]`;
    if (x && typeof x === 'object') {
      if (seen.has(x)) return '[circular]';
      seen.add(x);
      if (ArrayBuffer.isView(x)) return x.length > 64 ? `[${x.constructor.name} × ${x.length}]` : Array.from(x);
      if (x.isObject3D) return `[${x.type} ${x.name || ''}]`;
      if (x.isMaterial || x.isTexture || x.isBufferGeometry) return `[${x.type}]`;
      if (x instanceof Element) return `[<${x.tagName.toLowerCase()}${x.id ? '#' + x.id : ''}>]`;
    }
    return x;
  });
  if (s && s.length > cap) return JSON.stringify({ id: v.id, ok: v.ok, result: `[result truncated: ${s.length} characters] ` + s.slice(0, 4000) });
  return s;
}

// --- helpers -------------------------------------------------------------------------
function parseUTC(s) {
  if (s == null || s === 'now') return unixMsToJD(Date.now());
  let t = String(s).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) t += 'T00:00';
  if (!/[zZ]|[+-]\d{2}:?\d{2}$/.test(t)) t += 'Z';
  const ms = Date.parse(t);
  if (!isFinite(ms)) throw new Error(`Cannot read the time "${s}" — use ISO 8601 UTC, e.g. 2026-08-12T17:45`);
  const jd = unixMsToJD(ms);
  if (jd < MIN_JD || jd > MAX_JD) throw new Error('Time must be between 1800 and 2050');
  return jd;
}
function settle(app, frames = 2) { app._stepSimulation(0); for (let i = 0; i < frames; i++) app._frame(); }
/** Finish a camera flight right away (a background tab has no frames to animate it). */
function landFlight(app) {
  const f = app.cam.fly;
  if (app.cam.mode === 'fly' && f) f.t = f.dur;               // the next frame lands it
  for (let i = 0; i < 400 && app.cam.mode === 'fly'; i++) app._frame();
}

function findBody(app, q) {
  const s = String(q ?? '').trim(), k = s.toLowerCase(), sys = app.system;
  if (sys.byKey[k] && k !== 'satellite') return { body: sys.byKey[k] };
  const b = sys.bodies.find((x) => x.key !== 'satellite' && ((x.name || '').toLowerCase() === k || (x.shortName || '').toLowerCase() === k))
    || sys.bodies.find((x) => x.key !== 'satellite' && (x.name || '').toLowerCase().replace(/^\(?\d+\)?\s+/, '') === k);
  if (b) return { body: b };
  const L = app.satLayer;
  if (L) {
    const alias = { HUBBLE: 20580, ISS: 25544, TIANGONG: 48274 }[s.toUpperCase()];
    let i = /^\d+$/.test(s) ? L.findNorad(s) : alias ? L.findNorad(alias) : L.sats.findIndex((o) => o.name.toUpperCase() === s.toUpperCase());
    if (i < 0) { const part = L.sats.map((o, j) => [o, j]).filter(([o]) => o.name.toUpperCase().includes(s.toUpperCase())); if (part.length === 1) i = part[0][1]; }
    if (i >= 0) return { sat: i };
  }
  const near = sys.bodies.filter((x) => x.key !== 'satellite' && (x.name || '').toLowerCase().includes(k)).slice(0, 8).map((x) => `${x.name} (${x.key})`);
  throw new Error(`No body or satellite "${q}".${near.length ? ' Did you mean: ' + near.join(', ') + '?' : ' Use sim_list_bodies (bodies) or satellite_find (satellites).'}`);
}

function status(app) {
  app.ui.update(1);                                          // the HUD only refreshes on frames: bring it up to date
  const c = app.clock, cam = app.cam, t = cam.target, sel = app.system.selected;
  const hud = (id) => $(id)?.textContent || null;
  return {
    time_utc: iso(c.jdUTC), time_tdb_jd: +utcToTDB(c.jdUTC).toFixed(6), rate_sim_seconds_per_second: c.rate, paused: c.paused,
    scale: app.scale.mode, camera_mode: cam.mode, target: t ? { key: t.key, name: t.name } : null,
    selected: sel ? { key: sel.key, name: sel.name } : null,
    distance_to_target: hud('hud-dist'), altitude_above_target: hud('hud-alt'), camera_speed: hud('hud-speed'),
    surface: cam.mode === 'surface' && cam.surf ? { body: cam.surf.body.name, lat: +cam.surf.lat.toFixed(4), lon: +cam.surf.lon.toFixed(4), az: +(((cam.surf.az % 360) + 360) % 360).toFixed(1), alt: +cam.surf.alt.toFixed(1), fov: +(cam.surf.fov ?? app.camera.fov).toFixed(1) } : null,
    data: app.data?.available ? `downloaded ${app.data.manifest.date}` : 'missing', satellites: hud('hud-sat'), small_bodies: hud('hud-sb'),
    meteor_shower: $('hud-shower-row')?.style.display === '' ? hud('hud-shower') : null,
    quality: app.quality, sensor_overlay: app.view.sensor, window: `${innerWidth}×${innerHeight}`, tab_visible: !document.hidden,
  };
}

// --- commands --------------------------------------------------------------------------
const COMMANDS = {
  ping: () => ({ pong: true, url: location.href }),
  status: (app) => status(app),

  set_time: (app, { utc, rate, paused, now }) => {
    const c = app.clock;
    if (now) c.setNow();
    else if (utc != null) c.setJD(parseUTC(utc));
    if (rate != null) { if (!isFinite(+rate)) throw new Error('rate must be a number (simulated seconds per real second; negative runs backwards)'); c.rate = +rate; if (+rate !== 0 && paused == null) c.paused = false; }
    if (paused != null) c.paused = !!paused;
    app.ui._syncTimeButtons?.();
    settle(app);
    return status(app);
  },

  focus: (app, { target, instant = true }) => {
    const hit = findBody(app, target);
    if (hit.sat != null) {
      const s = app.satLayer.sats[hit.sat];
      if (satValidity(s, app.clock.jdUTC) === 'expired') {
        throw new Error(`${s.name} is not shown on ${iso(app.clock.jdUTC).slice(0, 10)}: its orbital elements are from ${iso(s.epoch).slice(0, 10)} and are only used within ±${MAX_DAYS} days (SGP4 errors grow by km per day). Set a time near that date (sim_set_time) or run update.bat.`);
      }
      if (app.cam.mode === 'surface') app.leaveSurface();
      app.selectSatellite(hit.sat, { instant });
    }
    else { if (app.cam.mode === 'surface') app.leaveSurface(); app._stepSimulation(0); app.system.selected = hit.body; app.cam.flyTo(hit.body, { instant }); }
    if (instant) landFlight(app);
    settle(app);
    return status(app);
  },

  camera: (app, { mode, distance_km, radii, azimuth_deg, elevation_deg }) => {
    const cam = app.cam;
    if (mode) {
      const n = { free: 1, orbit: 2, chase: 3, cockpit: 4 }[mode];
      if (!n) throw new Error('mode must be orbit, free, chase or cockpit (surface view: sim_surface)');
      if (cam.mode === 'surface') app.leaveSurface();
      app.setCameraMode(n);
      landFlight(app);
    }
    if (distance_km != null || radii != null || azimuth_deg != null || elevation_deg != null) {
      if (cam.mode !== 'orbit') { if (cam.mode === 'surface') app.leaveSurface(); cam.setMode('orbit'); landFlight(app); }
      const t = cam.target;
      if (!t) throw new Error('No target — sim_focus first');
      if (radii != null) cam.orbit.k = +radii;
      if (distance_km != null) {
        // True scale: scene units are km. Visual scale: converted with the target's radius (approximate).
        const kmPerRadius = t.radius;
        cam.orbit.k = (+distance_km) / kmPerRadius;
      }
      cam.orbit.k = Math.max(cam._minK(), Math.min(5e7, cam.orbit.k));
      if (azimuth_deg != null) cam.orbit.az = (+azimuth_deg * Math.PI) / 180;
      if (elevation_deg != null) cam.orbit.el = Math.max(-1.55, Math.min(1.55, (+elevation_deg * Math.PI) / 180));
    }
    settle(app);
    return status(app);
  },

  surface: (app, { body = 'earth', lat, lon, azimuth_deg, altitude_deg, fov_deg }) => {
    const hit = findBody(app, body);
    if (!hit.body) throw new Error('Surface view needs a body (planet, moon, asteroid…), not a satellite');
    app.enterSurface(hit.body, { lat: lat != null ? +lat : undefined, lon: lon != null ? +lon : undefined, az: azimuth_deg != null ? +azimuth_deg : undefined, alt: altitude_deg != null ? +altitude_deg : undefined });
    landFlight(app);
    if (fov_deg != null && app.cam.surf) app.cam.surf.fov = Math.max(1, Math.min(100, +fov_deg));
    settle(app, 3);
    return status(app);
  },
  leave_surface: (app) => { if (app.cam.mode === 'surface') app.leaveSurface(); settle(app); return status(app); },

  scale: (app, { mode }) => {
    if (!['true', 'visual'].includes(mode)) throw new Error('mode must be "true" (real sizes and distances) or "visual" (enlarged bodies, compressed distances)');
    app.scale.snap(mode); app.ui.syncScaleCtrl(); settle(app);
    return status(app);
  },

  display: (app, a) => {
    const sys = app.system, flags = {};
    for (const [k, key] of [['orbits', 'orbits'], ['moon_orbits', 'moonOrbits'], ['labels', 'labels'], ['axes', 'axes'], ['atmospheres', 'atmospheres'],
      ['clouds', 'clouds'], ['rings', 'rings'], ['spacecraft', 'spacecraft'], ['named_small_bodies', 'minor'], ['small_body_orbits', 'minorOrbits']]) if (a[k] != null) flags[key] = !!a[k];
    if (Object.keys(flags).length) sys.setVisibility(flags);
    if (a.markers != null) { sys.markers.visible = !!a.markers; if (app.ui.guiState) app.ui.guiState.markers = !!a.markers; }
    if (a.sensor_overlay != null) app.view.sensor = !!a.sensor_overlay;
    if (a.quality) { if (!['Low', 'Medium', 'High'].includes(a.quality)) throw new Error('quality: Low, Medium or High'); app.applyQuality(a.quality); }
    if (a.stars != null) app.stars.points.visible = !!a.stars;
    if (a.milky_way != null) app.milkyWay.mesh.visible = !!a.milky_way;
    if (a.ui_hidden != null) document.body.classList.toggle('hide-ui', !!a.ui_hidden);
    const L = app.satLayer;
    if (L && a.satellites) {
      const s = a.satellites;
      for (const k of ['paths', 'points', 'labels']) if (s[k] != null) L.settings[k] = !!s[k];
      if (s.path_opacity != null) L.settings.pathGain = Math.max(0.05, Math.min(1, +s.path_opacity));
      for (const [g, on] of Object.entries(s.groups || {})) { if (!SAT_GROUPS.some((x) => x.key === g)) throw new Error(`Unknown satellite group "${g}" (${SAT_GROUPS.map((x) => x.key).join(', ')})`); L.setVisibility(g, !!on); }
    }
    if (app.smallBodies && a.small_body_groups) for (const [g, on] of Object.entries(a.small_body_groups)) app.smallBodies.setVisibility(g, !!on);
    app.ui.gui?.controllersRecursive().forEach((c) => c.updateDisplay());
    settle(app);
    return { ok: true, show: { ...sys.show }, satellites: L ? { ...L.settings, groups: Object.fromEntries(SAT_GROUPS.map((g, i) => [g.key, L.visible[i]])) } : null };
  },

  list_bodies: (app, { kind, query }) => {
    const q = (query || '').toLowerCase();
    return app.system.bodies.filter((b) => b.key !== 'satellite' && (!kind || b.kind === kind || b.minorType === kind) && (!q || b.name.toLowerCase().includes(q) || b.key.includes(q)))
      .map((b) => ({ key: b.key, name: b.name, kind: b.minorType || b.kind, parent: b.kind === 'moon' ? b.parent : undefined }));
  },

  body_info: (app, { body }) => {
    const hit = findBody(app, body);
    if (hit.sat != null) { const L = app.satLayer; return { satellite: L.sats[hit.sat].name, norad: L.sats[hit.sat].norad, description: L.describe(hit.sat) }; }
    const b = hit.body, E = app.system.byKey.earth.helio, jdT = utcToTDB(app.clock.jdUTC);
    const dE = Math.hypot(b.helio[0] - E[0], b.helio[1] - E[1], b.helio[2] - E[2]), rS = Math.hypot(...b.helio);
    return { key: b.key, name: b.name, type: b.type, radius_km: b.radius, mass_kg: b.mass ?? null, offline_on_this_date: !!b.offline,
      distance_from_sun: { km: Math.round(rS), au: +(rS / AU_KM).toFixed(6) }, distance_from_earth: { km: Math.round(dE), au: +(dE / AU_KM).toFixed(8) },
      heliocentric_ecliptic_j2000_km: b.helio.map((v) => Math.round(v)), notes: b.infoFn ? b.infoFn(app.system, jdT) : (b.notes || null), time_utc: iso(app.clock.jdUTC) };
  },

  show_event: (app, { type, near_utc, index = 0 }) => {
    if (!app.data) throw new Error('Data still loading — try again in a moment');
    const jd = utcToTDB(near_utc ? parseUTC(near_utc) : app.clock.jdUTC);
    // Search a window around the requested time; take the requested type nearest to it.
    let evs = computeEvents(app.data, jd - 2, 2 * 365).filter((e) => !type || e.type === type);
    if (!evs.length) throw new Error(`No ${type || ''} event within two years after ${iso(tdbToUTC(jd))}`);
    if (near_utc) evs.sort((a, b) => Math.abs(a.jd - jd) - Math.abs(b.jd - jd));
    const ev = evs[Math.min(+index || 0, evs.length - 1)];
    app.events.jump(ev);
    landFlight(app);
    settle(app, 3);
    return { event: { type: ev.type, title: ev.title, detail: ev.detail, time_utc: iso(tdbToUTC(ev.jd)) }, message: [...document.querySelectorAll('.toast')].pop()?.textContent || null, status: status(app) };
  },

  screenshot: (app, { width = 1280, quality = 0.8, hide_ui = false }) => {
    if (hide_ui) document.body.classList.add('hide-ui');
    app._frame();                                             // render now, then read the canvas in the same task
    const src = app.renderer.domElement;
    const w = Math.max(160, Math.min(+width || 1280, src.width)), h = Math.round(src.height * (w / src.width));
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    const url = c.toDataURL('image/jpeg', Math.max(0.3, Math.min(0.95, +quality || 0.8)));
    if (hide_ui) document.body.classList.remove('hide-ui');
    return { mimeType: 'image/jpeg', data: url.slice(url.indexOf(',') + 1), width: w, height: h, note: 'The 3-D view only (HUD and panels are HTML and not in the image; use sim_status for their values).' };
  },

  verify: (app) => {
    const res = app.ui.runVerify();
    $('verify')?.classList.remove('open');
    const n = (s) => res.filter((r) => r.status === s).length;
    return { summary: `${n('PASS')} pass, ${n('FAIL')} fail, ${n('SKIP')} skipped, ${n('PENDING')} pending`, results: res.map((r) => ({ status: r.status, name: r.name, detail: r.detail })) };
  },

  errors: () => ({ entries: (window.__errlog?.entries || []).slice(-50) }),

  eval: async (app, { code }) => {
    if (typeof code !== 'string' || !code.trim()) throw new Error('code: a JavaScript snippet (the app is `app`; the last expression or a `return` is the result)');
    // Expression first; statements (with an explicit return) as a fallback.
    let fn;
    try { fn = new Function('app', `return (async () => (${code}))();`); }
    catch { fn = new Function('app', `return (async () => { ${code} })();`); }
    const r = await fn(app);
    settle(app, 1);
    return r === undefined ? null : r;
  },
};
