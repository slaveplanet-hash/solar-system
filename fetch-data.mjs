#!/usr/bin/env node
// =============================================================================
// fetch-data.mjs — Download small-body and trajectory data for the simulator.
//
//   node fetch-data.mjs            (full dataset: ~2–5 min, ~25 MB — measured 111 s / 24.8 MB on 2026-09-25)
//   node fetch-data.mjs --quick    (test dataset: ~1 min, ~4 MB)
//   node fetch-data.mjs --full     (same as no flag)
//   node fetch-data.mjs --satellites  (only refresh the Earth satellites — do this every few days;
//                                      skipped if the file is < 2 h old, add --force to override)
//   node fetch-data.mjs --auto     (what update.bat runs: the full fetch if the main data is missing or
//                                   older than AUTO_FULL_DAYS, otherwise only the satellites)
//
// Node.js 18+ (built-in fetch), no dependencies. Writes ./data/:
//   asteroids.json        brightest numbered asteroids (+ named bodies with physical data)
//   neos.json             near-Earth objects (Atira/Aten/Apollo/Amor, PHA flag)
//   kuiper.json           every trans-Neptunian object and Centaur (numbered + unnumbered)
//   comets.json           numbered periodic comets + notable comets + all comets with perihelion
//                         within the next 5 years
//   interstellar.json     every "nI" object in the JPL SBDB (1I, 2I, 3I, … discovered automatically)
//   dwarfs.json           dwarf planets and large TNOs (with physical parameters)
//   close_approaches.json Earth close approaches (JPL CAD API)
//   satellites.json       Earth satellites: CelesTrak GP mean elements (OMM) for the groups in js/satcore.js
//   horizons_vectors/     JPL Horizons state vectors (index.json + one file per object)
//   manifest.json         download date, mode, object counts, sources
//
// Sources: JPL SBDB Query API, SBDB API, SBDB Close-Approach Data API, JPL Horizons API, CelesTrak GP API.
// Requests are sequential with a short delay; failures retry with exponential backoff.
// Re-run any time to pick up newly discovered objects.
// =============================================================================
import { mkdir, writeFile, rename, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SAT_GROUPS, SAT_COLUMNS, buildSatTable } from './js/satcore.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
// --out <dir> writes somewhere else (e.g. when Windows "Controlled folder access" blocks node in Documents).
const outIdx = process.argv.indexOf('--out');
const DATA = outIdx > 0 && process.argv[outIdx + 1] ? resolve(process.argv[outIdx + 1]) : join(ROOT, 'data');
const VEC = join(DATA, 'horizons_vectors');
const QUICK = process.argv.includes('--quick');
const SAT_ONLY = process.argv.includes('--satellites');
const FORCE = process.argv.includes('--force');
const AUTO = process.argv.includes('--auto');
const AUTO_FULL_DAYS = 30;
const MODE = QUICK ? 'quick' : 'full';
const DELAY_MS = 350;
const UA = 'SolSimulator-fetch-data/1.0 (educational; node)';

const SBDB_QUERY = 'https://ssd-api.jpl.nasa.gov/sbdb_query.api';
const SBDB = 'https://ssd-api.jpl.nasa.gov/sbdb.api';
const CAD = 'https://ssd-api.jpl.nasa.gov/cad.api';
const HORIZONS = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const CELESTRAK = 'https://celestrak.org/NORAD/elements/gp.php';

const LIMITS = QUICK
  ? { asteroids: 2000, neos: 1000, cadDist: 0.02, cadFrom: '2000-01-01', cadTo: '2050-12-31', spacecraft: ['voyager1', 'newhorizons', 'jwst'] }
  : { asteroids: 50000, neos: Infinity, cadDist: 0.05, cadFrom: '1900-01-01', cadTo: '2100-12-31', spacecraft: null };

