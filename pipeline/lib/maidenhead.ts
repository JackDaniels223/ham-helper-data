/** Maidenhead locator (pure). precision 4 → "FN31", 6 → "FN31pr". Returns null for out-of-range input. */
export function maidenhead(lat: number, lon: number, precision: 4 | 6 = 4): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  const x = Math.min(lon + 180, 359.999999), y = Math.min(lat + 90, 179.999999);
  const A = 'A'.charCodeAt(0);
  let s = String.fromCharCode(A + Math.floor(x / 20), A + Math.floor(y / 10)) + Math.floor((x % 20) / 2) + Math.floor(y % 10);
  if (precision === 6) s += String.fromCharCode(97 + Math.floor((x % 2) * 12), 97 + Math.floor((y % 1) * 24));
  return s;
}
/** Centre of a 4-char grid square (inverse, for tests/plots). */
export function gridCenter(g: string): { lat: number; lon: number } | null {
  const m = /^([A-R])([A-R])([0-9])([0-9])$/i.exec(g); if (!m) return null; const A = 65;
  return { lon: (m[1].toUpperCase().charCodeAt(0) - A) * 20 + +m[3] * 2 + 1 - 180, lat: (m[2].toUpperCase().charCodeAt(0) - A) * 10 + +m[4] + 0.5 - 90 };
}
