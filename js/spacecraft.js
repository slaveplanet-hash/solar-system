// =============================================================================
// spacecraft.js — Spacecraft from JPL Horizons vectors as full bodies:
//   • procedural models (one merged geometry; UVs index a small colour palette so the
//     regular surface shader — sunlight, eclipses, exposure — lights them),
//   • attitude rules (high-gain antenna → Earth, sunshield/heat shield → Sun, ISS nadir),
//   • positions from the tracks; after the data ends, escaping craft continue on a
//     straight line (hyperbolic, v ≫ escape speed), bound craft go offline,
//   • fading trajectory trails (heliocentric, or in the host planet's frame for
//     Earth/Jupiter-centred segments: JWST halo orbit, ISS, Juno),
//   • a live info line (launch date, distances, light time, speed).
// =============================================================================
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { AU_KM, C_KM_S } from './ephemeris.js';
import { tdbToUTC, jdToUTCString } from './time.js';

const GM_SUN = 1.32712440018e11;           // km³/s²
// Palette cells (u = (i + 0.5) / 8): gold foil, white, dark grey, solar cell, silver, black, sunshield, mirror gold.
const PALETTE = [[0.83, 0.62, 0.25], [0.86, 0.86, 0.84], [0.22, 0.22, 0.24], [0.07, 0.1, 0.26],
  [0.62, 0.63, 0.66], [0.04, 0.04, 0.05], [0.78, 0.72, 0.86], [0.95, 0.72, 0.28]];
const GOLD = 0, WHITE = 1, DARK = 2, CELL = 3, SILVER = 4, BLACK = 5, SHIELD = 6, MIRROR = 7;

export const CRAFT = {
  voyager1:    { name: 'Voyager 1', launch: '1977-09-05', style: 'voyager', span: 13, point: 'earth', color: '#b8ffb8', mission: 'Jupiter & Saturn flybys; in interstellar space since 2012.' },
  voyager2:    { name: 'Voyager 2', launch: '1977-08-20', style: 'voyager', span: 13, point: 'earth', color: '#b8ffb8', mission: 'The only visitor to Uranus (1986) and Neptune (1989); interstellar since 2018.' },
  pioneer10:   { name: 'Pioneer 10', launch: '1972-03-03', style: 'pioneer', span: 6, point: 'earth', color: '#b8ffb8', mission: 'First Jupiter flyby (1973); contact lost 2003.' },
  pioneer11:   { name: 'Pioneer 11', launch: '1973-04-06', style: 'pioneer', span: 6, point: 'earth', color: '#b8ffb8', mission: 'First Saturn flyby (1979); contact lost 1995.' },
  newhorizons: { name: 'New Horizons', launch: '2006-01-19', style: 'newhorizons', span: 3, point: 'earth', color: '#b8ffb8', mission: 'Pluto flyby 2015-07-14, Arrokoth 2019-01-01.' },
  parker:      { name: 'Parker Solar Probe', launch: '2018-08-12', style: 'parker', span: 3, point: 'sun', color: '#ffd9a0', mission: 'Closest approach 6.9 million km from the Sun (0.046 AU), the fastest human-made object.' },
  jwst:        { name: 'James Webb Space Telescope', launch: '2021-12-25', style: 'jwst', span: 21, point: 'sun', color: '#ffe7a0', mission: 'Halo orbit around the Sun–Earth L2 point, ~1.5 million km beyond Earth.' },
  juno:        { name: 'Juno', launch: '2011-08-05', style: 'juno', span: 20, point: 'earth', color: '#b8ffb8', mission: 'Polar orbiter of Jupiter since 2016-07-05.' },
  clipper:     { name: 'Europa Clipper', launch: '2024-10-14', style: 'clipper', span: 30.5, point: 'earth', color: '#b8ffb8', mission: 'En route to Jupiter (arrival 2030) for ~49 Europa flybys.' },
  iss:         { name: 'International Space Station', launch: '1998-11-20', style: 'iss', span: 109, point: 'zenith', color: '#d8f0ff', mission: 'Low Earth orbit, ~420 km up, one orbit every ~92 minutes.' },
};

