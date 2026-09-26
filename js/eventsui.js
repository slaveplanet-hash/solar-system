// =============================================================================
// eventsui.js — "Upcoming Events" panel: lists events.js results for the next 1 or
// 5 years from the SIMULATION date, and jumps to an event with a good viewpoint and
// a slowed time rate:
//   solar eclipse   → stand on the shadow axis (or the nearest point of Earth for a
//                     partial eclipse) a little before greatest eclipse, look at the Sun
//   lunar eclipse   → stand where the Moon is overhead, look at it
//   conjunction     → a night-time spot on Earth where the pair is well up
//   meteor shower   → a pre-dawn spot with the radiant high
//   close approach  → fly to the object (Apophis has a body) or to Earth + a bracket
//   perihelion      → fly to the comet / interstellar object (or bracket the Sun side)
// =============================================================================
import * as THREE from 'three';
import { computeEvents, solarGeometry, lunarGeometry } from './events.js';
import { tdbToUTC, utcToTDB, jdToUTCString } from './time.js';
import { AU_KM, equToEcl } from './ephemeris.js';
import { conicPosition, GM_SUN_AU_D, DEG } from './kepler.js';
import { bodyQuaternion } from './bodies.js';
import { SHOWERS } from './showers.js';

const R_EARTH = 6378.137;
const ICON = { 'solar-eclipse': '◐', 'lunar-eclipse': '◑', conjunction: '☌', 'meteor-shower': '☄', 'close-approach': '⊕', 'comet-perihelion': '☄', 'interstellar-perihelion': '✦' };
const eclToThree = (v) => new THREE.Vector3(v[0], v[2], -v[1]);
const norm = (a) => Math.hypot(a[0], a[1], a[2]);

export class EventsPanel {
  constructor(app) {
    this.app = app;
    this.days = 365;
    this.events = [];
    this.window = null;
    this.target = null;               // { name, el, color } bracket target without a body
    this._build();
  }

  _build() {
    const el = this.el = document.createElement('div');
    el.id = 'events'; el.className = 'panel';
    el.innerHTML = `<div class="ev-head"><h2>Upcoming events</h2>
      <select id="ev-range"><option value="365">next year</option><option value="1826">next 5 years</option></select>
      <button id="ev-close" title="Close">×</button></div>
      <div id="ev-sub"></div><div id="ev-list"></div>`;
    document.body.appendChild(el);
    el.querySelector('#ev-close').onclick = () => this.toggle(false);
    el.querySelector('#ev-range').onchange = (e) => { this.days = +e.target.value; this.refresh(true); };
    const btn = document.createElement('button');
    btn.id = 'btn-events'; btn.title = 'Upcoming events (U)'; btn.innerHTML = '<span class="kbd">U</span>Events';
    btn.onclick = () => this.toggle();
    document.getElementById('modes').insertBefore(btn, document.getElementById('btn-verify'));
    this.btn = btn;
    window.addEventListener('keydown', (e) => {
      if (e.target.closest && e.target.closest('input, select, textarea')) return;
      if (e.code === 'KeyU') this.toggle();
    });
  }

  toggle(on = !this.el.classList.contains('open')) {
    this.el.classList.toggle('open', on);
    this.btn.classList.toggle('active', on);
    if (on) this.refresh();
  }

  /** Recompute when the simulated date leaves the listed window (or on demand). */
  refresh(force = false) {
    const app = this.app;
    if (!app.data) return;
    const now = utcToTDB(app.clock.jdUTC);
    if (!force && this.window && now >= this.window[0] && now <= this.window[0] + this.days * 0.5) return;
    this.window = [now - 0.5, now - 0.5 + this.days];
    $sub(this.el).textContent = 'computing…';
    setTimeout(() => {
      const t0 = performance.now();
      const notable = new Set(app.system.bodies.filter((b) => b.minorType === 'comet' && b.pdes).map((b) => b.pdes));
      this.events = computeEvents(app.data, this.window[0], this.days, { notableComets: notable });
      this.ms = performance.now() - t0;
      this._render();
    }, 30);
  }

