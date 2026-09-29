// =============================================================================
// camera.js — CameraController: FREE FLIGHT (6-DOF), ORBIT/FOCUS, eased cinematic
// FLY-TO, SHIP CHASE (spring arm), COCKPIT, and SURFACE VIEW. The three.js camera
// itself never moves from the origin (floating origin); this class owns the
// float64 camera position `pos` in scene units and the camera orientation.
//
// Free flight and the ship live in a co-moving reference-body frame (refframe.js),
// so time-lapse orbital motion never flings the viewer away from a planet.
// =============================================================================
import * as THREE from 'three';
import { RefFrame, nearestSurface } from './refframe.js';
import { bodyQuaternion } from './bodies.js';

const easeInOut = (u) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const UP = new THREE.Vector3(0, 1, 0);
const SHIP_MODES = new Set(['chase', 'cockpit']);
const DEG = Math.PI / 180;

export class CameraController {
  constructor(camera, dom, system) {
    this.camera = camera;
    this.dom = dom;
    this.system = system;
    this.pos = [0, 0, 0];                 // float64 scene position
    this.mode = 'orbit';                  // 'free' | 'orbit' | 'fly' | 'chase' | 'cockpit' | 'surface'
    this.target = null;                   // Body
    this.orbit = { az: 0.6, el: 0.25, k: 4 };   // k = distance in target radii
    this.vel = [0, 0, 0];                 // free-flight velocity relative to the reference body (scene u/s)
    this.frame = new RefFrame();          // free-flight co-moving frame
    this.speedMul = 1;
    this.keys = new Set();
    this.speed = 0;                       // reported speed (scene units / s)
    this.speedRef = null;                 // body the speed is measured against
    this.ship = null;                     // ShipController (set by the app)
    this.baseFov = camera.fov;            // FOV outside chase/surface (Settings → Field of view)
    this.surf = null;                     // surface-view state
    this._lookAcc = { dx: 0, dy: 0 };     // pointer deltas for ship steering
    this._chaseOff = null;                // spring-arm offset (camera − ship), scene units
    this._chaseVel = [0, 0, 0];
    this._prevRel = null;
    this.onModeChange = null;
    this.onPick = null;
    this._bindInput();
  }

