/**
 * HHC1: compact columnar payload for the callsign index (full files and deltas). Pure (no RN/Node imports) so the
 * pipeline (node, type-stripped) and the app share one encoder/decoder.
 * Sections are UTF-8 text joined by \0:
 *   0 header JSON { format:'HHC1', kind:'full'|'delta', built, rows, deletes }
 *   1 city dictionary, one "City\tST" per line
 *   2 callsigns sorted ascending, front-coded: one digit = chars shared with the previous call, then the suffix
 *   3 names · 4 class chars (one per row, '-' = none) · 5 city index (base 36) · 6 ZIP5 · 7 grant day (days since 1970,
 *   base 36) · 8 expire − grant (days, base 36) · 9 deleted callsigns (deltas only)
 * Only these fields exist: NO street address, PO box, FRN or license history can be carried (privacy).
 */
export type Rec = { call: string; name: string; cls: string; city: string; state: string; zip: string; grant: number; expire: number };
export type Payload = { kind: 'full' | 'delta'; built: string; rows: Rec[]; deletes: string[] };
export function encode(p: Payload): string {
  const rows = [...p.rows].sort((a, b) => (a.call < b.call ? -1 : a.call > b.call ? 1 : 0));
  const clean = (s: string) => (s ?? '').replace(/[\0\n\t]/g, ' ');
  const dict = new Map<string, number>(); const ci = (r: Rec) => { const k = `${clean(r.city)}\t${clean(r.state)}`; let i = dict.get(k); if (i === undefined) { i = dict.size; dict.set(k, i); } return i; };
  let prev = ''; const calls: string[] = [];
  for (const r of rows) { let i = 0; while (i < 9 && i < prev.length && prev[i] === r.call[i]) i++; calls.push(i + r.call.slice(i)); prev = r.call; }
  const cols = [rows.map(r => clean(r.name)).join('\n'), rows.map(r => (r.cls || '-')[0]).join(''), rows.map(r => ci(r).toString(36)).join('\n'),
    rows.map(r => r.zip).join('\n'), rows.map(r => r.grant.toString(36)).join('\n'), rows.map(r => (r.expire - r.grant).toString(36)).join('\n')];
  const header = JSON.stringify({ format: 'HHC1', kind: p.kind, built: p.built, rows: rows.length, deletes: p.deletes.length });
  const cities = [...dict.keys()].join('\n');
  return [header, cities, calls.join('\n'), ...cols, p.deletes.join('\n')].join('\0');
}
export class FormatError extends Error {}
export function decode(text: string): Payload {
  const s = text.split('\0'); if (s.length !== 10) throw new FormatError('Not a Ham Helper data file');
  let h: { format: string; kind: 'full' | 'delta'; built: string; rows: number; deletes: number };
  try { h = JSON.parse(s[0]); } catch { throw new FormatError('Bad header'); }
  if (h.format !== 'HHC1') throw new FormatError(`Unsupported format ${h.format}`);
  const lines = (x: string) => (x === '' ? [] : x.split('\n'));
  const cities = lines(s[1]).map(l => l.split('\t')); const calls = lines(s[2]); const names = lines(s[3]); const cls = s[4];
  const cidx = lines(s[5]); const zips = lines(s[6]); const grants = lines(s[7]); const spans = lines(s[8]);
  const n = h.rows;
  if ([calls.length, names.length, cls.length, cidx.length, zips.length, grants.length, spans.length].some(l => l !== n)) throw new FormatError('Column length mismatch');
  const rows: Rec[] = new Array(n); let prev = '';
  for (let i = 0; i < n; i++) {
    const k = calls[i].charCodeAt(0) - 48; const call = prev.slice(0, k) + calls[i].slice(1); prev = call;
    const c = cities[parseInt(cidx[i], 36)] ?? ['', ''];
    const g = parseInt(grants[i], 36);
    rows[i] = { call, name: names[i], cls: cls[i] === '-' ? '' : cls[i], city: c[0], state: c[1], zip: zips[i], grant: g, expire: g + parseInt(spans[i], 36) };
  }
  const deletes = lines(s[9]); if (deletes.length !== h.deletes) throw new FormatError('Delete list mismatch');
  return { kind: h.kind, built: h.built, rows, deletes };
}
