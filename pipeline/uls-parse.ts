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
import { sha256Hex, SUPPRESS_SALT, type Rec } from './lib';
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
    r.enType = f[5]; r.name = f[7]; r.city = f[16]; r.state = (f[17] || '').toUpperCase(); r.zip = (f[18] || '').slice(0, 5); // f[15] street: never copied
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
export function activeRecs(m: Map<number, Raw>, suppressed: (call: string) => boolean): Rec[] {
  const by = new Map<string, Raw>();
  for (const r of m.values()) { if (r.status !== 'A' || !r.call || suppressed(r.call)) continue; const o = by.get(r.call); if (!o || r.grant > o.grant) by.set(r.call, r); }
  return [...by.values()].map(toRec);
}
export const sameRec = (a: Rec, b: Rec) => a.name === b.name && a.cls === b.cls && a.city === b.city && a.state === b.state && a.zip === b.zip && a.grant === b.grant && a.expire === b.expire;
export function classDistribution(rows: Rec[]): Record<string, number> {
  const d: Record<string, number> = {}; for (const r of rows) { const k = r.cls || '(blank)'; d[k] = (d[k] ?? 0) + 1; } return d;
}
/** Suppression list entries are sha256hex(SUPPRESS_SALT + CALL) (QA N-M1); lines starting with # are comments. */
export const suppressHash = (call: string) => sha256Hex(new TextEncoder().encode(SUPPRESS_SALT + call.trim().toUpperCase()));
export function parseSuppress(text: string): (call: string) => boolean {
  const set = new Set(text.split('\n').map(l => l.trim().toLowerCase()).filter(l => l && !l.startsWith('#')));
  for (const h of set) if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`suppress.txt: not a sha256 hash: ${h.slice(0, 12)}… (store hashes, never callsigns)`);
  return call => set.size > 0 && set.has(suppressHash(call));
}

/* ---------- freshness (QA N-H1: never publish stale source data / never move records backwards) ---------- */
export type Sources = { full?: string; daily?: string }; // ISO Last-Modified of the last source file processed, per kind
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
export function mergeDaily(cur: Map<string, Rec>, m: Map<number, Raw>, suppressed: (c: string) => boolean): { up: Rec[]; del: Set<string>; skippedOlder: number } {
  const up = new Map<string, Rec>(); const del = new Set<string>(); let skippedOlder = 0;
  for (const r of m.values()) {
    if (!r.call) continue;
    if (suppressed(r.call)) { if (cur.delete(r.call)) del.add(r.call); up.delete(r.call); continue; }
    const old = cur.get(r.call);
    if (r.status === 'A') {
      if (old && old.grant > r.grant) { skippedOlder++; continue; }
      // fields missing from today's file (no EN/AM row for this USI) keep their previous values
      const rec = toRec({ ...r, name: r.name ?? old?.name, city: r.city ?? old?.city, state: r.state ?? old?.state, zip: r.zip ?? old?.zip, cls: r.cls ?? old?.cls });
      if (!old || !sameRec(old, rec)) { cur.set(r.call, rec); up.set(r.call, rec); del.delete(r.call); }
    } else if (old && old.grant <= r.grant) { cur.delete(r.call); up.delete(r.call); del.add(r.call); }
  }
  return { up: [...up.values()], del, skippedOlder };
}
