// =============================================================================
// events.js — "Upcoming Events" computed from the ephemerides and the /data/ files.
// Pure JS (Node-testable): no three.js.
//
//   • Solar eclipses   new moons → greatest eclipse = minimum distance of the Moon's
//                      shadow axis from Earth's centre (γ); type from the umbral cone
//                      length vs. the Moon–ground distance on the axis.
//   • Lunar eclipses   full moons → minimum distance of the Moon from the anti-solar
//                      axis; umbra/penumbra cones enlarged 2 % (Chauvenet).
//   • Conjunctions     planet pairs, geocentric separation minima < 1.5°.
//   • Meteor showers   IMO peak dates.
//   • Close approaches JPL CAD (its times and distances are taken as truth).
//   • Comet perihelia  notable comets (bright M1 or promoted bodies) and
//                      interstellar-object perihelia from the elements.
// All times are TDB (Julian days); convert with tdbToUTC for display/jumps.
// =============================================================================
import { computeSystemState, AU_KM } from './ephemeris.js';
import { utcToTDB, utcStringToJD } from './time.js';
import { SHOWERS } from './showers.js';

const R_EARTH = 6378.137, R_SUN = 695700, R_MOON = 1737.4;
const DEG = Math.PI / 180;
const SYNODIC = 29.530589;
const PLANETS = ['mercury', 'venus', 'mars', 'jupiter', 'saturn', 'uranus', 'neptune'];
export const PLANET_NAMES = { mercury: 'Mercury', venus: 'Venus', mars: 'Mars', jupiter: 'Jupiter', saturn: 'Saturn', uranus: 'Uranus', neptune: 'Neptune' };

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const wrap180 = (x) => ((x + 540) % 360) - 180;
const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (norm(a) * norm(b)))));

/** Minimise f on [a, b] (golden section). Returns { x, f }. */
function goldenMin(f, a, b, iters = 40) {
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a), fc = f(c), fd = f(d);
  for (let i = 0; i < iters; i++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  const x = (a + b) / 2;
  return { x, f: f(x) };
}

/** Moon − Sun geocentric ecliptic longitude difference (deg, −180..180). */
function elongation(jd, target = 0) {
  const s = computeSystemState(jd);
  const lm = Math.atan2(s.moonGeo[1], s.moonGeo[0]) / DEG;
  const ls = Math.atan2(-s.earth[1], -s.earth[0]) / DEG;
  return wrap180(lm - ls - target);
}

/** New (target 0) or full (target 180) moons in [jd0, jd1]. */
export function syzygies(jd0, jd1, target) {
  const out = [];
  let t = jd0, f0 = elongation(t, target);
  while (t < jd1) {
    const t1 = t + 1, f1 = elongation(t1, target);
    if (f0 < 0 && f1 >= 0 && f1 - f0 < 90) {              // upward zero crossing (not the ±180 wrap)
      let a = t, b = t1;
      for (let i = 0; i < 40; i++) { const m = (a + b) / 2; if (elongation(m, target) < 0) a = m; else b = m; }
      out.push((a + b) / 2);
      t = (a + b) / 2 + SYNODIC - 2; f0 = elongation(t, target);
      continue;
    }
    t = t1; f0 = f1;
  }
  return out;
}

/** Solar-eclipse geometry at jd: γ (Earth radii), whether the axis passes Earth-ward of the Moon, type. */
export function solarGeometry(jd) {
  const s = computeSystemState(jd);
  const dSM = norm(s.moon), d = s.moon.map((v) => v / dSM);          // Sun → Moon axis
  const tE = dot(s.earth, d);
  const along = d.map((v) => v * tE);
  const perp = norm(sub(s.earth, along));
  const sE = tE - dSM;                                                 // Moon → fundamental plane distance
  const penR = R_MOON + sE * (R_SUN + R_MOON) / dSM;                   // penumbra radius at Earth
  const umbraLen = dSM * R_MOON / (R_SUN - R_MOON);                    // umbral cone length from the Moon
  let type = null;
  if (sE > 0 && perp < R_EARTH + penR) {
    if (perp < R_EARTH) {
      const sGround = sE - Math.sqrt(R_EARTH * R_EARTH - perp * perp);  // Moon → ground along the axis
      type = sGround < umbraLen ? 'total' : 'annular';
    } else type = 'partial';
  }
  return { gamma: perp / R_EARTH, perp, type, s, axis: d };
}

