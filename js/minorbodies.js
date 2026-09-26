// =============================================================================
// minorbodies.js — Individually modelled asteroids and dwarf planets (+ their moons),
// the Didymos–Dimorphos system before/after DART, and an illustrative Oort cloud.
//
// Orbits: JPL SBDB osculating elements (from /data/, two-body from each epoch) or
// JPL Horizons vectors where the data pipeline provides them (Apophis, Dysnomia).
// Shapes: procedural models with the published triaxial dimensions (shapes.js).
// Rotation: published spin poles (IAU/WGCCRE where available, otherwise the cited
// literature value); bodies with unknown poles use an ecliptic-north pole and say so.
// =============================================================================
import * as THREE from 'three';
import { AU_KM, iauMatrix, eclipticToEquatorial } from './ephemeris.js';
import { DEG, TAU, GM_SUN_AU_D, ellipticPosition, solveKeplerElliptic, perifocalToFrame } from './kepler.js';
import { J2000 } from './time.js';
import { shapeGeometry } from './shapes.js';
import { trackPosition } from './smallbodies.js';
import { DART, dimorphosRel, dimorphosOrbit } from './dart.js';

const K = Math.sqrt(GM_SUN_AU_D);

// pdes → physical/rotation data. axes = semi-axes a ≥ b ≥ c (km). pole: {ra, dec} (ICRF) or {lam, bet} (ecliptic),
// right-hand-rule spin pole; W0 (deg at J2000) + 360°/P per day unless given. poleNote documents the source.
export const MINOR_BODIES = {
  // --- dwarf planets ---
  '1':      { key: 'ceres', name: 'Ceres', minorType: 'dwarf', type: 'Dwarf planet (main belt)', axes: [482.1, 482.1, 445.9], mass: 9.3835e20,
              rotHours: 9.074170, pole: { ra: 291.418, dec: 66.764 }, W0: 170.65, rate: 952.1532, style: 'sphere', proc: 'ceres', color: '#a19c95', poleNote: 'IAU WGCCRE 2015' },
  '136199': { key: 'eris', name: 'Eris', minorType: 'dwarf', type: 'Dwarf planet (scattered disc)', axes: [1163, 1163, 1163], mass: 1.6466e22,
              rotHours: 15.786 * 24, lockedTo: 'dysnomia', style: 'sphere', proc: 'eris', color: '#f2f2ef', poleNote: 'synchronous with Dysnomia (Szakáts 2023)' },
  '136108': { key: 'haumea', name: 'Haumea', minorType: 'dwarf', type: 'Dwarf planet (Kuiper belt)', axes: [1161, 852, 513], mass: 4.006e21,
              rotHours: 3.915341, pole: { ra: 285.1, dec: -10.6 }, W0: 0, style: 'smooth', proc: 'haumea', color: '#e8eaee', rings: 'haumea',
              poleNote: 'ring/Hiʻiaka-orbit pole (Ortiz 2017), approximate' },
  '136472': { key: 'makemake', name: 'Makemake', minorType: 'dwarf', type: 'Dwarf planet (Kuiper belt)', axes: [717, 717, 710], mass: 3.1e21,
              rotHours: 22.8266, pole: null, style: 'sphere', proc: 'makemake', color: '#e9d2bd', poleNote: 'pole unknown — assumed ecliptic north' },
  '225088': { key: 'gonggong', name: 'Gonggong', minorType: 'dwarf', type: 'Dwarf planet candidate (scattered disc)', axes: [615, 615, 615], mass: 1.75e21,
              rotHours: 22.40, pole: null, style: 'sphere', proc: 'redtno', color: '#b8755a', poleNote: 'pole unknown — assumed ecliptic north' },
  '50000':  { key: 'quaoar', name: 'Quaoar', minorType: 'dwarf', type: 'Dwarf planet candidate (Kuiper belt)', axes: [555, 555, 555], mass: 1.2e21,
              rotHours: 17.6788, pole: null, style: 'sphere', proc: 'redtno', color: '#a97a62', poleNote: 'pole unknown — assumed ecliptic north' },
  '90377':  { key: 'sedna', name: 'Sedna', minorType: 'dwarf', type: 'Dwarf planet candidate (detached)', axes: [497, 497, 497], mass: null,
              rotHours: 10.273, pole: null, style: 'sphere', proc: 'redtno', color: '#c0624a', poleNote: 'pole unknown — assumed ecliptic north' },
  '90482':  { key: 'orcus', name: 'Orcus', minorType: 'dwarf', type: 'Dwarf planet candidate (plutino)', axes: [455, 455, 455], mass: 6.35e20,
              rotHours: 9.54 * 24, pole: null, style: 'sphere', proc: 'orcus', color: '#a7a9ad', poleNote: 'pole unknown — assumed ecliptic north' },
  // --- named asteroids ---
  '4':      { key: 'vesta', name: 'Vesta', minorType: 'asteroid', type: 'Asteroid (V-type, main belt)', axes: [286.3, 278.6, 223.2], mass: 2.59e20,
              rotHours: 5.342128, pole: { ra: 309.031, dec: 42.235 }, W0: 285.39, rate: 1617.3329428, style: 'basin', proc: 'vesta', color: '#c9c2b7', poleNote: 'IAU WGCCRE 2015' },
  '2':      { key: 'pallas', name: 'Pallas', minorType: 'asteroid', type: 'Asteroid (B-type, main belt)', axes: [275, 258, 238], mass: 2.04e20,
              rotHours: 7.8132, pole: { lam: 30, bet: -16 }, W0: 0, style: 'lumpy', proc: 'pallas', color: '#9aa0aa', poleNote: 'Carry et al. 2010 (approximate)' },
  '10':     { key: 'hygiea', name: 'Hygiea', minorType: 'asteroid', type: 'Asteroid (C-type, main belt)', axes: [225, 215, 212], mass: 8.74e19,
              rotHours: 13.83, pole: { lam: 312, bet: -42 }, W0: 0, style: 'lumpy', proc: 'darkrock', color: '#8a8580', poleNote: 'Vernazza et al. 2019 (approximate)' },
  '16':     { key: 'psyche', name: 'Psyche', minorType: 'asteroid', type: 'Asteroid (M-type, metal-rich)', axes: [139, 119, 85.5], mass: 2.29e19,
              rotHours: 4.195948, pole: { lam: 32, bet: -7 }, W0: 0, style: 'lumpy', proc: 'psyche', color: '#a3a6ad', poleNote: 'Shepard et al. 2017' },
  '433':    { key: 'eros', name: 'Eros', minorType: 'asteroid', type: 'Near-Earth asteroid (Amor, S-type)', axes: [17.2, 5.6, 5.6], mass: 6.687e15,
              rotHours: 5.270, pole: { ra: 11.35, dec: 17.22 }, W0: 326.07, rate: 1639.38864745, style: 'banana', proc: 'eros', color: '#c2ad8c', poleNote: 'IAU WGCCRE 2015' },
  '101955': { key: 'bennu', name: 'Bennu', minorType: 'asteroid', type: 'Near-Earth asteroid (Apollo, B-type) — OSIRIS-REx', axes: [0.2825, 0.2675, 0.254], mass: 7.329e10,
              rotHours: 4.296057, pole: { ra: 85.46, dec: -60.36 }, W0: 0, style: 'top', proc: 'rubble', color: '#77736e', poleNote: 'Lauretta et al. 2019' },
  '162173': { key: 'ryugu', name: 'Ryugu', minorType: 'asteroid', type: 'Near-Earth asteroid (Apollo, Cb-type) — Hayabusa2', axes: [0.52, 0.51, 0.438], mass: 4.5e11,
              rotHours: 7.6326, pole: { lam: 179.3, bet: -87.44 }, W0: 0, style: 'top', proc: 'rubble', color: '#6f6b67', poleNote: 'Watanabe et al. 2019' },
  '25143':  { key: 'itokawa', name: 'Itokawa', minorType: 'asteroid', type: 'Near-Earth asteroid (Apollo, S-type) — Hayabusa', axes: [0.2675, 0.147, 0.1045], mass: 3.51e10,
              rotHours: 12.1324, pole: { lam: 128.5, bet: -89.66 }, W0: 0, style: 'peanut', proc: 'itokawa', color: '#a99b86', poleNote: 'Demura et al. 2006' },
  '65803':  { key: 'didymos', name: 'Didymos', minorType: 'asteroid', type: 'Near-Earth binary asteroid (Apollo) — DART target', axes: [0.4255, 0.4245, 0.31], mass: 5.3e11,
              rotHours: 2.2600, pole: { lam: 310, bet: -84 }, W0: 0, style: 'top', proc: 'darkrock', color: '#8b8781', poleNote: 'Naidu et al. 2020' },
  '99942':  { key: 'apophis', name: 'Apophis', minorType: 'asteroid', type: 'Potentially hazardous asteroid (Aten/Apollo, Sq-type)', axes: [0.225, 0.165, 0.14], mass: 4.0e10,
              rotHours: 30.56, pole: { lam: 250, bet: -75 }, W0: 0, style: 'lumpy', proc: 'eros', color: '#ff6a4a', poleNote: 'tumbling (NPA); principal period only (Pravec 2014)' },
  '3200':   { key: 'phaethon', name: 'Phaethon', minorType: 'asteroid', type: 'Near-Earth asteroid (Apollo, B-type) — Geminid parent', axes: [2.9, 2.6, 2.3], mass: 1.4e14,
              rotHours: 3.6039, pole: { lam: 318, bet: -47 }, W0: 0, style: 'top', proc: 'darkrock', color: '#8b8f96', poleNote: 'Hanuš et al. 2016' },
};

