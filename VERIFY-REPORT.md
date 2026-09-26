# Sol Simulator — self-check report

- Generated 2026-09-26 00:50:41 UTC with Node v24.18.0
- Data: C:\Users\tom\Documents\AI Project Folder\solar-system\data (downloaded 2026-09-25, full)
- Browser-only rows (GPU solver readback, named-body models) are SKIP here — run ✓ Verify in the app and use "Copy report".
- **Verify:** 34 pass · 0 fail · 2 skipped · 0 pending
- **Test suites:** 5 (5 passed) — 84 PASS lines, 0 FAIL
- ⏱ = depends on today's date or the data download date, so its numbers change from day to day.

## Spec §7 — core accuracy checks
| Status | Check | Result |
|---|---|---|
| ✅ PASS | Total solar eclipse 2024-04-08 18:18 UTC | Moon between Sun & Earth: yes; shadow-axis γ = 0.3463 R⊕ (NASA 0.3431 at greatest eclipse 18:17:16) |
| ✅ PASS | Total lunar eclipse 2025-03-14 06:58 UTC | Moon centre 2223 km from shadow axis (γ 0.3485, NASA 0.3485); umbra radius 4645 km → fully inside umbra (total) |
| ✅ PASS | Earth perihelion 2026 ⏱ | 0.98327 AU on 2026-01-03 17:08 UTC (expect ≈0.983 AU near Jan 3) |
| ✅ PASS | Earth aphelion 2026 ⏱ | 1.01669 AU on 2026-07-06 18:08 UTC (expect ≈1.017 AU near Jul 4) |
| ✅ PASS | Jupiter heliocentric longitude vs JPL Horizons ⏱ | 2026-09-26 00:50 UTC: sim 130.754°, Horizons 130.733°, Δ 0.0207° (limit 1°) |
| ✅ PASS | Mars heliocentric longitude vs JPL Horizons ⏱ | 2026-09-26 00:50 UTC: sim 82.822°, Horizons 82.829°, Δ 0.0068° (limit 1°) |
| ✅ PASS | Io orbital period ⏱ | mean of 50 orbits = 1.76909 d (expect 1.769 d; IAU 1.769138 d) |
| ✅ PASS | Synodic month (Moon) ⏱ | mean of 37 lunations = 29.5444 d (expect 29.5306); individual 29.29–29.81 d; next new moon 2026-10-10 15:50 UTC |

## Spec §8 — additional self-checks
| Status | Check | Result |
|---|---|---|
| ✅ PASS | Halley's Comet perihelion 1986-02-09, ~0.586 AU | Horizons vectors: perihelion 1986-02-09 11:00 UTC at 0.5871 AU |
| ✅ PASS | Hale-Bopp perihelion 1997-04-01, ~0.914 AU | Horizons vectors: perihelion 1997-04-01 03:10 UTC at 0.9142 AU |
| ✅ PASS | ʻOumuamua perihelion 2017-09-09, ~0.256 AU | 'Oumuamua (A/2017 U1): two-body perihelion from current elements 2017-09-09 12:09 UTC at q = 0.2559 AU (e = 1.2011) |
| ✅ PASS | Apophis closest approach 2029-04-13, ~38,000 km (inside GEO) | Horizons vectors: 38011 km from Earth's center at 2029-04-13 21:45 UTC (GEO radius 42,164 km) |
| ✅ PASS | Perseids: Earth crosses the 109P stream ~08/12 ⏱ | closest 2026-08-12 10:39 UTC (-0.1 d vs peak) at 0.0004 AU from the parent orbit; radiant RA 45.8°, Dec 57.7° (1.2° from IMO 48°, 58°); v_g 59.4 km/s (IMO 59) |

