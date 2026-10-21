#!/usr/bin/env bash
# Deploys Second Brain to an Ubuntu server you reach as root over ssh. Run it
# from your own machine:
#
#   app/deploy/deploy.sh            # first time: installs everything
#   app/deploy/deploy.sh            # afterwards: ships code, rebuilds, restarts
#
# Idempotent. Ships source with rsync rather than cloning on the server, so the
# server needs no GitHub credential.
#
# Settings come from the environment, or from the vault's .env (the vault is
# found the same way the app finds it). Required:
#   DEPLOY_HOST          ssh destination with root, e.g. an ~/.ssh/config alias
#   DEPLOY_PUBLIC_HOST   the domain or bare IP Caddy serves (https://<this>)
#   DEPLOY_VAULT_DIR     the vault checkout on the server
# Optional:
#   DEPLOY_APP_USER      Unix user that owns the vault and runs the app (default: secondbrain)
#   DEPLOY_APP_DIR       where the app is installed (default: /opt/secondbrain-app)
#   DEPLOY_HERMES_HOME   Hermes home on the server, for the agents module (default: ~APP_USER/.hermes)
#   EXTRA_CADDY_IMPORT   Caddyfile snippets for other sites on the same box, comma separated
#   DEPLOY_REDIRECT_FROM another host (e.g. the bare IP) that 308-redirects to DEPLOY_PUBLIC_HOST
#   DEPLOY_PAUSE_FILE    a file that holds an agent dispatcher off while the build runs (org module)
#   DEPLOY_EMBED=1       install the nightly embed timer (needs a local Ollama service)
#   DEPLOY_DB_BACKUP=1   install the nightly pg_dump-to-B2 timer (needs b2store for the app user)
#   DEPLOY_MODULES       the server's module list, when it differs from this machine's MODULES
#                        (e.g. voice here, livestream there); else MODULES. Each module installs its own timers:
#                        agents: agents-sync · usage: usage-sync, credits-sync, the usage importer
#                        projects: projects-render, the kiosk feed token, cli-projects on PATH
#                        org: the sb_org role, cli-org on PATH · map: map-build, metrics
#                        livestream: the minute poller and Caddy's /public/ files
#                        social: the minute post-publisher and reauth check, cli-social on PATH
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
ENGINE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
if [[ "$(basename "$ENGINE_ROOT")" == ".secondbrain" ]]; then VAULT_ROOT_LOCAL="$(dirname "$ENGINE_ROOT")"; else VAULT_ROOT_LOCAL="$ENGINE_ROOT"; fi
VAULT_ROOT_LOCAL="${VAULT_ROOT:-$VAULT_ROOT_LOCAL}"
# Read only the settings this script uses, literally: the vault's env file holds
# keys and hashes whose `$` sequences a shell `source` would expand (or trip
# set -u on). A value already in the environment wins.
ENV_FILE="${DEPLOY_ENV_FILE:-$VAULT_ROOT_LOCAL/.env}"
read_env() {
  local key=$1 line val
  [[ -n "${!key:-}" || ! -f "$ENV_FILE" ]] && return 0
  line=$(grep -E "^(export +)?$key=" "$ENV_FILE" | tail -n 1) || return 0
  val=${line#*=}; val=${val%$'\r'}
  if [[ $val == \"*\" || $val == \'*\' ]]; then val=${val:1:${#val}-2}; fi
  printf -v "$key" '%s' "$val"; export "$key"
}
for k in DEPLOY_HOST DEPLOY_PUBLIC_HOST DEPLOY_VAULT_DIR DEPLOY_APP_USER DEPLOY_APP_DIR DEPLOY_HERMES_HOME \
         EXTRA_CADDY_IMPORT DEPLOY_REDIRECT_FROM DEPLOY_PAUSE_FILE DEPLOY_EMBED DEPLOY_DB_BACKUP DEPLOY_MODULES MODULES; do
  read_env "$k"
done

HOST="${DEPLOY_HOST:?set DEPLOY_HOST (ssh destination with root)}"
PUBLIC_HOST="${DEPLOY_PUBLIC_HOST:?set DEPLOY_PUBLIC_HOST (domain or IP)}"
VAULT_DIR="${DEPLOY_VAULT_DIR:?set DEPLOY_VAULT_DIR (vault checkout on the server)}"
APP_USER="${DEPLOY_APP_USER:-secondbrain}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/secondbrain-app}"
HERMES_HOME_REMOTE="${DEPLOY_HERMES_HOME:-}"
EXTRA_IMPORT="${EXTRA_CADDY_IMPORT:-}"
REDIRECT_FROM="${DEPLOY_REDIRECT_FROM:-}"
PAUSE_FILE="${DEPLOY_PAUSE_FILE:-}"
WITH_EMBED="${DEPLOY_EMBED:-0}"
WITH_BACKUP="${DEPLOY_DB_BACKUP:-0}"
# The module list without spaces, so it travels to the server as one safe word.
MODS="$(printf '%s' "${DEPLOY_MODULES:-${MODULES:-}}" | tr -d ' ')"
for v in "$APP_USER" "$APP_DIR" "$VAULT_DIR" "$PUBLIC_HOST" "$HERMES_HOME_REMOTE" "$EXTRA_IMPORT" "$REDIRECT_FROM" "$PAUSE_FILE" "$MODS" "$WITH_EMBED" "$WITH_BACKUP"; do
  [[ "$v" =~ ^[A-Za-z0-9._/@:,-]*$ ]] || { echo "unsafe character in setting: $v"; exit 1; }
done

echo "→ shipping source to $HOST:$APP_DIR"
ssh "$HOST" "mkdir -p $APP_DIR"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude 'web/dist' --exclude data \
  --exclude .git --exclude .DS_Store \
  "$APP_ROOT/" "$HOST:$APP_DIR/"

echo "→ provisioning and restarting"
ssh "$HOST" "APP_DIR=$APP_DIR VAULT=$VAULT_DIR APP_USER=$APP_USER PUBLIC_HOST=$PUBLIC_HOST HERMES_HOME_REMOTE=$HERMES_HOME_REMOTE EXTRA_IMPORT=$EXTRA_IMPORT REDIRECT_FROM=$REDIRECT_FROM PAUSE_FILE=$PAUSE_FILE MODS=$MODS WITH_EMBED=$WITH_EMBED WITH_BACKUP=$WITH_BACKUP bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
id "$APP_USER" >/dev/null || { echo "user $APP_USER missing: create it and give it the vault checkout"; exit 1; }
[ -d "$VAULT" ] || { echo "vault missing at $VAULT"; exit 1; }
APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
HERMES_HOME_REMOTE="${HERMES_HOME_REMOTE:-$APP_HOME/.hermes}"
ENV_FILE=/etc/secondbrain/env # public-ok
render() { sed -e "s#@ENV_FILE@#$ENV_FILE#g" -e "s#@APP_USER@#$APP_USER#g" -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@VAULT_DIR@#$VAULT#g" -e "s#@HERMES_HOME@#$HERMES_HOME_REMOTE#g" -e "s#@APP_HOME@#$APP_HOME#g" "$1"; }
has() { [[ ",$MODS," == *",$1,"* ]]; }
# A unit pair: the .service rendered, the .timer copied as is.
unit() {
  render "$APP_DIR/deploy/$1.service" > "/etc/systemd/system/$1.service"
  install -m 644 "$APP_DIR/deploy/$1.timer" /etc/systemd/system/
  TIMERS+=("$1.timer")
}
TIMERS=()

# ---- packages (first run only) ----
# Wait out unattended-upgrades instead of failing on its lock. NodeSource's
# setup script reports an `apt update` lock failure yet exits 0, after which
# the install below quietly picked Ubuntu's Node 18 (no npm) on 2026-09-30.
echo 'DPkg::Lock::Timeout "300";' > /etc/apt/apt.conf.d/90wait-for-lock
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0; }
if [ "$(node_major)" -lt 22 ] || ! command -v npm >/dev/null; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  [ -f /etc/apt/sources.list.d/nodesource.sources ] || [ -f /etc/apt/sources.list.d/nodesource.list ] \
    || { echo "NodeSource repo was not added"; exit 1; }
  apt-get install -y nodejs
fi
[ "$(node_major)" -ge 22 ] || { echo "node $(node -v) is too old; need 22"; exit 1; }
if ! command -v psql >/dev/null; then
  apt-get install -y postgresql postgresql-contrib
fi
PGV=$(psql --version | grep -oE '[0-9]+' | head -1)
dpkg -s "postgresql-$PGV-pgvector" >/dev/null 2>&1 || apt-get install -y "postgresql-$PGV-pgvector"
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi
# IP certificates need the ACME profiles support that landed in 2.11.4.
CADDY_V=$(caddy version | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
if [ "$(printf '%s\n2.11.4\n' "$CADDY_V" | sort -V | head -1)" != "2.11.4" ]; then
  apt-get update && apt-get install -y --only-upgrade caddy
fi

# ---- database: peer auth over the unix socket, no password to leak ----
systemctl enable --now postgresql
sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1 \
  || sudo -u postgres createuser "$APP_USER"
sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='secondbrain'" | grep -q 1 \
  || sudo -u postgres createdb -O "$APP_USER" secondbrain
# The migration creates the extension; only a superuser may, so do it here.
sudo -u postgres psql -d secondbrain -c 'CREATE EXTENSION IF NOT EXISTS vector' >/dev/null

# ---- env file: created once, then only ever edited by hand ----
install -d -m 750 -o root -g "$APP_USER" /etc/secondbrain
if [ ! -f /etc/secondbrain/env ]; then
  install -m 640 -o root -g "$APP_USER" "$APP_DIR/deploy/env.example" /etc/secondbrain/env
fi

# projects module: a kiosk's read-only feed token, generated here once and never printed.
if has projects; then
  grep -qE '^PROJECTS_FEED_TOKEN=.{32,}' /etc/secondbrain/env \
    || echo "PROJECTS_FEED_TOKEN=$(openssl rand -hex 32)" >> /etc/secondbrain/env
fi

# org module: the row-level-security role its migration grants. The app user may not
# CREATE ROLE, so it is made here; its password lands only in the env file.
if has org; then
  sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='sb_org'" | grep -q 1 \
    || sudo -u postgres psql -qc "CREATE ROLE sb_org LOGIN"
  if ! grep -qE '^SB_ORG_DB_URL=' /etc/secondbrain/env; then
    SB_ORG_PW=$(openssl rand -hex 24)
    sudo -u postgres psql -qc "ALTER ROLE sb_org PASSWORD '$SB_ORG_PW'"
    echo "SB_ORG_DB_URL=postgres://sb_org:$SB_ORG_PW@127.0.0.1:5432/secondbrain" >> /etc/secondbrain/env
    unset SB_ORG_PW
  fi
fi

# ---- hold an agent dispatcher off while node_modules and dist are rebuilt: an agent
# woken in that window finds no CLI. Removed after the migration, and on any exit.
PAUSED_BY_DEPLOY=
if [ -n "$PAUSE_FILE" ] && [ ! -e "$PAUSE_FILE" ]; then
  install -d -o "$APP_USER" -g "$APP_USER" "$(dirname "$PAUSE_FILE")"
  echo "deploy in progress ($(date -u +%FT%TZ))" > "$PAUSE_FILE"; chown "$APP_USER:$APP_USER" "$PAUSE_FILE"
  PAUSED_BY_DEPLOY=1
  trap 'rm -f "$PAUSE_FILE"' EXIT
  for _ in $(seq 1 24); do pgrep -u "$APP_USER" -f 'claude -p' >/dev/null || break; echo "  waiting for a running agent to finish"; sleep 5; done
fi

# ---- build ----
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --no-audit --no-fund && npm run build"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && DATABASE_URL='postgres:///secondbrain?host=/var/run/postgresql' npm run migrate:up"
# node_modules, dist and the schema are whole again: let the dispatcher spawn.
if [ -n "$PAUSED_BY_DEPLOY" ]; then rm -f "$PAUSE_FILE"; echo "→ dispatcher unpaused"; fi
# The vault is a git checkout: tell git to ignore the editor's atomic-write
# temp files in case the sync runs in the instant one exists.
grep -qxF '.*.sb-*.tmp' "$VAULT/.git/info/exclude" 2>/dev/null \
  || echo '.*.sb-*.tmp' >> "$VAULT/.git/info/exclude"

# ---- CLI wrappers on the app user's PATH, so an agent's `Bash(cli-org *)` rule matches ----
WRAPPERS=()
has org && WRAPPERS+=(cli-org)
has projects && WRAPPERS+=(cli-projects)
has social && WRAPPERS+=(cli-social)
if [ "${#WRAPPERS[@]}" -gt 0 ]; then
  install -d -o "$APP_USER" -g "$APP_USER" "$APP_HOME/.local/bin"
  for w in "${WRAPPERS[@]}"; do
    render "$APP_DIR/deploy/bin/$w" > "$APP_HOME/.local/bin/$w"
    chown "$APP_USER:$APP_USER" "$APP_HOME/.local/bin/$w"; chmod 755 "$APP_HOME/.local/bin/$w"
  done
fi

# ---- services ----
render "$APP_DIR/deploy/secondbrain.service" > /etc/systemd/system/secondbrain.service
has agents && unit secondbrain-agents-sync
if has usage; then
  unit secondbrain-usage-sync
  unit secondbrain-credits-sync
  # A laptop's usage-push runs this over ssh as root and pipes its wire lines in.
  render "$APP_DIR/deploy/secondbrain-usage-import" > /usr/local/bin/secondbrain-usage-import
  chmod 755 /usr/local/bin/secondbrain-usage-import
fi
has projects && unit secondbrain-projects-render
has projects && unit secondbrain-roadmap-render
if has map; then unit secondbrain-map-build; unit secondbrain-metrics; fi
has livestream && unit secondbrain-livestream
has social && unit secondbrain-social
[ "$WITH_EMBED" = 1 ] && unit secondbrain-embed
[ "$WITH_BACKUP" = 1 ] && unit secondbrain-db-backup

install -d -o caddy -g caddy /var/log/caddy
ip_host() { [[ "$1" =~ ^[0-9.]+$ ]]; }
GLOBAL=""
SNI=""
if ip_host "$PUBLIC_HOST"; then SNI="$PUBLIC_HOST"; elif [ -n "$REDIRECT_FROM" ] && ip_host "$REDIRECT_FROM"; then SNI="$REDIRECT_FROM"; fi
if [ -n "$SNI" ]; then
  GLOBAL=$'{\n\tcert_issuer acme {\n\t\tprofile shortlived\n\t}\n\t# Clients connecting by IP send no SNI; tell Caddy which cert to serve them.\n\tdefault_sni '"$SNI"$'\n}'
fi
PUBLIC_FILES=""
if has livestream; then
  PUBLIC_FILES=$'\n\t# Public, no login: summaries a timer writes for a public page (no private data).\n\thandle_path /public/* {\n\t\troot * /var/lib/secondbrain-public\n\t\theader Access-Control-Allow-Origin *\n\t\theader Cache-Control "public, max-age=20"\n\t\tfile_server\n\t}\n'
fi
REDIRECT=""
if [ -n "$REDIRECT_FROM" ]; then
  # PUBLIC_ORIGIN names the public host, so a login posted from another host would
  # fail the origin check. Send it there; 308 keeps the method.
  REDIRECT=$'\nhttps://'"$REDIRECT_FROM"$' {\n\tredir https://'"$PUBLIC_HOST"$'{uri} 308\n}\n'
fi
IMPORT_LINES=""
IFS=',' read -r -a IMPORTS <<< "$EXTRA_IMPORT"
for f in "${IMPORTS[@]}"; do
  [ -n "$f" ] || continue
  [ -f "$f" ] || touch "$f"   # keep the import valid before that site exists
  IMPORT_LINES+="import $f"$'\n'
done
python3 - "$APP_DIR/deploy/Caddyfile.template" "$PUBLIC_HOST" "$GLOBAL" "$IMPORT_LINES" "$PUBLIC_FILES" "$REDIRECT" > /etc/caddy/Caddyfile <<'PY'
import sys
t = open(sys.argv[1]).read()
for key, value in (('@GLOBAL_OPTIONS@', sys.argv[3]), ('@PUBLIC_HOST@', sys.argv[2]), ('@EXTRA_IMPORT@', sys.argv[4]),
                   ('@PUBLIC_FILES@', sys.argv[5]), ('@REDIRECT@', sys.argv[6])):
    t = t.replace(key, value)
print(t, end='')
PY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# validate runs as root and opens the log file, leaving it root-owned; the
# caddy user then cannot open it and the reload fails.
chown -R caddy:caddy /var/log/caddy
systemctl daemon-reload
systemctl enable caddy secondbrain >/dev/null
for t in "${TIMERS[@]}"; do systemctl enable --now "$t" >/dev/null; done
systemctl reload-or-restart caddy

if grep -qE '^AUTH_PASSWORD_HASH=.+' /etc/secondbrain/env && grep -qE '^AUTH_TOTP_SECRET=.+' /etc/secondbrain/env; then
  systemctl restart secondbrain
  sleep 2
  systemctl is-active --quiet secondbrain && echo "✓ secondbrain running" \
    || { journalctl -u secondbrain -n 30 --no-pager; exit 1; }
else
  echo "! /etc/secondbrain/env has no login yet — the app will refuse to start until it does."
  echo "  Run 'secondbrain auth-setup' on your own machine and paste its output into that file, then:"
  echo "  systemctl restart secondbrain"
fi

# ---- firewall: SSH, and 80/443 for Caddy. 5123 and 5432 stay loopback-only ----
if command -v ufw >/dev/null; then
  ufw allow OpenSSH >/dev/null
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw --force enable >/dev/null
  ufw status
fi
REMOTE

echo "→ done: https://$PUBLIC_HOST"
