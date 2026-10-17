#!/usr/bin/env node
// Ham Helper callsign data pipeline (Node 22, --experimental-transform-types). Nothing here uploads anything.
//   P="node --no-warnings --experimental-transform-types --import ./data-pipeline/ts-resolve.mjs data-pipeline/build.mts"
//   $P full  <uls-dir: extracted l_amat.zip> <out-dir> --last-modified "<HTTP Last-Modified>" [--force]
//   $P daily <out-dir>/private/state.hhc.gz <uls-dir: extracted l_am_<day>.zip> <out-dir> --last-modified "<…>" [--force]
// Version stamp = the source file's Last-Modified (UTC YYYYMMDDHHMM), i.e. the FCC data date, not the build date.
// Removal requests come from env SUPPRESS_LIST (newline-separated callsigns, an Actions secret); nothing is committed.
//   $P manifest <out-dir> [--key-file <pem>]   signs with Ed25519: env MANIFEST_SIGNING_KEY (PEM) or --key-file
//   $P stategrid <uls-dir>                     most-common grid per state (for scripts/zip-grid-build.mjs)
// Exit 75 = stale source (not newer than the last one processed): nothing is written; the workflow skips publishing.
// Public outputs: full-*.hhc.gz, delta-*.hhc.gz, chain.json, sources.json, manifest.json (signed envelope).
// PRIVATE outputs (never published, Actions cache only): private/state.hhc.gz, private/purge.json. Purge state is never logged.
import { appendFileSync, createReadStream, existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
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
// Published file names are immutable (QA 8cea6f2 M: delta-202610161200 was reused with different content, so clients that had
// the first one considered themselves current). writeOnce refuses to replace an existing file with different bytes (identical
// bytes = idempotent rerun), and records every new name in new-files.txt, the only dated files the workflow uploads (no --clobber).
const write = (out: string, name: string, text: string) => {
  mkdirSync(out, { recursive: true }); const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 }); const p = join(out, name);
  if (existsSync(p)) { if (readFileSync(p).equals(gz)) return gz.length; fail(1, `ABORT: refusing to overwrite published file ${name} with different content`); }
  writeFileSync(p, gz); appendFileSync(join(out, 'new-files.txt'), name + '\n'); return gz.length;
};
/** Delta names carry both stamps, so a delta with a different base can never share a name. */
export const deltaName = (from: string, to: string) => `delta-${from}-${to}.hhc.gz`;
/** A full rebuild of the same FCC weekly file with different content (e.g. a suppression purge) gets a -rN suffix. */
function fullName(out: string, date: string, text: string) {
  const gz = gzipSync(Buffer.from(text, 'utf8'), { level: 9 });
  for (let n = 1; ; n++) { const f = n === 1 ? `full-${date}.hhc.gz` : `full-${date}-r${n}.hhc.gz`; const p = join(out, f); if (!existsSync(p) || readFileSync(p).equals(gz)) return f; }
}
const fullKey = (f: string) => { const m = /^full-(\d{12})(?:-r(\d+))?\.hhc\.gz$/.exec(f); return m ? m[1] + String(+(m[2] ?? 1)).padStart(4, '0') : null; };
const readJson = <T,>(p: string, d: T): T => (existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : d);
const logDelta = (out: string, file: string, from: string, to: string) => { const p = join(out, 'chain.json'); const c = readJson<object[]>(p, []); c.push({ file, from, to }); writeFileSync(p, JSON.stringify(c, null, 1)); };
const readState = (p: string) => decode(gunzipSync(readFileSync(p)).toString('utf8'));
const iso = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
const dayOf = (stamp: string) => Math.floor(Date.parse(iso(stamp)) / 864e5);
const fail = (code: number, msg: string): never => { console.error(msg); process.exit(code); };
function freshOrExit(out: string, kind: 'full' | 'daily') {
  const p = join(out, 'sources.json'); const prev = readJson<Sources>(p, {}); const f = checkFresh(prev, kind, lastModified, force);
  if (!f.ok) fail(75, `SKIP: ${f.reason}`);
  const iso = new Date(Date.parse(lastModified!)).toISOString();
  // A full build REPLACES the state, so the daily watermark resets to the full's date: every FCC daily posted after the weekly
  // file then applies again, in order (the workflow loops over all 7 retained dailies). Without this, a forced full rebuild
  // would leave the dailies between the weekly file and the last daily unapplied (the Mon–Wed gap).
  return () => writeFileSync(p, JSON.stringify(kind === 'full' ? { full: iso, ...(prev.minVersion ? { minVersion: prev.minVersion } : {}) } : { ...prev, daily: iso }, null, 1));
}
function diff(prev: Rec[], next: Rec[]) {
  const p = new Map(prev.map(r => [r.call, r])); const up: Rec[] = []; const seen = new Set<string>();
  for (const r of next) { seen.add(r.call); const o = p.get(r.call); if (!o || !sameRec(o, r)) up.push(r); }
  return { up, del: prev.filter(r => !seen.has(r.call)).map(r => r.call) };
}
// PRIVATE state (QA b4cbdf1 M3): <out>/private/ holds state.hhc.gz (full current state, which would reveal suppressed calls
// when diffed against the public files) and purge.json (pending-purge flag). The workflow keeps this folder in the Actions
// cache only; the release upload is `out/*.hhc.gz` (non-recursive), so nothing under private/ is ever published.
const privDir = (out: string) => { const d = join(out, 'private'); mkdirSync(d, { recursive: true }); return d; };
const statePathOf = (out: string) => join(privDir(out), 'state.hhc.gz');
const purgeFile = (out: string) => join(privDir(out), 'purge.json');
const setPurge = (out: string, pending: boolean) => writeFileSync(purgeFile(out), JSON.stringify({ pending }));
const writeState = (out: string, text: string) => { writeFileSync(statePathOf(out), gzipSync(Buffer.from(text, 'utf8'), { level: 9 })); };
const KEEP_DAYS = 35; // rolling delta window kept in the manifest

