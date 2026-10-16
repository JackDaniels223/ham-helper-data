#!/usr/bin/env node
// Ham Helper callsign data pipeline (Node ≥ 22.18, runs .ts natively). Nothing here uploads anything.
//   node --import ./data-pipeline/ts-resolve.mjs data-pipeline/build.mts full  <uls-dir: extracted l_amat.zip> <out-dir> <YYYYMMDD>
//   node --import ./data-pipeline/ts-resolve.mjs data-pipeline/build.mts daily <prev state.hhc.gz> <uls-dir: extracted l_am_<day>.zip> <out-dir> <YYYYMMDD>
//   node --import ./data-pipeline/ts-resolve.mjs data-pipeline/build.mts manifest <out-dir>
//   node --import ./data-pipeline/ts-resolve.mjs data-pipeline/build.mts stategrid <uls-dir>    (prints most-common grid per state for scripts/zip-grid-build.mjs)
// Outputs: full-YYYYMMDD.hhc.gz, delta-YYYYMMDD.hhc.gz, state.hhc.gz (the current full state, used by the next daily),
// manifest.json (sha256 + byte sizes). Format: src/uls/format.ts. Street addresses are never read past parsing.
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { encode, decode, type Rec } from './lib/format';
import { gridForZip } from './lib/zipGrid';

const here = new URL('.', import.meta.url).pathname;
const suppressed = new Set(readFileSync(join(here, 'suppress.txt'), 'utf8').split('\n').map(l => l.trim().toUpperCase()).filter(l => l && !l.startsWith('#')));
const toDays = (s: string) => { if (!s) return 0; const [m, d, y] = s.split('/').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
async function each(dir: string, file: string, fn: (f: string[]) => void) {
  const p = join(dir, file); if (!existsSync(p)) return;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) if (line) fn(line.split('|'));
}
type Raw = { call: string; status: string; grant: number; expire: number; name?: string; city?: string; state?: string; zip?: string; cls?: string };
/** Parse HD/EN/AM. EN field 15 (street) and 19+ (PO box, FRN…) are never copied. */
async function readUls(dir: string): Promise<Map<number, Raw>> {
  const m = new Map<number, Raw>();
  await each(dir, 'HD.dat', f => m.set(+f[1], { call: f[4], status: f[5], grant: toDays(f[7]), expire: toDays(f[8]) }));
  await each(dir, 'EN.dat', f => { const r = m.get(+f[1]); if (r && (f[5] === 'L' || !r.name)) { r.name = f[7]; r.city = f[16]; r.state = (f[17] || '').toUpperCase(); r.zip = (f[18] || '').slice(0, 5); } });
  await each(dir, 'AM.dat', f => { const r = m.get(+f[1]); if (r) r.cls = f[5] || ''; });
  return m;
}
const toRec = (r: Raw): Rec => ({ call: r.call, name: r.name ?? '', cls: r.cls ?? '', city: r.city ?? '', state: r.state ?? '', zip: r.zip ?? '', grant: r.grant, expire: r.expire });
const write = (out: string, name: string, text: string) => { mkdirSync(out, { recursive: true }); const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 }); writeFileSync(join(out, name), gz); return gz.length; };
const logDelta = (out: string, file: string, from: string, to: string) => { const p = join(out, 'chain.json'); const c = existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : []; c.push({ file, from, to }); writeFileSync(p, JSON.stringify(c, null, 1)); };
const readState = (p: string) => decode(gunzipSync(readFileSync(p)).toString('utf8'));
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const same = (a: Rec, b: Rec) => a.name === b.name && a.cls === b.cls && a.city === b.city && a.state === b.state && a.zip === b.zip && a.grant === b.grant && a.expire === b.expire;

