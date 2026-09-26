// =============================================================================
// sky.js — Background sky at infinity:
//   • StarField: the 9,096 stars of the Yale Bright Star Catalogue (V ≤ 6.5), real
//     J2000 positions; size/brightness from V magnitude, color from B−V.
//   • MilkyWay: procedural band computed per pixel in GALACTIC coordinates
//     (IAU J2000 equatorial→galactic rotation), with a bright bulge toward
//     Sagittarius and the Great Rift dust lanes.
// Both are drawn with the camera's rotation only (w-projection at infinity), so
// they never move when the camera translates.
// =============================================================================
import * as THREE from 'three';
import { decodeStars, STAR_COUNT } from './data/stars.js';
import { OBLIQUITY_J2000 } from './ephemeris.js';

const DEG = Math.PI / 180;

/** Equatorial J2000 unit vector → three.js world axes (via ecliptic: three = (x, z, −y)). */
function equToThree(ra, dec) {
  const x = Math.cos(dec) * Math.cos(ra), y = Math.cos(dec) * Math.sin(ra), z = Math.sin(dec);
  const ce = Math.cos(OBLIQUITY_J2000), se = Math.sin(OBLIQUITY_J2000);
  const ey = ce * y + se * z, ez = -se * y + ce * z;   // equatorial → ecliptic
  return [x, ez, -ey];
}

/** B−V color index → linear RGB via Ballesteros' temperature and a Planck-fit approximation. */
export function bvToRGB(bv) {
  bv = Math.max(-0.4, Math.min(2.0, bv));
  const T = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  // Tanner Helland blackbody fit (sRGB 0–255) → linear
  const t = T / 100;
  let r, g, b;
  if (t <= 66) { r = 255; g = 99.4708025861 * Math.log(t) - 161.1195681661; }
  else { r = 329.698727446 * Math.pow(t - 60, -0.1332047592); g = 288.1221695283 * Math.pow(t - 60, -0.0755148492); }
  if (t >= 66) b = 255; else if (t <= 19) b = 0; else b = 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = (v) => Math.pow(Math.max(0, Math.min(255, v)) / 255, 2.2);
  const c = [lin(r), lin(g), lin(b)];
  const m = Math.max(...c);
  return c.map((v) => v / m);
}

export class StarField {
  constructor() {
    const s = decodeStars();
    const n = STAR_COUNT;
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), mag = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos.set(equToThree(s.ra[i] * DEG, s.dec[i] * DEG), i * 3);
      col.set(bvToRGB(s.bv[i]), i * 3);
      mag[i] = s.vmag[i];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uGain: { value: 1.0 }, uExposure: { value: 1 }, uPixelRatio: { value: 1 }, uLimit: { value: 6.5 }, uFade: { value: 1 } },
      vertexShader: /* glsl */`
uniform float uGain, uExposure, uPixelRatio, uLimit, uFade;
attribute vec3 aColor;
attribute float aMag;
varying vec3 vCol;
void main() {
  // At infinity: rotate by the view only, push depth to the far plane.
  vec3 d = mat3(viewMatrix) * position;
  gl_Position = projectionMatrix * vec4(d, 1.0);
  gl_Position.z = gl_Position.w * 0.9999999;
  float flux = pow(10.0, -0.4 * (aMag + 1.0));             // relative to V = −1
  // Perceptual compression (the eye/cameras don't respond linearly) + a faint-star limit.
  float b = uGain * pow(flux, 0.55) * smoothstep(uLimit + 0.3, uLimit - 0.5, aMag);
  float size = clamp(1.4 + 5.0 * pow(flux, 0.35), 1.4, 6.5);
  gl_PointSize = size * uPixelRatio;
  // Energy spread over the point: keep total brightness ∝ b; cap post-exposure radiance.
  float perPixel = b * (2.0 / (size * size)) * 4.0;
  // Cap below the bloom threshold: single bright pixels would bloom into blocky squares.
  vCol = aColor * min(perPixel * uExposure, 1.1) / uExposure * uFade;   // uFade: daylight sky (surface view)
}`,
      fragmentShader: /* glsl */`
varying vec3 vCol;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(q, q);
  if (r2 > 1.0) discard;
  float a = exp(-r2 * 3.5);
  gl_FragColor = vec4(vCol * a, 1.0);
}`,
      blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true, transparent: true,
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = -10;
  }
}