if (mode === 'full') {
  const [dir, out] = a; const commit = freshOrExit(out, 'full'); const date = stampOf(lastModified!);
  const acc = await readUls(dir); const rows = activeRecs(acc.m, suppressed, dayOf(date)); assertClean(rows, suppressed);
  const statePath = statePathOf(out); const prev = existsSync(statePath) ? readState(statePath) : null;
  const cc = checkCount(prev?.rows.length ?? null, rows.length); if (!cc.ok && !force) fail(1, `ABORT: ${cc.reason}`);
  const text = encode({ kind: 'full', built: date, rows, deletes: [] });
  // Weekly reconcile delta: diff the previous state against this fresh full build, so clients never need a re-download.
  let reconcile: object | null = null;
  // Suppression purge (pending from a daily run, or a suppressed call still in state): NO reconcile delta, which breaks the
  // chain so clients take this full file. Removals therefore never appear in any DELETES list.
  const purge = readJson<{ pending?: boolean }>(purgeFile(out), {}).pending === true || !!prev?.rows.some(r => suppressed(r.call));
  if (prev && prev.built < date && !purge) { const d = diff(prev.rows, rows); write(out, deltaName(prev.built, date), encode({ kind: 'delta', built: date, rows: d.up, deletes: d.del })); logDelta(out, deltaName(prev.built, date), prev.built, date); reconcile = { from: prev.built, upserts: d.up.length, deletes: d.del.length }; }
  const bytes = write(out, fullName(out, date, text), text); writeState(out, text); setPurge(out, false); commit();
  console.log(JSON.stringify({ mode, date, licenses: acc.m.size, active: rows.length, rawBytes: Buffer.byteLength(text), gzBytes: bytes, reconcile, classes: classDistribution(rows), issues: acc.issues }));
} else if (mode === 'daily') {
  const [prevPath, dir, out] = a; const commit = freshOrExit(out, 'daily'); const date = stampOf(lastModified!);
  const prev = readState(prevPath); if (prev.built >= date) fail(75, `SKIP: state already at ${prev.built}`); // same ordering as checkFresh
  const cur = new Map(prev.rows.map(r => [r.call, r])); const acc = await readUls(dir);
  const { up, del, skippedOlder, purged } = mergeDaily(cur, acc.m, suppressed, dayOf(date)); assertClean(up, suppressed); assertClean([...cur.values()], suppressed);
  if (del.size > prev.rows.length * 0.02) fail(1, `ABORT: ${del.size} deletes is more than 2% of ${prev.rows.length}`);
  const text = encode({ kind: 'delta', built: date, rows: up, deletes: [...del] });
  const bytes = write(out, deltaName(prev.built, date), text); logDelta(out, deltaName(prev.built, date), prev.built, date);
  writeState(out, encode({ kind: 'full', built: date, rows: [...cur.values()], deletes: [] })); if (purged) setPurge(out, true); commit();
  console.log(JSON.stringify({ mode, date, from: prev.built, upserts: up.length, deletes: del.size, skippedOlder, gzBytes: bytes, issues: acc.issues }));
} else if (mode === 'reissue') {
  // One-time forced full download (QA 3ff612b M): delta-202610161200 was once published with a different base, so phones that
  // installed it sit at 202610161200 missing Mon–Wed and see themselves as current. Reissue the current state (no new FCC data)
  // as a full file stamped one minute later and set minVersion to it: the old chain ends before the new full, so the manifest
  // drops it and EVERY client (old app versions included) takes this full file once. The date shown in the app is unchanged.
  // Guard (QA L): a second reissue of the SAME data would bump minVersion again and make every device re-download ~12.8 MB.
  // If the state is already the current reissue (state.built === minVersion, no FCC data since), skip unless --force.
  const [out] = a; const st = readState(statePathOf(out));
  const curMin = readJson<{ minVersion?: string }>(join(out, 'sources.json'), {}).minVersion;
  if (curMin && st.built === curMin && !force) fail(75, `SKIP: data ${st.built} is already the current reissue (minVersion ${curMin}); nothing new to reissue. Use force to reissue anyway.`);
  const t = new Date(Date.parse(iso(st.built) + `T${st.built.slice(8, 10)}:${st.built.slice(10, 12)}:00Z`) + 60_000);
  const nb = t.toISOString().replace(/[-:T]/g, '').slice(0, 12); const text = encode({ kind: 'full', built: nb, rows: st.rows, deletes: [] });
  const f = fullName(out, nb, text); const bytes = write(out, f, text); writeState(out, text);
  const sp = join(out, 'sources.json'); writeFileSync(sp, JSON.stringify({ ...readJson<object>(sp, {}), minVersion: nb }, null, 1));
  console.log(JSON.stringify({ mode, from: st.built, built: nb, file: f, rows: st.rows.length, gzBytes: bytes }));
} else if (mode === 'manifest') {
  const [out] = a; const files = readdirSync(out);
  const fulls = files.filter(f => fullKey(f)).sort((x, y) => fullKey(x)!.localeCompare(fullKey(y)!)); if (!fulls.length) throw new Error('no full file');
  const full = fulls[fulls.length - 1]; const fd = full.slice(5, 17);
  const meta = (f: string) => { const b = readFileSync(join(out, f)); return { url: f, bytes: b.length, sha256: createHash('sha256').update(b).digest('hex') }; };
  // chain.json records each delta's true base (from) as it is written. Walk back from the NEWEST version (max `to`), not the
  // last entry, so a stale tail entry can never become the head (QA 3ff612b L); for a repeated `to`, the latest entry wins.
  const chain = readJson<{ file: string; from: string; to: string }[]>(join(out, 'chain.json'), []);
  const cutoff = new Date(Date.parse(iso(fd)) - KEEP_DAYS * 864e5).toISOString().slice(0, 10).replace(/-/g, '') + '0000';
  const byTo = new Map<string, { file: string; from: string; to: string }>(); for (const c of chain) if (existsSync(join(out, c.file))) byTo.set(c.to, c);
  const deltas: object[] = []; let expect: string | undefined = [...byTo.keys()].sort().pop(); const seen = new Set<string>();
  for (let c = expect ? byTo.get(expect) : undefined; c && !seen.has(c.to) && c.from >= cutoff; c = byTo.get(c.from)) { seen.add(c.to); deltas.unshift({ ...meta(c.file), from: c.from, to: c.to }); }
  // A chain that stops before the full file (suppression purge week) is dropped: clients must take the full file.
  if (deltas.length && (deltas[deltas.length - 1] as { to: string }).to < fd) deltas.length = 0;
  // Prune chain.json to exactly the published chain (QA 8cea6f2 L: a stale entry for a superseded delta lingered).
  writeFileSync(join(out, 'chain.json'), JSON.stringify((deltas as { url: string; from: string; to: string }[]).map(d => ({ file: d.url, from: d.from, to: d.to })), null, 1));
  // minVersion (QA 3ff612b M): clients whose local version is older than this take the full file instead of deltas.
  const minVersion = readJson<{ minVersion?: string }>(join(out, 'sources.json'), {}).minVersion;
  const payload = JSON.stringify({ version: 3, format: 'HHC2', generated: new Date().toISOString(), full: { ...meta(full), built: fd }, deltas, ...(minVersion ? { minVersion } : {}) }, null, 1);
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
