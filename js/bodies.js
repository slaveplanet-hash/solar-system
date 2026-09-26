// =============================================================================
// bodies.js — Everything that orbits: data, meshes, materials, clouds, atmospheres,
// rings, the Sun's corona, orbit lines, axis lines, labels and markers.
//
// Floating origin: every body keeps a float64 scene position (`scenePos`). Each
// frame `syncToCamera()` writes (scenePos − cameraPos) into the float32 group
// positions, so geometry near the camera is always numerically small.
// =============================================================================
import * as THREE from 'three';
import { planetElements, bodyToEclipticMatrix, moonGeoKm, AU_KM } from './ephemeris.js';
import { perifocalToFrame, solveKeplerElliptic, TAU } from './kepler.js';
import { MOON_DATA, moonElementsAt, frameToEcliptic } from './moons.js';
import { makeSurfaceTexture, makeFlatTexture, makeRingTexture, RING_SYSTEMS } from './surfaces.js';
import { shapeGeometry } from './shapes.js';
import { createSurfaceMaterial, createCloudMaterial, createAtmosphereMaterial, createRingMaterial,
  createSunMaterial, createCoronaMaterial, ATMOSPHERES } from './shaders.js';
import { selectOccluders, sunlightFactor } from './eclipse.js';

/** Where optional photographic maps live (e.g. Solar System Scope 2K maps, CC BY 4.0). */
export const TEXTURE_BASE_URL = './textures/';
const R_SUN = 695700;

// Physical data: radius (equatorial, km), flattening, mass (kg), sidereal orbit (days),
// sidereal rotation (hours, negative = retrograde), obliquity (deg), geometric albedo.
export const BODY_DATA = [
  { key: 'sun', name: 'Sun', kind: 'sun', type: 'Star (G2V)', radius: 695700, flat: 0, mass: 1.9885e30, orbitDays: null, rotHours: 25.38 * 24, tilt: 7.25, color: '#ffcf70', proc: 'sun', albedo: 1 },
  { key: 'mercury', name: 'Mercury', kind: 'planet', type: 'Terrestrial planet', parent: 'sun', radius: 2439.7, flat: 0, mass: 3.3011e23, orbitDays: 87.969, rotHours: 58.646 * 24, tilt: 0.03, color: '#b1aca4', proc: 'mercury', albedo: 0.14, airless: 0.7 },
  { key: 'venus', name: 'Venus', kind: 'planet', type: 'Terrestrial planet', parent: 'sun', radius: 6051.8, flat: 0, mass: 4.8675e24, orbitDays: 224.701, rotHours: -243.025 * 24, tilt: 177.4, color: '#e9cf98', proc: 'venus', albedo: 0.69, wrap: 0.15, atmo: 'venus' },
  { key: 'earth', name: 'Earth', kind: 'planet', type: 'Terrestrial planet', parent: 'sun', radius: 6378.137, flat: 0.003353, mass: 5.97217e24, orbitDays: 365.256, rotHours: 23.9345, tilt: 23.44, color: '#5b8fe0', proc: 'earth', albedo: 0.37, atmo: 'earth', clouds: true, night: true, ocean: 1 },
  { key: 'moon', name: 'Moon', kind: 'moon', type: 'Natural satellite', parent: 'earth', radius: 1737.4, flat: 0, mass: 7.342e22, orbitDays: 27.3217, rotHours: 27.3217 * 24, tilt: 6.68, color: '#c9c5bd', proc: 'moon', albedo: 0.12, airless: 0.7 },
  { key: 'mars', name: 'Mars', kind: 'planet', type: 'Terrestrial planet', parent: 'sun', radius: 3396.19, flat: 0.00589, mass: 6.4171e23, orbitDays: 686.980, rotHours: 24.6229, tilt: 25.19, color: '#d0703f', proc: 'mars', albedo: 0.17, atmo: 'mars' },
  { key: 'jupiter', name: 'Jupiter', kind: 'planet', type: 'Gas giant', parent: 'sun', radius: 71492, flat: 0.06487, mass: 1.89813e27, orbitDays: 4332.59, rotHours: 9.925, tilt: 3.13, color: '#dcb88f', proc: 'jupiter', albedo: 0.54, wrap: 0.04, atmo: 'jupiter', rings: 'jupiter' },
  { key: 'saturn', name: 'Saturn', kind: 'planet', type: 'Gas giant', parent: 'sun', radius: 60268, flat: 0.09796, mass: 5.6834e26, orbitDays: 10759.22, rotHours: 10.656, tilt: 26.73, color: '#e6d3a0', proc: 'saturn', albedo: 0.5, wrap: 0.04, atmo: 'saturn', rings: 'saturn' },
  { key: 'uranus', name: 'Uranus', kind: 'planet', type: 'Ice giant', parent: 'sun', radius: 25559, flat: 0.02293, mass: 8.6813e25, orbitDays: 30688.5, rotHours: -17.24, tilt: 97.77, color: '#9fe0e8', proc: 'uranus', albedo: 0.49, wrap: 0.04, atmo: 'uranus', rings: 'uranus' },
  { key: 'neptune', name: 'Neptune', kind: 'planet', type: 'Ice giant', parent: 'sun', radius: 24764, flat: 0.01708, mass: 1.02413e26, orbitDays: 60182, rotHours: 16.11, tilt: 28.32, color: '#5a7ff0', proc: 'neptune', albedo: 0.44, wrap: 0.04, atmo: 'neptune', rings: 'neptune' },
  { key: 'pluto', name: 'Pluto', kind: 'planet', type: 'Dwarf planet', parent: 'sun', radius: 1188.3, flat: 0, mass: 1.303e22, orbitDays: 90560, rotHours: -153.2928, tilt: 122.53, color: '#d8bf9f', proc: 'pluto', albedo: 0.52, airless: 0.5 },
];

