/**
 * Callsign payload formats (full files and deltas). Pure (no RN/Node imports) so the pipeline (node, type-stripped) and
 * the app share one encoder/decoder. Only these fields exist: NO street address, PO box, FRN or license history can be
 * carried (privacy).
 *
 * HHC2 (current; written by the pipeline). Designed to be decoded as a STREAM so the phone never holds all rows at once
 * (QA: install memory). UTF-8 text, gzip-compressed as one stream:
 *   HEAD \0 CITY DICTIONARY \0 DELETES \x01 BLOCK \x01 BLOCK \x01 …
 *   HEAD     JSON { format:'HHC2', kind:'full'|'delta', built, rows, deletes, blocks }
 *   CITY     one "City\tST" per line (shared by all blocks)
 *   DELETES  deleted callsigns, one per line (deltas)
 *   BLOCK    ≤ BLOCK_ROWS rows as columns joined by \0: calls (sorted, front-coded per block: one digit = chars shared with the
 *            previous call, then the suffix) · names · class chars ('-' = none) · city index (base 36) · ZIP5 ·
 *            grant day (days since 1970, base 36) · expire − grant (days, base 36)
 * HHC1 (legacy, single block, sections joined by \0) is still decoded so old state files can be read by the pipeline.
 */
export type Rec = { call: string; name: string; cls: string; city: string; state: string; zip: string; grant: number; expire: number };
export type Payload = { kind: 'full' | 'delta'; built: string; rows: Rec[]; deletes: string[] };
export type Head = { format: 'HHC2'; kind: 'full' | 'delta'; built: string; rows: number; deletes: number; blocks: number };
export const BLOCK_ROWS = 20000;
export class FormatError extends Error {}
const clean = (s: string) => (s ?? '').replace(/[\0\n\t\x01]/g, ' ');
const byCall = (a: Rec, b: Rec) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0);

export function encode(p: Payload, blockRows = BLOCK_ROWS): string {
  const rows = [...p.rows].sort(byCall);
  const dict = new Map<string, number>(); const ci = (r: Rec) => { const k = `${clean(r.city)}\t${clean(r.state)}`; let i = dict.get(k); if (i === undefined) { i = dict.size; dict.set(k, i); } return i; };
  const blocks: string[] = [];
  for (let b = 0; b < rows.length; b += blockRows) {
    const part = rows.slice(b, b + blockRows); let prev = ''; const calls: string[] = [];
    for (const r of part) { let i = 0; while (i < 9 && i < prev.length && prev[i] === r.call[i]) i++; calls.push(i + r.call.slice(i)); prev = r.call; }
    blocks.push([calls.join('\n'), part.map(r => clean(r.name)).join('\n'), part.map(r => (r.cls || '-')[0]).join(''), part.map(r => ci(r).toString(36)).join('\n'),
      part.map(r => r.zip).join('\n'), part.map(r => r.grant.toString(36)).join('\n'), part.map(r => (r.expire - r.grant).toString(36)).join('\n')].join('\0'));
  }
  const head: Head = { format: 'HHC2', kind: p.kind, built: p.built, rows: rows.length, deletes: p.deletes.length, blocks: blocks.length };
  return [[JSON.stringify(head), [...dict.keys()].join('\n'), p.deletes.map(clean).join('\n')].join('\0'), ...blocks].join('\x01');
}
const lines = (x: string) => (x === '' ? [] : x.split('\n'));
function parseBlock(text: string, cities: string[][]): Rec[] {
  const s = text.split('\0'); if (s.length !== 7) throw new FormatError('Bad block');
  const [calls, names, cls, cidx, zips, grants, spans] = [lines(s[0]), lines(s[1]), s[2], lines(s[3]), lines(s[4]), lines(s[5]), lines(s[6])];
  const n = calls.length;
  if ([names.length, cls.length, cidx.length, zips.length, grants.length, spans.length].some(l => l !== n)) throw new FormatError('Column length mismatch');
  const out: Rec[] = new Array(n); let prev = '';
  for (let i = 0; i < n; i++) {
    const k = calls[i].charCodeAt(0) - 48; const call = prev.slice(0, k) + calls[i].slice(1); prev = call;
    const c = cities[parseInt(cidx[i], 36)]; if (!c) throw new FormatError('Bad city index');
    const g = parseInt(grants[i], 36);
    out[i] = { call, name: names[i], cls: cls[i] === '-' ? '' : cls[i], city: c[0], state: c[1] ?? '', zip: zips[i], grant: g, expire: g + parseInt(spans[i], 36) };
  }
  return out;
}
/**
 * Incremental HHC2 decoder: feed decompressed text in arbitrary pieces with push(); complete blocks come back as row
 * arrays; finish() checks the totals. Holds at most one partial block of text plus the city dictionary.
 */
