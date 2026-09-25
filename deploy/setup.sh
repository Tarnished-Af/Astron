#!/usr/bin/env bash
# Astron setup for Ubuntu. Run from the unzipped folder:  sudo bash deploy/setup.sh
set -euo pipefail

APP=/opt/astron
DATA=/var/lib/astron
LOG=/var/log/astron-setup.log
SRC="$(cd "$(dirname "$0")/.." && pwd)"
STEPS=8
STEP=0

[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo bash deploy/setup.sh"; exit 1; }
: > "$LOG"

c_dim=$'\033[2m'; c_ok=$'\033[32m'; c_hi=$'\033[35m'; c_err=$'\033[31m'; c_off=$'\033[0m'
spin='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'

bar() {                     # bar <done> <total>
  local w=24
  local filled=$(( $1 * w / $2 )) i out=""
  for ((i=0;i<w;i++)); do [ $i -lt $filled ] && out+="█" || out+="░"; done
  printf "%s" "$out"
}

run_step() {                # run_step "What it's doing" command...
  STEP=$((STEP+1))
  local label="$1"; shift
  ( "$@" >>"$LOG" 2>&1 ) & local pid=$!
  local i=0
  while kill -0 $pid 2>/dev/null; do
    printf "\r  ${c_hi}%s${c_off} %s  ${c_dim}%s %d/%d${c_off}   " \
      "${spin:i++%${#spin}:1}" "$label" "$(bar $((STEP-1)) $STEPS)" $((STEP-1)) $STEPS
    sleep 0.1
  done
  if wait $pid; then
    printf "\r  ${c_ok}✓${c_off} %-44s ${c_dim}%s %d/%d${c_off}\n" "$label" "$(bar $STEP $STEPS)" $STEP $STEPS
  else
    printf "\r  ${c_err}✗${c_off} %-44s\n\n" "$label"
    echo "  ${c_err}That step failed.${c_off}"
    if [ -s "$LOG" ]; then echo "  Last few lines of the log:"; tail -n 20 "$LOG" | sed 's/^/    /'
    else echo "  It failed without printing anything, which usually means a command"
         echo "  returned an error code. Run it again with: sudo bash -x $0"; fi
    echo
    echo "  Full log: $LOG"
    exit 1
  fi
}

ask() {                     # ask <variable> <question> <default>
  local __v=$1 q=$2 def=${3:-} ans
  if [ -n "$def" ]; then read -rp "  $q [$def]: " ans; else read -rp "  $q: " ans; fi
  printf -v "$__v" '%s' "${ans:-$def}"
}
ask_secret() { local __v=$1 q=$2 ans; read -rsp "  $q: " ans; echo; printf -v "$__v" '%s' "$ans"; }

echo
echo "${c_hi}Astron setup${c_off}"
echo "${c_dim}Everything is logged to $LOG${c_off}"
echo

if [ -f "$APP/.env" ]; then
  echo "  Astron is already set up here. Keeping your existing settings."
  echo
  SKIP_QUESTIONS=1
else
  SKIP_QUESTIONS=0
  echo "  A few questions first, then it installs without further interruption."
  echo
  ask SITE_NAME   "What should the site be called?" "Astron"
  ask PORT_PUBLIC "Which port should the site be reachable on?" "80"
  ask ADMIN_USER  "Admin username" "admin"
  ask ADMIN_NAME  "Your name, as shown on the site" "Admin"
  while :; do
    ask_secret ADMIN_PASS "Temporary admin password (8+ characters)"
    [ ${#ADMIN_PASS} -ge 8 ] && break
    echo "  ${c_err}Too short.${c_off}"
  done
  echo
  echo "  ${c_dim}AI provider. Works with OpenAI-compatible endpoints, Anthropic or Gemini."
  echo "  Leave blank to set it up later on the Settings page.${c_off}"
  ask AI_URL   "AI address" ""
  ask AI_MODEL "Model (on Azure: your deployment name)" ""
  ask_secret AI_KEY "AI key (hidden)"
  echo
  echo "  ${c_dim}Reading handwriting is optional. Azure Document Intelligence is the best at it.${c_off}"
  ask DI_URL "Document Intelligence address (blank to skip)" ""
  ask_secret DI_KEY "Document Intelligence key (hidden)"
  echo
fi

echo "${c_dim}Installing.${c_off}"
echo

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y ca-certificates curl gnupg nginx poppler-utils imagemagick build-essential python3 sqlite3 unzip
}
install_node() {
  if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
}
copy_files() {
  id astron >/dev/null 2>&1 || useradd --system --home "$APP" --shell /usr/sbin/nologin astron
  mkdir -p "$APP" "$DATA"
  cp -r "$SRC"/server.js "$SRC"/package.json "$SRC"/lib "$SRC"/public "$SRC"/deploy "$SRC"/config "$APP"/
  # Your course lives in its own file. The bundled examples stay untouched so
  # updates can refresh them without ever overwriting your work.
  [ -f "$APP/config/catalog.json" ] || cp "$APP/config/catalog.example.json" "$APP/config/catalog.json"
  [ -f "$SRC/package-lock.json" ] && cp "$SRC/package-lock.json" "$APP"/ || true
}
install_deps() { cd "$APP" && npm install --omit=dev --no-audit --no-fund; }
write_env() {
  [ "$SKIP_QUESTIONS" = 1 ] && return 0
  cat > "$APP/.env" <<ENVFILE
PORT=3000
DATA_DIR=$DATA
SITE_NAME=$SITE_NAME
CATALOG=$APP/config/catalog.json
ADMIN_USERNAME=$ADMIN_USER
ADMIN_NAME=$ADMIN_NAME
ADMIN_PASSWORD=$ADMIN_PASS
AI_BASE_URL=$AI_URL
AI_MODEL=$AI_MODEL
AI_API_KEY=$AI_KEY
AI_FORMAT=auto
AI_DAILY_LIMIT=40
OCR_ENGINE=${DI_URL:+azure}${DI_URL:-off}
AZURE_DI_ENDPOINT=$DI_URL
AZURE_DI_KEY=$DI_KEY
STORAGE_LIMIT_MB=5120
MAX_FILE_MB=25
COOKIE_SECURE=false
ENVFILE
}
add_swap() {
  [ -f /swapfile ] && return 0
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
}
start_service() {
  chown -R astron:astron "$APP" "$DATA"
  chmod 600 "$APP/.env"
  cp "$APP/deploy/astron.service" /etc/systemd/system/astron.service
  systemctl daemon-reload
  systemctl enable --now astron
  sleep 2
  systemctl is-active --quiet astron
}
setup_nginx() {
  sed "s/listen 80 default_server;/listen ${PORT_PUBLIC:-80} default_server;/; s/listen \[::\]:80 default_server;/listen [::]:${PORT_PUBLIC:-80} default_server;/" \
    "$APP/deploy/nginx.conf" > /etc/nginx/sites-available/astron
  ln -sf /etc/nginx/sites-available/astron /etc/nginx/sites-enabled/astron
  rm -f /etc/nginx/sites-enabled/default
  nginx -t && systemctl reload nginx
}

run_step "System packages"        install_packages
run_step "Node.js"                install_node
run_step "Copying Astron"         copy_files
run_step "Installing dependencies" install_deps
run_step "Writing settings"       write_env
run_step "Swap file"              add_swap
run_step "Starting the service"   start_service
run_step "Web server"             setup_nginx

# the admin password has done its job now that the account exists
if journalctl -u astron --no-pager 2>/dev/null | grep -q "Created admin account"; then
  sed -i "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=|" "$APP/.env" || true
fi

PORT_SHOWN=${PORT_PUBLIC:-80}
URL="http://localhost"; [ "$PORT_SHOWN" = "80" ] || URL="http://localhost:$PORT_SHOWN"

echo
echo "  ${c_ok}Astron is running.${c_off}  $URL"
echo
echo "  ${c_dim}Sign in as ${ADMIN_USER:-your admin} and you'll be asked to choose a password."
echo "  Course, keys and limits: the Manage course and Settings pages, once you're in."
echo "  Logs:  sudo journalctl -u astron -f${c_off}"
echo
