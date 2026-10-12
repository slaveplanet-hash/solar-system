// =============================================================================
// ships/Sample.js — Sample ship, procedural (no files loaded).
// Model code adapted from a stand-alone Three.js viewer of the same model.
// Changes for the simulator: the model's own point lights are removed (the Sun
// lights the ship), the Bussard shader writes logarithmic depth, and the glow
// animation is pre-divided by exposure like the rest of the ship's HDR lights.
// Axis convention: +Z = bow, +Y = dorsal (up), +X = port. Units are metres.
// =============================================================================
import * as THREE from 'three';

/* =====================================================================
   SHIP DIMENSIONS — edit these to re-proportion the whole ship.
   Everything else is derived from them.
   ===================================================================== */
const SAUCER_RADIUS        = 63.5;   // primary hull radius (127 m diameter)
const SAUCER_THICKNESS     = 20.5;   // lower sensor dome to top of B/C deck
const BRIDGE_RADIUS        = 4.8;
const ENGINEERING_LENGTH   = 148;    // secondary hull, deflector rim to shuttle-bay doors
const ENGINEERING_RADIUS   = 12.6;
const ENGINEERING_NOSE_Z   = -25;    // where the secondary hull starts (saucer centre = 0)
const NECK_HEIGHT          = 23.7;   // vertical gap between saucer bottom and secondary hull top
const NECK_THICKNESS       = 7.0;
const NACELLE_LENGTH       = 150;
const NACELLE_RADIUS       = 6.5;
const NACELLE_SPACING      = 88;     // centre-to-centre
const NACELLE_ELEVATION    = 11;      // nacelle centreline above saucer rim plane
const NACELLE_NOSE_Z       = -76;
const PYLON_THICKNESS      = 3.0;
const DEFLECTOR_RADIUS     = 7.4;

// ---- derived values ----
const SX = SAUCER_RADIUS / 63.5;           // saucer profile is authored for R = 63.5
const SY = SAUCER_THICKNESS / 19.4;        // ...and thickness 19.4
const SAUCER_TOP_Y = 7.6 * SY;
const SAUCER_BOTTOM_Y = -11.8 * SY;
const ENG_Y = SAUCER_BOTTOM_Y - NECK_HEIGHT - ENGINEERING_RADIUS;
const ENG_REAR_Z = ENGINEERING_NOSE_Z - ENGINEERING_LENGTH;
const NAC_X = NACELLE_SPACING / 2;
const NAC_Y = NACELLE_ELEVATION;
const NAC_CENTER_Z = NACELLE_NOSE_Z - NACELLE_LENGTH / 2;
const NR = NACELLE_RADIUS / 6.5;           // nacelle profile authored for r = 6.5, L = 150
const NS = NACELLE_LENGTH / 150;

const SHIP_TARGET = new THREE.Vector3(0, -24, -80);
const CAMERA_HOME = new THREE.Vector3(185, 52, 112);

/* =====================================================================
   PROFILES (authored units — scaled by the constants above)
   ===================================================================== */

// Saucer: [radius, height] listed from the top centre, out over the rim and back to the
// bottom centre. Split into pieces so each layer gets its own material and crisp edges.
const SAUCER_PROFILE = {
  deckTop:   [[0, 7.6], [5, 7.6], [9.6, 7.5], [10.6, 7.25]],
  deckWall:  [[10.6, 7.25], [11.3, 6.7], [11.9, 5.8], [12.8, 5.25]],
  upper:     [[12.8, 5.25], [16, 5.0], [22, 4.55], [30, 3.85], [38, 3.15], [46, 2.5], [54, 1.95], [59, 1.65], [61.9, 1.45]],
  rimUpper:  [[61.9, 1.45], [62.7, 1.3], [63.25, 1.0], [63.35, 0.75]],
  rimBand:   [[63.35, 0.75], [63.0, 0.68], [63.0, -0.68], [63.35, -0.75]],
  rimLower:  [[63.35, -0.75], [63.25, -1.05], [62.7, -1.45], [61.7, -1.75]],
  lower:     [[61.7, -1.75], [56, -2.6], [48, -3.85], [40, -5.15], [32, -6.45], [25, -7.5], [19.5, -8.3], [18.0, -8.5]],
  domeStep:  [[18.0, -8.5], [17.5, -8.7], [17.1, -9.05]],
  lowerDome: [[17.1, -9.05], [14.5, -9.8], [11.5, -10.5], [8, -11.15], [4, -11.65], [0, -11.8]],
};

// Secondary hull stations: [fraction of length from nose, rx, ry, centre-y offset, superellipse power]
// (radii in units of ENGINEERING_RADIUS). The underside sweeps up into the shuttle-bay "boat tail".
const HULL_STATIONS = [
  [0.000, 0.83, 0.83, 0.00, 2.0],
  [0.006, 0.89, 0.89, 0.00, 2.0],
  [0.012, 0.92, 0.92, 0.00, 2.0],
  [0.030, 0.90, 0.90, 0.00, 2.0],
  [0.052, 0.925, 0.925, 0.00, 2.0],
  [0.150, 0.965, 0.965, 0.00, 2.0],
  [0.330, 1.00, 1.00, 0.00, 2.0],
  [0.550, 1.00, 1.00, 0.00, 2.0],
  [0.700, 0.955, 0.95, 0.02, 2.05],
  [0.800, 0.86, 0.83, 0.09, 2.15],
  [0.875, 0.75, 0.69, 0.19, 2.3],
  [0.940, 0.64, 0.56, 0.29, 2.45],
  [0.985, 0.575, 0.48, 0.335, 2.6],
  [1.000, 0.56, 0.465, 0.34, 2.6],
];

// Nacelle: [radius, distance from the nose] in authored units.
const NACELLE_PROFILE = {
  collar: [[6.2, 12.6], [6.75, 13.2], [6.9, 14.4], [6.8, 15.6], [6.45, 16.6]],
  body:   [[6.45, 16.6], [6.55, 20], [6.6, 40], [6.55, 80], [6.45, 105], [6.25, 122], [5.95, 133], [5.45, 140], [4.9, 145]],
  rear:   [[4.9, 145], [5.0, 145.6], [4.85, 147.2], [4.4, 148.2], [3.9, 148.4], [3.7, 147.8]],
};

/* =====================================================================
   SMALL UTILITIES
   ===================================================================== */
const lerp = THREE.MathUtils.lerp;
const clamp = THREE.MathUtils.clamp;
const DEG = Math.PI / 180;
const se = (v, n) => Math.sign(v) * Math.pow(Math.abs(v), 2 / n);   // superellipse helper

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const catmull = (p0, p1, p2, p3, t) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
};

// Matrix that places a unit object at `pos`, with local +Z along `normal`, local +X along `tangent`.
function surfaceMatrix(pos, normal, tangent, sx = 1, sy = 1, sz = 1) {
  const z = normal.clone().normalize();
  const x = tangent.clone().sub(z.clone().multiplyScalar(tangent.dot(z))).normalize();
  const y = new THREE.Vector3().crossVectors(z, x);
  const m = new THREE.Matrix4().makeBasis(x.multiplyScalar(sx), y.multiplyScalar(sy), z.multiplyScalar(sz));
  return m.setPosition(pos);
}

// Orient an object so local +Y is the surface normal and local +X follows `tangent`.
function placeOnSurface(obj, pos, normal, tangent) {
  const y = normal.clone().normalize();
  const x = tangent.clone().sub(y.clone().multiplyScalar(tangent.dot(y))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  obj.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  obj.position.copy(pos);
  return obj;
}

// LatheGeometry from a profile listed top-to-bottom (or nose-to-tail): reversed so faces point outward.
function latheFromProfile(list, map, segments) {
  return new THREE.LatheGeometry(list.map(map).reverse(), segments);
}
const saucerMap = ([r, y]) => new THREE.Vector2(r * SX, y * SY);

// Generic loft: rings of equal point count -> closed tube with UVs (u along loft, v around).
function loftRings(rings, uValues) {
  const R = rings.length, N = rings[0].length;
  const pos = new Float32Array(R * (N + 1) * 3);
  const uv = new Float32Array(R * (N + 1) * 2);
  let pi = 0, ui = 0;
  for (let i = 0; i < R; i++) {
    for (let k = 0; k <= N; k++) {
      const p = rings[i][k % N];
      pos[pi++] = p.x; pos[pi++] = p.y; pos[pi++] = p.z;
      uv[ui++] = uValues ? uValues[i] : i / (R - 1);
      uv[ui++] = k / N;
    }
  }
  const idx = [];
  for (let i = 0; i < R - 1; i++) {
    for (let k = 0; k < N; k++) {
      const a = i * (N + 1) + k, b = a + N + 1, c = a + 1, d = b + 1;
      idx.push(a, b, c, b, d, c);
    }
  }
  // Make sure faces point away from the section centre.
  const m = Math.floor((R - 1) / 2);
  const cen = new THREE.Vector3();
  rings[m].forEach(p => cen.add(p)); cen.divideScalar(N);
  let score = 0;
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), n = new THREE.Vector3();
  for (let k = 0; k < N; k++) {
    const pa = rings[m][k], pb = rings[m + 1][k], pc = rings[m][(k + 1) % N];
    e1.subVectors(pb, pa); e2.subVectors(pc, pa); n.crossVectors(e1, e2);
    score += n.dot(pa.clone().sub(cen));
  }
  if (score < 0) for (let t = 0; t < idx.length; t += 3) { const s = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = s; }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  // Weld normals across the UV seam.
  const nrm = geo.attributes.normal;
  for (let i = 0; i < R; i++) {
    const a = i * (N + 1), b = a + N;
    n.set(nrm.getX(a) + nrm.getX(b), nrm.getY(a) + nrm.getY(b), nrm.getZ(a) + nrm.getZ(b)).normalize();
    nrm.setXYZ(a, n.x, n.y, n.z); nrm.setXYZ(b, n.x, n.y, n.z);
  }
  return geo;
}

