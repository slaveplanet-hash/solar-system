// =============================================================================
// main.js — App bootstrap and frame loop.
//
// Frame order (all positions float64 until the very last step):
//   1. advance SimClock            (UTC JD, rate × real dt)
//   2. ephemeris                   (planets, Moon, 20 major moons: heliocentric km)
//   3. scale mapping + shadows     (km → scene units; eclipse occluders per body)
//   4. camera controller           (float64 camera position in scene units)
//   5. floating origin sync        (group.position = body − camera, float32; uniforms)
//   6. eye adaptation, lens flare, HDR post-processing
// =============================================================================
import * as THREE from 'three';
import { SimClock, utcToTDB, utcStringToJD } from './time.js';
import { computeSystemState, AU_KM } from './ephemeris.js';
import { computeMoonStates } from './moons.js';
import { ScaleSystem } from './scale.js';
import { SolarSystem } from './bodies.js';
import { CameraController } from './camera.js';
import { StarField, MilkyWay, SkyDome } from './sky.js';
import { PostFX } from './postfx.js';
import { UI } from './ui.js';
import { DataStore } from './datastore.js';
import { SmallBodyLayer } from './smallbodies.js';
import { buildMinorBodyDefs, OortCloud } from './minorbodies.js';
import { buildCometDefs, CometVisuals, MeteorShowers } from './comets.js';
import { ShipController } from './ship.js';
import { buildSpacecraftDefs, SpacecraftTrails, paletteTexture } from './spacecraft.js';
import { PhotometricPoints, SensorOverlay } from './sensor.js';
import { EventsPanel } from './eventsui.js';
import { sunlightFactor } from './eclipse.js';
import { nearestSurface } from './refframe.js';
import { PhotoTextures } from './textures.js';

// Quality presets: pixel ratio cap, MSAA samples, small-body draw limit, optional effects.
export const QUALITY = {
  Low:    { pixelRatio: 1, samples: 0, smallBodies: 20000, flare: false, grain: 0, texture: 2048 },
  Medium: { pixelRatio: 1.5, samples: 2, smallBodies: 60000, flare: true, grain: 0.03, texture: 4096 },
  High:   { pixelRatio: 2, samples: 4, smallBodies: Infinity, flare: true, grain: 0.03, texture: 8192 },
};