export class StreamDecoder {
  head: Head | null = null; deletes: string[] = []; private cities: string[][] = []; private buf = ''; private seenRows = 0; private seenBlocks = 0;
  get pendingChars() { return this.buf.length; }
  push(text: string): Rec[][] {
    this.buf += text; const out: Rec[][] = []; let i: number;
    while ((i = this.buf.indexOf('\x01')) >= 0) { const piece = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1); const r = this.piece(piece); if (r) out.push(r); }
    if (this.buf.length > 8_000_000) throw new FormatError('Block too large');
    return out;
  }
  finish(): Rec[][] {
    const r = this.buf.length || !this.head ? this.piece(this.buf) : null; this.buf = '';
    const out = r ? [r] : [];
    if (!this.head) throw new FormatError('Not a Ham Helper data file');
    if (this.seenRows !== this.head.rows || this.seenBlocks !== this.head.blocks) throw new FormatError('Row count mismatch');
    return out;
  }
  private piece(text: string): Rec[] | null {
    if (!this.head) {
      const s = text.split('\0'); if (s.length !== 3) throw new FormatError('Not a Ham Helper data file');
      let h: Head; try { h = JSON.parse(s[0]); } catch { throw new FormatError('Bad header'); }
      if (h.format !== 'HHC2') throw new FormatError(`Unsupported format ${h.format}`);
      this.head = h; this.cities = lines(s[1]).map(l => l.split('\t')); this.deletes = lines(s[2]);
      if (this.deletes.length !== h.deletes) throw new FormatError('Delete list mismatch');
      return null;
    }
    const rows = parseBlock(text, this.cities); this.seenRows += rows.length; this.seenBlocks++; return rows;
  }
}
/** Whole-payload decode (pipeline, tests, small deltas). Accepts HHC2 and legacy HHC1. */
export function decode(text: string): Payload {
  if (text.startsWith('{"format":"HHC1"')) return decodeV1(text);
  const d = new StreamDecoder(); const rows: Rec[] = [];
  for (const b of d.push(text)) rows.push(...b); for (const b of d.finish()) rows.push(...b);
  return { kind: d.head!.kind, built: d.head!.built, rows, deletes: d.deletes };
}
function decodeV1(text: string): Payload {
  const s = text.split('\0'); if (s.length !== 10) throw new FormatError('Not a Ham Helper data file');
  let h: { format: string; kind: 'full' | 'delta'; built: string; rows: number; deletes: number };
  try { h = JSON.parse(s[0]); } catch { throw new FormatError('Bad header'); }
  const cities = lines(s[1]).map(l => l.split('\t'));
  const rows = parseBlock([s[2], s[3], s[4], s[5], s[6], s[7], s[8]].join('\0'), cities.length ? cities : [['', '']]);
  if (rows.length !== h.rows) throw new FormatError('Column length mismatch');
  const deletes = lines(s[9]); if (deletes.length !== h.deletes) throw new FormatError('Delete list mismatch');
  return { kind: h.kind, built: h.built, rows, deletes };
}
