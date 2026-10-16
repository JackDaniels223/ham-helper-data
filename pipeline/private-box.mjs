// Seal / open the PRIVATE pipeline state (private/state.hhc.gz, private/purge.json) for the Actions cache.
// Why encrypt: in a public repo, a workflow from a fork pull request can restore this repo's caches. Secrets are NOT given
// to fork PRs, so AES-256-GCM with a key derived (HKDF-SHA256) from the MANIFEST_SIGNING_KEY secret keeps the state private.
//   node private-box.mjs seal <private-dir> <box-dir>     (env PRIVATE_BOX_SECRET)
//   node private-box.mjs open <box-dir> <private-dir>
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [mode, from, to] = process.argv.slice(2); const secret = process.env.PRIVATE_BOX_SECRET;
if (!secret) { console.error('ABORT: PRIVATE_BOX_SECRET not set'); process.exit(1); }
const key = Buffer.from(hkdfSync('sha256', Buffer.from(secret, 'utf8'), Buffer.from('ham-helper-data'), Buffer.from('private-state-v1'), 32));
mkdirSync(to, { recursive: true });
if (!existsSync(from)) { console.log('nothing to ' + mode); process.exit(0); }
for (const f of readdirSync(from)) {
  if (mode === 'seal') {
    const iv = randomBytes(12); const c = createCipheriv('aes-256-gcm', key, iv); c.setAAD(Buffer.from(f));
    const ct = Buffer.concat([c.update(readFileSync(join(from, f))), c.final()]);
    writeFileSync(join(to, f + '.box'), Buffer.concat([iv, c.getAuthTag(), ct]));
  } else if (mode === 'open' && f.endsWith('.box')) {
    const b = readFileSync(join(from, f)); const name = f.slice(0, -4); const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAAD(Buffer.from(name)); d.setAuthTag(b.subarray(12, 28)); writeFileSync(join(to, name), Buffer.concat([d.update(b.subarray(28)), d.final()]));
  }
}
console.log(mode + ' ok');