class App {
  constructor() {
    const canvas = document.getElementById('scene');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, logarithmicDepthBuffer: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x000000);
    // Scene units are km (true scale). Log depth lets near = 1 m and far = 10^16 km (the Oort cloud) coexist.
    this.camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.001, 1e16);

    this.clock = new SimClock();
    this.scale = new ScaleSystem();
    this.system = new SolarSystem(this.scene);
    this.photoTex = new PhotoTextures(this.system, this.renderer);   // lazy, tiered photo maps
    this.photoTex.init().then((list) => { this.system._photoList = list; });
    this.stars = new StarField();
    this.milkyWay = new MilkyWay();
    this.skyDome = new SkyDome();                             // ground-view sky (surface view only)
    this.scene.add(this.milkyWay.mesh, this.stars.points, this.skyDome.mesh);
    this.stars.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.cam = new CameraController(this.camera, canvas, this.system);
    this.ship = new ShipController(this.scene, this.system);
    this.cam.ship = this.ship;
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.post.setSize(window.innerWidth, window.innerHeight);
    this.photo = new PhotometricPoints(this.scene);            // every body at its true apparent magnitude
    this.sensor = new SensorOverlay();                         // brackets for tiny tracked objects (toggle)
    this.view = { sensor: true, sbMode: 'overview' };
    this.state = {};
    this.autoExposure = true;
    this.baseExposure = 1.0;
    this.time = 0;

    this.ui = new UI(this);
    this.events = new EventsPanel(this);
    let q0 = 'High';
    try { q0 = localStorage.getItem('sol.quality') || (window.innerWidth < 900 ? 'Medium' : 'High'); } catch { /* storage blocked */ }
    this.applyQuality(QUALITY[q0] ? q0 : 'High');
    this.clock.onClamp = (m) => this.ui.toast(m, 5000);
    this.cam.onModeChange = (m) => { this.ui.syncMode(m); this._surfaceOverlays(m === 'surface'); };
    this.cam.onPick = (b) => this.focus(b);
    this.cam.onNotice = (m) => this.ui.toast(m, 6000);
    this.system.onLabelClick = (b) => this.focus(b);

    // URL options for bookmarking a view: ?t=2024-04-08T18:18&focus=moon&scale=true&rate=0&instant
    const q = new URLSearchParams(location.search);
    if (q.get('t')) { const jd = utcStringToJD(q.get('t')); if (isFinite(jd)) this.clock.setJD(jd); }
    if (q.get('rate') != null) { const r = +q.get('rate'); if (r === 0) this.clock.paused = true; else if (isFinite(r)) this.clock.rate = r; }
    if (q.get('scale') === 'true') { this.scale.mode = 'true'; this.scale.s = 0; this.scale._from = this.scale._to = 0; this.ui.syncScaleCtrl(); }

    this._stepSimulation(0);
    const start = this.system.byKey[q.get('focus')] || this.system.byKey.earth;
    const e = this.system.byKey.earth.scenePos;
    this.cam.pos = [e[0] * 0.2, AU_KM * 1.6, e[2] * 0.2 + AU_KM * 1.2];
    this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(
      new THREE.Vector3(...this.cam.pos), new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 1, 0)));
    // ?cam=chase/cockpit launches the ship next to the focus body, so skip the opening flight then.
    if (q.get('instant') != null || q.get('cam')) this.cam.flyTo(start, { instant: true });
    else this.cam.flyTo(start);
    // ?surface=<body key>[&lat=..&lon=..&az=..&alt=..] stands on a body; ?cam=chase|cockpit starts in the ship.
    if (q.get('surface') && this.system.byKey[q.get('surface')]) {
      const n = (k) => (q.get(k) != null && isFinite(+q.get(k)) ? +q.get(k) : undefined);
      this.enterSurface(this.system.byKey[q.get('surface')], { lat: n('lat'), lon: n('lon'), az: n('az'), alt: n('alt') });
    } else if (q.get('cam') === 'chase') this.setCameraMode(3);
    else if (q.get('cam') === 'cockpit') this.setCameraMode(4);
    this.ui.syncMode(this.cam.mode);
    this._bindDrop();

    window.addEventListener('resize', () => this._resize());
    this._last = performance.now();
    this.renderer.setAnimationLoop(() => this._frame());
    window.app = this;
    this.dataReady = this._loadData();
  }

  /** Load /data/ (written by fetch-data.mjs). Without it the app runs with planets and moons only. */
  async _loadData() {
    this.data = await new DataStore('./data/').load();
    // Named asteroids and dwarf planets become full bodies (meshes, focusable); the rest are GPU points.
    const { defs, promoted } = buildMinorBodyDefs(this.data);
    const comets = buildCometDefs(this.data);                 // notable comets + interstellar objects
    for (const p of comets.promoted) promoted.add(p);
    const craft = buildSpacecraftDefs(this.data, this.system);      // Horizons-tracked spacecraft as full bodies
    for (const id of craft.trackIds) promoted.add('track:' + id);
    const added = this.system.addBodies([...defs, ...comets.defs, ...craft.defs]);
    // Palette-textured models: mark them so the procedural-texture pump never replaces (and disposes) the shared palette.
    for (const b of added) if (b.minorType === 'spacecraft') { this.system._setMap(b, paletteTexture()); b.textureState = 'palette'; b.flatTex = null; }
    this._stepSimulation(0);
    this.ui.addBodies(added);
    this.smallBodies = new SmallBodyLayer(this.scene, this.data, promoted);
    // Spacecraft/NEOs near Earth or Jupiter stay outside the enlarged planet discs in visual scale.
    this.smallBodies.mapHelio = (h, out) => this.system.mapHelioToScene(h, 0.01, this.scale, out);
    this.oort = new OortCloud(this.scene);
    this.cometFx = new CometVisuals(this.scene, this.system, this.data);
    this.showers = new MeteorShowers(this.scene, this.data);
    this.craftTrails = new SpacecraftTrails(this.scene, this.system);
    // ?focus=<key> for bodies that only exist once the data is loaded (e.g. focus=bennu).
    const q = new URLSearchParams(location.search), fk = q.get('focus');
    if (fk && added.some((b) => b.key === fk)) {
      this.system.selected = this.system.byKey[fk];
      this.cam.flyTo(this.system.byKey[fk], { instant: q.get('instant') != null });
    }
    this.applyQuality(this.quality, { effects: false });           // pixel ratio + small-body draw limit for the new layer
    this.smallBodies.showLabels = true;
    this.ui.onDataLoaded(this.data, this.smallBodies);
    if (!this.data.available) this.ui.toast('No /data/ folder found — showing planets and moons only. Run "node fetch-data.mjs" (see README).', 9000);
    else if (this.data.stale) this.ui.toast(`Small-body data is ${Math.floor(this.data.ageDays)} days old — re-run "node fetch-data.mjs" to update.`, 9000);
    if (this.data.errors.length) console.warn('[data] some files failed to load:', this.data.errors);
    return this.data;
  }

  /** Camera position in TRUE heliocentric km (three.js axes), inverting the visual radial compression. */
  cameraTrueHelio() {
    const p = this.cam.pos, r = Math.hypot(...p);
    if (r < 1) return [0, 0, 0];
    const f = this.cameraTrueSunDistance() / r;
    return [p[0] * f, p[1] * f, p[2] * f];
  }

  _stepSimulation(dt) {
    this.clock.tick(dt);
    const jdUTC = this.clock.jdUTC, jdTDB = utcToTDB(jdUTC);
    computeSystemState(jdTDB, this.state);
    computeMoonStates(jdTDB, this.state);
    this.scale.update(dt);
    this.system.update(this.state, jdTDB, jdUTC, this.scale);
  }

  _frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this._last) / 1000);
    this._last = now;
    this.time += dt;
    this._stepSimulation(dt);
    // The ship is stepped before the camera (chase/cockpit read its new pose); while piloted the
    // camera controller steps it with the keyboard/mouse input, otherwise it drifts parked.
    if (!this.cam.piloting) this.ship.update(dt, null);
    this.cam.update(dt);
    const w = window.innerWidth, h = window.innerHeight;
    this.system.syncToCamera(this.cam.pos, this.camera, w, h, this.time);
    this.ship.sync(this.cam.pos, this.camera, this.post.exposure, w, h, this.time);
    this.smallBodies?.update(utcToTDB(this.clock.jdUTC), this.state, this.scale, this.cam.pos, this.cameraTrueHelio(),
      this.camera, this.post.exposure, w, h);
    if (this.oort) this.oortFade = this.oort.update(this.scale, this.cam.pos, this.post.exposure, this.cameraTrueSunDistance() / AU_KM);
    const jdT = utcToTDB(this.clock.jdUTC);
    this.cometFx?.update(jdT, this.state, this.scale, this.cam.pos, this.camera, this.post.exposure, this.time);
    this.showers?.update(jdT, this.state, this.scale, this.cam.pos, this.system.byKey.earth, this.post.exposure, dt, this.system);
    this.craftTrails?.update(jdT, this.scale, this.cam.pos, 1 / this.post.exposure);
    this.system.pumpProceduralTextures();
    this.photoTex.update(now);
    this._adaptExposure(dt, w, h);
    this._applyVisibility();
    this.photo.update(this.system.bodies, this.observerTrueHelio(), this.cam.pos, this.post.exposure, 1 - 0.995 * (this._skyDay || 0));
    this.events.update(jdT, this.sensor);
    this.sensor.update(this.system.bodies, this.camera, this.cam.pos, w, h, this.system.selected);
    this.post.updateFlare(this.system.byKey.sun, this.system.bodies, this.time);
    this.post.render(dt, this.time);
    this.ui.update(dt);
  }

  /**
   * Observer's TRUE heliocentric ecliptic position (km). Near a body (surface view, orbiting a planet) the
   * offset from that body is converted with its radius scale; far away the radial compression is inverted.
   */
  observerTrueHelio() {
    const n = nearestSurface(this.system.bodies, this.cam.pos), b = n.body;
    if (b && b.kind !== 'sun' && n.dist < 50 * b.rScene) {
      const k = b.radius / b.rScene, d = this.cam.pos.map((v, i) => (v - b.scenePos[i]) * k);   // three axes
      return [b.helio[0] + d[0], b.helio[1] - d[2], b.helio[2] + d[1]];                         // -> ecliptic (x, -z, y)
    }
    const t = this.cameraTrueHelio();
    return [t[0], -t[2], t[1]];
  }

  /** Camera's TRUE distance from the Sun (km), inverting the visual distance compression. */
  cameraTrueSunDistance() {
    const r = Math.hypot(...this.cam.pos);
    return AU_KM * Math.pow(Math.max(r, 1) / AU_KM, 1 / this.scale.p);
  }

  _adaptExposure(dt, w, h) {
    const sys = this.system;
    let target;
    // The ship counts toward eye adaptation like a small body (not from the cockpit: you're inside it).
    const list = this.ship.proxy.screen.visible && this.cam.mode !== 'cockpit' ? [...sys.bodies, this.ship.proxy] : sys.bodies;
    if (this.autoExposure) target = this.post.estimateExposure(list, this.cam.pos, this.cameraTrueSunDistance(), w, h) * this.baseExposure;
    else target = this.baseExposure;
    // Standing on a surface the body is under the camera, not "on screen": add the sunlit ground and
    // (with an atmosphere) the daytime sky, so the eye stops down by day and the stars fade.
    // The sky dome and star fade always apply on a surface; only the exposure target needs eye adaptation.
    if (this.cam.mode === 'surface' && this.cam.surf?.basis) {
      const b = this.cam.surf.body, up = this.cam.surf.basis.up, sp = sys.byKey.sun.scenePos;
      const d = [sp[0] - this.cam.pos[0], sp[1] - this.cam.pos[1], sp[2] - this.cam.pos[2]], n = Math.hypot(...d);
      const sinAlt = (d[0] * up.x + d[1] * up.y + d[2] * up.z) / n;
      // Sunlight actually reaching the observer: eclipses by the body's moons (or its parent) dim the sky.
      const occ = sys.bodies.filter((o) => (o.parent === b.key && o.kind === 'moon') || o.key === b.parent).map((o) => ({ helio: o.helio, radius: o.radius, atmo: !!o.atmo }));
      this.observerSun = occ.length ? sunlightFactor(this.observerTrueHelio(), occ).visible : 1;
      const E = (AU_KM / Math.max(Math.hypot(...b.helio), 1e6)) ** 2 * this.observerSun;
      const day = Math.min(1, Math.max(0, (sinAlt + 0.1) / 0.25)) * Math.min(1, this.observerSun * 1.5);   // totality: night sky
      const SKY = { earth: 0.35, venus: 0.3, mars: 0.08, titan: 0.05, jupiter: 0.3, saturn: 0.3, uranus: 0.3, neptune: 0.3 };
      const L = E * (0.5 * (b.albedo ?? 0.3) * Math.max(0, sinAlt) + (SKY[b.atmo] ?? 0) * day);
      // Under a sunlit sky the scattered light, not the solar disc, sets adaptation (you can look at the
      // ground next to the Sun); in space / at night the regular estimate (incl. solar glare) stands.
      const atm = SKY[b.atmo] ? day : 0;
      const tSurf = (0.2 / (L + 1e-6)) * this.baseExposure;
      if (this.autoExposure) target = atm > 0 ? tSurf * atm + target * (1 - atm) : 0.2 / (0.2 / target + L * this.baseExposure);
      this._skyDay = atm;
      this.skyDome.set(b.atmo, new THREE.Vector3(d[0] / n, d[1] / n, d[2] / n), up, E);
    } else { this._skyDay = 0; this.skyDome.mesh.visible = false; this.observerSun = 1; }
    const exp = this.post.adapt(target, dt);
    // Exposure-compensated emitters: the Sun always reads as blinding, stars/Milky Way cap after exposure.
    // The Sun is blinding when small (post-exposure radiance 30 → saturated + bloom); as its disc fills the
    // view the eye stops down, so its displayed radiance eases toward ~1.4 and granulation/limb darkening show.
    const sun = sys.byKey.sun;
    const cov = Math.min(1, (Math.PI * sun.pixelRadius * sun.pixelRadius) / (w * h));
    const close = Math.min(1, Math.max(0, (cov - 0.001) / 0.08));
    this.sunCloseness = close * close * (3 - 2 * close);
    const post = 12 + (1.0 - 12) * this.sunCloseness;
    sun.material.uniforms.uGain.value = post / exp;
    sun.corona.material.uniforms.uGain.value = (1.2 - 0.9 * this.sunCloseness) / exp;
    this.post.flareScale = 1 - this.sunCloseness;
    this.stars.material.uniforms.uExposure.value = exp;
    this.milkyWay.material.uniforms.uExposure.value = exp;
    // A sunlit sky (surface view under an atmosphere) outshines the stars and the Milky Way.
    const fade = 1 - 0.995 * (this._skyDay || 0);
    this.stars.material.uniforms.uFade.value = fade;
    this.milkyWay.material.uniforms.uFade.value = fade;
    // Overlays (orbit lines, axes, markers) must look the same at any exposure: pre-divide by it.
    sys.setOverlayGain(1 / exp);
    // Near-zero ambient that stays near-zero after exposure: night sides are black.
    sys.ambientLevel = 0.0015 / exp;
  }

  /**
   * Every per-frame visibility rule in one place (user toggles, sensor overlay, surface view, daylight):
   *   markers         GUI "Body markers" AND sensor overlay on AND not a daylight sky
   *   small bodies    hidden from the ground; overview dots with the sensor on, magnitude-realistic with it off
   *   minor labels    only with the sensor overlay on (or the selected body)
   *   meteor streams  hidden from the ground (the meteors themselves show there)
   *   atmosphere      the shell of the body you stand on is replaced by the sky dome
   */
  _applyVisibility() {
    const sys = this.system, sensor = this.view.sensor;
    const surfBody = this.cam.mode === 'surface' ? this.cam.surf?.body : null;
    if (surfBody?.atmoMesh) surfBody.atmoMesh.visible = false;          // syncToCamera re-enables it each frame
    if (this.showers) this.showers.hideStreams = !!surfBody;
    if (this.craftTrails) this.craftTrails.hidden = !!surfBody;          // like orbit lines, trails clutter the sky from the ground
    sys.markers.visible = (this.ui.guiState?.markers ?? true) && sensor && (this._skyDay || 0) < 0.5;
    sys.show.minorLabels = sensor;
    this.sensor.enabled = sensor;
    const sb = this.smallBodies;
    if (sb) {
      const vis = !surfBody;                                             // not visible to the eye from the ground
      if (sb.points) sb.points.visible = vis;
      if (sb.cpuPoints) sb.cpuPoints.visible = vis;
      sb.settings.mode = sensor ? this.view.sbMode : 'realistic';
    }
  }

  /** Quality preset: pixel ratio, MSAA, small-body count and a few effects. Persisted per browser. */
  applyQuality(name, { effects = true } = {}) {
    const q = QUALITY[name];
    if (!q) return;
    this.quality = name;
    const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.post.setSamples(q.samples);
    this.post.setSize(window.innerWidth, window.innerHeight);
    this.stars.material.uniforms.uPixelRatio.value = pr;
    this.photo.material.uniforms.uPixelRatio.value = pr;
    if (this.smallBodies?.material) this.smallBodies.material.uniforms.uPixelRatio.value = pr;
    if (this.smallBodies?.cpuMaterial) this.smallBodies.cpuMaterial.uniforms.uPixelRatio.value = pr;
    if (this.smallBodies?.points) this.smallBodies.points.geometry.setDrawRange(0, Math.min(this.smallBodies.count, q.smallBodies));
    if (effects) { this.post.settings.flare = q.flare; this.post.settings.grain = q.grain; }
    this.photoTex.setMaxSize(q.texture);
    try { localStorage.setItem('sol.quality', name); } catch { /* storage blocked */ }
    this.ui.syncQuality?.();
  }

  _resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.post.setSize(window.innerWidth, window.innerHeight);
  }

  // --- actions used by UI -------------------------------------------------------
  focus(body) { this.system.selected = body; this.cam.flyTo(body); }

  setCameraMode(n) {
    if (n === 1) this.cam.setMode('free');
    else if (n === 2) this.cam.setMode('orbit');
    else {
      const first = !this.ship.spawned;
      this.cam.setMode(n === 3 ? 'chase' : 'cockpit');
      if (first) this.ui.toast('Ship launched ahead of the camera — click to steer with the mouse (Esc releases), W to thrust, Shift boost', 6000);
    }
  }

  /** Stand on a body's surface (true scale: in visual scale radii ×200 and compressed distances make the sky meaningless). */
  enterSurface(body, opts = {}) {
    if (!body || body.kind === 'sun') { this.ui.toast('Pick a planet, moon or small body to stand on (not the Sun)'); return; }
    if (this.scale.mode !== 'true') { this.setScaleMode('true'); }
    this.system.selected = body;
    this.cam.setMode('surface', { body, ...opts });
    this.ui.toast(`Standing on ${body.name} — drag or arrows to look, WASD walk, wheel zoom, G or 2 to leave`, 6000);
  }

  /** Orbit lines drawn from the ground cut across the whole sky: hide them on a surface, restore after. */
  _surfaceOverlays(on) {
    const sys = this.system;
    if (on && !this._savedOverlays) {
      this._savedOverlays = { orbits: sys.show.orbits, moonOrbits: sys.show.moonOrbits, minorOrbits: sys.show.minorOrbits };
      sys.setVisibility({ orbits: false, moonOrbits: false, minorOrbits: false });
    } else if (!on && this._savedOverlays) {
      sys.setVisibility(this._savedOverlays);
      this._savedOverlays = null;
    }
  }

  /** Jump straight to true scale (event jumps aim at planets: the visual compression would bend directions). */
  snapTrueScale() {
    if (this.scale.mode === 'true' && !this.scale.transitioning) return;
    this.scale.snap('true');
    this.ui.syncScaleCtrl();
    this._stepSimulation(0);
  }

  leaveSurface() {
    const b = this.cam.surf?.body;
    this.cam.target = b || this.cam.target;
    this.cam.setMode('orbit');
  }

  /** Drag a .glb (or a .gltf + its .bin/textures) anywhere onto the page to fly it. */
  _bindDrop() {
    const stop = (e) => { e.preventDefault(); e.stopPropagation(); };
    let depth = 0;
    window.addEventListener('dragenter', (e) => { stop(e); if (++depth === 1) document.body.classList.add('dropping'); });
    window.addEventListener('dragleave', (e) => { stop(e); if (--depth <= 0) { depth = 0; document.body.classList.remove('dropping'); } });
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', async (e) => {
      stop(e); depth = 0; document.body.classList.remove('dropping');
      const files = e.dataTransfer?.files;
      if (!files || !files.length) return;
      await this.loadShipFiles(files);
    });
  }

  async loadShipFiles(files) {
    try {
      const { dims } = await this.ship.loadFiles(files);
      this.ui.toast(`Ship model loaded: ${this.ship.modelName} (${dims.length.toPrecision(3)} × ${dims.width.toPrecision(3)} × ${dims.height.toPrecision(3)} model units → ${this.ship.lengthM} m long)`, 6000);
      if (!this.cam.piloting) this.setCameraMode(3);
      this.ui.syncShip?.();
      return true;
    } catch (err) {
      console.error(err);
      this.ui.toast(`Could not load the model: ${err.message}`, 8000);
      return false;
    }
  }

  async loadShipURL(url) {
    try {
      const { dims } = await this.ship.loadURL(url);
      this.ui.toast(`Ship model loaded from URL (${dims.length.toPrecision(3)} model units → ${this.ship.lengthM} m long)`, 5000);
      if (!this.cam.piloting) this.setCameraMode(3);
      this.ui.syncShip?.();
      return true;
    } catch (err) {
      console.error(err);
      this.ui.toast(`Could not load ${url}: ${err.message || err} (remote URLs must allow CORS; files inside the project folder always work)`, 9000);
      return false;
    }
  }

  setScaleMode(mode) {
    if (mode === 'visual' && this.cam.mode === 'surface') { this.ui.toast('Surface view needs true scale — leave the surface first (G or 2)'); this.ui.syncScaleCtrl(); return; }
    this.scale.setMode(mode);
    this.ui.syncScaleCtrl();
    this.ui.toast(mode === 'visual' ? 'Visual scale: radii exaggerated, distances compressed (eclipse geometry rescaled)' : 'True scale: real radii and distances (km) — eclipses exact');
  }
}

try {
  new App();
} catch (err) {
  console.error(err);
  const el = document.getElementById('fatal');
  el.textContent = 'Failed to start: ' + err.message + ' — WebGL2 is required.';
  el.style.display = 'block';
}