export class MilkyWay {
  constructor() {
    const ce = Math.cos(OBLIQUITY_J2000), se = Math.sin(OBLIQUITY_J2000);
    // three → ecliptic → equatorial → galactic, as one 3×3 matrix.
    const threeToEcl = new THREE.Matrix3().set(1, 0, 0, 0, 0, -1, 0, 1, 0);          // ecl = (x, −z, y)
    const eclToEqu = new THREE.Matrix3().set(1, 0, 0, 0, ce, -se, 0, se, ce);
    const equToGal = new THREE.Matrix3().set(
      -0.0548755604, -0.8734370902, -0.4838350155,
      0.4941094279, -0.4448296300, 0.7469822445,
      -0.8676661490, -0.1980763734, 0.4559837762);
    const m = equToGal.clone().multiply(eclToEqu).multiply(threeToEcl);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uToGal: { value: m }, uGain: { value: 1.0 }, uExposure: { value: 1 }, uFade: { value: 1 } },
      vertexShader: /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  vec3 d = mat3(viewMatrix) * position;
  gl_Position = projectionMatrix * vec4(d, 1.0);
  gl_Position.z = gl_Position.w * 0.99999995;
}`,
      fragmentShader: /* glsl */`
#include <common>
uniform mat3 uToGal;
uniform float uGain, uExposure, uFade;
varying vec3 vDir;
float hash(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float vnoise(vec3 x) {
  vec3 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(hash(i), hash(i + vec3(1, 0, 0)), f.x), mix(hash(i + vec3(0, 1, 0)), hash(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(hash(i + vec3(0, 0, 1)), hash(i + vec3(1, 0, 1)), f.x), mix(hash(i + vec3(0, 1, 1)), hash(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 6; i++) { s += a * vnoise(p); p *= 2.07; a *= 0.5; } return s; }
void main() {
  vec3 g = normalize(uToGal * normalize(vDir));
  float l = atan(g.y, g.x);                 // galactic longitude (0 = Galactic Center, Sagittarius)
  float b = asin(clamp(g.z, -1.0, 1.0));    // galactic latitude
  float cl = cos(l);
  // Disc thickness grows toward the center; central bulge.
  float width = 0.075 + 0.05 * max(cl, 0.0);
  float disc = exp(-pow(b / width, 2.0));
  float bulge = exp(-(pow(l / 0.35, 2.0) + pow(b / 0.2, 2.0))) * 1.6;
  float clumps = fbm(g * 9.0) * 0.8 + fbm(g * 30.0) * 0.35;
  float lum = (disc * (0.45 + 0.55 * max(cl, 0.0) + 0.25) + bulge) * (0.45 + clumps);
  // Dust lanes (Great Rift from Cygnus to Sagittarius, strongest near b ≈ 0 toward the center).
  float lane = smoothstep(0.35, 0.75, fbm(g * 14.0 + 3.1)) * exp(-pow((b - 0.01) / 0.045, 2.0)) * (0.4 + 0.6 * max(cl, 0.0));
  lum *= 1.0 - 0.85 * lane;
  vec3 col = mix(vec3(0.62, 0.7, 1.0), vec3(1.0, 0.86, 0.66), clamp(max(cl, 0.0) * 0.8 + bulge * 0.3, 0.0, 1.0));
  // Very faint in absolute terms; after the eye adapts it may brighten, but never beyond a dim glow.
  vec3 c = col * lum * uGain * 0.004;
  gl_FragColor = vec4(min(c * uExposure, vec3(0.025 * uGain)) / uExposure * uFade, 1.0);
}`,
      side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -11;
  }
}

// -----------------------------------------------------------------------------
// SkyDome — the sky seen from the ground of a body with an atmosphere (surface view).
// Single scattering with an airmass approximation: Rayleigh (λ⁻⁴-coloured) + Mie
// (forward-peaked, dust/haze coloured), both lit by sunlight reddened along its own
// slant path. Radiance is in scene units (white Lambert at 1 AU = 1) scaled by the
// body's solar irradiance, so eye adaptation handles day, twilight and night alike.
// The per-body optical depths are hand-set approximations, not a radiative-transfer fit.
// -----------------------------------------------------------------------------
export const SKY_PRESETS = {
  earth:   { ray: [0.18, 0.41, 1.0], tauR: 0.30, mie: [1.0, 1.0, 1.0], tauM: 0.06, g: 0.76 },
  mars:    { ray: [0.18, 0.41, 1.0], tauR: 0.01, mie: [1.0, 0.66, 0.40], tauM: 0.45, g: 0.8 },   // butterscotch dust
  venus:   { ray: [0.30, 0.45, 1.0], tauR: 1.2, mie: [1.0, 0.80, 0.50], tauM: 4.0, g: 0.7 },    // overcast, orange
  titan:   { ray: [0.30, 0.45, 1.0], tauR: 0.2, mie: [1.0, 0.62, 0.25], tauM: 3.0, g: 0.65 },   // orange haze
  jupiter: { ray: [0.30, 0.45, 1.0], tauR: 0.6, mie: [1.0, 0.90, 0.75], tauM: 0.5, g: 0.6 },
  saturn:  { ray: [0.30, 0.45, 1.0], tauR: 0.6, mie: [1.0, 0.92, 0.75], tauM: 0.5, g: 0.6 },
  uranus:  { ray: [0.20, 0.55, 1.0], tauR: 0.8, mie: [0.8, 1.0, 1.0], tauM: 0.2, g: 0.6 },
  neptune: { ray: [0.15, 0.40, 1.0], tauR: 0.9, mie: [0.8, 0.9, 1.0], tauM: 0.2, g: 0.6 },
};

export class SkyDome {
  constructor() {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uSun: { value: new THREE.Vector3(0, 1, 0) }, uUp: { value: new THREE.Vector3(0, 1, 0) },
        uE: { value: 1 }, uRay: { value: new THREE.Vector3(0.18, 0.41, 1) }, uMie: { value: new THREE.Vector3(1, 1, 1) },
        uTauR: { value: 0.3 }, uTauM: { value: 0.06 }, uG: { value: 0.76 },
      },
      vertexShader: /* glsl */`
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
  gl_Position.z = gl_Position.w * 0.99999990;
}`,
      fragmentShader: /* glsl */`
uniform vec3 uSun, uUp, uRay, uMie;
uniform float uE, uTauR, uTauM, uG;
varying vec3 vDir;
// Kasten & Young (1989) relative airmass; s = sin(altitude). ≈38 at the horizon.
float airmass(float s) {
  float altDeg = degrees(asin(clamp(s, -1.0, 1.0)));
  return 1.0 / (max(s, 0.0) + 0.50572 * pow(max(altDeg + 6.07995, 0.5), -1.6364));
}
void main() {
  vec3 d = normalize(vDir);
  float h = dot(d, uUp), hs = dot(uSun, uUp), mu = dot(d, uSun);
  float m = min(airmass(h), 40.0), ms = min(airmass(hs), 40.0);
  // Sunlight reaching the scattering layer (reddened along its slant path); fades below the horizon.
  // Aerosol/dust extinction is ~grey; its colour comes from wavelength-dependent absorption, i.e. the
  // scattering albedo (uMie), not from the extinction.
  vec3 ext = uRay * uTauR + uTauM + 1e-5;
  vec3 Ts = exp(-ext * ms) * smoothstep(-0.12, 0.02, hs);
  float pR = 0.0597 * (1.0 + mu * mu);                                        // 3/(16π)(1+μ²)
  float g2 = uG * uG;
  float pM = 0.0796 * (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * uG * mu, 1e-4), 1.5);   // Henyey–Greenstein
  vec3 fill = (1.0 - exp(-ext * m)) / ext;                                    // scattered fraction along the view path
  vec3 L = uE * Ts * fill * (uRay * uTauR * pR + uMie * uTauM * pM) * 26.0;   // gain: noon zenith ≈ 0.3–0.4 × a white sunlit card
  // Below the geometric horizon (seen only over a limb): fade to the horizon colour.
  L *= smoothstep(-0.25, 0.0, h) * 0.6 + 0.4;
  gl_FragColor = vec4(L, 1.0);
}`,
      side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
    });
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 32), this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -10;
    this.mesh.visible = false;
  }

  /** Configure for a body's atmosphere preset; returns false (and hides) if it has none. */
  set(atmoKey, sunDir, up, irradiance) {
    const p = SKY_PRESETS[atmoKey];
    this.mesh.visible = !!p;
    if (!p) return false;
    const u = this.material.uniforms;
    u.uRay.value.set(...p.ray); u.uMie.value.set(...p.mie);
    u.uTauR.value = p.tauR; u.uTauM.value = p.tauM; u.uG.value = p.g;
    u.uSun.value.copy(sunDir); u.uUp.value.copy(up); u.uE.value = irradiance;
    return true;
  }
}
