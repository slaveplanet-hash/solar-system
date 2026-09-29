// =============================================================================
// sensor.js — "Realism of scale" helpers.
//
//   • apparentMagnitude(): V magnitude of a body seen from an observer (true km):
//     planets from Mallama & Hilton (2018) phase curves (Saturn incl. its ring-tilt
//     term), the Moon from its V(1,0) and phase law, everything else from an H
//     derived from size + albedo with the IAU H–G phase function (G = 0.15).
//   • PhotometricPoints: every body drawn as a star-like point at its TRUE apparent
//     magnitude, through the same brightness mapping as the star catalogue, so e.g.
//     Jupiter from Earth outshines Sirius. The point hands over to the resolved disc
//     as the disc grows (crossfade over 1–6 px radius).
//   • SensorOverlay: optional brackets + labels for small, hard-to-see tracked
//     objects (asteroids, comets, spacecraft, event targets). Switch it off to see the
//     real emptiness of space.
// =============================================================================
import * as THREE from 'three';
import { AU_KM } from './ephemeris.js';
import { cometMagnitude } from './cometphysics.js';

const DEG = Math.PI / 180;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);

/** Phase angle (deg) at body b (helio km) for an observer at o (helio km). */
function phaseAngle(b, o) {
  const toSun = b.map((v) => -v), toObs = sub(o, b);
  const c = (toSun[0] * toObs[0] + toSun[1] * toObs[1] + toSun[2] * toObs[2]) / (len(toSun) * len(toObs));
  return Math.acos(Math.max(-1, Math.min(1, c))) / DEG;
}

/** IAU H–G phase function magnitude term (G = 0.15). */
function hgTerm(a, G = 0.15) {
  const t = Math.tan((a * DEG) / 2);
  const p1 = Math.exp(-3.33 * Math.pow(t, 0.63)), p2 = Math.exp(-1.87 * Math.pow(t, 1.22));
  return -2.5 * Math.log10(Math.max(1e-6, (1 - G) * p1 + G * p2));
}

/**
 * Apparent V magnitude of body `b` (fields: key, helio, radius, albedo, eclMatrix) for an observer at
 * heliocentric `obs` (km, ecliptic). Returns { V, alpha, delta } or null.
 */
export function apparentMagnitude(b, obs) {
  const r = len(b.helio) / AU_KM, d = len(sub(b.helio, obs)) / AU_KM;
  if (!(r > 0 && d > 0)) return null;
  const a = phaseAngle(b.helio, obs), dist = 5 * Math.log10(r * d);
  let V;
  switch (b.key) {
    case 'mercury': V = -0.613 + 6.328e-2 * a - 1.6336e-3 * a ** 2 + 3.3644e-5 * a ** 3 - 3.4265e-7 * a ** 4 + 1.6893e-9 * a ** 5 - 3.0334e-12 * a ** 6; break;
    case 'venus': V = a < 163.7 ? -4.384 - 1.044e-3 * a + 3.687e-4 * a ** 2 - 2.814e-6 * a ** 3 + 8.938e-9 * a ** 4 : 236.05828 - 2.81914 * a + 8.39034e-3 * a ** 2; break;
    case 'earth': V = -3.99 - 1.060e-3 * a + 2.054e-4 * a ** 2; break;
    case 'mars': V = a <= 50 ? -1.601 + 2.267e-2 * a - 1.302e-4 * a ** 2 : -0.367 - 0.02573 * a + 3.445e-4 * a ** 2; break;
    case 'jupiter': V = a <= 12 ? -9.395 - 3.7e-4 * a + 6.16e-4 * a ** 2 : -9.428 + 5 * Math.log10(1 - 1.507 * (a / 180) - 0.363 * (a / 180) ** 2 - 0.062 * (a / 180) ** 3 + 2.809 * (a / 180) ** 4 - 1.876 * (a / 180) ** 5); break;
    case 'saturn': {
      // Ring opening: sine of the ring-plane latitude of the observer (pole = body +z in eclMatrix).
      let sB = 0;
      if (b.eclMatrix) {
        const M = b.eclMatrix, pole = [M[2], M[5], M[8]], toObs = sub(obs, b.helio), n = len(toObs);
        sB = Math.abs((pole[0] * toObs[0] + pole[1] * toObs[1] + pole[2] * toObs[2]) / n);
      }
      V = a <= 6.5 ? -8.914 - 1.825 * sB + 0.026 * a - 0.378 * sB * Math.exp(-2.25 * a) : -8.94 + 2.446e-4 * a + 2.672e-4 * a ** 2 - 1.505e-6 * a ** 3 + 4.767e-9 * a ** 4;
      break;
    }
    case 'uranus': V = -7.110 + 6.587e-3 * a + 1.045e-4 * a ** 2; break;
    case 'neptune': V = -7.00 + 7.944e-3 * a + 9.617e-5 * a ** 2; break;
    case 'moon': V = 0.21 + 0.026 * a + 4.0e-9 * a ** 4; break;
    default: {
      // Comets: total (coma) magnitude m = M1 + 5 log Δ + K1 log r (SBDB M1/K1; often faint-phase fits).
      if (b.M1 != null && (b.minorType === 'comet' || b.minorType === 'interstellar')) return { V: cometMagnitude(b.M1, b.K1 ?? 10, r, d), alpha: a, delta: d };
      const D = 2 * b.radius, p = Math.max(0.02, b.albedo ?? 0.1);
      const H = 5 * Math.log10(1329 / (D * Math.sqrt(p)));
      V = H + hgTerm(Math.min(a, 150));
    }
  }
  return { V: V + dist, alpha: a, delta: d };
}

