#!/usr/bin/env node

// claude-web-usage: combined-statusline.js
// Main statusline script for Claude Code status bar.
// Reads session JSON from stdin, decrypts Claude Desktop cookies,
// calls claude.ai web API for usage data, and outputs a 3-line emoji format.
//
// Usage: Configured in ~/.claude/settings.json as statusLine.command
// No npm dependencies — uses only Node.js built-in modules.

const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Global safety timeout — kill the process if it hangs
let scriptCompleted = false;
setTimeout(() => { if (!scriptCompleted) process.exit(1); }, 10000);

// === Cache config ===
const CACHE_DIR = path.join(os.homedir(), '.cache');
const API_CACHE = path.join(CACHE_DIR, 'ccstatusline-api.json');
const API_LOCK = path.join(CACHE_DIR, 'ccstatusline-api.lock');
const CACHE_MAX_AGE = 30;  // seconds
const LOCK_MAX_AGE = 15;   // seconds

// === Cookie decryption for Claude Desktop web API ===
const COOKIE_DB = os.homedir() + '/Library/Application Support/Claude/Cookies';
const KEYCHAIN_SERVICE = 'Claude Safe Storage';
const DECRYPTED_PREFIX_LEN = 32;

let encKey = null;
function getEncKey() {
  if (encKey) return encKey;
  const pw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`, { encoding: 'utf8' }).trim();
  encKey = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  return encKey;
}

function decryptCookie(name) {
  const sql = `SELECT hex(encrypted_value) FROM cookies WHERE host_key = '.claude.ai' AND name = '${name}' LIMIT 1;`;
  const hex = execSync(`sqlite3 '${COOKIE_DB}' "${sql}"`, { encoding: 'utf8' }).trim();
  if (!hex) return null;
  const buf = Buffer.from(hex, 'hex');
  if (buf.slice(0, 3).toString() !== 'v10') return null;
  const key = getEncKey();
  const iv = Buffer.alloc(16, 0x20);
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  const dec = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
  return dec.slice(DECRYPTED_PREFIX_LEN).toString('utf8');
}

// === Fetch usage from claude.ai web API (in-process, avoids Cloudflare issues) ===
function fetchWebUsage() {
  return new Promise((resolve) => {
    try {
      const sessionKey = decryptCookie('sessionKey');
      const orgId = decryptCookie('lastActiveOrg');
      const cfClearance = decryptCookie('cf_clearance');
      if (!sessionKey || !orgId) { resolve(null); return; }

      let cookieStr = `sessionKey=${sessionKey}; lastActiveOrg=${orgId}`;
      if (cfClearance) cookieStr += `; cf_clearance=${cfClearance}`;

      const req = https.request({
        hostname: 'claude.ai',
        path: `/api/organizations/${orgId}/usage`,
        method: 'GET',
        headers: {
          'Cookie': cookieStr,
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        },
        timeout: 5000
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try {
            const parsed = JSON.parse(data);
            const result = {};
            if (parsed.five_hour) { result.sessionUsage = parsed.five_hour.utilization; result.sessionResetAt = parsed.five_hour.resets_at; }
            if (parsed.seven_day) { result.weeklyUsage = parsed.seven_day.utilization; }
            if (result.sessionUsage !== undefined || result.weeklyUsage !== undefined) resolve(result);
            else resolve(null);
          } catch { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => { req.destroy(); resolve(null); });
      req.end();
    } catch { resolve(null); }
  });
}

// === Get API usage with caching ===
async function getApiUsage() {
  const now = Math.floor(Date.now() / 1000);

  // Read existing cache
  let cached = null;
  try {
    const stat = fs.statSync(API_CACHE);
    const fileAge = now - Math.floor(stat.mtimeMs / 1000);
    cached = JSON.parse(fs.readFileSync(API_CACHE, 'utf8'));
    if (fileAge < CACHE_MAX_AGE && !cached.error) return cached;
  } catch {}

  // Check lock
  try {
    const lockAge = now - Math.floor(fs.statSync(API_LOCK).mtimeMs / 1000);
    if (lockAge < LOCK_MAX_AGE) return cached;
  } catch {}

  // Touch lock
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(API_LOCK, '');
  } catch {}

  // Fetch from web API (in-process, not rate-limited by Claude Code sessions)
  const webData = await fetchWebUsage();
  if (webData) {
    try { fs.writeFileSync(API_CACHE, JSON.stringify(webData)); } catch {}
    return webData;
  }

  return cached;
}

// === Weekly Cost Cache (via ccusage CLI tool) ===
const WEEKLY_COST_CACHE = '/tmp/ccusage-weekly-cost.json';
const WEEKLY_COST_LOCK = '/tmp/ccusage-weekly-cost.lock';

function getWeeklyResetDate() {
  const now = new Date();
  const dayUTC = now.getUTCDay(), hourUTC = now.getUTCHours();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0));
  if (dayUTC === 5 && hourUTC >= 3) next.setUTCDate(next.getUTCDate() + 7);
  else if (dayUTC !== 5) { let d = (5 - dayUTC + 7) % 7; if (d === 0) d = 7; next.setUTCDate(next.getUTCDate() + d); }
  return next;
}

function getWeeklySinceDate() {
  const now = new Date();
  const dayUTC = now.getUTCDay(), hourUTC = now.getUTCHours();
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0, 0));
  if (dayUTC === 5 && hourUTC < 3) last.setUTCDate(last.getUTCDate() - 7);
  else if (dayUTC !== 5) { let d = (dayUTC - 5 + 7) % 7; if (d === 0) d = 7; last.setUTCDate(last.getUTCDate() - d); }
  return last.toISOString().slice(0, 10).replace(/-/g, '');
}

function getWeeklyCost() {
  let cost = null;
  try {
    const cached = JSON.parse(fs.readFileSync(WEEKLY_COST_CACHE, 'utf8'));
    cost = cached.cost;
    if (Date.now() - cached.timestamp < 5 * 60 * 1000) return cost;
  } catch {}
  try { if (Date.now() - fs.statSync(WEEKLY_COST_LOCK).mtimeMs < 60000) return cost; } catch {}
  const sinceDate = getWeeklySinceDate();
  const untilDate = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const script = `
    const { execSync } = require('child_process');
    const fs = require('fs');
    try {
      fs.writeFileSync('${WEEKLY_COST_LOCK}', String(process.pid));
      const stdout = execSync('ccusage daily -s ${sinceDate} -u ${untilDate} -j 2>/dev/null', { timeout: 60000 });
      const data = JSON.parse(stdout);
      let totalCost = 0;
      if (data && Array.isArray(data.daily)) { for (const day of data.daily) totalCost += day.totalCost || 0; }
      fs.writeFileSync('${WEEKLY_COST_CACHE}', JSON.stringify({ cost: totalCost, timestamp: Date.now() }));
    } catch (e) {}
    try { fs.unlinkSync('${WEEKLY_COST_LOCK}'); } catch (e) {}
  `;
  const child = spawn('node', ['-e', script], { detached: true, stdio: 'ignore' });
  child.unref();
  return cost;
}

// === Format time remaining ===
function formatTimeLeft(ms) {
  if (ms <= 0) return '0h 0m left';
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h ${minutes}m left`;
  return `${hours}h ${minutes}m left`;
}