## Phase-specific checks (data, moons, rendering, small bodies, comets, events)
| Status | Check | Result |
|---|---|---|
| ✅ PASS | Events engine finds the 2024-04-08 total solar & 2025-03-14 total lunar eclipses | found total solar (+0.9 min vs NASA), total lunar (+1.2 min); tests/events.test.mjs checks all 44 eclipses of 2021–2030 |
| ✅ PASS | 20 major moons vs JPL Horizons (2026-09-25) | worst mimas 2.339° (7567 km); phobos 1.01°, deimos 0.06°, io 0.06°, europa 0.08°, ganymede 0.26°, callisto 0.33°, mimas 2.34°, enceladus 0.20°, tethys 0.07°, dione 0.05°, rhea 0.10°, titan 0.03°, iapetus 0.08°, miranda 0.30°, ariel 0.15°, umbriel 0.14°, titania 0.10°, oberon 0.09°, triton 0.01°, charon 0.00° |
| ✅ PASS | Solar eclipse shading (Moon umbra on Earth) | solar disc visible at the shadow-axis point on Earth: 0.000% (total → 0%) |
| ✅ PASS | Lunar eclipse shading (Moon turns red) | solar disc visible from Moon center 0.00%; light rgb (0.0392, 0.0132, 0.0041) — red-dominant |
| ✅ PASS | Kepler solver: universal vs elliptic (e = 0.5) | max \|Δ\| 3.61e-15 AU |
| ✅ PASS | Kepler solver: universal vs hyperbolic (e = 1.5) | max relative \|Δ\| 5.45e-16 |
| ✅ PASS | Kepler solver: near-parabolic continuity (e = 0.9999 / 1 / 1.0001) | max \|Δ\| 6.78e-4 AU |
| ✅ PASS | Rotation sense (retrograde rotators) ⏱ | retrograde: venus, uranus (expect venus, uranus) |
| ✅ PASS | Earth daylight / GMST alignment (2026-06-21 12:00 UTC) | sub-solar point 23.44°N, 0.46°E (expect ≈23.43°N, +0.4°E) |
| ✅ PASS | Small-body data present and fresh (< 6 months) ⏱ | updated 2026-09-25 (0.2 d ago, full); 50000 asteroids, 42531 NEOs (2549 PHA), 645 comets, 3 interstellar, 8 dwarfs, 43470 close approaches, 14 Horizons tracks |
| ➖ SKIP | GPU Kepler solver vs float64 CPU (render-target readback) | needs WebGL (runs in the browser Verify panel) |
| ✅ PASS | Horizons vector interpolation (cubic Hermite, leave-one-out) | Apophis, predicting each sample from neighbours 2 steps apart (an upper bound): geocentric 10 min: ≤ 0.13 km; heliocentric 360 min: ≤ 106.86 km; heliocentric 1440 min: ≤ 3.72 km; heliocentric 1440 min: ≤ 1.50 km |
| ✅ PASS | Kirkwood gaps emerge in the main-belt semi-major axes | 40,448 main-belt asteroids; density in gap ÷ neighbours: 3:1 0.00, 5:2 0.00, 7:3 0.20, 2:1 0.00 (gap if < 0.35) |
| ✅ PASS | Jupiter Trojans cluster at L4/L5 (±60° from Jupiter) | 8,015 Trojans: L4 (leading) 4788 with median Δλ = 62.1°, L5 (trailing) 3227 with median -61.6°; 99.7% within 20–100° of Jupiter |
| ✅ PASS | Plutinos pile up in the 3:2 Neptune resonance (a ≈ 39.4 AU) | 8,341 TNOs/Centaurs; density at 39.2–39.7 AU is 6.4× the neighbouring bins (resonance if > 3) |
| ✅ PASS | DART changed Dimorphos' orbital period (−33 min) | sim period 11.921 h before → 11.367 h after the 2022-09-26 impact: Δ = -33.2 min (published −33.24 ± 1.6 min, Naidu 2024) |
| ➖ SKIP | Named asteroids & dwarf planets modelled | browser only |
| ✅ PASS | Orionids: Earth crosses the 1P stream ~10/21 ⏱ | closest 2026-10-25 19:55 UTC (+4.3 d vs peak) at 0.1504 AU from the parent orbit; radiant RA 97.8°, Dec 19.4° (4.3° from IMO 95°, 16°); v_g 65.7 km/s (IMO 66) |
| ✅ PASS | Eta Aquariids: Earth crosses the 1P stream ~05/06 ⏱ | closest 2026-05-07 09:54 UTC (+0.9 d vs peak) at 0.0747 AU from the parent orbit; radiant RA 337.4°, Dec 1.2° (2.3° from IMO 338°, -1°); v_g 66.5 km/s (IMO 66) |
| ✅ PASS | Leonids: Earth crosses the 55P stream ~11/17 ⏱ | closest 2026-11-17 17:38 UTC (+0.2 d vs peak) at 0.0081 AU from the parent orbit; radiant RA 153.4°, Dec 21.8° (1.3° from IMO 152°, 22°); v_g 70.8 km/s (IMO 71) |
| ✅ PASS | Geminids: Earth crosses the Phaethon stream ~12/14 ⏱ | closest 2026-12-14 21:03 UTC (+0.4 d vs peak) at 0.0187 AU from the parent orbit; radiant RA 114.7°, Dec 32.7° (2.2° from IMO 112°, 33°); v_g 33.8 km/s (IMO 35) |
| ✅ PASS | Interstellar objects: hyperbolic excess speed v∞ and ʻOumuamua radiant | 'Oumuamua 26.4 km/s (expect 26.3); C/2019 Q4 32.3 km/s (expect 32.3); C/2025 N1 58.0 km/s (expect 58); ʻOumuamua came from RA 279.6°, Dec 33.9° (0.2° from the published 279.8°, +33.9°, near Vega) |
| ✅ PASS | Dust tail curves behind the orbital motion (syndyne/synchrone model) | NEOWISE on 2020-07-20 (17 d after perihelion): synchrone angle from the anti-sunward ion-tail axis 4 d → 8° trailing, 13 d → 37° trailing, 30 d → 99° trailing, 60 d → 129° trailing — curves steadily toward −v |