const MOON_EXTRA = {
  phobos: { albedo: 0.07, type: 'Moon of Mars' }, deimos: { albedo: 0.07, type: 'Moon of Mars' },
  io: { albedo: 0.63, type: 'Galilean moon' }, europa: { albedo: 0.67, type: 'Galilean moon' }, ganymede: { albedo: 0.43, type: 'Galilean moon' }, callisto: { albedo: 0.22, type: 'Galilean moon' },
  mimas: { albedo: 0.96, type: 'Moon of Saturn' }, enceladus: { albedo: 1.0, type: 'Moon of Saturn' }, tethys: { albedo: 0.8, type: 'Moon of Saturn' },
  dione: { albedo: 0.7, type: 'Moon of Saturn' }, rhea: { albedo: 0.7, type: 'Moon of Saturn' },
  titan: { albedo: 0.22, type: 'Moon of Saturn', atmo: 'titan', airless: 0, wrap: 0.2 }, iapetus: { albedo: 0.3, type: 'Moon of Saturn' },
  miranda: { albedo: 0.32, type: 'Moon of Uranus' }, ariel: { albedo: 0.53, type: 'Moon of Uranus' }, umbriel: { albedo: 0.26, type: 'Moon of Uranus' },
  titania: { albedo: 0.35, type: 'Moon of Uranus' }, oberon: { albedo: 0.31, type: 'Moon of Uranus' },
  triton: { albedo: 0.76, type: 'Moon of Neptune (retrograde)' }, charon: { albedo: 0.38, type: 'Moon of Pluto' },
};

/** All bodies in display order: each planet followed by its moons. */
export function allBodyDefs() {
  const out = [];
  for (const p of BODY_DATA) {
    if (p.kind === 'moon') continue;
    out.push(p);
    for (const m of BODY_DATA.filter((b) => b.kind === 'moon' && b.parent === p.key)) out.push(m);
    for (const m of MOON_DATA.filter((mm) => mm.parent === p.key)) {
      out.push({ key: m.key, name: m.name, kind: 'moon', parent: m.parent, radius: m.radius, shape: m.shape, flat: 0, mass: m.mass,
        orbitDays: m.P, rotHours: m.P * 24, tilt: 0, color: m.color, proc: m.proc, airless: 0.7, jplMoon: true, ...MOON_EXTRA[m.key] });
    }
  }
  return out;
}

// Optional photographic maps. Only files listed in textures/textures.json are requested.
export const TEXTURE_FILES = {
  sun: '2k_sun.jpg', mercury: '2k_mercury.jpg', venus: '2k_venus_atmosphere.jpg', earth: '2k_earth_daymap.jpg',
  moon: '2k_moon.jpg', mars: '2k_mars.jpg', jupiter: '2k_jupiter.jpg', saturn: '2k_saturn.jpg',
  uranus: '2k_uranus.jpg', neptune: '2k_neptune.jpg',
  'earth:night': '2k_earth_nightmap.jpg', 'earth:clouds': '2k_earth_clouds.jpg', 'earth:spec': '2k_earth_specular_map.jpg',
};

// -----------------------------------------------------------------------------
export class Body {
  constructor(def) {
    Object.assign(this, { albedo: 0.3, airless: 0, wrap: 0 }, def);
    this.helio = [0, 0, 0];      // heliocentric ecliptic km (float64)
    this.rel = [0, 0, 0];        // moons: planetocentric km
    this.scenePos = [0, 0, 0];   // scene units, three axes (float64)
    this.rScene = this.radius;
    this.eclMatrix = null;
    this.pixelRadius = 0;
    this.camDist = Infinity;
    this.eclipseVisible = 1;
    this.screen = { x: 0, y: 0, visible: false };
    this.group = new THREE.Group();
    this.group.name = def.key;
    this.textureState = 'flat';  // flat → procedural → photo
  }
}

/**
 * Body orientation as a three.js quaternion (mesh-local → scene axes), from b.eclMatrix (body →
 * ecliptic). Mesh-local axes: x = prime meridian, y = north pole, z = −(90° E). Exported so the
 * surface-view camera uses exactly the rotation the mesh is drawn with.
 */
const _basis = new THREE.Matrix4();
export function bodyQuaternion(b, out = new THREE.Quaternion()) {
  const M = b.eclMatrix;
  _basis.makeBasis(new THREE.Vector3(M[0], M[6], -M[3]), new THREE.Vector3(M[2], M[8], -M[5]), new THREE.Vector3(-M[1], -M[7], M[4]));
  return out.setFromRotationMatrix(_basis);
}

export class SolarSystem {
  constructor(scene) {
    this.scene = scene;
    this.bodies = allBodyDefs().map((d) => new Body(d));
    this.byKey = Object.fromEntries(this.bodies.map((b) => [b.key, b]));
    this.show = { orbits: true, labels: true, axes: false, moonOrbits: true, atmospheres: true, clouds: true, rings: true, minor: true, minorOrbits: true, spacecraft: true };
    this._tmpV = new THREE.Vector3();
    this._mat = new THREE.Matrix4();
    this._m3 = new THREE.Matrix3();
    // LOD by disc size: 32×16 · 72×36 · 180×90 · 360×180 (close approach / surface view: ~0.5° facets).
    this.lodGeoms = [new THREE.SphereGeometry(1, 32, 16), new THREE.SphereGeometry(1, 72, 36), new THREE.SphereGeometry(1, 180, 90), new THREE.SphereGeometry(1, 360, 180)];
    this.shellGeom = new THREE.SphereGeometry(1, 96, 48);
    this.ringTextures = {};
    for (const b of this.bodies) this._buildBody(b);
    this._buildLight();
    this._buildMarkers();
    this._buildOrbits();
    this._buildLabels();
    this._photoList = null;
    this._photoList = null;            // set by PhotoTextures.init() (main.js); the procedural pump waits for it
  }

