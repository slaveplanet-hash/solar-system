// =============================================================================
// time.js — Julian Dates, ΔT, and the simulation clock.
// Pure JS (no three.js) so it can be unit-tested in Node.
// =============================================================================

export const J2000 = 2451545.0;          // JD of J2000.0 (2000-01-01 12:00 TT)
export const DAY_S = 86400;
export const JULIAN_CENTURY = 36525;     // days
export const MIN_JD = 2378496.5;         // 1800-01-01 00:00 UTC
export const MAX_JD = 2469807.5;         // 2051-01-01 00:00 UTC

/** Unix milliseconds → Julian Date (UTC scale). */
export function unixMsToJD(ms) { return ms / 86400000 + 2440587.5; }
/** Julian Date (UTC scale) → Unix milliseconds. */
export function jdToUnixMs(jd) { return (jd - 2440587.5) * 86400000; }

/** Decimal year for a UTC JD (good enough for ΔT). */
export function jdToYear(jd) { return 2000 + (jd - J2000) / 365.25; }

/**
 * ΔT = TT − UT in seconds. Espenak & Meeus (NASA) polynomials for 1800–2005,
 * observed IERS values 2005–2025, then held at ~69.2 s (Earth's rotation has
 * been nearly constant since 2017). Error < 1 s for 1800–2030.
 */
export function deltaT(year) {
  const y = year;
  let t;
  if (y < 1860) { t = y - 1800;
    return 13.72 - 0.332447 * t + 0.0068612 * t * t + 0.0041116 * t ** 3 - 0.00037436 * t ** 4
      + 0.0000121272 * t ** 5 - 0.0000001699 * t ** 6 + 0.000000000875 * t ** 7; }
  if (y < 1900) { t = y - 1860;
    return 7.62 + 0.5737 * t - 0.251754 * t * t + 0.01680668 * t ** 3 - 0.0004473624 * t ** 4 + t ** 5 / 233174; }
  if (y < 1920) { t = y - 1900;
    return -2.79 + 1.494119 * t - 0.0598939 * t * t + 0.0061966 * t ** 3 - 0.000197 * t ** 4; }
  if (y < 1941) { t = y - 1920; return 21.20 + 0.84493 * t - 0.076100 * t * t + 0.0020936 * t ** 3; }
  if (y < 1961) { t = y - 1950; return 29.07 + 0.407 * t - t * t / 233 + t ** 3 / 2547; }
  if (y < 1986) { t = y - 1975; return 45.45 + 1.067 * t - t * t / 260 - t ** 3 / 718; }
  if (y < 2005) { t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t * t + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5; }
  // Observed (IERS): 2005 64.7, 2010 66.1, 2015 67.6, 2017+ ≈ 69.2
  const obs = [[2005, 64.7], [2010, 66.1], [2015, 67.6], [2017, 68.6], [2019, 69.2]];
  if (y >= 2019) return 69.2;
  for (let i = 0; i < obs.length - 1; i++) {
    if (y < obs[i + 1][0]) { const f = (y - obs[i][0]) / (obs[i + 1][0] - obs[i][0]); return obs[i][1] + f * (obs[i + 1][1] - obs[i][1]); }
  }
  return 69.2;
}

/** UTC JD → TDB JD (TDB ≈ TT; the periodic TDB−TT term is < 2 ms). */
export function utcToTDB(jdUTC) { return jdUTC + deltaT(jdToYear(jdUTC)) / DAY_S; }
export function tdbToUTC(jdTDB) { return jdTDB - deltaT(jdToYear(jdTDB)) / DAY_S; }

/** Julian centuries of TDB since J2000. */
export function centuries(jdTDB) { return (jdTDB - J2000) / JULIAN_CENTURY; }

/** Parse "YYYY-MM-DD HH:MM" (UTC) → JD UTC. */
export function utcStringToJD(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s.trim());
  if (!m) return NaN;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  return unixMsToJD(ms);
}

/** JD UTC → "YYYY-MM-DD HH:MM:SS" */
export function jdToUTCString(jd, withSeconds = true) {
  const d = new Date(jdToUnixMs(jd));
  if (isNaN(d)) return '—';
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  return withSeconds ? `${base}:${p(d.getUTCSeconds())}` : base;
}

// -----------------------------------------------------------------------------
// SimClock — holds the simulation time as a UTC Julian Date (float64).
// rate = simulated seconds per real second (negative = reverse).
// -----------------------------------------------------------------------------
export const RATE_PRESETS = [
  { label: '1×', rate: 1 },
  { label: '1 min/s', rate: 60 },
  { label: '1 hr/s', rate: 3600 },
  { label: '1 day/s', rate: 86400 },
  { label: '1 wk/s', rate: 604800 },
  { label: '1 mo/s', rate: 2629800 },   // mean month = 30.4375 d
  { label: '1 yr/s', rate: 31557600 },  // Julian year
];

export class SimClock {
  constructor(jdUTC = unixMsToJD(Date.now())) {
    this.jdUTC = jdUTC;
    this.rate = 1;
    this.paused = false;
    this.onClamp = null;  // callback(message) when the clock hits the 1800–2050 validity range
  }
  get jdTDB() { return utcToTDB(this.jdUTC); }
  get effectiveRate() { return this.paused ? 0 : this.rate; }

  /** Advance by a real-time delta (seconds). */
  tick(realDt) {
    if (this.paused || this.rate === 0) return;
    this.jdUTC += (realDt * this.rate) / DAY_S;
    this._clamp();
  }
  setJD(jdUTC) { this.jdUTC = jdUTC; this._clamp(); }
  setNow() { this.jdUTC = unixMsToJD(Date.now()); }
  reverse() { this.rate = -this.rate; }

  _clamp() {
    if (this.jdUTC < MIN_JD || this.jdUTC > MAX_JD) {
      this.jdUTC = Math.min(MAX_JD, Math.max(MIN_JD, this.jdUTC));
      this.paused = true;
      this.onClamp?.('Clock paused: the JPL planetary elements (Standish Table 1) are only valid for 1800–2050.');
    }
  }
}
