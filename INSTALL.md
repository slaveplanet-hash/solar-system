# Sol — Local install and usage guide

How to run Sol on your own computer: download the data, start the local server, keep it updated, and connect an AI assistant. For what the project is, see the [README](README.md). To just look at it, open the [live version](https://slaveplanet-hash.github.io/solar-system/).

This guide is for **Windows**. Every command goes in **PowerShell** or **Command Prompt**, opened in this `solar-system` folder (in File Explorer, click the address bar, type `powershell`, press Enter).

---

## 1. Install Node.js

1. Download the **LTS** installer from <https://nodejs.org/> (version 18 or newer) and run it with the default options.
2. Close and reopen PowerShell, then check it worked:

   ```bash
   node --version
   ```

   You should see something like `v22.11.0`. If you get "not recognized", restart Windows once (the installer updates PATH).

## 2. Download the small-body data

```bash
node fetch-data.mjs
```

This contacts NASA/JPL (SBDB, Close-Approach and Horizons APIs) and writes the `data/` folder.

| Command | What you get | Time | Disk |
|---|---|---|---|
| `node fetch-data.mjs --quick` | 2,000 asteroids, 1,000 NEOs, comets, 5 trajectories — good for a first test | under 1 min | ~4 MB |
| `node fetch-data.mjs` (same as `--full`) | 50,000 brightest numbered asteroids, all ~42,000 near-Earth objects, all ~8,300 trans-Neptunian objects and Centaurs, all numbered + upcoming comets, interstellar objects, dwarf planets, ~43,000 Earth close approaches (1900–2100), Horizons trajectories for Apophis, Halley, Hale-Bopp, Eris' moon Dysnomia and 10 spacecraft | ~75 s measured (up to ~5 min if JPL is busy) | 27.7 MB (75 requests) |

Progress is printed as it goes. Requests are sent one at a time with a short pause and are retried automatically if JPL is busy. The simulator also works **without** this step (planets and moons only) — it will tell you the data is missing.

There is no Python version of this script: it assembles multi-segment Horizons trajectories, the Kuiper-belt catalogue and close-approach tables with retries and atomic writes, so a second implementation would not be "simple". Node is the only requirement.

## 3. Start a local web server

Browsers block a page opened by double-clicking `index.html` from loading its modules and data files (`file://` security rules), so the simulator must be served over `http://`. Use **one** of:

```bash
npm run serve
```

(the included zero-dependency server, port 8130), or

```bash
npx serve -l 8130 .
```

or, if you have Python:

```bash
python -m http.server 8130
```

Leave that window open while you use the simulator. If you keep the data outside this folder (`--out`, see Troubleshooting), only the included server can serve it: `node tools/serve.mjs 8130 --data <folder>`.

## 4. Open the simulator

Go to **<http://localhost:8130/>** in Chrome, Edge or Firefox (WebGL2 required).

Handy links:

- `http://localhost:8130/?focus=saturn&t=2017-06-15T00:00&rate=0` — Saturn with its rings wide open
- `http://localhost:8130/?focus=moon&t=2025-03-14T06:58&rate=0&scale=true` — the red Moon of a total lunar eclipse
- `http://localhost:8130/?focus=earth&t=2024-04-08T18:18&rate=0&scale=true` — the Moon's shadow on Earth
- `http://localhost:8130/?focus=didymos&scale=true` — Didymos and Dimorphos, with the pre-DART orbit shown faintly
- `http://localhost:8130/?focus=vesta&scale=true`, `focus=bennu`, `focus=haumea`, `focus=eris` — shape-modelled asteroids and dwarf planets (need the downloaded data)
- `http://localhost:8130/?focus=neowise&t=2020-07-15T00:00&rate=0` and `?focus=halebopp&t=1997-03-20T00:00&rate=0` — a blue ion tail and a curved dust tail (zoom out with the wheel)
- `http://localhost:8130/?focus=oumuamua&t=2017-10-19T00:00&rate=0` — ʻOumuamua's hyperbolic path with inbound/outbound markers and v∞; also `focus=borisov`, `focus=atlas3i`
- `http://localhost:8130/?focus=earth&t=2026-08-12T22:00&scale=true` — Earth inside the Perseid stream. To watch meteors: drag until you're over the **night side in the northern hemisphere** (Perseus is highest before dawn), zoom in with the wheel to below 1,000 km altitude, press **1** (free flight) and drag the view up toward Perseus. Meteors appear only while the radiant is above your horizon — the HUD says *radiant below horizon* otherwise.

Meteor showers: the HUD lists any shower Earth is crossing (Perseids, Orionids, Eta Aquariids, Leonids, Geminids). *Settings → Small bodies* toggles the comet tails and the stream particles, and sets the meteor time-lapse rate (default ×60 the real ZHR).

- `http://localhost:8130/?focus=europa&surface=europa` — stand on Europa with Jupiter (≈12° across) low over the horizon. Europa is tidally locked, so Jupiter hangs still while the Sun rises and sets and Jupiter goes through phases.
- `http://localhost:8130/?surface=mars` — the butterscotch Martian sky at mid-morning; `?surface=earth&t=2026-08-12T20:00` puts you under the Perseids before dawn (true scale switches on automatically).
- `http://localhost:8130/?focus=earth&cam=chase` — launch the ship next to Earth and fly it.
- `http://localhost:8130/?focus=voyager1`, `focus=jwst`, `focus=juno`, `focus=parker` — spacecraft from JPL Horizons, with fading trajectory trails (press **Follow** in the info panel to ride along).
- `http://localhost:8130/?focus=iss&scale=true` — the ISS on its orbit path. Zoom out from Earth to see every satellite's path: the low-orbit shell, the GPS/Galileo/GLONASS/BeiDou orbits and the geostationary ring. **Click a satellite dot** for its name, altitude, speed and whether it is in sunlight. `?sat=<NORAD number>` jumps straight to one (e.g. `sat=20580` for Hubble). *Settings → Satellites* turns groups, paths and labels on and off.
- Press **U** (or the **Events** button) for **Upcoming events**: eclipses, planetary conjunctions, meteor-shower peaks, asteroid close approaches and comet/interstellar perihelia for the next year (or 5 years) from the simulated date. Click one to jump there. For example, the 2026-08-12 total solar eclipse puts you on the central line off Iceland 3 minutes before totality.

URL options: `t=YYYY-MM-DDTHH:MM` (UTC), `focus=<body>`, `scale=true` (true scale), `rate=<sim seconds per second>` (`0` = paused), `instant` (skip the opening flight), `cam=chase|cockpit` (start in the ship), `surface=<body>` with optional `lat`, `lon` (°, east positive), `az`, `alt` (view direction, °).

Controls: drag to orbit, wheel to zoom, click a body to fly there; **1** free flight (click to capture the mouse — or just drag, if your browser view doesn't allow mouse capture — WASD, Q/E roll, Space/C up/down, Shift boost, wheel = max speed), **2** orbit, **3** ship chase camera, **4** ship cockpit, **G** stand on the selected body (surface view; again to leave), **V** true/visual scale, **P** pause, **R** reverse, **[ ]** slower/faster, **H** hide the UI. **✓ Verify** runs the accuracy self-checks.

*Settings → View & quality*:
- **Quality preset** (Low/Medium/High): sets the pixel ratio, anti-aliasing, how many asteroids are drawn, lens flare and film grain. It's remembered in this browser.
- **Sensor overlay**: brackets and labels help you find tiny objects. Switch it off to see space as the eye would, with small bodies at their real (mostly invisible) brightness. Planets and moons always show as points at their true apparent magnitude, so Jupiter from Earth is brighter than any star.

Flying the ship (**3**/**4**): click the view to steer with the mouse (Esc releases), **W/S** thrust, **A/D** strafe, **Space/C** up/down, **Q/E** roll, arrows pitch/yaw, **Shift** boost, wheel = max speed. Speed scales with the distance to the nearest surface, and the ship and free-flight camera ride along with the nearest body, so time-lapse never flings you away. In surface view: drag or arrows to look, **WASD** to walk, wheel to zoom (binoculars).

## 5. Refreshing the data, textures and custom ships

- **Easiest: double-click `update.bat`** in this folder (or run `npm run update`).
  - It refreshes the Earth satellites every time.
  - It also runs the full asteroid/comet/spacecraft download when that data is more than 30 days old (or missing).
  - When it finishes, reload the simulator page. Run it every few days.

- **Refresh the data** any time (new comets, asteroids and interstellar objects are picked up automatically — every `1I`, `2I`, `3I`, … designation and every comet reaching perihelion in the next 5 years):

  ```bash
  node fetch-data.mjs
  ```

  The HUD shows *Data updated: YYYY-MM-DD* and turns yellow after 6 months.
- **Earth satellites** (~960: space stations, GPS/Galileo/GLONASS/BeiDou, weather, science, geostationary and the brightest naked-eye objects) come from a CelesTrak snapshot and **go stale in days, not months**. Refresh them on their own every few days:

  ```bash
  node fetch-data.mjs --satellites
  ```

  - Positions are computed with SGP4, the standard model for this data. They are about 1 km off at the snapshot date, and the error grows by roughly 1–3 km per day in low orbit.
  - Each satellite is drawn at full brightness within 3 days of its element date, dimmed as *approximate* up to 30 days, and hidden beyond that. The HUD *Satellites* row shows the snapshot's age.
  - The download is skipped if the file is less than 2 hours old, because CelesTrak blocks clients that download more often (`--force` overrides this).
  - For the public (GitHub Pages) copy, re-run this and push `data/satellites.json` every few days, or the satellites there will fade and disappear.
- **Photographic textures (optional, already set up in this folder):** the maps from <https://www.solarsystemscope.com/textures/> (CC BY 4.0, see `textures/CREDITS.md`) live in `textures/`, and `textures/textures.json` lists the ones the simulator uses. They load **lazily**:
  - A planet's **2K** map (0.1–1 MB) loads the first time its disc is more than a few pixels wide. Until then, a procedural surface or flat colour is shown.
  - The **4K/8K** maps (Mercury, Venus clouds, Earth day/night/clouds, Moon, Mars, Jupiter, Saturn: 1–15 MB each) load only when you come close. How big they can be depends on the quality preset: *Low* 2K only, *Medium* up to 4K, *High* up to 8K. They are released again a few seconds after you leave. Expect a short hitch (up to ~0.2 s) the moment an 8K map is uploaded to the GPU.
  - Not used on purpose:
    - the `*_fictional` dwarf-planet maps (invented surfaces);
    - the `.tif` normal/specular maps (browsers can't load TIFF);
    - the `*stars*.jpg` maps (the sky comes from the Yale star catalogue);
    - the Saturn ring alpha maps (the rings are built from measured ring data).
  - To add or remove maps, edit the `"available"` list. Only listed files are loaded.
- **Custom ship model:** drag a `.glb` file onto the page (or a `.gltf` together with its `.bin` and texture files), or paste a URL into *Settings → Ship → GLTF/GLB URL* and press *Load*. The model is centred and scaled to *Length (m)*. If it flies sideways or backwards, change *Model forward axis* (glTF models normally face +Z). Adjust the cockpit anchor and chase distance/height in the same folder. Files in this project folder always load. Remote URLs work only if that server allows cross-origin (CORS) requests. Draco- and Meshopt-compressed models are supported; their decoders load from the same CDN as three.js. From the browser console, `app.ship.setModel(anyObject3D)` attaches any three.js object.

## 6. Talk to it through an AI (MCP)

The folder includes an **MCP server** (`mcp/server.mjs`), so an AI assistant can run simulations for you. For example:

- "When is the next total solar eclipse? Show it to me."
- "When can I see the ISS from Chicago this week?"
- "Is Jupiter up tonight from London?"
- "Fly to Saturn in 2017 and take a picture."

It gives the AI two kinds of tools:

| Tools | What they do | Browser needed? |
|---|---|---|
| `body_position`, `sky_at`, `find_eclipses`, `find_conjunctions`, `upcoming_events`, `satellite_find`, `satellite_state`, `satellite_passes` | Calculations with the simulator's own verified code: positions, what's in the sky from a place, eclipses, conjunctions, events, satellite positions and passes | No |
| `sim_open`, `sim_status`, `sim_set_time`, `sim_focus`, `sim_camera`, `sim_surface`, `sim_scale`, `sim_display`, `sim_show_event`, `sim_screenshot`, `sim_verify`, `sim_errors`, `sim_eval`, … | Control the simulator on screen: time, camera, standing on a surface, layers, staging events, screenshots. `sim_eval` runs any JavaScript in the page for full control | Yes. It starts the local server and opens the page itself (`sim_open`) |

**Install: double-click `install-mcp.bat`** (or run `node mcp/install.mjs`). It:
- registers the server with **Claude Code** for every folder;
- installs two skills: `sol-simulator` teaches Claude how to use the tools (recipes for eclipses, satellite passes, screenshots), and `sol-simulator-setup` lets an AI install, check and repair the setup;
- adds it to **Claude Desktop** if that's installed (your old settings are kept as a `.bak`);
- adds it to **OpenCode**, both the CLI and OpenCode Desktop, if installed. It inserts only its own entry into `~/.config/opencode/opencode.jsonc`, keeps a `.bak`, and OpenCode picks up the skills automatically;
- prints the settings block to paste into **any other AI app** (Cursor, VS Code, Windsurf, LM Studio, …);
- self-tests the server.

Then start a **new** `claude` session (or reopen Claude Desktop or OpenCode) and ask away.
- `install-mcp.bat --check` shows what's installed.
- `install-mcp.bat --uninstall` removes it all.
- If you move this folder, run the installer again, because it stores full paths.

To stop Claude Code asking permission for every tool call, add `"mcp__sol-simulator__*"` to `permissions.allow` in `%USERPROFILE%\.claude\settings.json`.

**How it connects:**
- The MCP server starts `tools/serve.mjs` on port 8130 if it isn't already running.
- The simulator page, only when opened from `localhost`, listens for commands from it. The published GitHub Pages copy has no bridge.

**Security:**
- The server only listens on `127.0.0.1`, so nothing else on your network can reach it.
- Commands need a random token that changes every time the server starts (kept in `logs/bridge.json`, which is not committed). So other websites you visit can't control the simulator.

## 7. Troubleshooting

| Problem | Fix |
|---|---|
| Blank page, or "Failed to fetch dynamically imported module" | You opened `index.html` directly. Start a server (step 3) and use `http://localhost:8130/`. |
| "CORS" errors in the browser console | Same cause — the page must come from `http://localhost`, not `file://`. The browser never calls JPL directly; only `fetch-data.mjs` does. |
| HUD says *Data: missing — run fetch-data* | Run `node fetch-data.mjs` in this folder, then reload the page. |
| `fetch-data` stops with "giving up on …" | JPL was unreachable for a while. Check your connection and run it again; it rewrites the files from scratch. |
| `fetch-data` fails with `ENOENT`, `EBADF`, `EPERM` or "Access denied" while writing | Windows Security **Controlled folder access** (ransomware protection) is blocking Node from writing inside *Documents*. Either allow Node: *Windows Security → Virus & threat protection → Ransomware protection → Allow an app through Controlled folder access → Add* `C:\Program Files\nodejs\node.exe`; **or** keep the data outside Documents. In **PowerShell**: `node fetch-data.mjs --out "$env:LOCALAPPDATA\sol-data"` then `node tools/serve.mjs 8130 --data "$env:LOCALAPPDATA\sol-data"` (in Command Prompt write `%LOCALAPPDATA%\sol-data` instead). Only the included `tools/serve.mjs` supports `--data`; `npx serve` and `python -m http.server` don't. |
| Black screen / "WebGL2 is required" | Update the browser and graphics driver; make sure hardware acceleration is on (Chrome: Settings → System). |
| Low frame rate | Open *Settings → View & quality* and pick **Low** (or Medium). Also: turn off Atmospheres, Lens flare and Film grain, lower Bloom, or switch *Small bodies → Display* off some groups. Close other GPU-heavy tabs. |
| Port 8130 already in use | Use another port, e.g. `node tools/serve.mjs 8140`, then open `http://localhost:8140/`. |

## For developers

- `npm test` — all Node test suites (`tests/`):
  - ephemerides vs JPL Horizons;
  - the Kepler propagator;
  - all 44 eclipses of 2021–2030 vs NASA's catalogue;
  - planet magnitudes vs Horizons;
  - the downloaded data;
  - Earth satellites: SGP4 plus the time and frame conversion vs JPL Horizons' ISS track (frozen fixture, agreement ~0.2 km);
  - the MCP server over stdio: handshake, tool list, calculation tools, error handling, clean stdout.
- `npm run report` — runs every self-check that works in Node (the ✓ Verify checks plus all test suites) and writes **`VERIFY-REPORT.md`** (spec §7, §8 and phase checks, with PASS/FAIL). In the app, **✓ Verify → Copy report** copies the same report including the two browser-only (WebGL) checks.
- `node tools/fit-moons.mjs` — refit the moons' mean elements to Horizons (writes `js/data/moonElements.js`).
- `node tools/pack-stars.mjs` — repack the Yale Bright Star Catalogue into `js/data/stars.js`.

Data sources: JPL SSD (Standish planetary elements, SBDB, CAD, Horizons DE441 and satellite ephemerides), Meeus *Astronomical Algorithms* (Moon), IAU WGCCRE (rotation), Yale Bright Star Catalogue 5th ed. via CDS VizieR (V/50), CelesTrak GP data (Earth satellites; SGP4 via [satellite.js](https://github.com/shashwatak/satellite-js), MIT, vendored in `js/vendor/satellite/`).

## Credits

- Planet textures: **Solar System Scope** (<https://www.solarsystemscope.com/textures/>), licensed [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/), developed by INOVE; based on NASA data (MESSENGER, Viking, Cassini, Hubble, Blue Marble). The app shows this credit on screen while photo maps are in use. Details: `textures/CREDITS.md`.
- Ephemerides and small-body data: NASA/JPL Solar System Dynamics (Horizons, SBDB, CAD). Eclipse test data: NASA GSFC eclipse tables (F. Espenak). Meteor-shower parameters: International Meteor Organization.
- three.js and lil-gui (MIT), loaded from the jsDelivr CDN.
