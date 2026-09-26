// =============================================================================
// smallbodies.js — Asteroids, NEOs, comets, dwarf planets, interstellar objects
// and spacecraft from the /data/ pipeline.
//
// GPU path (tens of thousands of objects): each point carries its orbit as vertex
// attributes — perifocal unit vectors P, Q (ecliptic), a, e, mean anomaly at a
// reference epoch and mean motion. The vertex shader solves Kepler's equation
// (Newton–Raphson, 10 iterations), applies the TRUE/VISUAL distance mapping and the
// floating origin, and computes an apparent magnitude (asteroids: H–G system;
// comets: M1 + 5 log Δ + K1 log r). Used for e < 0.9.
//
// CPU path (hundreds of objects, float64): near-parabolic and hyperbolic orbits
// (universal-variable solver), interstellar objects, and anything with JPL Horizons
// vectors (preferred over elements wherever the vectors cover the date — e.g.
// Apophis, Halley 1984–88, spacecraft).
//
// Two-body propagation from each element set's epoch; `uncertainty()` reports how
// many objects are far from their epoch (>50 yr asteroids, >1 orbit comets).
// =============================================================================
import * as THREE from 'three';
import { DEG, GM_SUN_AU_D, conicPosition, ellipticPosition } from './kepler.js';
import { AU_KM } from './ephemeris.js';

const K_GAUSS = Math.sqrt(GM_SUN_AU_D);          // rad/day for a = 1 AU
const YEAR = 365.25;
// Orbits at or above this eccentricity use the float64 CPU path: near perihelion dE/dM ≈ 1/(1−e)
// amplifies float32 rounding of the mean anomaly beyond ~10⁻⁵ of the distance (measured by gpuSelfTest).
const E_GPU_MAX = 0.8;

// Display groups (index = color slot / visibility flag).
export const GROUPS = [
  { key: 'mba', name: 'Main belt', color: '#a89880' },
  { key: 'inner', name: 'Inner / Mars-crossers', color: '#c0ab88' },
  { key: 'trojan', name: 'Jupiter Trojans', color: '#72c27a' },
  { key: 'centaur', name: 'Centaurs', color: '#c48ae8' },
  { key: 'tno', name: 'Trans-Neptunian', color: '#6f9fe8' },
  { key: 'atira', name: 'NEO: Atira', color: '#ffe066' },
  { key: 'aten', name: 'NEO: Aten', color: '#ffa94a' },
  { key: 'apollo', name: 'NEO: Apollo', color: '#ff7a55' },
  { key: 'amor', name: 'NEO: Amor', color: '#f2c878' },
  { key: 'pha', name: 'Potentially hazardous', color: '#ff2e2e' },
  { key: 'comet', name: 'Comets', color: '#7fe8ff' },
  { key: 'interstellar', name: 'Interstellar', color: '#ff4fd8' },
  { key: 'dwarf', name: 'Dwarf planets', color: '#ffffff' },
  { key: 'spacecraft', name: 'Spacecraft', color: '#b8ffb8' },
  { key: 'other', name: 'Other', color: '#8a8a8a' },
  { key: 'hyperbolic', name: 'Hyperbolic asteroids', color: '#ff4fd8' },
];
const G = Object.fromEntries(GROUPS.map((g, i) => [g.key, i]));

export function groupOf(cls, flags = 0) {
  if (flags & 2) return G.pha;
  switch (cls) {
    case 'MBA': case 'IMB': case 'OMB': return G.mba;
    case 'MCA': case 'AST': return G.inner;
    case 'TJN': return G.trojan;
    case 'CEN': return G.centaur;
    case 'TNO': return G.tno;
    case 'IEO': return G.atira;
    case 'ATE': return G.aten;
    case 'APO': return G.apollo;
    case 'AMO': return G.amor;
    case 'HYA': case 'PAA': return G.hyperbolic;
    case 'JFc': case 'JFC': case 'HTC': case 'ETc': case 'CTc': case 'COM': case 'PAR': case 'HYP': return G.comet;
    default: return G.other;
  }
}

