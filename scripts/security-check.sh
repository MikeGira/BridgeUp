#!/bin/bash
# BridgeUp Security Pre-Deploy Checklist
# Run: chmod +x scripts/security-check.sh && ./scripts/security-check.sh

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

PASS=0
WARN=0
FAIL=0

check_pass() { echo -e "${GREEN}✓${NC} $1"; ((PASS++)); }
check_warn() { echo -e "${YELLOW}⚠${NC} $1"; ((WARN++)); }
check_fail() { echo -e "${RED}✗${NC} $1"; ((FAIL++)); }

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║  BridgeUp Security Check                 ║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# ─── 1. Secrets in code ──────────────────────────────────────────────────────
echo "1. Checking for hardcoded secrets..."
if grep -rn --include="*.js" --include="*.ts" --include="*.tsx" \
   -E "(password\s*[:=]\s*['\"][^'\"]{6,}['\"]|SUPABASE_SERVICE_KEY\s*=\s*['\"][^'\"]{10,}|sk_live_|api_key\s*[:=]\s*['\"][^'\"]{10,})" \
   --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git . 2>/dev/null; then
  check_fail "Possible hardcoded secrets found — review above lines"
else
  check_pass "No hardcoded secrets in source code"
fi

# ─── 2. .env not in git ──────────────────────────────────────────────────────
echo ""
echo "2. Checking .env not tracked by git..."
if git ls-files 2>/dev/null | grep -qE "^\.env$|^\.env\."; then
  check_fail ".env file is tracked by git — remove it: git rm --cached .env"
else
  check_pass ".env files not tracked by git"
fi

if grep -q ".env" .gitignore 2>/dev/null; then
  check_pass ".env is in .gitignore"
else
  check_warn ".env may not be in .gitignore — verify"
fi

# ─── 3. Environment variables in code ────────────────────────────────────────
echo ""
echo "3. Checking env var usage..."
if grep -rn --include="*.js" "process.env.SESSION_SECRET\|process.env.SUPABASE" \
   --exclude-dir=node_modules --exclude-dir=dist artifacts/bridgeup/server 2>/dev/null | head -5; then
  check_pass "Env vars used server-side only"
fi

if grep -rn --include="*.tsx" --include="*.ts" "SUPABASE_SERVICE_KEY\|SESSION_SECRET\|TWILIO" \
   --exclude-dir=node_modules artifacts/bridgeup/src 2>/dev/null; then
  check_fail "Secret env vars referenced in frontend code — move to server"
else
  check_pass "No secret env vars in frontend code"
fi

# ─── 4. Security middleware ───────────────────────────────────────────────────
echo ""
echo "4. Checking security middleware..."
if grep -q "helmet" artifacts/bridgeup/server/index.js 2>/dev/null; then
  check_pass "Helmet security headers: configured"
else
  check_fail "Helmet not found in server/index.js"
fi

if grep -q "rateLimit\|rate-limit" artifacts/bridgeup/server/index.js 2>/dev/null; then
  check_pass "Rate limiting: configured"
else
  check_fail "Rate limiting not found"
fi

if grep -q "cors" artifacts/bridgeup/server/index.js 2>/dev/null; then
  check_pass "CORS: configured"
else
  check_fail "CORS not configured"
fi

# ─── 5. Input validation ──────────────────────────────────────────────────────
echo ""
echo "5. Checking input validation patterns..."
ROUTES=("auth" "needs" "matching")
for route in "${ROUTES[@]}"; do
  if [ -f "artifacts/bridgeup/server/routes/$route.js" ]; then
    if grep -q "req.body\." "artifacts/bridgeup/server/routes/$route.js" && \
       grep -qE "(status(400|422)|return res\.(json|send).*error)" "artifacts/bridgeup/server/routes/$route.js"; then
      check_pass "Input validation found in $route.js"
    else
      check_warn "Verify input validation in $route.js"
    fi
  fi
done

# ─── 6. npm audit ─────────────────────────────────────────────────────────────
echo ""
echo "6. Running npm audit..."
if [ -f "artifacts/bridgeup/package.json" ]; then
  cd artifacts/bridgeup
  if npm audit --audit-level=high --json 2>/dev/null | python3 -c "
import sys, json
data = json.load(sys.stdin)
high = data.get('metadata', {}).get('vulnerabilities', {}).get('high', 0)
critical = data.get('metadata', {}).get('vulnerabilities', {}).get('critical', 0)
if high > 0 or critical > 0:
    print(f'FAIL: {high} high, {critical} critical vulnerabilities')
    sys.exit(1)
print('PASS: No high/critical vulnerabilities')
" 2>/dev/null; then
    check_pass "npm audit: no high/critical vulnerabilities"
  else
    check_warn "npm audit found issues — run 'npm audit fix' to resolve"
  fi
  cd ../..
else
  check_warn "package.json not found, skipping npm audit"
fi

# ─── 7. Console.log with sensitive data ──────────────────────────────────────
echo ""
echo "7. Checking console.log for sensitive data..."
if grep -rn --include="*.js" \
   -E "console\.(log|error|warn).*\b(password|token|secret|key|otp)\b" \
   --exclude-dir=node_modules --exclude-dir=dist artifacts/bridgeup/server 2>/dev/null | \
   grep -v "phoneLast4\|userId\|status" | head -5; then
  check_warn "Review console.log statements above for potential PII leakage"
else
  check_pass "No obvious sensitive data in console.log"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo -e "${BLUE}────────────────────────────────────────────${NC}"
echo -e "Results: ${GREEN}${PASS} passed${NC} | ${YELLOW}${WARN} warnings${NC} | ${RED}${FAIL} failed${NC}"
echo ""
if [ $FAIL -gt 0 ]; then
  echo -e "${RED}SECURITY CHECK FAILED — fix the issues above before deploying.${NC}"
  exit 1
elif [ $WARN -gt 0 ]; then
  echo -e "${YELLOW}Security check passed with warnings — review before deploying.${NC}"
else
  echo -e "${GREEN}All security checks passed!${NC}"
fi
