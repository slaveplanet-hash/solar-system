// =============================================================================
// scale.js — TRUE ⇄ VISUAL scale mapping with a smooth animated blend.
//
// Everything is stored in float64 kilometres (heliocentric ecliptic J2000) and
// mapped to "scene units" here. In TRUE scale, scene units are km. In VISUAL scale:
//   • heliocentric distance  r' = AU · (r/AU)^p       (p → distExp, 1 AU stays 1 AU)
//   • body radii             R' = R · exag            (Sun capped at sunMax)
//   • moon distances         d' = R'p · (d/Rp)^pm      (keeps moons outside parents)
// The blend parameter s ∈ [0,1] interpolates p, pm and log(exag), so the
// transition is continuous and every body glides to its new place.
// =============================================================================
import { AU_KM } from './ephemeris.js';

export class ScaleSystem {
  constructor() {
    this.mode = 'visual';
    this.s = 1;              // current blend (0 = true, 1 = visual)
    this._from = 1; this._to = 1; this._u = 1;
    this.duration = 2.5;     // seconds for a full transition
    this.exag = 200;         // planet/moon radius exaggeration in visual mode
    this.sunMax = 30;        // Sun radius exaggeration cap
    this.distExp = 0.45;     // heliocentric distance exponent in visual mode
    this.moonExp = 0.55;     // moon-orbit exponent in visual mode (in parent radii)
    this.version = 0;        // bumps whenever the mapping changes
  }

  setMode(mode) {
    if (mode === this.mode) return;
    this.mode = mode;
    this._from = this.s; this._to = mode === 'visual' ? 1 : 0; this._u = 0;
  }
  /** Switch instantly (no animation), e.g. before aiming a surface view at a planet. */
  snap(mode) {
    this.mode = mode;
    this.s = this._from = this._to = mode === 'visual' ? 1 : 0;
    this._u = 1;
    this.version++;
  }
  get transitioning() { return this._u < 1; }

  update(dt) {
    if (this._u < 1) {
      this._u = Math.min(1, this._u + dt / this.duration);
      const e = this._u * this._u * (3 - 2 * this._u);   // smoothstep
      this.s = this._from + (this._to - this._from) * e;
      this.version++;
    }
  }

  get p() { return 1 + this.s * (this.distExp - 1); }
  get pm() { return 1 + this.s * (this.moonExp - 1); }

  /** Radius multiplier for a body kind ('sun' or anything else). */
  radiusFactor(kind) {
    const e = kind === 'sun' ? Math.min(this.exag, this.sunMax) : this.exag;
    return Math.pow(e, this.s);
  }

  /** Heliocentric ecliptic km → scene-unit three.js axes (X, Y=north, Z=−eclY). */
  helioToScene(v, out = [0, 0, 0]) {
    const r = Math.hypot(v[0], v[1], v[2]);
    const f = r > 1e-9 ? (AU_KM * Math.pow(r / AU_KM, this.p)) / r : 0;
    out[0] = v[0] * f; out[1] = v[2] * f; out[2] = -v[1] * f;
    return out;
  }

  /**
   * Moon offset from its parent (ecliptic km) → scene-unit offset (three axes).
   * parentR, moonR in km. Guarantees the moon never intersects the parent.
   */
  moonOffsetToScene(rel, parentR, moonR, out = [0, 0, 0]) {
    const d = Math.hypot(rel[0], rel[1], rel[2]);
    const rf = this.radiusFactor('planet');
    let dv = parentR * rf * Math.pow(d / parentR, this.pm);
    dv = Math.max(dv, (parentR + moonR) * rf * 1.15);
    const f = d > 0 ? dv / d : 0;
    out[0] = rel[0] * f; out[1] = rel[2] * f; out[2] = -rel[1] * f;
    return out;
  }
}

/** Ecliptic (x,y,z) → three.js axes (x, z, −y). */
export function eclToThree(v, out = [0, 0, 0]) { out[0] = v[0]; out[1] = v[2]; out[2] = -v[1]; return out; }
