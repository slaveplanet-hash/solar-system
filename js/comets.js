// =============================================================================
// comets.js — Comets and interstellar objects as bodies, their comae and tails,
// meteor-shower streams and meteors seen from Earth's night side.
//
// • Notable comets and every interstellar object in /data/ become focusable bodies
//   with small dark nuclei (JPL SBDB elements; Horizons vectors where the data has them).
// • CometVisuals renders the brightest ACTIVE comets (up to 8): activity follows the
//   heliocentric distance (fades in inside ~3–5 AU, peaks near perihelion) scaled by the
//   comet's own magnitude parameters (m = M1 + 5 log Δ + K1 log r):
//     – coma: camera-facing glow;
//     – ion tail: straight, blue, exactly anti-sunward, with streaming structure;
//     – dust tail: a syndyne × synchrone grid of grains released over the last 60 days and
//       moving in reduced gravity μ(1−β) — broad, curved, lagging behind the orbital motion;
//     – jets from the sunlit side of modelled nuclei.
// • MeteorShowers: particle tubes along parent orbits; Earth's crossing and the radiant emerge
//   from the geometry (showers.js). Near Earth's surface on the night side, meteors streak
//   away from the computed radiant.
// =============================================================================
import * as THREE from 'three';
import { AU_KM, iauMatrix, eclipticToEquatorial, computeSystemState } from './ephemeris.js';
import { DEG, TAU, GM_SUN_AU_D, conicPosition, perifocalToFrame } from './kepler.js';
import { J2000, utcToTDB, utcStringToJD } from './time.js';
import { activity, intrinsicBrightness, cometMagnitude, vInfinity, asymptotes, eclipticToRaDec, dustGrid, DUST_BETAS, DUST_AGES } from './cometphysics.js';
// (eclipticToRaDec is used for the interstellar asymptote labels below.)
import { SHOWERS, parentElements, orbitSamples, orbitPointVel, distanceToOrbit } from './showers.js';
import { shapeGeometry } from './shapes.js';
import { trackPosition } from './smallbodies.js';

// Nucleus data (semi-axes km, rotation h). Sizes: Halley (Giotto), 67P (Rosetta), others from the literature;
// where only an estimate exists it is marked in `note`.
export const COMET_BODIES = {
  '1P':       { key: 'halley', name: 'Halley', axes: [7.5, 4.1, 4.1], rotHours: 52.8, style: 'lumpy', type: 'Periodic comet (Halley-type, 76 yr)' },
  '2P':       { key: 'encke', name: 'Encke', axes: [2.4, 2.4, 2.4], rotHours: 11.1, style: 'lumpy', type: 'Periodic comet (Encke-type, 3.3 yr)' },
  '67P':      { key: 'c67p', name: '67P/Churyumov–Gerasimenko', axes: [2.05, 1.65, 0.9], rotHours: 12.4, style: 'peanut', pole: { ra: 69.3, dec: 64.1 }, type: 'Jupiter-family comet — Rosetta' },
  '109P':     { key: 'swifttuttle', name: 'Swift–Tuttle', axes: [13, 13, 13], rotHours: 67, style: 'lumpy', type: 'Periodic comet (Perseid parent)' },
  '55P':      { key: 'tempeltuttle', name: 'Tempel–Tuttle', axes: [1.8, 1.8, 1.8], rotHours: 15, style: 'lumpy', type: 'Periodic comet (Leonid parent)', note: 'nucleus size estimated' },
  '1995 O1':  { key: 'halebopp', name: 'Hale–Bopp', axes: [30, 30, 30], rotHours: 11.35, style: 'lumpy', type: 'Long-period comet (Great Comet of 1997)', note: 'nucleus ~40–80 km (estimated)' },
  '1996 B2':  { key: 'hyakutake', name: 'Hyakutake', axes: [2.1, 2.1, 2.1], rotHours: 6.3, style: 'lumpy', type: 'Long-period comet (Great Comet of 1996)' },
  '2006 P1':  { key: 'mcnaught', name: 'McNaught', axes: [12, 12, 12], rotHours: 20, style: 'lumpy', type: 'Long-period comet (Great Comet of 2007)', note: 'nucleus size estimated' },
  '2020 F3':  { key: 'neowise', name: 'NEOWISE', axes: [2.5, 2.5, 2.5], rotHours: 7.58, style: 'lumpy', type: 'Long-period comet (2020)' },
  '2023 A3':  { key: 'tsuchinshanatlas', name: 'Tsuchinshan–ATLAS', axes: [2.9, 2.9, 2.9], rotHours: 20, style: 'lumpy', type: 'Long-period comet (2024)', note: 'nucleus size estimated' },
};
// Interstellar objects, matched by name. Unknown new ones get a generic 0.5 km nucleus.
const INTERSTELLAR = [
  { match: /Oumuamua/, key: 'oumuamua', name: 'ʻOumuamua (1I)', axes: [0.0575, 0.0555, 0.0095], rotHours: 8.67, color: '#d98a6a', note: 'inactive (no coma); flat 115×111×19 m model (Mashchenko 2019); tumbling' },
  { match: /Borisov/, key: 'borisov', name: '2I/Borisov', axes: [0.2, 0.2, 0.2], rotHours: 10, color: '#9fd8ff', note: 'nucleus < 0.5 km (Hubble)' },
  { match: /2025 N1|3I/, key: 'atlas3i', name: '3I/ATLAS', axes: [1.4, 1.4, 1.4], rotHours: 16.2, color: '#b7ffd8', note: 'nucleus size uncertain (≲ 5.6 km)' },
];

