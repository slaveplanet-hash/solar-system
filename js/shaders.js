// =============================================================================
// shaders.js — Custom materials: planet/moon surfaces, clouds, Rayleigh/Mie
// atmospheres, ring systems, the Sun's surface and corona.
//
// Lighting is done in the shaders (not three.js lights) so that:
//   • sunlight irradiance uses the TRUE heliocentric distance in every scale mode;
//   • eclipses are real ray/disc shadow math against up to 4 occluding spheres,
//     including the partial-disc penumbra and a red refracted umbra for Earth;
//   • Saturn's rings shadow the planet and the planet shadows its rings.
// Every material includes three's logdepthbuf chunks (logarithmic depth buffer).
// Radiance convention: a white Lambertian surface facing the Sun at 1 AU → 1.0.
// =============================================================================
import * as THREE from 'three';
import { TAU_MAX } from './surfaces.js';

// --- shared GLSL ------------------------------------------------------------------
const ECLIPSE_GLSL = /* glsl */`
uniform vec3 uSunPos;        // camera-relative Sun center (scene units)
uniform float uSunAng;       // TRUE angular radius of the Sun seen from this body (rad)
uniform vec4 uOcc[4];        // occluder: camera-relative center, radius (scene units)
uniform vec4 uOccX[4];       // K = true/scene angular-size ratio, sep_true@center, sep_scene@center, atmosphere flag
uniform int uOccCount;

float angleBetween(vec3 a, vec3 b) { return atan(length(cross(a, b)), dot(a, b)); }

// Fraction of a unit disc (the Sun) covered by a disc of radius r whose center is d away.
float discOverlap(float r, float d) {
  if (d >= 1.0 + r) return 0.0;
  if (d <= abs(1.0 - r)) return min(r * r, 1.0);
  float r2 = r * r, d2 = d * d;
  float a1 = acos(clamp((d2 + 1.0 - r2) / (2.0 * d), -1.0, 1.0));
  float a2 = acos(clamp((d2 + r2 - 1.0) / (2.0 * d * r), -1.0, 1.0));
  float k = sqrt(max(0.0, (-d + r + 1.0) * (d + r - 1.0) * (d - r + 1.0) * (d + r + 1.0)));
  return (a1 + r2 * a2 - 0.5 * k) / PI;
}

// Sunlight reaching point p after eclipses (rgb, 1 = unobstructed).
vec3 sunlight(vec3 p) {
  vec3 s = normalize(uSunPos - p);
  vec3 light = vec3(1.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uOccCount) break;
    vec3 toO = uOcc[i].xyz - p;
    float dO = length(toO);
    vec3 o = toO / dO;
    if (dot(o, s) <= 0.0) continue;
    float K = uOccX[i].x;
    float ro = asin(min(uOcc[i].w / dO, 1.0)) * K;
    float sep = max(uOccX[i].y + (angleBetween(o, s) - uOccX[i].z) * K, 0.0);
    float cov = discOverlap(ro / uSunAng, sep / uSunAng);
    float f = 1.0 - cov;
    if (uOccX[i].w > 0.5) {
      // Earth's atmosphere refracts reddened sunlight into the umbra → the red Moon of a lunar eclipse.
      float depth = clamp(1.0 - sep / max(ro, 1e-9), 0.0, 1.0);
      light = light * f + (1.0 - f) * vec3(0.95, 0.32, 0.1) * 0.05 * (0.5 + 0.5 * depth);
    } else {
      light *= f;
    }
  }
  return light;
}

// SphereGeometry-compatible equirectangular UV of an object-space unit direction.
vec2 sphereUv(vec3 n) {
  float phi = atan(n.z, -n.x);
  if (phi < 0.0) phi += 2.0 * PI;
  return vec2(phi / (2.0 * PI), 1.0 - acos(clamp(n.y, -1.0, 1.0)) / PI);
}
`;

const NOISE_GLSL = /* glsl */`
// 3D simplex noise — Ashima Arts / Stefan Gustavson (MIT).
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(i.z + vec4(0.0, i1.z, i2.z, 1.0)) + i.y + vec4(0.0, i1.y, i2.y, 1.0)) + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
`;

