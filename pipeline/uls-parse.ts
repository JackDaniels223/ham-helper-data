/**
 * Pure FCC ULS amateur parsing + safety rules shared by build.mts (and unit-tested in __tests__/pipeline.test.ts).
 *
 * Record layouts: FCC "Public Access Database Definitions" (ULS Data File Format), https://www.fcc.gov/wireless/data/public-access-files-database-downloads
 * (PDF: https://www.fcc.gov/sites/default/files/public_access_database_definitions_v2.pdf; 2026-03-19 revision only renamed AM pos 4
 * EBF Number → VEC Name, https://www.fcc.gov/wireless/data/public-access-updates). Positions are 1-based; f[] is 0-based.
 *   HD: 2 unique_system_identifier, 5 call_sign, 6 license_status, 8 grant_date, 9 expired_date
 *   EN: 2 USI, 5 call_sign, 6 entity_type (L = licensee), 8 entity_name, 16 street (NEVER read), 17 city, 18 state, 19 zip_code
 *   AM: 2 USI, 5 call_sign, 6 operator_class (T G A E N P; blank for club/military/RACES stations)
 * Joins are on unique_system_identifier; an EN/AM row whose call_sign disagrees with its HD row is ignored and counted.
 */
import { type Rec } from './lib';
export const OPERATOR_CLASSES = { T: 'Technician', G: 'General', A: 'Advanced', E: 'Extra', N: 'Novice', P: 'Technician Plus' } as const;
export type Raw = { call: string; status: string; grant: number; expire: number; name?: string; city?: string; state?: string; zip?: string; cls?: string; enType?: string };
export const toDays = (s: string) => { if (!s) return 0; const [m, d, y] = s.split('/').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
export class UlsAccumulator {
  readonly m = new Map<number, Raw>(); readonly issues = { enCallMismatch: 0, amCallMismatch: 0, badClass: 0, enOrphan: 0, amOrphan: 0 };
  hd(f: string[]) { this.m.set(+f[1], { call: (f[4] ?? '').trim().toUpperCase(), status: f[5], grant: toDays(f[7]), expire: toDays(f[8]) }); }
  en(f: string[]) {
    const r = this.m.get(+f[1]); if (!r) { this.issues.enOrphan++; return; }
    const c = (f[4] ?? '').trim().toUpperCase(); if (c && c !== r.call) { this.issues.enCallMismatch++; return; }
    if (r.name && r.enType === 'L' && f[5] !== 'L') return; // the licensee (L) row wins over contact/other entity rows
    r.enType = f[5]; r.name = decodeEntities(f[7]).trim(); r.city = sanitizeCity(f[16]); r.state = (f[17] || '').toUpperCase(); r.zip = (f[18] || '').slice(0, 5); // f[15] street: never copied
  }
  am(f: string[]) {
    const r = this.m.get(+f[1]); if (!r) { this.issues.amOrphan++; return; }
    const c = (f[4] ?? '').trim().toUpperCase(); if (c && c !== r.call) { this.issues.amCallMismatch++; return; }
    const k = (f[5] ?? '').trim().toUpperCase(); if (k && !(k in OPERATOR_CLASSES)) { this.issues.badClass++; r.cls = ''; return; }
    r.cls = k;
  }
}
export const toRec = (r: Raw): Rec => ({ call: r.call, name: r.name ?? '', cls: r.cls ?? '', city: r.city ?? '', state: r.state ?? '', zip: r.zip ?? '', grant: r.grant, expire: r.expire });
/** Active rows, one per callsign (if two active licenses ever share a call, the latest grant wins). */
export function activeRecs(m: Map<number, Raw>, suppressed: (call: string) => boolean, dataDay = 0): Rec[] {
  const by = new Map<string, Raw>();
  for (const r of m.values()) { if (r.status !== 'A' || !r.call || suppressed(r.call) || beyondGrace(r, dataDay)) continue; const o = by.get(r.call); if (!o || r.grant > o.grant) by.set(r.call, r); }
  return [...by.values()].map(toRec);
}
export const sameRec = (a: Rec, b: Rec) => a.name === b.name && a.cls === b.cls && a.city === b.city && a.state === b.state && a.zip === b.zip && a.grant === b.grant && a.expire === b.expire;
export function classDistribution(rows: Rec[]): Record<string, number> {
  const d: Record<string, number> = {}; for (const r of rows) { const k = r.cls || '(blank)'; d[k] = (d[k] ?? 0) + 1; } return d;
}
/**
 * Removal requests: newline-separated callsigns from the Actions secret SUPPRESS_LIST (never committed or published,
 * hashed or plain). Lines starting with # are comments. Those calls are omitted from every file and deleted by the next delta.
 */
export function parseSuppress(text: string | undefined): (call: string) => boolean {
  const set = new Set<string>();
  for (const l of (text ?? '').split(/\r?\n/)) { const c = l.trim().toUpperCase(); if (!c || c.startsWith('#')) continue; if (!/^[A-Z0-9]{3,7}$/.test(c)) throw new Error('SUPPRESS_LIST: an entry is not a callsign (value not shown)'); set.add(c); }
  return call => set.has(call);
}

/* ---------- city sanitising (QA: street addresses / suites / ZIPs had been typed into EN city) ---------- */
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
export const decodeEntities = (s: string) => (s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
/** Anything that must never be published as a city: digits, '#', ';', '&', '@', unit/suite/PMB/PO-box words. */
export function addressLike(city: string): boolean {
  const c = city.trim(); if (!c) return false;
  if (c.toUpperCase() === '29 PALMS') return false; // a real city name (Twentynine Palms, CA)
  return /[0-9#;&@]/.test(c) || /^(apt|apartment|suite|unit|pmb|bldg|trlr|spc)\b\.?/i.test(c) || /\b(p\.?\s?o\.?\s*box|pmb|suite|apt)\b/i.test(c);
}
/** City name only. Salvages "City, ST 12345" / "City 12345" to "City"; blanks anything else that looks like an address. */
export function sanitizeCity(raw: string): string {
  let c = decodeEntities(raw ?? '').replace(/\s+/g, ' ').trim();
  const m = /^([A-Za-z][A-Za-z .'-]*?)[\s,.]*(?:\b[A-Za-z]{2}\b\.?|\b[A-Za-z]{3,5}\.)?[\s,.]*\d{4,5}(?:-\d{4})?[\s,.]*$/.exec(c);
  if (m && /[A-Za-z]{3}/.test(m[1])) c = m[1].replace(/[\s,.]+$/, '');
  return addressLike(c) ? '' : c;
}
/** Street-address shape in a free-text field ("123B Example Street", "12000 Example PL NW"). */
const STREET = /\b\d+[A-Z]?\s+(?:[NSEW]\.?\s+)?(?:[A-Za-z0-9]+\s+){0,3}(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|boulevard|hwy|highway|way|pl|place|cir|circle|cv|cove|ter|terrace|pkwy|parkway)\b\.?/i;
/** Hard guard: throws (failing the run) if any published row still carries an address-like value or a suppressed call. */
export function assertClean(rows: Rec[], suppressed: (c: string) => boolean): void {
  let bad = 0; const sample: string[] = [];
  for (const r of rows) {
    const why = addressLike(r.city) ? 'city' : STREET.test(r.city) ? 'city-street' : STREET.test(r.name) || /\b(p\.?\s?o\.?\s*box|pmb)\b/i.test(r.name) ? 'name' : /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(r.name + r.city) ? 'entity' : !/^(\d{5})?$/.test(r.zip) ? 'zip' : suppressed(r.call) ? 'suppressed' : null;
    if (why) { bad++; if (sample.length < 5) sample.push(`${why}:${r.call}`); }
  }
  if (bad) throw new Error(`PRIVACY GUARD: ${bad} record(s) failed (${sample.join(', ')}); nothing written`);
}
/** Version stamp = the FCC file's Last-Modified time, UTC, YYYYMMDDHHMM (QA: stamp with the data date, not the build date). */
export function stampOf(lastModified: string): string {
  const d = new Date(Date.parse(lastModified)); if (Number.isNaN(d.getTime())) throw new Error('bad Last-Modified');
  return d.toISOString().replace(/[-:T]/g, '').slice(0, 12);
}
export const GRACE_DAYS = 730; // 47 CFR §97.21(b): renewal possible up to 2 years after expiry
/** Beyond the 2-year grace period a license can no longer be renewed: excluded even if HD still says Active. */
export const beyondGrace = (r: { expire: number }, dataDay: number) => r.expire > 0 && dataDay > r.expire + GRACE_DAYS;

/* ---------- freshness (QA N-H1: never publish stale source data / never move records backwards) ---------- */
export type Sources = { full?: string; daily?: string; minVersion?: string }; // PUBLIC file: no purge state here (QA b4cbdf1 M3)
 // ISO Last-Modified of the last source file processed, per kind
export type Fresh = { ok: true } | { ok: false; reason: string };
/** A source file is accepted only if it is strictly newer than every source already processed (equal is allowed only with force). */
export function checkFresh(prev: Sources, kind: 'full' | 'daily', lastModified: string | undefined, force = false): Fresh {
  if (!lastModified || Number.isNaN(Date.parse(lastModified))) return { ok: false, reason: 'source Last-Modified missing or unparseable' };
  const t = Date.parse(lastModified); const newest = Math.max(...[prev.full, prev.daily].filter(Boolean).map(s => Date.parse(s!)), -Infinity);
  if (t > newest) return { ok: true };
  if (force && t === Date.parse(prev[kind] ?? '')) return { ok: true };
  return { ok: false, reason: `stale ${kind} source (${new Date(t).toISOString()} is not newer than ${new Date(newest).toISOString()})` };
}
/** Count sanity: refuse a full build whose active count moves more than maxPct vs the previous state. */
export function checkCount(prev: number | null, next: number, maxPct = 2): Fresh {
  if (!prev) return { ok: true }; const pct = Math.abs(next - prev) / prev * 100;
  return pct <= maxPct ? { ok: true } : { ok: false, reason: `active count changed ${pct.toFixed(2)}% (${prev} → ${next}); limit ${maxPct}%` };
}
/** Daily merge that never moves a record backwards: an older grant never overwrites a newer one. */
export function mergeDaily(cur: Map<string, Rec>, m: Map<number, Raw>, suppressed: (c: string) => boolean, dataDay = 0): { up: Rec[]; del: Set<string>; skippedOlder: number; purged: number } {
  // Suppressed calls are dropped from state but NEVER listed in a delta's DELETES (that would publish them in plain text,
  // QA re-verify row 3). The caller sets the PRIVATE purge flag (out/private/purge.json); the next weekly full build then breaks the delta chain so every
  // client re-downloads a full file that simply lacks them.
  const up = new Map<string, Rec>(); const del = new Set<string>(); let skippedOlder = 0; let purged = 0;
  for (const r of m.values()) {
    if (!r.call) continue;
    if (suppressed(r.call)) { if (cur.delete(r.call)) purged++; up.delete(r.call); del.delete(r.call); continue; }
    const old = cur.get(r.call);
    if (r.status === 'A') {
      if (old && old.grant > r.grant) { skippedOlder++; continue; }
      // fields missing from today's file (no EN/AM row for this USI) keep their previous values
      const rec = toRec({ ...r, name: r.name ?? old?.name, city: r.city ?? old?.city, state: r.state ?? old?.state, zip: r.zip ?? old?.zip, cls: r.cls ?? old?.cls });
      if (!old || !sameRec(old, rec)) { cur.set(r.call, rec); up.set(r.call, rec); del.delete(r.call); }
    } else if (old && old.grant <= r.grant) { cur.delete(r.call); up.delete(r.call); del.add(r.call); }
  }
  for (const [c, r] of cur) {
    if (suppressed(c)) { cur.delete(c); up.delete(c); del.delete(c); purged++; } // newly suppressed: silent, see above
    else if (beyondGrace(r, dataDay)) { cur.delete(c); up.delete(c); del.add(c); } // aged out of grace
  }
  return { up: [...up.values()], del, skippedOlder, purged };
}