/** Heliocentric path (km) of a conic, restricted to r ≤ rMax AU for open or very long orbits. */
function conicPath(el, N, rMax) {
  const pts = [], tmp = [0, 0, 0];
  const w = el.peri * DEG, i = el.i * DEG, O = el.node * DEG, p = el.q * (1 + el.e);
  if (el.e < 1 && el.q / (1 - el.e) * (1 + el.e) <= rMax) {
    const a = el.q / (1 - el.e), b = a * Math.sqrt(1 - el.e * el.e);
    for (let k = 0; k < N; k++) {
      const E = (k / (N - 1)) * TAU;
      perifocalToFrame(a * (Math.cos(E) - el.e), b * Math.sin(E), w, i, O, tmp);
      pts.push(tmp.map((v) => v * AU_KM));
    }
    return pts;
  }
  const cmin = Math.max(-1, (p / rMax - 1) / el.e), nuMax = Math.acos(cmin);
  for (let k = 0; k < N; k++) {
    const nu = -nuMax + (2 * nuMax * k) / (N - 1);
    const r = p / (1 + el.e * Math.cos(nu));
    perifocalToFrame(r * Math.cos(nu), r * Math.sin(nu), w, i, O, tmp);
    pts.push(tmp.map((v) => v * AU_KM));
  }
  return pts;
}

function simpleRotation(rotHours, pole) {
  let ra, dec;
  if (pole) ({ ra, dec } = pole); else [ra, dec] = eclipticToEquatorial(0, 90);
  const rate = 360 / (rotHours / 24);
  return (jd) => iauMatrix(ra, dec, rate * (jd - J2000));
}

/**
 * Body definitions for notable comets and all interstellar objects. Returns { defs, promoted:Set(pdes) }.
 * Every def carries `cometEl` (conic elements) and M1/K1 so CometVisuals can render its coma/tails.
 */
export function buildCometDefs(data) {
  const defs = [], promoted = new Set();
  if (!data?.available) return { defs, promoted };
  const tracks = Object.values(data.tracks);
  const t = data.files.comets;
  const make = (info, el, extra) => {
    const meanR = Math.cbrt(info.axes[0] * info.axes[1] * info.axes[2]);
    const track = extra.pdes ? tracks.find((x) => x.pdes === extra.pdes) || null : null;
    const cur = [0, 0, 0];
    const byEl = (jd, state, out) => { conicPosition(el, jd, GM_SUN_AU_D, out); out[0] *= AU_KM; out[1] *= AU_KM; out[2] *= AU_KM; return out; };
    const positionFn = (jd, state, out) => {
      const r = (track && trackPosition(track, jd, state, out)) || byEl(jd, state, out);
      cur[0] = r[0]; cur[1] = r[1]; cur[2] = r[2];
      return r;
    };
    const rMax = extra.minorType === 'interstellar' ? 80 : 60;
    const def = {
      key: info.key, name: info.name, kind: 'planet', minor: true, minorType: extra.minorType, type: info.type || extra.type,
      parent: 'sun', radius: meanR, flat: 0, mass: null, rotHours: info.rotHours, tilt: null, color: info.color || '#8fb8c8',
      proc: 'darkrock', albedo: 0.04, airless: 0.7, axes: info.axes, pdes: extra.pdes, cometEl: el, M1: extra.M1, K1: extra.K1,
      elementEpoch: extra.epoch, track, orbitDays: el.e < 1 ? TAU / (Math.sqrt(GM_SUN_AU_D) / (el.q / (1 - el.e)) ** 1.5) : Infinity,
      geometry: shapeGeometry(info.style || 'lumpy', info.axes, meanR, info.key.length * 11 + 5),
      rotationFn: simpleRotation(info.rotHours, info.pole), poleNote: info.pole ? 'published spin axis' : 'pole unknown — assumed ecliptic north',
      positionFn,
      orbitFn: (jd, N) => {
        // Pass exactly through the current (possibly Horizons) position: shift by the element/track offset.
        const p = conicPath(el, N, rMax), e = byEl(jd, null, [0, 0, 0]);
        const off = [cur[0] - e[0], cur[1] - e[1], cur[2] - e[2]];
        return p.map((q) => [q[0] + off[0], q[1] + off[1], q[2] + off[2]]);
      },
      notes: [info.note, track ? 'Position from JPL Horizons vectors where available.' : null].filter(Boolean).join(' '),
    };
    if (extra.minorType === 'interstellar') {
      const vinf = vInfinity(el.q, el.e);
      const as = asymptotes(el), inb = eclipticToRaDec(as.inbound), outb = eclipticToRaDec(as.outbound);
      def.vinf = vinf;
      def.name = `${info.name} · v∞ ${vinf.toFixed(1)} km/s`;
      def.shortName = info.name;
      const far = (u) => u.map((v) => v * 60 * AU_KM);
      def.pathMarkers = [
        { helio: far(as.inbound), text: `◀ inbound — from RA ${inb.ra.toFixed(1)}°, Dec ${inb.dec >= 0 ? '+' : ''}${inb.dec.toFixed(1)}°` },
        { helio: far(as.outbound), text: `outbound ▶ toward RA ${outb.ra.toFixed(1)}°, Dec ${outb.dec >= 0 ? '+' : ''}${outb.dec.toFixed(1)}°` },
      ];
      def.radiantIn = inb;
      def.notes = `Hyperbolic orbit (e = ${el.e.toFixed(3)}): v∞ = ${vinf.toFixed(1)} km/s. ${def.notes}`.trim();
    }
    defs.push(def);
    if (extra.pdes) promoted.add(extra.pdes);
  };
  if (t) {
    const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
    for (const r of t.rows) {
      const info = COMET_BODIES[r[c.pdes]];
      if (!info) continue;
      make(info, { q: r[c.q], e: r[c.e], i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.tp] },
        { pdes: r[c.pdes], minorType: 'comet', M1: r[c.M1], K1: r[c.K1], epoch: r[c.epoch] });
    }
  }
  for (const o of data.files.interstellar?.objects || []) {
    const info = INTERSTELLAR.find((x) => x.match.test(o.name)) || { key: 'isobj_' + (o.pdes || o.name).replace(/\W/g, ''), name: o.name, axes: [0.5, 0.5, 0.5], rotHours: 10, note: 'newly catalogued interstellar object (generic nucleus)' };
    make({ ...info, type: 'Interstellar object (hyperbolic)' }, { q: o.q, e: o.e, i: o.i, node: o.om, peri: o.w, tp: o.tp },
      { pdes: o.pdes, minorType: 'interstellar', M1: o.M1, K1: o.K1, epoch: o.epoch });
  }
  return { defs, promoted };
}

