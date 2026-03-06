# Troubleshooting Guide

This guide covers common issues with `claude-web-usage` and how to resolve them.

---

## Quick Diagnostics

Run these commands to diagnose most issues:

```bash
# 1. Test cookie decryption
node ~/.claude/debug-cookies.js

# 2. Test web API call
node ~/.claude/web-usage-fetch.js

# 3. Check cached data
cat ~/.cache/ccstatusline-api.json 2>/dev/null || echo "No cache file"

# 4. Check lock file age
ls -la ~/.cache/ccstatusline-api.lock 2>/dev/null || echo "No lock file"

# 5. Verify settings
cat ~/.claude/settings.json 2>/dev/null | grep statusLine
```

---

## Cookie Decryption Failures

### "security: SecKeychainSearchCopyNext: The specified item could not be found"

**Cause:** Claude Desktop has never been installed or has never stored its encryption key in the Keychain.

**Fix:**
1. Install [Claude Desktop](https://claude.ai/download)
2. Open the app and log in to claude.ai
3. Close and reopen the app to ensure cookies are written
4. Try again

### "Error: SQLITE_ERROR: no such table: cookies"

**Cause:** The cookie database exists but is empty or corrupted.

**Fix:**
1. Close Claude Desktop completely
2. Reopen Claude Desktop and log in
3. The cookie database will be recreated

### "Error: SQLITE_BUSY: database is locked"

**Cause:** Claude Desktop is actively writing to the cookie database at the same moment.

**Fix:** This is transient. The script will fall back to cached data and retry on the next invocation. If it persists:
1. Close Claude Desktop
2. Run the debug tool: `node debug-cookies.js`
3. Reopen Claude Desktop

### "Unknown cookie encryption version"

**Cause:** The encrypted cookie does not start with the `v10` prefix, which is the standard Chromium encryption version on macOS.

**Possible causes:**
- Claude Desktop updated to a newer Chromium version with different encryption
- The cookie database is from a different platform
- Database corruption

**Fix:**
1. Run `node debug-cookies.js` to see the raw bytes
2. Check for updates to this tool
3. File an issue with the raw prefix bytes (first 3 bytes of the encrypted value)

### Cookie decrypted but value looks wrong

**Cause:** The 32-byte binary prefix stripping may not be correct for your version.

**Fix:**
1. Run `node debug-cookies.js`
2. Look at the "ASCII start offset" — it should be 32
3. If it's different, update `DECRYPTED_PREFIX_LEN` in the scripts
4. The "Clean value" output shows what the script will use

---

## Cloudflare 403 Errors

### "HTTP 403" from web-usage-fetch.js

**Cause:** Cloudflare is blocking the request. This usually means the `cf_clearance` cookie is missing or expired.

**Why this happens:**
- Cloudflare issues `cf_clearance` cookies after a browser challenge
- The cookie is tied to the TLS fingerprint of the connection that received it
- If the cookie expires, new requests get blocked until a new challenge is passed

**Fix:**
1. Open Claude Desktop app
2. Navigate to any page on claude.ai (this triggers a Cloudflare challenge refresh)
3. Wait 10-20 seconds for the new `cf_clearance` cookie to be written
4. Try again

**Important:** The HTTPS request **must** be made in-process (not via `curl` or a child process). This is already handled correctly by `combined-statusline.js`. If you're building a custom integration, see the "Cloudflare Gotcha" section in the README.

### Cloudflare 403 with curl but works with the script

This is expected behavior. `curl` and child processes use different TLS fingerprints than the parent Node.js process. The `cf_clearance` cookie is bound to the original TLS fingerprint. Always use in-process `https.request()`.

---

## Claude Desktop Issues

### "Cookie 'sessionKey' not found"

**Cause:** You are not logged in to claude.ai in Claude Desktop, or the session has expired.

**Fix:**
1. Open Claude Desktop
2. If prompted, log in to your Anthropic account
3. Use Claude Desktop normally for a moment to ensure the session is active
4. Try again

### "Cookie 'lastActiveOrg' not found"

**Cause:** You have logged in but haven't selected an organization, or this is a brand new account.

**Fix:**
1. Open Claude Desktop
2. Go to Settings and verify your organization
3. Start a conversation to ensure the org cookie is set

### Session expired (401 Unauthorized)

**Cause:** Your web session has expired. Claude Desktop sessions expire after a period of inactivity.

**Fix:**
1. Open Claude Desktop
2. Log in again if prompted
3. The statusline will automatically pick up the new session cookies

**Note:** The statusline script gracefully handles expired sessions — it falls back to cached data and shows the last-known values. You won't see errors in Claude Code, just stale numbers.

---

## Cache Issues

### Stale data (numbers not updating)

**Cause:** The cache file might be stuck, or the lock file is preventing refreshes.

**Fix:**
```bash
# Clear both cache and lock
rm -f ~/.cache/ccstatusline-api.json ~/.cache/ccstatusline-api.lock
```

The next statusline invocation will fetch fresh data.

### Cache directory doesn't exist

**Cause:** `~/.cache/` was deleted or never created.

**Fix:**
```bash
mkdir -p ~/.cache
```

The script also creates this directory automatically if it's missing.

### Lock file preventing updates

**Cause:** A previous script invocation crashed while holding the lock, and the lock file is less than 15 seconds old.

**Fix:** Wait 15 seconds (the lock auto-expires) or delete it manually:

```bash
rm -f ~/.cache/ccstatusline-api.lock
```

---

## Weekly Cost Not Showing

### Shows "$-" for weekly cost

**Cause:** `ccusage` is not installed, or its background calculation hasn't completed yet.

**Fix:**
1. Install ccusage: `npm install -g ccusage`
2. Verify it works: `ccusage daily -j`
3. Wait up to 60 seconds for the background calculation to complete
4. The cost will appear on the next statusline refresh

### Cost is $0.00 but you've been using Claude

**Cause:** ccusage may not have data for the current billing period, or its data source is out of sync.

**Fix:**
1. Check ccusage directly: `ccusage daily -j`
2. Clear the cost cache: `rm -f /tmp/ccusage-weekly-cost.json /tmp/ccusage-weekly-cost.lock`
3. The background process will recalculate on the next invocation

---

## Status Bar Issues

### Status bar not appearing in Claude Code

**Cause:** `settings.json` not configured correctly.

**Fix:**
1. Check the file exists and has the right content:
```bash
cat ~/.claude/settings.json
```
2. It should contain:
```json
{
  "statusLine": {
    "command": "node /Users/yourname/.claude/combined-statusline.js"
  }
}
```
3. Restart Claude Code after changing settings

### Status bar shows "Unknown" for model

**Cause:** Claude Code is not piping session JSON to the script, or the JSON format has changed.

**Fix:** This usually resolves itself on the next Claude Code session. If persistent, verify the script works with mock input:

```bash
echo '{"model":{"display_name":"Opus 4.6"},"context_window":{"used_percentage":50,"context_window_size":200000}}' | node ~/.claude/combined-statusline.js
```

### Script timeout (status bar disappears)

**Cause:** The script has a 10-second safety timeout. If cookie decryption, SQLite queries, or the API call takes too long, it exits.

**Common reasons:**
- SQLite database locked (Claude Desktop writing)
- Network issues (API call hanging)
- Keychain prompt blocking (first-time access)

**Fix:**
1. First run may trigger a macOS Keychain access prompt — allow it
2. Check network connectivity
3. Clear the lock file: `rm -f ~/.cache/ccstatusline-api.lock`

---

## OAuth Rate Limiting Symptoms (What This Tool Fixes)

If you're seeing these symptoms, they confirm the OAuth rate limiting problem that this tool solves:

| Symptom | OAuth API | Web API (this tool) |
|---------|-----------|---------------------|
| Usage data goes blank with 3+ sessions | Yes | No |
| `429 Too Many Requests` in logs | Yes | No |
| Usage shows for a few minutes then disappears | Yes | No |
| Only works with 1 session open | Yes | Works with any count |
| Restarting Claude Code temporarily fixes it | Yes | N/A — always works |

If you're still seeing blank usage data after installing this tool, check:
1. Is `settings.json` correctly configured?
2. Run `node ~/.claude/web-usage-fetch.js` — does it return data?
3. Check `~/.cache/ccstatusline-api.json` — is it being written?

---

## Getting Help

If none of the above resolves your issue:

1. Run all diagnostic commands from the "Quick Diagnostics" section above
2. Run `node debug-cookies.js 2>&1` and note the output
3. Run `node web-usage-fetch.js 2>&1` and note the output
4. File an issue with the diagnostic output (redact any cookie values or tokens)

**Never share your actual cookie values (`sk-ant-sid01-...`).** They grant full access to your Claude account.
