// =============================================================================
// ship.js — ShipController: an attachable ship (procedural placeholder or any
// GLTF/GLB / Object3D), flight physics in a co-moving reference-body frame,
// thruster glow + particle exhaust, navigation lights, and Sun lighting with a
// shadow test against the nearest body.
//
// Conventions: the ship's forward is −Z (like a three.js camera), up is +Y, and the
// model is normalised to unit length; `lengthM` scales it (metres, real size in
// both scale modes — the ship is never exaggerated).
// =============================================================================
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AU_KM } from './ephemeris.js';
import { RefFrame, nearestSurface } from './refframe.js';

const R_SUN_KM = 695700;
const THREE_VER = '0.160.0';
const LOGDEPTH_V = '#include <common>\n#include <logdepthbuf_pars_vertex>';

// ---------------------------------------------------------------------------------------------
// Procedural placeholder ship (unit length, nose at z = −0.5)
// ---------------------------------------------------------------------------------------------
export function buildPlaceholderShip() {
  const root = new THREE.Group();
  root.name = 'placeholder-ship';
  const hullMat = new THREE.MeshStandardMaterial({ color: 0xc9ced6, metalness: 0.3, roughness: 0.45 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x3a3f48, metalness: 0.4, roughness: 0.55 });
  const accentMat = new THREE.MeshStandardMaterial({ color: 0xd9772b, metalness: 0.2, roughness: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x0d1a2a, metalness: 0.9, roughness: 0.08 });
  const wingMat = hullMat.clone(); wingMat.side = THREE.DoubleSide;

  // Hull: a lathe profile (radius, height) swept around Y, then laid along −Z and flattened a bit.
  const prof = [[0, -0.5], [0.07, -0.5], [0.085, -0.42], [0.09, -0.12], [0.08, 0.15], [0.056, 0.34], [0.026, 0.46], [0.004, 0.5]]
    .map(([r, y]) => new THREE.Vector2(r, y));
  const hullGeo = new THREE.LatheGeometry(prof, 40);
  hullGeo.rotateX(-Math.PI / 2);                 // +Y (nose) → −Z
  hullGeo.scale(1.25, 0.8, 1);
  root.add(new THREE.Mesh(hullGeo, hullMat));

  // Canopy
  const canopyGeo = new THREE.SphereGeometry(0.05, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2);
  canopyGeo.scale(0.8, 0.75, 1.9);
  const canopy = new THREE.Mesh(canopyGeo, glassMat);
  canopy.position.set(0, 0.05, -0.2);
  root.add(canopy);

  // Wings (shape in x/z, extruded thin along y)
  const wingShape = new THREE.Shape();
  wingShape.moveTo(0.07, -0.06); wingShape.lineTo(0.43, 0.2); wingShape.lineTo(0.43, 0.3); wingShape.lineTo(0.07, 0.32); wingShape.closePath();
  const wingGeo = new THREE.ExtrudeGeometry(wingShape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1 });
  wingGeo.rotateX(Math.PI / 2);                  // shape y → z, extrusion → −y
  wingGeo.translate(0, -0.005, 0);
  const wingR = new THREE.Mesh(wingGeo, wingMat);
  const wingL = new THREE.Mesh(wingGeo.clone().scale(-1, 1, 1), wingMat);
  root.add(wingR, wingL);
  // Wing stripes
  const stripeGeo = new THREE.BoxGeometry(0.2, 0.004, 0.025);
  for (const sx of [1, -1]) {
    const st = new THREE.Mesh(stripeGeo, accentMat);
    st.position.set(sx * 0.3, 0.008, 0.24); st.rotation.y = sx * -0.35;
    root.add(st);
  }

  // Tail fin (shape in z/y)
  const finShape = new THREE.Shape();
  finShape.moveTo(0.18, 0); finShape.lineTo(0.42, 0.17); finShape.lineTo(0.47, 0.17); finShape.lineTo(0.46, 0); finShape.closePath();
  const finGeo = new THREE.ExtrudeGeometry(finShape, { depth: 0.01, bevelEnabled: false });
  finGeo.rotateY(-Math.PI / 2);                  // shape x → z, extrusion → x
  finGeo.translate(-0.005, 0.04, 0);
  root.add(new THREE.Mesh(finGeo, wingMat));

  // Engine nacelles + nozzles + hot cores
  const engines = [];
  const nacGeo = new THREE.CylinderGeometry(0.036, 0.042, 0.3, 24); nacGeo.rotateX(Math.PI / 2);
  const nozGeo = new THREE.CylinderGeometry(0.031, 0.044, 0.05, 24, 1, true); nozGeo.rotateX(Math.PI / 2);
  for (const sx of [1, -1]) {
    const nac = new THREE.Mesh(nacGeo, darkMat); nac.position.set(sx * 0.13, -0.01, 0.3); root.add(nac);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.043, 0.043, 0.02, 24).rotateX(Math.PI / 2), accentMat);
    band.position.set(sx * 0.13, -0.01, 0.2); root.add(band);
    const noz = new THREE.Mesh(nozGeo, darkMat); noz.position.set(sx * 0.13, -0.01, 0.475); root.add(noz);
    engines.push({ pos: new THREE.Vector3(sx * 0.13, -0.01, 0.5), r: 0.032 });
  }
  // Navigation lights: red port (left, −x), green starboard (+x), white tail strobe.
  const lights = [
    { pos: new THREE.Vector3(-0.43, 0, 0.26), color: new THREE.Color(1, 0.08, 0.05) },
    { pos: new THREE.Vector3(0.43, 0, 0.26), color: new THREE.Color(0.1, 1, 0.25) },
    { pos: new THREE.Vector3(0, 0.21, 0.46), color: new THREE.Color(1, 1, 1), strobe: true },
  ];
  return { root, engines, lights, cockpit: new THREE.Vector3(0, 0.072, -0.2) };
}