const meanRadius = (ax) => Math.cbrt(ax[0] * ax[1] * ax[2]);

/** Rotation matrix function for a body: IAU-style W(d) about the right-hand-rule pole. */
function rotationFn(info) {
  let ra, dec;
  if (info.pole?.ra !== undefined) ({ ra, dec } = info.pole);
  else if (info.pole?.lam !== undefined) [ra, dec] = eclipticToEquatorial(info.pole.lam, info.pole.bet);
  else [ra, dec] = eclipticToEquatorial(0, 90);                  // unknown: ecliptic north (documented)
  const rate = info.rate ?? 360 / (info.rotHours / 24);
  const W0 = info.W0 ?? 0;
  return (jdTDB) => iauMatrix(ra, dec, W0 + rate * (jdTDB - J2000));
}

/** Heliocentric km from SBDB-style elements {a, e, i, om, w, ma, epoch} (float64 two-body). */
function elementPosition(el) {
  const n = K / el.a ** 1.5;
  const tmp = [0, 0, 0];
  return (jdTDB, state, out = [0, 0, 0]) => {
    ellipticPosition(el.a, el.e, el.i * DEG, el.om * DEG, el.w * DEG, el.ma * DEG + n * (jdTDB - el.epoch), tmp);
    out[0] = tmp[0] * AU_KM; out[1] = tmp[1] * AU_KM; out[2] = tmp[2] * AU_KM;
    return out;
  };
}