  _render() {
    const list = this.el.querySelector('#ev-list');
    list.innerHTML = '';
    const now = utcToTDB(this.app.clock.jdUTC);
    for (const ev of this.events) {
      const row = document.createElement('button');
      row.className = 'ev-row' + (ev.jd < now ? ' past' : '');
      const utc = jdToUTCString(tdbToUTC(ev.jd), false).slice(0, 16);
      row.innerHTML = `<span class="ev-ic"></span><span class="ev-main"><span class="ev-t"></span><span class="ev-d"></span></span><span class="ev-date"></span>`;
      row.querySelector('.ev-ic').textContent = ICON[ev.type] || '•';
      row.querySelector('.ev-t').textContent = ev.title;
      row.querySelector('.ev-d').textContent = ev.detail;
      row.querySelector('.ev-date').textContent = utc + ' UTC';
      row.onclick = () => this.jump(ev);
      list.appendChild(row);
    }
    $sub(this.el).textContent = `${this.events.length} events · ${jdToUTCString(tdbToUTC(this.window[0]), false).slice(0, 10)} → ${jdToUTCString(tdbToUTC(this.window[1]), false).slice(0, 10)} · computed in ${this.ms.toFixed(0)} ms · click to jump`;
  }

  // --- jumping ------------------------------------------------------------------------------------
  _setTime(jdTDB, rate) {
    const app = this.app;
    app.clock.setJD(tdbToUTC(jdTDB));
    app.clock.rate = rate; app.clock.paused = false;
    app.ui._syncTimeButtons?.();
    app._stepSimulation(0);                           // bodies (incl. Earth's rotation) at the new date
  }

  /** Earth lat/lon (deg) under a heliocentric-ecliptic point P at the current simulated time. */
  _latLonUnder(P) {
    const E = this.app.system.byKey.earth;
    const v = eclToThree([P[0] - E.helio[0], P[1] - E.helio[1], P[2] - E.helio[2]]).normalize();
    v.applyQuaternion(bodyQuaternion(E).invert());
    return { lat: Math.asin(Math.max(-1, Math.min(1, v.y))) / DEG, lon: Math.atan2(-v.z, v.x) / DEG };
  }