const SPHERE_VERT = /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform vec3 uInvScale2;     // 1/scale² per axis → correct normals on oblate planets
varying vec3 vPosW;
varying vec3 vNormalW;
varying vec3 vObjN;
varying vec2 vUv;
void main() {
  vUv = uv;
  vObjN = normalize(position);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  vNormalW = normalize(mat3(modelMatrix) * (normal * uInvScale2));
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}
`;

/** Fresh eclipse uniforms (each material needs its own arrays). */
export function eclipseUniforms() {
  return {
    uSunPos: { value: new THREE.Vector3() },
    uSunAng: { value: 0.0046 },
    uOcc: { value: [0, 1, 2, 3].map(() => new THREE.Vector4()) },
    uOccX: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(1, 0, 0, 0)) },
    uOccCount: { value: 0 },
  };
}

// --- planet / moon surface ---------------------------------------------------------------
export function createSurfaceMaterial({ map, night = null, clouds = null, spec = null, ring = null,
  airless = 0, wrap = 0, ocean = 0, nightGain = 0.06, flat = 0 }) {
  const u = {
    ...eclipseUniforms(),
    uMap: { value: map },
    uNight: { value: night }, uHasNight: { value: night ? 1 : 0 }, uNightGain: { value: nightGain },
    uClouds: { value: clouds }, uHasClouds: { value: clouds ? 1 : 0 }, uCloudShadow: { value: 0.55 },
    uCloudRot: { value: new THREE.Matrix3() },
    uSpec: { value: spec }, uHasSpec: { value: spec ? 1 : 0 }, uOcean: { value: ocean },
    uRingTex: { value: ring?.tex || null }, uHasRing: { value: ring ? 1 : 0 },
    uRingIn: { value: ring?.inner || 0 }, uRingOut: { value: ring?.outer || 1 }, uRingPm: { value: 1 },
    uSunIrr: { value: 1 }, uSunColor: { value: new THREE.Color(1, 0.97, 0.92) },
    uAirless: { value: airless }, uWrap: { value: wrap }, uAmbient: { value: 0.0 },
    uWorldToObj: { value: new THREE.Matrix3() }, uFlat: { value: flat },
    uInvScale2: { value: new THREE.Vector3(1, 1, 1) },
  };
  return new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: SPHERE_VERT,
    fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ECLIPSE_GLSL}
uniform sampler2D uMap, uNight, uClouds, uSpec, uRingTex;
uniform float uHasNight, uNightGain, uHasClouds, uCloudShadow, uHasSpec, uOcean, uHasRing, uRingIn, uRingOut, uRingPm;
uniform mat3 uCloudRot, uWorldToObj;
uniform float uSunIrr, uAirless, uWrap, uAmbient, uFlat;
uniform vec3 uSunColor;
varying vec3 vPosW;
varying vec3 vNormalW;
varying vec3 vObjN;
varying vec2 vUv;
const float TAU_MAX = ${TAU_MAX.toFixed(1)};
void main() {
  #include <logdepthbuf_fragment>
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunPos - vPosW);
  vec3 V = normalize(-vPosW);
  float mu0 = dot(N, L);
  float mu = max(dot(N, V), 0.0);
  vec3 albedo = texture2D(uMap, vUv).rgb;
  vec3 light = sunlight(vPosW) * uSunIrr * uSunColor;
  vec3 Lo = normalize(uWorldToObj * L);

  // Ring shadow on the planet: march the sun ray to the ring plane and read the ring's optical depth.
  if (uHasRing > 0.5 && abs(Lo.y) > 1e-4) {
    vec3 P = vObjN * vec3(1.0, 1.0 - uFlat, 1.0);
    float t = -P.y / Lo.y;
    if (t > 0.0) {
      float r = pow(length(P.xz + t * Lo.xz), 1.0 / uRingPm);   // scene → true ring radius (visual scale)
      float ur = (r - uRingIn) / (uRingOut - uRingIn);
      if (ur > 0.0 && ur < 1.0) {
        float a = texture2D(uRingTex, vec2(ur, 0.5)).a;
        light *= exp(-(a * a * TAU_MAX) / abs(Lo.y));
      }
    }
  }
  // Cloud shadows: sample the cloud layer where the sun ray crosses it.
  float cloudHere = 0.0;
  if (uHasClouds > 0.5) {
    vec3 q = normalize(vObjN + Lo * (0.012 / max(mu0, 0.12)));
    light *= 1.0 - uCloudShadow * texture2D(uClouds, sphereUv(uCloudRot * q)).r;
    cloudHere = texture2D(uClouds, sphereUv(uCloudRot * vObjN)).r;
  }
  float lambert = max((mu0 + uWrap) / (1.0 + uWrap), 0.0);
  float lommel = mu0 > 0.0 ? 2.0 * mu0 / (mu0 + mu + 1e-4) : 0.0;     // airless regolith (flat full Moon)
  float diffuse = mix(lambert, lommel, uAirless);
  vec3 col = albedo * light * diffuse;

  // Specular sun glint on oceans (mask from a spec map, or detected from the day map's ocean color).
  float ocean = uHasSpec > 0.5 ? texture2D(uSpec, vUv).r : uOcean * smoothstep(0.03, 0.12, albedo.b - albedo.r) * step(albedo.g, albedo.b + 0.02);
  if (ocean > 0.0 && mu0 > 0.0) {
    vec3 H = normalize(L + V);
    float fres = 0.02 + 0.98 * pow(1.0 - max(dot(H, V), 0.0), 5.0);
    col += light * ocean * fres * (308.0 / 8.0) * pow(max(dot(N, H), 0.0), 300.0) * mu0 * 3.0 * (1.0 - cloudHere);
  }
  // City lights on the night side, blended across the terminator, dimmed under clouds.
  if (uHasNight > 0.5) {
    float nightMask = smoothstep(0.1, -0.12, mu0);
    col += texture2D(uNight, vUv).rgb * nightMask * uNightGain * (1.0 - 0.75 * cloudHere);
  }
  col += albedo * uAmbient;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

// --- clouds ------------------------------------------------------------------------------------
export function createCloudMaterial(cloudTex) {
  return new THREE.ShaderMaterial({
    uniforms: { ...eclipseUniforms(), uClouds: { value: cloudTex }, uSunIrr: { value: 1 }, uCloudRot: { value: new THREE.Matrix3() },
      uAmbient: { value: 0 }, uInvScale2: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: SPHERE_VERT,
    fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ECLIPSE_GLSL}
uniform sampler2D uClouds;
uniform float uSunIrr, uAmbient;
uniform mat3 uCloudRot;
varying vec3 vPosW;
varying vec3 vNormalW;
varying vec3 vObjN;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float a = texture2D(uClouds, sphereUv(uCloudRot * vObjN)).r;
  if (a < 0.01) discard;
  vec3 N = normalize(vNormalW);
  vec3 L = normalize(uSunPos - vPosW);
  float mu0 = dot(N, L);
  float d = max((mu0 + 0.08) / 1.08, 0.0);
  // Sunset tint on cloud tops near the terminator.
  vec3 tint = mix(vec3(1.0, 0.55, 0.3), vec3(1.0), smoothstep(0.0, 0.25, mu0));
  vec3 col = vec3(0.92) * tint * sunlight(vPosW) * uSunIrr * d + uAmbient;
  gl_FragColor = vec4(col, a * 0.92);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false,
  });
}

// --- atmosphere (single scattering, Rayleigh + Mie) -----------------------------------------------
/**
 * params (all lengths in planet radii): atmo (shell radius), betaR (vec3 per radius), betaM (vec3),
 * hR, hM (scale heights), g (Mie anisotropy), intensity.
 */
export function createAtmosphereMaterial(p) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...eclipseUniforms(),
      uCenter: { value: new THREE.Vector3() }, uR: { value: 1 }, uAtmo: { value: p.atmo },
      uBetaR: { value: new THREE.Vector3(...p.betaR) }, uBetaM: { value: new THREE.Vector3(...p.betaM) },
      uHR: { value: p.hR }, uHM: { value: p.hM }, uG: { value: p.g }, uIntensity: { value: p.intensity },
      uSunIrr: { value: 1 }, uInside: { value: 0 },
      uPole: { value: new THREE.Vector3(0, 1, 0) }, uFlat: { value: 0 },
    },
    vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec3 vPosW;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ECLIPSE_GLSL}
uniform vec3 uCenter, uBetaR, uBetaM, uPole;
uniform float uR, uAtmo, uHR, uHM, uG, uIntensity, uSunIrr, uInside, uFlat;
varying vec3 vPosW;
// Oblate planets: stretch along the pole so the ellipsoid becomes the unit sphere.
vec3 unflatten(vec3 v) { return v + uPole * dot(v, uPole) * (1.0 / (1.0 - uFlat) - 1.0); }
// Ray–sphere (centered at origin): returns (t0, t1), t0 > t1 when missed.
vec2 raySphere(vec3 ro, vec3 rd, float r) {
  float b = dot(ro, rd), c = dot(ro, ro) - r * r, h = b * b - c;
  if (h < 0.0) return vec2(1e9, -1e9);
  h = sqrt(h);
  return vec2(-b - h, -b + h);
}
void main() {
  #include <logdepthbuf_fragment>
  vec3 rd = normalize(unflatten(normalize(vPosW)));   // camera is at the origin
  // Start from the camera when inside the shell, otherwise from this shell fragment (well-conditioned).
  vec3 ro = unflatten(uInside > 0.5 ? -uCenter / uR : (vPosW - uCenter) / uR);
  vec2 ta = raySphere(ro, rd, uAtmo);
  float t0 = max(ta.x, 0.0), t1 = ta.y;
  vec2 tp = raySphere(ro, rd, 1.0);
  if (tp.x > 0.0 && tp.x < tp.y) t1 = min(t1, tp.x);
  if (t1 <= t0) discard;
  vec3 Ls = normalize(unflatten(normalize(uSunPos - uCenter)));
  float mu = dot(rd, Ls);
  float phaseR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g2 = uG * uG;
  float phaseM = 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + mu * mu)) / ((2.0 + g2) * pow(1.0 + g2 - 2.0 * uG * mu, 1.5));
  const int NV = 12, NL = 6;
  float ds = (t1 - t0) / float(NV);
  float odR = 0.0, odM = 0.0;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  for (int i = 0; i < NV; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * ds);
    float h = max(length(p) - 1.0, 0.0);
    float dR = exp(-h / uHR) * ds, dM = exp(-h / uHM) * ds;
    odR += dR; odM += dM;
    // Light path to the Sun (skip samples in the planet's shadow).
    vec2 tpl = raySphere(p, Ls, 1.0);
    if (tpl.x > 0.0 && tpl.x < tpl.y) continue;
    float tl = raySphere(p, Ls, uAtmo).y;
    float dl = tl / float(NL), lR = 0.0, lM = 0.0;
    for (int j = 0; j < NL; j++) {
      float hl = max(length(p + Ls * (float(j) + 0.5) * dl) - 1.0, 0.0);
      lR += exp(-hl / uHR) * dl; lM += exp(-hl / uHM) * dl;
    }
    vec3 att = exp(-(uBetaR * (odR + lR) + uBetaM * 1.1 * (odM + lM)));
    sumR += dR * att; sumM += dM * att;
  }
  // Eclipses: shadow the scattered light too (a moon's shadow on a planet darkens its sky), evaluated at the
  // midpoint of the lit ray segment (world space = center + p·R; the tiny flattening offset is ignored).
  vec3 mid = uCenter + (ro + rd * (0.5 * (t0 + t1))) * uR;
  vec3 ecl = sunlight(mid);
  // Radiance units: a white Lambertian at 1 AU = 1 ⇒ solar irradiance = π in these units.
  vec3 col = uSunIrr * uIntensity * (sumR * uBetaR * phaseR + sumM * uBetaM * phaseM) * PI * ecl;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.FrontSide,
  });
}

// Atmosphere presets (planet radii units). Earth: β_R = (5.8, 13.5, 33.1)e-6 /m, H_R 8 km, H_M 1.2 km.
export const ATMOSPHERES = {
  earth:   { atmo: 1.025, betaR: [37, 86, 211], betaM: [134, 134, 134], hR: 8 / 6378, hM: 1.2 / 6378, g: 0.76, intensity: 1.0 },
  venus:   { atmo: 1.045, betaR: [20, 28, 40], betaM: [260, 215, 140], hR: 15.9 / 6052, hM: 12 / 6052, g: 0.7, intensity: 0.9 },
  mars:    { atmo: 1.02, betaR: [2.5, 5.5, 13], betaM: [45, 30, 18], hR: 11.1 / 3396, hM: 8 / 3396, g: 0.8, intensity: 0.8 },
  titan:   { atmo: 1.18, betaR: [4, 6, 10], betaM: [40, 22, 7], hR: 40 / 2575, hM: 60 / 2575, g: 0.6, intensity: 1.0 },
  jupiter: { atmo: 1.012, betaR: [18, 22, 30], betaM: [30, 25, 18], hR: 27 / 71492, hM: 40 / 71492, g: 0.6, intensity: 0.7 },
  saturn:  { atmo: 1.014, betaR: [16, 19, 26], betaM: [30, 26, 17], hR: 60 / 60268, hM: 80 / 60268, g: 0.6, intensity: 0.45 },
  uranus:  { atmo: 1.02, betaR: [15, 32, 42], betaM: [12, 18, 20], hR: 28 / 25559, hM: 40 / 25559, g: 0.6, intensity: 0.8 },
  neptune: { atmo: 1.02, betaR: [10, 22, 60], betaM: [10, 14, 22], hR: 20 / 24764, hM: 30 / 24764, g: 0.6, intensity: 0.8 },
};

// --- rings -------------------------------------------------------------------------------------------
export function createRingMaterial(ring) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...eclipseUniforms(),
      uRingTex: { value: ring.tex }, uIn: { value: ring.inner }, uOut: { value: ring.outer },
      uNormal: { value: new THREE.Vector3(0, 1, 0) }, uWorldToObj: { value: new THREE.Matrix3() },
      uFlat: { value: ring.flat }, uSunIrr: { value: 1 }, uAlbedo: { value: ring.albedo }, uForward: { value: ring.forward || 0 },
      uPm: { value: 1 },
    },
    vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
uniform float uPm;            // visual-scale moon-distance exponent: ring radii compress the same way as moon orbits
varying vec3 vPosW;
varying vec3 vLocal;          // TRUE radius (planet radii) → ring profile lookup
varying vec3 vLocalS;         // scene radius (planet radii) → shadow geometry
void main() {
  vLocal = position;
  float rt = length(position.xz);
  vec3 ps = position * (pow(rt, uPm) / rt);
  vLocalS = ps;
  vec4 wp = modelMatrix * vec4(ps, 1.0);
  vPosW = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${ECLIPSE_GLSL}
uniform sampler2D uRingTex;
uniform float uIn, uOut, uFlat, uSunIrr, uAlbedo, uForward;
uniform vec3 uNormal;
uniform mat3 uWorldToObj;
varying vec3 vPosW;
varying vec3 vLocal;
varying vec3 vLocalS;
const float TAU_MAX = ${TAU_MAX.toFixed(1)};
void main() {
  #include <logdepthbuf_fragment>
  float r = length(vLocal.xz);
  float ur = (r - uIn) / (uOut - uIn);
  if (ur < 0.0 || ur > 1.0) discard;
  vec4 s = texture2D(uRingTex, vec2(ur, 0.5));
  float tau = s.a * s.a * TAU_MAX;
  if (tau < 1e-6) discard;
  vec3 V = normalize(-vPosW);
  vec3 L = normalize(uSunPos - vPosW);
  float nv = dot(V, uNormal), nl = dot(L, uNormal);
  float muV = max(abs(nv), 0.01), mu0 = max(abs(nl), 0.004);
  float opacity = 1.0 - exp(-tau / muV);
  // Single scattering: reflected from the lit face, diffusely transmitted to the unlit face.
  float I;
  if (nv * nl > 0.0) I = mu0 / (mu0 + muV) * (1.0 - exp(-tau * (1.0 / mu0 + 1.0 / muV)));
  else if (abs(mu0 - muV) > 1e-3) I = mu0 / (mu0 - muV) * (exp(-tau / mu0) - exp(-tau / muV));
  else I = tau / muV * exp(-tau / muV);
  // Forward-scattering dust (Jupiter/Neptune rings brighten dramatically at high phase).
  float phase = 1.0 + uForward * pow(max(dot(-L, V), 0.0), 8.0);
  // Planet shadow on the rings (oblate planet → stretched to a unit sphere), soft penumbra.
  vec3 Lo = normalize(uWorldToObj * L);
  vec3 P = vLocalS * vec3(1.0, 1.0 / (1.0 - uFlat), 1.0);
  vec3 Ls = normalize(Lo * vec3(1.0, 1.0 / (1.0 - uFlat), 1.0));
  float tc = -dot(P, Ls);
  float shadow = 1.0;
  if (tc > 0.0) {
    float dmin = length(P + tc * Ls);
    float w = max(uSunAng * tc, 0.002);
    shadow = smoothstep(1.0 - w, 1.0 + w, dmin);
  }
  // 2·ϖ0·I: single-scattering reflectance normalised so a thick lit ring ≈ a Lambert surface of the same albedo.
  vec3 radiance = s.rgb * uAlbedo * 2.0 * I * phase * uSunIrr * shadow * sunlight(vPosW);
  gl_FragColor = vec4(radiance / max(opacity, 1e-4), opacity);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
  });
}

// --- Sun ------------------------------------------------------------------------------------------------
export function createSunMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uGain: { value: 30 }, uInvScale2: { value: new THREE.Vector3(1, 1, 1) } },
    vertexShader: SPHERE_VERT,
    fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
uniform float uTime, uGain;
varying vec3 vPosW;
varying vec3 vNormalW;
varying vec3 vObjN;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  float mu = clamp(dot(normalize(vNormalW), normalize(-vPosW)), 0.0, 1.0);
  vec3 p = vObjN;
  float t = uTime;
  // Granulation (small convective cells) + supergranulation + slow large-scale plasma flow.
  float gran = snoise(p * 70.0 + vec3(0.0, t * 0.04, t * 0.03)) * 0.55 + snoise(p * 140.0 - vec3(t * 0.05)) * 0.3;
  float sup = snoise(p * 12.0 + vec3(t * 0.008));
  float flow = snoise(p * 3.0 + vec3(t * 0.002, 0.0, 0.0));
  // Sunspot groups in the activity belts (±5–35° latitude): sparse active regions (low-frequency mask)
  // containing dark umbrae with lighter penumbrae.
  float lat = abs(p.y);
  float belt = smoothstep(0.62, 0.25, lat) * smoothstep(0.05, 0.12, lat);
  float region = smoothstep(0.55, 0.8, snoise(p * 2.2 + vec3(5.1, 0.0, t * 0.0002)));
  float sn = snoise(p * 16.0 + vec3(17.3, 0.0, t * 0.0005));
  float pen = smoothstep(0.35, 0.55, sn) * region * belt;
  float umb = smoothstep(0.6, 0.75, sn) * region * belt;
  float spot = pen * 0.45 + umb * 0.5;
  float I = 1.0 + 0.22 * gran + 0.08 * sup + 0.05 * flow;
  // Limb darkening, wavelength dependent (the limb is redder and darker).
  vec3 limb = vec3(pow(mu, 0.40), pow(mu, 0.55), pow(mu, 0.80));
  vec3 base = vec3(1.0, 0.8, 0.52);
  vec3 c = base * I * limb * (1.0 - 0.9 * spot);
  // Faculae: bright patches visible toward the limb.
  c += vec3(1.0, 0.82, 0.55) * 0.3 * smoothstep(0.55, 0.85, snoise(p * 30.0 + t * 0.001)) * (1.0 - mu) * mu;
  gl_FragColor = vec4(c * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
  });
}

/** Corona billboard: camera-facing quad (half-size = 6 solar radii) with animated streamers. */
export function createCoronaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uGain: { value: 1 }, uSeed: { value: 0 } },
    vertexShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`,
    fragmentShader: /* glsl */`
#include <common>
#include <logdepthbuf_pars_fragment>
${NOISE_GLSL}
uniform float uTime, uGain, uSeed;
varying vec2 vUv;
void main() {
  #include <logdepthbuf_fragment>
  vec2 q = (vUv - 0.5) * 12.0;          // in solar radii
  float r = length(q);
  if (r < 0.98) discard;
  float a = atan(q.y, q.x);
  // Streamers: noise stretched radially and drifting outward; stronger near the solar equator.
  float st = snoise(vec3(cos(a) * 2.5, sin(a) * 2.5, r * 0.35 - uTime * 0.015 + uSeed)) * 0.5 + 0.5;
  float fine = snoise(vec3(cos(a) * 9.0, sin(a) * 9.0, r * 0.8 - uTime * 0.03)) * 0.5 + 0.5;
  float eq = 0.55 + 0.45 * pow(abs(cos(a)), 2.0);
  float k = pow(st, 2.0) * 0.7 + fine * 0.3;
  float inner = exp(-(r - 1.0) * 5.0) * 0.9;                 // bright inner corona
  float outer = pow(r, -2.6) * (0.25 + 1.4 * k * eq);       // K-corona falls ~ r^-2.5
  float b = (inner + outer) * smoothstep(6.0, 4.0, r) * smoothstep(0.98, 1.02, r);
  gl_FragColor = vec4(vec3(1.0, 0.88, 0.72) * b * uGain, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
}