/** Lunar-eclipse geometry at jd. */
export function lunarGeometry(jd) {
  const s = computeSystemState(jd);
  const dES = norm(s.earth), d = s.earth.map((v) => v / dES);         // anti-solar axis through Earth
  const r = sub(s.moon, s.earth), t = dot(r, d);
  const perp = norm(sub(r, d.map((v) => v * t)));
  // NASA/Espenak convention: Earth's flattened effective radius (0.99834 R⊕), and Chauvenet's 2 %
  // enlargement applied to the whole shadow radius (atmosphere).
  const Rf = 0.99834 * R_EARTH;
  const umbra = 1.02 * (Rf - t * (R_SUN - Rf) / dES);
  const penumbra = 1.02 * (Rf + t * (R_SUN + Rf) / dES);
  let type = null;
  if (t > 0) {
    if (perp + R_MOON < umbra) type = 'total';
    else if (perp - R_MOON < umbra) type = 'partial';
    else if (perp - R_MOON < penumbra) type = 'penumbral';
  }
  const umbralMag = (umbra - perp + R_MOON) / (2 * R_MOON);
  return { gamma: perp / R_EARTH, perp, type, umbralMag, s };
}

export function solarEclipses(jd0, jd1) {
  const out = [];
  for (const nm of syzygies(jd0 - 1, jd1 + 1, 0)) {
    const g = goldenMin((t) => solarGeometry(t).perp, nm - 0.3, nm + 0.3);
    const geo = solarGeometry(g.x);
    if (geo.type && g.x >= jd0 && g.x <= jd1) out.push({ jd: g.x, type: geo.type, gamma: geo.gamma });
  }
  return out;
}

export function lunarEclipses(jd0, jd1) {
  const out = [];
  for (const fm of syzygies(jd0 - 1, jd1 + 1, 180)) {
    const g = goldenMin((t) => lunarGeometry(t).perp, fm - 0.3, fm + 0.3);
    const geo = lunarGeometry(g.x);
    if (geo.type && g.x >= jd0 && g.x <= jd1) out.push({ jd: g.x, type: geo.type, gamma: geo.gamma, umbralMag: geo.umbralMag });
  }
  return out;
}

/** Planet–planet conjunctions (geocentric separation minima below `maxDeg`), with the Sun elongation. */
export function conjunctions(jd0, jd1, maxDeg = 1.5) {
  const n = Math.ceil(jd1 - jd0) + 3;
  const dirs = [];                                                     // daily geocentric vectors, computed once
  for (let i = 0; i < n; i++) {
    const s = computeSystemState(jd0 - 1 + i);
    dirs.push(Object.fromEntries([...PLANETS.map((p) => [p, sub(s[p], s.earth)]), ['sun', s.earth.map((v) => -v)]]));
  }
  const out = [];
  for (let a = 0; a < PLANETS.length; a++) for (let b = a + 1; b < PLANETS.length; b++) {
    const pa = PLANETS[a], pb = PLANETS[b];
    const sep = dirs.map((d) => angle(d[pa], d[pb]) / DEG);
    for (let i = 1; i < n - 1; i++) {
      if (!(sep[i] <= sep[i - 1] && sep[i] < sep[i + 1] && sep[i] < maxDeg + 1)) continue;
      const f = (t) => { const s = computeSystemState(t); return angle(sub(s[pa], s.earth), sub(s[pb], s.earth)) / DEG; };
      const g = goldenMin(f, jd0 - 1 + i - 1, jd0 - 1 + i + 1, 30);
      if (g.f > maxDeg || g.x < jd0 || g.x > jd1) continue;
      const s = computeSystemState(g.x);
      const mid = sub(s[pa], s.earth).map((v, k) => v / norm(sub(s[pa], s.earth)) + sub(s[pb], s.earth)[k] / norm(sub(s[pb], s.earth)));
      const elong = angle(mid, s.earth.map((v) => -v)) / DEG;
      out.push({ jd: g.x, a: pa, b: pb, sepDeg: g.f, elongDeg: elong });
    }
  }
  return out;
}