  /**
   * A spot on Earth (lat/lon) where direction `dirEcl` (unit, ecliptic) is ~`wantAlt`° high while the Sun is
   * at least 12° below the horizon. Coarse 5° grid; returns null if no such night-time spot exists.
   */
  _nightSpot(dirEcl, wantAlt = 45) {
    const E = this.app.system.byKey.earth, q = bodyQuaternion(E);
    const tgt = eclToThree(dirEcl).normalize(), sun = eclToThree(E.helio.map((v) => -v)).normalize();
    let best = null;
    for (let lat = -70; lat <= 70; lat += 5) for (let lon = -180; lon < 180; lon += 5) {
      const la = lat * DEG, lo = lon * DEG;
      const up = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), -Math.cos(la) * Math.sin(lo)).applyQuaternion(q);
      const sunAlt = Math.asin(up.dot(sun)) / DEG, alt = Math.asin(up.dot(tgt)) / DEG;
      if (sunAlt > -12 || alt < 15) continue;
      const score = -Math.abs(alt - wantAlt) - Math.abs(lat) * 0.05;     // prefer populated mid-latitudes a little
      if (!best || score > best.score) best = { lat, lon, score };
    }
    return best;
  }

  jump(ev) {
    const app = this.app, sys = app.system, E = () => sys.byKey.earth;
    this.target = null;
    let msg = '';
    // Sky events are viewed from Earth's surface in true scale: switch now, before any aiming.
    if (['solar-eclipse', 'lunar-eclipse', 'conjunction', 'meteor-shower'].includes(ev.type)) app.snapTrueScale();
    switch (ev.type) {
      case 'solar-eclipse': {
        this._setTime(ev.jd - 3 / 1440, 15);                                       // 3 min before greatest, 15× real time
        const g = solarGeometry(ev.jd), s = g.s, d = g.axis;
        const M = s.moon, Ep = s.earth, rel = [M[0] - Ep[0], M[1] - Ep[1], M[2] - Ep[2]];
        const b = rel[0] * d[0] + rel[1] * d[1] + rel[2] * d[2], c = norm(rel) ** 2 - R_EARTH ** 2, disc = b * b - c;
        let P;
        if (disc > 0) { const t = -b - Math.sqrt(disc); P = [M[0] + d[0] * t, M[1] + d[1] * t, M[2] + d[2] * t]; }
        else {                                                                   // partial: nearest point of Earth to the axis
          const t = -b, A = [M[0] + d[0] * t, M[1] + d[1] * t, M[2] + d[2] * t], u = [A[0] - Ep[0], A[1] - Ep[1], A[2] - Ep[2]], n = norm(u);
          P = [Ep[0] + (u[0] / n) * R_EARTH, Ep[1] + (u[1] / n) * R_EARTH, Ep[2] + (u[2] / n) * R_EARTH];
        }
        // Geometry is from the event instant; convert with Earth's orientation at that instant.
        this._setTime(ev.jd, 0); const ll = this._latLonUnder([P[0] - Ep[0] + E().helio[0], P[1] - Ep[1] + E().helio[1], P[2] - Ep[2] + E().helio[2]]);
        this._setTime(ev.jd - 3 / 1440, 15);
        app.enterSurface(E(), ll);
        app.cam.aimSurfaceAt(sys.byKey.sun.scenePos);
        msg = `${ev.title}: standing at ${fmtLL(ll)} ${disc > 0 ? 'on the central line' : 'where the eclipse is deepest'}, 3 min before greatest eclipse (time ×15). Totality is about 12 s away; the Sun is blinding until then.`;
        break;
      }
      case 'lunar-eclipse': {
        this._setTime(ev.jd, 0);
        const ll = this._latLonUnder(sys.byKey.moon.helio);
        this._setTime(ev.jd - 40 / 1440, 120);
        app.enterSurface(E(), ll);
        app.cam.aimSurfaceAt(sys.byKey.moon.scenePos);
        msg = `${ev.title}: the Moon is overhead at ${fmtLL(ll)}; greatest eclipse in 40 min (time ×120).`;
        break;
      }
      case 'conjunction': {
        this._setTime(ev.jd, 0);
        const [a, b] = ev.bodies.map((k) => sys.byKey[k]);
        const dir = [0, 1, 2].map((k) => (a.helio[k] - E().helio[k]) / norm(a.helio.map((v, i) => v - E().helio[i])) + (b.helio[k] - E().helio[k]) / norm(b.helio.map((v, i) => v - E().helio[i])));
        const spot = this._nightSpot(dir, 35);
        this._setTime(ev.jd, 600);
        if (spot) {
          app.enterSurface(E(), spot);
          app.cam.aimSurfaceAt(a.scenePos);
          app.cam.surf.fov = 12;                                                     // binocular field
          msg = `${ev.title}: night sky from ${fmtLL(spot)}, 12° field of view (wheel to zoom out); time ×600.`;
        } else {
          app.focus(a);
          msg = `${ev.title}: too close to the Sun to see from Earth — showing ${a.name} instead.`;
        }
        break;
      }
      case 'meteor-shower': {
        const sh = SHOWERS.find((x) => x.key === ev.shower);
        const e = equToEcl(radec(sh.radiant[0], sh.radiant[1]));
        // Search the 24 h around the peak for a dark site with the radiant high.
        let best = null;
        for (let h = -12; h <= 12; h += 1) {
          this._setTime(ev.jd + h / 24, 0);
          const spot = this._nightSpot(e, 65);
          if (spot && (!best || spot.score > best.spot.score)) best = { spot, h };
        }
        this._setTime(ev.jd + (best ? best.h : 0) / 24, 1);
        if (best) {
          app.enterSurface(E(), best.spot);
          const r = eclToThree(e).normalize();
          app.cam.aimSurfaceAt([app.cam.pos[0] + r.x * 1e6, app.cam.pos[1] + r.y * 1e6, app.cam.pos[2] + r.z * 1e6], -20);
          app.cam.surf.fov = 90;
          msg = `${ev.title}: dark sky at ${fmtLL(best.spot)} with the radiant high; meteors are time-lapsed ×${app.showers?.rateBoost ?? 60} (Settings).`;
        } else { app.focus(E()); msg = `${ev.title}: Earth enters the stream.`; }
        break;
      }
      case 'close-approach': {
        this._setTime(ev.jd - 3 / 24, 600);
        const body = sys.bodies.find((b) => b.pdes && String(b.pdes) === String(ev.des));   // exact: '2' (Pallas) ≠ '2026 PL1'
        if (body) { app.focus(body); msg = `${ev.title}: following ${body.name}; closest approach in 3 h (time ×600).`; }
        else {
          this.target = this._targetFromNEO(ev.des, ev.title.replace(' passes Earth', ''));
          app.focus(E());
          msg = `${ev.title}: bracketed near Earth, closest approach in 3 h (time ×600). Bracket position is two-body from the catalogue elements (approximate); the time and distance are JPL's.`;
        }
        break;
      }
      case 'comet-perihelion': case 'interstellar-perihelion': {
        this._setTime(ev.jd - 2, 3600);
        const body = sys.bodies.find((b) => (ev.pdes && b.pdes === ev.pdes) || (ev.name && b.name.includes(ev.name.split(' (')[0])));
        if (body) { app.focus(body); msg = `${ev.title}: perihelion in 2 days (time ×3600).`; }
        else {
          this.target = this._targetFromComet(ev.pdes, ev.title.replace(' at perihelion', ''));
          app.focus(sys.byKey.sun);
          msg = `${ev.title}: bracketed; perihelion in 2 days (time ×3600).`;
        }
        break;
      }
    }
    if (msg) app.ui.toast(msg, 9000);
    this.toggle(false);
  }

  _targetFromNEO(des, name) {
    const t = this.app.data.files.neos || this.app.data.files.asteroids;
    const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
    const r = t.rows.find((x) => String(x[c.pdes]) === String(des));
    if (!r) return null;
    const a = r[c.a], n = Math.sqrt(GM_SUN_AU_D / a ** 3);
    const el = { q: a * (1 - r[c.e]), e: r[c.e], i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.epoch] - (r[c.ma] * DEG) / n };
    return { name, el, color: '#ff9f6b', sub: 'close approach (≈ position)' };
  }

  _targetFromComet(pdes, name) {
    const t = this.app.data.files.comets;
    const c = Object.fromEntries(t.columns.map((k, i) => [k, i]));
    const r = t.rows.find((x) => x[c.pdes] === pdes);
    if (!r) return null;
    return { name, el: { q: r[c.q], e: r[c.e], i: r[c.i], node: r[c.om], peri: r[c.w], tp: r[c.tp] }, color: '#9fe8ff', sub: 'perihelion' };
  }

  /** Per frame: event-target bracket position (two-body) for the sensor overlay. */
  update(jdTDB, sensor) {
    sensor.targets.length = 0;
    const t = this.target;
    if (!t) return;
    const h = conicPosition(t.el, jdTDB, GM_SUN_AU_D, [0, 0, 0]).map((v) => v * AU_KM);
    const p = this.app.system.mapHelioToScene(h, 0.01, this.app.scale, [0, 0, 0]);
    sensor.targets.push({ name: t.name, scenePos: p, color: t.color, sub: t.sub });
  }
}

function $sub(el) { return el.querySelector('#ev-sub'); }
function radec(ra, dec) { const a = ra * DEG, d = dec * DEG; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; }
function fmtLL({ lat, lon }) { return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`; }