## Node test suites (`npm test`)
### ephemeris.test.mjs — passed
- ✅ mercury helio direction — worst 3.4″, \|Δr\| 7.64e-6 AU
- ✅ venus helio direction — worst 18.3″, \|Δr\| 1.72e-5 AU
- ✅ earth helio direction — worst 11.8″, \|Δr\| 3.91e-5 AU
- ✅ mars helio direction — worst 25.5″, \|Δr\| 1.13e-4 AU
- ✅ jupiter helio direction — worst 513.7″, \|Δr\| 2.74e-3 AU
- ✅ saturn helio direction — worst 610.1″, \|Δr\| 1.15e-2 AU
- ✅ uranus helio direction — worst 70.5″, \|Δr\| 1.16e-2 AU
- ✅ neptune helio direction — worst 53.9″, \|Δr\| 3.88e-3 AU
- ✅ pluto helio direction — worst 38.8″, \|Δr\| 8.72e-3 AU
- ✅ moon @JD 2440000.5000 — Δθ 16.4″ — Δr -5.2 km — \|Δ\| 32 km
- ✅ moon @JD 2451545.0000 — Δθ 1.7″ — Δr -3.8 km — \|Δ\| 5 km
- ✅ moon @JD 2460409.2633 — Δθ 10.3″ — Δr 2.3 km — \|Δ\| 18 km
- ✅ moon @JD 2460748.7911 — Δθ 2.5″ — Δr 1.2 km — \|Δ\| 5 km
- ✅ moon @JD 2461308.5000 — Δθ 5.5″ — Δr -1.3 km — \|Δ\| 10 km
- ✅ moon @JD 2466000.5000 — Δθ 36.1″ — Δr 0.6 km — \|Δ\| 64 km
- ✅ mars longitude 2024–2030 vs Horizons — worst 0.0190°
- ✅ jupiter longitude 2024–2030 vs Horizons — worst 0.0630°
- ✅ universal vs elliptic (e=0.5) — max \|Δ\| 3.61e-15 AU
- ✅ universal vs hyperbolic (e=1.5) — max rel \|Δ\| 5.45e-16
- ✅ near-parabolic continuity e=0.9999/1/1.0001 — max \|Δ\| 6.78e-4 AU
- ✅ conicPosition r(tp) = q — r=0.586000000000
- ✅ 2024-04-08 solar eclipse gamma — γ=0.3463 (NASA 0.3431 at 18:17:16)
- ✅ 2025-03-14 lunar eclipse gamma
- ✅ mercury rotation (sub-solar point) — Δlon -0.009° — Δlat 0.000°
- ✅ venus rotation (sub-solar point) — Δlon 0.006° — Δlat 0.000°
- ✅ earth rotation (sub-solar point) — Δlon 0.002° — Δlat -0.000°
- ✅ mars rotation (sub-solar point) — Δlon -0.000° — Δlat -0.002°
- ✅ jupiter rotation (sub-solar point) — Δlon -0.016° — Δlat -0.002°
- ✅ saturn rotation (sub-solar point) — Δlon -0.070° — Δlat -0.041°
- ✅ uranus rotation (sub-solar point) — Δlon 0.018° — Δlat 0.002°
- ✅ neptune pole
- ✅ pluto rotation (sub-solar point) — Δlon 0.012° — Δlat -0.002°
- ✅ phobos — vs Horizons — worst 1.009° (163 km), fit rms 0.267°
- ✅ deimos — vs Horizons — worst 0.070° (29 km), fit rms 0.027°
- ✅ io — vs Horizons — worst 0.072° (1563 km), fit rms 0.006°
- ✅ europa — vs Horizons — worst 0.078° (6236 km), fit rms 0.032°
- ✅ ganymede — vs Horizons — worst 0.273° (5467 km), fit rms 0.07°
- ✅ callisto — vs Horizons — worst 0.544° (18142 km), fit rms 0.202°
- ✅ mimas — vs Horizons — worst 2.339° (7567 km), fit rms 1.496°
- ✅ enceladus vs Horizons — worst 0.203° (847 km), fit rms 0.115°
- ✅ tethys — vs Horizons — worst 0.073° (375 km), fit rms 0.013°
- ✅ dione — vs Horizons — worst 0.048° (318 km), fit rms 0.015°
- ✅ rhea — vs Horizons — worst 0.128° (1215 km), fit rms 0.076°
- ✅ titan — vs Horizons — worst 0.034° (927 km), fit rms 0.018°
- ✅ iapetus — vs Horizons — worst 0.096° (6283 km), fit rms 0.032°
- ✅ ariel — vs Horizons — worst 0.283° (956 km), fit rms 0.139°
- ✅ umbriel — vs Horizons — worst 0.361° (1694 km), fit rms 0.287°
- ✅ titania — vs Horizons — worst 0.146° (1108 km), fit rms 0.081°
- ✅ oberon — vs Horizons — worst 0.213° (2190 km), fit rms 0.09°
- ✅ miranda — vs Horizons — worst 0.407° (923 km), fit rms 0.154°
- ✅ triton — vs Horizons — worst 0.053° (327 km), fit rms 0.004°
- ✅ charon — vs Horizons — worst 0.004° (1 km), fit rms 0°

