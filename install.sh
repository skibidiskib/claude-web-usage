#!/bin/bash
#
# claude-web-usage installer
# Installs the statusline scripts and configures Claude Code.
#
# Usage: bash install.sh
#        chmod +x install.sh && ./install.sh
#
# This script is safe and non-destructive:
# - Backs up existing files before overwriting
# - Backs up settings.json before modifying
# - Does not delete anything
# - Can be run multiple times safely

set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE_DIR="$HOME/.claude"
CACHE_DIR="$HOME/.cache"
SETTINGS_FILE="$CLAUDE_DIR/settings.json"
COOKIE_DB="$HOME/Library/Application Support/Claude/Cookies"

echo -e "${BOLD}${CYAN}"
echo "  ┌─────────────────────────────────────────┐"
echo "  │       claude-web-usage installer         │"
echo "  │  Usage monitoring via web session cookies │"
echo "  └─────────────────────────────────────────┘"
echo -e "${NC}"

# ─── Step 1: Check prerequisites ───

echo -e "${BOLD}[1/6] Checking prerequisites...${NC}"

# macOS check
if [[ "$(uname)" != "Darwin" ]]; then
  echo -e "${RED}ERROR: This tool is macOS-only (requires Keychain and Chromium cookie decryption).${NC}"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} macOS detected"

# Node.js check
if ! command -v node &>/dev/null; then
  echo -e "${RED}ERROR: Node.js is required but not installed.${NC}"
  echo "  Install via: brew install node"
  exit 1
fi
NODE_VERSION=$(node -v | sed 's/v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo -e "${YELLOW}WARNING: Node.js >= 18 recommended (found v${NODE_VERSION}).${NC}"
else
  echo -e "  ${GREEN}✓${NC} Node.js v${NODE_VERSION}"
fi

# Claude Code check
if ! command -v claude &>/dev/null; then
  echo -e "${YELLOW}WARNING: Claude Code CLI not found in PATH. The statusline will only work within Claude Code sessions.${NC}"
else
  echo -e "  ${GREEN}✓${NC} Claude Code CLI found"
fi

# Claude Desktop check
if [[ ! -f "$COOKIE_DB" ]]; then
  echo -e "${RED}ERROR: Claude Desktop cookies not found at:${NC}"
  echo "  $COOKIE_DB"
  echo ""
  echo "  Make sure Claude Desktop app is installed and you have logged in at least once."
  echo "  Download: https://claude.ai/download"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Claude Desktop cookies found"

# sqlite3 check
if ! command -v sqlite3 &>/dev/null; then
  echo -e "${RED}ERROR: sqlite3 is required but not found.${NC}"
  echo "  It should be pre-installed on macOS. Try: xcode-select --install"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} sqlite3 available"

echo ""

# ─── Step 2: Copy scripts ───

echo -e "${BOLD}[2/6] Installing scripts to ${CLAUDE_DIR}/...${NC}"

mkdir -p "$CLAUDE_DIR"
mkdir -p "$CACHE_DIR"

for script in combined-statusline.js web-usage-fetch.js debug-cookies.js; do
  TARGET="$CLAUDE_DIR/$script"
  if [[ -f "$TARGET" ]]; then
    BACKUP="${TARGET}.backup.$(date +%Y%m%d%H%M%S)"
    cp "$TARGET" "$BACKUP"
    echo -e "  ${YELLOW}→${NC} Backed up existing $script to $(basename "$BACKUP")"
  fi
  cp "$SCRIPT_DIR/$script" "$TARGET"
  chmod +x "$TARGET"
  echo -e "  ${GREEN}✓${NC} Installed $script"
done

echo ""

# ─── Step 3: Update settings.json ───

echo -e "${BOLD}[3/6] Configuring Claude Code settings...${NC}"

STATUSLINE_CMD="node $HOME/.claude/combined-statusline.js"

