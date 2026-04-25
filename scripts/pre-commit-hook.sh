#!/bin/bash
# BridgeUp Pre-commit Security Hook
# Install: cp scripts/pre-commit-hook.sh .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

echo ""
echo -e "${YELLOW}BridgeUp pre-commit security check...${NC}"

FAIL=0

# ─── Check for .env files being committed ────────────────────────────────────
if git diff --cached --name-only | grep -qE "^\.env$|\.env\."; then
  echo -e "${RED}✗ BLOCKED: .env file staged for commit — remove it:${NC}"
  echo "  git reset HEAD .env"
  FAIL=1
fi

# ─── Check for obvious secrets in staged code ────────────────────────────────
STAGED=$(git diff --cached --name-only | grep -E "\.(js|ts|tsx|json)$" | grep -v node_modules)

if [ -n "$STAGED" ]; then
  for file in $STAGED; do
    if [ -f "$file" ]; then
      if grep -qE "(sk_live_[a-zA-Z0-9]{20,}|AAAA[a-zA-Z0-9]{50,}|eyJ[a-zA-Z0-9._-]{100,})" "$file" 2>/dev/null; then
        echo -e "${RED}✗ BLOCKED: Possible secret key in $file${NC}"
        FAIL=1
      fi
    fi
  done
fi

# ─── Check for console.log with passwords ────────────────────────────────────
if git diff --cached | grep -E "console\.(log|warn|error).*password" 2>/dev/null | grep -v "phoneLast4"; then
  echo -e "${YELLOW}⚠ WARNING: console.log may expose sensitive data — review above${NC}"
fi

# ─── Check no TODOs about security are left ──────────────────────────────────
if git diff --cached | grep -iE "TODO.*security|FIXME.*auth|HACK.*bypass" 2>/dev/null; then
  echo -e "${YELLOW}⚠ WARNING: Security TODOs found — resolve before production deploy${NC}"
fi

if [ $FAIL -eq 0 ]; then
  echo -e "${GREEN}✓ Pre-commit security check passed${NC}"
  echo ""
  exit 0
else
  echo ""
  echo -e "${RED}Pre-commit check FAILED. Fix the issues above and re-stage.${NC}"
  echo ""
  exit 1
fi