### kepler-state.test.mjs — passed
- ✅ propagateState vs conicPosition (e = 0.967) — worst \|Δ\| 4.16e-6 AU over ±3000 d (limited by the finite-difference test velocity)
- ✅ propagateState vs conicPosition (e = 1.5) — worst relative \|Δ\| 8.27e-8
- ✅ β = 0.9 grain conserves energy (μ_eff = 0.1 μ) — relative ΔE 2.29e-16; r(100 d) = (0.900, 1.677, 0.000) AU

### events.test.mjs — passed
- ✅ solar eclipses 2021–2030: 22 in NASA's table, 22 found; worst timing error 1.6 min
- ✅ lunar eclipses 2021–2030: 22 in NASA's table, 22 found; worst timing error 1.4 min
- ✅ Jupiter–Saturn great conjunction 2020-12-21 (0.10°): JD 2459205.69, 6.0′

### photometry.test.mjs — passed
- ✅ mercury — V — -0.20 — Horizons — -0.202 — Δ +0.000
- ✅ venus — V — -4.80 — Horizons — -4.804 — Δ +0.000
- ✅ mars — V — 1.15 — Horizons — 1.069 — Δ +0.082
- ✅ jupiter — V — -1.86 — Horizons — -1.854 — Δ -0.001
- ✅ saturn — V — 0.37 — Horizons — 0.375 — Δ -0.004
- ✅ uranus — V — 5.74 — Horizons — 5.662 — Δ +0.080
- ✅ neptune — V — 7.68 — Horizons — 7.679 — Δ +0.001
- ✅ moon — V — -12.17 — Horizons -12.152 — Δ -0.020