// ---------------------------------------------------------------------------------------------
// Models (unit: the model's largest half-extent ≈ 1; local +Y = pointing axis)
// ---------------------------------------------------------------------------------------------
function part(geo, cell) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const uv = new Float32Array(g.attributes.position.count * 2);
  for (let i = 0; i < uv.length; i += 2) { uv[i] = (cell + 0.5) / PALETTE.length; uv[i + 1] = 0.5; }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
  return g;
}
const box = (w, h, d, x, y, z, cell, rot) => { const g = new THREE.BoxGeometry(w, h, d); if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot))); g.translate(x, y, z); return part(g, cell); };
const cyl = (rt, rb, h, x, y, z, cell, rot, seg = 16) => { const g = new THREE.CylinderGeometry(rt, rb, h, seg); if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...rot))); g.translate(x, y, z); return part(g, cell); };
function dish(r, depth, y, cell) {
  const pts = [];
  for (let i = 0; i <= 10; i++) { const u = i / 10; pts.push(new THREE.Vector2(u * r, depth * u * u)); }
  const g = new THREE.LatheGeometry(pts, 32);
  g.translate(0, y, 0);
  return part(g, cell);
}
function hexPanel(r, y, cell, tilt = 0) {
  const g = new THREE.CylinderGeometry(r, r, 0.02, 6);
  if (tilt) g.rotateX(tilt);
  g.translate(0, y, 0);
  return part(g, cell);
}

function buildModel(style) {
  const P = [];
  switch (style) {
    case 'voyager':           // 3.7 m dish on a decagonal bus, RTG boom, magnetometer boom (13 m)
      P.push(dish(0.28, 0.07, 0.12, WHITE), cyl(0.16, 0.16, 0.1, 0, 0.05, 0, GOLD, null, 10),
        cyl(0.015, 0.015, 0.35, -0.25, 0, 0, SILVER, [0, 0, Math.PI / 2]), cyl(0.04, 0.04, 0.12, -0.42, 0, 0, DARK, [0, 0, Math.PI / 2]),
        cyl(0.012, 0.012, 0.25, 0.2, -0.02, 0.05, SILVER, [0, 0, Math.PI / 2]), cyl(0.005, 0.005, 1.0, 0.1, 0, -0.5, SILVER, [Math.PI / 2, 0, 0]));
      break;
    case 'pioneer':           // 2.74 m dish, hexagonal bus, two RTG booms
      P.push(dish(0.46, 0.1, 0.12, WHITE), hexPanel(0.2, 0.05, GOLD), cyl(0.012, 0.012, 0.6, 0.4, 0, 0, SILVER, [0, 0, Math.PI / 2]),
        cyl(0.012, 0.012, 0.6, -0.4, 0, 0, SILVER, [0, 0, Math.PI / 2]), cyl(0.05, 0.05, 0.12, 0.72, 0, 0, DARK, [0, 0, Math.PI / 2]),
        cyl(0.05, 0.05, 0.12, -0.72, 0, 0, DARK, [0, 0, Math.PI / 2]));
      break;
    case 'newhorizons':       // triangular body, 2.1 m dish, single RTG
      P.push(dish(0.7, 0.15, 0.3, WHITE), cyl(0.45, 0.45, 0.35, 0, 0.1, 0, GOLD, null, 3), cyl(0.09, 0.09, 0.7, 0.55, 0, 0.1, DARK, [0, 0, Math.PI / 2]));
      break;
    case 'parker':            // 2.3 m carbon heat shield facing the Sun (+Y), bus behind, two small arrays
      P.push(cyl(0.77, 0.77, 0.08, 0, 0.35, 0, WHITE, null, 32), cyl(0.25, 0.3, 0.6, 0, -0.05, 0, DARK, null, 6),
        box(0.5, 0.02, 0.2, 0.5, -0.2, 0, CELL), box(0.5, 0.02, 0.2, -0.5, -0.2, 0, CELL), cyl(0.01, 0.01, 0.6, 0, -0.6, 0, SILVER));
      break;
    case 'jwst':              // 21×14 m five-layer sunshield (normal +Y toward the Sun), 6.5 m gold mirror above
      P.push(box(1.0, 0.02, 0.66, 0, 0, 0, SHIELD, [0, Math.PI / 4, 0]), box(0.98, 0.02, 0.64, 0, -0.03, 0, SHIELD, [0, Math.PI / 4, 0]),
        box(0.3, 0.12, 0.3, 0, 0.1, 0, DARK), hexPanel(0.16, -0.25, MIRROR, Math.PI / 2 * 0.9), cyl(0.008, 0.008, 0.2, 0, -0.14, 0.12, SILVER, [Math.PI / 4, 0, 0]),
        box(0.25, 0.02, 0.1, 0.35, 0.05, -0.3, CELL));
      break;
    case 'juno':              // three 9 m solar arrays around a hexagonal bus, HGA on top (+Y → Earth)
      P.push(hexPanel(0.18, 0, DARK), cyl(0.18, 0.18, 0.12, 0, 0.02, 0, GOLD, null, 6), dish(0.12, 0.03, 0.09, WHITE));
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        const g = new THREE.BoxGeometry(0.85, 0.02, 0.13); g.translate(0.6, 0, 0); g.rotateY(a);
        P.push(part(g, CELL));
      }
      break;
    case 'clipper':           // 30.5 m solar arrays, 3 m HGA, long body
      P.push(cyl(0.05, 0.05, 0.25, 0, -0.05, 0, GOLD, null, 12), dish(0.1, 0.02, 0.08, WHITE),
        box(0.45, 0.01, 0.1, 0.3, -0.05, 0, CELL), box(0.45, 0.01, 0.1, -0.3, -0.05, 0, CELL),
        box(0.45, 0.01, 0.1, 0.78, -0.05, 0, CELL), box(0.45, 0.01, 0.1, -0.78, -0.05, 0, CELL));
      break;
    case 'iss':               // 109 m truss (x), 8 solar array wings, pressurised modules along −z/+z, radiators
      P.push(box(1.0, 0.03, 0.03, 0, 0, 0, SILVER), box(0.05, 0.05, 0.5, 0, -0.03, 0, WHITE), cyl(0.04, 0.04, 0.3, 0, -0.03, 0.4, WHITE, [Math.PI / 2, 0, 0]));
      for (const x of [-0.85, -0.6, 0.6, 0.85]) P.push(box(0.12, 0.005, 0.68, x, 0, 0, CELL));
      for (const x of [-0.25, 0.25]) P.push(box(0.1, 0.005, 0.25, x, -0.05, 0.1, WHITE));
      break;
    default:
      P.push(box(0.4, 0.4, 0.4, 0, 0, 0, GOLD));
  }
  const g = mergeGeometries(P, false);
  g.computeBoundingSphere();
  return g;
}