function applyPlanarUV(geo, top) {
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), z = p.getZ(i);
    uv.setXY(i, 0.5 + (top ? -x : x) / (2 * SAUCER_RADIUS), 0.5 + z / (2 * SAUCER_RADIUS));
  }
  uv.needsUpdate = true;
}

/* =====================================================================
   SURFACE SAMPLING — so windows, panels and phasers follow the hull curvature
   ===================================================================== */

// Point/normal/tangent on a saucer profile piece at world radius r and azimuth phi (0 = bow).
function saucerFrame(list, r, phi, lift = 0) {
  const pts = list.map(saucerMap);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
    if ((r - a.x) * (r - b.x) <= 0 && a.x !== b.x) {
      const t = (r - a.x) / (b.x - a.x);
      const y = lerp(a.y, b.y, t);
      const dr = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dr, dy);
      const nr = -dy / L, ny = dr / L;            // outward normal for a top->bottom listing
      const radial = new THREE.Vector3(Math.sin(phi), 0, Math.cos(phi));
      const n = radial.clone().multiplyScalar(nr).add(new THREE.Vector3(0, ny, 0)).normalize();
      const p = radial.clone().multiplyScalar(r).add(new THREE.Vector3(0, y, 0)).addScaledVector(n, lift);
      return { p, n, t: new THREE.Vector3(Math.cos(phi), 0, -Math.sin(phi)) };
    }
  }
  return null;
}

// Secondary-hull cross-section at fraction f (0 = nose, 1 = shuttle bay), world units.
function hullAt(f) {
  const T = HULL_STATIONS;
  f = clamp(f, 0, 1);
  let i = 0;
  while (i < T.length - 2 && f > T[i + 1][0]) i++;
  const t = clamp((f - T[i][0]) / (T[i + 1][0] - T[i][0]), 0, 1);
  const v = j => catmull(T[Math.max(i - 1, 0)][j], T[i][j], T[i + 1][j], T[Math.min(i + 2, T.length - 1)][j], t);
  const R = ENGINEERING_RADIUS;
  return { rx: v(1) * R, ry: v(2) * R, cy: v(3) * R, n: v(4) };
}

// Point on the secondary hull at fraction f and angle a (0 = port, PI/2 = dorsal).
function hullFrame(f, a, lift = 0) {
  const st = hullAt(f);
  const c = Math.cos(a), s = Math.sin(a);
  const n = new THREE.Vector3(c / st.rx, s / st.ry, 0).normalize();
  const p = new THREE.Vector3(st.rx * se(c, st.n), ENG_Y + st.cy + st.ry * se(s, st.n), ENGINEERING_NOSE_Z - f * ENGINEERING_LENGTH)
    .addScaledVector(n, lift);
  return { p, n, t: new THREE.Vector3(0, 0, 1) };
}

/* =====================================================================
   PROCEDURAL TEXTURES (canvas) — panel seams and registry markings
   ===================================================================== */
const FONT = '"Futura", "Century Gothic", "Trebuchet MS", Arial, sans-serif';

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

function drawSaucerSkin(g, S, top) {
  const R = SAUCER_RADIUS, k = S / (2 * R), c = S / 2;
  const rnd = mulberry32(top ? 11 : 23);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  const bands = (top ? [12.8, 19, 26, 33, 40, 47, 54, 61.9] : [17.1, 22, 29, 36, 43, 50, 56, 61.7]).map(r => r * SX);

  // plating: concentric bands split into sectors with subtle tone variation
  for (let i = 0; i < bands.length - 1; i++) {
    const r0 = bands[i] * k, r1 = bands[i + 1] * k, n = 16 + i * 8;
    for (let j = 0; j < n; j++) {
      const a0 = j / n * Math.PI * 2, a1 = (j + 1) / n * Math.PI * 2;
      const tone = 234 + Math.floor(rnd() * 18);
      g.fillStyle = `rgb(${tone},${tone},${tone + 1})`;
      g.beginPath(); g.arc(c, c, r1, a0, a1); g.arc(c, c, r0, a1, a0, true); g.closePath(); g.fill();
    }
  }
  // seams
  g.strokeStyle = 'rgba(80,86,94,0.55)'; g.lineWidth = 1.7;
  bands.forEach(r => { g.beginPath(); g.arc(c, c, r * k, 0, Math.PI * 2); g.stroke(); });
  g.strokeStyle = 'rgba(80,86,94,0.38)'; g.lineWidth = 1.3;
  for (let i = 0; i < bands.length - 1; i++) {
    const n = 16 + i * 8;
    for (let j = 0; j < n; j++) {
      const a = j / n * Math.PI * 2;
      g.beginPath();
      g.moveTo(c + Math.cos(a) * bands[i] * k, c + Math.sin(a) * bands[i] * k);
      g.lineTo(c + Math.cos(a) * bands[i + 1] * k, c + Math.sin(a) * bands[i + 1] * k);
      g.stroke();
    }
  }
  // small hatches and engineering marks
  g.lineWidth = 1.2;
  for (let i = 0; i < 70; i++) {
    const a = rnd() * Math.PI * 2, r = lerp(bands[1], bands[6], rnd()) * k;
    const w = (0.8 + rnd() * 1.6) * k, h = (0.6 + rnd() * 0.9) * k;
    g.save(); g.translate(c + Math.cos(a) * r, c + Math.sin(a) * r); g.rotate(a);
    g.strokeStyle = 'rgba(70,76,84,0.5)'; g.strokeRect(-w / 2, -h / 2, w, h);
    if (rnd() < 0.3) { g.fillStyle = 'rgba(60,66,72,0.18)'; g.fillRect(-w / 2, -h / 2, w, h); }
    g.restore();
  }

  // registry lettering — bow toward the top of the canvas
  const P = (x, z) => [c + (top ? -x : x) * k, c - z * k];
  g.fillStyle = '#1f2226'; g.textAlign = 'center'; g.textBaseline = 'middle';
  if (top) {
    g.font = `700 ${8.6 * SX * k}px ${FONT}`;
    g.fillText('SAMPLE-01', ...P(0, 37 * SX));
    g.font = `600 ${3.0 * SX * k}px ${FONT}`;
    if ('letterSpacing' in g) g.letterSpacing = `${0.5 * k}px`;
    g.fillText('SAMPLE', ...P(0, 25 * SX));
  } else {
    g.font = `700 ${8.0 * SX * k}px ${FONT}`;
    g.fillText('SAMPLE-01', ...P(0, 37 * SX));
  }
}

function drawHullSkin(g, W, H) {
  const L = ENGINEERING_LENGTH, C = 2 * Math.PI * ENGINEERING_RADIUS;
  const kU = W / L, kV = H / C;
  const rnd = mulberry32(7);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  const colW = 9 * kU, rows = 12;
  for (let x = 0; x < W; x += colW) {
    for (let r = 0; r < rows; r++) {
      const tone = 236 + Math.floor(rnd() * 16);
      g.fillStyle = `rgb(${tone},${tone},${tone + 1})`;
      g.fillRect(x, r * H / rows, colW, H / rows);
    }
  }
  g.strokeStyle = 'rgba(80,86,94,0.5)'; g.lineWidth = 1.6;
  for (let x = 0; x < W; x += colW) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); }
  for (let r = 0; r <= rows; r++) { g.beginPath(); g.moveTo(0, r * H / rows); g.lineTo(W, r * H / rows); g.stroke(); }

  const label = (sMid, v, flip) => {
    g.save();
    g.translate(sMid * kU, (1 - v) * H);
    if (flip) g.rotate(Math.PI);
    g.scale(kU / kV, 1);
    g.fillStyle = '#1f2226'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = `700 ${3.6 * kV}px ${FONT}`;
    g.fillText('SAMPLE-01', 0, 0);
    g.restore();
  };
  label(30, 0.30, false);   // port side, reads nose-to-tail
  label(30, 0.70, true);    // starboard side
}

function drawPanelSkin(g, S, cols, rows, seed) {
  const rnd = mulberry32(seed);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  for (let i = 0; i < cols; i++) for (let j = 0; j < rows; j++) {
    const tone = 236 + Math.floor(rnd() * 16);
    g.fillStyle = `rgb(${tone},${tone},${tone + 1})`;
    g.fillRect(i * S / cols, j * S / rows, S / cols, S / rows);
  }
  g.strokeStyle = 'rgba(80,86,94,0.5)'; g.lineWidth = 2;
  for (let i = 0; i <= cols; i++) { g.beginPath(); g.moveTo(i * S / cols, 0); g.lineTo(i * S / cols, S); g.stroke(); }
  for (let j = 0; j <= rows; j++) { g.beginPath(); g.moveTo(0, j * S / rows); g.lineTo(S, j * S / rows); g.stroke(); }
}

