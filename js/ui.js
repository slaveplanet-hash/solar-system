// =============================================================================
// ui.js — HUD, time controls, body list, info panel, lil-gui settings, toasts,
// Verify panel and hotkeys. Plain DOM; the markup lives in index.html.
// =============================================================================
import GUI from 'lil-gui';
import { RATE_PRESETS, jdToUTCString, utcStringToJD, utcToTDB, MIN_JD, MAX_JD } from './time.js';
import { AU_KM, C_KM_S } from './ephemeris.js';
import { runVerify } from './verify.js';
import { buildReport } from './report.js';
import { cometInfo } from './comets.js';

const $ = (id) => document.getElementById(id);

function fmtKm(km) {
  if (!isFinite(km)) return '—';
  const a = Math.abs(km);
  if (a < 1) return `${(km * 1000).toFixed(0)} m`;
  if (a < 1e6) return `${km.toLocaleString('en-US', { maximumFractionDigits: a < 100 ? 2 : 0 })} km`;
  if (a < 1e9) return `${(km / 1e6).toFixed(3)} M km`;
  return `${(km / 1e9).toFixed(3)} B km`;
}
function fmtDuration(s) {
  if (!isFinite(s)) return '—';
  if (s < 60) return `${s.toFixed(1)} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m ${(s % 60).toFixed(0).padStart(2, '0')} s`;
  return `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60).toString().padStart(2, '0')} m`;
}
function fmtRate(clock) {
  if (clock.paused) return 'Paused';
  const r = clock.rate, a = Math.abs(r), sgn = r < 0 ? '−' : '';
  const p = RATE_PRESETS.find((x) => x.rate === a);
  if (p) return sgn + (a === 1 ? '1× real time' : p.label.replace('/s', ' / s'));
  return `${sgn}${a.toLocaleString()}×`;
}
function fmtPeriod(days) {
  if (days == null) return '—';
  if (!isFinite(days)) return 'unbound (hyperbolic)';
  const a = Math.abs(days);
  if (a < 2) return `${(a * 24).toFixed(3)} h`;
  if (a < 800) return `${a.toFixed(3)} d`;
  return `${(a / 365.25).toFixed(2)} yr (${a.toLocaleString('en-US', { maximumFractionDigits: 0 })} d)`;
}

export class UI {
  constructor(app) {
    this.app = app;
    this._acc = 0;
    this._buildBodyList();
    this._buildTimeBar();
    this._buildModes();
    this._buildGUI();
    this._bindKeys();
    $('verify-close').onclick = () => $('verify').classList.remove('open');
    $('verify-rerun').onclick = () => this.runVerify();
  }

  // --- body list --------------------------------------------------------------
  _buildBodyList() {
    const list = $('body-list');
    for (const b of this.app.system.bodies) {
      const btn = document.createElement('button');
      btn.className = 'body-btn' + (b.kind === 'moon' ? ' moon' : '');
      btn.innerHTML = `<span class="dot" style="--c:${b.color}"></span>${b.name}`;
      btn.onclick = () => this.app.focus(b);
      btn.dataset.key = b.key;
      list.appendChild(btn);
    }
  }

  /** Append bodies added after start-up (dwarf planets, named asteroids, their moons) in grouped sections. */
  addBodies(list) {
    const el = $('body-list');
    const sections = [['dwarf', 'Dwarf planets'], ['asteroid', 'Asteroids'], ['comet', 'Comets'], ['interstellar', 'Interstellar objects'], ['spacecraft', 'Spacecraft']];
    for (const [type, title] of sections) {
      const primaries = list.filter((b) => b.minorType === type);
      if (!primaries.length) continue;
      const h = document.createElement('div');
      h.className = 'body-section';
      h.textContent = title;
      el.appendChild(h);
      for (const b of primaries) {
        this._bodyButton(el, b);
        for (const m of list.filter((x) => x.kind === 'moon' && x.parent === b.key)) this._bodyButton(el, m);
      }
    }
  }

  _bodyButton(el, b) {
    const btn = document.createElement('button');
    btn.className = 'body-btn' + (b.kind === 'moon' ? ' moon' : '');
    btn.innerHTML = `<span class="dot" style="--c:${b.color}"></span>${b.shortName || b.name}`;
    btn.onclick = () => this.app.focus(b);
    btn.dataset.key = b.key;
    el.appendChild(btn);
  }