/** Perifocal basis P (→ perihelion), Q (90° ahead) in ecliptic coordinates. */
function pq(i, om, w) {
  const ci = Math.cos(i), si = Math.sin(i), cO = Math.cos(om), sO = Math.sin(om), cw = Math.cos(w), sw = Math.sin(w);
  return [
    [cw * cO - sw * sO * ci, cw * sO + sw * cO * ci, sw * si],
    [-sw * cO - cw * sO * ci, -sw * sO + cw * cO * ci, cw * si],
  ];
}

// --- shared GLSL: Kepler solver on the GPU ------------------------------------------------
export const KEPLER_GLSL = /* glsl */`
const float AU_KM = 149597870.7;
const float TWO_PI = 6.283185307179586;
attribute vec3 aP;
attribute vec3 aQ;
attribute vec4 aOrb;      // a (AU), e, M at reference epoch (rad), n (rad/day)
uniform float uDt;        // days since the reference epoch
vec3 keplerAU() {
  float a = aOrb.x, e = aOrb.y;
  float M = mod(aOrb.z + aOrb.w * uDt, TWO_PI);
  if (M > PI) M -= TWO_PI;
  // Starting guess: M + e·sin M for moderate e; for high e near perihelion the near-parabolic
  // estimate E ≈ ∛(6M) (from M ≈ E³/6 when e → 1), otherwise a point between M and ±π.
  float E;
  if (e < 0.8) E = M + e * sin(M);
  else if (abs(M) < 0.3) E = sign(M) * pow(6.0 * abs(M), 1.0 / 3.0);
  else E = (M >= 0.0 ? PI : -PI) * 0.85 + M * 0.15;
  for (int k = 0; k < 16; k++) E -= (E - e * sin(E) - M) / (1.0 - e * cos(E));
  // cos E − e rewritten as (1 − e) − 2 sin²(E/2): avoids float32 cancellation near perihelion of eccentric orbits.
  float s = sin(0.5 * E);
  float x = a * ((1.0 - e) - 2.0 * s * s);
  float y = a * sqrt(max(1.0 - e * e, 0.0)) * sin(E);
  return x * aP + y * aQ;   // heliocentric ecliptic J2000, AU
}
`;