  // ---------------------------------------------------------------------------
  _buildBody(b) {
    if (b.kind === 'sun') {
      b.material = createSunMaterial();
      b.mesh = new THREE.Mesh(this.lodGeoms[1], b.material);
      b.corona = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), createCoronaMaterial());
      b.corona.renderOrder = 5;
      b.group.add(b.corona);
    } else {
      const ring = b.rings ? this._ringInfo(b) : null;
      b.flatTex = makeFlatTexture(b.color);
      b.material = createSurfaceMaterial({
        map: b.flatTex, ring, airless: b.airless || 0, wrap: b.wrap || 0, ocean: b.ocean || 0, flat: b.flat,
      });
      const geom = b.geometry || (b.shape ? shapeGeometry('lumpy', b.shape, b.radius, b.key.length * 7) : this.lodGeoms[1]);
      b.mesh = new THREE.Mesh(geom, b.material);
      b.material.uniforms.uInvScale2.value.set(1, 1 / (1 - b.flat) ** 2, 1);
      if (b.clouds) {
        b.cloudMesh = new THREE.Mesh(this.shellGeom, createCloudMaterial(null));
        b.cloudMesh.renderOrder = 1;
        b.group.add(b.cloudMesh);
      }
      if (b.atmo) {
        const preset = ATMOSPHERES[b.atmo];
        b.atmoMesh = new THREE.Mesh(this.shellGeom, createAtmosphereMaterial(preset));
        b.atmoMesh.renderOrder = 2;
        b.atmoMesh.frustumCulled = false;
        b.atmoRatio = preset.atmo;
        b.group.add(b.atmoMesh);
      }
      if (ring) {
        // 64 radial segments: the visual-scale radius remap (r → r^pm) is applied per vertex.
        const geo = new THREE.RingGeometry(ring.inner, ring.outer, 360, 64);
        geo.rotateX(-Math.PI / 2);          // ring plane = local XZ (equator)
        b.ringMesh = new THREE.Mesh(geo, createRingMaterial(ring));
        b.ringMesh.renderOrder = 3;
        b.ringMesh.frustumCulled = false;
        b.group.add(b.ringMesh);
      }
    }
    b.mesh.name = b.key;
    b.group.add(b.mesh);
    if (b.key === 'earth') {
      // Geostationary orbit (r = 42,164 km, equatorial) for context: Apophis passes inside it on 2029-04-13.
      const pts = [];
      for (let k = 0; k <= 256; k++) { const a = (k / 256) * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a))); }
      b.geoRing = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: 0x7fd4ff, transparent: true, opacity: 0.35, depthWrite: false, toneMapped: false }));
      b.geoRing.frustumCulled = false;
      b.group.add(b.geoRing);
    }
    // Rotation axis line (mesh local +Y = north pole).
    const axGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -1.6, 0), new THREE.Vector3(0, 1.6, 0)]);
    axGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array([1, 0.3, 0.3, 0.3, 0.8, 1]), 3));
    b.axis = new THREE.Line(axGeo, new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false, transparent: true, opacity: 0.9 }));
    b.axis.visible = false;
    b.mesh.add(b.axis);
    this.scene.add(b.group);
  }

  _ringInfo(b) {
    const sys = RING_SYSTEMS[b.rings];
    if (!this.ringTextures[b.rings]) this.ringTextures[b.rings] = makeRingTexture(sys);
    return { tex: this.ringTextures[b.rings], inner: sys.inner / b.radius, outer: sys.outer / b.radius, albedo: sys.albedo, forward: sys.forward || 0, flat: b.flat };
  }

  _buildLight() {
    // Bodies are shaded by custom shaders; this physically based point light (decay 2) lights any
    // standard three.js material added later (e.g. ship models): radiance 1 for white at 1 AU.
    this.sunLight = new THREE.PointLight(0xfff4e8, Math.PI * AU_KM * AU_KM, 0, 2);
    this.scene.add(this.sunLight);
    this.ambient = new THREE.AmbientLight(0x6a7a99, 0.0);
    this.scene.add(this.ambient);
  }

  _buildMarkers() {
    if (this.markers) {   // rebuilt when bodies are added later (asteroids, dwarf planets)
      this.scene.remove(this.markers);
      this.markers.geometry.dispose(); this.markers.material.map.dispose(); this.markers.material.dispose();
    }
    const n = this.bodies.length;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    // Round, soft dot sprite (PointsMaterial draws squares without a map).
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const g = c.getContext('2d'), grd = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.45, 'rgba(255,255,255,0.85)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, 32, 32);
    this.markers = new THREE.Points(geo, new THREE.PointsMaterial({
      size: 6, sizeAttenuation: false, vertexColors: true, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, map: new THREE.CanvasTexture(c),
    }));
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 8;
    this.scene.add(this.markers);
    this.markerGain = 1;
  }

  _buildOrbits() {
    this.orbitN = 512;
    for (const b of this.bodies) this._buildOrbitLine(b);
  }

  _buildOrbitLine(b) {
    {
      if (b.kind === 'sun' || b.noOrbit) return;              // spacecraft draw a trajectory trail instead
      const n = b.kind === 'moon' ? (b.key === 'moon' ? 160 : 180) : this.orbitN + 1;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
      const col = new Float32Array(n * 3), base = new THREE.Color(b.color);
      for (let i = 0; i < n; i++) {
        const f = b.key === 'moon' ? 0.35 + 0.65 * (1 - Math.abs(i / (n - 1) - 0.5) * 2) : 0.25 + 0.75 * Math.pow(1 - i / (n - 1), 1.5);
        col[i * 3] = base.r * f; col[i * 3 + 1] = base.g * f; col[i * 3 + 2] = base.b * f;
      }
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
      b.orbitLine = new THREE.Line(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false, toneMapped: false }));
      b.orbitLine.frustumCulled = false;
      b.orbitLine.renderOrder = 6;
      this.scene.add(b.orbitLine);
      if (b.ghostOrbitFn) {   // e.g. Dimorphos' pre-DART orbit, shown faintly after the impact
        const gg = new THREE.BufferGeometry();
        gg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
        b.ghostLine = new THREE.Line(gg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.25, depthWrite: false, toneMapped: false }));
        b.ghostLine.frustumCulled = false;
        b.ghostLine.renderOrder = 6;
        this.scene.add(b.ghostLine);
      }
    }
  }

  _buildLabels() {
    this.labelLayer = document.getElementById('labels');
    for (const b of this.bodies) this._buildLabel(b);
  }

  _buildLabel(b) {
    const el = document.createElement('div');
    el.className = 'label' + (b.kind === 'moon' ? ' moon' : '') + (b.minor ? ' minor' : '');
    el.textContent = b.name;
    el.style.setProperty('--c', b.color);
    el.addEventListener('click', (e) => { e.stopPropagation(); this.onLabelClick?.(b); });
    this.labelLayer.appendChild(el);
    b.label = el;
    // Extra path labels (interstellar objects: inbound/outbound asymptote directions).
    for (const m of b.pathMarkers || []) {
      const e = document.createElement('div');
      e.className = 'label path';
      e.textContent = m.text;
      e.style.setProperty('--c', b.color);
      this.labelLayer.appendChild(e);
      m.el = e;
    }
  }

  /**
   * Add bodies after start-up (named asteroids, dwarf planets and their moons from /data/).
   * A def may provide: positionFn(jdTDB, state) → heliocentric km; relFn(jdTDB, state) → km from its parent;
   * rotationFn(jdTDB, body) → body→ecliptic matrix; orbitFn(jdTDB, n) → heliocentric km points starting at the
   * body; relOrbitFn(jdTDB, n) → parent-relative km points; geometry (custom THREE.BufferGeometry).
   */
  addBodies(defs) {
    const added = [];
    for (const d of defs) {
      if (this.byKey[d.key]) continue;
      const b = new Body(d);
      // Insert after its parent's family so lists stay grouped.
      this.bodies.push(b);
      this.byKey[b.key] = b;
      this._buildBody(b);
      this._buildOrbitLine(b);
      this._buildLabel(b);
      added.push(b);
    }
    this._buildMarkers();
    return added;
  }

  // --- textures ------------------------------------------------------------------
  // Photo maps are loaded lazily by PhotoTextures (textures.js); it sets this._photoList.

  _setMap(b, tex) {
    const u = b.material.uniforms || null;
    const old = b.map;
    if (u && u.uMap) u.uMap.value = tex;
    b.map = tex;
    if (old && old !== tex) old.dispose();
  }

  _setLayer(b, layer, tex) {
    const u = b.material.uniforms;
    if (layer === 'night') { if (b.nightTex && b.nightTex !== tex) b.nightTex.dispose(); b.nightTex = tex; u.uNight.value = tex; u.uHasNight.value = 1; }
    if (layer === 'clouds') {
      if (b.cloudTex && b.cloudTex !== tex) b.cloudTex.dispose();
      b.cloudTex = tex; u.uClouds.value = tex; u.uHasClouds.value = 1;
      b.cloudMesh.material.uniforms.uClouds.value = tex;
    }
  }

  /** Generate at most one procedural map per call for the most prominent body still needing one. */
  pumpProceduralTextures() {
    if (this._photoList === null) return;             // wait until we know which photo maps exist
    let best = null;
    for (const b of this.bodies) {
      if (b.kind === 'sun' || b.textureState !== 'flat') continue;
      if (b.pixelRadius < 2.5 && !(b.key === 'earth')) continue;
      if (!best || b.pixelRadius > best.pixelRadius) best = b;
    }
    if (best) {
      const big = ['earth', 'jupiter', 'saturn', 'mars', 'moon'].includes(best.key);
      this._setMap(best, makeSurfaceTexture(best.proc, big ? 1024 : 512));
      best.textureState = 'procedural';
      best.flatTex?.dispose(); best.flatTex = null;
      return;
    }
    // Earth's extra layers (after its day map). Procedural city lights follow the PROCEDURAL continents,
    // so they are only generated when the day map is procedural too (a real day map needs the real night map).
    const e = this.byKey.earth;
    if (e.textureState !== 'flat') {
      const photoNight = this._photoList.includes(TEXTURE_FILES['earth:night']);
      const photoClouds = this._photoList.includes(TEXTURE_FILES['earth:clouds']);
      if (!e.cloudTex && !photoClouds) { this._setLayer(e, 'clouds', makeSurfaceTexture('earthClouds', 1024, { alphaFromRed: true, srgb: false })); return; }
      if (!e.nightTex && !photoNight && e.textureState === 'procedural') { this._setLayer(e, 'night', makeSurfaceTexture('earthNight', 1024)); }
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame simulation update (float64): positions, radii, orientations, orbit lines.
  // ---------------------------------------------------------------------------
  update(state, jdTDB, jdUTC, scale) {
    const B = this.byKey;
    this.jdTDB = jdTDB;
    this._scaleRef = scale;
    this.pm = scale.pm;           // ring radii compress with the moon-orbit exponent in visual scale
    for (const b of this.bodies) {
      b.rScene = b.radius * scale.radiusFactor(b.kind);
      if (b.kind === 'moon') continue;
      const h = b.positionFn ? b.positionFn(jdTDB, state, b.helio) : state[b.key];
      if (!h) { b.offline = true; continue; }        // e.g. outside a trajectory's span
      b.offline = false;
      b.helio[0] = h[0]; b.helio[1] = h[1]; b.helio[2] = h[2];
      b.eclMatrix = b.rotationFn ? b.rotationFn(jdTDB, b) : bodyToEclipticMatrix(b.key, jdTDB, jdUTC);
      if (b.kind === 'sun') b.scenePos[0] = b.scenePos[1] = b.scenePos[2] = 0;
      else if (b.minor) this.mapHelioToScene(b.helio, b.radius, scale, b.scenePos);   // planets are earlier in the list
      else scale.helioToScene(b.helio, b.scenePos);
    }
    const off = [0, 0, 0];
    for (const b of this.bodies) {
      if (b.kind !== 'moon') continue;
      const p = B[b.parent];
      const rel = b.relFn ? b.relFn(jdTDB, state, b.rel) : b.key === 'moon' ? state.moonGeo : state.moons[b.key];
      if (!rel) { b.offline = true; continue; }
      b.offline = false;
      b.rel[0] = rel[0]; b.rel[1] = rel[1]; b.rel[2] = rel[2];
      for (let i = 0; i < 3; i++) b.helio[i] = p.helio[i] + rel[i];
      scale.moonOffsetToScene(rel, p.radius, b.radius, off);
      b.sceneOff = b.sceneOff || [0, 0, 0];
      for (let i = 0; i < 3; i++) { b.scenePos[i] = p.scenePos[i] + off[i]; b.sceneOff[i] = off[i]; }
      b.eclMatrix = b.rotationFn ? b.rotationFn(jdTDB, b) : b.key === 'moon' ? bodyToEclipticMatrix('moon', jdTDB, jdUTC)
        : b.jplMoon ? this._tidalMatrix(b, jdTDB) : tidalFromRel(b, jdTDB, state);
    }
    // Minor-body primaries whose rotation is locked to their moon (e.g. Eris ↔ Dysnomia).
    for (const b of this.bodies) if (b.lockedTo && B[b.lockedTo] && !B[b.lockedTo].offline) b.eclMatrix = facing(B[b.lockedTo].rel, B[b.lockedTo]._relNormal, +1);
    // Shadows: occluders per receiver (true geometry) + eclipse visibility at each body's center.
    this.occ = selectOccluders(this.bodies);
    for (const b of this.bodies) {
      if (b.kind === 'sun') continue;
      const o = this.occ.get(b.key);
      b.eclipseVisible = o.list.length ? sunlightFactor(b.helio, o.list.map((c) => ({ helio: c.body.helio, radius: c.body.radius, atmo: c.body.key === 'earth' }))).visible : 1;
    }
    if (this.show.orbits) this._updateOrbitSamples(jdTDB, scale);
  }

  /**
   * Heliocentric km → scene position for objects that are not moons but can pass close to a planet
   * (Apophis at 38,000 km from Earth, spacecraft at Earth or Jupiter). In VISUAL scale a planet's radius is
   * exaggerated and heliocentric distances compressed, so such objects would be drawn inside the planet.
   * Within a planet's sphere of influence they are placed relative to it with the moon mapping (which keeps
   * them outside the enlarged disc), blending smoothly to the heliocentric mapping across [r1, r2].
   * In TRUE scale both mappings coincide, so this changes nothing there.
   */
  mapHelioToScene(h, bodyR, scale, out = [0, 0, 0]) {
    scale.helioToScene(h, out);
    if (scale.s <= 0) return out;
    for (const [key, r1, r2] of NEAR_PLANET_ZONES) {
      const P = this.byKey[key];
      const rel = [h[0] - P.helio[0], h[1] - P.helio[1], h[2] - P.helio[2]];
      const d = Math.hypot(rel[0], rel[1], rel[2]);
      if (d >= r2) continue;
      const near = scale.moonOffsetToScene(rel, P.radius, bodyR, [0, 0, 0]);
      const w = 1 - smooth(r1, r2, d);
      for (let k = 0; k < 3; k++) out[k] = out[k] + (P.scenePos[k] + near[k] - out[k]) * w;
      break;
    }
    return out;
  }

  /** Synchronous rotation: prime meridian (body x) faces the parent, pole = orbit normal. */
  _tidalMatrix(b, jdTDB) {
    const r = b.rel, d = Math.hypot(r[0], r[1], r[2]);
    const x = [-r[0] / d, -r[1] / d, -r[2] / d];
    const o = moonElementsAt(b.key, jdTDB);
    const nf = [Math.sin(o.i) * Math.sin(o.node), -Math.sin(o.i) * Math.cos(o.node), Math.cos(o.i)];
    const n = frameToEcliptic(o.R, nf);
    const dn = n[0] * x[0] + n[1] * x[1] + n[2] * x[2];
    let z = [n[0] - dn * x[0], n[1] - dn * x[1], n[2] - dn * x[2]];
    const zl = Math.hypot(...z); z = z.map((v) => v / zl);
    const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
    return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
  }

  /**
   * Re-sample orbit lines only when needed: the body has moved ≳0.1° along its orbit, the scale mapping
   * changed, or it was never sampled. At most ~10 lines per frame (plus any whose scale changed). Each line
   * is anchored where its body was at sampling time (moon lines ride on their parent), so a line that is
   * not refreshed this frame stays in the right place.
   */
  _updateOrbitSamples(jdTDB, scale) {
    const tmp = [0, 0, 0], sc = [0, 0, 0], ecl = [0, 0, 0];
    let budget = 10;
    for (const b of this.bodies) {
      if (!b.orbitLine) continue;
      if (b.kind === 'moon' && !this.show.moonOrbits) continue;
      const pos = b.orbitLine.geometry.attributes.position;
      const arr = pos.array;
      const n = arr.length / 3;
      if (b.offline) continue;
      const scaleChanged = b._orbVer !== scale.version;
      const moved = b._orbJd === undefined || (Math.abs(jdTDB - b._orbJd) * TAU) / Math.max(Math.abs(b.orbitDays || 365), 1e-3) > 0.002;
      // Near the camera even a 0.1° lag would show (Earth: ~260,000 km), so close bodies refresh every frame.
      const near = b._orbJd !== jdTDB && b.camDist < 300 * b.rScene;
      if (!scaleChanged && !near && !(moved && budget > 0)) continue;
      if (!scaleChanged && !near) budget--;
      b._orbJd = jdTDB; b._orbVer = scale.version;
      b._orbRef = b.scenePos.slice();
      b._orbOff = b.sceneOff ? b.sceneOff.slice() : null;
      if (b.orbitFn) {
        // Minor bodies: heliocentric path supplied by the body (starts at its current position).
        const pts = b.orbitFn(jdTDB, n);
        for (let k = 0; k < n; k++) {
          this.mapHelioToScene(pts[k], b.radius, scale, sc);
          arr[k * 3] = sc[0] - b.scenePos[0]; arr[k * 3 + 1] = sc[1] - b.scenePos[1]; arr[k * 3 + 2] = sc[2] - b.scenePos[2];
        }
      } else if (b.relOrbitFn) {
        const p = this.byKey[b.parent];
        const pts = b.relOrbitFn(jdTDB, n, b.rel);
        for (let k = 0; k < n; k++) {
          scale.moonOffsetToScene(pts[k], p.radius, b.radius, sc);
          arr[k * 3] = sc[0] - b.sceneOff[0]; arr[k * 3 + 1] = sc[1] - b.sceneOff[1]; arr[k * 3 + 2] = sc[2] - b.sceneOff[2];
        }
        if (b.ghostLine) {
          const g = b.ghostOrbitFn(jdTDB, n);
          b.ghostOn = !!g;
          if (g) {
            const ga = b.ghostLine.geometry.attributes.position;
            for (let k = 0; k < n; k++) {
              scale.moonOffsetToScene(g[k], p.radius, b.radius, sc);
              ga.array[k * 3] = sc[0] - b.sceneOff[0]; ga.array[k * 3 + 1] = sc[1] - b.sceneOff[1]; ga.array[k * 3 + 2] = sc[2] - b.sceneOff[2];
            }
            ga.needsUpdate = true;
          }
        }
      } else if (b.key === 'moon') {
        // Geocentric Moon path over ± half a sidereal month, centred on "now" (passes through the Moon).
        const earth = this.byKey.earth, span = 27.3217;
        for (let i = 0; i < n; i++) {
          const g = moonGeoKm(jdTDB + (i / (n - 1) - 0.5) * span, tmp);
          scale.moonOffsetToScene(g, earth.radius, b.radius, sc);
          arr[i * 3] = sc[0] - b.sceneOff[0]; arr[i * 3 + 1] = sc[1] - b.sceneOff[1]; arr[i * 3 + 2] = sc[2] - b.sceneOff[2];
        }
      } else if (b.kind === 'moon') {
        const o = moonElementsAt(b.key, jdTDB);
        const E0 = solveKeplerElliptic(o.M, o.e), bb = o.a * Math.sqrt(1 - o.e * o.e);
        const p = this.byKey[b.parent];
        // Offset so the sampled ellipse passes exactly through the (perturbed) current position.
        perifocalToFrame(o.a * (Math.cos(E0) - o.e), bb * Math.sin(E0), o.argPeri, o.i, o.node, tmp);
        frameToEcliptic(o.R, tmp, ecl);
        const dx = b.rel[0] - ecl[0], dy = b.rel[1] - ecl[1], dz = b.rel[2] - ecl[2];
        for (let k = 0; k < n; k++) {
          const E = E0 - (k / (n - 1)) * TAU;
          perifocalToFrame(o.a * (Math.cos(E) - o.e), bb * Math.sin(E), o.argPeri, o.i, o.node, tmp);
          frameToEcliptic(o.R, tmp, ecl);
          ecl[0] += dx; ecl[1] += dy; ecl[2] += dz;
          scale.moonOffsetToScene(ecl, p.radius, b.radius, sc);
          arr[k * 3] = sc[0] - b.sceneOff[0]; arr[k * 3 + 1] = sc[1] - b.sceneOff[1]; arr[k * 3 + 2] = sc[2] - b.sceneOff[2];
        }
      } else {
        // Planets: current osculating ellipse, sampled in eccentric anomaly starting AT the body.
        const elKey = b.key === 'earth' ? 'emb' : b.key;
        const el = planetElements(elKey, jdTDB);
        const a = el.a * AU_KM, e = el.e, bb = a * Math.sqrt(1 - e * e);
        const E0 = solveKeplerElliptic(el.M, e);
        perifocalToFrame(a * (Math.cos(E0) - e), bb * Math.sin(E0), el.argPeri, el.i, el.node, tmp);
        const ox = b.helio[0] - tmp[0], oy = b.helio[1] - tmp[1], oz = b.helio[2] - tmp[2];   // EMB→Earth, barycenter→Pluto
        for (let k = 0; k < n; k++) {
          const E = E0 - (k / (n - 1)) * TAU;
          perifocalToFrame(a * (Math.cos(E) - e), bb * Math.sin(E), el.argPeri, el.i, el.node, tmp);
          tmp[0] += ox; tmp[1] += oy; tmp[2] += oz;
          scale.helioToScene(tmp, sc);
          arr[k * 3] = sc[0] - b.scenePos[0]; arr[k * 3 + 1] = sc[1] - b.scenePos[1]; arr[k * 3 + 2] = sc[2] - b.scenePos[2];
        }
      }
      pos.needsUpdate = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Floating origin + per-frame uniforms, LOD, labels, markers.
  // ---------------------------------------------------------------------------
  syncToCamera(camPos, camera, width, height, time) {
    this._cam = camera; this._camPos = camPos; this._w = width; this._h = height;
    const tanHalf = Math.tan((camera.fov * Math.PI) / 360);
    const mPos = this.markers.geometry.attributes.position.array;
    const mCol = this.markers.geometry.attributes.color.array;
    const v = this._tmpV, col = new THREE.Color();
    const sun = this.byKey.sun;
    // Positions first (occluder uniforms need every body's camera-relative position).
    for (const b of this.bodies) {
      const rx = b.scenePos[0] - camPos[0], ry = b.scenePos[1] - camPos[1], rz = b.scenePos[2] - camPos[2];
      b.group.position.set(rx, ry, rz);
      b.camDist = Math.hypot(rx, ry, rz);
      b.pixelRadius = (b.rScene / Math.max(b.camDist, 1e-9)) / tanHalf * (height / 2);
    }
    const sunPos = sun.group.position;
    this.bodies.forEach((b, idx) => {
      const { x: rx, y: ry, z: rz } = b.group.position;
      // Orientation (body→ecliptic) → three axes: three(v) = (v0, v2, −v1).
      if (b.eclMatrix) bodyQuaternion(b, b.mesh.quaternion);
      b.mesh.scale.set(b.rScene, b.rScene * (1 - b.flat), b.rScene);
      if (b.geoRing) {
        // Same distance mapping as moons, so it stays consistent with Apophis/ISS/JWST in visual scale.
        const r = Math.hypot(...this._scaleRef.moonOffsetToScene([42164, 0, 0], b.radius, 0.01, [0, 0, 0]));
        b.geoRing.quaternion.copy(b.mesh.quaternion);
        b.geoRing.scale.setScalar(r);
        b.geoRing.visible = this.show.orbits && b.camDist < r * 25;
        b.geoRing.material.color.setRGB(0.5 * this.markerGain, 0.83 * this.markerGain, this.markerGain);
      }
      if (!b.shape && !b.geometry) {
        // Finest level when close to the body (within 1.25 radii: low orbit, surface view), by distance not disc
        // size — from the surface the disc radius is only ~1/tan(fov/2) × half the screen height.
        const lod = b.pixelRadius < 30 ? 0 : b.pixelRadius < 260 ? 1 : b.camDist < 1.25 * b.rScene ? 3 : 2;
        if (b.mesh.geometry !== this.lodGeoms[lod]) b.mesh.geometry = this.lodGeoms[lod];
      }
      const shown = !b.offline && (b.minorType === 'spacecraft' ? this.show.spacecraft : (!b.minor || this.show.minor));
      b.group.visible = shown;
      b.mesh.visible = b.pixelRadius > 0.05;
      b.axis.visible = this.show.axes;
      this._updateMaterials(b, sunPos, time, camera);

      // Marker: fades out once the disc is bigger than a few pixels; moons hide when on top of the parent.
      mPos[idx * 3] = rx; mPos[idx * 3 + 1] = ry; mPos[idx * 3 + 2] = rz;
      let fade = shown ? 1 - Math.min(1, Math.max(0, (b.pixelRadius - 1.5) / 3)) : 0;
      if (b.kind === 'moon') {
        const p = this.byKey[b.parent];
        fade *= 0.7 * Math.min(1, Math.max(0, (Math.hypot(p.screen.x - b.screen.x, p.screen.y - b.screen.y) - p.pixelRadius - 3) / 8));
      }
      col.set(b.color);
      const boost = (b.kind === 'sun' ? 1.6 : 1) * this.markerGain;
      mCol[idx * 3] = col.r * fade * boost; mCol[idx * 3 + 1] = col.g * fade * boost; mCol[idx * 3 + 2] = col.b * fade * boost;

      // Orbit lines follow their body (vertices are body-relative). Fade: planet lines when the camera is
      // right at the planet; moon lines when the camera is far from the moon system.
      if (b.orbitLine) {
        // Anchor: where the body was when the line was sampled (moons: relative to their parent's current position).
        if (b._orbOff && b.kind === 'moon') {
          const p = this.byKey[b.parent];
          b.orbitLine.position.set(p.scenePos[0] + b._orbOff[0] - camPos[0], p.scenePos[1] + b._orbOff[1] - camPos[1], p.scenePos[2] + b._orbOff[2] - camPos[2]);
        } else if (b._orbRef) {
          b.orbitLine.position.set(b._orbRef[0] - camPos[0], b._orbRef[1] - camPos[1], b._orbRef[2] - camPos[2]);
        } else b.orbitLine.position.set(rx, ry, rz);
        let op = 0.55;
        if (b.kind === 'moon') {
          const p = this.byKey[b.parent];
          const orbitR = Math.hypot(...b.sceneOff);
          const ratio = p.camDist / Math.max(orbitR, 1e-9);
          op *= 1 - smooth(25, 120, ratio);
        } else op *= smooth(1.1, 2.5, b.camDist / b.rScene) * (b.minor ? 0.55 : 1);
        b.orbitLine.material.opacity = op;
        b.orbitLine.visible = shown && this.show.orbits && op > 0.01 && (b.kind !== 'moon' || this.show.moonOrbits)
          && (!b.minor || this.show.minorOrbits);
        if (b.ghostLine) {
          b.ghostLine.position.copy(b.orbitLine.position);
          b.ghostLine.visible = b.orbitLine.visible && !!b.ghostOn;
          b.ghostLine.material.opacity = op * 0.5;
          b.ghostLine.material.color.setScalar(this.markerGain);
        }
      }
      // Screen position for labels / picking
      v.set(rx, ry, rz).applyMatrix4(camera.matrixWorldInverse);
      const inFront = v.z < 0;
      v.applyMatrix4(camera.projectionMatrix);
      b.screen.x = (v.x * 0.5 + 0.5) * width;
      b.screen.y = (-v.y * 0.5 + 0.5) * height;
      b.screen.visible = inFront && Math.abs(v.x) < 1.2 && Math.abs(v.y) < 1.2;
    });
    this.markers.geometry.attributes.position.needsUpdate = true;
    this.markers.geometry.attributes.color.needsUpdate = true;
    this.sunLight.position.copy(sunPos);
    this._updateLabels();
  }

  _updateMaterials(b, sunPos, time, camera) {
    if (b.kind === 'sun') {
      b.material.uniforms.uTime.value = time;
      b.corona.quaternion.copy(camera.quaternion);
      b.corona.scale.setScalar(b.rScene * 12);
      b.corona.material.uniforms.uTime.value = time;
      return;
    }
    const dSun = Math.hypot(...b.helio);
    const E = (AU_KM / dSun) ** 2, sunAng = Math.asin(R_SUN / dSun);
    // World→object rotation (for ring/cloud lookups) = inverse of the mesh rotation.
    this._mat.makeRotationFromQuaternion(b.mesh.quaternion).transpose();
    const w2o = this._m3.setFromMatrix4(this._mat);
    const occ = this.occ.get(b.key);
    const setEclipse = (u) => {
      u.uSunPos.value.copy(sunPos);
      u.uSunAng.value = sunAng;
      const list = occ ? occ.list : [];
      u.uOccCount.value = list.length;
      list.forEach((c, i) => {
        const p = c.body.group.position;
        u.uOcc.value[i].set(p.x, p.y, p.z, c.body.rScene);
        u.uOccX.value[i].set(c.K, c.sepTrue, c.sepScene, c.body.key === 'earth' ? 1 : 0);
      });
    };
    const u = b.material.uniforms;
    setEclipse(u);
    u.uSunIrr.value = E;
    u.uWorldToObj.value.copy(w2o);
    u.uAmbient.value = this.ambientLevel ?? 0;
    // Clouds drift slowly relative to the surface (visual; weather is not simulated).
    const cloudAngle = ((this.jdTDB - 2451545) / 23) * Math.PI * 2;
    if (b.cloudMesh) {
      const cr = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationY(cloudAngle));
      u.uCloudRot.value.copy(cr);
      const cu = b.cloudMesh.material.uniforms;
      setEclipse(cu);
      cu.uSunIrr.value = E; cu.uCloudRot.value.copy(cr); cu.uAmbient.value = this.ambientLevel ?? 0;
      b.cloudMesh.quaternion.copy(b.mesh.quaternion);
      b.cloudMesh.scale.set(b.rScene * 1.012, b.rScene * (1 - b.flat) * 1.012, b.rScene * 1.012);
      cu.uInvScale2.value.set(1, 1 / (1 - b.flat) ** 2, 1);
      b.cloudMesh.visible = this.show.clouds && b.pixelRadius > 1.5 && !!b.cloudTex;
      u.uHasClouds.value = b.cloudMesh.visible ? 1 : 0;
    }
    if (b.atmoMesh) {
      const au = b.atmoMesh.material.uniforms;
      setEclipse(au);
      au.uCenter.value.copy(b.group.position);
      au.uR.value = b.rScene;
      au.uSunIrr.value = E;
      const inside = b.camDist < b.rScene * b.atmoRatio;
      au.uInside.value = inside ? 1 : 0;
      au.uFlat.value = b.flat;
      au.uPole.value.set(0, 1, 0).applyQuaternion(b.mesh.quaternion);
      b.atmoMesh.material.side = inside ? THREE.BackSide : THREE.FrontSide;
      // Oblate shell matching the planet's flattening (same orientation as the planet).
      b.atmoMesh.quaternion.copy(b.mesh.quaternion);
      b.atmoMesh.scale.set(b.rScene * b.atmoRatio, b.rScene * b.atmoRatio * (1 - b.flat), b.rScene * b.atmoRatio);
      b.atmoMesh.visible = this.show.atmospheres && b.pixelRadius > 1.0;
    }
    if (b.ringMesh) {
      const ru = b.ringMesh.material.uniforms;
      setEclipse(ru);
      ru.uSunIrr.value = E;
      ru.uWorldToObj.value.copy(w2o);
      ru.uNormal.value.set(0, 1, 0).applyQuaternion(b.mesh.quaternion);
      ru.uPm.value = this.pm;
      u.uRingPm.value = this.pm;
      b.ringMesh.quaternion.copy(b.mesh.quaternion);
      b.ringMesh.scale.setScalar(b.rScene);
      b.ringMesh.visible = this.show.rings && b.pixelRadius > 0.5;
    }
  }

  _updateLabels() {
    const show = this.show.labels;
    this.bigOnScreen = this.bodies.filter((o) => o.pixelRadius > 12 && o.screen.visible && o.group.visible);
    // Asymptote markers (projected like any heliocentric point).
    const v = new THREE.Vector3(), sc = [0, 0, 0];
    for (const b of this.bodies) for (const m of b.pathMarkers || []) {
      let ok = show && b.group.visible && this.show.minorOrbits && this._cam;
      if (ok) {
        this.mapHelioToScene(m.helio, 1, this._scaleRef, sc);
        v.set(sc[0] - this._camPos[0], sc[1] - this._camPos[1], sc[2] - this._camPos[2]).applyMatrix4(this._cam.matrixWorldInverse);
        ok = v.z < 0;
        v.applyMatrix4(this._cam.projectionMatrix);
        ok = ok && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
        if (ok) m.el.style.transform = `translate(${((v.x * 0.5 + 0.5) * this._w + 4).toFixed(1)}px, ${((-v.y * 0.5 + 0.5) * this._h - 8).toFixed(1)}px)`;
      }
      m.el.style.display = ok ? 'block' : 'none';
    }
    for (const b of this.bodies) {
      let vis = show && b.screen.visible && b.group.visible;
      // Hide labels of bodies hidden behind a nearer body's disc.
      if (vis) for (const o of this.bigOnScreen) {
        if (o !== b && o.camDist < b.camDist && Math.hypot(o.screen.x - b.screen.x, o.screen.y - b.screen.y) < o.pixelRadius * 0.95) { vis = false; break; }
      }
      // Named asteroids only get labels when the camera is fairly close (≈ 0.7 AU in scene units) or they're selected;
      // comets only while active (inside ~4 AU of the Sun) or when close/selected.
      // Sensor overlay off ("real emptiness"): no labels for minor bodies/spacecraft unless selected.
      if (vis && b.minor && this.show.minorLabels === false && b !== this.selected) vis = false;
      if (vis && b.minorType === 'asteroid' && b.camDist > 0.7 * AU_KM && b !== this.selected) vis = false;
      if (vis && b.minorType === 'comet' && Math.hypot(...b.helio) > 4 * AU_KM && b.camDist > 0.7 * AU_KM && b !== this.selected) vis = false;
      if (vis && b.kind === 'moon') {
        const p = this.byKey[b.parent];
        const sep = Math.hypot(p.screen.x - b.screen.x, p.screen.y - b.screen.y);
        if (sep < Math.max(26, p.pixelRadius + 14)) vis = false;
      }
      b.label.style.display = vis ? 'block' : 'none';
      if (vis) {
        const off = Math.min(Math.max(b.pixelRadius, 0), 400) + 6;
        b.label.style.transform = `translate(${(b.screen.x + off * 0.7).toFixed(1)}px, ${(b.screen.y - off * 0.7 - 8).toFixed(1)}px)`;
      }
    }
  }

  /** Screen-space pick: nearest body whose disc (or 14 px halo) contains the point. */
  pick(x, y) {
    let best = null, bestD = Infinity;
    for (const b of this.bodies) {
      if (!b.screen.visible || !b.group.visible) continue;
      const d = Math.hypot(b.screen.x - x, b.screen.y - y);
      const r = Math.max(b.pixelRadius, b.kind === 'moon' ? 10 : 14);
      if (d < r && b.camDist < bestD) { best = b; bestD = b.camDist; }
    }
    return best;
  }

  moonsOf(key) { return this.bodies.filter((b) => b.parent === key && b.kind === 'moon').length; }

  /** Scale overlay colors by 1/exposure so tone mapping leaves them unchanged (and they never bloom). */
  setOverlayGain(g) {
    this.markerGain = g;
    const k = Math.min(g, 1) * 0.8;
    for (const b of this.bodies) {
      if (b.orbitLine) b.orbitLine.material.color.setScalar(g * 0.8);
      b.axis.material.color.setScalar(g);
    }
    void k;
  }

  setVisibility(flags) { Object.assign(this.show, flags); if (!this.show.labels) this.bodies.forEach((b) => (b.label.style.display = 'none')); }
}

// [planet, r1, r2] km: full planet-relative placement inside r1, heliocentric beyond r2 (≈ Hill spheres).
const NEAR_PLANET_ZONES = [['earth', 1.5e6, 3e6], ['jupiter', 2.5e7, 5e7]];

/**
 * Body→ecliptic matrix with body x along ±r (sign −1: facing the origin of r, i.e. the parent) and z along
 * the orbit normal n (orthogonalised). Columns = body axes, row-major.
 */
function facing(r, n, sign = 1) {
  const d = Math.hypot(r[0], r[1], r[2]);
  const x = [sign * r[0] / d, sign * r[1] / d, sign * r[2] / d];
  const nn = n || [0, 0, 1];
  const dn = nn[0] * x[0] + nn[1] * x[1] + nn[2] * x[2];
  let z = [nn[0] - dn * x[0], nn[1] - dn * x[1], nn[2] - dn * x[2]];
  const zl = Math.hypot(...z) || 1; z = z.map((v) => v / zl);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]];
}

/** Tidal lock for moons given only by relFn: faces the parent; pole = r × ṙ from a short finite difference. */
function tidalFromRel(b, jdTDB, state) {
  const r1 = b.relFn ? b.relFn(jdTDB + 0.001, state, [0, 0, 0]) : null;
  if (!r1) return null;
  const r0 = b.rel, v = [r1[0] - r0[0], r1[1] - r0[1], r1[2] - r0[2]];
  const n = [r0[1] * v[2] - r0[2] * v[1], r0[2] * v[0] - r0[0] * v[2], r0[0] * v[1] - r0[1] * v[0]];
  const nl = Math.hypot(...n) || 1;
  b._relNormal = n.map((x) => x / nl);
  return facing(r0, b._relNormal, -1);
}

function smooth(e0, e1, x) { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