// ---------------------------------------------------------------------------------------------
// Coma, tails and jets
// ---------------------------------------------------------------------------------------------
const LOGDEPTH_V = '#include <common>\n#include <logdepthbuf_pars_vertex>';
const COMA_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uI: { value: 1 } },
  vertexShader: `${LOGDEPTH_V}\nvarying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}`,
  fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float uI; varying vec2 vUv;
void main(){\n#include <logdepthbuf_fragment>\n  float r = length(vUv - 0.5) * 2.0; if (r > 1.0) discard;
  float core = 0.035 / (r + 0.035);                    // coma surface brightness ~ 1/ρ
  float fall = 1.0 - smoothstep(0.25, 1.0, r);
  vec3 col = mix(vec3(0.62, 0.95, 0.78), vec3(0.85, 0.92, 1.0), smoothstep(0.0, 0.5, r));   // C2 green core
  gl_FragColor = vec4(col * core * fall * uI, 1.0);
}`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});
const ION_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uI: { value: 1 }, uTime: { value: 0 }, uSeed: { value: Math.random() * 100 } },
  vertexShader: `${LOGDEPTH_V}\nvarying vec2 vUv;\nvoid main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}`,
  fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float uI, uTime, uSeed; varying vec2 vUv;
float h(float n){ return fract(sin(n) * 43758.5453); }
float n1(float x){ float i = floor(x), f = fract(x); return mix(h(i), h(i + 1.0), f * f * (3.0 - 2.0 * f)); }
void main(){\n#include <logdepthbuf_fragment>\n  float s = vUv.x, t = vUv.y * 2.0 - 1.0;          // s: along the tail (0 = head), t: across
  // Streamers: narrow rays whose brightness streams outward and flickers (plasma disconnections).
  float rays = 0.0;
  for (int k = 0; k < 5; k++) { float fk = float(k);
    float c = (h(fk + uSeed) - 0.5) * 0.9 * (0.3 + s);
    float wdt = 0.06 + 0.1 * s;
    float q = (t - c) / wdt;
    rays += exp(-q * q) * (0.55 + 0.45 * n1(s * 14.0 - uTime * 1.6 + fk * 7.0));
  }
  float body = exp(-t * t * 3.0) * 0.5 + rays * 0.5;
  float along = pow(max(1.0 - s, 0.0), 1.3) * smoothstep(0.0, 0.03, s);
  gl_FragColor = vec4(vec3(0.35, 0.58, 1.0) * body * along * uI, 1.0);
}`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});
const DUST_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uI: { value: 1 } },
  vertexShader: `${LOGDEPTH_V}\nattribute float aW; attribute vec2 aBA; varying float vW; varying vec2 vBA;
void main(){ vW = aW; vBA = aBA; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0);\n#include <logdepthbuf_vertex>\n}`,
  fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform float uI; varying float vW; varying vec2 vBA;
