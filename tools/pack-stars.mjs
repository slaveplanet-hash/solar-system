// Packs the Yale Bright Star Catalogue (5th ed., VizieR V/50) into js/data/stars.js.
// Input:  tests/fixtures/raw/bsc5.tsv  (VizieR asu-tsv: _RAJ2000 _DEJ2000 Vmag B-V HR Name)
//   curl "https://vizier.cds.unistra.fr/viz-bin/asu-tsv?-source=V/50/catalog&-out=_RAJ2000,_DEJ2000,Vmag,B-V,HR,Name&-out.max=10000&-oc.form=d"
// Output: 6 bytes/star, base64 — RA u16 (0–360°), Dec u16 (−90…+90°), V u8 ((V+2)·25), B−V u8 ((B−V+0.5)·100).
import { readFileSync, writeFileSync } from 'node:fs';
const root = new URL('..', import.meta.url);
const lines = readFileSync(new URL('tests/fixtures/raw/bsc5.tsv', root), 'utf8').split('\n');
const stars = [];
for (const l of lines) {
  if (!l || l.startsWith('#') || !/^\d/.test(l)) continue;
  const c = l.split('\t');
  const ra = parseFloat(c[0]), de = parseFloat(c[1]), v = parseFloat(c[2]);
  let bv = parseFloat(c[3]);
  if (!isFinite(ra) || !isFinite(de) || !isFinite(v)) continue;
  if (!isFinite(bv)) bv = 0.6;
  stars.push([ra, de, v, bv]);
}
stars.sort((a, b) => a[2] - b[2]);   // brightest first
const buf = Buffer.alloc(stars.length * 6);
stars.forEach(([ra, de, v, bv], i) => {
  buf.writeUInt16LE(Math.round((ra / 360) * 65535) % 65536, i * 6);
  buf.writeUInt16LE(Math.round(((de + 90) / 180) * 65535), i * 6 + 2);
  buf.writeUInt8(Math.max(0, Math.min(255, Math.round((v + 2) * 25))), i * 6 + 4);
  buf.writeUInt8(Math.max(0, Math.min(255, Math.round((bv + 0.5) * 100))), i * 6 + 5);
});
const b64 = buf.toString('base64');
const out = `// Yale Bright Star Catalogue, 5th revised ed. (Hoffleit & Warren 1991), via CDS VizieR V/50.
// ${stars.length} stars (V ≤ ~6.5), sorted brightest first. Packed by tools/pack-stars.mjs.
// Layout per star (6 bytes, little-endian): RA u16 (0–360°), Dec u16 (−90…+90°), V u8 = (V+2)·25, (B−V) u8 = (B−V+0.5)·100.
export const STAR_COUNT = ${stars.length};
export const STARS_B64 = '${b64}';

/** Decode → { ra, dec, vmag, bv } Float32Arrays (degrees / magnitudes). */
export function decodeStars() {
  const bin = atob(STARS_B64);
  const n = STAR_COUNT;
  const ra = new Float32Array(n), dec = new Float32Array(n), vmag = new Float32Array(n), bv = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 6;
    ra[i] = ((bin.charCodeAt(o) | (bin.charCodeAt(o + 1) << 8)) / 65535) * 360;
    dec[i] = ((bin.charCodeAt(o + 2) | (bin.charCodeAt(o + 3) << 8)) / 65535) * 180 - 90;
    vmag[i] = bin.charCodeAt(o + 4) / 25 - 2;
    bv[i] = bin.charCodeAt(o + 5) / 100 - 0.5;
  }
  return { ra, dec, vmag, bv };
}
`;
writeFileSync(new URL('js/data/stars.js', root), out);
console.log(`packed ${stars.length} stars → js/data/stars.js (${(out.length / 1024).toFixed(1)} KB); brightest V=${stars[0][2]}`);