let _palette = null;
export function paletteTexture() {
  if (_palette) return _palette;
  const data = new Uint8Array(PALETTE.length * 4);
  PALETTE.forEach((c, i) => { data.set([c[0] * 255, c[1] * 255, c[2] * 255, 255].map(Math.round), i * 4); });
  _palette = new THREE.DataTexture(data, PALETTE.length, 1, THREE.RGBAFormat);
  _palette.colorSpace = THREE.SRGBColorSpace;
  _palette.magFilter = _palette.minFilter = THREE.NearestFilter;
  _palette.needsUpdate = true;
  return _palette;
}

// ---------------------------------------------------------------------------------------------
// Positions & attitude
// ---------------------------------------------------------------------------------------------
const _st = { center: 10, pos: [0, 0, 0], vel: [0, 0, 0] };

/** Heliocentric km at jd, or null (not launched / bound craft after the data ends). Sets out.vel (km/s, helio). */
function craftState(track, jd, state, out, vel) {
  const hostOf = (c) => (c === 399 ? state.earth : c === 599 ? state.jupiter : null);
  let s = track.stateAt(jd, _st);
  if (!s) {
    if (jd < track.start) return null;
    // After the data: straight line from the last heliocentric state if it is on an escape trajectory.
    const last = track.lastHelio;
    if (!last) return null;
    const dt = (jd - last[0]) * 86400;
    for (let k = 0; k < 3; k++) { out[k] = last[1 + k] + last[4 + k] * dt; vel[k] = last[4 + k]; }
    return out;
  }
  const host = hostOf(s.center);
  for (let k = 0; k < 3; k++) { out[k] = s.pos[k] + (host ? host[k] : 0); vel[k] = s.vel[k]; }
  return out;
}

