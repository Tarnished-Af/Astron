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
  else
    printf "\r  ${c_err}✗${c_off} %s\n\n" "$label"
    if [ -s "$LOG" ]; then echo "  Last few lines of the log:"; tail -n 20 "$LOG" | sed 's/^/    /'
    else echo "  That step failed without printing anything, which usually means a command"
         echo "  returned an error code. Run it again with: sudo bash -x $0"; fi
    echo; echo "  Full log: $LOG"; exit 1; fi
}

backup_first() {
  # Cheap insurance: a copy of the notes database before anything changes.
  [ -f /var/lib/astron/astron.db ] || return 0
  cp /var/lib/astron/astron.db "/var/lib/astron/astron-before-update.db"
}

protect_catalog() {
  # Make sure the course in use lives in its own file before anything is copied.
  # Older installs may have no CATALOG line at all, in which case the server was
  # using the bundled example, and that is exactly the file this update refreshes.
  local env=/opt/astron/.env
  local cfgdir=/opt/astron/config
  local mine="$cfgdir/catalog.json"
  mkdir -p "$cfgdir"
  [ -f "$env" ] || { echo "no .env yet, nothing to protect"; return 0; }

  local cur=""
  if grep -qE '^CATALOG=' "$env"; then
    cur=$(grep -E '^CATALOG=' "$env" | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
  fi
  # No setting, or an empty one, means the server fell back to the bundled example.
  [ -n "$cur" ] || cur="$cfgdir/catalog.example.json"
  echo "course currently read from: $cur"

  if [ ! -f "$mine" ]; then
    if [ -f "$cur" ]; then
      cp "$cur" "$mine"
      echo "copied it to catalog.json so updates cannot overwrite it"
    else
      cp "$cfgdir/catalog.example.json" "$mine" 2>/dev/null || true
      echo "started a fresh catalog.json"
    fi
  else
    echo "catalog.json already exists, leaving it alone"
  fi

  if grep -qE '^CATALOG=' "$env"; then
    sed -i "s|^CATALOG=.*|CATALOG=$mine|" "$env"
  else
    printf '\nCATALOG=%s\n' "$mine" >> "$env"
  fi
  echo "CATALOG now points at $mine"
}

copy_files() {
  cp -r "$SRC"/server.js "$SRC"/package.json "$SRC"/lib "$SRC"/public "$SRC"/deploy /opt/astron/
  mkdir -p /opt/astron/config
  # Only the bundled examples are refreshed. Anything else, including your own
  # catalog.json, is left exactly as it is.
  for f in "$SRC"/config/*.json; do
    base=$(basename "$f")
    case "$base" in
      catalog.example.json|catalog.btu-cse.json) cp "$f" /opt/astron/config/;;
      *) [ -f "/opt/astron/config/$base" ] || cp "$f" /opt/astron/config/;;
    esac
  done
  chown -R astron:astron /opt/astron
}
install_deps() { cd /opt/astron && npm install --omit=dev --no-audit --no-fund; }
restart() { systemctl restart astron; sleep 2; systemctl is-active --quiet astron; }

echo
echo "${c_hi}Updating Astron${c_off}  ${c_dim}log: $LOG${c_off}"
echo
step "Backing up the database"  backup_first
step "Protecting your course"   protect_catalog
step "Copying files"            copy_files
step "Installing dependencies"  install_deps
step "Restarting"               restart
echo
echo "  ${c_ok}Done.${c_off} ${c_dim}Hard refresh your browser (Ctrl+Shift+R) to pick up the new page.${c_off}"
echo
