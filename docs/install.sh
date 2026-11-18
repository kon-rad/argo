#!/bin/sh
# Argo / Second Brain: install the prerequisites, then print how to make a vault.
#
#   curl -fsSL https://kon-rad.github.io/argo/install.sh | sh
#
# Everything this script installs is a normal system package via Homebrew (macOS)
# or apt (Debian/Ubuntu): git, Node 22+, Python 3.9+ and PostgreSQL 15+ with
# pgvector. It never reads, moves or deletes your notes, and it does not touch
# anything outside the package manager's own directories. Safe to re-run.
#
# It does not create a vault. That is one command, printed at the end, so you see
# exactly where your notes will live before anything is written.
set -eu

say() { printf '%s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }
die() { say "install: $*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

say "Argo / Second Brain prerequisites"
say "This installs git, Node 22+, Python 3.9+ and PostgreSQL 15+ with pgvector."

OS="$(uname -s)"
case "$OS" in
  Darwin) PLATFORM=macos ;;
  Linux)
    ID="unknown"
    # shellcheck disable=SC1091
    [ -r /etc/os-release ] && . /etc/os-release && ID="${ID:-unknown}"
    case "$ID" in
      debian|ubuntu|raspbian) PLATFORM=debian ;;
      *) PLATFORM=linux ;;
    esac
    ;;
  *) die "unsupported platform '$OS'. Install git, Node 22+, Python 3.9+ and PostgreSQL 15+ with pgvector by hand." ;;
esac

install_macos() {
  have brew || die "Homebrew is required on macOS. Install it from https://brew.sh and re-run."
  step "Homebrew packages"
  have git || brew install git
  brew list node@22 >/dev/null 2>&1 || brew install node@22
  have python3 || brew install python
  brew list postgresql@15 >/dev/null 2>&1 || brew install postgresql@15
  brew services start postgresql@15 >/dev/null 2>&1 || say "start Postgres yourself: brew services start postgresql@15"
  PG_PREFIX="$(brew --prefix postgresql@15)"
  if [ ! -e "$PG_PREFIX/share/postgresql@15/extension/vector.control" ]; then
    step "pgvector (built against postgresql@15)"
    tmp="$(mktemp -d)"
    git clone --branch v0.8.1 --depth 1 https://github.com/pgvector/pgvector.git "$tmp/pgvector"
    make -C "$tmp/pgvector" PG_CONFIG="$PG_PREFIX/bin/pg_config"
    make -C "$tmp/pgvector" install PG_CONFIG="$PG_PREFIX/bin/pg_config"
    rm -rf "$tmp"
  else
    say "pgvector already installed for postgresql@15"
  fi
  # Make node@22 the `node` on PATH for this shell's children (Homebrew keg-only).
  if ! have node; then export PATH="$PG_PREFIX/../node@22/bin:$PATH"; fi
}

install_debian() {
  have sudo || die "sudo is required to install packages. Install git, Node 22+, Python 3.9+ and PostgreSQL 15+ with pgvector by hand."
  step "apt packages"
  sudo apt-get update -qq
  sudo apt-get install -y git python3 postgresql postgresql-contrib
  if ! have node || [ "$(node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1 || echo 0)" -lt 22 ]; then
    step "Node 22 (NodeSource)"
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
  fi
  step "pgvector"
  PG_MAJOR="$(pg_config --version 2>/dev/null | sed -n 's/^PostgreSQL \([0-9]*\).*/\1/p' || true)"
  [ -n "$PG_MAJOR" ] || PG_MAJOR=16
  sudo apt-get install -y "postgresql-${PG_MAJOR}-pgvector" \
    || say "install the pgvector package matching your Postgres (postgresql-<major>-pgvector)."
  # The app connects as the current user on a local install.
  sudo -u postgres createuser --superuser "$USER" 2>/dev/null || true
  sudo systemctl start postgresql 2>/dev/null || true
}

case "$PLATFORM" in
  macos) install_macos ;;
  debian) install_debian ;;
  *) die "this script automates macOS and Debian/Ubuntu only. Install git, Node 22+, Python 3.9+ and PostgreSQL 15+ with pgvector by hand." ;;
esac

step "Check"
missing=""
have git || missing="$missing git"
have node || missing="$missing node"
have python3 || missing="$missing python3"
have psql || missing="$missing postgresql"
[ -z "$missing" ] && say "all prerequisites found" || say "still missing:$missing (open a new shell so PATH changes take effect, then re-check)"

cat <<'NEXT'

Next, make your vault (your notes stay yours; this only creates empty PARA folders):

  mkdir my-vault && cd my-vault && git init
  git submodule add https://github.com/kon-rad/argo.git .secondbrain
  .secondbrain/bin/secondbrain-vault init .
  cp .env.example .env
  git add -A && git commit -m "new vault"
  .secondbrain/app/bin/secondbrain        # installs, migrates, builds, starts, opens the browser

Then read the two onboarding pages:
  https://kon-rad.github.io/argo/onboarding/02-set-up-your-vault/
  https://kon-rad.github.io/argo/onboarding/00-from-zero/
NEXT
