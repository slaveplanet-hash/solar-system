// Dev probe: our sub-solar points vs Horizons QUANTITIES=15 (observer = Sun center)
// at 2026-09-25 00:00 UT. Horizons evaluates the target at the light-time-retarded
// instant and reports planetographic latitude / west longitude (prograde planets) or
// east longitude (retrograde planets, Pluto).
import { computeSystemState, subSolarPoint, AU_KM, C_KM_S, ROTATION_MODELS } from '../js/ephemeris.js';
import { utcToTDB } from '../js/time.js';
const jdU0 = 2461308.5 - 69.2 / 86400; // TLIST epoch was TT
const ref = { mercury: [81.889768, -0.023151], venus: [64.591961, 2.533379], earth: [180.336035, -0.779585], mars: [126.571482, -1.157518],
  jupiter: [184.107547, 0.408598], saturn: [81.140641, -9.265765], uranus: [257.481899, 73.905022], neptune: [53.677344, -19.557126], pluto: [313.375493, 60.050078] };
const flat = { mercury: 0, venus: 0, earth: 0.003353, mars: 0.00589, jupiter: 0.06487, saturn: 0.09796, uranus: 0.02293, neptune: 0.01708, pluto: 0 };
const eastPos = { venus: 1, earth: 1, uranus: 1, pluto: 1 };
for (const [k, [lon, lat]] of Object.entries(ref)) {
  let s = computeSystemState(utcToTDB(jdU0));
  const lt = Math.hypot(...s[k]) / C_KM_S / 86400;
  const jdU = jdU0 - lt, jd = utcToTDB(jdU);
  s = computeSystemState(jd);
  const p = subSolarPoint(k, s[k], jd, jdU);
  const latg = Math.atan(Math.tan(p.lat * Math.PI / 180) / (1 - flat[k]) ** 2) * 180 / Math.PI;
  const L = eastPos[k] ? p.lon : (360 - p.lon) % 360;
  let dl = L - lon; dl = ((dl + 540) % 360) - 180;
  console.log(k.padEnd(8), `lon ${L.toFixed(3)} vs ${lon}  Δ ${dl.toFixed(3)}°   lat ${latg.toFixed(3)} vs ${lat}  Δ ${(latg - lat).toFixed(3)}°`);
}