// ---------------------------------------------------------------------------------------------
export class PhotometricPoints {
  constructor(scene) {
    this.scene = scene;
    this.max = 512;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(this.max * 3), 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(new Float32Array(this.max), 1));
    geo.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(this.max), 1));
    // Same V → brightness mapping, size law and cap as the Yale star field (sky.js), but at real positions.
    this.material = new THREE.ShaderMaterial({
      uniforms: { uGain: { value: 1.0 }, uExposure: { value: 1 }, uPixelRatio: { value: 1 }, uFade: { value: 1 } },
      vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uGain, uExposure, uPixelRatio, uFade;
attribute vec3 aColor;
attribute float aMag, aFade;
varying vec3 vCol;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
  float flux = pow(10.0, -0.4 * (aMag + 1.0));
  float b = uGain * pow(flux, 0.55);
  float size = clamp(1.4 + 5.0 * pow(flux, 0.35), 1.4, 6.5);
  gl_PointSize = aFade > 0.0 ? size * uPixelRatio : 0.0;
  float perPixel = b * (2.0 / (size * size)) * 4.0;
  vCol = aColor * min(perPixel * uExposure, 1.1) / uExposure * aFade * uFade;
}`,
      fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vCol;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  gl_FragColor = vec4(vCol * exp(-r2 * 3.5), 1.0);
}`,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    scene.add(this.points);
    this.mags = new Map();         // key → last V (for the HUD/tests)
    this._col = new THREE.Color();
  }

  /** obsHelio: observer TRUE heliocentric ecliptic km. */
  update(bodies, obsHelio, camPos, exposure, fade = 1) {
    const g = this.points.geometry, P = g.attributes.position.array, C = g.attributes.aColor.array,
      M = g.attributes.aMag.array, F = g.attributes.aFade.array;
    let n = 0;
    for (const b of bodies) {
      if (n >= this.max) break;
      if (b.kind === 'sun' || b.offline || !b.group.visible || b.minorType === 'spacecraft' || b.minorType === 'satellite') continue;
      const m = apparentMagnitude(b, obsHelio);
      if (!m) continue;
      this.mags.set(b.key, m.V);
      const f = 1 - Math.min(1, Math.max(0, (b.pixelRadius - 1) / 5));   // hand over to the disc (1 → 6 px)
      if (f <= 0 || m.V > 9) continue;
      P[n * 3] = b.scenePos[0] - camPos[0]; P[n * 3 + 1] = b.scenePos[1] - camPos[1]; P[n * 3 + 2] = b.scenePos[2] - camPos[2];
      this._col.set(b.color); const mx = Math.max(this._col.r, this._col.g, this._col.b, 1e-3);
      // Desaturated body colour (points look nearly white to the eye, with a hint of tint).
      C[n * 3] = 0.7 + 0.3 * this._col.r / mx; C[n * 3 + 1] = 0.7 + 0.3 * this._col.g / mx; C[n * 3 + 2] = 0.7 + 0.3 * this._col.b / mx;
      M[n] = m.V; F[n] = f;
      n++;
    }
    g.setDrawRange(0, n);
    for (const k of ['position', 'aColor', 'aMag', 'aFade']) g.attributes[k].needsUpdate = true;
    this.material.uniforms.uExposure.value = exposure;
    this.material.uniforms.uFade.value = fade;
  }
}

