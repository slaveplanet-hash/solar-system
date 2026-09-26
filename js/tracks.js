// =============================================================================
// tracks.js — JPL Horizons state-vector trajectories with cubic Hermite
// interpolation (positions + velocities). Pure JS (Node-testable).
//
// A track has one or more segments, each sampled at a fixed step and expressed
// relative to a center body (10 = Sun, 399 = Earth, 599 = Jupiter). Rows are
// [jd TDB, x, y, z (km), vx, vy, vz (km/s)] in the ecliptic J2000 frame.
// When several segments cover a date, the finest (smallest step) one wins, so a
// dense segment around a close flyby overrides the coarse heliocentric one.
// =============================================================================
export class HorizonsTrack {
  constructor(json) {
    this.id = json.id;
    this.name = json.name;
    this.kind = json.kind;
    this.pdes = json.pdes || null;
    this.segments = json.segments.map((s) => ({
      center: s.center, start: s.start, stop: s.stop, rows: s.rows,
      step: s.rows.length > 1 ? (s.rows[s.rows.length - 1][0] - s.rows[0][0]) / (s.rows.length - 1) : 1,
    })).sort((a, b) => a.step - b.step);
    this.start = Math.min(...this.segments.map((s) => s.start));
    this.stop = Math.max(...this.segments.map((s) => s.stop));
  }

  covers(jd) { return this.segments.some((s) => jd >= s.start && jd <= s.stop); }

  /**
   * State at jd relative to the segment's center body. Returns { center, pos:[km], vel:[km/s] } or null.
   */
  stateAt(jd, out = { center: 10, pos: [0, 0, 0], vel: [0, 0, 0] }, center = null) {
    const seg = this.segments.find((s) => jd >= s.start && jd <= s.stop && (center === null || s.center === center));
    if (!seg) return null;
    out.edgeDays = Math.min(jd - seg.start, seg.stop - jd);   // distance to the segment edge (for cross-fades)
    const rows = seg.rows;
    // Binary search for rows[i].jd ≤ jd < rows[i+1].jd
    let lo = 0, hi = rows.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (rows[mid][0] <= jd) lo = mid; else hi = mid; }
    const r0 = rows[lo], r1 = rows[Math.min(lo + 1, rows.length - 1)];
    const h = r1[0] - r0[0];
    out.center = seg.center;
    if (h <= 0) { for (let k = 0; k < 3; k++) { out.pos[k] = r0[1 + k]; out.vel[k] = r0[4 + k]; } return out; }
    hermite(r0, r1, (jd - r0[0]) / h, h * 86400, out);
    return out;
  }
}

/** Cubic Hermite between two states; t ∈ [0,1], hs = interval in seconds (velocities are km/s). */
export function hermite(r0, r1, t, hs, out) {
  const t2 = t * t, t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
  // Derivatives (per unit t) for the velocity.
  const d00 = 6 * t2 - 6 * t, d10 = 3 * t2 - 4 * t + 1, d01 = -6 * t2 + 6 * t, d11 = 3 * t2 - 2 * t;
  for (let k = 0; k < 3; k++) {
    const p0 = r0[1 + k], p1 = r1[1 + k], m0 = r0[4 + k] * hs, m1 = r1[4 + k] * hs;
    out.pos[k] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    out.vel[k] = (d00 * p0 + d10 * m0 + d01 * p1 + d11 * m1) / hs;
  }
  return out;
}

/**
 * Leave-one-out interpolation error of a segment: predict every k-th interior sample from
 * its neighbours two steps apart. Returns the worst position error in km.
 */
export function hermiteSelfCheck(seg, stride = 7) {
  const rows = seg.rows;
  const out = { pos: [0, 0, 0], vel: [0, 0, 0] };
  let worst = 0;
  for (let i = 1; i + 1 < rows.length; i += stride) {
    const a = rows[i - 1], b = rows[i + 1], h = b[0] - a[0];
    hermite(a, b, (rows[i][0] - a[0]) / h, h * 86400, out);
    worst = Math.max(worst, Math.hypot(out.pos[0] - rows[i][1], out.pos[1] - rows[i][2], out.pos[2] - rows[i][3]));
  }
  return worst;
}