// === Main ===
async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const sessionObj = JSON.parse(Buffer.concat(chunks).toString());

  const model = sessionObj.model?.display_name || 'Unknown';

  let gitBranch = '';
  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD 2>/dev/null', { encoding: 'utf8', timeout: 3000 }).trim();
    if (gitBranch) gitBranch = ` [${gitBranch}]`;
  } catch {}

  const ctxPercent = sessionObj.context_window?.used_percentage;
  const ctxSize = sessionObj.context_window?.context_window_size || 200000;
  let contextTokens = '-', contextPct = '-';
  if (ctxPercent > 0) {
    const used = Math.round((ctxPercent / 100) * ctxSize);
    contextTokens = used >= 1000 ? Math.round(used / 1000) + 'K' : String(used);
    contextPct = Math.round(ctxPercent);
  }

  const api = await getApiUsage();
  let blockPercent = '-', blockTime = '-';
  if (api?.sessionUsage !== undefined) blockPercent = api.sessionUsage.toFixed(0);
  if (api?.sessionResetAt) blockTime = formatTimeLeft(new Date(api.sessionResetAt).getTime() - Date.now());

  const weeklyCost = getWeeklyCost();
  const costStr = weeklyCost !== null ? `$${weeklyCost.toFixed(2)}` : '$-';
  let weeklyLine = 'unavailable';
  if (api?.weeklyUsage !== undefined) {
    const weeklyResetMs = getWeeklyResetDate().getTime() - Date.now();
    weeklyLine = `${api.weeklyUsage.toFixed(1)}% / ${costStr} | (${formatTimeLeft(weeklyResetMs)})`;
  } else {
    weeklyLine = `- / ${costStr} | (-)`;
  }

  console.log([
    `\u{1F680} ${model}${gitBranch}`,
    `\u2705 ${contextTokens} (${contextPct}%) | ${blockPercent}% (${blockTime})`,
    `\u{1F7E2} ${weeklyLine}`
  ].join('\n'));
  scriptCompleted = true;
}

main().catch(() => {
  console.log('\u{1F680} Unknown\n\u2705 - (-%) | -% (-)\n\u{1F7E2} unavailable');
  scriptCompleted = true;
});
