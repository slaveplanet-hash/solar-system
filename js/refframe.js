// =============================================================================
// refframe.js — A position stored relative to a reference body (co-moving frame).
//
// At time-lapse rates Earth moves millions of km per frame; anything that should
// "stay near" a body (free-flight camera, the ship, its chase spring) is kept as an
// offset from that body's scene position. The reference switches (with hysteresis)
// to whichever body's surface is clearly closest, keeping the absolute position.
// =============================================================================

/** Nearest body surface to an absolute scene position: { body, dist } (scene units). */
export function nearestSurface(bodies, p) {
  let body = null, dist = Infinity;
  for (const b of bodies) {
    const d = Math.hypot(p[0] - b.scenePos[0], p[1] - b.scenePos[1], p[2] - b.scenePos[2]) - b.rScene;
    if (d < dist) { dist = d; body = b; }
  }
  return { body, dist };
}

export class RefFrame {
  constructor() {
    this.ref = null;          // Body
    this.rel = [0, 0, 0];     // offset from ref.scenePos (scene units)
    this.refR = 1;            // ref.rScene when rel was last valid (detects scale-mode changes)
  }

  /** Anchor to `ref`, keeping the absolute scene position `abs`. */
  attach(ref, abs) {
    this.ref = ref;
    this.refR = ref.rScene;
    for (let k = 0; k < 3; k++) this.rel[k] = abs[k] - ref.scenePos[k];
  }

  /** Store a new absolute position (same reference). */
  set(abs) { for (let k = 0; k < 3; k++) this.rel[k] = abs[k] - this.ref.scenePos[k]; }

  /**
   * Absolute scene position → out. When the body's scene radius changed (true ↔ visual scale),
   * offsets within 50 radii are rescaled with it so the altitude in radii is preserved (and `vel`
   * with them); farther out the heliocentric mapping dominates and the offset is left alone.
   */
  resolve(out, vel) {
    const r = this.ref;
    if (r.rScene !== this.refR && this.refR > 0) {
      const d = Math.hypot(this.rel[0], this.rel[1], this.rel[2]);
      if (d < 50 * this.refR) {
        const f = r.rScene / this.refR;
        for (let k = 0; k < 3; k++) { this.rel[k] *= f; if (vel) vel[k] *= f; }
      }
      this.refR = r.rScene;
    }
    for (let k = 0; k < 3; k++) out[k] = r.scenePos[k] + this.rel[k];
    return out;
  }

  /** Switch to a body whose surface is clearly (< 70 %) closer than the current one's. */
  rebase(bodies, abs) {
    const n = nearestSurface(bodies, abs);
    if (!n.body || n.body === this.ref) return false;
    const r = this.ref;
    const cur = Math.hypot(abs[0] - r.scenePos[0], abs[1] - r.scenePos[1], abs[2] - r.scenePos[2]) - r.rScene;
    if (n.dist < 0.7 * cur) { this.attach(n.body, abs); return true; }
    return false;
  }
}