/* =====================================================================
   MATERIALS (shared)
   ===================================================================== */
const MAT = {};
const FX = { lights: [], navBlink: [], ringMats: [] };   // references used by the animation loop

function std(o) { return new THREE.MeshStandardMaterial(Object.assign({ envMapIntensity: 0.45 }, o)); }
function glowColor(r, g, b) { return new THREE.Color(r, g, b); }

function buildMaterials() {
  const saucerTop = canvasTexture(2048, 2048, (g, s) => drawSaucerSkin(g, s, true));
  const saucerBottom = canvasTexture(2048, 2048, (g, s) => drawSaucerSkin(g, s, false));
  const hullSkin = canvasTexture(2048, 1024, drawHullSkin);
  const neckSkin = canvasTexture(512, 512, (g, s) => drawPanelSkin(g, s, 5, 10, 3));
  const pylonSkin = canvasTexture(512, 512, (g, s) => drawPanelSkin(g, s, 6, 8, 5));
  const grille = canvasTexture(64, 512, (g, w, h) => {
    g.fillStyle = '#000'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 26; i++) {
      const y = i * h / 26;
      const grd = g.createLinearGradient(0, y, 0, y + h / 26 * 0.55);
      grd.addColorStop(0, '#ffcf8a'); grd.addColorStop(1, '#ff5a1e');
      g.fillStyle = grd; g.fillRect(4, y + 2, w - 8, h / 26 * 0.5);
    }
  });

  MAT.saucerTop    = std({ color: 0xdcdfdc, roughness: 0.5, metalness: 0.2, map: saucerTop });
  MAT.saucerBottom = std({ color: 0xd2d5d3, roughness: 0.55, metalness: 0.2, map: saucerBottom });
  MAT.hull         = std({ color: 0xd6d9d7, roughness: 0.52, metalness: 0.2 });
  MAT.hullAlt      = std({ color: 0xc5c9c8, roughness: 0.56, metalness: 0.22 });
  MAT.engHull      = std({ color: 0xd0d3d1, roughness: 0.54, metalness: 0.2, map: hullSkin });
  MAT.neck         = std({ color: 0xcdd0ce, roughness: 0.55, metalness: 0.2, map: neckSkin });
  MAT.pylon        = std({ color: 0xc9cdcc, roughness: 0.52, metalness: 0.24, map: pylonSkin });
  MAT.nacelle      = std({ color: 0xc3c7c9, roughness: 0.42, metalness: 0.32 });
  MAT.rimBand      = std({ color: 0x8e9398, roughness: 0.6, metalness: 0.35 });
  MAT.dark         = std({ color: 0x3d4248, roughness: 0.55, metalness: 0.5 });
  MAT.darker       = std({ color: 0x1b1e23, roughness: 0.7, metalness: 0.4 });
  MAT.chrome       = std({ color: 0x9ca5ad, roughness: 0.22, metalness: 0.9, envMapIntensity: 1.0 });
  MAT.seam         = std({ color: 0x6a7076, roughness: 0.7, metalness: 0.3 });
  MAT.panel        = std({ color: 0xadb1b3, roughness: 0.75, metalness: 0.2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  MAT.access       = std({ color: 0x969b9f, roughness: 0.6, metalness: 0.35, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  MAT.window       = new THREE.MeshBasicMaterial({ color: 0xffffff });

  MAT.deflector = std({ color: 0x9db8e6, roughness: 0.28, metalness: 0.55, emissive: 0x2f6bff, emissiveIntensity: 1.6, side: THREE.DoubleSide });
  MAT.deflectorCore = new THREE.MeshBasicMaterial({ color: glowColor(0.7, 0.95, 3.0) });
  MAT.deflectorCore.userData.base = MAT.deflectorCore.color.clone();

  MAT.bussardGlass = new THREE.MeshPhysicalMaterial({
    color: 0xa8d8ff, roughness: 0.06, metalness: 0, clearcoat: 1, transparent: true, opacity: 0.3,
    emissive: 0x3f7cff, emissiveIntensity: 0.35, depthWrite: false,
  });
  MAT.bussardCore = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uIntensity: { value: 2.4 },
      uA: { value: new THREE.Color(0.10, 0.35, 1.0) }, uB: { value: new THREE.Color(0.75, 0.92, 1.0) },
    },
    vertexShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        vUv = uv;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalize(normalMatrix * normal);
        vV = normalize(-mv.xyz);
        gl_Position = projectionMatrix * mv;
        #include <logdepthbuf_vertex>
      }`,
    fragmentShader: /* glsl */`
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform float uTime; uniform float uIntensity; uniform vec3 uA; uniform vec3 uB;
      varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main() {
        #include <logdepthbuf_fragment>
        // bands travel aft along the nacelle; vanes swirl slowly around the collector
        float band   = 0.5 + 0.5 * sin(vUv.y * 26.0 + uTime * 2.4);
        float swirl  = 0.5 + 0.5 * sin(vUv.x * 6.28318 * 5.0 + vUv.y * 10.0 - uTime * 1.1);
        float swirl2 = 0.5 + 0.5 * sin(vUv.x * 6.28318 * 3.0 - vUv.y * 6.0 + uTime * 0.7);
        float fres = 1.0 - abs(dot(normalize(vN), normalize(vV)));
        float tip = smoothstep(0.55, 1.0, vUv.y);
        float e = 0.45 + 0.35 * band + 0.3 * swirl * swirl2 + 0.5 * tip;
        vec3 col = mix(uA, uB, clamp(0.35 * swirl + 0.45 * tip + 0.3 * fres, 0.0, 1.0));
        gl_FragColor = vec4(col * e * uIntensity, 1.0);
      }`,
  });
  for (let i = 0; i < 4; i++) {
    const m = new THREE.MeshBasicMaterial({ color: glowColor(0.9, 1.3, 2.6) });
    m.userData.base = m.color.clone();
    FX.ringMats.push(m);
  }

  MAT.exhaust = new THREE.MeshBasicMaterial({ color: glowColor(3.0, 0.7, 0.18) });
  MAT.exhaust.userData.base = MAT.exhaust.color.clone();
  MAT.impulse = new THREE.MeshBasicMaterial({ color: glowColor(3.4, 0.9, 0.22) });
  MAT.impulse.userData.base = MAT.impulse.color.clone();
  MAT.grille = std({ color: 0x2a1d18, roughness: 0.6, metalness: 0.4, emissive: 0xff6a24, emissiveIntensity: 2.2, emissiveMap: grille });

  MAT.navRed   = new THREE.MeshBasicMaterial({ color: glowColor(4, 0.25, 0.2) });
  MAT.navGreen = new THREE.MeshBasicMaterial({ color: glowColor(0.25, 4, 0.5) });
  MAT.navWhite = new THREE.MeshBasicMaterial({ color: glowColor(4, 4, 4) });
  MAT.amber    = new THREE.MeshBasicMaterial({ color: glowColor(3, 1.6, 0.4) });
  MAT.sensorGlow = new THREE.MeshBasicMaterial({ color: glowColor(0.55, 0.65, 0.85) });
  [MAT.navRed, MAT.navGreen, MAT.navWhite, MAT.amber, MAT.sensorGlow].forEach(m => (m.userData.base = m.color.clone()));
}

/* =====================================================================
   REUSABLE DETAIL HELPERS
   ===================================================================== */
const windowSpecs = [];   // filled by builders, turned into one InstancedMesh
const panelSpecs = [];    // recessed maintenance panels (instanced)
const accessSpecs = [];   // circular access hatches (instanced)

// Ring of hull plating / seam. Lies in the XY plane (axis Z) unless `horizontal`.
function createPanelRing(radius, tube, material, horizontal = true, segments = 160) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, segments), material);
  if (horizontal) m.rotation.x = Math.PI / 2;
  return m;
}

// Structural ring on a nacelle.
function createEngineRing(radius, tube = 0.14) {
  return new THREE.Mesh(new THREE.TorusGeometry(radius, tube, 6, 72), MAT.dark);
}

// Queue a recessed maintenance panel on a surface frame.
function createHullPanel(frame, w, h) {
  if (frame) panelSpecs.push(surfaceMatrix(frame.p.clone().addScaledVector(frame.n, 0.03), frame.n, frame.t, w, h, 1));
}

function createAccessPanel(frame, r) {
  if (frame) accessSpecs.push(surfaceMatrix(frame.p.clone().addScaledVector(frame.n, 0.04), frame.n, frame.t, r, r, 1));
}

// Queue a row of windows. `frames` are surface frames {p, n, t}.
function createWindowRow(frames, w = 1.1, h = 0.55) {
  for (const f of frames) if (f) windowSpecs.push({ f, w, h });
}

// Indices of a symmetric clustered pattern of window slots around 360°.
function clusteredAngles(stepDeg, cluster, gap, skip = () => false) {
  const out = [];
  const half = Math.round(180 / stepDeg);
  for (let j = 0; j < half; j++) {
    if (j % (cluster + gap) >= cluster) continue;
    const a = (j + 0.5) * stepDeg * DEG;
    if (!skip(a)) out.push(a);
    if (!skip(-a)) out.push(-a);
  }
  return out;
}

function createPhaserBank() {
  const g = new THREE.Group();
  g.name = 'PhaserBank';
  const base = new THREE.Mesh(GEO.phaserBase, MAT.dark); base.position.y = 0.15;
  const housing = new THREE.Mesh(GEO.phaserHousing, MAT.hullAlt); housing.position.y = 0.5;
  const emitter = new THREE.Mesh(GEO.phaserEmitter, MAT.chrome); emitter.position.y = 0.78;
  g.add(base, housing, emitter);
  return g;
}

function createSensor(radius, domeMat = MAT.chrome) {
  const g = new THREE.Group();
  g.name = 'Sensor';
  const base = new THREE.Mesh(GEO.sensorBase, MAT.hullAlt);
  base.scale.setScalar(radius); base.position.y = 0.17 * radius;
  const dome = new THREE.Mesh(GEO.hemisphere, domeMat);
  dome.scale.setScalar(radius); dome.position.y = 0.34 * radius;
  g.add(base, dome);
  return g;
}

function createNavLight(material, size = 0.45) {
  const m = new THREE.Mesh(GEO.navLight, material);
  m.scale.setScalar(size);
  return m;
}

// Shared small geometries.
const GEO = {};
function buildSharedGeometry() {
  GEO.phaserBase = new THREE.CylinderGeometry(1.25, 1.55, 0.3, 20);
  GEO.phaserHousing = new THREE.BoxGeometry(2.4, 0.5, 1.15);
  GEO.phaserEmitter = new THREE.SphereGeometry(0.5, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
  GEO.sensorBase = new THREE.CylinderGeometry(1.2, 1.4, 0.34, 24);
  GEO.hemisphere = new THREE.SphereGeometry(1, 24, 10, 0, Math.PI * 2, 0, Math.PI / 2);
  GEO.navLight = new THREE.SphereGeometry(1, 12, 8);
  GEO.unitPlane = new THREE.PlaneGeometry(1, 1);
  GEO.unitDisc = new THREE.CircleGeometry(0.5, 20);
  GEO.windowBox = new THREE.BoxGeometry(1, 1, 1);
}

/* =====================================================================
   SAUCER
   ===================================================================== */
function buildSaucer(g) {
  const P = SAUCER_PROFILE, SEG = 160;
  const piece = (list, mat, planar) => {
    const geo = latheFromProfile(list, saucerMap, SEG);
    if (planar) applyPlanarUV(geo, planar === 'top');
    const m = new THREE.Mesh(geo, mat);
    g.add(m);
    return m;
  };
  piece(P.deckTop, MAT.hull).name = 'BCDeckTop';
  piece(P.deckWall, MAT.hullAlt).name = 'BCDeckWall';
  piece(P.upper, MAT.saucerTop, 'top').name = 'UpperSurface';
  piece(P.rimUpper, MAT.hull).name = 'RimUpperLip';
  piece(P.rimBand, MAT.rimBand).name = 'RecessedPerimeter';
  piece(P.rimLower, MAT.hull).name = 'RimLowerLip';
  piece(P.lower, MAT.saucerBottom, 'bottom').name = 'LowerSurface';
  piece(P.domeStep, MAT.dark).name = 'LowerDomeStep';
  piece(P.lowerDome, MAT.hullAlt).name = 'LowerDome';

  // saucer separation line and concentric construction layers
  const sep = createPanelRing(61.9 * SX, 0.13, MAT.seam); sep.position.y = 1.45 * SY; sep.name = 'SeparationLine'; g.add(sep);
  const sepLow = createPanelRing(61.7 * SX, 0.13, MAT.seam); sepLow.position.y = -1.75 * SY; g.add(sepLow);
  const deckBase = createPanelRing(12.8 * SX, 0.16, MAT.dark); deckBase.position.y = 5.25 * SY; g.add(deckBase);
  const deckEdge = createPanelRing(10.6 * SX, 0.1, MAT.seam); deckEdge.position.y = 7.25 * SY; g.add(deckEdge);
  const domeRing = createPanelRing(18.0 * SX, 0.14, MAT.seam); domeRing.position.y = -8.5 * SY; g.add(domeRing);
  [30, 46].forEach(r => {
    const f = saucerFrame(P.upper, r * SX, 0);
    const ring = createPanelRing(r * SX, 0.06, MAT.seam); ring.position.y = f.p.y; g.add(ring);
  });

  // windows
  const navSkip = a => Math.abs(Math.abs(a) - 80 * DEG) < 3 * DEG;
  const aftSkip = deg => a => Math.abs(Math.abs(a) - Math.PI) < deg * DEG;
  createWindowRow(clusteredAngles(2.0, 4, 1, navSkip).map(a => {
    const radial = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    return { p: radial.clone().multiplyScalar(63.0 * SX), n: radial, t: new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)) };
  }), 1.15, 0.62);
  createWindowRow(clusteredAngles(2.6, 3, 2).map(a => saucerFrame(P.upper, 57.5 * SX, a)), 1.1, 0.6);
  createWindowRow(clusteredAngles(6, 2, 1, aftSkip(30)).map(a => saucerFrame(P.upper, 21.5 * SX, a)), 1.0, 0.55);
  createWindowRow(clusteredAngles(2.4, 4, 1, aftSkip(6)).map(a => saucerFrame(P.lower, 58.5 * SX, a)), 1.1, 0.6);
  createWindowRow(clusteredAngles(2.8, 3, 2, aftSkip(16)).map(a => saucerFrame(P.lower, 50 * SX, a)), 1.1, 0.6);
  createWindowRow(clusteredAngles(7, 2, 1, aftSkip(25)).map(a => saucerFrame(P.lower, 22 * SX, a)), 1.0, 0.55);
  createWindowRow(clusteredAngles(8, 1, 0, aftSkip(26)).map(a => saucerFrame(P.deckWall, 11.6 * SX, a)), 0.9, 0.5);
}

/* =====================================================================
   BRIDGE
   ===================================================================== */
function buildBridge(g) {
  const y0 = SAUCER_TOP_Y, B = BRIDGE_RADIUS;
  const deckH = 1.5 * SY;
  const deck = new THREE.Mesh(new THREE.CylinderGeometry(B * 1.22, B * 1.5, deckH, 56), MAT.hullAlt);
  deck.position.y = y0 + deckH / 2 - 0.05; deck.name = 'BridgeDeck';
  const lip = createPanelRing(B * 1.22, 0.1, MAT.seam); lip.position.y = y0 + deckH;
  const dome = new THREE.Mesh(new THREE.SphereGeometry(B, 48, 16, 0, Math.PI * 2, 0, Math.PI / 2), MAT.hull);
  dome.scale.y = 0.42; dome.position.y = y0 + deckH - 0.05; dome.name = 'BridgeDome';
  const capY = y0 + deckH + B * 0.42 - 0.1;
  const cap = new THREE.Mesh(new THREE.CylinderGeometry(B * 0.3, B * 0.34, 0.45, 28), MAT.hullAlt);
  cap.position.y = capY + 0.2;
  const lift = new THREE.Mesh(new THREE.CapsuleGeometry(0.9, 1.6, 6, 14), MAT.hullAlt);
  lift.rotation.x = Math.PI / 2; lift.scale.set(1.4, 1, 1.0);
  lift.position.set(0, y0 + 1.2, -B * 1.15); lift.name = 'TurboliftHousing';
  g.add(deck, lip, dome, cap, lift);

  const sensor = createSensor(0.42);
  sensor.position.y = capY + 0.42;
  g.add(sensor);

  // bridge viewports around the deck structure
  const tilt = Math.atan2(B * 1.5 - B * 1.22, deckH);
  const frames = [];
  for (let i = 0; i < 18; i++) {
    const a = (i + 0.5) / 18 * Math.PI * 2;
    if (Math.abs(Math.cos(a) + 1) < 0.08) continue;   // turbolift side
    const radial = new THREE.Vector3(Math.sin(a), 0, Math.cos(a));
    const n = radial.clone().multiplyScalar(Math.cos(tilt)).add(new THREE.Vector3(0, Math.sin(tilt), 0));
    frames.push({ p: radial.clone().multiplyScalar(B * 1.36).setY(y0 + deckH * 0.5), n, t: new THREE.Vector3(Math.cos(a), 0, -Math.sin(a)) });
  }
  createWindowRow(frames, 0.7, 0.4);
}

/* =====================================================================
   ENGINEERING (SECONDARY) HULL
   ===================================================================== */
function buildEngineeringHull(g) {
  const fs = new Set(HULL_STATIONS.map(s => s[0]));
  for (let k = 0; k <= 72; k++) fs.add(k / 72);
  const list = [...fs].sort((a, b) => a - b).filter((v, i, arr) => i === 0 || v - arr[i - 1] > 1e-4);
  const N = 72;
  const rings = list.map(f => {
    const st = hullAt(f), z = ENGINEERING_NOSE_Z - f * ENGINEERING_LENGTH, ring = [];
    for (let k = 0; k < N; k++) {
      const a = -Math.PI / 2 + (k / N) * Math.PI * 2;      // seam on the keel
      ring.push(new THREE.Vector3(st.rx * se(Math.cos(a), st.n), ENG_Y + st.cy + st.ry * se(Math.sin(a), st.n), z));
    }
    return ring;
  });
  const hull = new THREE.Mesh(loftRings(rings, list), MAT.engHull);
  hull.name = 'SecondaryHull';
  g.add(hull);

  // deflector collar and plating rings
  [[0.012, 0.28, MAT.dark], [0.052, 0.1, MAT.seam], [0.33, 0.07, MAT.seam], [0.55, 0.07, MAT.seam], [0.70, 0.07, MAT.seam]].forEach(([f, tube, mat]) => {
    const st = hullAt(f);
    const ring = createPanelRing(st.rx, tube, mat, false, 96);
    ring.position.set(0, ENG_Y + st.cy, ENGINEERING_NOSE_Z - f * ENGINEERING_LENGTH);
    ring.scale.y = st.ry / st.rx;
    g.add(ring);
  });

  // windows: rows along both flanks
  const sideRows = [[36 * DEG, 0.08, 0.66], [0, 0.08, 0.30], [0, 0.38, 0.68], [-14 * DEG, 0.12, 0.62], [12 * DEG, 0.72, 0.9]];
  const stepF = 2.5 / ENGINEERING_LENGTH;
  for (const [a, f0, f1] of sideRows) {
    for (const side of [1, -1]) {
      const ang = side > 0 ? a : Math.PI - a;
      const frames = [];
      let j = 0;
      for (let f = f0; f <= f1; f += stepF, j++) if (j % 7 < 5) frames.push(hullFrame(f, ang));
      createWindowRow(frames, 1.1, 0.6);
    }
  }
}

/* =====================================================================
   NECK (dorsal interconnect)
   ===================================================================== */
function neckSection(f) {
  const yB = ENG_Y + ENGINEERING_RADIUS, yT = -4.6 * SY;
  const leB = ENGINEERING_NOSE_Z - 0.18 * ENGINEERING_LENGTH, teB = ENGINEERING_NOSE_Z - 0.52 * ENGINEERING_LENGTH;
  const leT = -0.41 * SAUCER_RADIUS, teT = -0.90 * SAUCER_RADIUS;
  const fil = f < 0.3 ? Math.exp(-(Math.max(f, -0.02) + 0.02) / 0.05) : 0;   // fillet into the hull
  return {
    y: lerp(yB, yT, f),
    le: lerp(leB, leT, f) + 7 * fil,
    te: lerp(teB, teT, f) - 7 * fil,
    t: lerp(NECK_THICKNESS, NECK_THICKNESS * 0.92, f) + 6 * fil,
  };
}

function buildNeck(g) {
  const fracs = [-0.14, -0.02, 0.01, 0.04, 0.08, 0.13, 0.2, 0.32, 0.46, 0.6, 0.74, 0.87, 1.0, 1.14];
  const N = 44, P = 2.4;
  const rings = fracs.map(f => {
    const s = neckSection(f), zm = (s.le + s.te) / 2, hc = (s.le - s.te) / 2, ring = [];
    for (let k = 0; k < N; k++) {
      const th = (k / N) * Math.PI * 2;
      ring.push(new THREE.Vector3(s.t / 2 * se(Math.sin(th), P), s.y, zm + hc * se(Math.cos(th), P)));
    }
    return ring;
  });
  const neck = new THREE.Mesh(loftRings(rings), MAT.neck);
  neck.name = 'DorsalNeck';
  g.add(neck);

  // structural ribs at the leading edge
  for (const f of [0.3, 0.55, 0.8]) {
    const s = neckSection(f);
    const rib = new THREE.Mesh(new THREE.BoxGeometry(s.t + 0.25, 0.22, 3.2), MAT.seam);
    rib.position.set(0, s.y, s.le - 1.2);
    g.add(rib);
  }

  // windows on both flanks
  for (const f of [0.3, 0.5, 0.7]) {
    const s = neckSection(f);
    for (const side of [1, -1]) {
      const frames = [];
      let j = 0;
      for (let z = s.le - 5; z > s.te + 5; z -= 2.4, j++) {
        if (j % 6 >= 4) continue;
        frames.push({ p: new THREE.Vector3(side * (s.t / 2), s.y, z), n: new THREE.Vector3(side, 0, 0), t: new THREE.Vector3(0, 0, 1) });
      }
      createWindowRow(frames, 1.0, 0.55);
    }
  }
}

/* =====================================================================
   NACELLE PYLONS
   ===================================================================== */
const naca = x => 5 * (0.2969 * Math.sqrt(x) - 0.126 * x - 0.3516 * x * x + 0.2843 * x * x * x - 0.1036 * x * x * x * x);

function createPylonGeometry() {
  const root = new THREE.Vector2(ENGINEERING_RADIUS * 0.3, ENG_Y + ENGINEERING_RADIUS * 0.6);
  const tip = new THREE.Vector2(NAC_X, NAC_Y);
  const d = tip.clone().sub(root);
  const len = d.length();
  const nrm = new THREE.Vector2(d.y, -d.x).normalize();
  const rootLE = ENGINEERING_NOSE_Z - 0.64 * ENGINEERING_LENGTH, rootTE = ENGINEERING_NOSE_Z - 0.82 * ENGINEERING_LENGTH;
  const tipLE = NACELLE_NOSE_Z - 0.38 * NACELLE_LENGTH, tipTE = NACELLE_NOSE_Z - 0.52 * NACELLE_LENGTH;

  // where the pylon leaves the hull and enters the nacelle
  const st = hullAt((ENGINEERING_NOSE_Z - (rootLE + rootTE) / 2) / ENGINEERING_LENGTH);
  let uJ = 0;
  for (let u = 0; u < 1; u += 0.002) {
    const p = root.clone().addScaledVector(d, u);
    const ex = p.x / st.rx, ey = (p.y - ENG_Y - st.cy) / st.ry;
    if (ex * ex + ey * ey > 1) { uJ = u; break; }
  }
  const uN = 1 - NACELLE_RADIUS / len;

  const us = [0, uJ - 0.02, uJ, uJ + 0.015, uJ + 0.04, uJ + 0.08, 0.3, 0.45, 0.6, 0.72, uN - 0.07, uN - 0.03, uN, 1.0]
    .filter(u => u >= 0).sort((a, b) => a - b);
  const N = 36;
  const rings = us.map(u => {
    const c = root.clone().addScaledVector(d, u);
    const w = clamp((u - uJ) / (uN - uJ), -0.2, 1.2);
    const fR = Math.exp(-Math.max(0, u - uJ) / 0.035), fT = Math.exp(-Math.max(0, uN - u) / 0.03);
    const T = PYLON_THICKNESS * lerp(1.12, 0.85, clamp(w, 0, 1)) + 2.6 * fR + 1.4 * fT;
    const le = lerp(rootLE, tipLE, w) + 4.5 * fR + 2.5 * fT;
    const te = lerp(rootTE, tipTE, w) - 4.0 * fR - 2.0 * fT;
    const ring = [];
    for (let k = 0; k < N; k++) {
      const th = (k / N) * Math.PI * 2;
      const xc = (1 - Math.cos(th)) / 2;               // 0 = leading edge, 1 = trailing edge
      const half = naca(xc) * T / 2 * (Math.sin(th) >= 0 ? 1 : -1);
      ring.push(new THREE.Vector3(c.x + nrm.x * half, c.y + nrm.y * half, lerp(le, te, xc)));
    }
    return ring;
  });
  return { geo: loftRings(rings, us), root, d, nrm, uJ, uN, rootLE, rootTE, tipLE, tipTE };
}

function buildPylons(g) {
  const P = createPylonGeometry();
  const port = new THREE.Mesh(P.geo, MAT.pylon); port.name = 'PortPylon';
  const star = new THREE.Mesh(P.geo, MAT.pylon); star.name = 'StarboardPylon';
  star.scale.x = -1;                                     // exact mirror
  g.add(port, star);

  // leading-edge reinforcement strips and spanwise seams
  const spanDir = new THREE.Vector3(P.d.x, P.d.y, 0).normalize();
  const span = P.d.length() * (P.uN - P.uJ);
  for (const side of [1, -1]) {
    for (const [u, w] of [[0.35, 0.2], [0.55, 0.2], [0.75, 0.2]]) {
      const w2 = clamp((u - P.uJ) / (P.uN - P.uJ), 0, 1);
      const le = lerp(P.rootLE, P.tipLE, w2), te = lerp(P.rootTE, P.tipTE, w2);
      const c = P.root.clone().addScaledVector(P.d, u);
      const rib = new THREE.Mesh(new THREE.BoxGeometry(PYLON_THICKNESS * 0.62, w, (le - te) * 0.9), MAT.seam);
      rib.position.set(side * c.x, c.y, (le + te) / 2 - 0.4);
      rib.rotation.z = Math.atan2(-side * P.d.x, P.d.y);   // local Y along the span
      g.add(rib);
    }
    // leading edge cap
    const mid = P.root.clone().addScaledVector(P.d, (P.uJ + P.uN) / 2);
    const leMid = lerp(P.rootLE, P.tipLE, 0.5);
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, span * 0.92, 8), MAT.hullAlt);
    cap.position.set(side * mid.x, mid.y, leMid - 0.35);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(side * spanDir.x, spanDir.y, 0));
    // sweep the cap to follow the leading edge
    const a = new THREE.Vector3(side * (P.root.x + P.d.x * P.uJ), P.root.y + P.d.y * P.uJ, P.rootLE - 0.3);
    const b = new THREE.Vector3(side * (P.root.x + P.d.x * P.uN), P.root.y + P.d.y * P.uN, P.tipLE - 0.3);
    cap.position.copy(a).add(b).multiplyScalar(0.5);
    cap.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize());
    cap.scale.y = a.distanceTo(b) / (span * 0.92);
    g.add(cap);
  }
}

/* =====================================================================
   WARP NACELLES
   ===================================================================== */
let NAC_GEO = null;
const nacZ = s => NACELLE_LENGTH / 2 - s * NS;           // nacelle-local z of a station
function nacR(s) {
  const L = NACELLE_PROFILE.body;
  for (let i = 0; i < L.length - 1; i++) if (s >= L[i][1] && s <= L[i + 1][1]) {
    return lerp(L[i][0], L[i + 1][0], (s - L[i][1]) / (L[i + 1][1] - L[i][1])) * NR;
  }
  return L[L.length - 1][0] * NR;
}

function nacelleGeometries() {
  if (NAC_GEO) return NAC_GEO;
  const map = ([r, s]) => new THREE.Vector2(r * NR, nacZ(s));
  const lathe = (list, segs = 64) => latheFromProfile(list, map, segs).rotateX(Math.PI / 2);
  const dome = [], core = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14 * Math.PI / 2;
    dome.push([6.3 * Math.sin(t), 9 * (1 - Math.cos(t))]);
    core.push([5.5 * Math.sin(t), 1.2 + 8 * (1 - Math.cos(t))]);
  }
  dome.push([6.3, 13.0]);
  core.push([5.5, 14.5]);
  const s0 = 104, s1 = 136;
  const grille = (center) => {
    const geo = new THREE.CylinderGeometry(nacR(s0) + 0.05, nacR(s1) + 0.05, (s1 - s0) * NS, 6, 1, true, center - 0.2, 0.4);
    geo.rotateX(Math.PI / 2);
    geo.translate(0, 0, nacZ((s0 + s1) / 2));
    return geo;
  };
  NAC_GEO = {
    glass: lathe(dome, 56),
    core: lathe(core, 56),
    collar: lathe(NACELLE_PROFILE.collar, 72),
    body: lathe(NACELLE_PROFILE.body, 72),
    rear: lathe(NACELLE_PROFILE.rear, 56),
    grilleA: grille(Math.PI + 0.55),
    grilleB: grille(Math.PI - 0.55),
    exhaust: new THREE.CircleGeometry(3.72 * NR, 40).rotateY(Math.PI).translate(0, 0, nacZ(147.8)),
    spike: new THREE.ConeGeometry(1.0 * NR, 2.6 * NS, 20).rotateX(-Math.PI / 2).translate(0, 0, nacZ(147.8) - 1.3 * NS),
    vane: new THREE.BoxGeometry(0.22, 7.2 * NR, 0.6),
  };
  return NAC_GEO;
}

function createNacelle(name) {
  const G = nacelleGeometries();
  const g = new THREE.Group();
  g.name = name;

  // outer housing
  const body = new THREE.Mesh(G.body, MAT.nacelle); body.name = 'Housing';
  const collar = new THREE.Mesh(G.collar, MAT.chrome); collar.name = 'BussardCollar';
  const rear = new THREE.Mesh(G.rear, MAT.dark); rear.name = 'ExhaustHousing';
  g.add(body, collar, rear);
  for (const s of [16.9, 30, 58, 86, 104, 136, 144.5]) {
    const ring = createEngineRing(nacR(s) + 0.02, s === 104 || s === 136 ? 0.18 : 0.12);
    ring.position.z = nacZ(s);
    g.add(ring);
  }

  // forward warp section: energy chamber, layered rings, translucent dome
  const core = new THREE.Mesh(G.core, MAT.bussardCore); core.name = 'EnergyChamber';
  g.add(core);
  [3, 6, 9, 12].forEach((s, i) => {
    const t = Math.acos(clamp(1 - s / 9, -1, 1));
    const r = (s >= 9 ? 6.3 : 6.3 * Math.sin(t)) * 0.93 * NR;
    const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.12, 6, 48), FX.ringMats[i]);
    ring.position.z = nacZ(s);
    g.add(ring);
  });
  const glass = new THREE.Mesh(G.glass, MAT.bussardGlass); glass.name = 'BussardDome';
  glass.renderOrder = 2;
  g.add(glass);

  // rear engine section
  const exhaust = new THREE.Mesh(G.exhaust, MAT.exhaust); exhaust.name = 'ExhaustGlow';
  const spike = new THREE.Mesh(G.spike, MAT.dark);
  g.add(exhaust, spike);
  for (let i = 0; i < 4; i++) {
    const v = new THREE.Mesh(G.vane, MAT.darker);
    v.rotation.z = i * Math.PI / 4;
    v.position.z = nacZ(147.8) - 0.25;
    g.add(v);
  }
  g.add(new THREE.Mesh(G.grilleA, MAT.grille), new THREE.Mesh(G.grilleB, MAT.grille));

  // nacelle illumination
  const blue = new THREE.PointLight(0x6fa8ff, 900, 140, 2);
  blue.position.set(0, 0, nacZ(-6));
  const red = new THREE.PointLight(0xff6a2a, 260, 60, 2);
  red.position.set(0, 0, nacZ(156));
  blue.userData.base = blue.intensity; red.userData.base = red.intensity;
  FX.lights.push({ light: blue, kind: 'nacelle' }, { light: red, kind: 'engine' });
  g.add(blue, red);

  // strobe on the nacelle cap
  const strobe = createNavLight(MAT.navWhite, 0.35);
  strobe.position.set(0, nacR(140) + 0.3, nacZ(140));
  FX.navBlink.push(strobe);
  g.add(strobe);
  return g;
}

/* =====================================================================
   DEFLECTOR
   ===================================================================== */
function buildDeflector(g) {
  const z0 = ENGINEERING_NOSE_Z, R0 = ENGINEERING_RADIUS;
  const wellR = 0.72 * R0, outerR = 0.83 * R0, wellD = 3.4;
  const DR = DEFLECTOR_RADIUS, depth = 3.4 * DR / 7.4;
  const y = ENG_Y;

  const face = new THREE.Mesh(new THREE.RingGeometry(wellR, outerR, 72), MAT.hullAlt);
  face.position.set(0, y, z0);
  const well = new THREE.Mesh(new THREE.CylinderGeometry(wellR, wellR, wellD, 72, 1, true).rotateX(Math.PI / 2), MAT.darker.clone());
  well.material.side = THREE.BackSide;
  well.position.set(0, y, z0 - wellD / 2);
  const back = new THREE.Mesh(new THREE.CircleGeometry(wellR, 72), MAT.darker);
  back.position.set(0, y, z0 - wellD);
  const lip = createPanelRing(wellR + 0.12, 0.4, MAT.dark, false, 96);
  lip.position.set(0, y, z0);
  g.add(face, well, back, lip);

  // concave dish
  const dishPts = [];
  for (let i = 0; i <= 16; i++) { const r = i / 16 * DR; dishPts.push(new THREE.Vector2(r, depth * (r / DR) * (r / DR))); }
  const dish = new THREE.Mesh(new THREE.LatheGeometry(dishPts, 72).rotateX(Math.PI / 2), MAT.deflector);
  const dishBase = z0 - 2.6;
  dish.position.set(0, y, dishBase); dish.name = 'DeflectorDish';
  const rim = createPanelRing(DR + 0.1, 0.32, MAT.chrome, false, 96);
  rim.position.set(0, y, dishBase + depth);
  // concentric emitter rings inside the bowl
  for (const f of [0.45, 0.72]) {
    const rr = DR * f;
    const ring = createPanelRing(rr, 0.12, MAT.dark, false, 72);
    ring.position.set(0, y, dishBase + depth * f * f + 0.05);
    g.add(ring);
  }
  const housing = new THREE.Mesh(new THREE.ConeGeometry(1.7, 2.6, 28).rotateX(Math.PI / 2), MAT.dark);
  housing.position.set(0, y, dishBase + 1.2);
  const core = new THREE.Mesh(new THREE.SphereGeometry(1.15, 24, 16), MAT.deflectorCore);
  core.position.set(0, y, dishBase + 2.0); core.name = 'DeflectorEmitter';
  const spike = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.32, 10.5, 12).rotateX(Math.PI / 2), MAT.chrome);
  spike.position.set(0, y, dishBase + 2.0 + 5.25); spike.name = 'DeflectorAntenna';
  g.add(dish, rim, housing, core, spike);

  // mounting struts from dish rim back into the housing
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + i * Math.PI / 2;
    const p0 = new THREE.Vector3(Math.cos(a) * DR * 0.98, y + Math.sin(a) * DR * 0.98, dishBase + depth * 0.9);
    const p1 = new THREE.Vector3(Math.cos(a) * (wellR - 0.1), y + Math.sin(a) * (wellR - 0.1), z0 - wellD * 0.75);
    const strut = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, p0.distanceTo(p1)), MAT.dark);
    strut.position.copy(p0).add(p1).multiplyScalar(0.5);
    strut.lookAt(p1);
    g.add(strut);
  }

  const light = new THREE.PointLight(0x5c8dff, 700, 110, 2);
  light.position.set(0, y, z0 + 12);
  light.userData.base = light.intensity;
  FX.lights.push({ light, kind: 'deflector' });
  g.add(light);
}

/* =====================================================================
   PHASER BANKS
   ===================================================================== */
function buildPhaserBanks(g) {
  const P = SAUCER_PROFILE;
  const lower = [14, 42, 78, 118, 160], upper = [32, 96, 150];
  for (const side of [1, -1]) {
    for (const deg of lower) {
      const f = saucerFrame(P.lower, 46 * SX, side * deg * DEG);
      g.add(placeOnSurface(createPhaserBank(), f.p, f.n, f.t));
    }
    for (const deg of upper) {
      const f = saucerFrame(P.upper, 42 * SX, side * deg * DEG);
      g.add(placeOnSurface(createPhaserBank(), f.p, f.n, f.t));
    }
  }
}

/* =====================================================================
   SENSORS & NAVIGATION LIGHTS
   ===================================================================== */
function buildSensors(g) {
  const P = SAUCER_PROFILE;
  // main lower sensor dome
  const lowerSensor = createSensor(2.6 * SX, MAT.sensorGlow);
  placeOnSurface(lowerSensor, new THREE.Vector3(0, SAUCER_BOTTOM_Y + 0.05, 0), new THREE.Vector3(0, -1, 0), new THREE.Vector3(1, 0, 0));
  lowerSensor.name = 'LowerSensorDome';
  g.add(lowerSensor);
  // dorsal sensor nubs
  for (const a of [60, -60, 120, -120]) {
    const f = saucerFrame(P.upper, 25 * SX, a * DEG);
    g.add(placeOnSurface(createSensor(0.7), f.p, f.n, f.t));
  }
  // secondary hull ventral sensors and dorsal antenna
  for (const f of [0.12, 0.3]) {
    const fr = hullFrame(f, -Math.PI / 2);
    g.add(placeOnSurface(createSensor(1.1), fr.p, fr.n, new THREE.Vector3(1, 0, 0)));
  }
  const top = hullFrame(0.62, Math.PI / 2);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.2, 3.2, 8), MAT.dark);
  mast.position.copy(top.p).add(new THREE.Vector3(0, 1.6, 0));
  g.add(mast);

  // navigation lights: red to port (+X), green to starboard (-X), white strobes top and bottom
  const rimR = 63.38 * SX;
  const red = createNavLight(MAT.navRed, 0.55); red.position.set(Math.sin(80 * DEG) * rimR, 0, Math.cos(80 * DEG) * rimR);
  const green = createNavLight(MAT.navGreen, 0.55); green.position.set(-Math.sin(80 * DEG) * rimR, 0, Math.cos(80 * DEG) * rimR);
  g.add(red, green);
  FX.steady = [red, green];
  const up = saucerFrame(P.upper, 59 * SX, Math.PI), down = saucerFrame(P.lower, 59 * SX, Math.PI);
  for (const f of [up, down]) {
    const s = createNavLight(MAT.navWhite, 0.45);
    s.position.copy(f.p).addScaledVector(f.n, 0.3);
    FX.navBlink.push(s);
    g.add(s);
  }
}

/* =====================================================================
   IMPULSE ENGINES
   ===================================================================== */
function buildEngines(g) {
  const w0 = 5.8 * SX, w1 = 4.7 * SX, h = 2.9 * SY;
  const shape = new THREE.Shape();
  shape.moveTo(-w0, 0); shape.lineTo(w0, 0); shape.lineTo(w1, h); shape.lineTo(-w1, h); shape.closePath();
  const len = 8.6 * SX;
  const housing = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: len, bevelEnabled: true, bevelThickness: 0.4, bevelSize: 0.35, bevelSegments: 2 }), MAT.hullAlt);
  const zRear = -11.2 * SX - len;
  housing.position.set(0, 4.25 * SY, zRear);
  housing.name = 'ImpulseHousing';
  g.add(housing);

  const portShape = (w, hh, r) => {
    const s = new THREE.Shape();
    s.moveTo(-w / 2 + r, -hh / 2); s.lineTo(w / 2 - r, -hh / 2); s.quadraticCurveTo(w / 2, -hh / 2, w / 2, -hh / 2 + r);
    s.lineTo(w / 2, hh / 2 - r); s.quadraticCurveTo(w / 2, hh / 2, w / 2 - r, hh / 2);
    s.lineTo(-w / 2 + r, hh / 2); s.quadraticCurveTo(-w / 2, hh / 2, -w / 2, hh / 2 - r);
    s.lineTo(-w / 2, -hh / 2 + r); s.quadraticCurveTo(-w / 2, -hh / 2, -w / 2 + r, -hh / 2);
    return s;
  };
  const frameGeo = new THREE.ShapeGeometry(portShape(4.1 * SX, 2.0 * SY, 0.5), 6).rotateY(Math.PI);
  const glowGeo = new THREE.ShapeGeometry(portShape(3.5 * SX, 1.5 * SY, 0.45), 6).rotateY(Math.PI);
  for (const x of [-2.35 * SX, 2.35 * SX]) {
    const frame = new THREE.Mesh(frameGeo, MAT.darker);
    frame.position.set(x, 4.25 * SY + h * 0.5, zRear - 0.42);
    const glow = new THREE.Mesh(glowGeo, MAT.impulse);
    glow.position.set(x, 4.25 * SY + h * 0.5, zRear - 0.46);
    glow.name = 'ImpulseExhaust';
    g.add(frame, glow);
  }
  const light = new THREE.PointLight(0xff7a33, 260, 45, 2);
  light.position.set(0, 6 * SY, zRear - 6);
  light.userData.base = light.intensity;
  FX.lights.push({ light, kind: 'engine' });
  g.add(light);
}

/* =====================================================================
   SHUTTLE BAY
   ===================================================================== */
function buildShuttleBay(g) {
  const st = hullAt(1), cy = ENG_Y + st.cy, z = ENG_REAR_Z;
  const face = new THREE.Shape();
  for (let k = 0; k <= 64; k++) {
    const a = k / 64 * Math.PI * 2;
    const x = st.rx * se(Math.cos(a), st.n), y = st.ry * se(Math.sin(a), st.n);
    k === 0 ? face.moveTo(x, y) : face.lineTo(x, y);
  }
  const cap = new THREE.Mesh(new THREE.ShapeGeometry(face, 1).rotateY(Math.PI), MAT.hullAlt);
  cap.position.set(0, cy, z);
  g.add(cap);

  const dw = st.rx * 1.24, dh = st.ry * 1.0;
  const doorShape = new THREE.Shape();
  doorShape.moveTo(-dw / 2, -dh / 2); doorShape.lineTo(dw / 2, -dh / 2); doorShape.lineTo(dw / 2 * 0.86, dh / 2);
  doorShape.lineTo(-dw / 2 * 0.86, dh / 2); doorShape.closePath();
  const frame = new THREE.Mesh(new THREE.ExtrudeGeometry(doorShape, { depth: 0.5, bevelEnabled: true, bevelThickness: 0.2, bevelSize: 0.35, bevelSegments: 1 }), MAT.dark);
  frame.position.set(0, cy + 0.3, z - 0.15);
  frame.rotation.y = Math.PI;
  frame.name = 'ShuttleBayDoors';
  g.add(frame);
  // clamshell segments
  for (let i = 1; i < 6; i++) {
    const yy = -dh / 2 + i * dh / 6;
    const wAt = lerp(dw, dw * 0.86, i / 6);
    const seg = new THREE.Mesh(new THREE.BoxGeometry(wAt * 0.96, 0.1, 0.12), MAT.darker);
    seg.position.set(0, cy + 0.3 + yy, z - 0.92);
    g.add(seg);
  }
  const split = new THREE.Mesh(new THREE.BoxGeometry(0.12, dh * 0.96, 0.12), MAT.darker);
  split.position.set(0, cy + 0.3, z - 0.92);
  g.add(split);
  // landing lights
  for (const sx of [-1, 1]) for (const fy of [-0.42, 0, 0.42]) {
    const l = createNavLight(MAT.amber, 0.22);
    l.position.set(sx * (dw / 2 + 0.75 - Math.abs(fy) * 0.4), cy + 0.3 + fy * dh, z - 0.5);
    g.add(l);
  }
}

/* =====================================================================
   HULL PANELS (instanced plating, hatches)
   ===================================================================== */
function buildHullPanels(g) {
  const P = SAUCER_PROFILE, rnd = mulberry32(1701);
  for (let i = 0; i < 26; i++) {
    const a = (8 + rnd() * 164) * DEG, r = lerp(27, 56, rnd()) * SX;
    const w = 2.4 + rnd() * 3, h = 1.4 + rnd() * 1.6;
    for (const s of [1, -1]) createHullPanel(saucerFrame(P.upper, r, s * a), w, h);
  }
  for (let i = 0; i < 22; i++) {
    const a = (8 + rnd() * 150) * DEG, r = lerp(26, 56, rnd()) * SX;
    const w = 2.2 + rnd() * 3, h = 1.4 + rnd() * 1.4;
    for (const s of [1, -1]) createHullPanel(saucerFrame(P.lower, r, s * a), w, h);
  }
  for (let i = 0; i < 12; i++) {
    const f = 0.1 + rnd() * 0.6, a = (-50 + rnd() * 120) * DEG;
    if (f < 0.34 && a > 6 * DEG && a < 30 * DEG) continue;   // keep registry clear
    for (const s of [1, -1]) createHullPanel(hullFrame(f, s > 0 ? a : Math.PI - a), 2.6 + rnd() * 2.5, 1.5 + rnd());
  }
  for (let i = 0; i < 20; i++) {
    const a = (5 + rnd() * 170) * DEG, r = lerp(16, 60, rnd()) * SX;
    for (const s of [1, -1]) {
      createAccessPanel(saucerFrame(rnd() < 0.5 ? P.upper : P.lower, r, s * a), 0.9 + rnd() * 1.1);
    }
  }
  for (let i = 0; i < 8; i++) {
    const f = 0.1 + rnd() * 0.75, a = (-60 + rnd() * 100) * DEG;
    for (const s of [1, -1]) createAccessPanel(hullFrame(f, s > 0 ? a : Math.PI - a), 1.0 + rnd());
  }

  const panels = new THREE.InstancedMesh(GEO.unitPlane, MAT.panel, panelSpecs.length);
  panelSpecs.forEach((m, i) => panels.setMatrixAt(i, m));
  panels.computeBoundingSphere(); panels.name = 'MaintenancePanels';
  const hatches = new THREE.InstancedMesh(GEO.unitDisc, MAT.access, accessSpecs.length);
  accessSpecs.forEach((m, i) => hatches.setMatrixAt(i, m));
  hatches.computeBoundingSphere(); hatches.name = 'AccessHatches';
  g.add(panels, hatches);
}

/* =====================================================================
   WINDOWS (single InstancedMesh)
   ===================================================================== */
function buildWindows(g) {
  const rnd = mulberry32(42);
  const mesh = new THREE.InstancedMesh(GEO.windowBox, MAT.window, windowSpecs.length);
  mesh.name = 'HullWindows';
  const base = [], phase = new Float32Array(windowSpecs.length), speed = new Float32Array(windowSpecs.length);
  const warm = new THREE.Color(1.0, 0.9, 0.72), cool = new THREE.Color(0.78, 0.9, 1.05), dark = new THREE.Color(0.03, 0.04, 0.06);
  windowSpecs.forEach(({ f, w, h }, i) => {
    mesh.setMatrixAt(i, surfaceMatrix(f.p.clone().addScaledVector(f.n, 0.03), f.n, f.t, w, h, 0.24));
    const lit = rnd() < 0.8;
    const c = lit ? (rnd() < 0.65 ? warm : cool).clone().multiplyScalar(0.85 + rnd() * 0.75) : dark.clone();
    base.push(c);
    mesh.setColorAt(i, c);
    phase[i] = rnd() * Math.PI * 2;
    speed[i] = 0.3 + rnd() * 1.4;
  });
  mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  FX.windows = { mesh, base, phase, speed, tmp: new THREE.Color() };
  g.add(mesh);
}

/* =====================================================================
   SAMPLE ASSEMBLY
   ===================================================================== */
function createSample() {
  FX.lights.length = 0; FX.navBlink.length = 0; FX.ringMats.length = 0;
  NAC_GEO = null;
  buildMaterials();
  buildSharedGeometry();
  windowSpecs.length = 0; panelSpecs.length = 0; accessSpecs.length = 0;

  const Sample_Ship = new THREE.Group();
  Sample_Ship.name = 'Sample_Ship';
  const groups = {};
  const group = name => { const g = new THREE.Group(); g.name = name; groups[name] = g; Sample_Ship.add(g); return g; };

  buildSaucer(group('Saucer'));
  buildBridge(group('Bridge'));
  buildEngineeringHull(group('EngineeringHull'));
  buildNeck(group('Neck'));
  buildPylons(group('NacellePylons'));

  const port = createNacelle('PortNacelle');
  port.position.set(NAC_X, NAC_Y, NAC_CENTER_Z);
  const starboard = createNacelle('StarboardNacelle');
  starboard.position.set(-NAC_X, NAC_Y, NAC_CENTER_Z);
  groups.PortNacelle = port; groups.StarboardNacelle = starboard;
  Sample_Ship.add(port, starboard);

  buildDeflector(group('Deflector'));
  buildPhaserBanks(group('PhaserBanks'));
  const windows = group('Windows');
  buildHullPanels(group('HullPanels'));
  buildSensors(group('Sensors'));
  buildEngines(group('Engines'));
  buildShuttleBay(group('ShuttleBay'));
  buildWindows(windows);        // last: every builder has queued its window rows

  Sample_Ship.userData.groups = groups;
  return Sample_Ship;
}

/* =====================================================================
   SIMULATOR ENTRY POINT
   ===================================================================== */
/**
 * Build the ship for ShipController.setModel. Anchors are in model metres (+Z = bow).
 * `animate(t, exposure)` drives the warp nacelles, deflector, impulse engines, windows and
 * navigation lights; every glow is divided by exposure so it reads the same at any adaptation.
 */
export function buildSampleShip() {
  const root = createSample();
  // The viewer's coloured point lights would add lights to every material in the solar system
  // (and their metre-scale ranges mean nothing at km scene units): the Sun lights the ship instead.
  const lights = [];
  root.traverse((o) => { if (o.isLight) lights.push(o); });
  lights.forEach((l) => l.parent.remove(l));
  FX.lights.length = 0;

  const zRear = -11.2 * SX - 8.6 * SX - 0.46, yImp = 4.25 * SY + 2.9 * SY * 0.5;
  const engines = [-2.35 * SX, 2.35 * SX].map((x) => ({ pos: new THREE.Vector3(x, yImp, zRear), r: 0.9 * SX }));
  const cockpit = new THREE.Vector3(0, SAUCER_TOP_Y + 1.5 * SY + BRIDGE_RADIUS * 0.42 + 1.2, BRIDGE_RADIUS * 1.6);

  // MAT/FX are rebuilt by every createSample(): bind this build's own materials.
  const M = { ...MAT }, rings = [...FX.ringMats], W = FX.windows;
  const base = { deflector: M.deflector.emissiveIntensity, glass: M.bussardGlass.emissiveIntensity, grille: M.grille.emissiveIntensity };
  function animate(t, exposure) {
    const g = 1 / Math.max(exposure, 1e-9);
    const pulse = 0.88 + 0.12 * Math.sin(t * 1.7) + 0.04 * Math.sin(t * 4.3);
    M.bussardCore.uniforms.uTime.value = t;
    M.bussardCore.uniforms.uIntensity.value = 2.3 * pulse * g;
    M.bussardGlass.emissiveIntensity = base.glass * pulse * g;
    rings.forEach((m, i) => {
      const w = 0.35 + 0.9 * Math.max(0, Math.sin(t * 2.2 - i * 0.95));
      m.color.copy(m.userData.base).multiplyScalar(w * g);
    });
    const dp = 0.85 + 0.15 * Math.sin(t * 1.1);
    M.deflector.emissiveIntensity = base.deflector * dp * g;
    M.deflectorCore.color.copy(M.deflectorCore.userData.base).multiplyScalar(dp * g);
    const flick = 1 + 0.05 * Math.sin(t * 13.0) + 0.04 * Math.sin(t * 7.3 + 1.0) + 0.03 * Math.sin(t * 23.0);
    M.impulse.color.copy(M.impulse.userData.base).multiplyScalar(flick * g);
    M.exhaust.color.copy(M.exhaust.userData.base).multiplyScalar(flick * g);
    M.grille.emissiveIntensity = base.grille * (0.85 + 0.15 * Math.sin(t * 1.7 - 2.0)) * g;

    for (let i = 0; i < W.base.length; i++) {
      W.tmp.copy(W.base[i]).multiplyScalar((0.9 + 0.1 * Math.sin(t * W.speed[i] + W.phase[i])) * g);
      W.mesh.setColorAt(i, W.tmp);
    }
    W.mesh.instanceColor.needsUpdate = true;

    const strobe = (t % 1.8) < 0.1 ? 1 : 0.04;
    M.navWhite.color.copy(M.navWhite.userData.base).multiplyScalar(strobe * g);
    M.navRed.color.copy(M.navRed.userData.base).multiplyScalar(g);
    M.navGreen.color.copy(M.navGreen.userData.base).multiplyScalar(g);
    M.amber.color.copy(M.amber.userData.base).multiplyScalar((0.8 + 0.2 * Math.sin(t * 3)) * g);
    M.sensorGlow.color.copy(M.sensorGlow.userData.base).multiplyScalar((0.9 + 0.1 * Math.sin(t * 0.8)) * g);
  }

  return { root, engines, cockpit, animate };
}