void main(){\n#include <logdepthbuf_fragment>\n  // vBA.x: β index 0..1 (edge fade), vBA.y: age 0..1 (older grains fainter, spread out)
  float edge = smoothstep(0.0, 0.15, vBA.x) * (1.0 - smoothstep(0.8, 1.0, vBA.x));
  float ageDays = 60.0 * pow(clamp(vBA.y, 0.0, 1.0), 1.6);   // DUST_AGES spacing (clamped: pow of a negative → NaN)
  float age = exp(-ageDays / 15.0) * smoothstep(0.0, 0.02, vBA.y + 0.005);   // old grains: spread thin
  gl_FragColor = vec4(vec3(1.0, 0.9, 0.72) * vW * edge * age * uI, 1.0);
}`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
});

export class CometVisuals {
  constructor(scene, system, data, slots = 8) {
    this.scene = scene; this.system = system;
    this.enabled = true;
    this.candidates = [];
    // Candidates: every comet row with magnitude parameters (+ promoted bodies use their own positions).
    const t = data?.files?.comets;
    const bodyByPdes = new Map(system.bodies.filter((b) => b.cometEl).map((b) => [b.pdes, b]));
    if (t) {
      const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
      for (const r of t.rows) {
        if (r[c.M1] == null) continue;
        // Defunct / disintegrated comets ("5D/Brorsen", "D/1993 F2") are not active: no coma or tails.
        if (/^\d+D$/.test(r[c.pdes]) || /^D\//.test(r[c.pdes]) || /^\d+D\//.test(r[c.name])) continue;
        this.candidates.push({ name: r[c.name], pdes: r[c.pdes], M1: r[c.M1], K1: r[c.K1] ?? 10, body: bodyByPdes.get(r[c.pdes]) || null,
          el: { q: r[c.q], e: r[c.e], i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.tp] } });
      }
    }
    for (const b of system.bodies) if (b.minorType === 'interstellar' && b.M1 != null) {
      this.candidates.push({ name: b.shortName || b.name, pdes: b.pdes, M1: b.M1, K1: b.K1 ?? 10, body: b, el: b.cometEl });
    }
    const nb = DUST_BETAS.length, na = DUST_AGES.length;
    const idx = [];
    for (let k = 0; k + 1 < nb; k++) for (let j = 0; j + 1 < na; j++) {
      const a = k * na + j, b = (k + 1) * na + j, c2 = k * na + j + 1, d = (k + 1) * na + j + 1;
      idx.push(a, b, d, a, d, c2);
    }
    this.slots = [];
    for (let s = 0; s < slots; s++) {
      const group = new THREE.Group();
      const coma = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), COMA_MAT());
      const ionGeo = new THREE.BufferGeometry();
      ionGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
      ionGeo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), 2));
      ionGeo.setIndex([0, 2, 1, 1, 2, 3]);
      const ion = new THREE.Mesh(ionGeo, ION_MAT());
      const dustGeo = new THREE.BufferGeometry();
      dustGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nb * na * 3), 3));
      dustGeo.setAttribute('aW', new THREE.BufferAttribute(new Float32Array(nb * na), 1));
      const ba = new Float32Array(nb * na * 2);
      for (let k = 0; k < nb; k++) for (let j = 0; j < na; j++) { ba[(k * na + j) * 2] = k / (nb - 1); ba[(k * na + j) * 2 + 1] = j / (na - 1); }
      dustGeo.setAttribute('aBA', new THREE.BufferAttribute(ba, 2));
      dustGeo.setIndex(idx);
      const dust = new THREE.Mesh(dustGeo, DUST_MAT());
      for (const m of [coma, ion, dust]) { m.frustumCulled = false; m.renderOrder = 4; group.add(m); }
      group.visible = false;
      scene.add(group);
      this.slots.push({ group, coma, ion, dust, cand: null, grid: null, gridJd: null });
    }
    this._lastSelect = -1e9;
    this.active = [];
  }

  _nucleusKm(c, jd, state) {
    if (c.body && !c.body.offline) return c.body.helio.slice();
    const p = conicPosition(c.el, jd, GM_SUN_AU_D, [0, 0, 0]);
    return [p[0] * AU_KM, p[1] * AU_KM, p[2] * AU_KM];
  }

  /** Choose the brightest active comets (re-evaluated every simulated day or real second). */
  _select(jd, state) {
    const scored = [];
    for (const c of this.candidates) {
      const h = this._nucleusKm(c, jd, state), r = Math.hypot(...h) / AU_KM;
      if (r > 6) continue;
      const act = activity(r), B = intrinsicBrightness(c.M1, c.K1, r);
      const score = act * B;
      if (score > 1e-3) scored.push({ c, score, r });
    }
    scored.sort((a, b) => b.score - a.score);
    const chosen = scored.slice(0, this.slots.length);
    // Keep existing slot assignments where possible (avoid recomputing dust grids).
    const keep = new Set(chosen.map((x) => x.c));
    for (const s of this.slots) if (s.cand && !keep.has(s.cand)) { s.cand = null; s.grid = null; s.group.visible = false; }
    for (const x of chosen) {
      if (this.slots.some((s) => s.cand === x.c)) continue;
      const free = this.slots.find((s) => !s.cand);
      if (free) { free.cand = x.c; free.grid = null; }
    }
    this.active = chosen.map((x) => ({ name: x.c.name, r: x.r, score: x.score }));
  }

  update(jd, state, scale, camPos, camera, exposure, time) {
    if (!this.enabled) { for (const s of this.slots) s.group.visible = false; return; }
    const now = performance.now();
    if (now - this._lastSelect > 1000 || Math.abs(jd - (this._selJd ?? jd)) > 1) { this._select(jd, state); this._lastSelect = now; this._selJd = jd; }
    const sys = this.system, rf = Math.sqrt(scale.radiusFactor('planet'));
    const tmp = [0, 0, 0], v = new THREE.Vector3(), side = new THREE.Vector3(), axis = new THREE.Vector3();
    let gridBudget = 1;
    for (const s of this.slots) {
      const c = s.cand;
      if (!c) { s.group.visible = false; continue; }
      const h = this._nucleusKm(c, jd, state);
      const rKm = Math.hypot(...h), r = rKm / AU_KM;
      const act = activity(r), B = intrinsicBrightness(c.M1, c.K1, r);
      const size = Math.min(4, Math.max(0.05, Math.pow(B, 0.3))) * act;
      const I = Math.min(3, Math.sqrt(B)) * act / (r * r);             // sunlit radiance scale (pre-exposure)
      s.group.visible = size > 0.01;
      if (!s.group.visible) continue;
      // Same placement as the nucleus mesh (bodies near Earth/Jupiter use the Hill-zone mapping).
      const P = c.body?.scenePos ? c.body.scenePos : sys.mapHelioToScene(h, 1, scale, [0, 0, 0]);
      const px = P[0] - camPos[0], py = P[1] - camPos[1], pz = P[2] - camPos[2];
      // Coma
      const comaR = 6e4 * size * rf;
      s.coma.position.set(px, py, pz);
      s.coma.quaternion.copy(camera.quaternion);
      s.coma.scale.setScalar(comaR * 2);
      // The billboard's 1/ρ profile is what an outside observer sees; from inside the coma the column in
      // front of the camera shrinks, so fade it out to reveal the nucleus and jets on approach.
      const camD = Math.hypot(px, py, pz);
      s.coma.material.uniforms.uI.value = 1.4 * I * Math.min(1, Math.pow(camD / (comaR * 0.5), 2));
      // Ion tail: straight, anti-sunward; the tip is mapped like any heliocentric point.
      const L = 4e7 * size;
      const u = [h[0] / rKm, h[1] / rKm, h[2] / rKm];
      const T = sys.mapHelioToScene([h[0] + u[0] * L, h[1] + u[1] * L, h[2] + u[2] * L], 1, scale, tmp);
      axis.set(T[0] - P[0], T[1] - P[1], T[2] - P[2]);
      v.set(px, py, pz).normalize();
      side.crossVectors(axis, v).normalize();
      const w0 = comaR * 0.35, w1 = Math.max(comaR * 1.2, axis.length() * 0.06);
      const ip = s.ion.geometry.attributes.position.array;
      const put = (k, x, y, z) => { ip[k * 3] = x; ip[k * 3 + 1] = y; ip[k * 3 + 2] = z; };
      put(0, px - side.x * w0, py - side.y * w0, pz - side.z * w0);
      put(1, px + side.x * w0, py + side.y * w0, pz + side.z * w0);
      put(2, px + axis.x - side.x * w1, py + axis.y - side.y * w1, pz + axis.z - side.z * w1);
      put(3, px + axis.x + side.x * w1, py + axis.y + side.y * w1, pz + axis.z + side.z * w1);
      s.ion.geometry.attributes.position.needsUpdate = true;
      s.ion.material.uniforms.uI.value = 0.5 * I;
      s.ion.material.uniforms.uTime.value = time;
      // Dust tail: recompute the grain grid when the date moved (≥ 0.05 d) — one comet per frame.
      if ((!s.grid || Math.abs(jd - s.gridJd) > 0.05 || s.gridVer !== scale.version) && gridBudget > 0) {
        const pos = c.body && c.body.positionFn
          ? (t) => { const q = c.body.positionFn(t, state, [0, 0, 0]); return [q[0] / AU_KM, q[1] / AU_KM, q[2] / AU_KM]; }
          : (t) => conicPosition(c.el, t, GM_SUN_AU_D, [0, 0, 0]);
        s.grid = dustGrid(pos, jd);
        s.gridJd = jd; s.gridVer = scale.version;
        s.gridScene = new Float64Array(s.grid.points.length);
        for (let k = 0; k < s.grid.points.length; k += 3) {
          sys.mapHelioToScene([s.grid.points[k] * AU_KM, s.grid.points[k + 1] * AU_KM, s.grid.points[k + 2] * AU_KM], 1, scale, tmp);
          s.gridScene[k] = tmp[0]; s.gridScene[k + 1] = tmp[1]; s.gridScene[k + 2] = tmp[2];
        }
        s.dust.geometry.attributes.aW.array.set(s.grid.weight);
        s.dust.geometry.attributes.aW.needsUpdate = true;
        gridBudget--;
      }
      if (s.gridScene) {
        // Shift the grid so its age-0 row sits exactly on the current nucleus (it may be a few frames old).
        const dp = s.dust.geometry.attributes.position.array, g = s.gridScene;
        const ox = P[0] - g[0], oy = P[1] - g[1], oz = P[2] - g[2];     // grid vertex 0 = (β₀, age 0) = the nucleus
        for (let k = 0; k < g.length; k += 3) { dp[k] = g[k] + ox - camPos[0]; dp[k + 1] = g[k + 1] + oy - camPos[1]; dp[k + 2] = g[k + 2] + oz - camPos[2]; }
        s.dust.geometry.attributes.position.needsUpdate = true;
      }
      s.dust.material.uniforms.uI.value = 0.55 * I;
      // Jets on modelled nuclei (sunlit side only).
      if (c.body) this._jets(c.body, act, exposure, r);
    }
  }

  _jets(b, act, exposure, rAU) {
    if (!b.jets) {
      b.jets = [];
      const dirs = [[0.6, 0.5, 0.62], [-0.3, 0.8, -0.5], [0.2, -0.3, 0.93]];
      for (const d of dirs) {
        const n = new THREE.Vector3(...d).normalize();
        // Gas plume: an open cone widening outward from a vent (apex at the surface). Brightness follows
        // the column through the plume (bright on-axis, soft edges) and thins with distance from the vent.
        const geo = new THREE.CylinderGeometry(1.6, 0.06, 6, 32, 8, true);
        geo.translate(0, 3 + 0.9, 0);
        const m = new THREE.Mesh(geo, new THREE.ShaderMaterial({
          uniforms: { uI: { value: 1 } },
          vertexShader: `${LOGDEPTH_V}