// ---------------------------------------------------------------------------------------------
export class SensorOverlay {
  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'sensor';
    Object.assign(this.canvas.style, { position: 'fixed', inset: '0', pointerEvents: 'none', zIndex: 3 });
    document.body.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.enabled = true;
    this.targets = [];            // extra { name, scenePos, color } (event targets without a body)
  }

  update(bodies, camera, camPos, width, height, selected) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
      this.canvas.style.width = width + 'px'; this.canvas.style.height = height + 'px';
    }
    const g = this.ctx;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, width, height);
    this.canvas.style.display = this.enabled || this.targets.length ? '' : 'none';
    const v = new THREE.Vector3();
    const draw = (x, y, color, label, sub, strong) => {
      const s = strong ? 11 : 7, k = 4;
      g.strokeStyle = color; g.lineWidth = strong ? 1.6 : 1; g.globalAlpha = strong ? 0.95 : 0.7;
      g.beginPath();
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        g.moveTo(x + sx * s, y + sy * (s - k)); g.lineTo(x + sx * s, y + sy * s); g.lineTo(x + sx * (s - k), y + sy * s);
      }
      g.stroke();
      g.font = '10.5px ui-monospace, SFMono-Regular, Consolas, monospace';
      g.fillStyle = color; g.globalAlpha = strong ? 0.95 : 0.6;
      g.fillText(label, x + s + 4, y - 2);
      if (sub) { g.globalAlpha = 0.45; g.fillText(sub, x + s + 4, y + 10); }
      g.globalAlpha = 1;
    };
    const project = (p) => {
      v.set(p[0] - camPos[0], p[1] - camPos[1], p[2] - camPos[2]).applyMatrix4(camera.matrixWorldInverse);
      if (v.z >= 0) return null;
      const d = -v.z;
      v.applyMatrix4(camera.projectionMatrix);
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      return { x: (v.x * 0.5 + 0.5) * width, y: (-v.y * 0.5 + 0.5) * height, d };
    };
    if (this.enabled) {
      // Small tracked objects that are (near-)invisible: sub-pixel discs of minor bodies and spacecraft.
      const cands = [];
      for (const b of bodies) {
        if (!b.minor || b.offline || !b.group.visible || b.pixelRadius > 4) continue;
        const s = project(b.scenePos);
        if (s) cands.push({ b, s });
      }
      cands.sort((a, c) => a.s.d - c.s.d);
      for (const { b, s } of cands.slice(0, 40)) {
        const color = b.minorType === 'spacecraft' || b.minorType === 'satellite' ? '#b8ffb8' : b.minorType === 'comet' || b.minorType === 'interstellar' ? '#9fe8ff' : '#ffd79a';
        draw(s.x, s.y, color, b.shortName || b.name, fmtDist(b.camDist, b), b === selected);
      }
    }
    for (const t of this.targets) {                                     // event targets: always drawn
      const s = project(t.scenePos);
      if (s) draw(s.x, s.y, t.color || '#ff9f6b', t.name, t.sub || '', true);
    }
  }
}

function fmtDist(dScene, b) {
  const km = dScene * (b.radius / Math.max(b.rScene, 1e-12));
  return km > 0.05 * AU_KM ? `${(km / AU_KM).toFixed(2)} AU` : `${Math.round(km).toLocaleString('en-US')} km`;
}