### data.test.mjs — passed
- ✅ Hermite interpolation, daily samples, Earth-like orbit — worst 0.039 km
- ✅ Small-body data present and fresh (< 6 months) — updated 2026-09-25 (0.2 d ago, full); 50000 asteroids, 42531 NEOs (2549 PHA), 645 comets, 3 interstellar, 8 dwarfs, 43470 close approaches, 14 Horizons tracks
- ➖ GPU Kepler solver vs float64 CPU (render-target readback) — needs WebGL (runs in the browser Verify panel)
- ✅ Horizons vector interpolation (cubic Hermite, leave-one-out) — Apophis, predicting each sample from neighbours 2 steps apart (an upper bound): geocentric 10 min: ≤ 0.13 km; heliocentric 360 min: ≤ 106.86 km; heliocentric 1440 min: ≤ 3.72 km; heliocentric 1440 min: ≤ 1.50 km
- ✅ Halley's Comet perihelion 1986-02-09, ~0.586 AU — Horizons vectors: perihelion 1986-02-09 11:00 UTC at 0.5871 AU
- ✅ Hale-Bopp perihelion 1997-04-01, ~0.914 AU — Horizons vectors: perihelion 1997-04-01 03:10 UTC at 0.9142 AU
- ✅ ʻOumuamua perihelion 2017-09-09, ~0.256 AU — 'Oumuamua (A/2017 U1): two-body perihelion from current elements 2017-09-09 12:09 UTC at q = 0.2559 AU (e = 1.2011)
- ✅ Apophis closest approach 2029-04-13, ~38,000 km (inside GEO) — Horizons vectors: 38011 km from Earth's center at 2029-04-13 21:45 UTC (GEO radius 42,164 km)
- ✅ Kirkwood gaps emerge in the main-belt semi-major axes — 40,448 main-belt asteroids; density in gap ÷ neighbours: 3:1 0.00, 5:2 0.00, 7:3 0.20, 2:1 0.00 (gap if < 0.35)
- ✅ Jupiter Trojans cluster at L4/L5 (±60° from Jupiter) — 8,015 Trojans: L4 (leading) 4788 with median Δλ = 62.1°, L5 (trailing) 3227 with median -61.6°; 99.7% within 20–100° of Jupiter
- ✅ Plutinos pile up in the 3:2 Neptune resonance (a ≈ 39.4 AU) — 8,341 TNOs/Centaurs; density at 39.2–39.7 AU is 6.4× the neighbouring bins (resonance if > 3)
- ✅ DART changed Dimorphos' orbital period (−33 min) — sim period 11.921 h before → 11.367 h after the 2022-09-26 impact: Δ = -33.2 min (published −33.24 ± 1.6 min, Naidu 2024)
- ➖ Named asteroids & dwarf planets modelled — browser only
- ✅ Perseids: Earth crosses the 109P stream ~08/12 — closest 2026-08-12 10:39 UTC (-0.1 d vs peak) at 0.0004 AU from the parent orbit; radiant RA 45.8°, Dec 57.7° (1.2° from IMO 48°, 58°); v_g 59.4 km/s (IMO 59)
- ✅ Orionids: Earth crosses the 1P stream ~10/21 — closest 2026-10-25 19:55 UTC (+4.3 d vs peak) at 0.1504 AU from the parent orbit; radiant RA 97.8°, Dec 19.4° (4.3° from IMO 95°, 16°); v_g 65.7 km/s (IMO 66)
- ✅ Eta Aquariids: Earth crosses the 1P stream ~05/06 — closest 2026-05-07 09:54 UTC (+0.9 d vs peak) at 0.0747 AU from the parent orbit; radiant RA 337.4°, Dec 1.2° (2.3° from IMO 338°, -1°); v_g 66.5 km/s (IMO 66)
- ✅ Leonids: Earth crosses the 55P stream ~11/17 — closest 2026-11-17 17:38 UTC (+0.2 d vs peak) at 0.0081 AU from the parent orbit; radiant RA 153.4°, Dec 21.8° (1.3° from IMO 152°, 22°); v_g 70.8 km/s (IMO 71)
- ✅ Geminids: Earth crosses the Phaethon stream ~12/14 — closest 2026-12-14 21:03 UTC (+0.4 d vs peak) at 0.0187 AU from the parent orbit; radiant RA 114.7°, Dec 32.7° (2.2° from IMO 112°, 33°); v_g 33.8 km/s (IMO 35)
- ✅ Interstellar objects: hyperbolic excess speed v∞ and ʻOumuamua radiant — 'Oumuamua 26.4 km/s (expect 26.3); C/2019 Q4 32.3 km/s (expect 32.3); C/2025 N1 58.0 km/s (expect 58); ʻOumuamua came from RA 279.6°, Dec 33.9° (0.2° from the published 279.8°, +33.9°, near Vega)
- ✅ Dust tail curves behind the orbital motion (syndyne/synchrone model) — NEOWISE on 2020-07-20 (17 d after perihelion): synchrone angle from the anti-sunward ion-tail axis 4 d → 8° trailing, 13 d → 37° trailing, 30 d → 99° trailing, 60 d → 129° trailing — curves steadily toward −v

