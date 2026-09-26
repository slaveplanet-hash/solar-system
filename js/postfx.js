// =============================================================================
// postfx.js — HDR post-processing and eye adaptation.
//
//   RenderPass (HDR, MSAA) → UnrealBloom (threshold tracks exposure so only the Sun
//   and bright highlights bloom) → LensFlare (sun ghosts/streaks, CPU-occluded)
//   → OutputPass (ACES filmic + sRGB) → Final (film grain, vignette, optional
//   chromatic aberration).
//
// Auto-exposure is estimated analytically from what is on screen (each body's
// projected coverage × lit phase × albedo × sunlight at its TRUE distance ×
// eclipse visibility) — no GPU readback stalls. It adapts quickly toward
// darker (bright scene) and slowly toward brighter (dark side / night), like an eye.
// =============================================================================
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { AU_KM } from './ephemeris.js';

const LensFlareShader = {
  uniforms: {
    tDiffuse: { value: null }, uSun: { value: new THREE.Vector2(0.5, 0.5) }, uAspect: { value: 1 },
    uIntensity: { value: 0 }, uTime: { value: 0 },
  },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform vec2 uSun;
uniform float uAspect, uIntensity, uTime;
varying vec2 vUv;
float disc(vec2 p, vec2 c, float r, float soft) { return smoothstep(r, r * (1.0 - soft), length((p - c) * vec2(uAspect, 1.0))); }
void main() {
  vec3 col = texture2D(tDiffuse, vUv).rgb;
  if (uIntensity > 0.0) {
    vec2 d = (vUv - uSun) * vec2(uAspect, 1.0);
    float r = length(d);
    float ang = atan(d.y, d.x);
    // Starburst (6 diffraction spikes) + anamorphic streak + soft glare.
    float spikes = pow(abs(cos(ang * 3.0 + 0.3)), 80.0) * exp(-r * 12.0) * 0.3;
    float streak = exp(-abs(d.y) * 260.0) * exp(-abs(d.x) * 3.0) * 0.2;
    float glare = exp(-r * 18.0) * 0.8 + exp(-r * 4.0) * 0.06;
    vec3 f = vec3(1.0, 0.92, 0.8) * (spikes + glare) + vec3(0.55, 0.7, 1.0) * streak;
    // Ghosts along the line through the screen center, tinted like coated optics.
    vec2 axis = vec2(0.5) - uSun;
    const int N = 6;
    float fs[6] = float[6](0.35, 0.62, 0.9, 1.25, 1.55, 1.95);
    float rs[6] = float[6](0.018, 0.035, 0.012, 0.06, 0.025, 0.09);
    vec3 cs[6] = vec3[6](vec3(0.9, 0.6, 0.3), vec3(0.3, 0.8, 0.6), vec3(0.8, 0.5, 1.0), vec3(0.3, 0.5, 1.0), vec3(1.0, 0.8, 0.4), vec3(0.4, 0.9, 0.9));
    for (int i = 0; i < N; i++) {
      vec2 c = uSun + axis * fs[i];
      f += cs[i] * disc(vUv, c, rs[i], 0.35) * 0.05;
    }
    // Halo ring centered on the screen.
    float hr = length((vUv - 0.5) * vec2(uAspect, 1.0) - (uSun - 0.5) * vec2(uAspect, 1.0) * -0.3);
    f += vec3(0.6, 0.75, 1.0) * smoothstep(0.02, 0.0, abs(hr - 0.42)) * 0.03;
    col += f * uIntensity;
  }
  gl_FragColor = vec4(col, 1.0);
}`,
};

const FinalShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uGrain: { value: 0.035 }, uVignette: { value: 0.35 },
    uCA: { value: 0.0 }, uRes: { value: new THREE.Vector2(1, 1) } },
  vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */`
uniform sampler2D tDiffuse;
uniform float uTime, uGrain, uVignette, uCA;
uniform vec2 uRes;
varying vec2 vUv;
float rand(vec2 co) { return fract(sin(dot(co, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 c = vUv - 0.5;
  vec3 col;
  if (uCA > 0.0) {
    vec2 off = c * uCA * 0.012;
    col = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
  } else col = texture2D(tDiffuse, vUv).rgb;
  float v = 1.0 - uVignette * smoothstep(0.35, 0.95, length(c * vec2(uRes.x / uRes.y, 1.0)) * 0.9);
  col *= v;
  float g = rand(vUv * uRes + fract(uTime) * 100.0) - 0.5;
  col += g * uGrain * (0.35 + 0.65 * (1.0 - dot(col, vec3(0.333))));   // grain is stronger in shadows
  gl_FragColor = vec4(col, 1.0);
}`,
};

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.7, 0.35, 1.0);
    this.composer.addPass(this.bloom);
    this.flare = new ShaderPass(LensFlareShader);
    this.composer.addPass(this.flare);
    this.composer.addPass(new OutputPass());
    this.final = new ShaderPass(FinalShader);
    this.composer.addPass(this.final);
    this.settings = { bloom: 0.7, bloomThreshold: 1.25, flare: true, grain: 0.035, vignette: 0.35, chromatic: 0 };
    this.exposure = 1;
    this.sunVisible = 0;
  }

  /** MSAA sample count of the HDR scene targets (0 = off); the targets are re-created on next use. */
  setSamples(n) {
    for (const rt of [this.composer.renderTarget1, this.composer.renderTarget2]) {
      if (rt.samples === n) continue;
      rt.samples = n;
      rt.dispose();
    }
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    this.final.uniforms.uRes.value.set(w * pr, h * pr);
  }

  /**
   * Analytic scene luminance → target exposure. `bodies` carry pixelRadius, helio (km),
   * scenePos, albedo, eclipseVisible. `camTrueDist` is the camera's true distance to the Sun (km).
   */
  estimateExposure(bodies, camPos, camTrueDist, width, height) {
    // Clamp to 0.05–60 AU: far outside the planets (or in visual scale, where the inverted
    // compression explodes) sunlight is treated as at 60 AU so exposure stays bounded.
    const d = Math.min(60 * AU_KM, Math.max(camTrueDist, 0.05 * AU_KM));
    const E_cam = (AU_KM / d) ** 2;
    const area = width * height;
    if (!(area > 0)) return this.exposure;          // hidden/minimised window (0×0): keep the current exposure
    let covered = 0, lum = 0, sunLum = 0, cap = Infinity;
    for (const b of bodies) {
      if (!b.screen.visible && b.pixelRadius < width) continue;
      const cov = Math.min(1, (Math.PI * b.pixelRadius * b.pixelRadius) / area);
      if (cov < 1e-7) continue;
      // The Sun counts only as much as it is actually visible (occlusion test from the lens-flare pass).
      if (b.kind === 'sun') { sunLum += cov * 400 * this.sunVisible; continue; }
      // Illuminated fraction seen from the camera (phase).
      const toSun = [-b.scenePos[0], -b.scenePos[1], -b.scenePos[2]];
      const toCam = [camPos[0] - b.scenePos[0], camPos[1] - b.scenePos[1], camPos[2] - b.scenePos[2]];
      const cosPhase = (toSun[0] * toCam[0] + toSun[1] * toCam[1] + toSun[2] * toCam[2]) / (Math.hypot(...toSun) * Math.hypot(...toCam) || 1);
      const k = (1 + cosPhase) / 2;
      const E = (AU_KM / Math.max(Math.hypot(...b.helio), 1e6)) ** 2;
      // Ring systems roughly double Saturn's lit area on screen.
      const ringBoost = b.key === 'saturn' ? 2.2 : 1;
      const add = cov * k * b.albedo * E * (b.eclipseVisible ?? 1) * 0.8 * ringBoost;
      if (isFinite(add)) lum += add;
      // Highlight rule: a lit object big enough to look at (> 0.1 % of the view) must not blow out, even
      // on a black background — cap exposure so its brightest (Lambert-peak) surface reads ≈ 1.
      if (cov > 0.001 && k > 0.05) {
        const peak = (b.peakAlbedo ?? b.albedo) * E * (b.eclipseVisible ?? 1);
        if (peak > 1e-6) cap = Math.min(cap, 1.0 / peak);
      }
      covered += cov * ringBoost;
    }
    const bg = Math.max(0, 1 - covered) * 0.004 * E_cam;
    const L = lum + bg + sunLum * E_cam;
    const lo = 0.1 * Math.pow(E_cam, -0.85), hi = 3.0 * Math.pow(E_cam, -0.85);
    return Math.min(cap, Math.min(hi, Math.max(lo, 0.2 / L)));
  }

  adapt(target, dt) {
    // One bad frame (e.g. a zero-length vector) must never poison the smoothed exposure for good.
    if (!isFinite(this.exposure) || this.exposure <= 0) this.exposure = 1;
    if (!isFinite(target) || target <= 0) return this.exposure;
    // Eyes close fast (≈0.4 s) and open slowly (≈2.5 s).
    const tau = target < this.exposure ? 0.4 : 2.5;
    const k = 1 - Math.exp(-dt / tau);
    this.exposure = Math.exp(Math.log(this.exposure) + (Math.log(target) - Math.log(this.exposure)) * k);
    return this.exposure;
  }

  /** Lens flare: sun screen position + CPU-occluded visibility (fraction of sample points unblocked). */
  updateFlare(sunBody, bodies, time) {
    const u = this.flare.uniforms;
    u.uTime.value = time;
    const v = new THREE.Vector3(...sunBody.group.position.toArray()).project(this.camera);
    const inFront = new THREE.Vector3(...sunBody.group.position.toArray()).applyMatrix4(this.camera.matrixWorldInverse).z < 0;
    if (!this.settings.flare || !inFront) { u.uIntensity.value = 0; this.sunVisible = 0; return; }
    const sx = v.x * 0.5 + 0.5, sy = v.y * 0.5 + 0.5;
    // Occlusion: rays from the camera (origin) to 13 points across the solar disc vs every body sphere.
    const S = sunBody.group.position, R = sunBody.rScene;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(R);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion).multiplyScalar(R);
    let vis = 0, n = 0;
    const pts = [[0, 0]];
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; pts.push([Math.cos(a) * 0.5, Math.sin(a) * 0.5], [Math.cos(a + 0.5) * 0.9, Math.sin(a + 0.5) * 0.9]); }
    for (const [px, py] of pts) {
      const target = S.clone().addScaledVector(right, px).addScaledVector(up, py);
      const dist = target.length(), dir = target.clone().divideScalar(dist);
      let blocked = false;
      for (const b of bodies) {
        if (b.kind === 'sun') continue;
        const c = b.group.position, t = c.dot(dir);
        if (t <= 0 || t > dist) continue;
        const d2 = c.lengthSq() - t * t;
        if (d2 < b.rScene * b.rScene) { blocked = true; break; }
      }
      n++; if (!blocked) vis++;
    }
    const visible = vis / n;
    this.sunVisible = visible;
    const edge = Math.max(Math.abs(v.x), Math.abs(v.y));
    const onScreen = 1 - Math.min(1, Math.max(0, (edge - 1.0) / 0.5));
    u.uSun.value.set(sx, sy);
    u.uAspect.value = this.composer.renderTarget1.width / this.composer.renderTarget1.height;
    // Intensity in pre-tonemap units; divide by exposure so the flare is exposure-independent.
    u.uIntensity.value = visible * onScreen * 1.2 * (this.flareScale ?? 1) / this.exposure;
  }

  render(dt, time) {
    this.bloom.strength = this.settings.bloom;
    this.bloom.threshold = this.settings.bloomThreshold / this.exposure;   // threshold in post-exposure units
    this.final.uniforms.uTime.value = time;
    this.final.uniforms.uGrain.value = this.settings.grain;
    this.final.uniforms.uVignette.value = this.settings.vignette;
    this.final.uniforms.uCA.value = this.settings.chromatic;
    this.renderer.toneMappingExposure = this.exposure;
    this.composer.render(dt);
  }
}
