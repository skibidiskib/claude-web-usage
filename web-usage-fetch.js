#!/usr/bin/env node

// claude-web-usage: web-usage-fetch.js
// Standalone debug/test script that fetches usage data from the claude.ai web API
// using Claude Desktop app cookies. Outputs verbose diagnostic information to stderr
// and the final JSON result to stdout.
//
// Usage: node web-usage-fetch.js
// No npm dependencies — uses only Node.js built-in modules.

const crypto = require('crypto');
const { execSync } = require('child_process');
const https = require('https');

const COOKIE_DB = process.env.HOME + '/Library/Application Support/Claude/Cookies';
const KEYCHAIN_SERVICE = 'Claude Safe Storage';

// Chromium v10 cookies on macOS have a 32-byte prefix after decryption
// (likely an internal nonce/hash). The actual cookie value starts at byte 32.
const DECRYPTED_PREFIX_LEN = 32;

let encryptionKey = null;

function getEncryptionKey() {
  if (encryptionKey) return encryptionKey;
  const password = execSync(
    `security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`,
    { encoding: 'utf8' }
  ).trim();
  encryptionKey = crypto.pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1');
  return encryptionKey;
}

function decryptCookie(encryptedBuffer) {
  if (encryptedBuffer.slice(0, 3).toString() !== 'v10') {
    throw new Error('Unknown cookie encryption version');
  }
  const key = getEncryptionKey();
  const data = encryptedBuffer.slice(3);
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const dec = Buffer.concat([decipher.update(data), decipher.final()]);
  // Strip 32-byte binary prefix to get the actual cookie value
  return dec.slice(DECRYPTED_PREFIX_LEN).toString('utf8');
}

function getCookie(name) {
  const sql = `SELECT hex(encrypted_value) FROM cookies WHERE host_key = '.claude.ai' AND name = '${name}' LIMIT 1;`;
  const hex = execSync(`sqlite3 '${COOKIE_DB}' "${sql}"`, { encoding: 'utf8' }).trim();
  if (!hex) throw new Error(`Cookie '${name}' not found`);
  return decryptCookie(Buffer.from(hex, 'hex'));
}

function httpGet(hostname, path, headers) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', headers, timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  try {
    const sessionKey = getCookie('sessionKey');
    const orgId = getCookie('lastActiveOrg');

    console.error('sessionKey:', sessionKey.slice(0, 20) + '...');
    console.error('orgId:', orgId);

    const headers = {
      'Cookie': `sessionKey=${sessionKey}; lastActiveOrg=${orgId}`,
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    };

    // Step 1: Verify auth by getting organizations
    console.error('\nTrying /api/organizations...');
    try {
      const orgs = await httpGet('claude.ai', '/api/organizations', headers);
      console.error('Orgs response:', JSON.stringify(orgs).slice(0, 300));
    } catch (e) {
      console.error('Orgs error:', e.message);
    }

    // Step 2: Try rate_limits endpoint
    console.error('\nTrying /api/organizations/' + orgId + '/rate_limits...');
    try {
      const data = await httpGet('claude.ai', `/api/organizations/${orgId}/rate_limits`, headers);
      console.error('rate_limits:', JSON.stringify(data).slice(0, 500));
      const result = parseUsageData(data);
      if (result) { console.log(JSON.stringify(result, null, 2)); return; }
    } catch (e) {
      console.error('rate_limits error:', e.message.slice(0, 300));
    }

    // Step 3: Try usage endpoint
    console.error('\nTrying /api/organizations/' + orgId + '/usage...');
    try {
      const data = await httpGet('claude.ai', `/api/organizations/${orgId}/usage`, headers);
      console.error('usage:', JSON.stringify(data).slice(0, 500));
      const result = parseUsageData(data);
      if (result) { console.log(JSON.stringify(result, null, 2)); return; }
    } catch (e) {
      console.error('usage error:', e.message.slice(0, 300));
    }

    // Step 4: Try settings
    console.error('\nTrying /api/organizations/' + orgId + '/settings...');
    try {
      const data = await httpGet('claude.ai', `/api/organizations/${orgId}/settings`, headers);
      console.error('settings:', JSON.stringify(data).slice(0, 500));
    } catch (e) {
      console.error('settings error:', e.message.slice(0, 300));
    }

    console.log(JSON.stringify({ error: 'no-data' }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
  }
}

function parseUsageData(data) {
  if (!data) return null;
  const result = {};

  if (data.five_hour) {
    result.sessionUsage = data.five_hour.utilization;
    result.sessionResetAt = data.five_hour.resets_at;
  }
  if (data.seven_day) {
    result.weeklyUsage = data.seven_day.utilization;
  }
  if (data.standard?.rate_limit) {
    const rl = data.standard.rate_limit;
    if (rl.five_hour) { result.sessionUsage = rl.five_hour.utilization; result.sessionResetAt = rl.five_hour.resets_at; }
    if (rl.seven_day) { result.weeklyUsage = rl.seven_day.utilization; }
  }
  if (Array.isArray(data)) {
    for (const item of data) {
      if (item.type === 'five_hour' || item.window === 'five_hour') { result.sessionUsage = item.utilization; result.sessionResetAt = item.resets_at; }
      if (item.type === 'seven_day' || item.window === 'seven_day') { result.weeklyUsage = item.utilization; }
    }
  }

  if (result.sessionUsage !== undefined || result.weeklyUsage !== undefined) return result;
  return null;
}

main();