/** Last heliocentric state if hyperbolic w.r.t. the Sun (v² > 2μ/r), else null. */
function escapingTail(track) {
  const segs = track.segments.filter((s) => s.center === 10);
  if (!segs.length) return null;
  const seg = segs.reduce((a, b) => (b.stop > a.stop ? b : a));
  if (seg.stop < track.stop - 1) return null;                    // the data ends in a planet-centred segment
  const r = seg.rows[seg.rows.length - 1];
  const rr = Math.hypot(r[1], r[2], r[3]), v2 = r[4] ** 2 + r[5] ** 2 + r[6] ** 2;
  return v2 > (2 * GM_SUN) / rr ? r : null;
}

/** body→ecliptic 3×3 (row-major, columns = body axes); body z (mesh +Y) along `p`, x ⟂ p in the ecliptic plane. */
function frameAlong(p) {
  const n = Math.hypot(...p) || 1, z = p.map((v) => v / n);
  let x = [-z[1], z[0], 0];
  if (Math.hypot(...x) < 1e-6) x = [1, 0, 0];
  const xn = Math.hypot(...x); x = x.map((v) => v / xn);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

// ---------------------------------------------------------------------------------------------
// Body definitions
// ---------------------------------------------------------------------------------------------
export function buildSpacecraftDefs(data, system) {
  const defs = [], trackIds = new Set();
  if (!data?.available) return { defs, trackIds };
  for (const track of Object.values(data.tracks)) {
    if (track.kind !== 'spacecraft') continue;
    const info = CRAFT[track.id] || { name: track.name, launch: null, style: 'generic', span: 5, point: 'earth', color: '#b8ffb8', mission: '' };
    trackIds.add(track.id);
    track.lastHelio = escapingTail(track);
    const vel = [0, 0, 0];
    const E = () => system.byKey.earth.helio;      // Earth is updated before appended bodies in SolarSystem.update
    defs.push({
      key: track.id, name: info.name, shortName: info.name, kind: 'planet', minor: true, minorType: 'spacecraft',
      type: 'Spacecraft', parent: 'sun', radius: info.span / 2000, flat: 0, mass: null, rotHours: null, tilt: null,
      color: info.color, albedo: 0.5, peakAlbedo: 0.9, airless: 0, geometry: buildModel(info.style), track, craft: info, vel, noOrbit: true,
      poleNote: info.point === 'sun' ? 'shield → Sun' : info.point === 'zenith' ? 'nadir-pointing' : 'high-gain antenna → Earth',
      positionFn: (jd, state, out) => craftState(track, jd, state, out, vel),
      rotationFn: (jd, b) => {
        if (info.point === 'sun') return frameAlong(b.helio.map((v) => -v));
        if (info.point === 'zenith') return frameAlong(b.helio.map((v, k) => v - E()[k]));
        return frameAlong(E().map((v, k) => v - b.helio[k]));
      },
      infoFn: (sys, jdTDB) => spacecraftInfo(sys.byKey[track.id], sys, jdTDB),
      notes: info.mission,
    });
  }
  return { defs, trackIds };
}

export function spacecraftInfo(b, sys, jdTDB) {
  const c = b.craft, t = b.track, earth = sys.byKey.earth.helio;
  const parts = [c.mission];
  if (c.launch) parts.push(`Launched ${c.launch}.`);
  if (b.offline) {
    parts.push(jdTDB < t.start ? `Not yet launched on this date (trajectory data starts ${jdToUTCString(tdbToUTC(t.start)).slice(0, 10)}).`
      : `Beyond the downloaded trajectory (ends ${jdToUTCString(tdbToUTC(t.stop)).slice(0, 10)}); a bound orbit is not extrapolated.`);
    return parts.join(' ');
  }
  const rS = Math.hypot(...b.helio), dE = Math.hypot(b.helio[0] - earth[0], b.helio[1] - earth[1], b.helio[2] - earth[2]);
  const v = Math.hypot(...b.vel);
  parts.push(`Now ${(rS / AU_KM).toFixed(rS > 10 * AU_KM ? 2 : 4)} AU from the Sun, ${dE < 1e7 ? Math.round(dE).toLocaleString('en-US') + ' km' : (dE / AU_KM).toFixed(3) + ' AU'} from Earth — radio signals take ${fmtLight(dE / C_KM_S)}.`);
  parts.push(`Speed ${v.toFixed(2)} km/s ${t.stateAt(jdTDB, _st)?.center === 399 ? 'relative to Earth' : t.stateAt(jdTDB, _st)?.center === 599 ? 'relative to Jupiter' : 'relative to the Sun'}.`);
  if (jdTDB > t.stop) parts.push(`Extrapolated in a straight line beyond the Horizons data (ends ${jdToUTCString(tdbToUTC(t.stop)).slice(0, 10)}).`);
  if (b.key === 'iss') parts.push(`The downloaded ISS track covers only ${jdToUTCString(tdbToUTC(t.start)).slice(0, 10)} → ${jdToUTCString(tdbToUTC(t.stop)).slice(0, 10)} (orbit decay and reboosts make longer predictions unreliable).`);
  return parts.join(' ');
}

function fmtLight(s) {
  if (s < 1) return `${(s * 1000).toFixed(0)} ms`;
  if (s < 120) return `${s.toFixed(1)} s`;
  if (s < 7200) return `${(s / 60).toFixed(1)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

// ---------------------------------------------------------------------------------------------
// Trails
// ---------------------------------------------------------------------------------------------
const HOST_WINDOW = { 399: 180, 599: 60 };            // days of trail in a planet's frame (JWST halo ~6 mo, Juno ~53 d)

// Age fade on the GPU: each vertex carries its time (days since the track start); uNow moves every frame,
// so past points are mapped to the scene only when the scale mapping changes, never per frame.
const TRAIL_MAT = () => new THREE.ShaderMaterial({
  uniforms: { uNow: { value: 0 }, uAge0: { value: 1 }, uWin: { value: 1e9 }, uColor: { value: new THREE.Color() }, uGain: { value: 1 } },
  vertexShader: `#include <common>\n#include <logdepthbuf_pars_vertex>\nattribute float aT; uniform float uNow, uAge0, uWin; varying float vA;
void main(){ float age = uNow - aT;
  vA = (age < -1e-6 || age > uWin) ? 0.0 : exp(-age / uAge0) * 0.9 + 0.1 * step(age, uAge0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n#include <logdepthbuf_vertex>\n}`,
  fragmentShader: `#include <common>\n#include <logdepthbuf_pars_fragment>\nuniform vec3 uColor; uniform float uGain; varying float vA;
void main(){\n#include <logdepthbuf_fragment>\n  if (vA <= 0.0) discard;\n  gl_FragColor = vec4(uColor * vA * uGain, 1.0); }`,
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
});

export class SpacecraftTrails {
  constructor(scene, system) {
    this.scene = scene;
    this.system = system;
    this.enabled = true;
    this.hidden = false;
    this.trails = [];
    for (const b of system.bodies) {
      if (b.minorType !== 'spacecraft') continue;
      const t0 = b.track.start;
      // One static buffer per frame of reference: heliocentric rows, and each planet-centred segment.
      const parts = [];
      const helioRows = b.track.segments.filter((s) => s.center === 10).flatMap((s) => s.rows).sort((a, c) => a[0] - c[0]);
      if (helioRows.length) parts.push({ center: 10, rows: helioRows });
      for (const s of b.track.segments) if (s.center !== 10) parts.push({ center: s.center, rows: s.rows });
      for (const p of parts) {
        const n = p.rows.length;
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        const aT = new Float32Array(n);
        p.rows.forEach((r, i) => { aT[i] = r[0] - t0; });
        geo.setAttribute('aT', new THREE.BufferAttribute(aT, 1));
        p.jd = p.rows.map((r) => r[0]);
        p.line = new THREE.Line(geo, TRAIL_MAT());
        p.line.frustumCulled = false;
        p.line.renderOrder = 6;
        p.line.material.uniforms.uColor.value.set(b.color);
        p.ver = -1;
        scene.add(p.line);
      }
      // Head: last past sample → the craft's current position (moves every frame; 2 vertices).
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
      hg.setAttribute('aT', new THREE.BufferAttribute(new Float32Array(2), 1));
      const head = new THREE.Line(hg, TRAIL_MAT());
      head.frustumCulled = false; head.renderOrder = 6;
      head.material.uniforms.uColor.value.set(b.color);
      scene.add(head);
      this.trails.push({ b, parts, head, t0 });
    }
  }

  /** Map a part's rows into the scene (once per scale version). Planet-frame parts are stored relative to the planet. */
  _map(p, scale) {
    const pos = p.line.geometry.attributes.position.array, tmp = [0, 0, 0];
    const host = p.center === 399 ? this.system.byKey.earth : p.center === 599 ? this.system.byKey.jupiter : null;
    p.host = host;
    // Heliocentric parts: relative to an anchor (float32 precision near the anchor = near the camera usually).
    p.anchor = host ? [0, 0, 0] : scale.helioToScene([p.rows[p.rows.length - 1][1], p.rows[p.rows.length - 1][2], p.rows[p.rows.length - 1][3]], [0, 0, 0]);
    for (let i = 0; i < p.rows.length; i++) {
      const r = p.rows[i];
      if (host) scale.moonOffsetToScene([r[1], r[2], r[3]], host.radius, 0.01, tmp);
      else { scale.helioToScene([r[1], r[2], r[3]], tmp); tmp[0] -= p.anchor[0]; tmp[1] -= p.anchor[1]; tmp[2] -= p.anchor[2]; }
      pos[i * 3] = tmp[0]; pos[i * 3 + 1] = tmp[1]; pos[i * 3 + 2] = tmp[2];
    }
    p.line.geometry.attributes.position.needsUpdate = true;
    p.ver = scale.version;
  }

  update(jdTDB, scale, camPos, gain) {
    const show = this.enabled && !this.hidden && this.system.show.spacecraft !== false;   // hidden: surface view
    let remaps = 0;
    for (const t of this.trails) {
      const b = t.b, track = b.track;
      const cur = track.stateAt(Math.min(Math.max(jdTDB, track.start), track.stop), _st);
      const center = cur ? cur.center : 10;
      const visible = show && jdTDB >= track.start;
      let last = null;
      for (const p of t.parts) {
        const on = visible && p.center === center;
        p.line.visible = on;
        if (!on) continue;
        // Scale changes remap at most two parts per frame (a V toggle animates for 2.5 s).
        if (p.ver !== scale.version && (p.ver < 0 || remaps < 2)) { this._map(p, scale); remaps++; }
        const host = p.host, win = host ? (b.key === 'iss' ? 0.066 : HOST_WINDOW[p.center] ?? 30) : 1e9;
        const age0 = host ? win : Math.max(60, (jdTDB - track.start) * 0.35);
        // Draw only up to "now" (binary search), and only the window for planet-frame trails.
        let lo = 0, hi = p.jd.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (p.jd[m] <= jdTDB) lo = m + 1; else hi = m; }
        const end = lo;
        let start = 0;
        if (host) { let a = 0, c = end; const from = jdTDB - win; while (a < c) { const m = (a + c) >> 1; if (p.jd[m] < from) a = m + 1; else c = m; } start = a; }
        p.line.geometry.setDrawRange(start, Math.max(0, end - start));
        const A = host ? host.scenePos : p.anchor;
        p.line.position.set(A[0] - camPos[0], A[1] - camPos[1], A[2] - camPos[2]);
        const u = p.line.material.uniforms;
        u.uNow.value = jdTDB - t.t0; u.uAge0.value = age0; u.uWin.value = win; u.uGain.value = gain * 0.8;
        if (end > 0) last = { p, i: end - 1, age0, win };
      }
      // Head segment: last drawn sample → the craft now.
      t.head.visible = visible && !!last && !b.offline;
      if (!t.head.visible) continue;
      const P = last.p, hp = t.head.geometry.attributes.position.array, ht = t.head.geometry.attributes.aT.array;
      const A = P.host ? P.host.scenePos : P.anchor, pa = P.line.geometry.attributes.position.array;
      hp[0] = pa[last.i * 3]; hp[1] = pa[last.i * 3 + 1]; hp[2] = pa[last.i * 3 + 2];
      hp[3] = b.scenePos[0] - A[0]; hp[4] = b.scenePos[1] - A[1]; hp[5] = b.scenePos[2] - A[2];
      ht[0] = P.jd[last.i] - t.t0; ht[1] = jdTDB - t.t0;
      t.head.geometry.attributes.position.needsUpdate = true; t.head.geometry.attributes.aT.needsUpdate = true;
      t.head.position.set(A[0] - camPos[0], A[1] - camPos[1], A[2] - camPos[2]);
      const hu = t.head.material.uniforms, pu = P.line.material.uniforms;
      hu.uNow.value = pu.uNow.value; hu.uAge0.value = last.age0; hu.uWin.value = last.win; hu.uGain.value = pu.uGain.value;
    }
  }
}