// ---------------------------------------------------------------------------------------------
// HTTP with retry/backoff, sequential pacing, progress
// ---------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0, bytes = 0;
async function get(url, { json = true, allowNotFound = false } = {}) {
  const waits = [2000, 5000, 12000, 30000];
  for (let attempt = 0; ; attempt++) {
    await sleep(DELAY_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      const text = await res.text();
      requests++; bytes += text.length;
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      // 300 = "matched more than one object", 404 = not found: the caller decides.
      if (!res.ok && !(allowNotFound && (res.status === 404 || res.status === 300))) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      return json ? JSON.parse(text) : text;
    } catch (e) {
      if (attempt >= waits.length) throw new Error(`giving up on ${url.slice(0, 120)}… — ${e.message}`);
      log(`   ! ${e.message} — retrying in ${waits[attempt] / 1000}s`);
      await sleep(waits[attempt]);
    }
  }
}
const t0 = Date.now();
function log(msg) { console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(4)}s] ${msg}`); }
function qs(params) { return new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))).toString(); }
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const round = (v, sig = 10) => (v === null || !isFinite(v) ? null : Number(v.toPrecision(sig)));
const clean = (s) => (s || '').trim().replace(/\s+/g, ' ');

/**
 * Atomic write: temp file + rename, so a browser reading ./data/ never sees a half-written file.
 * Retries transient Windows errors (antivirus/indexer locks: EBUSY, EPERM, EBADF, EACCES).
 */
async function writeJSON(path, obj) {
  const text = JSON.stringify(obj);
  const tmp = `${path}.tmp-${process.pid}`;
  for (let attempt = 0; ; attempt++) {
    try {
      await writeFile(tmp, text);
      await rename(tmp, path);
      return text.length;
    } catch (e) {
      if (attempt >= 5 || !['EBUSY', 'EPERM', 'EBADF', 'EACCES'].includes(e.code)) throw e;
      log(`   ! ${e.code} writing ${path} — retrying`);
      await sleep(500 * (attempt + 1));
    }
  }
}

// ---------------------------------------------------------------------------------------------
// SBDB Query API — paged columnar downloads
// ---------------------------------------------------------------------------------------------
async function sbdbQuery(params, max, label) {
  const page = 10000;
  let rows = [], fields = null, total = null;
  for (let from = 0; from < max; from += page) {
    const limit = Math.min(page, max - from);
    const j = await get(`${SBDB_QUERY}?${qs({ ...params, 'full-prec': 1, limit, 'limit-from': from || undefined })}`);
    fields = j.fields; total = j.count;
    rows = rows.concat(j.data || []);
    log(`   ${label}: ${rows.length.toLocaleString()} / ${Math.min(max, total).toLocaleString()}`);
    if (!j.data || j.data.length < limit || rows.length >= total) break;
  }
  return { fields, rows, total };
}

const AST_FIELDS = 'spkid,full_name,pdes,name,a,e,i,om,w,ma,epoch,H,G,class,neo,pha,diameter,albedo';
/** Elliptic asteroid row: [name, pdes, a, e, i, om, w, ma, epoch, H, G, class, flags(1=NEO,2=PHA), diameter_km] */
function asteroidRow(f, r) {
  const g = (k) => r[f.indexOf(k)];
  const flags = (g('neo') === 'Y' ? 1 : 0) | (g('pha') === 'Y' ? 2 : 0);
  return [clean(g('full_name')), g('pdes'), round(num(g('a'))), round(num(g('e'))), round(num(g('i'))), round(num(g('om'))),
    round(num(g('w'))), round(num(g('ma'))), num(g('epoch')), round(num(g('H')), 4), round(num(g('G')), 3), g('class'), flags, round(num(g('diameter')), 5)];
}
const AST_COLUMNS = ['name', 'pdes', 'a', 'e', 'i', 'om', 'w', 'ma', 'epoch', 'H', 'G', 'class', 'flags', 'diameter'];

const COM_FIELDS = 'spkid,full_name,pdes,prefix,q,e,i,om,w,tp,epoch,a,M1,K1,class';
/** Comet row (any conic): [name, pdes, q, e, i, om, w, tp, epoch, M1, K1, class] */
function cometRow(f, r) {
  const g = (k) => r[f.indexOf(k)];
  return [clean(g('full_name')), g('pdes'), round(num(g('q'))), round(num(g('e'))), round(num(g('i'))), round(num(g('om'))),
    round(num(g('w'))), round(num(g('tp')), 12), num(g('epoch')), round(num(g('M1')), 3), round(num(g('K1')), 3), g('class')];
}
const COM_COLUMNS = ['name', 'pdes', 'q', 'e', 'i', 'om', 'w', 'tp', 'epoch', 'M1', 'K1', 'class'];

// ---------------------------------------------------------------------------------------------
// SBDB single-object API (named bodies, dwarfs, interstellar)
// ---------------------------------------------------------------------------------------------
async function sbdbObject(sstr, depth = 0) {
  let j;
  try { j = await get(`${SBDB}?${qs({ sstr, 'phys-par': 1, 'full-prec': 1 })}`, { allowNotFound: true }); }
  catch (e) { log(`     ! ${sstr}: ${e.message}`); return null; }
  // Ambiguous (e.g. a comet that split into fragments): take the first match.
  if (j && Array.isArray(j.list) && j.list.length && depth === 0) return sbdbObject(j.list[0].pdes, 1);
  if (!j || !j.orbit) return null;
  const el = Object.fromEntries(j.orbit.elements.map((e) => [e.name, num(e.value)]));
  const phys = Object.fromEntries((j.phys_par || []).map((p) => [p.name, num(p.value) ?? p.value]));
  return {
    name: clean(j.object.fullname), pdes: j.object.des, kind: j.object.kind, prefix: j.object.prefix || null,
    class: j.object.orbit_class?.code || null, neo: !!j.object.neo, pha: !!j.object.pha,
    epoch: num(j.orbit.epoch), a: el.a, e: el.e, q: el.q, i: el.i, om: el.om, w: el.w, ma: el.ma, tp: el.tp,
    H: phys.H ?? null, G: phys.G ?? null, M1: phys.M1 ?? null, K1: phys.K1 ?? null,
    diameter: phys.diameter ?? null, albedo: phys.albedo ?? null, rot_per: phys.rot_per ?? null, GM: phys.GM ?? null,
    extent: phys.extent ?? null,
  };
}

// ---------------------------------------------------------------------------------------------
// Horizons vectors (with automatic clamping to the ephemeris' available span)
// ---------------------------------------------------------------------------------------------
const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function parseHorizonsDate(s) {   // "A.D. 1977-SEP-05 14:10:00.0000"
  const m = /(\d{4})-([A-Z]{3})-(\d{2})(?:\s+(\d{2}):(\d{2}))?/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], MONTHS[m[2]] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)));
}
const iso = (d) => d.toISOString().slice(0, 16).replace('T', ' ');
const stepDays = (step) => { const m = /^(\d+(?:\.\d+)?)\s*([dhm])/.exec(step); return +m[1] * ({ d: 1, h: 1 / 24, m: 1 / 1440 })[m[2]]; };

async function horizonsVectors(command, center, start, stop, step) {
  let s = new Date(start), e = new Date(stop);
  const rows = [];
  const maxRows = 20000;
  const sd = stepDays(step);
  for (let attempt = 0; attempt < 4; attempt++) {
    rows.length = 0;
    let failed = false;
    // Chunk the span so no single request exceeds ~20,000 rows.
    for (let cs = new Date(s); cs < e;) {
      const ce = new Date(Math.min(e.getTime(), cs.getTime() + maxRows * sd * 864e5));
      const text = await get(`${HORIZONS}?${qs({ format: 'text', COMMAND: `'${command}'`, OBJ_DATA: "'NO'", MAKE_EPHEM: "'YES'", EPHEM_TYPE: "'VECTORS'",
        CENTER: `'500@${center}'`, REF_PLANE: "'ECLIPTIC'", REF_SYSTEM: "'J2000'", VEC_TABLE: "'2'", OUT_UNITS: "'KM-S'", CSV_FORMAT: "'YES'",
        VEC_LABELS: "'NO'", START_TIME: `'${iso(cs)}'`, STOP_TIME: `'${iso(ce)}'`, STEP_SIZE: `'${step}'` })}`, { json: false });
      if (!text.includes('$$SOE')) {
        // Clamp to the available span if Horizons tells us where it is, then retry the whole range.
        const prior = /prior to (A\.D\. [^\n]+)/.exec(text), after = /after (A\.D\. [^\n]+)/.exec(text);
        if (prior) { const d = parseHorizonsDate(prior[1]); if (d) { s = new Date(d.getTime() + 864e5); failed = true; break; } }
        if (after) { const d = parseHorizonsDate(after[1]); if (d) { e = new Date(d.getTime() - 864e5); failed = true; break; } }
        throw new Error(`Horizons: ${text.split('\n').filter((l) => l.trim()).slice(-3).join(' | ').slice(0, 300)}`);
      }
      for (const line of text.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n')) {
        const c = line.split(',').map((x) => x.trim());
        rows.push([+c[0], ...[2, 3, 4].map((k) => round(+c[k], 11)), ...[5, 6, 7].map((k) => round(+c[k], 9))]);
      }
      cs = new Date(ce.getTime() + sd * 864e5);
    }
    if (!failed) break;
    log(`     span clamped to ${iso(s)} → ${iso(e)}`);
  }
  // De-duplicate (chunk boundaries) and sort.
  const seen = new Set();
  return rows.filter((r) => (seen.has(r[0]) ? false : seen.add(r[0]))).sort((a, b) => a[0] - b[0]);
}

// Objects with high-precision Horizons trajectories. Segments: [start, stop, step, center].
// center: 10 = Sun, 399 = Earth, 599 = Jupiter. Vectors are geometric, ecliptic J2000, TDB, km & km/s.
const now = new Date();
const plusDays = (d) => new Date(now.getTime() + d * 864e5).toISOString().slice(0, 10);
const TRACKS = {
  apophis: { name: '99942 Apophis', command: '99942;', kind: 'asteroid', pdes: '99942', segments: [
    // Contiguous segments (shared boundary dates, no gaps).
    // Geocentric 10-min window ±30 days around the 2029-04-13 flyby: the switch to heliocentric happens
    // ~30 M km out, where the simulated-Earth offset is negligible. The 6 h heliocentric segment overlaps the
    // whole window (the finest segment wins inside it) so the browser can cross-fade over the last day.
    ['2004-06-20', '2029-01-01', '1d', 10], ['2029-01-01', '2029-08-01', '6h', 10], ['2029-03-14', '2029-05-13', '10m', 399],
    ['2029-08-01', '2050-12-31', '1d', 10]] },
  halley: { name: '1P/Halley (1986 apparition)', command: 'DES=1P; CAP<1994;', kind: 'comet', pdes: '1P', segments: [['1984-01-01', '1988-12-31', '1d', 10]] },
  // Current SBDB elements for Hale-Bopp are fitted near 2022; two-body propagation back to 1997 misses
  // planetary perturbations (q off by 0.02 AU), so the 1997 apparition comes from Horizons.
  halebopp: { name: 'C/1995 O1 (Hale-Bopp, 1997 apparition)', command: 'DES=C/1995 O1; CAP<2000;', kind: 'comet', pdes: '1995 O1', segments: [['1995-07-01', '1999-12-31', '1d', 10]] },
  voyager1: { name: 'Voyager 1', command: '-31', kind: 'spacecraft', segments: [['1977-09-06', '2030-12-31', '5d', 10]] },
  voyager2: { name: 'Voyager 2', command: '-32', kind: 'spacecraft', segments: [['1977-08-21', '2030-12-31', '5d', 10]] },
  pioneer10: { name: 'Pioneer 10', command: '-23', kind: 'spacecraft', segments: [['1972-03-04', '2030-12-31', '10d', 10]] },
  pioneer11: { name: 'Pioneer 11', command: '-24', kind: 'spacecraft', segments: [['1973-04-07', '2030-12-31', '10d', 10]] },
  newhorizons: { name: 'New Horizons', command: '-98', kind: 'spacecraft', segments: [['2006-01-20', '2030-12-31', '2d', 10]] },
  parker: { name: 'Parker Solar Probe', command: '-96', kind: 'spacecraft', segments: [['2018-08-13', '2030-12-31', '6h', 10]] },
  jwst: { name: 'James Webb Space Telescope', command: '-170', kind: 'spacecraft', segments: [['2021-12-26', '2030-12-31', '1d', 399]] },
  juno: { name: 'Juno', command: '-61', kind: 'spacecraft', segments: [['2011-08-06', '2016-06-30', '1d', 10], ['2016-07-05', '2030-12-31', '3h', 599]] },
  clipper: { name: 'Europa Clipper', command: '-159', kind: 'spacecraft', segments: [['2024-10-15', '2030-12-31', '1d', 10]] },
  // Eris' moon, relative to the Eris system barycenter (JPL tnosat ephemeris); P = 15.8 d, so 1-day Hermite ≈ km-level.
  dysnomia: { name: 'Dysnomia', command: '120136199', kind: 'moon', parent: '136199', segments: [['1990-01-01', '2050-12-31', '1d', 20136199]] },
  iss: { name: 'International Space Station', command: '-125544', kind: 'spacecraft', segments: [[plusDays(-1), plusDays(2), '2m', 399]] },
};

// Look up by number (a name like "Eris" can return a list of matches instead of an orbit).
const DWARFS = ['1', '136199', '136108', '136472', '225088', '50000', '90377', '90482'];   // Ceres, Eris, Haumea, Makemake, Gonggong, Quaoar, Sedna, Orcus
const NAMED = ['4', '2', '10', '16', '433', '101955', '162173', '25143', '65803', '99942', '3200'];   // Vesta … Didymos, Apophis, Phaethon
const NOTABLE_COMETS = ['1P', '2P', '55P', '67P', '109P', 'C/1995 O1', 'C/1996 B2', 'C/2006 P1', 'C/2020 F3', 'C/2023 A3', 'C/2013 A1', 'C/1965 S1'];

// ---------------------------------------------------------------------------------------------
async function main() {
  log(`Sol simulator data fetch — mode: ${MODE}${QUICK ? ' (small test dataset)' : ''}`);
  await mkdir(VEC, { recursive: true });
  const counts = {};
  const sizes = {};
  const jdNow = now.getTime() / 864e5 + 2440587.5;

  // 1. Asteroids: brightest numbered (sorted by H).
  log(`1/8 Asteroids — ${LIMITS.asteroids.toLocaleString()} brightest numbered (SBDB Query API)…`);
  const ast = await sbdbQuery({ fields: AST_FIELDS, 'sb-kind': 'a', 'sb-ns': 'n', sort: 'H' }, LIMITS.asteroids, 'asteroids');
  const astRows = ast.rows.map((r) => asteroidRow(ast.fields, r)).filter((r) => r[2] > 0 && r[3] < 1);
  log('   named bodies with physical data (SBDB API)…');
  const named = [];
  for (const n of NAMED) { const o = await sbdbObject(n); if (o) named.push(o); log(`     ${o ? o.name : n + ' (not found)'}`); }
  sizes.asteroids = await writeJSON(join(DATA, 'asteroids.json'), { columns: AST_COLUMNS, rows: astRows, named, source: 'JPL SBDB', mode: MODE });
  counts.asteroids = astRows.length;

  // 2. NEOs (full list; PHA flag; orbit class Atira/Aten/Apollo/Amor).
  log('2/8 Near-Earth objects (SBDB Query API, sb-group=neo)…');
  const neo = await sbdbQuery({ fields: AST_FIELDS, 'sb-kind': 'a', 'sb-group': 'neo', sort: 'H' }, LIMITS.neos, 'NEOs');
  const neoRows = neo.rows.map((r) => asteroidRow(neo.fields, r)).filter((r) => r[2] > 0 && r[3] < 1);
  sizes.neos = await writeJSON(join(DATA, 'neos.json'), { columns: AST_COLUMNS, rows: neoRows, total: neo.total, source: 'JPL SBDB' });
  counts.neos = neoRows.length;
  counts.phas = neoRows.filter((r) => r[12] & 2).length;

  // 2b. Kuiper belt & Centaurs: every TNO and Centaur (numbered and unnumbered).
  log('2b/8 Trans-Neptunian objects and Centaurs (SBDB Query API, sb-class=TNO,CEN)…');
  const kb = await sbdbQuery({ fields: AST_FIELDS, 'sb-kind': 'a', 'sb-class': 'TNO,CEN', sort: 'H' }, QUICK ? 1000 : Infinity, 'TNOs + Centaurs');
  const kbRows = kb.rows.map((r) => asteroidRow(kb.fields, r)).filter((r) => r[2] > 0 && r[3] < 1);
  sizes.kuiper = await writeJSON(join(DATA, 'kuiper.json'), { columns: AST_COLUMNS, rows: kbRows, total: kb.total, source: 'JPL SBDB' });
  counts.kuiper = kbRows.length;

  // 3. Comets: numbered periodic + perihelion within the next 5 years + notable ones.
  log('3/8 Comets…');
  const cNum = await sbdbQuery({ fields: COM_FIELDS, 'sb-kind': 'c', 'sb-ns': 'n' }, 5000, 'numbered periodic comets');
  const upcoming = await sbdbQuery({ fields: COM_FIELDS, 'sb-kind': 'c', 'sb-cdata': JSON.stringify({ AND: [`tp|RG|${jdNow.toFixed(1)}|${(jdNow + 5 * 365.25).toFixed(1)}`] }) }, 5000, 'comets reaching perihelion within 5 years');
  const byDes = new Map();
  for (const r of cNum.rows) byDes.set(r[cNum.fields.indexOf('pdes')], cometRow(cNum.fields, r));
  for (const r of upcoming.rows) byDes.set(r[upcoming.fields.indexOf('pdes')], cometRow(upcoming.fields, r));
  const notable = [];
  for (const d of NOTABLE_COMETS) {
    const o = await sbdbObject(d);
    if (!o) { log(`     ${d} (not found)`); continue; }
    byDes.set(o.pdes, [o.name, o.pdes, round(o.q), round(o.e), round(o.i), round(o.om), round(o.w), round(o.tp, 12), o.epoch, o.M1, o.K1, o.class]);
    notable.push(o.pdes);
    log(`     ${o.name}`);
  }
  const cometRows = [...byDes.values()].filter((r) => r[2] > 0 && r[3] >= 0 && isFinite(r[7]));
  sizes.comets = await writeJSON(join(DATA, 'comets.json'), { columns: COM_COLUMNS, rows: cometRows, notable, source: 'JPL SBDB' });
  counts.comets = cometRows.length;

  // 4. Interstellar objects: 1I, 2I, 3I, … until two consecutive designations are missing.
  log('4/8 Interstellar objects (SBDB API, "nI" designations)…');
  const inter = [];
  for (let n = 1, misses = 0; misses < 2 && n < 100; n++) {
    const o = await sbdbObject(`${n}I`);
    if (!o) { misses++; continue; }
    misses = 0;
    inter.push(o);
    log(`     ${o.name}  e=${o.e?.toFixed(4)} q=${o.q?.toFixed(3)} AU`);
  }
  sizes.interstellar = await writeJSON(join(DATA, 'interstellar.json'), { objects: inter, source: 'JPL SBDB' });
  counts.interstellar = inter.length;

  // 5. Dwarf planets / large TNOs.
  log('5/8 Dwarf planets…');
  const dwarfs = [];
  for (const n of DWARFS) { const o = await sbdbObject(n); if (o) { dwarfs.push(o); log(`     ${o.name}`); } }
  sizes.dwarfs = await writeJSON(join(DATA, 'dwarfs.json'), { objects: dwarfs, source: 'JPL SBDB' });
  counts.dwarfs = dwarfs.length;

  // 6. Close approaches to Earth.
  log(`6/8 Earth close approaches ${LIMITS.cadFrom} … ${LIMITS.cadTo}, < ${LIMITS.cadDist} AU (CAD API)…`);
  const cad = await get(`${CAD}?${qs({ 'date-min': LIMITS.cadFrom, 'date-max': LIMITS.cadTo, 'dist-max': LIMITS.cadDist, fullname: 'true', sort: 'date' })}`);
  const cf = cad.fields || [];
  const cadRows = (cad.data || []).map((r) => {
    const g = (k) => r[cf.indexOf(k)];
    return [g('des'), round(num(g('jd')), 12), round(num(g('dist')), 7), round(num(g('dist_min')), 7), round(num(g('v_rel')), 5), round(num(g('h')), 4), clean(g('fullname'))];
  });
  sizes.close_approaches = await writeJSON(join(DATA, 'close_approaches.json'), { columns: ['des', 'jd', 'dist_au', 'dist_min_au', 'v_rel_kms', 'H', 'name'], rows: cadRows, dist_max_au: LIMITS.cadDist, source: 'JPL CAD API' });
  counts.close_approaches = cadRows.length;
  log(`   ${cadRows.length.toLocaleString()} close approaches`);

  // 7. Horizons state vectors.
  log('7/8 JPL Horizons state vectors…');
  const index = [];
  const wanted = Object.entries(TRACKS).filter(([id, t]) => t.kind !== 'spacecraft' || !LIMITS.spacecraft || LIMITS.spacecraft.includes(id));
  let vecBytes = 0;
  for (const [id, t] of wanted) {
    log(`   ${t.name}`);
    const segments = [];
    for (const [start, stop, step, center] of t.segments) {
      try {
        const rows = await horizonsVectors(t.command, center, start, stop, step);
        if (rows.length) segments.push({ center, step, start: rows[0][0], stop: rows[rows.length - 1][0], rows });
        log(`     ${start} → ${stop} @ ${step}, center ${center}: ${rows.length.toLocaleString()} states`);
      } catch (e) { log(`     ! segment ${start} → ${stop} skipped: ${e.message}`); }
    }
    if (!segments.length) continue;
    vecBytes += await writeJSON(join(VEC, `${id}.json`), { id, name: t.name, kind: t.kind, pdes: t.pdes || null, parent: t.parent || null, units: 'km, km/s, JD TDB, ecliptic J2000', segments });
    index.push({ id, name: t.name, kind: t.kind, pdes: t.pdes || null, parent: t.parent || null, start: segments[0].start, stop: segments[segments.length - 1].stop, file: `${id}.json` });
  }
  await writeJSON(join(VEC, 'index.json'), { tracks: index });
  sizes.horizons_vectors = vecBytes;
  counts.horizons_tracks = index.length;

  // 8. Earth satellites.
  // A CelesTrak outage or block must not lose the JPL data downloaded above (the manifest is written last).
  let sat = null;
  try { sat = await fetchSatellites(); }
  catch (e) { log(`   ! satellites skipped: ${e.message} — try again later with: node fetch-data.mjs --satellites`); }
  if (sat) { counts.satellites = sat.count; sizes.satellites = sat.bytes; }

  const manifest = {
    generated: now.toISOString(), date: now.toISOString().slice(0, 10), mode: MODE, counts,
    bytes: sizes, requests,
    sources: {
      sbdb_query: SBDB_QUERY, sbdb: SBDB, cad: CAD, horizons: HORIZONS, celestrak: CELESTRAK,
      note: 'Osculating elements at each object\'s epoch (two-body propagation in the browser). Horizons vectors: geometric, ecliptic J2000, TDB.',
    },
  };
  if (sat) manifest.satellites = { generated: sat.generated, count: sat.count };
  await writeJSON(join(DATA, 'manifest.json'), manifest);
  const total = Object.values(sizes).reduce((s, v) => s + v, 0);
  log(`Done: ${requests} requests, ${(total / 1e6).toFixed(1)} MB written to ${DATA}`);
  for (const [k, v] of Object.entries(counts)) log(`   ${k.padEnd(18)} ${v.toLocaleString()}`);
}

// ---------------------------------------------------------------------------------------------
// 8. Earth satellites — CelesTrak GP data (OMM JSON; the TLE format can't hold catalog numbers
//    above 99999, which new objects have had since July 2026). CelesTrak refreshes about every
//    2 hours and blocks clients that download more often, so a newer file than that is kept.
//    SAT_SOURCE_DIR=<dir> reads <dir>/<group>.json instead of downloading (offline testing).
// ---------------------------------------------------------------------------------------------
async function fetchSatellites() {
  const file = join(DATA, 'satellites.json');
  log('8/8 Earth satellites (CelesTrak GP data, OMM)…');
  try {
    const prev = JSON.parse(await readFile(file, 'utf8'));
    const ageH = (Date.now() - Date.parse(prev.generated)) / 36e5;
    if (ageH < 2 && !FORCE && !process.env.SAT_SOURCE_DIR) {
      log(`   satellites.json is only ${(ageH * 60).toFixed(0)} min old — kept (CelesTrak updates every ~2 h; --force to download anyway)`);
      return { generated: prev.generated, count: prev.rows.length, bytes: 0 };
    }
  } catch { /* no previous file */ }
  const byGroup = {};
  for (const g of SAT_GROUPS) {
    let list;
    if (process.env.SAT_SOURCE_DIR) list = JSON.parse(await readFile(join(process.env.SAT_SOURCE_DIR, `${g.celestrak}.json`), 'utf8'));
    else {
      // An empty reply (HTTP 200, no body) was seen once in testing: get() retries a body that isn't
      // JSON; an empty list is retried here.
      for (let attempt = 0; attempt < 3; attempt++) {
        list = await get(`${CELESTRAK}?${qs({ GROUP: g.celestrak, FORMAT: 'json' })}`);
        if (Array.isArray(list) && list.length) break;
        await sleep(3000);
      }
    }
    if (!Array.isArray(list) || !list.length) throw new Error(`CelesTrak returned no data for group "${g.celestrak}"`);
    byGroup[g.key] = list;
    log(`   ${g.name.padEnd(22)} ${list.length}`);
  }
  const rows = buildSatTable(byGroup);
  const generated = new Date().toISOString();
  const epochs = rows.map((r) => Date.parse(r[3] + 'Z')).sort((a, b) => a - b);
  const range = [new Date(epochs[0]).toISOString(), new Date(epochs[epochs.length - 1]).toISOString()];
  const bytes = await writeJSON(file, { generated, source: 'CelesTrak GP data (https://celestrak.org), U.S. Space Force catalog',
    format: 'OMM mean elements for SGP4/SDP4', groups: SAT_GROUPS.map(({ key, name, celestrak, color }) => ({ key, name, celestrak, color })),
    columns: SAT_COLUMNS, rows, epochRange: range });
  log(`   ${rows.length} satellites (unique), element epochs ${range[0].slice(0, 10)} … ${range[1].slice(0, 10)}`);
  return { generated, count: rows.length, bytes };
}

/** --satellites: refresh only satellites.json and patch the manifest. */
async function satellitesOnly() {
  log('Sol simulator data fetch — satellites only');
  await mkdir(DATA, { recursive: true });
  const sat = await fetchSatellites();
  try {
    const m = JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8'));
    m.counts.satellites = sat.count;
    if (sat.bytes) m.bytes.satellites = sat.bytes;
    m.satellites = { generated: sat.generated, count: sat.count };
    m.sources.celestrak = CELESTRAK;
    await writeJSON(join(DATA, 'manifest.json'), m);
  } catch { log('   (no manifest.json yet — run the full fetch once so the simulator finds the data folder)'); }
  log(`Done: ${requests} requests.`);
}

/** --auto: full refresh when the main data is missing or old, otherwise just the satellites. */
async function auto() {
  let age = Infinity;
  try { age = (Date.now() - Date.parse(JSON.parse(await readFile(join(DATA, 'manifest.json'), 'utf8')).generated)) / 864e5; } catch { /* no data yet */ }
  if (age > AUTO_FULL_DAYS) {
    log(age === Infinity ? 'No data yet — full download.' : `Main data is ${age.toFixed(0)} days old (> ${AUTO_FULL_DAYS}) — full download.`);
    return main();
  }
  log(`Main data is ${age.toFixed(0)} days old (full refresh after ${AUTO_FULL_DAYS} days) — updating the satellites only.`);
  return satellitesOnly();
}

(AUTO ? auto() : SAT_ONLY ? satellitesOnly() : main()).catch((e) => {
  console.error(`\nfetch-data failed: ${e.message}`);
  if (['ENOENT', 'EBADF', 'EPERM', 'EACCES'].includes(e.code) && process.platform === 'win32') {
    console.error(`
Windows refused to let Node.js write to ${DATA}.
This is usually Windows Security "Controlled folder access" (ransomware protection), which blocks
unrecognised programs from writing inside Documents. Either:
  • Windows Security → Virus & threat protection → Ransomware protection → "Allow an app through
    Controlled folder access" → add node.exe (e.g. C:\\Program Files\\nodejs\\node.exe), then re-run; or
  • write the data outside Documents and let the included server serve it from there.
    PowerShell:
      node fetch-data.mjs --out "$env:LOCALAPPDATA\\sol-data"
      node tools/serve.mjs 8130 --data "$env:LOCALAPPDATA\\sol-data"
    Command Prompt: use "%LOCALAPPDATA%\\sol-data" instead.`);
  }
  process.exit(1);
});
