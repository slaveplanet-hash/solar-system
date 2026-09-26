// =============================================================================
// datastore.js — Loads the /data/ files written by fetch-data.mjs.
// Works in the browser (fetch) and in Node (pass a reader). If /data/ is missing
// the simulator still runs with planets and moons only.
// =============================================================================
import { HorizonsTrack } from './tracks.js';

export const DATA_FILES = ['asteroids', 'neos', 'kuiper', 'comets', 'interstellar', 'dwarfs', 'close_approaches'];
export const STALE_DAYS = 183;   // warn when the download is older than ~6 months

async function browserReader(path) {
  const r = await fetch(path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

export class DataStore {
  constructor(base = './data/', reader = browserReader) {
    this.base = base;
    this.read = reader;
    this.available = false;
    this.manifest = null;
    this.files = {};
    this.tracks = {};          // id → HorizonsTrack
    this.trackIndex = [];
    this.errors = [];
  }

  async load() {
    try { this.manifest = await this.read(this.base + 'manifest.json'); }
    catch { this.available = false; return this; }
    this.available = true;
    await Promise.all(DATA_FILES.map(async (f) => {
      try { this.files[f] = await this.read(`${this.base}${f}.json`); }
      catch (e) { this.errors.push(e.message); }
    }));
    try {
      const idx = await this.read(this.base + 'horizons_vectors/index.json');
      this.trackIndex = idx.tracks || [];
      await Promise.all(this.trackIndex.map(async (t) => {
        try { this.tracks[t.id] = new HorizonsTrack(await this.read(this.base + 'horizons_vectors/' + t.file)); }
        catch (e) { this.errors.push(e.message); }
      }));
    } catch (e) { this.errors.push(e.message); }
    return this;
  }

  get ageDays() { return this.manifest ? (Date.now() - Date.parse(this.manifest.generated)) / 864e5 : Infinity; }
  get stale() { return this.ageDays > STALE_DAYS; }

  /** Track for a small body designation (e.g. '99942'), if any. */
  trackFor(pdes) { return Object.values(this.tracks).find((t) => t.pdes === pdes) || null; }
}

/** Convert a columnar {columns, rows} table into objects (for small tables). */
export function tableObjects(t) {
  if (!t) return [];
  return t.rows.map((r) => Object.fromEntries(t.columns.map((c, i) => [c, r[i]])));
}
