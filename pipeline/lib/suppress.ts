/**
 * Callsigns removed on request (docs/PRIVACY.md), stored ONLY as salted SHA-256 hashes so the list doesn't publish who
 * asked for privacy (QA N-M1): hash = sha256hex(SUPPRESS_SALT + CALLSIGN_UPPERCASE). Same list/salt as
 * data-pipeline/suppress.txt. The pipeline removes these from every file; the app also hides them, so a removal reaches
 * devices with this app version even before their data is re-downloaded.
 * Add one: `node data-pipeline/suppress-hash.mjs CALL` and paste the hash in both places.
 */
import { sha256Hex } from './sha256';
export const SUPPRESS_SALT = 'hamhelper/suppress/v1:';
export const SUPPRESSED_HASHES: ReadonlySet<string> = new Set<string>([]);
export const suppressHash = (call: string) => sha256Hex(new TextEncoder().encode(SUPPRESS_SALT + call.trim().toUpperCase()));
export function isSuppressed(call: string, set: ReadonlySet<string> = SUPPRESSED_HASHES): boolean { return set.size > 0 && set.has(suppressHash(call)); }