  get piloting() { return SHIP_MODES.has(this.mode); }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  _bindInput() {
    const dom = this.dom;
    let down = null;
    dom.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      down = { moved: 0 };
      if (this.mode !== 'free' && document.pointerLockElement !== dom) dom.setPointerCapture(e.pointerId);
    });
    dom.addEventListener('pointermove', (e) => {
      const locked = document.pointerLockElement === dom;
      if (locked || down) {
        if (down) down.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
        if (this.mode === 'free' && locked) this._look(e.movementX, e.movementY);
        else if (this.piloting) { this._lookAcc.dx += e.movementX; this._lookAcc.dy += e.movementY; }
        else if (this.mode === 'surface') this._surfaceLook(e.movementX, e.movementY);
        else if (this.mode === 'orbit' && down) {
          this.orbit.az -= e.movementX * 0.005;
          this.orbit.el = Math.max(-1.55, Math.min(1.55, this.orbit.el + e.movementY * 0.005));
        }
      }
    });
    dom.addEventListener('pointerup', (e) => {
      if (!down) return;
      const click = down.moved < 5;
      down = null;
      if (!click) return;
      // Free flight and the ship modes steer with the mouse: a click captures it (Esc releases).
      if (this.mode === 'free' || this.piloting) {
        // Some embedded browsers refuse mouse capture (the request rejects): steering by dragging still works.
        const p = dom.requestPointerLock?.();
        p?.catch?.(() => { if (!this._lockWarned) { this._lockWarned = true; this.onNotice?.('Mouse capture isn’t available in this browser view — drag with the mouse to steer instead'); } });
        return;
      }
      if (this.mode === 'surface') return;
      const rect = dom.getBoundingClientRect();
      const b = this.system.pick(e.clientX - rect.left, e.clientY - rect.top);
      // A satellite dot in front of the picked body (e.g. over Earth's disc) wins.
      if (this.onPickSatellite?.(e.clientX - rect.left, e.clientY - rect.top, b)) return;
      if (b) this.onPick?.(b);
    });
    dom.addEventListener('wheel', (e) => {
      e.preventDefault();
      const f = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 200) * 0.0015);
      if (this.mode === 'orbit') this.orbit.k = Math.max(this._minK(), Math.min(5e7, this.orbit.k * f));
      else if (this.mode === 'free') this.speedMul = Math.max(1e-3, Math.min(1e3, this.speedMul / f));
      else if (this.piloting && this.ship) this.ship.speedMul = Math.max(1e-3, Math.min(1e3, this.ship.speedMul / f));
      else if (this.mode === 'surface') { this.surf.fov = Math.max(1, Math.min(100, this.surf.fov * f)); }   // binocular zoom
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
    // Ctrl (descend) + W (thrust) = the browser's close-tab shortcut; ask before leaving mid-flight.
    window.addEventListener('beforeunload', (e) => { if (this.mode === 'free' || this.piloting) { e.preventDefault(); e.returnValue = ''; } });
  }

  _look(dx, dy) {
    const s = 0.0022 * (this.camera.fov / 60);
    const q = this.camera.quaternion;
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -dx * s));
    q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -dy * s));
    q.normalize();
  }

  _minK() {
    if (!this.target) return 1.05;
    // Keep the near surface beyond the near plane: at least 1.02 R or a few metres.
    return Math.max(1.02, 1 + (this.camera.near * 20) / this.target.rScene);
  }

  _setFov(f) {
    if (Math.abs(this.camera.fov - f) < 1e-4) return;
    this.camera.fov = f;
    this.camera.updateProjectionMatrix();
  }

  // ---------------------------------------------------------------------------
  // Modes
  // ---------------------------------------------------------------------------
  setMode(mode, opts = {}) {
    if (mode === this.mode && mode !== 'surface') return;
    const prev = this.mode;
    if (mode !== 'free' && mode !== 'surface' && !SHIP_MODES.has(mode) && document.pointerLockElement) document.exitPointerLock();
    if (mode === 'free') {
      this.vel = [0, 0, 0];
      this.frame.attach(nearestSurface(this.system.bodies, this.pos).body, this.pos);
      this.mode = 'free';
    } else if (mode === 'orbit') {
      if (!this.target || this.target.kind === 'ship') this.target = this.nearestBody();
      this._orbitFromCurrent();
      this.mode = 'orbit';
    } else if (SHIP_MODES.has(mode)) {
      const s = this.ship;
      if (!s.spawned) s.spawnAt(this.pos, this.camera.quaternion);
      const d = Math.hypot(this.pos[0] - s.pos[0], this.pos[1] - s.pos[1], this.pos[2] - s.pos[2]);
      // Parked far away: fly there cinematically first, then take over.
      if (d > s.L * s.chase.arm * 40 && prev !== 'fly') { this.flyTo(s.target, { then: mode }); return; }
      this._chaseOff = [this.pos[0] - s.pos[0], this.pos[1] - s.pos[1], this.pos[2] - s.pos[2]];
      this._chaseVel = [0, 0, 0];
      this.mode = mode;
    } else if (mode === 'surface') {
      this._enterSurface(opts);
      this.mode = 'surface';
    }
    if (prev === 'chase' || prev === 'surface') this._setFov(this.baseFov);
    this.onModeChange?.(this.mode);
  }

  /** Derive orbit az/el/k from the current camera position so switching doesn't jump. */
  _orbitFromCurrent() {
    const t = this.target.scenePos;
    const d = [this.pos[0] - t[0], this.pos[1] - t[1], this.pos[2] - t[2]];
    const r = Math.hypot(...d) || this.target.rScene * 4;
    this.orbit.k = Math.max(this._minK(), r / this.target.rScene);
    this.orbit.el = Math.asin(Math.max(-1, Math.min(1, d[1] / r)));
    this.orbit.az = Math.atan2(d[0], d[2]);
  }

  /** Smooth cinematic flight to a body (or the ship), then orbit it — or switch to `then`. */
  flyTo(body, { instant = false, then = null } = {}) {
    if (document.pointerLockElement) document.exitPointerLock();
    if (this.mode === 'surface' || this.mode === 'chase') this._setFov(this.baseFov);
    const T = body.scenePos;
    // End view: three-quarter lit, rotated ~40° from the sub-solar direction, slightly above.
    const sun = this.system.byKey.sun.scenePos;
    let az, el = 0.22;
    if (body.kind === 'sun') {
      const d = [this.pos[0] - T[0], this.pos[2] - T[2]];
      az = Math.atan2(d[0], d[1]);
    } else {
      az = Math.atan2(sun[0] - T[0], sun[2] - T[2]) + 0.75;
    }
    const k1 = body.kind === 'sun' ? 5 : body.kind === 'moon' ? 5 : body.kind === 'ship' ? 7 : 3.6;
    const dir1 = new THREE.Vector3(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az));
    this.target = body;
    if (instant) {
      this.orbit = { az, el, k: k1 };
      this.mode = 'orbit';
      this._applyOrbit();
      this.onModeChange?.(this.mode);
      if (then) this.setMode(then);
      return;
    }
    const rel = new THREE.Vector3(this.pos[0] - T[0], this.pos[1] - T[1], this.pos[2] - T[2]);
    let d0 = rel.length();
    if (d0 < 1e-6) { rel.copy(dir1); d0 = body.rScene * 10; }
    const dir0 = rel.clone().normalize();
    const ratio = Math.abs(Math.log(d0 / (k1 * body.rScene)));
    this.fly = {
      body, t: 0, dur: Math.min(8, Math.max(2.5, 1.6 + ratio * 0.35)),
      dir0, dir1, d0, k1, q0: this.camera.quaternion.clone(),
      qDir: new THREE.Quaternion().setFromUnitVectors(dir0, dir1),
      az, el, then,
    };
    this.mode = 'fly';
    this.onModeChange?.(this.mode);
  }

  nearestBody() { return nearestSurface(this.system.bodies, this.pos).body; }

  /** Distance from the camera to the nearest body surface (scene units) + that body. */
  nearestSurface() { return nearestSurface(this.system.bodies, this.pos); }

  // ---------------------------------------------------------------------------
  // Per-frame update (call AFTER bodies have their new scenePos/eclMatrix for this frame)
  // ---------------------------------------------------------------------------
  update(dt) {
    if (this.mode === 'fly') this._updateFly(dt);
    else if (this.mode === 'orbit') this._updateOrbit(dt);
    else if (this.mode === 'free') this._updateFree(dt);
    else if (this.mode === 'chase') this._updateChase(dt);
    else if (this.mode === 'cockpit') this._updateCockpit(dt);
    else if (this.mode === 'surface') this._updateSurface(dt);
    // Surface view stands ON the ground (its own eye-height rule); every other mode keeps clear of it.
    if (this.mode !== 'surface') this._collide();
    if (this.mode === 'free') { this.frame.set(this.pos); this.frame.rebase(this.system.bodies, this.pos); }
    this._measureSpeed(dt);
    this.camera.updateMatrixWorld(true);
  }

  _applyOrbit() {
    const t = this.target.scenePos, o = this.orbit;
    o.k = Math.max(this._minK(), o.k);
    const r = o.k * this.target.rScene;
    const off = [Math.cos(o.el) * Math.sin(o.az) * r, Math.sin(o.el) * r, Math.cos(o.el) * Math.cos(o.az) * r];
    this.pos[0] = t[0] + off[0]; this.pos[1] = t[1] + off[1]; this.pos[2] = t[2] + off[2];
    this._lookAtOffset(off);
  }

  _lookAtOffset(off) {
    // Camera at `off` relative to the target, looking at it, world up = ecliptic north.
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(off[0], off[1], off[2]), new THREE.Vector3(0, 0, 0), UP);
    this.camera.quaternion.setFromRotationMatrix(m);
  }

  _updateOrbit(dt) {
    // Keyboard orbiting too (arrows / WASD) for trackpads.
    const k = this.keys, rs = 1.2 * dt;
    if (k.has('ArrowLeft') || k.has('KeyA')) this.orbit.az -= rs;
    if (k.has('ArrowRight') || k.has('KeyD')) this.orbit.az += rs;
    if (k.has('ArrowUp') || k.has('KeyW')) this.orbit.k = Math.max(this._minK(), this.orbit.k * Math.exp(-dt * 1.2));
    if (k.has('ArrowDown') || k.has('KeyS')) this.orbit.k = Math.min(5e7, this.orbit.k * Math.exp(dt * 1.2));
    this._applyOrbit();
  }

  _updateFly(dt) {
    const f = this.fly;
    f.t += dt;
    const u = Math.min(1, f.t / f.dur), e = easeInOut(u);
    const T = f.body.scenePos;
    const d1 = f.k1 * f.body.rScene;
    const dist = Math.exp(Math.log(f.d0) + (Math.log(d1) - Math.log(f.d0)) * e);   // log-distance: cinematic zoom
    const q = new THREE.Quaternion().slerp(f.qDir, e);                              // identity → qDir
    const dir = f.dir0.clone().applyQuaternion(q);
    const off = [dir.x * dist, dir.y * dist, dir.z * dist];
    this.pos[0] = T[0] + off[0]; this.pos[1] = T[1] + off[1]; this.pos[2] = T[2] + off[2];
    const look = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(...off), new THREE.Vector3(), UP));
    const w = Math.min(1, u / 0.35);
    this.camera.quaternion.copy(f.q0).slerp(look, w * w * (3 - 2 * w));
    if (u >= 1) {
      this.orbit = { az: f.az, el: f.el, k: f.k1 };
      this.fly = null;
      this.mode = 'orbit';
      if (f.then) { this.setMode(f.then); return; }
      this.onModeChange?.(this.mode);
    }
  }

  _updateFree(dt) {
    const k = this.keys;
    const q = this.camera.quaternion;
    this.frame.resolve(this.pos, this.vel);        // ride along with the reference body
    // Roll
    const roll = (k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0);
    if (roll) { q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll * dt * 1.2)); q.normalize(); }
    // Arrow keys look (no pointer lock needed)
    const lx = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const ly = (k.has('ArrowDown') ? 1 : 0) - (k.has('ArrowUp') ? 1 : 0);
    if (lx || ly) this._look(lx * dt * 500, ly * dt * 500);

    const inp = new THREE.Vector3(
      (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
      // Ctrl = down per spec; C is an alternative because browsers reserve Ctrl+W (close tab).
      (k.has('Space') ? 1 : 0) - (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC') ? 1 : 0),
      (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0));
    if (inp.lengthSq() > 0) inp.normalize();
    inp.applyQuaternion(q);
    // Speed auto-scales with distance to the nearest surface: slow near a moon, fast between planets.
    const ns = this.nearestSurface();
    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 6 : 1;
    const maxSpeed = Math.max(ns.dist, 0.01) * 0.6 * this.speedMul * boost;
    this.maxSpeed = maxSpeed;
    const a = 1 - Math.exp(-dt * 3.0);           // inertia + damping
    for (let i = 0; i < 3; i++) this.vel[i] += (inp.getComponent(i) * maxSpeed - this.vel[i]) * a;
    // Never carry more speed than the local limit (prevents overshooting into a body).
    const sp = Math.hypot(...this.vel);
    if (sp > maxSpeed) for (let i = 0; i < 3; i++) this.vel[i] *= maxSpeed / sp;
    for (let i = 0; i < 3; i++) this.pos[i] += this.vel[i] * dt;
  }

  // --- ship modes ---------------------------------------------------------------
  _pilot(dt) {
    const s = this.ship;
    s.update(dt, { keys: this.keys, look: this._lookAcc });
    this._lookAcc.dx = 0; this._lookAcc.dy = 0;
    return s;
  }

  /** Third-person chase: a critically damped spring on the camera's OFFSET from the ship (the lag is
   *  relative to the ship, never to the orbital motion), look-ahead framing, speed-based FOV. */
  _updateChase(dt) {
    const s = this._pilot(dt), L = s.L, q = s.quat;
    const want = new THREE.Vector3(0, s.chase.height * L, s.chase.arm * L).applyQuaternion(q);
    const w = 6.5, off = this._chaseOff || [want.x, want.y, want.z];
    for (let i = 0; i < 3; i++) {
      const acc = w * w * (want.getComponent(i) - off[i]) - 2 * w * this._chaseVel[i];
      this._chaseVel[i] += acc * Math.min(dt, 0.05);
      off[i] += this._chaseVel[i] * Math.min(dt, 0.05);
    }
    // Keep the arm between 0.6 and 40 ship lengths (e.g. right after a ship-length change).
    const len = Math.hypot(...off), lo = 0.6 * L, hi = 40 * L;
    if (len < lo || len > hi) { const f = Math.min(hi, Math.max(lo, len)) / Math.max(len, 1e-12); for (let i = 0; i < 3; i++) off[i] *= f; }
    this._chaseOff = off;
    for (let i = 0; i < 3; i++) this.pos[i] = s.pos[i] + off[i];
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    const aim = new THREE.Vector3(0, s.chase.height * L * 0.55, -1.6 * L).applyQuaternion(q);
    const look = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().lookAt(new THREE.Vector3(...off), aim, up));
    this.camera.quaternion.slerp(look, 1 - Math.exp(-dt * 9));
    // Velocity-based FOV widening (speed as a fraction of the local maximum, not absolute km/s).
    const frac = Math.min(1, s.speed / Math.max(s.maxSpeed, 1e-12));
    const fov = this.baseFov + 18 * frac * frac;
    this._setFov(this.camera.fov + (fov - this.camera.fov) * (1 - Math.exp(-dt * 3)));
  }

  _updateCockpit(dt) {
    const s = this._pilot(dt), L = s.L, q = s.quat;
    const c = s.cockpit.clone().multiplyScalar(L).applyQuaternion(q);
    for (let i = 0; i < 3; i++) this.pos[i] = s.pos[i] + c.getComponent(i);
    this.camera.quaternion.copy(q);
  }

  // --- surface view -------------------------------------------------------------
  /**
   * Stand on `body` at planetocentric lat/lon (deg, east-positive) looking at azimuth `az` (from north
   * through east) and altitude `alt`. Omitted values get a sensible default: on a moon, near the
   * limb of the parent-facing hemisphere looking at the parent; elsewhere 40° N at 02:00 local time
   * looking north-east (a good meteor-watching sky).
   */
  _enterSurface({ body, lat, lon, az, alt }) {
    const q = bodyQuaternion(body), qi = q.clone().invert();
    const toLocal = (p) => new THREE.Vector3(p[0] - body.scenePos[0], p[1] - body.scenePos[1], p[2] - body.scenePos[2]).applyQuaternion(qi).normalize();
    const latLon = (v) => [Math.asin(Math.max(-1, Math.min(1, v.y))) / DEG, Math.atan2(-v.z, v.x) / DEG];
    const parent = body.parent && body.parent !== 'sun' ? this.system.byKey[body.parent] : null;
    let look = null;
    if (lat == null || lon == null) {
      if (parent) {
        const [pl, po] = latLon(toLocal(parent.scenePos));
        lat = pl; lon = po + 78;                    // parent ~12° above the western horizon
        look = parent;
      } else {
        const [, so] = latLon(toLocal(this.system.byKey.sun.scenePos));
        if (body.atmo && body.key !== 'earth') {    // show off the daytime sky: 10:00 local, looking west
          lat = 20; lon = so - 30; az = az ?? 270; alt = alt ?? 12;
        } else { lat = 40; lon = so - 150; }        // 02:00 local solar time (Earth: meteor-watching sky)
      }
    }
    this.surf = { body, lat, lon: ((lon + 540) % 360) - 180, az: az ?? 45, alt: alt ?? 35, fov: this.baseFov, geo: null, rGeo: 1, rKey: '' };
    if (look) {
      this._placeSurface();                          // establishes the local horizon frame
      const d = new THREE.Vector3(look.scenePos[0] - this.pos[0], look.scenePos[1] - this.pos[1], look.scenePos[2] - this.pos[2]).normalize();
      const { up, north, east } = this.surf.basis;
      this.surf.alt = Math.asin(Math.max(-1, Math.min(1, d.dot(up)))) / DEG + 4;
      this.surf.az = Math.atan2(d.dot(east), d.dot(north)) / DEG;
    }
  }

  /** Surface view: point the view at a scene position (e.g. the Sun during an eclipse). */
  aimSurfaceAt(p, altOffset = 0) {
    if (this.mode !== 'surface' || !this.surf) return;
    this._placeSurface();
    const d = new THREE.Vector3(p[0] - this.pos[0], p[1] - this.pos[1], p[2] - this.pos[2]).normalize();
    const { up, north, east } = this.surf.basis;
    this.surf.alt = Math.max(-89, Math.min(89, Math.asin(Math.max(-1, Math.min(1, d.dot(up)))) / DEG + altOffset));
    this.surf.az = Math.atan2(d.dot(east), d.dot(north)) / DEG;
  }

  _surfaceLook(dx, dy) {
    const s = 0.12 * (this.camera.fov / 60);
    this.surf.az += dx * s;
    this.surf.alt = Math.max(-89, Math.min(89, this.surf.alt - dy * s));
  }

  /** Ground radius along a mesh-local direction (geometry units), from the rendered triangles. */
  _groundRadius(b, dirGeo) {
    const geo = b.mesh.geometry;
    const key = `${geo.uuid}:${dirGeo.x.toFixed(6)},${dirGeo.y.toFixed(6)},${dirGeo.z.toFixed(6)}`;
    const S = this.surf;
    if (S.rKey === key) return S.rGeo;
    // Per-geometry cache of triangle-centroid directions: each query tests only the few triangles
    // whose centroid lies within ~3° of the ray, instead of all of them.
    if (!geo.userData.tri) {
      const P = geo.attributes.position, I = geo.index;
      const n = I ? I.count / 3 : P.count / 3, dirs = new Float32Array(n * 3);
      const a = new THREE.Vector3(), bb = new THREE.Vector3(), c = new THREE.Vector3();
      for (let t = 0; t < n; t++) {
        const i0 = I ? I.getX(t * 3) : t * 3, i1 = I ? I.getX(t * 3 + 1) : t * 3 + 1, i2 = I ? I.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(P, i0); bb.fromBufferAttribute(P, i1); c.fromBufferAttribute(P, i2);
        a.add(bb).add(c).normalize();
        dirs[t * 3] = a.x; dirs[t * 3 + 1] = a.y; dirs[t * 3 + 2] = a.z;
      }
      geo.userData.tri = dirs;
    }
    const dirs = geo.userData.tri, P = geo.attributes.position, I = geo.index;
    const ray = new THREE.Ray(new THREE.Vector3(), dirGeo), hit = new THREE.Vector3();
    const a = new THREE.Vector3(), bb = new THREE.Vector3(), c = new THREE.Vector3();
    let best = Infinity;
    for (let cone = 0.9986; best === Infinity && cone > 0.9; cone -= 0.02) {
      for (let t = 0; t < dirs.length / 3; t++) {
        if (dirs[t * 3] * dirGeo.x + dirs[t * 3 + 1] * dirGeo.y + dirs[t * 3 + 2] * dirGeo.z < cone) continue;
        const i0 = I ? I.getX(t * 3) : t * 3, i1 = I ? I.getX(t * 3 + 1) : t * 3 + 1, i2 = I ? I.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(P, i0); bb.fromBufferAttribute(P, i1); c.fromBufferAttribute(P, i2);
        if (ray.intersectTriangle(a, bb, c, false, hit)) best = Math.min(best, hit.length());
      }
    }
    if (best === Infinity) best = 1;
    S.rKey = key; S.rGeo = best;
    return best;
  }

  /** Put the eye on the ground at the current lat/lon; builds the local up/north/east basis. */
  _placeSurface() {
    const S = this.surf, b = S.body;
    const q = bodyQuaternion(b);
    const la = S.lat * DEG, lo = S.lon * DEG;
    const nLoc = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo));
    const sy = 1 - b.flat;
    const dirGeo = new THREE.Vector3(nLoc.x, nLoc.y / sy, nLoc.z).normalize();   // same direction in unscaled geometry
    const rg = this._groundRadius(b, dirGeo);
    const ground = dirGeo.clone().multiplyScalar(rg).multiply(new THREE.Vector3(b.rScene, b.rScene * sy, b.rScene)).applyQuaternion(q);
    const up = ground.clone().normalize();
    // Eye height: 2 m, raised on big bodies where float32 vertex precision (~R·1e-7) would shimmer.
    const km = b.rScene / b.radius;
    const h = Math.max(0.002, 2e-6 * b.radius) * km;
    for (let i = 0; i < 3; i++) this.pos[i] = b.scenePos[i] + ground.getComponent(i) + up.getComponent(i) * h;
    const pole = new THREE.Vector3(0, 1, 0).applyQuaternion(q);
    let north = pole.clone().addScaledVector(up, -pole.dot(up));
    if (north.lengthSq() < 1e-10) {                        // standing on a pole: any meridian is "north"
      const x = new THREE.Vector3(1, 0, 0).applyQuaternion(q);
      north = x.addScaledVector(up, -x.dot(up));
    }
    north.normalize();
    const east = new THREE.Vector3().crossVectors(north, up).normalize();
    S.basis = { up, north, east };
  }

  _updateSurface(dt) {
    const S = this.surf, k = this.keys;
    // Arrows look; WASD walk (a brisk "walk" scaled to the body so exploring stays practical).
    const lx = (k.has('ArrowRight') ? 1 : 0) - (k.has('ArrowLeft') ? 1 : 0);
    const ly = (k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0);
    if (lx) S.az += lx * dt * 45 * (this.camera.fov / 60);
    if (ly) S.alt = Math.max(-89, Math.min(89, S.alt + ly * dt * 45 * (this.camera.fov / 60)));
    const fw = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0), st = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    if (fw || st) {
      const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 10 : 1;
      const step = 0.12 * boost * dt;                     // degrees of arc per second
      const a = S.az * DEG;
      const dN = fw * Math.cos(a) - st * Math.sin(a), dE = fw * Math.sin(a) + st * Math.cos(a);
      S.lat = Math.max(-89.9, Math.min(89.9, S.lat + dN * step));
      S.lon += (dE * step) / Math.max(0.05, Math.cos(S.lat * DEG));
      S.lon = ((S.lon + 540) % 360) - 180;
    }
    this._placeSurface();
    const { up, north, east } = S.basis;
    const az = S.az * DEG, al = S.alt * DEG;
    const dir = north.clone().multiplyScalar(Math.cos(al) * Math.cos(az)).addScaledVector(east, Math.cos(al) * Math.sin(az)).addScaledVector(up, Math.sin(al));
    this.camera.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(new THREE.Vector3(), dir, up));
    this._setFov(S.fov);
  }

  /** The camera can never pass inside a body's surface. */
  _collide() {
    for (const b of this.system.bodies) {
      const d = [this.pos[0] - b.scenePos[0], this.pos[1] - b.scenePos[1], this.pos[2] - b.scenePos[2]];
      const r = Math.hypot(...d);
      const minR = b.rScene * (1 + 0.01 * b.flat) * 1.002 + this.camera.near * 10;
      if (r < minR && r > 0) {
        const f = minR / r;
        for (let i = 0; i < 3; i++) this.pos[i] = b.scenePos[i] + d[i] * f;
        if (this.mode === 'free') { // cancel the inward velocity component
          const n = d.map((x) => x / r), vn = this.vel[0] * n[0] + this.vel[1] * n[1] + this.vel[2] * n[2];
          if (vn < 0) for (let i = 0; i < 3; i++) this.vel[i] -= vn * n[i];
        }
      }
    }
  }

  _measureSpeed(dt) {
    // Ship modes: the ship's own speed relative to its reference body. Surface: standing still.
    if (this.piloting) { this.speed = this.ship.speed; this.speedRef = this.ship.frame.ref; this._prevRel = null; return; }
    if (this.mode === 'surface') { this.speed = 0; this.speedRef = this.surf.body; this._prevRel = null; return; }
    // Speed relative to the target (orbit/fly) or the reference body (free flight).
    const ref = this.mode === 'free' ? this.frame.ref : this.target;
    if (!ref || dt <= 0) return;
    const rel = [this.pos[0] - ref.scenePos[0], this.pos[1] - ref.scenePos[1], this.pos[2] - ref.scenePos[2]];
    if (this._prevRel && this.speedRef === ref) {
      const inst = Math.hypot(rel[0] - this._prevRel[0], rel[1] - this._prevRel[1], rel[2] - this._prevRel[2]) / dt;
      this.speed += (inst - this.speed) * Math.min(1, dt * 6);
    } else this.speed = 0;
    this._prevRel = rel;
    this.speedRef = ref;
  }
}