varying float vS; varying vec3 vN, vV;
void main(){ vS = (position.y - 0.9) / 6.0; vec4 mv = modelViewMatrix * vec4(position,1.0);
  vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv;
#include <logdepthbuf_vertex>
}`,
          fragmentShader: `#include <common>
#include <logdepthbuf_pars_fragment>
uniform float uI; varying float vS; varying vec3 vN, vV;
void main(){
#include <logdepthbuf_fragment>
  float s = clamp(vS, 0.0, 1.0);
  float core = pow(abs(dot(normalize(vN), normalize(vV))), 2.5);     // thickest column through the axis
  float along = exp(-s * 3.5) * smoothstep(0.0, 0.04, s);
  gl_FragColor = vec4(vec3(0.85, 0.9, 1.0) * core * along * uI, 1.0); }`,
          transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        }));
        m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
        m.userData.n = n;
        b.mesh.add(m);
        b.jets.push(m);
      }
    }
    // Sun direction in the nucleus' mesh frame.
    // (group.position is camera-relative under the floating origin; scenePos is Sun-centred.)
    const sunW = new THREE.Vector3(...b.scenePos).negate().normalize();
    const inv = b.mesh.getWorldQuaternion(new THREE.Quaternion()).invert();
    const sunL = sunW.applyQuaternion(inv);
    for (const j of b.jets) {
      const lit = j.userData.n.dot(sunL);
      j.visible = act > 0.05 && lit > 0.15;
      // Dust-laden gas scatters sunlight like the surface does: keep it near the nucleus' own radiance
      // (albedo ~0.04 / r²), so it reads as a faint plume rather than a light source.
      j.material.uniforms.uI.value = 0.05 * act * lit / Math.max(0.1, rAU * rAU);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Meteor showers: stream tubes along parent orbits + meteors near Earth's night-side surface
// ---------------------------------------------------------------------------------------------
export class MeteorShowers {
  constructor(scene, data) {
    this.scene = scene;
    this.enabled = true;
    this.rateBoost = 60;             // meteors are rare: time-lapse factor for the sky view (Settings)
    this.streams = [];
    this.state = [];
    let seed = 1234;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(TAU * rnd());
    const done = new Set();
    for (const sh of SHOWERS) {
      const el = parentElements(data, sh);
      if (!el) continue;
      // Only the arc of the parent orbit near this shower's node counts (Halley's orbit is met twice a
      // year: the Eta Aquariids in May and the Orionids in October must not light up together).
      const eNode = computeSystemState(utcToTDB(utcStringToJD(`2000-${sh.peak} 00:00`))).earth.map((v) => v / AU_KM);
      const all = orbitSamples(el, 1200), node = orbitPointVel(el, distanceToOrbit(el, eNode, all).nu).pos;
      const arc = all.filter((nu) => { const q = orbitPointVel(el, nu).pos; return Math.hypot(q[0] - node[0], q[1] - node[1], q[2] - node[2]) < 0.5; });
      const stream = { shower: sh, el, nus: arc.length > 2 ? arc : all };
      this.streams.push(stream);
      if (done.has(sh.parent)) { stream.shared = true; continue; }   // Halley feeds two showers: one tube
      done.add(sh.parent);
      const n = 2500, pos = new Float64Array(n * 3), nus = orbitSamples(el, n);
      const tube = Math.max(...SHOWERS.filter((x) => x.parent === sh.parent).map((x) => x.tube));
      for (let k = 0; k < n; k++) {
        const { pos: p } = orbitPointVel(el, nus[k] + (rnd() - 0.5) * 0.002);
        const r = Math.hypot(...p);
        pos[k * 3] = (p[0] + gauss() * tube * 0.5 * (r / 1)) * AU_KM;
        pos[k * 3 + 1] = (p[1] + gauss() * tube * 0.5 * (r / 1)) * AU_KM;
        pos[k * 3 + 2] = (p[2] + gauss() * tube * 0.5 * (r / 1)) * AU_KM;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const mat = new THREE.PointsMaterial({ size: 1.4, sizeAttenuation: false, color: new THREE.Color(sh.color), transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.55 });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false; pts.renderOrder = 7;
      scene.add(pts);
      stream.points = pts; stream.helio = pos; stream.color = new THREE.Color(sh.color);
    }
    // Meteor streaks: segments of directions at infinity (like the stars).
    this.maxMeteors = 80;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.maxMeteors * 2 * 3), 3));
    g.setAttribute('aA', new THREE.BufferAttribute(new Float32Array(this.maxMeteors * 2), 1));
    this.streakMat = new THREE.ShaderMaterial({
      uniforms: { uGain: { value: 1 } },
      vertexShader: `attribute float aA; varying float vA; void main(){ vA = aA; vec3 d = mat3(viewMatrix) * position; gl_Position = projectionMatrix * vec4(d, 1.0); gl_Position.z = gl_Position.w * 0.999999; }`,
      fragmentShader: `uniform float uGain; varying float vA; void main(){ gl_FragColor = vec4(vec3(0.85, 1.0, 0.9) * vA * uGain, 1.0); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.streaks = new THREE.LineSegments(g, this.streakMat);
    this.streaks.frustumCulled = false; this.streaks.renderOrder = -5;
    scene.add(this.streaks);
    this.meteors = [];
    this._p = null; this._ver = -1; this._lastAct = -1e9;
    this.sky = { active: false };
  }

  /** Earth–stream distance → activity per shower (throttled: every 0.5 s real time). */
  _activity(jd, state) {
    const e = state.earth.map((v) => v / AU_KM);
    this.state = this.streams.map((s) => {
      const { dist, nu } = distanceToOrbit(s.el, e, s.nus);
      const act = Math.exp(-((dist / s.shower.tube) ** 2));
      return { shower: s.shower, dist, nu, act, el: s.el };
    });
  }

  update(jd, state, scale, camPos, earth, exposure, dtReal, system) {
    // Stream particles (static heliocentric; remapped only when the scale mapping changes).
    for (const s of this.streams) {
      if (!s.points) continue;
      s.points.visible = this.enabled && !this.hideStreams;     // hidden from the ground (surface view)
      if (!this.enabled) continue;
      if (s._mapped !== scale.version) {
        const out = [0, 0, 0];
        s.scene = s.scene || new Float64Array(s.helio.length);
        for (let k = 0; k < s.helio.length; k += 3) {
          // Plain radial mapping, no near-planet zones: the stream is static while Earth moves through it
          // (zones applied at mapping time would leave a hole where Earth was when the stream was mapped).
          scale.helioToScene([s.helio[k], s.helio[k + 1], s.helio[k + 2]], out);
          s.scene[k] = out[0]; s.scene[k + 1] = out[1]; s.scene[k + 2] = out[2];
        }
        s._mapped = scale.version;
      }
      const arr = s.points.geometry.attributes.position.array;
      for (let k = 0; k < s.scene.length; k++) arr[k] = s.scene[k] - camPos[k % 3];
      s.points.geometry.attributes.position.needsUpdate = true;
      s.points.material.color.copy(s.color).multiplyScalar(0.35 / exposure);
    }
    const now = performance.now();
    if (now - this._lastAct > 500 || Math.abs(jd - (this._actJd ?? jd)) > 0.2) { this._activity(jd, state); this._lastAct = now; this._actJd = jd; }
    this._updateSky(jd, state, camPos, earth, exposure, dtReal);
  }

  /** Meteors: only near Earth's surface on the night side while a stream is being crossed. */
  _updateSky(jd, state, camPos, earth, exposure, dtReal) {
    const rel = [camPos[0] - earth.scenePos[0], camPos[1] - earth.scenePos[1], camPos[2] - earth.scenePos[2]];
    const d = Math.hypot(...rel);
    const altKm = (d / earth.rScene - 1) * earth.radius;
    const up = rel.map((x) => x / d);
    const sunDir = earth.scenePos.map((x) => -x / Math.hypot(...earth.scenePos));
    const night = up[0] * sunDir[0] + up[1] * sunDir[1] + up[2] * sunDir[2] < -0.1;
    const near = altKm < 1000;
    const active = this.state.filter((s) => s.act > 0.03);
    this.sky = { active: this.enabled && near && night && active.length > 0, showers: active, altKm, night };
    // Spawn
    if (this.sky.active) {
      for (const s of active) {
        // Radiant: meteoroid velocity at the closest orbit point relative to Earth (geocentric), reversed.
        if (!s.radiant || Math.abs(jd - (s.radJd ?? 0)) > 0.05) {
          const { vel } = orbitPointVel(s.el, s.nu);
          const vE = earthVelocity(jd);
          const vg = [vel[0] - vE[0], vel[1] - vE[1], vel[2] - vE[2]];
          const n = Math.hypot(...vg);
          s.radiant = [-vg[0] / n, -vg[2] / n, vg[1] / n];            // ecliptic → three axes (x, z, −y), reversed
          s.radJd = jd;
        }
        // Observed rate = ZHR × sin(radiant altitude): nothing while the radiant is below the horizon.
        const sinH = s.radiant[0] * up[0] + s.radiant[1] * up[1] + s.radiant[2] * up[2];
        s.radiantAlt = Math.asin(Math.max(-1, Math.min(1, sinH))) / DEG;
        const rate = (s.shower.zhr * s.act * Math.max(0, sinH) * this.rateBoost) / 3600;   // per second (time-lapsed)
        let expected = rate * dtReal;
        while (expected > 0) { if (Math.random() < expected) this._spawn(s.radiant, up); expected -= 1; }
      }
    }
    // Advance and draw
    const pos = this.streaks.geometry.attributes.position.array, al = this.streaks.geometry.attributes.aA.array;
    this.meteors = this.meteors.filter((m) => (m.t += dtReal) < m.dur);
    al.fill(0);
    this.meteors.forEach((m, i) => {
      if (i >= this.maxMeteors) return;
      const f = m.t / m.dur;
      const head = rotate(m.start, m.axis, m.len * f), tail = rotate(m.start, m.axis, Math.max(0, m.len * f - m.trail));
      pos.set(tail, i * 6); pos.set(head, i * 6 + 3);
      const fade = Math.sin(Math.PI * f);
      al[i * 2] = 0; al[i * 2 + 1] = fade * m.b;
    });
    this.streaks.geometry.attributes.position.needsUpdate = true;
    this.streaks.geometry.attributes.aA.needsUpdate = true;
    this.streakMat.uniforms.uGain.value = 1.2 / exposure;
    this.streaks.visible = this.meteors.length > 0;
  }

  _spawn(R, up) {
    for (let tries = 0; tries < 20; tries++) {
      const d = randomUnit();
      const cr = d[0] * R[0] + d[1] * R[1] + d[2] * R[2];
      if (cr < Math.cos(70 * DEG) || cr > Math.cos(3 * DEG)) continue;            // within 3–70° of the radiant
      if (d[0] * up[0] + d[1] * up[1] + d[2] * up[2] < 0.08) continue;              // above the horizon
      // Axis of the great circle through R and d: meteors move AWAY from the radiant.
      const ax = normalize(cross(R, d));
      this.meteors.push({ start: d, axis: ax, len: (5 + Math.random() * 20) * DEG, trail: (3 + Math.random() * 6) * DEG,
        dur: 0.35 + Math.random() * 0.8, t: 0, b: 0.4 + Math.random() * 1.2 });
      return;
    }
  }
}

