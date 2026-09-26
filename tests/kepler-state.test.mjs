// Node test: general-state universal propagator vs the element-based conic solver.
import { propagateState, conicPosition, GM_SUN_AU_D } from '../js/kepler.js';

let fails = 0;
const check = (name, ok, detail) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`); if (!ok) fails++; };

// Halley-like orbit: state at t0 (finite-difference velocity), propagate ±years, compare with conicPosition.
const el = { q: 0.5871, e: 0.9673, i: 162.2, node: 58.4, peri: 111.3, tp: 2446470.5 };
// h = 0.01 d: smaller steps make the finite-difference velocity (not the propagator) lose digits to round-off.
const t0 = 2446400, h = 1e-2;
const r0 = conicPosition(el, t0, GM_SUN_AU_D, [0, 0, 0]);
const r1 = conicPosition(el, t0 + h, GM_SUN_AU_D, [0, 0, 0]), rm = conicPosition(el, t0 - h, GM_SUN_AU_D, [0, 0, 0]);
const v0 = r1.map((v, i) => (v - rm[i]) / (2 * h));
let worst = 0;
for (const dt of [-300, -30, 1, 70, 400, 3000]) {
  const p = propagateState(r0, v0, dt, GM_SUN_AU_D), ref = conicPosition(el, t0 + dt, GM_SUN_AU_D, [0, 0, 0]);
  worst = Math.max(worst, Math.hypot(...p.map((v, i) => v - ref[i])));
}
check('propagateState vs conicPosition (e = 0.967)', worst < 1e-5, `worst |Δ| ${worst.toExponential(2)} AU over ±3000 d (limited by the finite-difference test velocity)`);

// Hyperbolic comet (e = 1.5) the same way.
{
  const eh = { q: 0.8, e: 1.5, i: 40, node: 10, peri: 20, tp: 2460000 };
  const t = 2459950, a = conicPosition(eh, t, GM_SUN_AU_D, [0, 0, 0]);
  const b = conicPosition(eh, t + h, GM_SUN_AU_D, [0, 0, 0]), c = conicPosition(eh, t - h, GM_SUN_AU_D, [0, 0, 0]);
  const v = b.map((x, i) => (x - c[i]) / (2 * h));
  let w = 0;
  for (const dt of [-500, 20, 50, 900]) {
    const p = propagateState(a, v, dt, GM_SUN_AU_D), ref = conicPosition(eh, t + dt, GM_SUN_AU_D, [0, 0, 0]);
    w = Math.max(w, Math.hypot(...p.map((x, i) => x - ref[i])) / Math.max(1, Math.hypot(...ref)));
  }
  check('propagateState vs conicPosition (e = 1.5)', w < 1e-6, `worst relative |Δ| ${w.toExponential(2)}`);
}

// Radiation-pressure grain (β = 0.9 → μ_eff = 0.1 μ): specific orbital energy must be conserved.
{
  const mu = GM_SUN_AU_D * 0.1, r0 = [1, 0, 0], v0 = [0, 0.0172, 0], v = [0, 0, 0];
  const r = propagateState(r0, v0, 100, mu, [0, 0, 0], v);
  const E = (rr, vv) => (vv[0] ** 2 + vv[1] ** 2 + vv[2] ** 2) / 2 - mu / Math.hypot(...rr);
  const dE = Math.abs(E(r, v) - E(r0, v0)) / Math.abs(E(r0, v0));
  check('β = 0.9 grain conserves energy (μ_eff = 0.1 μ)', dE < 1e-9, `relative ΔE ${dE.toExponential(2)}; r(100 d) = (${r.map((x) => x.toFixed(3)).join(', ')}) AU`);
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