/** Orbit path (heliocentric km) of the current osculating ellipse, starting at the body, shifted to pass through `now`. */
function elementOrbit(el, getNow) {
  const n = K / el.a ** 1.5, tmp = [0, 0, 0];
  const a = el.a * AU_KM, b = a * Math.sqrt(1 - el.e * el.e);
  return (jdTDB, N) => {
    const M = el.ma * DEG + n * (jdTDB - el.epoch);
    const E0 = solveKeplerElliptic(M, el.e);
    perifocalToFrame(a * (Math.cos(E0) - el.e), b * Math.sin(E0), el.w * DEG, el.i * DEG, el.om * DEG, tmp);
    const now = getNow();
    const off = [now[0] - tmp[0], now[1] - tmp[1], now[2] - tmp[2]];      // e.g. Horizons vs two-body for Apophis
    const pts = [];
    for (let k = 0; k < N; k++) {
      const E = E0 - (k / (N - 1)) * TAU;
      perifocalToFrame(a * (Math.cos(E) - el.e), b * Math.sin(E), el.w * DEG, el.i * DEG, el.om * DEG, tmp);
      pts.push([tmp[0] + off[0], tmp[1] + off[1], tmp[2] + off[2]]);
    }
    return pts;
  };
}

// Didymos–Dimorphos and DART: see dart.js (pure, shared with the Verify checks).

// ---------------------------------------------------------------------------------------------
/**
 * Build SolarSystem body definitions from the loaded data. Returns { defs, promoted:Set(pdes) }.
 */