if [[ -f "$SETTINGS_FILE" ]]; then
  # Check if statusLine is already configured
  if grep -q "combined-statusline" "$SETTINGS_FILE" 2>/dev/null; then
    echo -e "  ${GREEN}✓${NC} statusLine already configured in settings.json"
  else
    # Backup settings
    BACKUP="${SETTINGS_FILE}.backup.$(date +%Y%m%d%H%M%S)"
    cp "$SETTINGS_FILE" "$BACKUP"
    echo -e "  ${YELLOW}→${NC} Backed up settings.json to $(basename "$BACKUP")"

    # Use node to safely modify JSON
    node -e "
      const fs = require('fs');
      const settings = JSON.parse(fs.readFileSync('$SETTINGS_FILE', 'utf8'));
      if (!settings.statusLine) settings.statusLine = {};
      settings.statusLine.command = '$STATUSLINE_CMD';
      fs.writeFileSync('$SETTINGS_FILE', JSON.stringify(settings, null, 2) + '\n');
    "
    echo -e "  ${GREEN}✓${NC} Updated statusLine.command in settings.json"
  fi
else
  # Create new settings file
  cat > "$SETTINGS_FILE" << JSONEOF
{
  "statusLine": {
    "command": "$STATUSLINE_CMD"
  }
}
JSONEOF
  echo -e "  ${GREEN}✓${NC} Created settings.json with statusLine config"
fi

echo ""

# ─── Step 4: Test cookie decryption ───

echo -e "${BOLD}[4/6] Testing cookie decryption...${NC}"