function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function normalize(v) { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); }
function randomUnit() { const z = Math.random() * 2 - 1, t = Math.random() * TAU, s = Math.sqrt(1 - z * z); return [s * Math.cos(t), z, s * Math.sin(t)]; }
/** Rotate unit vector v about unit axis k by angle a (Rodrigues). */
function rotate(v, k, a) {
  const c = Math.cos(a), s = Math.sin(a), d = k[0] * v[0] + k[1] * v[1] + k[2] * v[2], x = cross(k, v);
  return [v[0] * c + x[0] * s + k[0] * d * (1 - c), v[1] * c + x[1] * s + k[1] * d * (1 - c), v[2] * c + x[2] * s + k[2] * d * (1 - c)];
}

/** Earth's heliocentric velocity (AU/day) by central difference. */
function earthVelocity(jd) {
  const a = computeSystemState(jd + 0.01).earth, b = computeSystemState(jd - 0.01).earth;
  return [(a[0] - b[0]) / 0.02 / AU_KM, (a[1] - b[1]) / 0.02 / AU_KM, (a[2] - b[2]) / 0.02 / AU_KM];
}

/** Dynamic info line for a comet body (shown in the info panel). */
export function cometInfo(b, system) {
  if (!b.cometEl) return '';
  const r = Math.hypot(...b.helio) / AU_KM;
  const e = system.byKey.earth.helio;
  const dE = Math.hypot(b.helio[0] - e[0], b.helio[1] - e[1], b.helio[2] - e[2]) / AU_KM;
  const act = activity(r);
  const mag = b.M1 != null ? cometMagnitude(b.M1, b.K1 ?? 10, r, dE) : null;
  return `r = ${r.toFixed(3)} AU · activity ${(act * 100).toFixed(0)}%${mag != null ? ` · total magnitude from Earth ≈ ${mag.toFixed(1)} (M1 ${b.M1}, K1 ${b.K1})` : ' · inactive (no coma parameters)'}.`;
}
