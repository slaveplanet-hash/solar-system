// =============================================================================
// textures.js — Photographic planet maps (Solar System Scope, CC BY 4.0), loaded
// lazily and in tiers:
//   tier 0 (2K)   when a body's disc first exceeds a few pixels; kept afterwards.
//   tier 1 (4–8K) only on close approach (disc > ~450 px), if the quality preset
//                 and the GPU (maxTextureSize) allow the image's REAL size; disposed
//                 again 4 s after the disc drops below ~180 px (falls back to 2K).
// Images are decoded off the main thread (ImageBitmap) and uploaded one at a time;
// a result that arrives after the body is no longer close is discarded at once.
// Only files listed in textures/textures.json are used; bodies without a listed map
// keep their procedural surface.
// =============================================================================
import * as THREE from 'three';

export const TEXTURE_BASE_URL = './textures/';

// body → layer → [tier 0, tier 1]. (Some "8k_" files are really 4096 px wide: tiers use the decoded size.)
export const PHOTO_TIERS = {
  mercury: { map: ['2k_mercury.jpg', '8k_mercury.jpg'] },
  venus: { map: ['2k_venus_atmosphere.jpg', '4k_venus_atmosphere.jpg'] },
  earth: { map: ['2k_earth_daymap.jpg', '8k_earth_daymap.jpg'], night: ['2k_earth_nightmap.jpg', '8k_earth_nightmap.jpg'], clouds: ['2k_earth_clouds.jpg', '8k_earth_clouds.jpg'] },
  moon: { map: ['2k_moon.jpg', '8k_moon.jpg'] },
  mars: { map: ['2k_mars.jpg', '8k_mars.jpg'] },
  jupiter: { map: ['2k_jupiter.jpg', '8k_jupiter.jpg'] },
  saturn: { map: ['2k_saturn.jpg', '8k_saturn.jpg'] },
  uranus: { map: ['2k_uranus.jpg'] },
  neptune: { map: ['2k_neptune.jpg'] },
};

// Real widths of the high tiers (textures/CREDITS.md): the "8k_" Jupiter/Saturn maps are 4096 px. Used to skip a
// file that the current preset could not use anyway, before spending memory and time decoding it.
export const REAL_WIDTH = {
  '8k_mercury.jpg': 8192, '4k_venus_atmosphere.jpg': 4096, '8k_earth_daymap.jpg': 8192, '8k_earth_nightmap.jpg': 8192,
  '8k_earth_clouds.jpg': 8192, '8k_moon.jpg': 8192, '8k_mars.jpg': 8192, '8k_jupiter.jpg': 4096, '8k_saturn.jpg': 4096,
};
const widthOf = (f) => REAL_WIDTH[f] ?? (parseInt(f, 10) || 2) * 1024;

const HI_IN = 450, HI_OUT = 180, HI_OUT_S = 4, LO_IN = 3;   // disc radius in px (a 1080p screen is ~540 px half-height)

export class PhotoTextures {
  constructor(system, renderer) {
    this.system = system;
    this.renderer = renderer;
    this.list = null;              // files present (textures.json "available")
    this.maxSize = 8192;           // set by the quality preset (Low 2048, Medium 4096, High 8192)
    this.busy = false;
    this.anyLoaded = false;
    this.loader = new THREE.ImageBitmapLoader().setOptions({ imageOrientation: 'flipY', premultiplyAlpha: 'none' });
    this.stats = { loads: 0, unloads: 0, lastMs: 0 };
  }

  async init() {
    let list = [];
    try {
      const r = await fetch(TEXTURE_BASE_URL + 'textures.json', { cache: 'no-cache' });
      if (r.ok) list = (await r.json()).available || [];
    } catch { /* offline or missing: procedural only */ }
    this.list = list;
    for (const [key, layers] of Object.entries(PHOTO_TIERS)) {
      const b = this.system.byKey[key];
      if (!b) continue;
      b.photo = {};
      for (const [layer, files] of Object.entries(layers)) {
        const avail = files.filter((f) => list.includes(f));
        if (!avail.length || !list.includes(files[0])) continue;
        b.photo[layer] = { files, tex: [null, null], bitmaps: [null, null], state: 'pending', hiSince: 0, lowSince: 0, hiFailed: false };
      }
      // The procedural pump must not build a map that the photo would replace a moment later.
      if (b.photo.map && b.textureState === 'flat') b.textureState = 'photo-pending';
    }
    return list;
  }

  /** Quality preset changed: allow new upgrades, and drop (now) oversized high tiers immediately. */
  setMaxSize(px) {
    const gpu = this.renderer.capabilities.maxTextureSize || 4096;
    this.maxSize = Math.min(px, gpu);
    for (const b of this.system.bodies) for (const [layer, p] of Object.entries(b.photo || {})) {
      p.hiFailed = false;
      if (p.tex[1] && p.bitmaps[1].width > this.maxSize) { this._apply(b, layer, p.tex[0]); this._free(p, 1); this.stats.unloads++; }
    }
  }

