import { RUNS_B64, STATE_GRID } from './zipGrid.data';
import { maidenhead } from './maidenhead';
/** ZIP → approximate 4-char Maidenhead grid from the bundled Census ZCTA table (see zipGrid.data.ts for source/encoding). */
let table: { zip: Int32Array; x: Int16Array; y: Int16Array } | null = null;
function b64ToBytes(s: string): Uint8Array {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'; const map = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) map[A.charCodeAt(i)] = i;
  const clean = s.replace(/=+$/, ''); const out = new Uint8Array(Math.floor(clean.length * 3 / 4)); let o = 0, buf = 0, bits = 0;
  for (let i = 0; i < clean.length; i++) { buf = (buf << 6) | map[clean.charCodeAt(i)]; bits += 6; if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; } }
  return out.subarray(0, o);
}
function load() {
  if (table) return table; const b = b64ToBytes(RUNS_B64); let i = 0;
  const v = () => { let n = 0, sh = 0, c; do { c = b[i++]; n |= (c & 0x7f) << sh; sh += 7; } while (c & 0x80); return n; };
  const uz = (n: number) => (n & 1 ? -(n + 1) / 2 : n / 2);
  const zs: number[] = [], xs: number[] = [], ys: number[] = []; let z = 0, x = 0, y = 0;
  while (i < b.length) { z += v(); x += uz(v()); y += uz(v()); zs.push(z); xs.push(x); ys.push(y); }
  return (table = { zip: Int32Array.from(zs), x: Int16Array.from(xs), y: Int16Array.from(ys) });
}
const sq = (x: number, y: number) => maidenhead(y - 90 + 0.5, x * 2 - 180 + 1);
export function gridForZip(zip: string | null | undefined): string | null {
  const z = parseInt((zip ?? '').slice(0, 5), 10); if (!(z > 0)) return null; const t = load();
  let lo = 0, hi = t.zip.length - 1; if (z < t.zip[0]) return null;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (t.zip[m] <= z) lo = m; else hi = m - 1; }
  return sq(t.x[lo], t.y[lo]);
}
/** ZIP centroid grid, falling back to the state's most common licensee grid. */
export function gridForLicense(zip: string | null | undefined, state: string | null | undefined): { grid: string; source: 'zip' | 'state' } | null {
  const g = gridForZip(zip); if (g) return { grid: g, source: 'zip' };
  const s = state ? STATE_GRID[state.toUpperCase()] : undefined; return s ? { grid: s, source: 'state' } : null;
}
export const zipTableRuns = () => load().zip.length;
