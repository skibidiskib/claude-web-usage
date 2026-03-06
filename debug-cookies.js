#!/usr/bin/env node

// claude-web-usage: debug-cookies.js
// Cookie decryption debug tool that shows raw hex bytes, decrypted lengths,
// and helps diagnose cookie decryption issues.
//
// Usage: node debug-cookies.js
// No npm dependencies — uses only Node.js built-in modules.

const crypto = require('crypto');
const { execSync } = require('child_process');

const pw = execSync('security find-generic-password -s "Claude Safe Storage" -w 2>/dev/null', { encoding: 'utf8' }).trim();
const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
const COOKIE_DB = process.env.HOME + '/Library/Application Support/Claude/Cookies';

function getHex(name) {
  const sql = `SELECT hex(encrypted_value) FROM cookies WHERE host_key = '.claude.ai' AND name = '${name}' LIMIT 1;`;
  return execSync(`sqlite3 '${COOKIE_DB}' "${sql}"`, { encoding: 'utf8' }).trim();
}

function decrypt(name) {
  const hex = getHex(name);
  if (!hex) {
    console.log(`\n=== ${name} ===`);
    console.log('NOT FOUND in cookie database');
    return null;
  }
  const buf = Buffer.from(hex, 'hex');
  console.log(`\n=== ${name} ===`);
  console.log('Raw length:', buf.length, '| Prefix:', buf.slice(0, 3).toString());

  const data = buf.slice(3); // strip "v10"
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);

  console.log('Decrypted length:', dec.length);
  console.log('Hex:', dec.toString('hex'));
  console.log('Raw UTF8:', JSON.stringify(dec.toString('utf8')));

  // Find where printable ASCII starts
  let asciiStart = -1;
  for (let i = 0; i < dec.length; i++) {
    if (dec[i] >= 0x20 && dec[i] <= 0x7e) {
      asciiStart = i;
      break;
    }
  }
  if (asciiStart >= 0) {
    console.log('ASCII start offset:', asciiStart);
    console.log('Clean value:', dec.slice(asciiStart).toString('utf8'));
  }

  return dec;
}

console.log('Claude Desktop Cookie Debugger');
console.log('==============================');
console.log('Cookie DB:', COOKIE_DB);
console.log('Keychain password retrieved: YES (length:', pw.length, ')');
console.log('AES-128-CBC key derived: YES');

decrypt('sessionKey');
decrypt('lastActiveOrg');
decrypt('cf_clearance');
