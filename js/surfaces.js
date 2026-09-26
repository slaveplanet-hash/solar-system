// =============================================================================
// surfaces.js — Procedural equirectangular maps (fallbacks when no photographic
// texture is present) and 1-D ring profiles.
//
// Noise is sampled on the unit sphere → no seam, no polar pinching.
// Texture u = 0.5 is the prime meridian (body +x), east is +u, top row = north.
// =============================================================================
import * as THREE from 'three';

const TAU = Math.PI * 2, D = Math.PI / 180;

// --- noise ---------------------------------------------------------------------
function hash3(i, j, k, seed) {
  let h = Math.imul(i, 73856093) ^ Math.imul(j, 19349663) ^ Math.imul(k, 83492791) ^ Math.imul(seed, 2654435761);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x, y, z, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  const a = hash3(xi, yi, zi, seed), b = hash3(xi + 1, yi, zi, seed), c = hash3(xi, yi + 1, zi, seed), d = hash3(xi + 1, yi + 1, zi, seed);
  const e = hash3(xi, yi, zi + 1, seed), f = hash3(xi + 1, yi, zi + 1, seed), g = hash3(xi, yi + 1, zi + 1, seed), h = hash3(xi + 1, yi + 1, zi + 1, seed);
  const l1 = a + (b - a) * u, l2 = c + (d - c) * u, l3 = e + (f - e) * u, l4 = g + (h - g) * u;
  const m1 = l1 + (l2 - l1) * v, m2 = l3 + (l4 - l3) * v;
  return m1 + (m2 - m1) * w;
}
export function fbm(x, y, z, oct = 5, seed = 1) {
  let a = 0.5, f = 1, s = 0, n = 0;
  for (let o = 0; o < oct; o++) { s += a * vnoise(x * f, y * f, z * f, seed + o); n += a; a *= 0.5; f *= 2.03; }
  return s / n;
}
const ridge = (x, y, z, oct, seed) => 1 - Math.abs(fbm(x, y, z, oct, seed) * 2 - 1);
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const clamp01 = (t) => Math.max(0, Math.min(1, t));
const sstep = (e0, e1, x) => { const t = clamp01((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
const angDist = (lat1, lon1, lat2, lon2) => Math.acos(Math.min(1, Math.sin(lat1) * Math.sin(lat2) + Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon1 - lon2)));
/** Crater field: returns darkening/brightening from pseudo-random craters in a cell grid. */
function craters(x, y, z, scale, seed) {
  const n = ridge(x * scale, y * scale, z * scale, 3, seed);
  return sstep(0.82, 0.97, n) - 0.5 * sstep(0.65, 0.8, n);
}

// Earth land/ocean height shared by day map, night lights and cloud placement.
function earthHeight(x, y, z) {
  const w = fbm(x * 3, y * 3, z * 3, 3, 51) - 0.5;
  return fbm(x * 1.8 + w, y * 1.8 + w, z * 1.8 + w, 6, 52);
}

// --- surface styles: (x,y,z,lat,lon) → [r,g,b] 0–255 (sRGB) -----------------------------
export const SURFACES = {
  sun(x, y, z) { return mix([255, 170, 70], [255, 236, 190], clamp01(0.35 + 0.5 * fbm(x * 40, y * 40, z * 40, 3, 11))); },
  mercury(x, y, z) {
    const n = fbm(x * 5, y * 5, z * 5, 6, 21);
    return mix([95, 90, 86], [185, 178, 168], clamp01(n * 0.9 + craters(x, y, z, 9, 22) * 0.35 + 0.05));
  },
  moon(x, y, z, lat, lon) {
    const n = fbm(x * 4, y * 4, z * 4, 6, 31);
    const maria = sstep(0.52, 0.6, fbm(x * 2.2, y * 2.2, z * 2.2, 4, 33) + 0.12 * Math.cos(lon) * Math.cos(lat));
    const c = mix([120, 118, 114], [205, 202, 195], clamp01(n * 0.8 + craters(x, y, z, 10, 32) * 0.35 + 0.1));
    return mix(c, [70, 70, 72], maria * 0.75);
  },
  venus(x, y, z, lat) {
    const w = fbm(x * 3, y * 3, z * 3, 4, 41), b = fbm(x * 2 + w, y * 2 + w, z * 12, 5, 42);
    return mix([205, 165, 100], [245, 225, 175], clamp01(b * 1.1 - 0.05 + 0.1 * Math.cos(lat)));
  },
  earth(x, y, z, lat) {
    const h = earthHeight(x, y, z), alat = Math.abs(lat) / D;
    if (h < 0.53) return mix([6, 22, 62], [22, 78, 135], sstep(0.44, 0.53, h));
    const veg = fbm(x * 6, y * 6, z * 6, 4, 53);
    const dry = sstep(12, 22, alat) * (1 - sstep(32, 42, alat));
    let c = mix([45, 95, 40], [150, 125, 80], clamp01(dry * 0.9 + (veg - 0.5)));
    c = mix(c, [110, 95, 80], sstep(0.62, 0.72, h));
    return mix(c, [240, 244, 248], sstep(64, 72, alat + 6 * (veg - 0.5)));
  },
  earthNight(x, y, z, lat) {
    const h = earthHeight(x, y, z), alat = Math.abs(lat) / D;
    if (h < 0.535) return [0, 0, 0];
    const coast = 1 - sstep(0.535, 0.6, h);                                   // people live near coasts
    const band = sstep(5, 20, alat) * (1 - sstep(55, 65, alat));             // populated latitudes
    const city = sstep(0.62, 0.8, fbm(x * 24, y * 24, z * 24, 3, 57)) * 1.2 + sstep(0.7, 0.9, fbm(x * 70, y * 70, z * 70, 2, 58)) * 0.6;
    const v = clamp01(city * (0.25 + coast) * (0.2 + band));
    return [255 * v, 205 * v, 130 * v];
  },
  earthClouds(x, y, z, lat) {
    // Returns [a,a,a]; alpha channel is filled from red by the generator.
    const alat = Math.abs(lat) / D;
    const w = fbm(x * 2, y * 2, z * 2, 3, 61) - 0.5;
    const n = fbm(x * 4 + w * 1.5, y * 4 + w * 1.5, z * 7, 6, 62);
    // More cloud in the ITCZ and mid-latitude storm tracks, less in the subtropical highs.
    const g = (c, w) => Math.exp(-(((alat - c) / w) ** 2));
    const belt = 0.08 * g(3, 8) + 0.1 * g(55, 12) - 0.07 * g(25, 8);
    const a = clamp01(sstep(0.5, 0.72, n + belt) * 1.05);
    return [255 * a, 255 * a, 255 * a];
  },
  mars(x, y, z, lat) {
    const n = fbm(x * 4, y * 4, z * 4, 6, 61), d = fbm(x * 2, y * 2, z * 2, 4, 62);
    let c = mix([165, 75, 40], [215, 130, 80], clamp01(n + craters(x, y, z, 8, 63) * 0.15));
    c = mix(c, [95, 55, 38], sstep(0.55, 0.65, d) * 0.8);
    return mix(c, [245, 240, 235], sstep(78, 83, Math.abs(lat) / D + 4 * (n - 0.5)));
  },
  jupiter(x, y, z, lat, lon) {
    const t = fbm(x * 3, y * 3, z * 30, 5, 71) - 0.5;
    const s = Math.sin(lat * 14 + t * 2.2) * 0.5 + 0.5;
    let c = mix([236, 224, 200], [170, 112, 72], sstep(0.35, 0.75, s));
    c = mix(c, [150, 150, 160], sstep(55, 75, Math.abs(lat) / D));
    const grs = angDist(lat, lon * 0.55, -22 * D, 60 * D * 0.55);
    return mix(c, [195, 105, 70], 1 - sstep(0.06, 0.1, grs + 0.02 * t));
  },
  saturn(x, y, z, lat) {
    const t = fbm(x * 2, y * 2, z * 24, 4, 81) - 0.5;
    const s = Math.sin(lat * 11 + t * 1.2) * 0.5 + 0.5;
    const c = mix([232, 214, 165], [196, 165, 110], sstep(0.4, 0.8, s) * 0.7);
    return mix(c, [150, 160, 170], sstep(70, 85, Math.abs(lat) / D) * 0.6);
  },
  uranus(x, y, z, lat) {
    const t = fbm(x * 2, y * 2, z * 16, 3, 91);
    return mix([150, 210, 218], [190, 232, 236], clamp01(0.3 + 0.25 * t + 0.3 * sstep(50, 85, Math.abs(lat) / D)));
  },
  neptune(x, y, z, lat, lon) {
    const t = fbm(x * 3, y * 3, z * 20, 5, 101);
    let c = mix([40, 72, 190], [95, 140, 235], clamp01(t * 1.1 + 0.15 * Math.sin(lat * 9)));
    c = mix(c, [235, 240, 255], sstep(0.72, 0.8, fbm(x * 6, y * 6, z * 40, 3, 102)) * 0.7);
    return mix(c, [20, 35, 110], 1 - sstep(0.07, 0.11, angDist(lat, lon * 0.6, -20 * D, 40 * D * 0.6)));
  },
  pluto(x, y, z, lat, lon) {
    const n = fbm(x * 4, y * 4, z * 4, 6, 111);
    let c = mix([150, 110, 80], [215, 180, 145], n);
    const cthulhu = (1 - sstep(8, 22, Math.abs(lat / D + 5))) * sstep(0.35, 0.6, Math.cos(lon - 115 * D));
    c = mix(c, [75, 45, 35], cthulhu * 0.85);
    return mix(c, [245, 238, 225], 1 - sstep(0.3, 0.45, angDist(lat, lon, 25 * D, 175 * D) + 0.1 * (n - 0.5)));
  },
  // --- moons ---
  phobos(x, y, z) {
    const n = fbm(x * 5, y * 5, z * 5, 5, 121);
    return mix([60, 55, 50], [120, 110, 100], clamp01(n * 0.8 + craters(x, y, z, 7, 122) * 0.5));
  },
  io(x, y, z) {
    const n = fbm(x * 4, y * 4, z * 4, 5, 131), p = fbm(x * 9, y * 9, z * 9, 3, 132);
    let c = mix([225, 200, 80], [245, 238, 170], n);
    c = mix(c, [190, 120, 50], sstep(0.6, 0.72, fbm(x * 3, y * 3, z * 3, 4, 133)) * 0.7);
    c = mix(c, [150, 55, 25], sstep(0.78, 0.84, p));                             // red Pele-like deposits
    return mix(c, [25, 20, 15], sstep(0.86, 0.9, fbm(x * 14, y * 14, z * 14, 2, 134)));   // volcanic calderas
  },
  europa(x, y, z) {
    const n = fbm(x * 3, y * 3, z * 3, 4, 141);
    const lines = sstep(0.93, 0.985, ridge(x * 6, y * 6, z * 6, 4, 142)) + 0.6 * sstep(0.95, 0.99, ridge(x * 13, y * 13, z * 13, 3, 143));
    const c = mix([225, 215, 195], [245, 240, 232], n);
    return mix(mix(c, [185, 150, 110], sstep(0.55, 0.7, fbm(x * 2, y * 2, z * 2, 4, 144)) * 0.5), [150, 95, 60], clamp01(lines) * 0.75);
  },
  ganymede(x, y, z) {
    const dark = sstep(0.5, 0.56, fbm(x * 2.5, y * 2.5, z * 2.5, 5, 151));
    const grooves = sstep(0.8, 0.95, ridge(x * 18, y * 18, z * 18, 2, 152));
    let c = mix([185, 178, 165], [100, 90, 78], dark);
    c = mix(c, [215, 210, 200], grooves * (1 - dark) * 0.5);
    return mix(c, [235, 235, 230], sstep(0.85, 0.97, ridge(x * 10, y * 10, z * 10, 3, 153)) * 0.5);
  },
  callisto(x, y, z) {
    const n = fbm(x * 4, y * 4, z * 4, 5, 161);
    const c = mix([70, 62, 52], [115, 102, 88], n);
    return mix(c, [210, 205, 195], sstep(0.88, 0.97, ridge(x * 16, y * 16, z * 16, 2, 162)) * 0.8);
  },
  icy(x, y, z) {
    const n = fbm(x * 4, y * 4, z * 4, 5, 171);
    return mix([165, 162, 158], [232, 230, 226], clamp01(n + craters(x, y, z, 9, 172) * 0.35));
  },
  enceladus(x, y, z, lat) {
    const n = fbm(x * 5, y * 5, z * 5, 4, 181);
    let c = mix([225, 232, 238], [250, 252, 255], n);
    const stripes = lat < -55 * D ? sstep(0.9, 0.97, ridge(x * 20, y * 3, z * 20, 2, 182)) : 0;
    return mix(c, [120, 150, 175], stripes * 0.8);
  },
  titan(x, y, z) {
    const n = fbm(x * 3, y * 3, z * 3, 5, 191);
    return mix([150, 95, 40], [210, 150, 70], n);
  },
  iapetus(x, y, z, lat, lon) {
    // Cassini Regio: the dark leading hemisphere centred near 90°W (= 270°E).
    const n = fbm(x * 4, y * 4, z * 4, 5, 201);
    const lead = sstep(-0.1, 0.25, Math.cos(lon - 270 * D) * Math.cos(lat) + 0.2 * (n - 0.5));
    return mix(mix([215, 208, 195], [240, 236, 228], n), [55, 38, 25], lead);
  },
  miranda(x, y, z) {
    const n = fbm(x * 3, y * 3, z * 3, 5, 211);
    const coronae = sstep(0.85, 0.95, ridge(x * 8, y * 2, z * 8, 3, 212));
    return mix(mix([150, 148, 145], [205, 203, 198], n), [110, 108, 105], coronae);
  },
  dark(x, y, z) {
    const n = fbm(x * 4, y * 4, z * 4, 5, 221);
    return mix([70, 68, 66], [125, 122, 118], clamp01(n + craters(x, y, z, 8, 222) * 0.3));
  },
  triton(x, y, z, lat) {
    const n = fbm(x * 6, y * 6, z * 6, 5, 231);
    const melon = sstep(0.4, 0.7, ridge(x * 14, y * 14, z * 14, 3, 232));
    let c = mix([175, 150, 140], [225, 205, 195], n);
    c = mix(c, [150, 125, 115], melon * 0.4 * (lat > -10 * D ? 1 : 0));
    return mix(c, [240, 225, 220], sstep(-15, -35, lat / D));                     // south polar cap
  },
  // --- asteroids & dwarf planets (tints follow measured colours/albedos) ---
  rubble(x, y, z) {                                   // Bennu/Ryugu: very dark (albedo ~0.045), boulder-strewn
    const n = fbm(x * 6, y * 6, z * 6, 5, 251), b = sstep(0.7, 0.85, fbm(x * 22, y * 22, z * 22, 2, 252));
    return mix(mix([38, 36, 35], [70, 67, 64], n), [110, 106, 100], b * 0.6);
  },
  itokawa(x, y, z) {                                  // S-type: grey-brown, smooth "seas" of fine gravel
    const n = fbm(x * 5, y * 5, z * 5, 5, 261), sea = sstep(0.55, 0.65, fbm(x * 2, y * 2, z * 2, 3, 262));
    return mix(mix([110, 100, 88], [165, 152, 135], n), [150, 140, 125], sea * 0.6);
  },
  eros(x, y, z) {                                     // S-type, albedo ~0.25
    const n = fbm(x * 5, y * 5, z * 5, 5, 271);
    return mix([120, 105, 85], [185, 168, 140], clamp01(n + craters(x, y, z, 9, 272) * 0.3));
  },
  vesta(x, y, z) {                                    // basaltic, bright (albedo ~0.42) with darker ejecta
    const n = fbm(x * 4, y * 4, z * 4, 5, 281), dark = sstep(0.58, 0.7, fbm(x * 2.5, y * 2.5, z * 2.5, 4, 282));
    return mix(mix([150, 145, 138], [210, 205, 196], clamp01(n + craters(x, y, z, 8, 283) * 0.3)), [95, 88, 80], dark * 0.6);
  },
  ceres(x, y, z, lat, lon) {                          // dark (albedo 0.09) with Occator's bright faculae (19.8°N, 239.3°E)
    const n = fbm(x * 4, y * 4, z * 4, 5, 291);
    const c = mix([62, 60, 58], [110, 106, 102], clamp01(n + craters(x, y, z, 10, 292) * 0.35));
    const occ = 1 - sstep(0.012, 0.03, angDist(lat, lon, 19.8 * D, 239.3 * D));
    return mix(c, [245, 245, 240], occ);
  },
  psyche(x, y, z) {                                   // M-type: metallic grey
    const n = fbm(x * 5, y * 5, z * 5, 5, 301);
    return mix([95, 97, 102], [160, 162, 168], clamp01(n + craters(x, y, z, 8, 302) * 0.3));
  },
  pallas(x, y, z) {                                   // B-type: slightly bluish grey
    const n = fbm(x * 5, y * 5, z * 5, 5, 311);
    return mix([70, 74, 82], [135, 140, 150], clamp01(n + craters(x, y, z, 9, 312) * 0.3));
  },
  darkrock(x, y, z) {                                 // C-types (Hygiea, Phaethon, Didymos, Dimorphos, Apophis)
    const n = fbm(x * 5, y * 5, z * 5, 5, 321);
    return mix([60, 58, 56], [120, 116, 110], clamp01(n + craters(x, y, z, 9, 322) * 0.3));
  },
  eris(x, y, z) {                                     // albedo ~0.96: frost-covered, nearly white
    const n = fbm(x * 3, y * 3, z * 3, 4, 331);
    return mix([225, 225, 222], [252, 252, 250], n);
  },
  makemake(x, y, z) {                                 // bright, slightly reddish methane frost
    const n = fbm(x * 3, y * 3, z * 3, 4, 341);
    return mix([205, 175, 150], [245, 225, 205], n);
  },
  haumea(x, y, z, lat, lon) {                         // crystalline water ice with a dark red spot
    const n = fbm(x * 3, y * 3, z * 3, 4, 351);
    const c = mix([215, 218, 222], [245, 247, 250], n);
    return mix(c, [150, 70, 60], 1 - sstep(0.25, 0.4, angDist(lat, lon, 0, 90 * D)));
  },
  redtno(x, y, z) {                                   // very red TNOs (Sedna, Gonggong, Quaoar)
    const n = fbm(x * 3, y * 3, z * 3, 4, 361);
    return mix([140, 65, 40], [200, 110, 75], n);
  },
  orcus(x, y, z) {                                    // neutral grey water ice
    const n = fbm(x * 3, y * 3, z * 3, 4, 371);
    return mix([120, 122, 125], [175, 178, 182], clamp01(n + craters(x, y, z, 8, 372) * 0.2));
  },
  dysnomia(x, y, z) {                                 // very dark (albedo ~0.05)
    const n = fbm(x * 4, y * 4, z * 4, 4, 381);
    return mix([35, 33, 32], [70, 66, 62], n);
  },
  charon(x, y, z, lat) {
    const n = fbm(x * 4, y * 4, z * 4, 5, 241);
    const c = mix([120, 118, 115], [175, 172, 168], clamp01(n + craters(x, y, z, 8, 242) * 0.3));
    return mix(c, [110, 60, 45], sstep(55, 72, lat / D + 8 * (n - 0.5)));         // Mordor Macula
  },
};

/** Render a style into a CanvasTexture (equirectangular). `alphaFromRed` for cloud maps. */
export function makeSurfaceTexture(style, width = 512, { alphaFromRed = false, srgb = true } = {}) {
  const w = width, h = width / 2;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const img = ctx.createImageData(w, h);
  const fn = SURFACES[style];
  for (let j = 0; j < h; j++) {
    const lat = (0.5 - (j + 0.5) / h) * Math.PI, cl = Math.cos(lat), sl = Math.sin(lat);
    for (let i = 0; i < w; i++) {
      const lon = ((i + 0.5) / w - 0.5) * TAU;
      const c = fn(cl * Math.cos(lon), cl * Math.sin(lon), sl, lat, lon);
      const o = (j * w + i) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = alphaFromRed ? c[0] : 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = 4;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** A 1×1 texture of a flat color (placeholder until the lazy procedural map is generated). */
export function makeFlatTexture(hex) {
  const c = new THREE.Color(hex);
  const tex = new THREE.DataTexture(new Uint8Array([c.r * 255, c.g * 255, c.b * 255, 255]), 1, 1);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// -----------------------------------------------------------------------------
// Ring profiles: 1-D textures, RGB = particle albedo color (linear), A = normal optical depth / TAU_MAX.
// Radii in km from the planet center. Values from Cassini/Voyager ring profiles (simplified).
// -----------------------------------------------------------------------------
export const TAU_MAX = 3.0;
export const RING_SYSTEMS = {
  saturn: {
    inner: 66900, outer: 141000, albedo: 0.55,
    // [r0, r1, τ, color]
    bands: [
      [66900, 74490, 0.002, [0.55, 0.5, 0.45]],                  // D ring
      [74490, 91980, 0.08, [0.5, 0.45, 0.4]],                    // C ring
      [87400, 87650, 0.0, null],                                  // Maxwell gap
      [91980, 99000, 1.1, [0.85, 0.78, 0.66]],                   // inner B
      [99000, 104500, 2.2, [0.92, 0.85, 0.72]],                  // B core
      [104500, 110000, 2.6, [0.95, 0.88, 0.75]],
      [110000, 117580, 1.8, [0.9, 0.83, 0.7]],                   // outer B
      [117580, 122170, 0.12, [0.55, 0.5, 0.45]],                 // Cassini Division
      [117680, 117965, 0.0, null],                                // Huygens gap
      [122170, 133423, 0.55, [0.82, 0.76, 0.66]],                // A ring
      [133423, 133745, 0.0, null],                                // Encke gap
      [133745, 136485, 0.45, [0.8, 0.74, 0.64]],
      [136485, 136527, 0.0, null],                                // Keeler gap
      [136527, 136775, 0.35, [0.78, 0.72, 0.62]],
      [140150, 140230, 0.6, [0.85, 0.8, 0.72]],                  // F ring
    ],
    ringlets: 0.25,
  },
  uranus: {
    inner: 38000, outer: 52000, albedo: 0.05,
    bands: [[41837, 41845, 0.3, [0.5, 0.5, 0.5]], [42234, 42242, 0.3, [0.5, 0.5, 0.5]], [42571, 42580, 0.3, [0.5, 0.5, 0.5]],
      [44718, 44728, 0.4, [0.5, 0.5, 0.5]], [45661, 45672, 0.4, [0.5, 0.5, 0.5]], [47176, 47178, 0.2, [0.5, 0.5, 0.5]],
      [47627, 47631, 0.8, [0.5, 0.5, 0.5]], [48300, 48306, 0.5, [0.5, 0.5, 0.5]], [51110, 51190, 1.2, [0.5, 0.5, 0.5]]],
    ringlets: 0,
  },
  jupiter: {
    inner: 92000, outer: 226000, albedo: 0.05,
    bands: [[92000, 122500, 0.004, [0.7, 0.5, 0.4]], [122500, 129000, 0.02, [0.75, 0.55, 0.42]],
      [129000, 182000, 0.002, [0.7, 0.55, 0.45]], [182000, 226000, 0.001, [0.7, 0.55, 0.45]]],
    ringlets: 0, forward: 8,
  },
  // Haumea's ring (Ortiz et al. 2017): radius ≈ 2,287 km, ~70 km wide, in the equatorial plane.
  haumea: {
    inner: 2150, outer: 2420, albedo: 0.09,
    bands: [[2252, 2322, 0.5, [0.75, 0.72, 0.7]]],
    ringlets: 0,
  },
  neptune: {
    inner: 40000, outer: 64000, albedo: 0.05,
    bands: [[40900, 42900, 0.01, [0.6, 0.6, 0.6]], [53180, 53220, 0.08, [0.6, 0.6, 0.6]], [53220, 57200, 0.004, [0.6, 0.6, 0.6]],
      [57180, 57220, 0.03, [0.6, 0.6, 0.6]], [62900, 62960, 0.12, [0.6, 0.6, 0.6]]],
    ringlets: 0, forward: 4,
  },
};

/** Build the 1-D ring profile DataTexture (RGBA8; A = sqrt(τ/TAU_MAX) so faint rings keep precision). */
export function makeRingTexture(sys, n = 4096) {
  const data = new Uint8Array(n * 4);
  const tau = new Float32Array(n), col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const r = sys.inner + ((i + 0.5) / n) * (sys.outer - sys.inner);
    let t = 0, c = [0.5, 0.5, 0.5];
    for (const [r0, r1, tb, cb] of sys.bands) if (r >= r0 && r < r1) { t = tb; if (cb) c = cb; }
    if (sys.ringlets && t > 0.05) t *= 1 + sys.ringlets * (fbm(r / 180, 0.5, 0.5, 4, 301) - 0.5) * 2;   // fine radial structure
    tau[i] = t; col.set(c, i * 3);
  }
  for (let i = 0; i < n; i++) {
    data[i * 4] = col[i * 3] * 255; data[i * 4 + 1] = col[i * 3 + 1] * 255; data[i * 4 + 2] = col[i * 3 + 2] * 255;
    data[i * 4 + 3] = Math.round(Math.sqrt(Math.min(1, tau[i] / TAU_MAX)) * 255);
  }
  const tex = new THREE.DataTexture(data, n, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

/** CPU lookup of ring optical depth at radius r (km) — used for verification/UI. */
export function ringTauAt(sys, r) {
  let t = 0;
  for (const [r0, r1, tb] of sys.bands) if (r >= r0 && r < r1) t = tb;
  return t;
}