const POINT_FRAG = /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vColor * exp(-r2 * 2.5), 1.0);
}`;

export class SmallBodyLayer {
  /** exclude: designations rendered as full bodies elsewhere (named asteroids, dwarf planets). */
  constructor(scene, data, exclude = new Set()) {
    this.scene = scene;
    this.data = data;
    this.exclude = exclude;
    this.visible = GROUPS.map((g) => g.key !== 'other');
    this.settings = { mode: 'overview', size: 2.0, limitMag: 14 };
    this.count = 0;
    this.cpuObjects = [];
    this.labels = [];
    if (!data?.available) return;
    this._buildGPU();
    this._buildCPU();
  }

  // ---------------------------------------------------------------------------
  _buildGPU() {
    const d = this.data.files;
    const tRef = Date.now() / 864e5 + 2440587.5 + 69.2 / 86400;   // ≈ now (TDB)
    this.tRef = tRef;
    const byDes = new Map();
    this.cpuExtra = [];
    const cpuSeen = new Set();
    const trackDes = new Set(Object.values(this.data.tracks).map((t) => t.pdes).filter(Boolean));
    const addAst = (table, forceGroup) => {
      if (!table) return;
      const c = Object.fromEntries(table.columns.map((k, i) => [k, i]));
      for (const r of table.rows) {
        if (this.exclude.has(r[c.pdes])) continue;       // rendered as a full body (mesh) by SolarSystem
        if (trackDes.has(r[c.pdes])) continue;          // handled on the CPU from Horizons vectors
        if (r[c.e] >= E_GPU_MAX) {                       // very eccentric: float64 CPU path (see header)
          if (cpuSeen.has(r[c.pdes])) continue;          // same object in asteroids.json and kuiper.json
          cpuSeen.add(r[c.pdes]);
          const a = r[c.a], e = r[c.e], n = K_GAUSS / a ** 1.5;
          this.cpuExtra.push({ name: r[c.name], pdes: r[c.pdes], kind: 'asteroid', group: forceGroup ?? groupOf(r[c.class], r[c.flags]),
            epoch: r[c.epoch], el: { q: a * (1 - e), e, i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.epoch] - (r[c.ma] * DEG) / n } });
          byDes.delete(r[c.pdes]);
          continue;
        }
        byDes.set(r[c.pdes], {
          name: r[c.name], a: r[c.a], e: r[c.e], i: r[c.i], om: r[c.om], w: r[c.w], ma: r[c.ma], epoch: r[c.epoch],
          H: r[c.H] ?? 15, G: r[c.G] ?? 0.15, group: forceGroup ?? groupOf(r[c.class], r[c.flags]), kind: 0,
        });
      }
    };
    addAst(d.asteroids);
    addAst(d.kuiper);                                     // every TNO + Centaur (Phase 4 data)
    addAst(d.neos);
    for (const o of d.dwarfs?.objects || []) {
      if (o.pdes === '134340' || this.exclude.has(o.pdes)) continue;   // Pluto / promoted to full bodies
      if (o.e >= E_GPU_MAX) {                             // e.g. Sedna (e = 0.86): float64 CPU path
        byDes.delete(o.pdes);
        const n = K_GAUSS / o.a ** 1.5;
        this.cpuExtra.push({ name: o.name, pdes: o.pdes, kind: 'dwarf', group: G.dwarf, epoch: o.epoch, labeled: true,
          el: { q: o.a * (1 - o.e), e: o.e, i: o.i, node: o.om, peri: o.w, tp: o.epoch - (o.ma * DEG) / n } });
        continue;
      }
      byDes.set(o.pdes, { name: o.name, a: o.a, e: o.e, i: o.i, om: o.om, w: o.w, ma: o.ma, epoch: o.epoch, H: o.H ?? 0, G: 0.15, group: G.dwarf, kind: 0 });
    }
    // Periodic comets with e < 0.98 go to the GPU too (q, e, tp → a, M).
    this.cpuComets = [];
    if (d.comets) {
      const c = Object.fromEntries(d.comets.columns.map((k, i) => [k, i]));
      for (const r of d.comets.rows) {
        if (this.exclude.has(r[c.pdes])) continue;       // notable comets are full bodies (comets.js)
        const e = r[c.e], q = r[c.q];
        const obj = { name: r[c.name], pdes: r[c.pdes], q, e, i: r[c.i], om: r[c.om], w: r[c.w], tp: r[c.tp], epoch: r[c.epoch],
          M1: r[c.M1] ?? 10, K1: r[c.K1] ?? 10, kind: 1, group: G.comet };
        if (trackDes.has(obj.pdes) || e >= E_GPU_MAX) { this.cpuComets.push(obj); continue; }
        const a = q / (1 - e), n = K_GAUSS / a ** 1.5;
        byDes.set('comet:' + obj.pdes, { ...obj, a, ma: null, n, Mref: n * (tRef - obj.tp) });
      }
    }
    const list = [...byDes.values()];
    const N = list.length;
    this.count = N;
    this.list = list;
    const P = new Float32Array(N * 3), Q = new Float32Array(N * 3), orb = new Float32Array(N * 4), sty = new Float32Array(N * 4);
    this.epochs = new Float64Array(N);
    this.kinds = new Uint8Array(N);
    this.periods = new Float64Array(N);
    list.forEach((o, k) => {
      const [p, q] = pq(o.i * DEG, o.om * DEG, o.w * DEG);
      P.set(p, k * 3); Q.set(q, k * 3);
      const n = o.n ?? K_GAUSS / o.a ** 1.5;
      o.n = n;
      o.Mref0 = o.Mref ?? (o.ma * DEG + n * (tRef - o.epoch));
      orb[k * 4] = o.a; orb[k * 4 + 1] = o.e; orb[k * 4 + 2] = wrapTwoPi(o.Mref0); orb[k * 4 + 3] = n;
      sty[k * 4] = o.group; sty[k * 4 + 1] = o.kind ? o.M1 : o.H; sty[k * 4 + 2] = o.kind ? o.K1 : o.G; sty[k * 4 + 3] = o.kind;
      this.epochs[k] = o.epoch; this.kinds[k] = o.kind; this.periods[k] = (2 * Math.PI) / n;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));   // unused (computed in shader)
    geo.setAttribute('aP', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('aQ', new THREE.BufferAttribute(Q, 3));
    geo.setAttribute('aOrb', new THREE.BufferAttribute(orb, 4));
    geo.setAttribute('aStyle', new THREE.BufferAttribute(sty, 4));
    this.geometry = geo;
    const colors = GROUPS.map((g) => new THREE.Color(g.color));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uDt: { value: 0 }, uP: { value: 1 }, uCam: { value: new THREE.Vector3() }, uCamTrue: { value: new THREE.Vector3() },
        uColors: { value: colors }, uVis: { value: this.visible.map((v) => (v ? 1 : 0)) }, uSize: { value: 2 },
        uPixelRatio: { value: 1 }, uMode: { value: 0 }, uLimitMag: { value: 14 }, uExposure: { value: 1 },
      },
      vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${KEPLER_GLSL}
attribute vec4 aStyle;   // group, H (or M1), G (or K1), kind (0 asteroid, 1 comet)
uniform float uP, uSize, uPixelRatio, uMode, uLimitMag, uExposure;
uniform vec3 uCam, uCamTrue;
uniform vec3 uColors[16];
uniform float uVis[16];
varying vec3 vColor;
void main() {
  int g = int(aStyle.x + 0.5);
  if (uVis[g] < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); return; }
  vec3 h = keplerAU();
  vec3 t = vec3(h.x, h.z, -h.y);                           // ecliptic → three.js axes
  float r = max(length(t), 1e-6);
  vec3 world = t * (AU_KM * pow(r, uP) / r) - uCam;      // TRUE/VISUAL radial mapping + floating origin
  gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  #include <logdepthbuf_vertex>
  // Apparent magnitude from the TRUE geometry.
  vec3 obs = uCamTrue / AU_KM;
  vec3 toObs = obs - t;
  float delta = max(length(toObs), 1e-6);
  float cosa = clamp(dot(-t, toObs) / (r * delta), -1.0, 1.0);
  float alpha = acos(cosa);
  float m;
  if (aStyle.w < 0.5) {
    float tg = tan(alpha * 0.5);
    float phi1 = exp(-3.33 * pow(tg, 0.63)), phi2 = exp(-1.87 * pow(tg, 1.22));
    m = aStyle.y + 5.0 * log(r * delta) / log(10.0) - 2.5 * log(max((1.0 - aStyle.z) * phi1 + aStyle.z * phi2, 1e-6)) / log(10.0);
  } else {
    m = aStyle.y + 5.0 * log(delta) / log(10.0) + aStyle.z * log(r) / log(10.0);
  }
  float b;
  if (uMode < 0.5) {
    // Overview: everything visible, brighter for intrinsically larger bodies; constant after exposure.
    b = clamp(0.3 + (17.0 - aStyle.y) * 0.06, 0.22, 1.0) / uExposure;
    gl_PointSize = uSize * uPixelRatio * (aStyle.x > 11.5 && aStyle.x < 12.5 ? 2.0 : 1.0);
  } else {
    // Realistic: brightness from apparent magnitude; invisible beyond the limiting magnitude.
    b = pow(10.0, -0.4 * (m - uLimitMag + 4.0)) * smoothstep(uLimitMag + 0.5, uLimitMag - 0.5, m);
    b = min(b * uExposure, 1.1) / uExposure;
    gl_PointSize = 1.6 * uPixelRatio;
  }
  vColor = uColors[g] * b;
}`,
      fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.scene.add(this.points);
  }

  // ---------------------------------------------------------------------------
  _buildCPU() {
    const d = this.data;
    const objs = [];
    // Horizons-tracked objects (vectors preferred; fall back to elements outside the span).
    for (const t of Object.values(d.tracks)) {
      if (t.kind === 'moon' || (t.pdes && this.exclude.has(t.pdes)) || this.exclude.has('track:' + t.id)) continue;   // rendered as full bodies
      const el = t.pdes ? this._elementsFor(t.pdes) : null;
      objs.push({ name: t.name, kind: t.kind, group: t.kind === 'spacecraft' ? G.spacecraft : t.kind === 'comet' ? G.comet : groupOf(el?.class, el?.flags),
        track: t, el, labeled: true });
    }
    const tracked = new Set(objs.map((o) => o.track.pdes).filter(Boolean));
    for (const c of this.cpuComets) {
      if (tracked.has(c.pdes)) { const o = objs.find((x) => x.track.pdes === c.pdes); o.el = { q: c.q, e: c.e, i: c.i, node: c.om, peri: c.w, tp: c.tp }; continue; }
      objs.push({ name: c.name, kind: 'comet', group: G.comet, el: { q: c.q, e: c.e, i: c.i, node: c.om, peri: c.w, tp: c.tp }, epoch: c.epoch, labeled: false });
    }
    for (const x of this.cpuExtra) objs.push({ labeled: false, ...x });
    for (const o of d.files.interstellar?.objects || []) {
      if (o.pdes && this.exclude.has(o.pdes)) continue;       // rendered as a full body (comets.js)
      objs.push({ name: o.name, kind: 'interstellar', group: G.interstellar, el: { q: o.q, e: o.e, i: o.i, node: o.om, peri: o.w, tp: o.tp }, epoch: o.epoch, labeled: true });
    }
    this.cpuObjects = objs;
    const n = objs.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    const col = new Float32Array(n * 3);
    objs.forEach((o, k) => { const c = new THREE.Color(GROUPS[o.group].color); col.set([c.r, c.g, c.b], k * 3); });
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aOn', new THREE.BufferAttribute(new Float32Array(n), 1));
    this.cpuMaterial = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: 4 }, uPixelRatio: { value: 1 }, uGain: { value: 1 } },
      vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 aColor;
