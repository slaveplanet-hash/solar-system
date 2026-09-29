---
name: sol-simulator
description: Run and show simulations in the Sol Solar System simulator through its MCP tools (sol-simulator). Use when the user asks about planet or moon positions, what is in the sky from a place, eclipses, conjunctions, meteor showers, asteroid flybys, ISS or other satellite passes, or wants the simulator to jump to a date, fly to a body, stand on a surface, or show and screenshot an event.
---

# Sol simulator via MCP

Two kinds of tools on the `sol-simulator` MCP server:

- **Calculations (no browser needed; use these for any numbers):** `body_position`, `sky_at`, `find_eclipses`, `find_conjunctions`, `upcoming_events`, `satellite_find`, `satellite_state`, `satellite_passes`.
- **The simulator on screen (`sim_*`):** `sim_open` (start it), `sim_status`, `sim_set_time`, `sim_focus`, `sim_camera`, `sim_surface` / `sim_leave_surface`, `sim_scale`, `sim_display`, `sim_show_event`, `sim_screenshot`, `sim_list_bodies`, `sim_body_info`, `sim_verify`, `sim_errors`, `sim_eval`.

## Rules

- Times are UTC ISO 8601 (`2026-08-12T17:45`). Convert the user's local time to UTC first and say which you used. Longitudes are east-positive (New York −74, Tokyo +139.7).
- If a `sim_*` tool says no tab is connected, call `sim_open`, then retry. If one times out, Chrome may have frozen the background tab: ask the user to bring the simulator tab to the front (or reload it).
- After changing the view, check it with `sim_screenshot`; describe what you see and don't assume. The image shows only the 3-D view; HUD values come from `sim_status`.
- Satellites exist only within ±30 days of the snapshot (best within 3). Outside that, say so and suggest running `update.bat`.
- Prefer the specific tools. Use `sim_eval` (JavaScript, `app` = the running simulator) only for what they can't do, and tell the user what you ran.

## Recipes

**Show an eclipse.** Use `find_eclipses` for the time, then `sim_show_event {type: "solar-eclipse", near_utc}`. This stands you on the central line a few minutes before totality at ×15 speed. Then `sim_screenshot`. For a lunar eclipse use `type: "lunar-eclipse"`.

**ISS (or any satellite) over a city.** Run `satellite_passes {satellite: "ISS", lat, lon, visible_only: true}` and report rise, max and set times (in the user's time zone as well as UTC), directions and max elevation. To show one:
1. `sim_set_time` to one minute before max.
2. `sim_surface {body: "earth", lat, lon, azimuth_deg: <max azimuth>, altitude_deg: <max elevation>, fov_deg: 60}`.
3. `sim_screenshot`.

**What's up tonight.** `sky_at {lat, lon, time}` at a dark hour (Sun below −12°). Planets with altitude > 10° are worth looking for.

**Tour a body.**
1. `sim_focus {target}`.
2. `sim_camera {distance_km}`, or `{radii}` for multiples of the body's radius, plus `azimuth_deg` and `elevation_deg` to frame it.
3. `sim_screenshot`.

If Earth or another body blocks the view, change the azimuth or elevation.

**Watch motion.** `sim_set_time {rate}`, where rate is simulated seconds per real second. Useful values: 60 for satellites, 3600 for moons, 86400 for planets.

**True vs visual scale.** `sim_scale {mode: "true"}` for real sizes and distances (needed for sky views and eclipses). Use `"visual"` for overviews, where bodies are ×200 larger and distances compressed.

**Clean view.** `sim_display {orbits: false, labels: false, sensor_overlay: false, ui_hidden: true}`. `satellites: {groups: {geo: false}}` hides one satellite group.

## Accuracy to state when it matters

- Planets: JPL elements, arcsecond-level for 1800–2050.
- Moon: a few km.
- Eclipses: match NASA's catalogue (time within minutes).
- Satellites (SGP4): about 1 km at the snapshot, growing 1–3 km/day in low orbit. Pass times near the snapshot are good to seconds.
- Elevations are geometric: add about 0.5° near the horizon for refraction.
- Close approaches and comet brightness come from JPL tables and rough magnitude models.
