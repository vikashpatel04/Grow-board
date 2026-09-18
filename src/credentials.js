/**
 * Grow Board - credential handling.
 *
 * The SQL password must never live in the repository or inside the installer,
 * because release assets are published publicly on GitHub for auto-update.
 * It is stored per-machine under %APPDATA%\Grow Board instead, obfuscated so
 * it is not casually readable, and entered once on the Settings page.
 *
 * Obfuscation is not encryption. It stops a password being read over someone's
 * shoulder or found by grepping a text file; it is not protection against
 * someone with access to the machine, and it is not claimed to be. The login it
 * protects is read-only and reachable only on the shop's own network.
 */
'use strict';

const crypto = require('crypto');
const os = require('os');

const KEY = crypto.createHash('sha256')
  .update('grow-board:' + os.hostname() + ':' + (process.env.USERNAME || 'user'))
  .digest();

function seal(plain) {
  if (!plain) return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function open(sealed) {
  if (!sealed) return '';
  try {
    const raw = Buffer.from(sealed, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    // Machine or user changed - the stored value is unusable, ask again.
    return '';
  }
}

module.exports = { seal, open };