function diff(prev: Rec[], next: Rec[]) {
  const p = new Map(prev.map(r => [r.call, r])); const up: Rec[] = []; const seen = new Set<string>();
  for (const r of next) { seen.add(r.call); const o = p.get(r.call); if (!o || !same(o, r)) up.push(r); }
  return { up, del: prev.filter(r => !seen.has(r.call)).map(r => r.call) };
}
const KEEP_DAYS = 35; // rolling delta window kept in the manifest
const [mode, ...a] = process.argv.slice(2);
if (mode === 'full') {
  const [dir, out, date] = a; const m = await readUls(dir);
  const rows = [...m.values()].filter(r => r.status === 'A' && !suppressed.has(r.call)).map(toRec);
  const text = encode({ kind: 'full', built: date, rows, deletes: [] });
  // Weekly reconcile delta: diff the previous state against this fresh full build, so clients never need a re-download.
  const statePath = join(out, 'state.hhc.gz'); let reconcile: object | null = null;
  if (existsSync(statePath)) { const prev = readState(statePath); if (prev.built < date) { const d = diff(prev.rows, rows); write(out, `delta-${date}.hhc.gz`, encode({ kind: 'delta', built: date, rows: d.up, deletes: d.del })); logDelta(out, `delta-${date}.hhc.gz`, prev.built, date);
    reconcile = { from: prev.built, upserts: d.up.length, deletes: d.del.length }; } }
  const bytes = write(out, `full-${date}.hhc.gz`, text); write(out, 'state.hhc.gz', text);
  console.log(JSON.stringify({ mode, date, licenses: m.size, active: rows.length, rawBytes: Buffer.byteLength(text), gzBytes: bytes, reconcile }));
} else if (mode === 'daily') {
  const [prevPath, dir, out, date] = a; const prev = readState(prevPath); const cur = new Map(prev.rows.map(r => [r.call, r]));
  const m = await readUls(dir); const up: Rec[] = []; const del = new Set<string>();
  for (const r of m.values()) {
    if (suppressed.has(r.call)) { if (cur.delete(r.call)) del.add(r.call); continue; }
    if (r.status === 'A') { const old = cur.get(r.call); const rec = toRec({ ...(old ? { name: old.name, city: old.city, state: old.state, zip: old.zip, cls: old.cls } : {}), ...r });
      if (!old || !same(old, rec)) { cur.set(r.call, rec); up.push(rec); del.delete(r.call); } }
    else if (cur.has(r.call) && cur.get(r.call)!.grant <= r.grant) { cur.delete(r.call); del.add(r.call); }
  }
  for (const c of suppressed) if (cur.delete(c)) del.add(c);
  const text = encode({ kind: 'delta', built: date, rows: up, deletes: [...del] });
  const bytes = write(out, `delta-${date}.hhc.gz`, text); logDelta(out, `delta-${date}.hhc.gz`, prev.built, date);
  write(out, 'state.hhc.gz', encode({ kind: 'full', built: date, rows: [...cur.values()], deletes: [] }));
  console.log(JSON.stringify({ mode, date, from: prev.built, upserts: up.length, deletes: del.size, gzBytes: bytes }));
} else if (mode === 'manifest') {
  const [out] = a; const files = readdirSync(out);
  const fulls = files.filter(f => /^full-\d{8}\.hhc\.gz$/.test(f)).sort(); if (!fulls.length) throw new Error('no full file');
  const full = fulls[fulls.length - 1]; const fd = full.slice(5, 13);
  const meta = (f: string) => { const b = readFileSync(join(out, f)); return { url: f, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }; };
  // chain.json records each delta's true base (from) as it is written; keep the newest contiguous chain within KEEP_DAYS.
  const chain: { file: string; from: string; to: string }[] = existsSync(join(out, 'chain.json')) ? JSON.parse(readFileSync(join(out, 'chain.json'), 'utf8')) : [];
  const cutoff = new Date(Date.parse(iso(fd)) - KEEP_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
  const deltas: object[] = []; let expect: string | null = null;
  for (let i = chain.length - 1; i >= 0; i--) { const c = chain[i]; if (expect && c.to !== expect) break; if (c.from < cutoff) break; if (!existsSync(join(out, c.file))) break; deltas.unshift({ ...meta(c.file), from: c.from, to: c.to }); expect = c.from; }
  const manifest = { version: 2, format: 'HHC1', generated: new Date().toISOString(), full: { ...meta(full), built: fd }, deltas };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2)); console.log(JSON.stringify({ full, deltas: deltas.length }));
} else if (mode === 'stategrid') {
  const m = await readUls(a[0]); const counts = new Map<string, Map<string, number>>();
  for (const r of m.values()) { if (r.status !== 'A' || !/^[A-Z]{2}$/.test(r.state ?? '') || ['AA', 'AE', 'AP'].includes(r.state!)) continue; const g = gridForZip(r.zip ?? ''); if (!g) continue;
    const s = counts.get(r.state!) ?? new Map(); s.set(g, (s.get(g) ?? 0) + 1); counts.set(r.state!, s); }
  const best: Record<string, string> = {}; for (const [st, s] of [...counts].sort()) best[st] = [...s].sort((x, y) => y[1] - x[1])[0][0];
  console.log(JSON.stringify(best));
} else { console.error('usage: see header'); process.exit(2); }
void iso; void statSync;