attribute float aOn;
uniform float uSize, uPixelRatio, uGain;
varying vec3 vColor;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
  gl_PointSize = aOn > 0.5 ? uSize * uPixelRatio : 0.0;
  vColor = aColor * uGain * aOn;
}`,
      fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.cpuPoints = new THREE.Points(geo, this.cpuMaterial);
    this.cpuPoints.frustumCulled = false;
    this.cpuPoints.renderOrder = 7;
    this.scene.add(this.cpuPoints);
    // Labels for interstellar objects, spacecraft and Horizons-tracked bodies.
    const layer = document.getElementById('labels');
    for (const o of objs) {
      if (!o.labeled) continue;
      const el = document.createElement('div');
      el.className = 'label sb';
      el.textContent = o.name.replace(/^\d+\s+/, '');
      el.style.setProperty('--c', GROUPS[o.group].color);
      layer.appendChild(el);
      o.label = el;
    }
  }

  _elementsFor(pdes) {
    for (const f of ['neos', 'asteroids']) {
      const t = this.data.files[f];
      if (!t) continue;
      const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
      const r = t.rows.find((x) => x[c.pdes] === pdes);
      if (r) {
        const a = r[c.a], e = r[c.e], n = K_GAUSS / a ** 1.5;
        return { q: a * (1 - e), e, i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.epoch] - (r[c.ma] * DEG) / n, class: r[c.class], flags: r[c.flags] };
      }
    }
    return null;
  }

  /** Heliocentric ecliptic km of a CPU object at jdTDB (vectors preferred), or null. */
  cpuPosition(o, jdTDB, state, out = [0, 0, 0]) {
    if (o.track && trackPosition(o.track, jdTDB, state, out)) return out;
    if (!o.el) return null;
    conicPosition(o.el, jdTDB, GM_SUN_AU_D, out);
    out[0] *= AU_KM; out[1] *= AU_KM; out[2] *= AU_KM;
    return out;
  }

  // ---------------------------------------------------------------------------
  update(jdTDB, state, scale, camPos, camTrue, camera, exposure, width, height) {
    if (!this.data?.available) return;
    // Re-base the reference epoch if the clock has moved far (keeps float32 time small on the GPU).
    if (Math.abs(jdTDB - this.tRef) > 3000) this._rebase(jdTDB);
    const u = this.material.uniforms;
    u.uDt.value = jdTDB - this.tRef;
    u.uP.value = scale.p;
    u.uCam.value.set(camPos[0], camPos[1], camPos[2]);
    u.uCamTrue.value.set(camTrue[0], camTrue[1], camTrue[2]);
    u.uVis.value = this.visible.map((v) => (v ? 1 : 0));
    u.uSize.value = this.settings.size;
    u.uMode.value = this.settings.mode === 'overview' ? 0 : 1;
    u.uLimitMag.value = this.settings.limitMag;
    u.uExposure.value = exposure;
    // CPU objects.
    const pos = this.cpuPoints.geometry.attributes.position.array, on = this.cpuPoints.geometry.attributes.aOn.array;
    const h = [0, 0, 0], sc = [0, 0, 0], v = new THREE.Vector3();
    this.cpuObjects.forEach((o, k) => {
      const p = this.visible[o.group] ? this.cpuPosition(o, jdTDB, state, h) : null;
      if (!p) { on[k] = 0; if (o.label) o.label.style.display = 'none'; return; }
      if (this.mapHelio) this.mapHelio(p, sc); else scale.helioToScene(p, sc);   // near-planet aware (visual scale)
      pos[k * 3] = sc[0] - camPos[0]; pos[k * 3 + 1] = sc[1] - camPos[1]; pos[k * 3 + 2] = sc[2] - camPos[2];
      on[k] = 1;
      o.helio = [p[0], p[1], p[2]];
      if (o.label) {
        v.set(pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]).applyMatrix4(camera.matrixWorldInverse);
        const front = v.z < 0;
        v.applyMatrix4(camera.projectionMatrix);
        const ok = this.showLabels && front && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        o.label.style.display = ok ? 'block' : 'none';
        if (ok) o.label.style.transform = `translate(${((v.x * 0.5 + 0.5) * width + 6).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * height - 16).toFixed(1)}px)`;
      }
    });
    this.cpuPoints.geometry.attributes.position.needsUpdate = true;
    this.cpuPoints.geometry.attributes.aOn.needsUpdate = true;
    this.cpuMaterial.uniforms.uGain.value = 1 / exposure;
  }

  _rebase(jdTDB) {
    this.tRef = jdTDB;
    const orb = this.geometry.attributes.aOrb.array;
    this.list.forEach((o, k) => {
      orb[k * 4 + 2] = wrapTwoPi(o.kind ? o.n * (jdTDB - o.tp) : o.ma * DEG + o.n * (jdTDB - o.epoch));
    });
    this.geometry.attributes.aOrb.needsUpdate = true;
  }

  /** Orbit-uncertainty summary: objects far from their element epoch. */
  uncertainty(jdTDB) {
    if (!this.count) return null;
    let ast = 0, com = 0;
    for (let k = 0; k < this.count; k++) {
      const dt = Math.abs(jdTDB - this.epochs[k]);
      if (this.kinds[k] === 0) { if (dt > 50 * YEAR) ast++; } else if (dt > this.periods[k]) com++;
    }
    for (const o of this.cpuObjects) if (o.kind === 'comet' && o.epoch && !o.track?.covers(jdTDB) && o.el.e < 1) {
      const a = o.el.q / (1 - o.el.e), P = 2 * Math.PI / (K_GAUSS / a ** 1.5);
      if (Math.abs(jdTDB - o.epoch) > P) com++;
    }
    return { asteroids: ast, comets: com };
  }

  setVisibility(key, on) { const i = GROUPS.findIndex((g) => g.key === key); if (i >= 0) this.visible[i] = on; }

  // ---------------------------------------------------------------------------
  /**
   * GPU self-test: evaluate the vertex-shader Kepler solver for `n` objects into a float
   * render target, read it back, and compare with the float64 CPU solver.
   * Returns { n, worstKm, worstName } or null if unsupported.
   */
  gpuSelfTest(renderer, jdTDB, n = Infinity) {
    if (!this.count) return null;
    const N = Math.min(n, this.count);
    const W = Math.min(N, 1024), H = Math.ceil(N / W);          // 2-D readback: every object fits
    const step = Math.max(1, Math.floor(this.count / N));
    const idx = Array.from({ length: N }, (_, k) => Math.min(this.count - 1, k * step));
    const src = this.geometry.attributes;
    const pick = (attr, size) => { const a = new Float32Array(N * size); idx.forEach((j, k) => a.set(attr.array.subarray(j * size, j * size + size), k * size)); return a; };
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    geo.setAttribute('aP', new THREE.BufferAttribute(pick(src.aP, 3), 3));
    geo.setAttribute('aQ', new THREE.BufferAttribute(pick(src.aQ, 3), 3));
    geo.setAttribute('aOrb', new THREE.BufferAttribute(pick(src.aOrb, 4), 4));
    geo.setAttribute('aIndex', new THREE.BufferAttribute(new Float32Array(idx.map((_, k) => k)), 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uDt: { value: jdTDB - this.tRef }, uW: { value: W }, uH: { value: H } },
      vertexShader: `#include <common>\n${KEPLER_GLSL}\nattribute float aIndex; uniform float uW, uH; varying vec3 vH;
