#!/usr/bin/env node
// Ham Helper callsign data pipeline (Node 22, --experimental-transform-types). Nothing here uploads anything.
//   P="node --no-warnings --experimental-transform-types --import ./data-pipeline/ts-resolve.mjs data-pipeline/build.mts"
//   $P full  <uls-dir: extracted l_amat.zip> <out-dir> --last-modified "<HTTP Last-Modified>" [--force]
//   $P daily <prev state.hhc.gz> <uls-dir: extracted l_am_<day>.zip> <out-dir> --last-modified "<…>" [--force]
// Version stamp = the source file's Last-Modified (UTC YYYYMMDDHHMM), i.e. the FCC data date, not the build date.
// Removal requests come from env SUPPRESS_LIST (newline-separated callsigns, an Actions secret); nothing is committed.
//   $P manifest <out-dir> [--key-file <pem>]   signs with Ed25519: env MANIFEST_SIGNING_KEY (PEM) or --key-file
//   $P stategrid <uls-dir>                     most-common grid per state (for scripts/zip-grid-build.mjs)
// Exit 75 = stale source (not newer than the last one processed): nothing is written; the workflow skips publishing.
// Outputs: full-*.hhc.gz, delta-*.hhc.gz, state.hhc.gz, chain.json, sources.json, manifest.json (signed envelope).
import { createReadStream, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { join } from 'node:path';
import { encode, decode, gridForZip, type Rec } from './lib';
import { UlsAccumulator, activeRecs, assertClean, checkCount, checkFresh, classDistribution, mergeDaily, parseSuppress, sameRec, stampOf, type Sources } from './uls-parse';

const here = new URL('.', import.meta.url).pathname;
const argv = process.argv.slice(2); const flag = (n: string) => { const i = argv.indexOf(n); if (i < 0) return undefined; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const force = argv.includes('--force'); if (force) argv.splice(argv.indexOf('--force'), 1);
const lastModified = flag('--last-modified'); const keyFile = flag('--key-file');
const [mode, ...a] = argv;
const suppressed = parseSuppress(process.env.SUPPRESS_LIST); void here;
async function each(dir: string, file: string, fn: (f: string[]) => void) {
  const p = join(dir, file); if (!existsSync(p)) return;
  const rl = createInterface({ input: createReadStream(p, { encoding: 'latin1' }), crlfDelay: Infinity });
  for await (const line of rl) if (line) fn(line.split('|'));
}
async function readUls(dir: string) {
  const acc = new UlsAccumulator();
  await each(dir, 'HD.dat', f => acc.hd(f)); await each(dir, 'EN.dat', f => acc.en(f)); await each(dir, 'AM.dat', f => acc.am(f));
  return acc;
}
const write = (out: string, name: string, text: string) => { mkdirSync(out, { recursive: true }); const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 }); writeFileSync(join(out, name), gz); return gz.length; };
const readJson = <T,>(p: string, d: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const logDelta = (out: string, file: string, from: string, to: string) => { const p = join(out, 'chain.json'); const c = readJson<object[]>(p, []); c.push({ file, from, to }); writeFileSync(p, JSON.stringify(c, null, 1)); };
const readState = (p: string) => decode(gunzipSync(readFileSync(p)).toString('utf8'));
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const dayOf = (stamp: string) => Math.floor(Date.parse(iso(stamp)) / 864e5);
const fail = (code: number, msg: string): never => { console.error(msg); process.exit(code); };
function freshOrExit(out: string, kind: 'full' | 'daily') {
  const p = join(out, 'sources.json'); const prev = readJson<Sources>(p, {}); const f = checkFresh(prev, kind, lastModified, force);
  if (!f.ok) fail(75, `SKIP: ${f.reason}`);
  return () => writeFileSync(p, JSON.stringify({ ...prev, [kind]: new Date(Date.parse(lastModified!)).toISOString() }, null, 1));
}
function diff(prev: Rec[], next: Rec[]) {
  const p = new Map(prev.map(r => [r.call, r])); const up: Rec[] = []; const seen = new Set<string>();
  for (const r of next) { seen.add(r.call); const o = p.get(r.call); if (!o || !sameRec(o, r)) up.push(r); }
  return { up, del: prev.filter(r => !seen.has(r.call)).map(r => r.call) };
}
const KEEP_DAYS = 35; // rolling delta window kept in the manifest

if (mode === 'full') {
  const [dir, out] = a; const commit = freshOrExit(out, 'full'); const date = stampOf(lastModified!);
  const acc = await readUls(dir); const rows = activeRecs(acc.m, suppressed, dayOf(date)); assertClean(rows, suppressed);
  const statePath = join(out, 'state.hhc.gz'); const prev = existsSync(statePath) ? readState(statePath) : null;
  const cc = checkCount(prev?.rows.length ?? null, rows.length); if (!cc.ok && !force) fail(1, `ABORT: ${cc.reason}`);
  const text = encode({ kind: 'full', built: date, rows, deletes: [] });
  // Weekly reconcile delta: diff the previous state against this fresh full build, so clients never need a re-download.
  let reconcile: object | null = null;
  if (prev && prev.built < date) { const d = diff(prev.rows, rows); write(out, `delta-${date}.hhc.gz`, encode({ kind: 'delta', built: date, rows: d.up, deletes: d.del })); logDelta(out, `delta-${date}.hhc.gz`, prev.built, date); reconcile = { from: prev.built, upserts: d.up.length, deletes: d.del.length }; }
  const bytes = write(out, `full-${date}.hhc.gz`, text); write(out, 'state.hhc.gz', text); commit();
  console.log(JSON.stringify({ mode, date, licenses: acc.m.size, active: rows.length, rawBytes: Buffer.byteLength(text), gzBytes: bytes, reconcile, classes: classDistribution(rows), issues: acc.issues }));
} else if (mode === 'daily') {
  const [prevPath, dir, out] = a; const commit = freshOrExit(out, 'daily'); const date = stampOf(lastModified!);
  const prev = readState(prevPath); if (prev.built >= date) fail(75, `SKIP: state already at ${prev.built}`); // same ordering as checkFresh
  const cur = new Map(prev.rows.map(r => [r.call, r])); const acc = await readUls(dir);
  const { up, del, skippedOlder } = mergeDaily(cur, acc.m, suppressed, dayOf(date)); assertClean(up, suppressed); assertClean([...cur.values()], suppressed);
  if (del.size > prev.rows.length * 0.02) fail(1, `ABORT: ${del.size} deletes is more than 2% of ${prev.rows.length}`);
  const text = encode({ kind: 'delta', built: date, rows: up, deletes: [...del] });
  const bytes = write(out, `delta-${date}.hhc.gz`, text); logDelta(out, `delta-${date}.hhc.gz`, prev.built, date);
  write(out, 'state.hhc.gz', encode({ kind: 'full', built: date, rows: [...cur.values()], deletes: [] })); commit();
  console.log(JSON.stringify({ mode, date, from: prev.built, upserts: up.length, deletes: del.size, skippedOlder, gzBytes: bytes, issues: acc.issues }));
} else if (mode === 'manifest') {
  const [out] = a; const files = readdirSync(out);
  const fulls = files.filter(f => /^full-\d{12}\.hhc\.gz$/.test(f)).sort(); if (!fulls.length) throw new Error('no full file');
  const full = fulls[fulls.length - 1]; const fd = full.slice(5, 17);
  const meta = (f: string) => { const b = readFileSync(join(out, f)); return { url: f, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }; };
  // chain.json records each delta's true base (from) as it is written; keep the newest contiguous chain within KEEP_DAYS.
  const chain = readJson<{ file: string; from: string; to: string }[]>(join(out, 'chain.json'), []);
  const cutoff = new Date(Date.parse(iso(fd)) - KEEP_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '') + '0000';
  const deltas: object[] = []; let expect: string | null = null;
  for (let i = chain.length - 1; i >= 0; i--) { const c = chain[i]; if (expect && c.to !== expect) break; if (c.from < cutoff) break; if (!existsSync(join(out, c.file))) break; deltas.unshift({ ...meta(c.file), from: c.from, to: c.to }); expect = c.from; }
  const payload = JSON.stringify({ version: 3, format: 'HHC2', generated: new Date().toISOString(), full: { ...meta(full), built: fd }, deltas }, null, 1);
  const pem = keyFile ? readFileSync(keyFile, 'utf8') : process.env.MANIFEST_SIGNING_KEY; if (!pem) fail(1, 'ABORT: no signing key (MANIFEST_SIGNING_KEY or --key-file)');
  const sig = sign(null, Buffer.from(payload, 'utf8'), createPrivateKey(pem!)).toString('base64');
  writeFileSync(join(out, 'manifest.json'), JSON.stringify({ signed: 'ed25519', kid: 'hh1', payload, sig }));
  console.log(JSON.stringify({ full, deltas: deltas.length, signed: true }));
} else if (mode === 'stategrid') {
  const acc = await readUls(a[0]); const counts = new Map<string, Map<string, number>>();
  for (const r of acc.m.values()) { if (r.status !== 'A' || !/^[A-Z]{2}$/.test(r.state ?? '') || ['AA', 'AE', 'AP'].includes(r.state!)) continue; const g = gridForZip(r.zip ?? ''); if (!g) continue;
    const s = counts.get(r.state!) ?? new Map(); s.set(g, (s.get(g) ?? 0) + 1); counts.set(r.state!, s); }
  const best: Record<string, string> = {}; for (const [st, s] of [...counts].sort()) best[st] = [...s].sort((x, y) => y[1] - x[1])[0][0];
  console.log(JSON.stringify(best));
} else fail(2, 'usage: see header');