// ---------------------------------------------------------------------------------------------
// Shaders: thruster glow billboard and exhaust particles (HDR, pre-divided by exposure)
// ---------------------------------------------------------------------------------------------
const GLOW_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uI: { value: 1 }, uColor: { value: new THREE.Color(0.55, 0.75, 1) } },
  vertexShader: `${LOGDEPTH_V}\nvarying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}`,
  fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float uI; uniform vec3 uColor; varying vec2 vUv;
void main(){\n#include <logdepthbuf_fragment>\n  float r = clamp(length(vUv - 0.5) * 2.0, 0.0, 1.0);
  float core = exp(-r * r * 40.0), halo = exp(-r * 6.0) * (1.0 - r);
  gl_FragColor = vec4((vec3(1.0) * core * 2.0 + uColor * halo) * uI, 1.0);
}`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

const EXHAUST_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uGain: { value: 1 }, uScale: { value: 500 }, uNear: { value: 0.05 } },
  vertexShader: `${LOGDEPTH_V}\nattribute float aT; attribute float aSize; uniform float uScale, uNear; varying float vT, vFade;
void main(){ vT = aT; vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFade = smoothstep(uNear * 0.5, uNear * 1.5, -mv.z);                  // sprites reaching the camera fade out
  gl_PointSize = aT < 0.0 ? 0.0 : clamp(aSize * uScale / max(-mv.z, 1e-6), 1.0, 48.0);
  gl_Position = projectionMatrix * mv;\n#include <logdepthbuf_vertex>\n}`,
  fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float uGain; varying float vT, vFade;
void main(){\n#include <logdepthbuf_fragment>\n  if (vT < 0.0) discard;
  float r = clamp(length(gl_PointCoord - 0.5) * 2.0, 0.0, 1.0);
  float t = clamp(vT, 0.0, 1.0);
  float a = exp(-r * r * 4.0) * (1.0 - r) * pow(1.0 - t, 1.5);
  vec3 col = mix(vec3(0.75, 0.88, 1.0), vec3(1.0, 0.45, 0.15), smoothstep(0.1, 0.8, t));
  gl_FragColor = vec4(col * a * vFade * uGain, 1.0);
}`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

/** Dispose every geometry/material/texture under `root`, skipping the subtree `keep` (if any). */
function disposeTree(root, keep) {
  const skip = new Set();
  keep?.traverse((o) => skip.add(o));
  root.traverse((o) => {
    if (skip.has(o) || !o.isMesh) return;
    o.geometry?.dispose();
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m) continue;
      for (const v of Object.values(m)) if (v && v.isTexture) v.dispose();
      m.dispose();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// ShipController
// ---------------------------------------------------------------------------------------------
export class ShipController {
  constructor(scene, system) {
    this.scene = scene;
    this.system = system;
    this.lengthM = 60;                                  // real length in metres
    this.forwardAxis = '+Z';                            // forward axis of loaded models (glTF convention: +Z)
    this.chase = { arm: 3.2, height: 0.35 };            // chase-cam offset in ship lengths
    this.cockpit = new THREE.Vector3();                 // cockpit anchor (ship lengths, model frame)
    this.speedMul = 1;
    this.frame = new RefFrame();
    this.pos = [0, 0, 0];                               // absolute scene position (float64)
    this.vel = [0, 0, 0];                               // velocity relative to the reference body (scene u/s)
    this.quat = new THREE.Quaternion();
    this.spawned = false;
    this.throttle = 0;
    this.speed = 0;
    this.maxSpeed = 1;
    this.lit = 1;
    this.modelName = 'placeholder';

    this.rig = new THREE.Group();                       // at the ship position, world-aligned (exhaust lives here)
    this.body = new THREE.Group();                      // rotated + scaled ship frame
    this.rig.add(this.body);
    this.rig.visible = false;
    scene.add(this.rig);
    this._buildExhaust();
    this.useDefaultModel();

    // Pseudo-body so the camera can fly to the ship and the exposure estimate can see it.
    const self = this;
    this.target = {
      key: 'ship', name: 'Ship', kind: 'ship', flat: 0, albedo: 0.45,
      get scenePos() { return self.pos; }, get rScene() { return self.L * 0.5; }, get radius() { return self.L * 0.5; },
      get helio() { return self.frame.ref ? self.frame.ref.helio : [AU_KM, 0, 0]; },
    };
    this.proxy = { kind: 'ship', key: 'ship', albedo: 0.45, screen: { visible: false }, pixelRadius: 0, scenePos: this.pos, helio: [AU_KM, 0, 0], eclipseVisible: 1 };
  }

  /** Ship length in scene units (km). */
  get L() { return this.lengthM / 1000; }

  // --- models --------------------------------------------------------------------------------
  useDefaultModel() {
    const p = buildPlaceholderShip();
    this._source = null;
    this.modelName = 'placeholder';
    this._install(p.root, p.engines, p.lights, p.cockpit);
  }

  /**
   * Attach ANY Object3D as the ship. It is re-oriented so `forward` ('+Z' | '-Z' | '+X' | '-X')
   * points along the flight direction, centred, and normalised to unit length.
   */
  setModel(object, { forward = this.forwardAxis, name = 'custom model', keep = null } = {}) {
    this._source = object;
    this.modelName = name;
    this.forwardAxis = forward;
    const rotY = { '+Z': Math.PI, '-Z': 0, '+X': Math.PI / 2, '-X': -Math.PI / 2 }[forward] ?? Math.PI;
    const turn = new THREE.Group(); turn.rotation.y = rotY; turn.add(object);
    const norm = new THREE.Group(); norm.add(turn);
    norm.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(turn);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const s = 1 / Math.max(size.z, 1e-9);
    turn.position.copy(center).multiplyScalar(-1);
    norm.scale.setScalar(s);
    // No environment map in space: fully metallic PBR surfaces would only show a specular glint,
    // so metalness is capped at 0.6 (documented) to keep the sunlit side readable.
    object.traverse((o) => {
      if (!o.isMesh) return;
      o.frustumCulled = false;
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) if (m && 'metalness' in m) m.metalness = Math.min(m.metalness, 0.6);
    });
    const w = size.x * s, h = size.y * s;
    const engines = [{ pos: new THREE.Vector3(0, 0, 0.5), r: Math.max(0.02, 0.12 * Math.min(w, h)) }];
    const lights = [
      { pos: new THREE.Vector3(-w / 2, 0, 0.15), color: new THREE.Color(1, 0.08, 0.05) },
      { pos: new THREE.Vector3(w / 2, 0, 0.15), color: new THREE.Color(0.1, 1, 0.25) },
    ];
    this._install(norm, engines, lights, new THREE.Vector3(0, 0.3 * h, -0.3), keep);
    return { length: size.z, width: size.x, height: size.y };
  }

  /** Re-apply the forward axis to the current custom model. */
  setForwardAxis(axis) {
    this.forwardAxis = axis;
    if (this._source) {
      const src = this._source;
      src.parent?.remove(src);
      this.setModel(src, { forward: axis, name: this.modelName, keep: src });
    }
  }

  _install(model, engines, lights, cockpit, keep = null) {
    // Free the previous model's GPU resources (geometries, materials, textures) — except objects that are
    // being re-used (setForwardAxis re-wraps the same loaded model).
    if (this.model) { this.body.remove(this.model); disposeTree(this.model, keep); }
    this.model = model;
    this.body.add(model);
    this.engines = engines;
    this.cockpit.copy(cockpit);
    // Thruster glow billboards + hot nozzle cores
    this.glows?.forEach((g) => { for (const m of [g.mesh, g.core]) { this.body.remove(m); m.geometry.dispose(); m.material.dispose(); } });
    this.glows = engines.map((e) => {
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), GLOW_MAT());
      mesh.position.copy(e.pos).add(new THREE.Vector3(0, 0, e.r * 0.4));
      mesh.renderOrder = 3;
      this.body.add(mesh);
      const core = new THREE.Mesh(new THREE.CircleGeometry(e.r * 0.92, 24), new THREE.MeshBasicMaterial({ color: 0xffffff }));
      core.position.copy(e.pos).add(new THREE.Vector3(0, 0, -0.004));
      mesh.userData.core = core;
      this.body.add(core);
      return { mesh, core, e };
    });
    this.navLights?.forEach((n) => { this.body.remove(n.mesh); n.mesh.material.dispose(); });
    this._navGeo?.dispose();
    const lg = this._navGeo = new THREE.SphereGeometry(0.006, 8, 6);
    this.navLights = lights.map((l) => {
      const mesh = new THREE.Mesh(lg, new THREE.MeshBasicMaterial({ color: l.color.clone() }));
      mesh.position.copy(l.pos);
      this.body.add(mesh);
      return { mesh, color: l.color, strobe: !!l.strobe };
    });
  }

  /** Load a GLTF/GLB from a URL. `files` (name → blob URL) resolves sibling .bin/textures of a dropped .gltf. */
  async loadURL(url, { files = null, name = null } = {}) {
    const manager = new THREE.LoadingManager();
    if (files) manager.setURLModifier((u) => files.get(decodeURIComponent(u.split(/[\\/]/).pop())) || u);
    const loader = new GLTFLoader(manager);
    // Compressed-geometry decoders, loaded from the same CDN as three.js only if a model needs them.
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    loader.setMeshoptDecoder(MeshoptDecoder);
    const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
    const draco = new DRACOLoader().setDecoderPath(`https://cdn.jsdelivr.net/npm/three@${THREE_VER}/examples/jsm/libs/draco/gltf/`);
    loader.setDRACOLoader(draco);
    const gltf = await loader.loadAsync(url);
    draco.dispose();
    const dims = this.setModel(gltf.scene, { name: name || url.split(/[\\/]/).pop() });
    return { gltf, dims };
  }

  /** Load from dropped files (a .glb, or a .gltf plus its .bin and textures). */
  async loadFiles(fileList) {
    const files = [...fileList];
    const main = files.find((f) => /\.glb$/i.test(f.name)) || files.find((f) => /\.gltf$/i.test(f.name));
    if (!main) throw new Error('drop a .glb file (or a .gltf together with its .bin and texture files)');
    const map = new Map(files.map((f) => [f.name, URL.createObjectURL(f)]));
    try {
      return await this.loadURL(map.get(main.name), { files: map, name: main.name });
    } finally {
      setTimeout(() => map.forEach((u) => URL.revokeObjectURL(u)), 5000);
    }
  }

  // --- spawn / flight ----------------------------------------------------------------------------
  /** Place the ship just ahead of a camera (position + orientation), anchored to the nearest body. */
  spawnAt(camPos, camQuat) {
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(camQuat);
    const d = this.L * this.chase.arm * 1.15;
    for (let k = 0; k < 3; k++) this.pos[k] = camPos[k] + fwd.getComponent(k) * d;
    this.quat.copy(camQuat);
    this.vel = [0, 0, 0];
    const n = nearestSurface(this.system.bodies, this.pos);
    // Never spawn inside a body (e.g. the camera was hugging a surface).
    if (n.dist < this.L * 2) {
      const b = n.body, off = [this.pos[0] - b.scenePos[0], this.pos[1] - b.scenePos[1], this.pos[2] - b.scenePos[2]];
      const r = Math.hypot(...off), want = b.rScene + this.L * 4;
      for (let k = 0; k < 3; k++) this.pos[k] = b.scenePos[k] + (off[k] / r) * want;
    }
    this.frame.attach(n.body, this.pos);
    this.spawned = true;
    this.rig.visible = true;
  }

  /**
   * Physics step. input = null → parked (drifts to rest in its body's frame);
   * input = { keys: Set, look: {dx, dy} } → piloted.
   */
  update(dt, input) {
    if (!this.spawned || !this.frame.ref) return;
    const bodies = this.system.bodies;
    this.frame.resolve(this.pos, this.vel);
    let thrust = 0;
    const ns = nearestSurface(bodies, this.pos);
    const boost = input && (input.keys.has('ShiftLeft') || input.keys.has('ShiftRight')) ? 6 : 1;
    this.maxSpeed = Math.max(ns.dist, this.L * 3) * 0.6 * this.speedMul * boost;
    if (input) {
      const k = input.keys, q = this.quat;
      // Attitude: mouse/arrow pitch & yaw, Q/E roll (about the ship's own axes)
      const s = 0.0022;
      const yaw = -input.look.dx * s + ((k.has('ArrowLeft') ? 1 : 0) - (k.has('ArrowRight') ? 1 : 0)) * dt * 1.1;
      const pitch = -input.look.dy * s + ((k.has('ArrowUp') ? 1 : 0) - (k.has('ArrowDown') ? 1 : 0)) * dt * 1.1;
      const roll = ((k.has('KeyQ') ? 1 : 0) - (k.has('KeyE') ? 1 : 0)) * dt * 1.4;
      if (yaw) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw));
      if (pitch) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), pitch));
      if (roll) q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
      q.normalize();
      const inp = new THREE.Vector3(
        (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0),
        (k.has('Space') ? 1 : 0) - (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC') ? 1 : 0),
        (k.has('KeyS') ? 1 : 0) - (k.has('KeyW') ? 1 : 0));
      if (inp.lengthSq() > 0) inp.normalize();
      thrust = inp.length() * (boost > 1 ? 1 : 0.6);
      inp.applyQuaternion(q);
      const a = 1 - Math.exp(-dt * 2.2);          // inertia + damping
      for (let i = 0; i < 3; i++) this.vel[i] += (inp.getComponent(i) * this.maxSpeed - this.vel[i]) * a;
      const sp = Math.hypot(...this.vel);
      if (sp > this.maxSpeed) for (let i = 0; i < 3; i++) this.vel[i] *= this.maxSpeed / sp;
    } else {
      const f = Math.exp(-dt * 1.5);
      for (let i = 0; i < 3; i++) this.vel[i] *= f;
    }
    this.throttle += (thrust - this.throttle) * (1 - Math.exp(-dt * 6));
    for (let i = 0; i < 3; i++) this.pos[i] += this.vel[i] * dt;
    this._collide();
    this.frame.set(this.pos);
    this.frame.rebase(bodies, this.pos);
    this.speed = Math.hypot(...this.vel);
    this._stepExhaust(dt);
  }

  /**
   * The ship can never pass inside a body. Its floor is the camera's own collision shell plus the
   * chase-arm length, so the chase camera (which may swing below the ship) is never pushed away from it.
   */
  _collide() {
    const clear = 0.01 + this.L * (this.chase.arm + Math.abs(this.chase.height) + 1.5);
    for (const b of this.system.bodies) {
      const d = [this.pos[0] - b.scenePos[0], this.pos[1] - b.scenePos[1], this.pos[2] - b.scenePos[2]];
      const r = Math.hypot(...d);
      const minR = b.rScene * (1 + 0.01 * b.flat) * 1.002 + clear;
      if (r < minR && r > 0) {
        const n = d.map((x) => x / r);
        for (let i = 0; i < 3; i++) this.pos[i] = b.scenePos[i] + n[i] * minR;
        const vn = this.vel[0] * n[0] + this.vel[1] * n[1] + this.vel[2] * n[2];
        if (vn < 0) for (let i = 0; i < 3; i++) this.vel[i] -= vn * n[i];
      }
    }
  }

  // --- exhaust particles -----------------------------------------------------------------------------
  _buildExhaust() {
    const N = this.nParticles = 900;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(N).fill(-1), 1));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(N), 1));
    this.pVel = new Float32Array(N * 3);
    this.pLife = new Float32Array(N);
    this.pAge = new Float32Array(N).fill(1e9);
    this._pNext = 0;
    this._emitAcc = 0;
    this.exhaust = new THREE.Points(geo, EXHAUST_MAT());
    this.exhaust.frustumCulled = false;
    this.exhaust.renderOrder = 3;
    this.rig.add(this.exhaust);
  }

  /**
   * Particles live in world-aligned axes relative to the ship: they trail when the ship turns but are
   * not smeared by its (auto-scaled, often enormous) speed — a stylised plume.
   */
  _stepExhaust(dt) {
    const g = this.exhaust.geometry, P = g.attributes.position.array, T = g.attributes.aT.array, S = g.attributes.aSize.array;
    const L = this.L, thr = Math.max(0, Math.min(1, this.throttle));
    const rate = (thr > 0.02 ? 60 + 1100 * thr : 0) * this.engines.length;
    this._emitAcc += rate * dt;
    const back = new THREE.Vector3(0, 0, 1).applyQuaternion(this.quat);
    const tmp = new THREE.Vector3(), jit = new THREE.Vector3();
    while (this._emitAcc >= 1) {
      this._emitAcc -= 1;
      const e = this.engines[(Math.random() * this.engines.length) | 0];
      const i = this._pNext; this._pNext = (this._pNext + 1) % this.nParticles;
      jit.set((Math.random() - 0.5) * 2, (Math.random() - 0.5) * 2, 0).multiplyScalar(e.r * 0.6);
      tmp.copy(e.pos).add(jit).multiplyScalar(L).applyQuaternion(this.quat);
      const v = L * 1.5 * (0.5 + thr);
      P[i * 3] = tmp.x; P[i * 3 + 1] = tmp.y; P[i * 3 + 2] = tmp.z;
      this.pVel[i * 3] = back.x * v + (Math.random() - 0.5) * v * 0.18;
      this.pVel[i * 3 + 1] = back.y * v + (Math.random() - 0.5) * v * 0.18;
      this.pVel[i * 3 + 2] = back.z * v + (Math.random() - 0.5) * v * 0.18;
      this.pLife[i] = 0.18 + Math.random() * 0.27;
      this.pAge[i] = 0;
      S[i] = e.r * L * (2.2 + Math.random() * 1.6) * (0.6 + thr);
    }
    for (let i = 0; i < this.nParticles; i++) {
      if (this.pAge[i] >= this.pLife[i]) { T[i] = -1; continue; }
      this.pAge[i] += dt;
      P[i * 3] += this.pVel[i * 3] * dt; P[i * 3 + 1] += this.pVel[i * 3 + 1] * dt; P[i * 3 + 2] += this.pVel[i * 3 + 2] * dt;
      T[i] = Math.min(0.999, this.pAge[i] / this.pLife[i]);
    }
    g.attributes.position.needsUpdate = true;
    g.attributes.aT.needsUpdate = true;
    g.attributes.aSize.needsUpdate = true;
  }

  // --- per-frame sync (after SolarSystem.syncToCamera) ---------------------------------------------------
  sync(camPos, camera, exposure, width, height, time, hidden = false) {
    this.rig.visible = this.spawned && !hidden;
    this.proxy.screen.visible = false;
    if (!this.spawned) return;
    const L = this.L, sys = this.system;
    this.rig.position.set(this.pos[0] - camPos[0], this.pos[1] - camPos[1], this.pos[2] - camPos[2]);
    this.body.quaternion.copy(this.quat);
    this.body.scale.setScalar(L);
    const camDist = this.rig.position.length();

    // Sunlight: the Sun's PointLight (decay 2, intensity π·AU² ⇒ white Lambert radiance 1 at 1 AU) is
    // corrected for the visual-scale distance compression and dimmed by the nearest body's shadow.
    const sun = sys.byKey.sun, ref = this.frame.ref;
    const toSun = [sun.scenePos[0] - this.pos[0], sun.scenePos[1] - this.pos[1], sun.scenePos[2] - this.pos[2]];
    const dScene = Math.hypot(...toSun);
    const dTrue = ref && ref !== sun ? Math.hypot(...ref.helio) : AU_KM * Math.pow(Math.max(dScene, 1) / AU_KM, 1 / (sys._scaleRef?.p || 1));
    this.lit = this._sunlitFraction(toSun, dScene, dTrue);
    sys.sunLight.intensity = Math.PI * AU_KM * AU_KM * (dScene / dTrue) ** 2 * this.lit;
    // A faint fill so the night side isn't pure black (reflected light from nearby bodies, stars).
    sys.ambient.intensity = 0.02 / exposure;

    // Thrusters (HDR, pre-divided by exposure so they read as bright at any adaptation)
    const thr = Math.max(0, Math.min(1, this.throttle));
    const camLocal = new THREE.Quaternion().copy(this.quat).invert().multiply(camera.quaternion);
    for (const g of this.glows) {
      g.mesh.quaternion.copy(camLocal);
      g.mesh.scale.setScalar(g.e.r * (2 + 3 * thr));
      g.mesh.material.uniforms.uI.value = (0.03 + 0.35 * thr) / exposure;
      g.core.material.color.setRGB(0.55, 0.75, 1).multiplyScalar((0.3 + 1.6 * thr) / exposure);
    }
    this.exhaust.material.uniforms.uGain.value = 0.3 / exposure;   // seen end-on from the chase cam: many sprites overlap
    this.exhaust.material.uniforms.uScale.value = height / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.exhaust.material.uniforms.uNear.value = L * 0.8;
    for (const n of this.navLights) {
      const on = !n.strobe || (time % 1.2) < 0.08;
      n.mesh.visible = on;
      n.mesh.material.color.copy(n.color).multiplyScalar(2.5 / exposure);
    }

    // Exposure proxy (auto-exposure should adapt when the lit ship fills the view)
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const v = this.rig.position.clone().applyMatrix4(camera.matrixWorldInverse);
    this.proxy.pixelRadius = (L * 0.3) / Math.max(camDist, 1e-9) / tanHalf * (height / 2);
    this.proxy.screen.visible = !hidden && v.z < 0;
    this.proxy.scenePos = this.pos;
    this.proxy.helio = [dTrue, 0, 0];
    this.proxy.eclipseVisible = this.lit;
  }

  /**
   * Fraction of the solar disc visible from the ship, occluded by its reference body
   * (angular-disc overlap, linear in separation; annular case capped by the area ratio).
   */
  _sunlitFraction(toSun, dScene, dTrue) {
    const b = this.frame.ref;
    if (!b || b.kind === 'sun') return 1;
    const toB = [b.scenePos[0] - this.pos[0], b.scenePos[1] - this.pos[1], b.scenePos[2] - this.pos[2]];
    const dB = Math.hypot(...toB);
    if (dB >= dScene) return 1;                                   // body is beyond the Sun
    const a = Math.asin(Math.min(1, b.rScene / dB));              // body's angular radius
    const s = Math.asin(Math.min(1, R_SUN_KM / dTrue));           // Sun's true angular radius
    const cos = (toB[0] * toSun[0] + toB[1] * toSun[1] + toB[2] * toSun[2]) / (dB * dScene);
    const th = Math.acos(Math.max(-1, Math.min(1, cos)));
    const floor = a < s ? 1 - (a / s) ** 2 : 0;                   // annular: a ring of Sun stays visible
    const f = (th - (a - s)) / (2 * s);
    return Math.max(floor, Math.min(1, Math.max(0, f)));
  }
}