COOKIE_TEST=$(node -e "
  const crypto = require('crypto');
  const { execSync } = require('child_process');
  try {
    const pw = execSync('security find-generic-password -s \"Claude Safe Storage\" -w 2>/dev/null', { encoding: 'utf8' }).trim();
    const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
    const db = '$COOKIE_DB';
    const hex = execSync(\`sqlite3 '\${db}' \"SELECT hex(encrypted_value) FROM cookies WHERE host_key = '.claude.ai' AND name = 'sessionKey' LIMIT 1;\"\`, { encoding: 'utf8' }).trim();
    if (!hex) { console.log('NO_COOKIE'); process.exit(0); }
    const buf = Buffer.from(hex, 'hex');
    if (buf.slice(0, 3).toString() !== 'v10') { console.log('BAD_VERSION'); process.exit(0); }
    const iv = Buffer.alloc(16, 0x20);
    const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
    const dec = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
    const value = dec.slice(32).toString('utf8');
    if (value.startsWith('sk-ant-sid')) console.log('OK');
    else console.log('UNEXPECTED_FORMAT');
  } catch (e) {
    console.log('ERROR:' + e.message);
  }
" 2>/dev/null)

case "$COOKIE_TEST" in
  OK)
    echo -e "  ${GREEN}✓${NC} Cookie decryption successful (sessionKey starts with sk-ant-sid)"
    ;;
  NO_COOKIE)
    echo -e "  ${RED}✗${NC} sessionKey cookie not found. Log in to claude.ai in Claude Desktop app."
    ;;
  BAD_VERSION)
    echo -e "  ${RED}✗${NC} Unexpected cookie encryption version (expected v10)."
    ;;
  UNEXPECTED_FORMAT)
    echo -e "  ${YELLOW}!${NC} Cookie decrypted but format is unexpected. May still work."
    ;;
  *)
    echo -e "  ${RED}✗${NC} Cookie decryption failed: $COOKIE_TEST"
    ;;
esac

echo ""

# ─── Step 5: Test web API ───

echo -e "${BOLD}[5/6] Testing web API call...${NC}"

API_TEST=$(node -e "
  const crypto = require('crypto');
  const { execSync } = require('child_process');
  const https = require('https');
  try {
    const pw = execSync('security find-generic-password -s \"Claude Safe Storage\" -w 2>/dev/null', { encoding: 'utf8' }).trim();
    const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
    const db = '$COOKIE_DB';
    function getCookie(name) {
      const hex = execSync(\`sqlite3 '\${db}' \"SELECT hex(encrypted_value) FROM cookies WHERE host_key = '.claude.ai' AND name = '\${name}' LIMIT 1;\"\`, { encoding: 'utf8' }).trim();
      if (!hex) return null;
      const buf = Buffer.from(hex, 'hex');
      if (buf.slice(0, 3).toString() !== 'v10') return null;
      const iv = Buffer.alloc(16, 0x20);
      const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
      const dec = Buffer.concat([decipher.update(buf.slice(3)), decipher.final()]);
      return dec.slice(32).toString('utf8');
    }
    const sessionKey = getCookie('sessionKey');
    const orgId = getCookie('lastActiveOrg');
    const cfClearance = getCookie('cf_clearance');
    if (!sessionKey || !orgId) { console.log('MISSING_COOKIES'); process.exit(0); }
    let cookieStr = \`sessionKey=\${sessionKey}; lastActiveOrg=\${orgId}\`;
    if (cfClearance) cookieStr += \`; cf_clearance=\${cfClearance}\`;
    const req = https.request({
      hostname: 'claude.ai',
      path: \`/api/organizations/\${orgId}/usage\`,
      method: 'GET',
      headers: {
        'Cookie': cookieStr,
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const j = JSON.parse(data);
            if (j.five_hour) console.log('OK:' + j.five_hour.utilization);
            else console.log('OK_NO_DATA');
          } catch { console.log('PARSE_ERROR'); }
        } else {
          console.log('HTTP_' + res.statusCode);
        }
      });
    });
    req.on('error', (e) => console.log('NET_ERROR:' + e.message));
    req.on('timeout', () => { req.destroy(); console.log('TIMEOUT'); });
    req.end();
  } catch (e) {
    console.log('ERROR:' + e.message);
  }
" 2>/dev/null)

# Wait a moment for the async request to complete
sleep 2

case "$API_TEST" in
  OK:*)
    UTIL="${API_TEST#OK:}"
    echo -e "  ${GREEN}✓${NC} Web API call successful! Current 5-hour utilization: ${UTIL}%"
    ;;
  OK_NO_DATA)
    echo -e "  ${GREEN}✓${NC} Web API responded but no usage data yet. This is normal for new sessions."
    ;;
  MISSING_COOKIES)
    echo -e "  ${RED}✗${NC} Missing required cookies. Log in to claude.ai in Claude Desktop app."
    ;;
  HTTP_403)
    echo -e "  ${YELLOW}!${NC} Got 403 Forbidden. Cloudflare may be blocking. Try opening claude.ai in Claude Desktop to refresh cookies."
    ;;
  HTTP_401)
    echo -e "  ${RED}✗${NC} Got 401 Unauthorized. Session may be expired. Log in again to claude.ai in Claude Desktop."
    ;;
  TIMEOUT)
    echo -e "  ${YELLOW}!${NC} Request timed out. Check your network connection."
    ;;
  NET_ERROR:*)
    echo -e "  ${RED}✗${NC} Network error: ${API_TEST#NET_ERROR:}"
    ;;
  *)
    echo -e "  ${YELLOW}!${NC} Unexpected result: $API_TEST"
    ;;
esac

echo ""

# ─── Step 6: Summary ───

echo -e "${BOLD}[6/6] Installation summary${NC}"
echo ""
echo -e "  ${BOLD}Installed files:${NC}"
echo "    $CLAUDE_DIR/combined-statusline.js"
echo "    $CLAUDE_DIR/web-usage-fetch.js"
echo "    $CLAUDE_DIR/debug-cookies.js"
echo ""
echo -e "  ${BOLD}Settings:${NC}"
echo "    $SETTINGS_FILE"
echo ""
echo -e "  ${BOLD}Cache directory:${NC}"
echo "    $CACHE_DIR/ccstatusline-api.json"
echo ""
echo -e "  ${BOLD}Debug tools:${NC}"
echo "    node ~/.claude/debug-cookies.js    # Debug cookie decryption"
echo "    node ~/.claude/web-usage-fetch.js  # Test API call with verbose output"
echo ""

if [[ "$COOKIE_TEST" == "OK" ]]; then
  echo -e "${GREEN}${BOLD}Installation complete!${NC} Restart Claude Code to see the statusline."
else
  echo -e "${YELLOW}${BOLD}Installation complete with warnings.${NC} See above for issues to resolve."
fi
echo ""