export function buildMinorBodyDefs(data) {
  const defs = [];
  const promoted = new Set();
  if (!data?.available) return { defs, promoted };
  const src = new Map();
  for (const o of data.files.asteroids?.named || []) src.set(o.pdes, o);
  for (const o of data.files.dwarfs?.objects || []) src.set(o.pdes, o);
  const tracks = Object.values(data.tracks);
  for (const [pdes, info] of Object.entries(MINOR_BODIES)) {
    const el = src.get(pdes);
    if (!el || !(el.a > 0) || !(el.e < 1)) continue;
    const meanR = meanRadius(info.axes);
    const byElements = elementPosition(el);
    const track = tracks.find((t) => t.pdes === pdes) || null;
    const def = {
      key: info.key, name: info.name, kind: 'planet', minor: true, minorType: info.minorType, type: info.type,
      parent: 'sun', radius: meanR, flat: info.style === 'sphere' ? 1 - info.axes[2] / info.axes[0] : 0, mass: info.mass,
      orbitDays: TAU / (K / el.a ** 1.5), rotHours: info.rotHours, tilt: null, color: info.color, proc: info.proc,
      albedo: el.albedo ?? 0.1, airless: 0.7, axes: info.axes, poleNote: info.poleNote, rings: info.rings, lockedTo: info.lockedTo,
      pdes, elementEpoch: el.epoch, track: track || null,
      geometry: info.style === 'sphere' ? null : shapeGeometry(info.style, info.axes, meanR, pdes.length * 13 + 3, meanR > 100 ? 6 : 5),
      // Locked bodies (Eris) get their orientation from their moon when it's loaded; this is the fallback.
      rotationFn: rotationFn(info),
    };
    const helioNow = [0, 0, 0];
    def.positionFn = track
      ? (jd, state, out) => trackPosition(track, jd, state, out) || byElements(jd, state, out)
      : byElements;
    // Orbit line from the osculating elements, shifted to pass through the (possibly Horizons) position.
    const orbit = elementOrbit(el, () => helioNow);
    const pos = def.positionFn;
    def.positionFn = (jd, state, out) => { const r = pos(jd, state, out); if (r) { helioNow[0] = r[0]; helioNow[1] = r[1]; helioNow[2] = r[2]; } return r; };
    def.orbitFn = orbit;
    if (track) def.notes = 'Position from JPL Horizons vectors (DE441) within ' + new Date((track.start - 2440587.5) * 864e5).getUTCFullYear()
      + '–' + new Date((track.stop - 2440587.5) * 864e5).getUTCFullYear() + '; SBDB elements outside.';
    defs.push(def);
    promoted.add(pdes);
  }
  // Moons of minor bodies.
  const dys = data.tracks.dysnomia;
  if (dys && defs.find((d) => d.key === 'eris')) {
    const st = { pos: [0, 0, 0], vel: [0, 0, 0] };
    const P = 15.785899;                                  // days (Holler et al. 2021)
    const yr = (jd) => new Date((jd - 2440587.5) * 864e5).getUTCFullYear();
    // Outside the Horizons span: rotate the nearest edge state about the orbit normal at the mean motion
    // (the orbit is nearly circular, e ≈ 0.006, so this is good to ~0.6 % of the radius).
    const edge = (jd) => {
      const t0 = jd < dys.start ? dys.start + 1e-6 : dys.stop - 1e-6;
      const s = dys.stateAt(t0, { pos: [0, 0, 0], vel: [0, 0, 0] });
      const r = s.pos, v = s.vel;
      const n = [r[1] * v[2] - r[2] * v[1], r[2] * v[0] - r[0] * v[2], r[0] * v[1] - r[1] * v[0]];
      const nl = Math.hypot(...n); const u = n.map((x) => x / nl);
      const th = (2 * Math.PI * (jd - t0)) / P, c = Math.cos(th), sn = Math.sin(th);
      const cr = [u[1] * r[2] - u[2] * r[1], u[2] * r[0] - u[0] * r[2], u[0] * r[1] - u[1] * r[0]];
      return [r[0] * c + cr[0] * sn, r[1] * c + cr[1] * sn, r[2] * c + cr[2] * sn];   // Rodrigues (u ⊥ r)
    };
    const rel = (jd, out) => {
      const s = dys.stateAt(jd, st);
      const p = s ? s.pos : edge(jd);
      out[0] = p[0]; out[1] = p[1]; out[2] = p[2];
      return out;
    };
    defs.push({
      key: 'dysnomia', name: 'Dysnomia', kind: 'moon', minor: true, minorType: 'moon', type: 'Moon of Eris', parent: 'eris',
      radius: 307, flat: 0, mass: null, orbitDays: P, rotHours: null, tilt: null, color: '#6d6763', proc: 'dysnomia', albedo: 0.05, airless: 0.7,
      notes: `Position from JPL Horizons (tnosat satellite ephemeris, ${yr(dys.start)}–${yr(dys.stop)}), relative to the Eris system barycenter; circular-orbit extrapolation outside that span.`,
      relFn: (jd, state, out) => rel(jd, out),
      relOrbitFn: (jd, N) => {
        const pts = [];
        for (let k = 0; k < N; k++) pts.push(rel(jd - (k / (N - 1)) * P, [0, 0, 0]));
        return pts;
      },
    });
  }
  if (defs.find((d) => d.key === 'didymos')) {
    const ax = [0.0885, 0.087, 0.058];
    const mr = meanRadius(ax);
    defs.push({
      key: 'dimorphos', name: 'Dimorphos', kind: 'moon', minor: true, minorType: 'moon', type: 'Moon of Didymos — DART impact 2022-09-26',
      parent: 'didymos', radius: mr, flat: 0, mass: 4.3e9, orbitDays: DART.post.P, rotHours: null, tilt: null, color: '#9b958d', proc: 'darkrock',
      albedo: 0.15, airless: 0.7, axes: ax, geometry: shapeGeometry('lumpy', ax, mr, 41),
      notes: `Orbit period ${fmtH(DART.pre.P)} before DART, ${fmtH(DART.post.P)} after (−33.2 min). Faint ring = pre-impact orbit. Orbital phase illustrative.`,
      relFn: (jd, state, out) => dimorphosRel(jd, out),
      relOrbitFn: (jd, N) => dimorphosOrbit(jd, N),
      ghostOrbitFn: (jd, N) => (jd >= DART.impactJD ? dimorphosOrbit(jd, N, true) : null),
    });
  }
  return { defs, promoted };
}

