// =============================================================================
// satellites.js — Earth satellites (CelesTrak snapshot, SGP4 via satcore.js) as a layer:
//   • a point per satellite, recomputed with SGP4 every frame (dimmed in Earth's shadow,
//     dimmer still when the date is more than FRESH_DAYS from the element epoch, hidden
//     beyond MAX_DAYS),
//   • its orbit path: one full period sampled with SGP4 (180 segments ≈ 1 km chord error
//     at ISS altitude; a quarter ahead of the satellite, the rest behind), fading from the satellite backwards. The fade follows the satellite
//     on the GPU; the samples are refreshed under a per-frame time budget because the
//     orbit plane turns (ISS: ~5°/day ≈ 0.4 km per sim-minute), stalest first,
//   • the ISS as a full body (model, Follow) driven by the same SGP4 elements, and a
//     "selected satellite" body that takes over whichever satellite you click.
// Positions are Earth-relative (float32 is ~mm there); the true/visual mapping near Earth is
// done in the shaders with the same formula as SolarSystem.mapHelioToScene.
// =============================================================================
import * as THREE from 'three';
import { SAT_GROUPS, temeToEclipticMatrix, satPosition, satValidity, satOrbitSummary, nearEarthToScene,
  R_EARTH, ISS_NORAD, FRESH_DAYS, MAX_DAYS } from './satcore.js';
import { tdbToUTC, utcToTDB, jdToUTCString } from './time.js';
import { CRAFT, buildModel, frameAlong } from './spacecraft.js';

const NS = 181;                  // vertices per path
const NG = SAT_GROUPS.length;
const LINE_BUDGET_MS = 2.5;      // SGP4 path sampling per frame
const LEAD = 0.25;               // fraction of the path sampled ahead of the satellite

// Near-Earth TRUE/VISUAL mapping (= satcore.nearEarthToScene = ScaleSystem.moonOffsetToScene when s > 0).
const MAP_GLSL = /* glsl */`
uniform float uS, uRf, uPm, uClampR;
vec3 mapNear(vec3 p) {
  if (uS <= 0.0) return p;
  const float RE = ${R_EARTH.toFixed(3)};
  float d = max(length(p), 1e-6);
  float dv = max(RE * uRf * pow(d / RE, uPm), uClampR);
  return p * (dv / d);
}`;

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

export class SatelliteLayer {
  /** sats: satcore.satRecords(); system: SolarSystem (for Earth). */
  constructor(scene, system, sats) {
    this.scene = scene;
    this.system = system;
    this.sats = sats;
    this.N = sats.length;
    this.visible = SAT_GROUPS.map(() => true);
    this.settings = { points: true, paths: true, labels: true, pathGain: 0.5, size: 3 };
    this.hidden = false;          // surface view
    this.overlay = true;          // sensor overlay (paths + labels need it)
    this.selected = -1;
    this.T = new Array(9);
    this.iss = sats.findIndex((s) => s.norad === ISS_NORAD);
    const N = this.N;
    this.rel = new Float64Array(N * 3);        // current geocentric ecliptic km
    this.state = new Uint8Array(N);            // 0 hidden · 1 approximate · 2 fresh
    this.lineJd = new Float64Array(N).fill(NaN);
    this.lineOn = new Float32Array(N);         // value currently written into the path's aOn
    this.tRef = sats.length ? sats.reduce((s, x) => s + x.epoch, 0) / N : 0;   // float32 time origin (UTC JD)
    this._buildPoints();
    this._buildPaths();
    this._buildLabels();
  }

  _mapUniforms() {
    return { uS: { value: 0 }, uRf: { value: 1 }, uPm: { value: 1 }, uClampR: { value: 0 } };
  }

