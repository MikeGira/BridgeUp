#!/bin/bash
# BridgeUp Health Monitor + Self-Heal
# Monitors the app and restarts on failure.
# Run: chmod +x scripts/health-monitor.sh && ./scripts/health-monitor.sh [URL]
# For production: run with a process manager (PM2, systemd) on a schedule

SITE_URL="${1:-http://localhost:3000}"
HEALTH_ENDPOINT="$SITE_URL/api/health"
MAX_FAILURES=3
FAILURE_COUNT=0
LOG_FILE="/tmp/bridgeup-health.log"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

log() {
  local msg="[$(date '+%Y-%m-%d %H:%M:%S')] $1"
  echo -e "$msg"
  echo "$msg" >> "$LOG_FILE"
}

check_health() {
  local status
  status=$(curl -s -o /tmp/health_response.json -w "%{http_code}" \
    --max-time 10 --connect-timeout 5 "$HEALTH_ENDPOINT" 2>/dev/null)

  if [ "$status" = "200" ]; then
    local service
    service=$(python3 -c "import json; d=json.load(open('/tmp/health_response.json')); print(d.get('status','?'))" 2>/dev/null)
    log "${GREEN}HEALTHY${NC} — $HEALTH_ENDPOINT responded $status (status: $service)"
    return 0
  else
    log "${RED}UNHEALTHY${NC} — $HEALTH_ENDPOINT responded $status"
    return 1
  fi
}

check_security_headers() {
  local headers
  headers=$(curl -sI --max-time 10 "$SITE_URL" 2>/dev/null)
  local ok=true

  for header in "X-Content-Type-Options" "Strict-Transport-Security" "X-Frame-Options"; do
    if echo "$headers" | grep -qi "$header"; then
      log "${GREEN}SECURITY${NC} — $header: present"
    else
      log "${YELLOW}SECURITY${NC} — $header: missing (check Helmet config)"
      ok=false
    fi
  done

  $ok && return 0 || return 1
}

self_heal() {
  log "${YELLOW}SELF-HEAL${NC} — Attempting to restart BridgeUp server..."

  # PM2 restart (if using PM2 in production)
  if command -v pm2 &>/dev/null; then
    pm2 restart bridgeup-server && log "${GREEN}HEALED${NC} — PM2 restart successful" && return 0
  fi

  # Systemd restart (if deployed as a service)
  if systemctl is-active bridgeup &>/dev/null; then
    systemctl restart bridgeup && log "${GREEN}HEALED${NC} — systemd restart successful" && return 0
  fi

  # Local Node.js restart (development)
  local pid
  pid=$(pgrep -f "node.*server/index.js" 2>/dev/null)
  if [ -n "$pid" ]; then
    kill "$pid" 2>/dev/null
    sleep 2
    nohup node /d/Projects/BridgeUp/BridgeUp2.1/artifacts/bridgeup/server/index.js >> "$LOG_FILE" 2>&1 &
    sleep 3
    check_health && log "${GREEN}HEALED${NC} — Server restarted (PID: $!)" && return 0
  fi

  log "${RED}HEAL FAILED${NC} — Could not restart server automatically"
  return 1
}

# ─── Main loop ────────────────────────────────────────────────────────────────
log "Starting BridgeUp Health Monitor → $HEALTH_ENDPOINT"
echo "Monitoring every 30 seconds. Press Ctrl+C to stop."
echo ""

while true; do
  if check_health; then
    FAILURE_COUNT=0
    check_security_headers
  else
    ((FAILURE_COUNT++))
    log "${RED}FAILURE ${FAILURE_COUNT}/${MAX_FAILURES}${NC}"

    if [ $FAILURE_COUNT -ge $MAX_FAILURES ]; then
      log "${RED}MAX FAILURES REACHED${NC} — triggering self-heal"
      if self_heal; then
        FAILURE_COUNT=0
      else
        log "${RED}CRITICAL${NC} — Server is down and could not be healed. Manual intervention required."
        # In production, send alert here (email, Slack, PagerDuty)
      fi
    fi
  fi

  sleep 30
done