void main() {
  vH = keplerAU();
  float col = mod(aIndex, uW), row = floor(aIndex / uW);
  gl_Position = vec4((col + 0.5) / uW * 2.0 - 1.0, (row + 0.5) / uH * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`,
      fragmentShader: `varying vec3 vH; void main() { gl_FragColor = vec4(vH, 1.0); }`,
      depthTest: false, depthWrite: false,
    });
    const rt = new THREE.WebGLRenderTarget(W, H, { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false });
    const scene = new THREE.Scene();
    scene.add(new THREE.Points(geo, mat));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const prevRT = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
    renderer.setRenderTarget(rt); renderer.autoClear = true;
    renderer.setClearColor(0x000000, 0); renderer.clear();
    renderer.render(scene, cam);
    const buf = new Float32Array(W * H * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    renderer.setRenderTarget(prevRT); renderer.autoClear = prevAuto;
    let worst = 0, worstName = '', worstRel = 0, worstRelName = '';
    const ref = [0, 0, 0];
    idx.forEach((j, k) => {
      const o = this.list[j];
      const M = o.kind ? o.n * (jdTDB - o.tp) : o.ma * DEG + o.n * (jdTDB - o.epoch);   // float64 reference
      ellipticPosition(o.a, o.e, o.i * DEG, o.om * DEG, o.w * DEG, M, ref);
      const errAU = Math.hypot(buf[k * 4] - ref[0], buf[k * 4 + 1] - ref[1], buf[k * 4 + 2] - ref[2]);
      const err = errAU * AU_KM, rel = errAU / Math.hypot(...ref);
      if (err > worst) { worst = err; worstName = o.name; }
      if (rel > worstRel) { worstRel = rel; worstRelName = o.name; }
    });
    geo.dispose(); mat.dispose(); rt.dispose();
    return { n: N, worstKm: worst, worstName, worstRel, worstRelName };
  }
}

function wrapTwoPi(x) { x %= 2 * Math.PI; return x < 0 ? x + 2 * Math.PI : x; }

const _st = { center: 10, pos: [0, 0, 0], vel: [0, 0, 0] }, _sh = { center: 10, pos: [0, 0, 0], vel: [0, 0, 0] };
/**
 * Heliocentric km from a Horizons track (null outside its span). Planet-centred segments ride on the
 * simulated planet (Earth's ephemeris differs from DE441 by up to ~6,000 km), so they cross-fade to the
 * heliocentric segment over their last day — no jump at segment boundaries.
 */
export function trackPosition(track, jdTDB, state, out = [0, 0, 0]) {
  const s = track.stateAt(jdTDB, _st);
  if (!s) return null;
  const c = s.center === 399 ? state.earth : s.center === 599 ? state.jupiter : null;
  for (let k = 0; k < 3; k++) out[k] = s.pos[k] + (c ? c[k] : 0);
  if (c && s.edgeDays < 1) {
    const h = track.stateAt(jdTDB, _sh, 10);
    if (h) {
      const w = s.edgeDays * s.edgeDays * (3 - 2 * s.edgeDays);
      for (let k = 0; k < 3; k++) out[k] = h.pos[k] + (out[k] - h.pos[k]) * w;
    }
  }
  return out;
}