function fmtH(days) { const h = days * 24; return `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`; }

// ---------------------------------------------------------------------------------------------
// Oort cloud — ILLUSTRATIVE statistical shell (no Oort-cloud object has ever been observed in situ).
// Inner (Hills) cloud 2,000–20,000 AU, flattened toward the ecliptic; outer cloud 20,000–100,000 AU, isotropic.
// ---------------------------------------------------------------------------------------------
export class OortCloud {
  constructor(scene, n = 24000) {
    const helio = new Float64Array(n * 3);
    let s = 12345;
    const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let k = 0; k < n; k++) {
      const inner = k < n * 0.35;
      const r = inner ? 2000 * Math.pow(10, rnd()) : 20000 * Math.pow(5, rnd());      // log-uniform in each shell
      const lon = rnd() * TAU;
      let sinb = rnd() * 2 - 1;
      if (inner) sinb = Math.sin(Math.asin(sinb) * 0.45);                               // flattened toward the ecliptic
      const cb = Math.sqrt(1 - sinb * sinb);
      helio[k * 3] = r * AU_KM * cb * Math.cos(lon); helio[k * 3 + 1] = r * AU_KM * cb * Math.sin(lon); helio[k * 3 + 2] = r * AU_KM * sinb;
    }
    this.helio = helio;
    this.n = n;
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    this.material = new THREE.PointsMaterial({ size: 1.3, sizeAttenuation: false, color: 0x8fa6c8, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0.8 });
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = 7;
    scene.add(this.points);
    this._scaleVersion = -1;
    this._p = -1;
    this.visible = true;
  }

  /** Recompute scene positions when the scale mapping changes (static otherwise: statistical, not orbiting). */
  update(scale, camPos, exposure, camTrueAU) {
    if (scale.p !== this._p) {
      this._p = scale.p;
      const out = [0, 0, 0];
      this._scene = this._scene || new Float64Array(this.n * 3);
      for (let k = 0; k < this.n; k++) {
        scale.helioToScene([this.helio[k * 3], this.helio[k * 3 + 1], this.helio[k * 3 + 2]], out);
        this._scene[k * 3] = out[0]; this._scene[k * 3 + 1] = out[1]; this._scene[k * 3 + 2] = out[2];
      }
      this._dirty = true;
    }
    // Floating origin: the group is offset by −camera (points are far away; float32 is plenty here).
    this.points.position.set(-camPos[0], -camPos[1], -camPos[2]);
    if (this._dirty) {
      this.geometry.attributes.position.array.set(this._scene);
      this.geometry.attributes.position.needsUpdate = true;
      this._dirty = false;
    }
    // Fade in only once the camera is far from the planets (≳ 150 AU true distance).
    const f = Math.min(1, Math.max(0, (camTrueAU - 150) / 850));
    this.points.visible = this.visible && f > 0.01;
    this.material.opacity = 0.8 * f;
    this.material.color.setRGB(0.17 / exposure, 0.2 / exposure, 0.25 / exposure);   // faint: illustrative only
    return f;
  }
}
