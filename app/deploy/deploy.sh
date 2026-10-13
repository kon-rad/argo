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
#   EXTRA_CADDY_IMPORT   a Caddyfile snippet for other sites on the same box
#   MODULES              the same list the app uses; `agents` also installs the agents-sync timer
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_ROOT="$(cd "$HERE/.." && pwd)"
ENGINE_ROOT="$(cd "$APP_ROOT/.." && pwd)"
if [[ "$(basename "$ENGINE_ROOT")" == ".secondbrain" ]]; then VAULT_ROOT_LOCAL="$(dirname "$ENGINE_ROOT")"; else VAULT_ROOT_LOCAL="$ENGINE_ROOT"; fi
VAULT_ROOT_LOCAL="${VAULT_ROOT:-$VAULT_ROOT_LOCAL}"
if [[ -f "$VAULT_ROOT_LOCAL/.env" ]]; then set -a; . "$VAULT_ROOT_LOCAL/.env"; set +a; fi

HOST="${DEPLOY_HOST:?set DEPLOY_HOST (ssh destination with root)}"
PUBLIC_HOST="${DEPLOY_PUBLIC_HOST:?set DEPLOY_PUBLIC_HOST (domain or IP)}"
VAULT_DIR="${DEPLOY_VAULT_DIR:?set DEPLOY_VAULT_DIR (vault checkout on the server)}"
APP_USER="${DEPLOY_APP_USER:-secondbrain}"
APP_DIR="${DEPLOY_APP_DIR:-/opt/secondbrain-app}"
HERMES_HOME_REMOTE="${DEPLOY_HERMES_HOME:-}"
EXTRA_IMPORT="${EXTRA_CADDY_IMPORT:-}"
WITH_AGENTS=0; [[ ",${MODULES:-}," == *",agents,"* || ",${MODULES:-}," == *", agents,"* ]] && WITH_AGENTS=1
for v in "$APP_USER" "$APP_DIR" "$VAULT_DIR" "$PUBLIC_HOST" "$HERMES_HOME_REMOTE" "$EXTRA_IMPORT"; do
  [[ "$v" =~ ^[A-Za-z0-9._/@:-]*$ ]] || { echo "unsafe character in setting: $v"; exit 1; }
done

echo "→ shipping source to $HOST:$APP_DIR"
ssh "$HOST" "mkdir -p $APP_DIR"
rsync -az --delete \
  --exclude node_modules --exclude dist --exclude 'web/dist' --exclude data \
  --exclude .git --exclude .DS_Store \
  "$APP_ROOT/" "$HOST:$APP_DIR/"

echo "→ provisioning and restarting"
ssh "$HOST" "APP_DIR=$APP_DIR VAULT=$VAULT_DIR APP_USER=$APP_USER PUBLIC_HOST=$PUBLIC_HOST HERMES_HOME_REMOTE=$HERMES_HOME_REMOTE EXTRA_IMPORT=$EXTRA_IMPORT WITH_AGENTS=$WITH_AGENTS bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
id "$APP_USER" >/dev/null || { echo "user $APP_USER missing: create it and give it the vault checkout"; exit 1; }
[ -d "$VAULT" ] || { echo "vault missing at $VAULT"; exit 1; }
HERMES_HOME_REMOTE="${HERMES_HOME_REMOTE:-$(getent passwd "$APP_USER" | cut -d: -f6)/.hermes}"
render() { sed -e "s#@APP_USER@#$APP_USER#g" -e "s#@APP_DIR@#$APP_DIR#g" -e "s#@VAULT_DIR@#$VAULT#g" -e "s#@HERMES_HOME@#$HERMES_HOME_REMOTE#g" "$1"; }

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

# ---- build ----
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" "$APP_DIR/data"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && npm ci --no-audit --no-fund && npm run build"
sudo -u "$APP_USER" bash -c "cd $APP_DIR && DATABASE_URL='postgres:///secondbrain?host=/var/run/postgresql' npm run migrate:up"
# The vault is a git checkout: tell git to ignore the editor's atomic-write
# temp files in case the sync runs in the instant one exists.
grep -qxF '.*.sb-*.tmp' "$VAULT/.git/info/exclude" 2>/dev/null \
  || echo '.*.sb-*.tmp' >> "$VAULT/.git/info/exclude"

# ---- services ----
render "$APP_DIR/deploy/secondbrain.service" > /etc/systemd/system/secondbrain.service
if [ "$WITH_AGENTS" = 1 ]; then
  render "$APP_DIR/deploy/secondbrain-agents-sync.service" > /etc/systemd/system/secondbrain-agents-sync.service
  install -m 644 "$APP_DIR/deploy/secondbrain-agents-sync.timer" /etc/systemd/system/
fi
install -d -o caddy -g caddy /var/log/caddy
GLOBAL=""
if [[ "$PUBLIC_HOST" =~ ^[0-9.]+$ ]]; then
  GLOBAL=$'{\n\tcert_issuer acme {\n\t\tprofile shortlived\n\t}\n\t# Clients connecting by IP send no SNI; tell Caddy which cert to serve them.\n\tdefault_sni '"$PUBLIC_HOST"$'\n}'
fi
IMPORT_LINE=""
if [ -n "$EXTRA_IMPORT" ]; then
  [ -f "$EXTRA_IMPORT" ] || touch "$EXTRA_IMPORT"   # keep the import valid before that site exists
  IMPORT_LINE="import $EXTRA_IMPORT"
fi
python3 - "$APP_DIR/deploy/Caddyfile.template" "$PUBLIC_HOST" "$GLOBAL" "$IMPORT_LINE" > /etc/caddy/Caddyfile <<'PY'
import sys
t = open(sys.argv[1]).read()
print(t.replace('@GLOBAL_OPTIONS@', sys.argv[3]).replace('@PUBLIC_HOST@', sys.argv[2]).replace('@EXTRA_IMPORT@', sys.argv[4]), end='')
PY
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
# validate runs as root and opens the log file, leaving it root-owned; the
# caddy user then cannot open it and the reload fails.
chown -R caddy:caddy /var/log/caddy
systemctl daemon-reload
systemctl enable caddy secondbrain >/dev/null
if [ "$WITH_AGENTS" = 1 ]; then systemctl enable --now secondbrain-agents-sync.timer >/dev/null; fi
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