/** Everything in [jdTDB, jdTDB + days], sorted by time. `notableComets`: Set of comet pdes promoted to bodies. */
export function computeEvents(data, jdTDB, days = 365, { notableComets = new Set() } = {}) {
  const jd0 = jdTDB, jd1 = jdTDB + days;
  const ev = [];
  const id = (k) => `${k}@${Math.round((ev.length + 1) * 1000)}`;
  for (const e of solarEclipses(jd0, jd1)) {
    ev.push({ id: id('se'), type: 'solar-eclipse', jd: e.jd, title: `${cap(e.type)} solar eclipse`,
      detail: `greatest eclipse · γ = ${e.gamma.toFixed(3)}`, kind: e.type, gamma: e.gamma });
  }
  for (const e of lunarEclipses(jd0, jd1)) {
    ev.push({ id: id('le'), type: 'lunar-eclipse', jd: e.jd, title: `${cap(e.type)} lunar eclipse`,
      detail: `umbral magnitude ${e.umbralMag.toFixed(2)}`, kind: e.type });
  }
  for (const c of conjunctions(jd0, jd1)) {
    ev.push({ id: id('cj'), type: 'conjunction', jd: c.jd, title: `${PLANET_NAMES[c.a]}–${PLANET_NAMES[c.b]} conjunction`,
      detail: `${c.sepDeg < 1 ? (c.sepDeg * 60).toFixed(0) + '′' : c.sepDeg.toFixed(2) + '°'} apart · ${c.elongDeg.toFixed(0)}° from the Sun${c.elongDeg < 15 ? ' (too close to the Sun to observe)' : ''}`,
      bodies: [c.a, c.b], elongDeg: c.elongDeg });
  }
  const y0 = 2000 + (jd0 - 2451545) / 365.25, y1 = 2000 + (jd1 - 2451545) / 365.25;
  for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
    for (const sh of SHOWERS) {
      const jd = utcToTDB(utcStringToJD(`${y}-${sh.peak} 12:00`));
      if (jd < jd0 || jd > jd1) continue;
      ev.push({ id: id('ms'), type: 'meteor-shower', jd, title: `${sh.name} peak`, detail: `ZHR ≈ ${sh.zhr} · radiant RA ${sh.radiant[0]}°, Dec ${sh.radiant[1] >= 0 ? '+' : ''}${sh.radiant[1]}° (IMO peak date)`, shower: sh.key });
    }
  }
  const cad = data?.files?.close_approaches;
  if (cad) {
    const c = Object.fromEntries(cad.columns.map((k, i) => [k, i]));
    const rows = cad.rows.filter((r) => r[c.jd] >= jd0 && r[c.jd] <= jd1 && (r[c.dist_au] < 0.01 || (r[c.H] <= 22 && r[c.dist_au] < 0.03)))
      .sort((a, b) => a[c.dist_au] - b[c.dist_au]).slice(0, 15);
    for (const r of rows) {
      const ld = r[c.dist_au] * AU_KM / 384400;
      ev.push({ id: id('ca'), type: 'close-approach', jd: r[c.jd], title: `${r[c.name].replace(/^\((.*)\)$/, '$1')} passes Earth`,
        detail: `${(r[c.dist_au] * AU_KM).toLocaleString('en-US', { maximumFractionDigits: 0 })} km (${ld.toFixed(ld < 10 ? 2 : 1)} lunar distances) · ${r[c.v_rel_kms].toFixed(1)} km/s · H ${r[c.H]}`,
        des: r[c.des], distKm: r[c.dist_au] * AU_KM });
    }
  }
  const com = data?.files?.comets;
  if (com) {
    const c = Object.fromEntries(com.columns.map((k, i) => [k, i]));
    const cands = [];
    for (const r of com.rows) {
      const tp = r[c.tp];
      if (!(tp >= jd0 && tp <= jd1)) continue;
      const peak = r[c.M1] != null ? r[c.M1] + (r[c.K1] ?? 10) * Math.log10(r[c.q]) : 99;
      if (peak <= 12 || notableComets.has(r[c.pdes])) cands.push({ r, peak });
    }
    cands.sort((a, b) => a.peak - b.peak);
    for (const { r, peak } of cands.slice(0, 10)) {
      ev.push({ id: id('cp'), type: 'comet-perihelion', jd: r[c.tp], title: `${r[c.name]} at perihelion`,
        detail: `q = ${r[c.q].toFixed(3)} AU${peak < 99 ? ` · total magnitude ≈ ${peak.toFixed(1)} (M1/K1 model, uncertain)` : ''}`, pdes: r[c.pdes] });
    }
  }
  for (const o of data?.files?.interstellar?.objects || []) {
    if (!(o.tp >= jd0 && o.tp <= jd1)) continue;
    ev.push({ id: id('is'), type: 'interstellar-perihelion', jd: o.tp, title: `${o.name} at perihelion`, detail: `q = ${o.q.toFixed(3)} AU · e = ${o.e.toFixed(3)} (hyperbolic)`, pdes: o.pdes, name: o.name });
  }
  return ev.sort((a, b) => a.jd - b.jd);
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