  _load(file, srgb) {
    return new Promise((resolve, reject) => {
      this.loader.load(TEXTURE_BASE_URL + file, (bitmap) => {
        const tex = new THREE.Texture(bitmap);
        tex.flipY = false;                                     // flipped during decode (imageOrientation)
        tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
        tex.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
        tex.wrapS = THREE.RepeatWrapping;
        tex.needsUpdate = true;
        resolve({ tex, bitmap });
      }, undefined, reject);
    });
  }

  _apply(b, layer, tex) {
    const sys = this.system, u = b.material.uniforms;
    if (layer === 'map') {
      if (b.map && b.map !== tex && !this._isPhoto(b, b.map)) b.map.dispose();   // procedural / flat map
      u.uMap.value = tex; b.map = tex;
      b.flatTex = null;
      b.textureState = 'photo';
      // Procedural city lights follow procedural continents: drop them if no real night map exists.
      if (b.key === 'earth' && !b.photo.night && b.nightTex) { b.nightTex.dispose(); b.nightTex = null; u.uNight.value = null; u.uHasNight.value = 0; }
    } else if (layer === 'night') {
      if (b.nightTex && b.nightTex !== tex && !this._isPhoto(b, b.nightTex)) b.nightTex.dispose();
      b.nightTex = tex; u.uNight.value = tex; u.uHasNight.value = 1;
    } else if (layer === 'clouds') {
      if (b.cloudTex && b.cloudTex !== tex && !this._isPhoto(b, b.cloudTex)) b.cloudTex.dispose();
      b.cloudTex = tex; u.uClouds.value = tex; u.uHasClouds.value = 1;
      if (b.cloudMesh) b.cloudMesh.material.uniforms.uClouds.value = tex;
    }
    void sys;
  }

  _isPhoto(b, tex) { return Object.values(b.photo || {}).some((p) => p.tex.includes(tex)); }

  _free(p, tier) {
    p.tex[tier]?.dispose(); p.bitmaps[tier]?.close?.();
    p.tex[tier] = null; p.bitmaps[tier] = null;
  }

  /** One decision per frame: start at most one load, and unload stale high tiers. */
  update(now) {
    if (!this.list) return;
    let job = null;
    for (const b of this.system.bodies) {
      if (!b.photo) continue;
      for (const [layer, p] of Object.entries(b.photo)) {
        // Unload the high tier after a while well away from the body.
        if (p.tex[1]) {
          if (b.pixelRadius < HI_OUT) { p.lowSince ||= now; if (now - p.lowSince > HI_OUT_S * 1000) { this._apply(b, layer, p.tex[0]); this._free(p, 1); this.stats.unloads++; p.lowSince = 0; } }
          else p.lowSince = 0;
        }
        if (this.busy) continue;
        const wantLo = !p.tex[0] && p.state !== 'failed' && (b.pixelRadius > LO_IN || b.key === 'earth');
        const wantHi = p.tex[0] && !p.tex[1] && !p.hiFailed && p.files[1] && this.list.includes(p.files[1]) && widthOf(p.files[1]) <= this.maxSize && b.pixelRadius > HI_IN;
        if ((wantLo || wantHi) && (!job || b.pixelRadius > job.b.pixelRadius)) job = { b, layer, p, tier: wantLo ? 0 : 1 };
      }
    }
    if (job && !this.busy) this._run(job);
  }

  async _run({ b, layer, p, tier }) {
    this.busy = true;
    const t0 = performance.now();
    try {
      const { tex, bitmap } = await this._load(p.files[tier], layer !== 'clouds');
      if (tier === 1 && (bitmap.width > this.maxSize || b.pixelRadius < HI_OUT)) {
        // Too large for this preset/GPU, or the viewer already left: discard immediately.
        tex.dispose(); bitmap.close?.();
        if (bitmap.width > this.maxSize) p.hiFailed = true;
      } else {
        p.tex[tier] = tex; p.bitmaps[tier] = bitmap; p.state = 'loaded';
        this._apply(b, layer, tex);
        this.anyLoaded = true;
        this.stats.loads++;
      }
    } catch (e) {
      console.warn(`[textures] ${p.files[tier]} failed to load — keeping the ${tier ? '2K' : 'procedural'} map`, e);
      if (tier === 0) { p.state = 'failed'; if (layer === 'map' && b.textureState === 'photo-pending') b.textureState = 'flat'; }   // procedural takes over
      else p.hiFailed = true;
    }
    this.stats.lastMs = performance.now() - t0;
    this.busy = false;
  }

  /** Current tier per body/layer (for the HUD, tests and the leak audit). */
  summary() {
    const out = {};
    for (const b of this.system.bodies) if (b.photo) for (const [layer, p] of Object.entries(b.photo)) {
      out[`${b.key}${layer === 'map' ? '' : ':' + layer}`] = p.tex[1] ? `${p.bitmaps[1].width}px` : p.tex[0] ? `${p.bitmaps[0].width}px` : p.state;
    }
    return out;
  }
}