  // --- time bar ---------------------------------------------------------------
  _buildTimeBar() {
    const clock = this.app.clock;
    const presets = $('rate-presets');
    for (const p of RATE_PRESETS) {
      const b = document.createElement('button');
      b.textContent = p.label;
      b.onclick = () => { clock.rate = Math.sign(clock.rate || 1) * p.rate; clock.paused = false; this._syncTimeButtons(); };
      b.dataset.rate = p.rate;
      presets.appendChild(b);
    }
    $('btn-pause').onclick = () => { clock.paused = !clock.paused; this._syncTimeButtons(); };
    $('btn-reverse').onclick = () => { clock.reverse(); clock.paused = false; this._syncTimeButtons(); };
    $('btn-now').onclick = () => { clock.setNow(); clock.rate = 1; clock.paused = false; this._syncTimeButtons(); this.toast('Jumped to the current real date/time'); };
    const input = $('date-input');
    input.min = '1800-01-01T00:00'; input.max = '2050-12-31T23:59';
    $('btn-go').onclick = () => this._jumpToInput();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this._jumpToInput(); });
    this._syncTimeButtons();
  }
  _jumpToInput() {
    const jd = utcStringToJD($('date-input').value.replace('T', ' '));
    if (!isFinite(jd)) { this.toast('Enter a date/time (UTC)'); return; }
    if (jd < MIN_JD || jd > MAX_JD) { this.toast('Date must be between 1800 and 2050 (validity of the JPL elements)'); return; }
    this.app.clock.setJD(jd);
    this.toast(`Jumped to ${jdToUTCString(jd, false)} UTC`);
  }
  _syncTimeButtons() {
    const c = this.app.clock;
    $('btn-pause').textContent = c.paused ? '▶' : '❚❚';
    $('btn-pause').classList.toggle('active', c.paused);
    $('btn-reverse').classList.toggle('active', c.rate < 0);
    for (const b of $('rate-presets').children) b.classList.toggle('active', !c.paused && +b.dataset.rate === Math.abs(c.rate));
  }

  // --- camera modes -------------------------------------------------------------
  _buildModes() {
    document.querySelectorAll('#modes [data-mode]').forEach((b) => (b.onclick = () => this.app.setCameraMode(+b.dataset.mode)));
    $('btn-surface').onclick = () => this.toggleSurface();
    $('btn-verify').onclick = () => this.runVerify();
    $('verify-copy').onclick = async () => {
      const v = this._lastVerify;
      if (!v) return;
      const d = this.app.data;
      const md = buildReport(v.res, { env: [
        `Browser run ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC · ${navigator.userAgent.match(/(Chrome|Firefox|Edg|Safari)\/[\d.]+/)?.[0] || 'browser'} · ${window.innerWidth}×${window.innerHeight} @${devicePixelRatio}x · quality ${this.app.quality}`,
        `Data: ${d?.available ? `downloaded ${d.manifest.date} (${d.manifest.mode})` : 'missing'} · checks took ${v.ms.toFixed(0)} ms`,
        'Node test suites: run `npm run report` (writes VERIFY-REPORT.md).'] });
      try { await navigator.clipboard.writeText(md); this.toast('Report copied to the clipboard (Markdown)'); }
      catch { this.toast('Clipboard blocked by the browser — run "npm run report" to get VERIFY-REPORT.md instead', 6000); }
    };
    $('info-follow').onclick = () => { const b = this.app.system.selected; if (b) this.app.focus(b); };
  }
  syncMode(mode) {
    const n = { free: 1, orbit: 2, fly: 2, chase: 3, cockpit: 4 }[mode] ?? 0;
    document.querySelectorAll('#modes [data-mode]').forEach((b) => b.classList.toggle('active', +b.dataset.mode === n));
    $('btn-surface').classList.toggle('active', mode === 'surface');
    const help = mode === 'free' ? 'free' : mode === 'chase' || mode === 'cockpit' ? 'ship' : mode === 'surface' ? 'surface' : 'orbit';
    for (const h of ['free', 'orbit', 'ship', 'surface']) $('help-' + h).style.display = h === help ? '' : 'none';
    if (this.surfState) this._syncSurface();
  }

  // --- lil-gui ----------------------------------------------------------------
  _buildGUI() {
    const app = this.app, scale = app.scale, sys = app.system;
    const gui = new GUI({ title: 'Settings', width: 260 });
    gui.domElement.id = 'gui';
    this.gui = gui;
    const s = { scaleMode: scale.mode === 'visual' ? 'Visual' : 'True', exag: scale.exag, distExp: scale.distExp,
      labels: sys.show.labels, orbits: sys.show.orbits, moonOrbits: sys.show.moonOrbits, axes: sys.show.axes, markers: true,
      fov: app.camera.fov, autoExposure: app.autoExposure, exposure: app.baseExposure };
    this.guiState = s;
    const fS = gui.addFolder('Scale');
    this.scaleCtrl = fS.add(s, 'scaleMode', ['True', 'Visual']).name('Scale mode').onChange((v) => app.setScaleMode(v === 'Visual' ? 'visual' : 'true'));
    fS.add(s, 'exag', 1, 1000, 1).name('Radius exaggeration').onChange((v) => { scale.exag = v; scale.version++; });
    fS.add(s, 'distExp', 0.3, 1, 0.01).name('Distance exponent').onChange((v) => { scale.distExp = v; scale.version++; });
    const fD = gui.addFolder('Display');
    fD.add(s, 'labels').name('Labels').onChange((v) => sys.setVisibility({ labels: v }));
    fD.add(s, 'orbits').name('Orbit lines').onChange((v) => sys.setVisibility({ orbits: v }));
    fD.add(s, 'moonOrbits').name('Moon orbits').onChange((v) => sys.setVisibility({ moonOrbits: v }));
    fD.add(s, 'axes').name('Rotation axes').onChange((v) => sys.setVisibility({ axes: v }));
    fD.add(s, 'markers').name('Body markers').onChange((v) => (sys.markers.visible = v));
    const post = app.post.settings;
    Object.assign(s, { atmospheres: true, clouds: true, rings: true, stars: true, starGain: 1, milkyWay: true, mwGain: 1 });
    fD.add(s, 'atmospheres').name('Atmospheres').onChange((v) => sys.setVisibility({ atmospheres: v }));
    fD.add(s, 'clouds').name('Earth clouds').onChange((v) => sys.setVisibility({ clouds: v }));
    fD.add(s, 'rings').name('Rings').onChange((v) => sys.setVisibility({ rings: v }));
    const fK = gui.addFolder('Sky');
    fK.add(s, 'stars').name('Stars (Yale BSC)').onChange((v) => (app.stars.points.visible = v));
    fK.add(s, 'starGain', 0.1, 4, 0.05).name('Star brightness').onChange((v) => (app.stars.material.uniforms.uGain.value = v));
    fK.add(s, 'milkyWay').name('Milky Way').onChange((v) => (app.milkyWay.mesh.visible = v));
    fK.add(s, 'mwGain', 0, 4, 0.05).name('Milky Way brightness').onChange((v) => (app.milkyWay.material.uniforms.uGain.value = v));
    const fE = gui.addFolder('Effects');
    fE.add(post, 'bloom', 0, 3, 0.01).name('Bloom strength');
    fE.add(post, 'bloomThreshold', 0.3, 4, 0.01).name('Bloom threshold');
    fE.add(post, 'flare').name('Lens flare');
    fE.add(post, 'grain', 0, 0.15, 0.001).name('Film grain');
    fE.add(post, 'vignette', 0, 1, 0.01).name('Vignette');
    fE.add(post, 'chromatic', 0, 1, 0.01).name('Chromatic aberration');
    const fC = gui.addFolder('Camera & exposure');
    fC.add(s, 'fov', 20, 100, 1).name('Field of view').onChange((v) => { app.camera.fov = v; app.camera.updateProjectionMatrix(); });
    fC.add(s, 'autoExposure').name('Eye adaptation').onChange((v) => (app.autoExposure = v));
    fC.add(s, 'exposure', 0.1, 4, 0.01).name('Exposure').onChange((v) => (app.baseExposure = v));
    this._buildShipGUI(gui);
    // View: quality preset + sensor overlay ("real emptiness" when off).
    const fV = gui.addFolder('View & quality');
    s.quality = app.quality || 'High';
    s.sensor = app.view.sensor;
    this.qualityCtrl = fV.add(s, 'quality', ['Low', 'Medium', 'High']).name('Quality preset').onChange((v) => app.applyQuality(v));
    fV.add(s, 'sensor').name('Sensor overlay (brackets)').onChange((v) => {
      app.view.sensor = v;
      this.toast(v ? 'Sensor overlay on: brackets and labels mark small bodies and spacecraft' : 'Sensor overlay off: only what the eye would see — small bodies at their true brightness (mostly invisible)', 5000);
    });
    fV.add({ ev: () => app.events.toggle(true) }, 'ev').name('Upcoming events… (U)');
    fV.close();
    [fK, fE, fC].forEach((f) => f.close());
    if (window.innerWidth < 900) gui.close();
  }
  /** Called once /data/ has been loaded (or found missing). */
  onDataLoaded(data, sb) {
    this.data = data; this.sb = sb;
    const el = $('hud-data');
    if (!data.available) {
      el.textContent = 'missing — run fetch-data';
      el.className = 'missing';
      el.title = 'No ./data/ folder. Run: node fetch-data.mjs (see README.md). Planets and moons still work.';
      $('hud-sb').textContent = 'none loaded';
      return;
    }
    el.textContent = `updated ${data.manifest.date}${data.stale ? ` (${Math.floor(data.ageDays)} d old)` : ''}`;
    el.className = data.stale ? 'stale' : '';
    el.title = data.stale ? 'Data older than 6 months — re-run node fetch-data.mjs' : `mode: ${data.manifest.mode}`;
    $('hud-sb').textContent = `${(sb.count + sb.cpuObjects.length).toLocaleString()} (GPU ${sb.count.toLocaleString()})`;
    // Settings folder
    const f = this.gui.addFolder('Small bodies');
    const s = { mode: 'Overview', size: sb.settings.size, limitMag: sb.settings.limitMag, labels: true };
    // The display mode is applied by App._applyVisibility (the sensor overlay can override it).
    f.add(s, 'mode', ['Overview', 'Realistic (magnitude)']).name('Display').onChange((v) => (this.app.view.sbMode = v === 'Overview' ? 'overview' : 'realistic'));
    f.add(s, 'size', 1, 5, 0.1).name('Point size').onChange((v) => (sb.settings.size = v));
    f.add(s, 'limitMag', 6, 24, 0.5).name('Limiting magnitude').onChange((v) => (sb.settings.limitMag = v));
    f.add(s, 'labels').name('Labels (tracked)').onChange((v) => (sb.showLabels = v));
    const sys = this.app.system;
    Object.assign(s, { minor: true, minorOrbits: true, oort: true });
    f.add(s, 'minor').name('Named asteroids & dwarfs').onChange((v) => sys.setVisibility({ minor: v }));
    f.add(s, 'minorOrbits').name('…their orbits').onChange((v) => sys.setVisibility({ minorOrbits: v }));
    f.add(s, 'oort').name('Oort cloud (illustrative)').onChange((v) => { if (this.app.oort) this.app.oort.visible = v; });
    Object.assign(s, { tails: true, streams: true, meteorRate: 60 });
    f.add(s, 'tails').name('Comet comae & tails').onChange((v) => { if (this.app.cometFx) this.app.cometFx.enabled = v; });
    f.add(s, 'streams').name('Meteor streams').onChange((v) => { if (this.app.showers) this.app.showers.enabled = v; });
    f.add(s, 'meteorRate', 1, 300, 1).name('Meteor time-lapse ×').onChange((v) => { if (this.app.showers) this.app.showers.rateBoost = v; });
    const groups = { mba: 'Main belt', inner: 'Inner / Mars-crossers', trojan: 'Jupiter Trojans', centaur: 'Centaurs', tno: 'Trans-Neptunian',
      atira: 'NEO: Atira', aten: 'NEO: Aten', apollo: 'NEO: Apollo', amor: 'NEO: Amor', pha: 'Hazardous (PHA)', comet: 'Comets',
      interstellar: 'Interstellar', dwarf: 'Dwarf planets', spacecraft: 'Spacecraft' };
    const gs = Object.fromEntries(Object.keys(groups).map((k) => [k, true]));
    // Spacecraft: one switch for the craft bodies, their trails and labels (and any leftover points).
    for (const [k, name] of Object.entries(groups)) f.add(gs, k).name(name).onChange((v) => { sb.setVisibility(k, v); if (k === 'spacecraft') sys.setVisibility({ spacecraft: v }); });
    f.close();
  }

  /** Ship & surface-view settings. */
  _buildShipGUI(gui) {
    const app = this.app, ship = app.ship, cam = app.cam;
    const fS = gui.addFolder('Ship');
    const st = this.shipState = { length: ship.lengthM, forward: ship.forwardAxis, arm: ship.chase.arm, height: ship.chase.height,
      cx: ship.cockpit.x, cy: ship.cockpit.y, cz: ship.cockpit.z, url: '', model: ship.modelName };
    fS.add(st, 'model').name('Model').disable();
    fS.add(st, 'length', 1, 1e6).name('Length (m)').onChange((v) => { if (v > 0) ship.lengthM = v; });
    fS.add(st, 'forward', ['+Z', '-Z', '+X', '-X']).name('Model forward axis').onChange((v) => { ship.setForwardAxis(v); this.syncShip(); });
    fS.add(st, 'arm', 1.2, 15, 0.1).name('Chase distance (× length)').onChange((v) => (ship.chase.arm = v));
    fS.add(st, 'height', -1, 2, 0.01).name('Chase height (× length)').onChange((v) => (ship.chase.height = v));
    fS.add(st, 'cx', -0.6, 0.6, 0.005).name('Cockpit x (× length)').onChange((v) => (ship.cockpit.x = v));
    fS.add(st, 'cy', -0.6, 0.6, 0.005).name('Cockpit y (× length)').onChange((v) => (ship.cockpit.y = v));
    fS.add(st, 'cz', -0.6, 0.6, 0.005).name('Cockpit z (× length, − = nose)').onChange((v) => (ship.cockpit.z = v));
    fS.add(st, 'url').name('GLTF/GLB URL');
    fS.add({ load: () => st.url.trim() && app.loadShipURL(st.url.trim()) }, 'load').name('Load URL (or drop a .glb on the page)');
    fS.add({ reset: () => { ship.useDefaultModel(); this.syncShip(); } }, 'reset').name('Use placeholder ship');
    fS.add({ bring: () => { ship.spawnAt(cam.pos, app.camera.quaternion); if (!cam.piloting) app.setCameraMode(3); } }, 'bring').name('Bring ship to camera');
    fS.close();
    this.shipFolder = fS;
    const fV = gui.addFolder('Surface view');
    const sv = this.surfState = { lat: 0, lon: 0 };
    fV.add({ go: () => this.toggleSurface(true) }, 'go').name('Stand on selected body (G)');
    this.surfLat = fV.add(sv, 'lat', -89.9, 89.9, 0.1).name('Latitude °').onChange((v) => { if (cam.mode === 'surface') cam.surf.lat = v; });
    this.surfLon = fV.add(sv, 'lon', -180, 180, 0.1).name('Longitude ° (E+)').onChange((v) => { if (cam.mode === 'surface') cam.surf.lon = v; });
    fV.add({ leave: () => cam.mode === 'surface' && app.leaveSurface() }, 'leave').name('Leave surface');
    fV.close();
  }

  /** Reflect ship settings after a model change (cockpit anchor, forward axis, name). */
  syncShip() {
    const st = this.shipState, ship = this.app.ship;
    Object.assign(st, { model: ship.modelName, forward: ship.forwardAxis, cx: ship.cockpit.x, cy: ship.cockpit.y, cz: ship.cockpit.z, length: ship.lengthM });
    this.shipFolder.controllers.forEach((c) => c.updateDisplay());
  }

  _syncSurface() {
    const S = this.app.cam.surf;
    if (this.app.cam.mode !== 'surface' || !S) return;
    this.surfState.lat = +S.lat.toFixed(2); this.surfState.lon = +S.lon.toFixed(2);
    this.surfLat.updateDisplay(); this.surfLon.updateDisplay();
  }

  /** G / the Surface button: stand on the selected (or focused) body, or leave the surface. */
  toggleSurface(forceEnter = false) {
    const app = this.app;
    if (app.cam.mode === 'surface' && !forceEnter) { app.leaveSurface(); return; }
    const t = app.system.selected || app.cam.target;
    app.enterSurface(t && t.kind !== 'ship' ? t : app.system.byKey.earth);
  }

  syncQuality() {
    if (this.qualityCtrl) this.guiState.quality = this.app.quality;
    this.gui?.controllersRecursive().forEach((c) => c.updateDisplay());   // flare/grain checkboxes follow the preset
  }

  syncScaleCtrl() { this.guiState.scaleMode = this.app.scale.mode === 'visual' ? 'Visual' : 'True'; this.scaleCtrl.updateDisplay(); }

  // --- keys -----------------------------------------------------------------------
  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      const c = this.app.clock;
      switch (e.code) {
        case 'KeyH': document.body.classList.toggle('hide-ui'); break;
        case 'Digit1': this.app.setCameraMode(1); break;
        case 'Digit2': this.app.setCameraMode(2); break;
        case 'Digit3': this.app.setCameraMode(3); break;
        case 'Digit4': this.app.setCameraMode(4); break;
        case 'KeyP': c.paused = !c.paused; this._syncTimeButtons(); break;
        case 'KeyR': c.reverse(); this._syncTimeButtons(); break;
        case 'BracketRight': case 'BracketLeft': {
          const i = RATE_PRESETS.findIndex((p) => p.rate === Math.abs(c.rate));
          const j = Math.max(0, Math.min(RATE_PRESETS.length - 1, (i < 0 ? 0 : i) + (e.code === 'BracketRight' ? 1 : -1)));
          c.rate = Math.sign(c.rate || 1) * RATE_PRESETS[j].rate; c.paused = false; this._syncTimeButtons(); break;
        }
        case 'KeyV': this.app.setScaleMode(this.app.scale.mode === 'visual' ? 'true' : 'visual'); break;
        case 'KeyF': if (this.app.cam.target && this.app.cam.target.kind !== 'ship') this.app.focus(this.app.cam.target); break;
        case 'KeyG': this.toggleSurface(); break;
      }
    });
  }

  // --- toasts & verify ------------------------------------------------------------
  toast(msg, ms = 3200) {
    const el = document.createElement('div');
    el.className = 'toast'; el.textContent = msg;
    $('toasts').appendChild(el);
    setTimeout(() => el.classList.add('out'), ms);
    setTimeout(() => el.remove(), ms + 500);
  }

  runVerify() {
    const t0 = performance.now();
    const res = runVerify({ data: this.app.data, smallBodies: this.app.smallBodies, renderer: this.app.renderer, system: this.app.system });
    const ms = performance.now() - t0;
    this._lastVerify = { res, ms };
    const tbody = $('verify-rows');
    tbody.innerHTML = '';
    for (const r of res) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td><span class="st st-${r.status.toLowerCase()}">${r.status}</span></td><td><div class="vn"></div><div class="vd"></div></td>`;
      tr.querySelector('.vn').textContent = r.name;
      tr.querySelector('.vd').textContent = r.detail;
      tbody.appendChild(tr);
    }
    const n = (s) => res.filter((r) => r.status === s).length;
    $('verify-summary').textContent = `${n('PASS')} pass · ${n('FAIL')} fail · ${n('PENDING')} pending · ${n('SKIP')} skipped — ${ms.toFixed(0)} ms`;
    $('verify').classList.add('open');
    console.group('%c[Verify] accuracy self-checks', 'color:#7fd4ff;font-weight:bold');
    for (const r of res) console.log(`${r.status.padEnd(7)} ${r.name} — ${r.detail}`);
    console.groupEnd();
    return res;
  }

  /** HUD rows while flying the ship or standing on a surface. */
  _hudShipSurface(cam, visual) {
    const app = this.app;
    const fmtSpeed = (kms) => `${kms < 1 ? (kms * 1000).toFixed(1) + ' m/s' : kms.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' km/s'} · ${(kms / C_KM_S).toExponential(2)} c`;
    if (cam.mode === 'surface') {
      const S = cam.surf, b = S.body;
      $('hud-target').textContent = `${b.name} · ${Math.abs(S.lat).toFixed(2)}°${S.lat >= 0 ? 'N' : 'S'} ${Math.abs(S.lon).toFixed(2)}°${S.lon >= 0 ? 'E' : 'W'}`;
      $('hud-dist').textContent = `looking az ${(((S.az % 360) + 360) % 360).toFixed(0)}° alt ${S.alt.toFixed(0)}° · FOV ${app.camera.fov.toFixed(0)}°`;
      $('hud-alt').textContent = `on the ground (eye ${fmtKm(Math.max(0.002, 2e-6 * b.radius))})`;
      $('hud-speed').textContent = '0 m/s (standing)';
      $('hud-speed-ref').textContent = `rel. ${b.name}`;
      $('hud-light').textContent = fmtDuration(Math.hypot(...b.helio) / C_KM_S);
      return;
    }
    const s = app.ship, ref = s.frame.ref;
    if (!ref) return;
    const toKm = visual ? ref.radius / ref.rScene : 1;
    const dScene = Math.hypot(s.pos[0] - ref.scenePos[0], s.pos[1] - ref.scenePos[1], s.pos[2] - ref.scenePos[2]);
    $('hud-target').textContent = `Ship (${s.modelName}) · near ${ref.name}`;
    $('hud-dist').textContent = `${visual ? '≈ ' : ''}${fmtKm(dScene * toKm)} from the centre of ${ref.name}`;
    $('hud-alt').textContent = `${visual ? '≈ ' : ''}${fmtKm(dScene * toKm - ref.radius)}${s.lit < 0.02 ? ' · in shadow' : s.lit < 0.98 ? ' · partial shadow' : ''}`;
    $('hud-speed').textContent = `${fmtSpeed(s.speed * toKm)} · throttle ${(s.throttle * 100).toFixed(0)}%`;
    $('hud-speed-ref').textContent = `rel. ${ref.name}`;
    $('hud-light').textContent = fmtDuration(Math.hypot(...ref.helio) / C_KM_S);
  }

  // --- per-frame HUD (throttled) --------------------------------------------------------
  update(dt) {
    this._acc += dt;
    if (this._acc < 0.1) return;
    this._acc = 0;
    const app = this.app, c = app.clock, cam = app.cam, t = cam.target, visual = app.scale.s > 0.001;
    $('hud-date').textContent = jdToUTCString(c.jdUTC) + ' UTC';
    $('hud-jd').textContent = `JD ${utcToTDB(c.jdUTC).toFixed(5)} TDB`;
    $('hud-rate').textContent = fmtRate(c);
    $('hud-scale').textContent = app.scale.transitioning ? 'transitioning…' : visual ? `Visual (radii ×${app.scale.exag})` : 'True scale';
    const modeName = { free: 'Free flight', orbit: 'Orbit', fly: 'Flying…', chase: 'Ship · chase', cockpit: 'Ship · cockpit', surface: 'Surface view' }[cam.mode];
    $('hud-mode').textContent = modeName;
    $('credits').style.display = app.photoTex?.anyLoaded ? '' : 'none';   // CC BY attribution while photo maps are in use
    this._syncSurface();
    if (cam.piloting || cam.mode === 'surface') this._hudShipSurface(cam, visual);
    else if (t) {
      const dScene = Math.hypot(cam.pos[0] - t.scenePos[0], cam.pos[1] - t.scenePos[1], cam.pos[2] - t.scenePos[2]);
      // In visual scale, near the target convert via its radius; far away (> 50 radii) invert the
      // heliocentric distance mapping instead, so the numbers stay physically meaningful.
      const toKm = visual ? t.radius / t.rScene : 1;
      let dKm = dScene * toKm;
      if (visual && dScene > 50 * t.rScene) {
        const ct = app.cameraTrueHelio(), h = t.helio;             // three axes vs ecliptic (x, z, −y)
        dKm = Math.hypot(ct[0] - h[0], ct[1] - h[2], ct[2] + h[1]);
      }
      $('hud-target').textContent = t.name;
      $('hud-dist').textContent = `${visual ? '≈ ' : ''}${fmtKm(dKm)} · ${(dKm / AU_KM).toPrecision(4)} AU`;
      $('hud-alt').textContent = `${visual ? '≈ ' : ''}${fmtKm(dKm - t.radius)}`;
      const ref = cam.speedRef || t;
      const kms = cam.speed * (visual ? ref.radius / ref.rScene : 1);
      $('hud-speed').textContent = `${kms < 1 ? (kms * 1000).toFixed(1) + ' m/s' : kms.toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' km/s'} · ${(kms / C_KM_S).toExponential(2)} c`;
      $('hud-speed-ref').textContent = `rel. ${ref.name}`;
      const rs = Math.hypot(...t.helio);
      $('hud-light').textContent = t.kind === 'sun' ? '—' : fmtDuration(rs / C_KM_S);
    }
    this._updateInfo(t);
    $('oort-note').style.display = this.app.oort?.visible && this.app.oortFade > 0.05 ? 'block' : 'none';
    // Meteor showers Earth is currently crossing (activity from the Earth–stream distance).
    const sh = (this.app.showers?.state || []).filter((x) => x.act > 0.03);
    $('hud-shower-row').style.display = sh.length ? '' : 'none';
    if (sh.length) $('hud-shower').textContent = sh.map((x) => `${x.shower.name} ${(x.act * 100).toFixed(0)}%`).join(', ')
      + (this.app.showers.sky.active
        ? (sh.some((x) => (x.radiantAlt ?? 90) > 0) ? ' · meteors visible' : ' · radiant below horizon') : '');
    // Keep the body list just below the HUD (the HUD grows when data rows/warnings appear).
    const hud = $('hud'), hb = hud.offsetTop + hud.offsetHeight + 10;
    if (this._hudBottom !== hb) { this._hudBottom = hb; $('bodies').style.top = hb + 'px'; $('bodies').style.maxHeight = `calc(100vh - ${hb + 90}px)`; }
    // Orbit-uncertainty note (two-body propagation far from the element epoch), refreshed ~1×/s.
    if (this.sb?.count && (this._uncT = (this._uncT || 0) + 1) % 10 === 0) {
      const u = this.sb.uncertainty(utcToTDB(c.jdUTC));
      const parts = [];
      if (u.asteroids) parts.push(`${u.asteroids.toLocaleString()} asteroids >50 yr from epoch`);
      if (u.comets) parts.push(`${u.comets.toLocaleString()} comets >1 orbit from epoch`);
      $('hud-unc-row').style.display = parts.length ? '' : 'none';
      $('hud-unc').textContent = parts.join('; ');
      $('hud-unc-row').title = 'Two-body propagation ignores planetary perturbations; positions far from the element epoch are approximate.';
    }
    document.querySelectorAll('.body-btn').forEach((b) => b.classList.toggle('active', t && b.dataset.key === t.key));
    this._syncTimeButtons();
  }

  _updateInfo(b) {
    const el = $('info');
    if (!b) { el.classList.remove('open'); return; }
    el.classList.add('open');
    if (this._infoKey !== b.key) {
      this._infoKey = b.key;
      $('info-name').textContent = b.name;
      $('info-name').style.setProperty('--c', b.color);
      $('info-type').textContent = b.type;
      const km = (v) => (v < 10 ? v.toFixed(2) : v.toLocaleString('en-US', { maximumFractionDigits: 0 }));
      $('info-radius').textContent = b.craft ? `${b.craft.span} m across (largest dimension)` : b.axes
        ? `${km(2 * b.axes[0])} × ${km(2 * b.axes[1])} × ${km(2 * b.axes[2])} km (mean R ${km(b.radius)} km)`
        : `${b.radius.toLocaleString('en-US')} km${b.flat ? ` (flattening ${b.flat})` : ''}`;
      $('info-mass').textContent = b.mass ? `${b.mass.toExponential(3).replace('e+', ' × 10^')} kg` : '—';
      const parent = b.parent && this.app.system.byKey[b.parent];
      $('info-orbit').textContent = b.kind === 'sun' ? '—' : fmtPeriod(b.orbitDays) + (b.kind === 'moon' ? ` (around ${parent.name})` : '');
      $('info-rot').textContent = b.minorType === 'spacecraft' ? 'attitude-controlled' : b.kind === 'moon' ? (b.rotHours ? fmtPeriod(b.rotHours / 24) : `${fmtPeriod(b.orbitDays)} — assumed synchronous`)
        : b.lockedTo ? `${fmtPeriod(b.rotHours / 24)} — synchronous with ${this.app.system.byKey[b.lockedTo]?.name}`
          : `${fmtPeriod(b.rotHours / 24)}${b.rotHours < 0 ? ' — retrograde' : ''}`;
      $('info-tilt').textContent = b.kind === 'moon' ? '≈0° (synchronous)' : b.tilt != null ? `${b.tilt}°` : (b.poleNote ? `pole: ${b.poleNote}` : '—');
      $('info-moons').textContent = String(this.app.system.moonsOf(b.key));
      $('info-notes-row').style.display = b.notes ? '' : 'none';
      $('info-notes').textContent = b.notes || '';
    }
    // Two-body orbit far from its element epoch (and not covered by Horizons vectors): warn.
    if (b.elementEpoch) {
      const jd = utcToTDB(this.app.clock.jdUTC);
      const yrs = Math.abs(jd - b.elementEpoch) / 365.25;
      const covered = b.track && b.track.covers(jd);
      const warn = !covered && yrs > 50
        ? `⚠ Orbit uncertainty: ${Math.round(yrs)} years from the element epoch — two-body propagation ignores planetary perturbations, so this position is approximate.` : '';
      const text = [b.cometEl ? cometInfo(b, this.app.system) : null, b.infoFn ? null : b.notes, warn].filter(Boolean).join(' ');
      if ($('info-notes').textContent !== text) { $('info-notes').textContent = text; $('info-notes-row').style.display = text ? '' : 'none'; }
    }
    // Live notes (spacecraft: distances, light time, data coverage), refreshed with the HUD.
    if (b.infoFn) {
      const text = b.infoFn(this.app.system, utcToTDB(this.app.clock.jdUTC));
      if ($('info-notes').textContent !== text) { $('info-notes').textContent = text; $('info-notes-row').style.display = text ? '' : 'none'; }
    }
    $('info-follow').style.display = b.minorType === 'spacecraft' ? '' : 'none';
    const r = Math.hypot(...b.helio);
    $('info-sundist').textContent = b.kind === 'sun' ? '—' : `${(r / AU_KM).toFixed(5)} AU · ${fmtKm(r)}`;
  }
}