  _buildPoints() {
    const N = this.N, geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
    const col = new Float32Array(N * 3);
    this.sats.forEach((s, i) => { const c = new THREE.Color(SAT_GROUPS[s.group].color); col.set([c.r, c.g, c.b], i * 3); });
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aOn', new THREE.BufferAttribute(new Float32Array(N), 1).setUsage(THREE.DynamicDrawUsage));
    this.pointMat = new THREE.ShaderMaterial({
      uniforms: { ...this._mapUniforms(), uSize: { value: 3 }, uPixelRatio: { value: 1 }, uGain: { value: 1 } },
      vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${MAP_GLSL}
attribute vec3 aColor;
attribute float aOn;
uniform float uSize, uPixelRatio, uGain;
varying vec3 vColor;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(mapNear(position), 1.0);
  #include <logdepthbuf_vertex>
  gl_PointSize = aOn > 0.0 ? uSize * uPixelRatio : 0.0;
  vColor = aColor * uGain * aOn;
}`,
      fragmentShader: POINT_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.pointMat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    this.scene.add(this.points);
  }

  _buildPaths() {
    const N = this.N, V = N * NS;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(V * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aOn', new THREE.BufferAttribute(new Float32Array(V), 1).setUsage(THREE.DynamicDrawUsage));
    const per = new Float32Array(V), grp = new Float32Array(V);
    this.sats.forEach((s, i) => { per.fill(s.periodMin, i * NS, (i + 1) * NS); grp.fill(s.group, i * NS, (i + 1) * NS); });
    geo.setAttribute('aPer', new THREE.BufferAttribute(per, 1));
    geo.setAttribute('aGroup', new THREE.BufferAttribute(grp, 1));
    const idx = new Uint32Array(N * (NS - 1) * 2);
    for (let i = 0, k = 0; i < N; i++) for (let j = 0; j < NS - 1; j++) { idx[k++] = i * NS + j; idx[k++] = i * NS + j + 1; }
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.pathMat = new THREE.ShaderMaterial({
      uniforms: { ...this._mapUniforms(), uNow: { value: 0 }, uGain: { value: 1 }, uAlpha: { value: 1 },
        uColors: { value: SAT_GROUPS.map((g) => new THREE.Color(g.color)) }, uVis: { value: this.visible.map(() => 1) } },
      vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
${MAP_GLSL}
attribute float aT, aPer, aGroup, aOn;
uniform float uNow, uGain, uAlpha;
uniform vec3 uColors[${NG}];
uniform float uVis[${NG}];
varying vec3 vColor;
varying float vOn, vA;
void main() {
  gl_Position = projectionMatrix * modelViewMatrix * vec4(mapNear(position), 1.0);
  #include <logdepthbuf_vertex>
  int g = int(aGroup + 0.5);
  float age = mod(uNow - aT, aPer) / aPer;          // 0 at the satellite → 1 one orbit behind it
  float f = 0.1 + 0.9 * pow(1.0 - age, 1.6);
  vOn = aOn * uVis[g];
  vColor = uColors[g] * uGain;
  vA = min(f * aOn * uAlpha, 1.0);             // the selected path (aOn 2.5) stands out
}`,
      fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vOn, vA;
void main() {
  #include <logdepthbuf_fragment>
  if (vOn <= 0.0) discard;
  gl_FragColor = vec4(vColor, vA);
}`,
      // Alpha (not additive) blending: hundreds of overlapping paths must not sum into a white, blooming blob.
      transparent: true, depthWrite: false, blending: THREE.NormalBlending,
    });
    this.paths = new THREE.LineSegments(geo, this.pathMat);
    this.paths.frustumCulled = false;
    this.paths.renderOrder = 6;
    this.scene.add(this.paths);
  }

  _buildLabels() {
    const layer = document.getElementById('labels');
    this.labels = [];
    this.sats.forEach((s, i) => {
      if (SAT_GROUPS[s.group].key !== 'stations' || i === this.iss) return;
      const el = document.createElement('div');
      el.className = 'label sb';
      el.textContent = s.name;
      el.style.setProperty('--c', SAT_GROUPS[s.group].color);
      el.style.display = 'none';
      layer.appendChild(el);
      this.labels.push({ i, el });
    });
  }

  /** Body definitions: the ISS (if present) and the "selected satellite" stand-in. */
  bodyDefs() {
    const defs = [], layer = this;
    const E = () => this.system.byKey.earth.helio;
    if (this.iss >= 0) {
      const info = CRAFT.iss, i = this.iss;
      defs.push({
        key: 'iss', name: info.name, shortName: info.name, kind: 'planet', minor: true, minorType: 'spacecraft', type: 'Space station',
        parent: 'sun', radius: info.span / 2000, flat: 0, mass: 4.5e5, rotHours: null, tilt: null, color: info.color, albedo: 0.5, peakAlbedo: 0.9,
        airless: 0, geometry: buildModel('iss'), craft: info, noOrbit: true, poleNote: 'nadir-pointing', orbitDays: this.sats[i].periodMin / 1440,
        positionFn: (jdTDB, state, out) => layer._bodyHelio(i, jdTDB, out),
        rotationFn: (jd, b) => frameAlong(b.helio.map((v, k) => v - E()[k])),
        infoFn: () => `${info.mission} Launched ${info.launch}. ${layer.describe(i)}`,
        notes: info.mission,
      });
    }
    defs.push({
      key: 'satellite', name: 'Satellite', shortName: 'Satellite', kind: 'planet', minor: true, minorType: 'satellite', type: 'Artificial satellite',
      parent: 'sun', radius: 0.005, flat: 0, mass: null, rotHours: null, tilt: null, color: '#ffffff', albedo: 0.5, peakAlbedo: 0.9, airless: 0,
      geometry: buildModel('satellite'), noOrbit: true, poleNote: 'nadir-pointing (assumed)',
      positionFn: (jdTDB, state, out) => (layer.selected >= 0 && layer.selected !== layer.iss ? layer._bodyHelio(layer.selected, jdTDB, out) : null),
      rotationFn: (jd, b) => frameAlong(b.helio.map((v, k) => v - E()[k])),
      infoFn: () => (layer.selected >= 0 ? layer.describe(layer.selected) : ''),
      notes: '',
    });
    return defs;
  }

  /** Heliocentric km of satellite i at jdTDB (Earth is updated before appended bodies), or null. */
  _bodyHelio(i, jdTDB, out) {
    const s = this.sats[i], jdUTC = tdbToUTC(jdTDB);
    if (satValidity(s, jdUTC) === 'expired') return null;
    const T = temeToEclipticMatrix(jdTDB, jdUTC, this._bT || (this._bT = new Array(9)));
    const r = satPosition(s, jdUTC, T, this._bR || (this._bR = [0, 0, 0]));
    if (!r) return null;
    const e = this.system.byKey.earth.helio;
    out[0] = e[0] + r[0]; out[1] = e[1] + r[1]; out[2] = e[2] + r[2];
    return out;
  }

  /** Take over the stand-in body with satellite i; returns the body to focus. */
  select(i) {
    this.selected = i;
    for (let k = 0; k < this.N; k++) this.lineOn[k] = -1;          // re-write path brightness (highlight)
    if (i === this.iss) return this.system.byKey.iss;
    const b = this.system.byKey.satellite, s = this.sats[i], g = SAT_GROUPS[s.group];
    b.name = b.shortName = s.name;
    b.type = `Artificial satellite · ${g.name}`;
    b.color = g.color;
    b.orbitDays = s.periodMin / 1440;
    b.label.textContent = s.name;
    b.label.style.setProperty('--c', g.color);
    return b;
  }

  findNorad(norad) { return this.sats.findIndex((s) => s.norad === +norad); }

  /** Live description for the info panel. */
  describe(i) {
    const s = this.sats[i], jdUTC = this._jdUTC ?? s.epoch, g = SAT_GROUPS[s.group];
    const o = satOrbitSummary(s), age = jdUTC - s.epoch, v = satValidity(s, jdUTC);
    const ep = `${jdToUTCString(s.epoch, false)} UTC`;
    const parts = [`NORAD ${s.norad} · COSPAR ${s.intl} · ${g.name}.`];
    if (v === 'expired') {
      parts.push(`Not shown on this date: its elements are from ${ep} and are only used within ±${MAX_DAYS} days of that (SGP4 errors grow by kilometres per day). Re-run "node fetch-data.mjs --satellites" for current elements.`);
      return parts.join(' ');
    }
    const p = [0, 0, 0], vel = [0, 0, 0];
    if (satPosition(s, jdUTC, temeToEclipticMatrix(utcToTDB(jdUTC), jdUTC), p, vel)) {
      const r = Math.hypot(...p), eh = this.system.byKey.earth.helio, en = Math.hypot(...eh);
      const along = -(p[0] * eh[0] + p[1] * eh[1] + p[2] * eh[2]) / en;
      const lit = along > 0 || Math.sqrt(Math.max(0, r * r - along * along)) > R_EARTH;
      parts.push(`Altitude ${Math.round(r - R_EARTH).toLocaleString('en-US')} km, speed ${Math.hypot(...vel).toFixed(2)} km/s (relative to Earth), ${lit ? 'in sunlight' : 'in Earth’s shadow'}.`);
    }
    parts.push(`Orbit ${Math.round(o.perigee).toLocaleString('en-US')} × ${Math.round(o.apogee).toLocaleString('en-US')} km, inclination ${o.incl.toFixed(1)}°, period ${o.periodMin < 200 ? o.periodMin.toFixed(1) + ' min' : (o.periodMin / 60).toFixed(2) + ' h'}.`);
    const d = Math.abs(age);
    parts.push(`SGP4 from CelesTrak elements of ${ep} (${d < 1 ? (d * 24).toFixed(1) + ' h' : d.toFixed(1) + ' days'} ${age >= 0 ? 'ago' : 'ahead'}).`);
    parts.push(v === 'fresh' ? 'Typical error: ~1 km at the element epoch, growing by ~1–3 km per day in low orbit.'
      : `⚠ More than ${FRESH_DAYS} days from the element epoch: position approximate (low orbits: tens of km or more).`);
    return parts.join(' ');
  }

  // ---------------------------------------------------------------------------
  update(jdTDB, jdUTC, scale, camPos, camera, gain, width, height) {
    const earth = this.system.byKey.earth;
    this._jdUTC = jdUTC;
    // Only near Earth: from far away every satellite is inside Earth's marker.
    const fade = Math.min(1, Math.max(0, (earth.pixelRadius - 2) / 10));
    const on = !this.hidden && fade > 0 && this.N > 0;
    this.points.visible = on && this.settings.points;
    this.paths.visible = on && this.settings.paths && this.overlay;
    if (!on) { for (const l of this.labels) l.el.style.display = 'none'; this.active = false; return; }
    this.active = true;
    const T = temeToEclipticMatrix(jdTDB, jdUTC, this.T);
    // Sun direction from Earth (ecliptic), for the shadow test.
    const eh = earth.helio, en = Math.hypot(eh[0], eh[1], eh[2]);
    const sx = -eh[0] / en, sy = -eh[1] / en, sz = -eh[2] / en;
    const pos = this.points.geometry.attributes.position.array, pon = this.points.geometry.attributes.aOn.array;
    const r = [0, 0, 0];
    this.counts = { shown: 0, approx: 0, expired: 0 };
    for (let i = 0; i < this.N; i++) {
      const s = this.sats[i];
      const val = satValidity(s, jdUTC);
      if (val === 'expired') this.counts.expired++;
      if (!this.visible[s.group] && i !== this.selected) { this.state[i] = 0; pon[i] = 0; continue; }
      const p = val === 'expired' ? null : satPosition(s, jdUTC, T, r);
      if (!p) { this.state[i] = 0; pon[i] = 0; continue; }
      this.state[i] = val === 'fresh' ? 2 : 1;
      if (val === 'approx') this.counts.approx++;
      this.counts.shown++;
      this.rel.set(p, i * 3);
      // Cylindrical Earth shadow.
      const along = p[0] * sx + p[1] * sy + p[2] * sz;
      const lit = along > 0 || Math.hypot(p[0] - along * sx, p[1] - along * sy, p[2] - along * sz) > R_EARTH;
      pos[i * 3] = p[0]; pos[i * 3 + 1] = p[2]; pos[i * 3 + 2] = -p[1];          // ecliptic → three axes
      pon[i] = i === this.iss ? 0 : (lit ? 1 : 0.28) * (val === 'fresh' ? 1 : 0.5); // the ISS body draws itself
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.aOn.needsUpdate = true;
    if (this.paths.visible) {
      const E0 = earth.scenePos;
      this._updatePaths(jdUTC, T, scale, [camPos[0] - E0[0], camPos[1] - E0[1], camPos[2] - E0[2]]);
    }
    // Shared uniforms: mapping, floating origin, exposure.
    const rf = scale.radiusFactor('planet');
    for (const m of [this.pointMat, this.pathMat]) {
      const u = m.uniforms;
      u.uS.value = scale.s; u.uRf.value = rf; u.uPm.value = scale.pm; u.uClampR.value = (R_EARTH + 0.01) * rf * 1.15;
      u.uGain.value = gain * (m === this.pathMat ? 0.85 : fade);
    }
    this.pathMat.uniforms.uAlpha.value = fade * Math.min(1, this.settings.pathGain);
    this.pointMat.uniforms.uSize.value = this.settings.size;
    this.pathMat.uniforms.uNow.value = (jdUTC - this.tRef) * 1440;
    this.pathMat.uniforms.uVis.value = this.visible.map((x) => (x ? 1 : 0));
    const E = earth.scenePos;
    this.points.position.set(E[0] - camPos[0], E[1] - camPos[1], E[2] - camPos[2]);
    this.paths.position.copy(this.points.position);
    this._updateLabels(scale, camera, width, height);
  }

  /**
   * Re-sample stale paths within the frame budget, most urgent first: staleness, boosted for the selected /
   * focused satellite and those near the camera (at high time rates not every path can keep up; the ones
   * you are looking at do). Then set per-path brightness.
   */
  _updatePaths(jdUTC, T, scale, camRel) {
    const g = this.paths.geometry, pa = g.attributes.position, ta = g.attributes.aT, oa = g.attributes.aOn;
    const t0 = performance.now(), m = [0, 0, 0];
    // Staleness in units of the drift tolerance: low orbits turn fastest (J2 nodal regression).
    const cand = [];
    for (let i = 0; i < this.N; i++) {
      if (!this.state[i] || !this.visible[this.sats[i].group]) continue;
      const P = this.sats[i].periodMin, tol = P < 200 ? 2 / 1440 : P < 1000 ? 30 / 1440 : 0.125;
      let st = Number.isNaN(this.lineJd[i]) ? Infinity : Math.abs(jdUTC - this.lineJd[i]) / tol;
      if (!(st > 1)) continue;
      if (i === this.selected || (i === this.iss && this.focusIss)) st *= 1e4;
      else {
        nearEarthToScene([this.rel[i * 3], this.rel[i * 3 + 1], this.rel[i * 3 + 2]], scale, m);
        const d = Math.hypot(m[0] - camRel[0], m[1] - camRel[1], m[2] - camRel[2]);
        st *= 1 + 100 * Math.exp(-d / (2 * R_EARTH * scale.radiusFactor('planet')));
      }
      cand.push([st, i]);
    }
    cand.sort((a, b) => b[0] - a[0]);
    const r = [0, 0, 0];
    let lo = Infinity, hi = -1;
    for (const [, i] of cand) {
      if (performance.now() - t0 > LINE_BUDGET_MS) break;
      const s = this.sats[i], P = s.periodMin / 1440;
      let ok = true;
      // From LEAD of an orbit ahead to the rest behind: between refreshes the satellite moves along freshly
      // sampled path, not along the orbit-ago tail (the plane has turned since: 16 km off for the ISS).
      for (let k = 0; k < NS; k++) {
        const t = jdUTC + (LEAD - k / (NS - 1)) * P;
        if (!satPosition(s, t, T, r)) { ok = false; break; }
        const j = (i * NS + k) * 3;
        pa.array[j] = r[0]; pa.array[j + 1] = r[2]; pa.array[j + 2] = -r[1];
        ta.array[i * NS + k] = (t - this.tRef) * 1440;
      }
      this.lineJd[i] = ok ? jdUTC : NaN;
      if (!ok) this.state[i] = 0;
      this.lineOn[i] = -1;
      lo = Math.min(lo, i); hi = Math.max(hi, i);
    }
    if (hi >= 0) {
      pa.clearUpdateRanges(); ta.clearUpdateRanges();
      pa.addUpdateRange(lo * NS * 3, (hi - lo + 1) * NS * 3); ta.addUpdateRange(lo * NS, (hi - lo + 1) * NS);
      pa.needsUpdate = true; ta.needsUpdate = true;
    }
    // Per-path brightness: hidden, stale (≫ tolerance: e.g. right after a date jump), approximate, fresh, selected.
    let changed = false;
    for (let i = 0; i < this.N; i++) {
      const P = this.sats[i].periodMin, tol = P < 200 ? 2 / 1440 : P < 1000 ? 30 / 1440 : 0.125;
      const stale = Number.isNaN(this.lineJd[i]) || Math.abs(jdUTC - this.lineJd[i]) > 60 * tol;
      const want = !this.state[i] || stale ? 0 : (i === this.selected ? 2.5 : this.state[i] === 2 ? 1 : 0.45);
      if (want !== this.lineOn[i]) { oa.array.fill(want, i * NS, (i + 1) * NS); this.lineOn[i] = want; changed = true; }
    }
    if (changed) { oa.clearUpdateRanges(); oa.needsUpdate = true; }
  }

  _updateLabels(scale, camera, width, height) {
    const earth = this.system.byKey.earth, show = this.settings.labels && this.overlay && earth.camDist < 60 * earth.rScene;
    const v = new THREE.Vector3(), m = [0, 0, 0];
    for (const { i, el } of this.labels) {
      if (!show || !this.state[i] || !this.visible[this.sats[i].group] || i === this.selected) { el.style.display = 'none'; continue; }
      nearEarthToScene([this.rel[i * 3], this.rel[i * 3 + 1], this.rel[i * 3 + 2]], scale, m);
      v.set(m[0] + this.points.position.x, m[1] + this.points.position.y, m[2] + this.points.position.z).applyMatrix4(camera.matrixWorldInverse);
      const front = v.z < 0;
      v.applyMatrix4(camera.projectionMatrix);
      const okk = front && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      el.style.display = okk ? 'block' : 'none';
      if (okk) el.style.transform = `translate(${((v.x * 0.5 + 0.5) * width + 6).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * height - 16).toFixed(1)}px)`;
    }
  }

  /** Nearest visible satellite within `radius` px of (x, y): { i (−1 if none), dist (scene units from the camera) }. */
  pick(x, y, scale, camera, width, height, radius = 10) {
    if (!this.active || !this.points.visible) return { i: -1, dist: Infinity };
    const v = new THREE.Vector3(), m = [0, 0, 0];
    let best = -1, bestD = Infinity;
    for (let i = 0; i < this.N; i++) {
      if (!this.state[i] || !this.visible[this.sats[i].group]) continue;
      nearEarthToScene([this.rel[i * 3], this.rel[i * 3 + 1], this.rel[i * 3 + 2]], scale, m);
      v.set(m[0] + this.points.position.x, m[1] + this.points.position.y, m[2] + this.points.position.z);
      const dist = v.length();
      v.applyMatrix4(camera.matrixWorldInverse);
      if (v.z >= 0) continue;
      v.applyMatrix4(camera.projectionMatrix);
      const d = Math.hypot((v.x * 0.5 + 0.5) * width - x, (-v.y * 0.5 + 0.5) * height - y);
      if (d < radius && dist < bestD) { best = i; bestD = dist; }
    }
    return { i: best, dist: bestD };
  }

  setVisibility(key, on) { const i = SAT_GROUPS.findIndex((g) => g.key === key); if (i >= 0) this.visible[i] = on; }
  groupCount(i) { return this.sats.filter((s) => s.group === i).length; }
}
