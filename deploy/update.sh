#!/usr/bin/env bash
# Install a newer Astron without touching your notes, accounts or settings.
# Run from the new unzipped folder:  sudo bash deploy/update.sh
set -euo pipefail
SRC="$(cd "$(dirname "$0")/.." && pwd)"
LOG=/var/log/astron-update.log
c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_hi=$'\033[35m'; c_err=$'\033[31m'; c_off=$'\033[0m'
spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
: > "$LOG"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo bash deploy/update.sh"; exit 1; }

step() {
  local label="$1"; shift
  ( "$@" >>"$LOG" 2>&1 ) & local pid=$! i=0
  while kill -0 $pid 2>/dev/null; do printf "\r  ${c_hi}%s${c_off} %s   " "${spin:i++%${#spin}:1}" "$label"; sleep 0.1; done
  if wait $pid; then printf "\r  ${c_ok}✓${c_off} %s\n" "$label"
  else printf "\r  ${c_err}✗${c_off} %s\n\n" "$label"; tail -n 20 "$LOG" | sed 's/^/    /'; echo; echo "Full log: $LOG"; exit 1; fi
}

copy_files() {
  cp -r "$SRC"/server.js "$SRC"/package.json "$SRC"/lib "$SRC"/public "$SRC"/deploy /opt/astron/
  mkdir -p /opt/astron/config
  # Your own catalog is never overwritten; the bundled examples are refreshed.
  for f in "$SRC"/config/*.json; do
    base=$(basename "$f")
    case "$base" in catalog.example.json|catalog.btu-cse.json) cp "$f" /opt/astron/config/;;
      *) [ -f "/opt/astron/config/$base" ] || cp "$f" /opt/astron/config/;; esac
  done
  chown -R astron:astron /opt/astron
}
install_deps() { cd /opt/astron && npm install --omit=dev --no-audit --no-fund; }
restart() { systemctl restart astron; sleep 2; systemctl is-active --quiet astron; }

echo
echo "${c_hi}Updating Astron${c_off}  ${c_dim}log: $LOG${c_off}"
echo
step "Copying files"            copy_files
step "Installing dependencies"  install_deps
step "Restarting"               restart
echo
echo "  ${c_ok}Done.${c_off} ${c_dim}Hard refresh your browser (Ctrl+Shift+R) to pick up the new page.${c_off}"
echo
