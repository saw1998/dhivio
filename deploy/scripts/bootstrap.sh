#!/usr/bin/env bash
###
# One-shot prod bootstrap. Run this exactly once on a fresh VPS:
#
#   sudo bash deploy/scripts/bootstrap.sh
#
# What it does (idempotent — safe to re-run with --rotate-jwt to refresh keys):
#   1. Creates /srv/dhivio/{state,backups,migrations-staging,functions}
#   2. Generates POSTGRES_PASSWORD, SESSION_SECRET, REALTIME_* keys, INNGEST_* keys.
#   3. Mints SUPABASE_JWT_SECRET + matching ANON / SERVICE_ROLE HS256 JWTs
#      (10-year exp) using the same algorithm as packages/dev/src/lib/jwt.ts.
#   4. Templates deploy/postgres/init.sql.template → deploy/postgres/init.sql
#      with the generated $POSTGRES_PASSWORD.
#   5. Writes /srv/dhivio/.env with every variable from deploy/.env.example.
#   6. Opens $EDITOR so the operator can fill in the [USER] block.
#   7. Creates the external `dhivio_net` Docker network.
#   8. Provisions a 2 GB swapfile if none exists (RAM cushion for postgres).
###
set -euo pipefail

# ── Args ───────────────────────────────────────────────────────────────────
ROTATE_JWT=0
NON_INTERACTIVE=0
for arg in "$@"; do
  case "$arg" in
    --rotate-jwt)        ROTATE_JWT=1 ;;
    --non-interactive)   NON_INTERACTIVE=1 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ── Paths ──────────────────────────────────────────────────────────────────
ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
ENV_FILE="$ROOT/.env"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Output helpers ─────────────────────────────────────────────────────────
if [[ -t 1 ]]; then GR=$'\e[32m'; YE=$'\e[33m'; CY=$'\e[36m'; RD=$'\e[31m'; RS=$'\e[0m'
else GR=; YE=; CY=; RD=; RS=; fi
ok()   { printf '%s✓%s %s\n' "$GR" "$RS" "$*"; }
info() { printf '%s•%s %s\n' "$CY" "$RS" "$*"; }
warn() { printf '%s!%s %s\n' "$YE" "$RS" "$*"; }
fail() { printf '%s✗%s %s\n' "$RD" "$RS" "$*" >&2; }

require_root() {
  if [[ $EUID -ne 0 ]]; then fail "must run as root"; exit 1; fi
}

# ── Crypto helpers ─────────────────────────────────────────────────────────
gen_hex() {   # gen_hex <bytes>
  openssl rand -hex "$1"
}
gen_b64() {   # gen_b64 <bytes>  (URL-safe, no padding)
  openssl rand -base64 "$1" | tr '+/' '-_' | tr -d '='
}

# Mint an HS256 JWT — payload is hardcoded apart from `role` and `exp`.
# Mirrors packages/dev/src/lib/jwt.ts::signJwt — issuer "supabase-demo",
# iat = now, exp = now + 10y.
mint_jwt() {  # mint_jwt <role> <secret_hex>
  local role="$1" secret="$2"
  local iat exp header payload h p data sig
  iat=$(date +%s)
  exp=$((iat + 10 * 365 * 24 * 3600))
  header='{"alg":"HS256","typ":"JWT"}'
  payload="{\"iss\":\"supabase-demo\",\"role\":\"$role\",\"iat\":$iat,\"exp\":$exp}"
  h=$(printf '%s' "$header"  | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  p=$(printf '%s' "$payload" | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  data="$h.$p"
  sig=$(printf '%s' "$data" | openssl dgst -sha256 -mac HMAC -macopt "hexkey:$secret" -binary \
        | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  printf '%s.%s' "$data" "$sig"
}

# ── Pre-flight ─────────────────────────────────────────────────────────────
require_root
command -v openssl >/dev/null || { fail "openssl not found"; exit 1; }
command -v docker  >/dev/null || { fail "docker not found";  exit 1; }

# ── 1. Layout ──────────────────────────────────────────────────────────────
info "creating $ROOT layout"
mkdir -p "$ROOT"/{state,backups,migrations-staging,migrations-current,functions,logs}
chmod 750 "$ROOT" "$ROOT/state" "$ROOT/backups"

# Sync deploy/ into $ROOT so all paths in compose files resolve consistently.
# IMPORTANT: --delete must not touch runtime state directories that don't
# exist in the source tree (state/, backups/, migrations-*/, functions/,
# logs/). Without these excludes, --delete wipes the dirs we just created.
info "syncing deploy/ into $ROOT"
rsync -a --delete \
  --exclude '.env' \
  --exclude 'scripts/.local' \
  --exclude 'state/' \
  --exclude 'backups/' \
  --exclude 'migrations-staging/' \
  --exclude 'migrations-current/' \
  --exclude 'functions/' \
  --exclude 'logs/' \
  "$DEPLOY_DIR/" "$ROOT/"

# Belt-and-braces: re-create runtime dirs in case rsync (or a future flag
# change) wipes them. Cheap, idempotent.
mkdir -p "$ROOT"/{state,backups,migrations-staging,migrations-current,functions,logs}
chmod 750 "$ROOT/state" "$ROOT/backups"

# Seed the edge-runtime stub so its very first boot doesn't crash-loop on
# "could not find an appropriate entrypoint". The supabase.yml workflow
# will overwrite functions/* on the first successful migration run, but
# until then this stub keeps the container healthy and answering 200.
if [[ ! -f "$ROOT/functions/main/index.ts" ]]; then
  info "seeding edge-runtime stub at functions/main/"
  mkdir -p "$ROOT/functions/main"
  cp "$DEPLOY_DIR/edge-runtime/main/index.ts" "$ROOT/functions/main/index.ts"
fi

# ── 2. Generate or load auto secrets ───────────────────────────────────────
if [[ -f "$ENV_FILE" && $ROTATE_JWT -eq 0 ]]; then
  info "$ENV_FILE exists — preserving existing secrets (use --rotate-jwt to regenerate)"
  # shellcheck disable=SC1090
  set -a; source "$ENV_FILE"; set +a
fi

POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-$(gen_hex 24)}"
SESSION_SECRET="${SESSION_SECRET:-$(gen_b64 48)}"
REALTIME_SECRET_KEY_BASE="${REALTIME_SECRET_KEY_BASE:-$(gen_b64 48)}"
# REALTIME_DB_ENC_KEY: Realtime's AES-128-ECB code path reads this env var as
# raw bytes (not hex). AES-128 needs exactly 16 bytes, so 16 ASCII chars is
# the only safe length. `gen_hex 16` would give 32 chars and triggers
# `Erlang error: Bad key size` on boot.
REALTIME_DB_ENC_KEY="${REALTIME_DB_ENC_KEY:-$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 16)}"
INNGEST_EVENT_KEY="${INNGEST_EVENT_KEY:-$(gen_hex 24)}"
# INNGEST_SIGNING_KEY: must be BARE HEX. The `signkey-prod-` prefix is only
# for SDK presentation; the `inngest start` binary parses this env var as
# hex and aborts with `signing-key must be hex string with even number of
# chars` if any non-hex characters are present.
INNGEST_SIGNING_KEY="${INNGEST_SIGNING_KEY:-$(gen_hex 24)}"

if [[ -z "${SUPABASE_JWT_SECRET:-}" || $ROTATE_JWT -eq 1 ]]; then
  info "minting Supabase JWT triple (10y validity)"
  SUPABASE_JWT_SECRET="$(gen_hex 32)"
  SUPABASE_ANON_KEY="$(mint_jwt anon "$SUPABASE_JWT_SECRET")"
  SUPABASE_SERVICE_ROLE_KEY="$(mint_jwt service_role "$SUPABASE_JWT_SECRET")"
else
  info "reusing existing SUPABASE_JWT_SECRET (use --rotate-jwt to force)"
fi

# ── 3. Render init.sql with $POSTGRES_PASSWORD ─────────────────────────────
info "rendering postgres/init.sql from template"
sed "s|\${POSTGRES_PASSWORD}|$POSTGRES_PASSWORD|g" \
  "$ROOT/postgres/init.sql.template" > "$ROOT/postgres/init.sql"
chmod 640 "$ROOT/postgres/init.sql"

# ── 4. Render /srv/dhivio/.env ─────────────────────────────────────────────
info "writing $ENV_FILE"
TMP_ENV="$(mktemp)"
cat > "$TMP_ENV" <<EOF
# Generated by bootstrap.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ)
# Single source of truth for prod. Loaded by all docker-compose stacks.

# [AUTO]
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
SESSION_SECRET=$SESSION_SECRET
SUPABASE_JWT_SECRET=$SUPABASE_JWT_SECRET
SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY=$SUPABASE_SERVICE_ROLE_KEY
REALTIME_SECRET_KEY_BASE=$REALTIME_SECRET_KEY_BASE
REALTIME_DB_ENC_KEY=$REALTIME_DB_ENC_KEY
INNGEST_EVENT_KEY=$INNGEST_EVENT_KEY
INNGEST_SIGNING_KEY=$INNGEST_SIGNING_KEY

# [AUTO] Domain
DOMAIN=dhivio.com
ERP_URL=https://erp.dhivio.com
MES_URL=https://mes.dhivio.com
SUPABASE_URL=https://api.dhivio.com
REDIS_URL=redis://redis:6379/0
INNGEST_BASE_URL=http://inngest:8288
SUPABASE_AUTH_EXTERNAL_GOOGLE_REDIRECT_URI=https://api.dhivio.com/auth/v1/callback
SUPABASE_AUTH_EXTERNAL_AZURE_REDIRECT_URI=https://api.dhivio.com/auth/v1/callback

IMAGE_TAG=${IMAGE_TAG:-latest}
CARBON_EDITION=${CARBON_EDITION:-community}
AUTH_PROVIDERS=${AUTH_PROVIDERS:-email,google}
RATE_LIMIT=${RATE_LIMIT:-5}

# Docker Hub namespace under which dhivio-erp / dhivio-mes images are pushed
# by .github/workflows/build-and-push.yml. Must match secrets.DOCKERHUB_USERNAME.
DOCKERHUB_USERNAME=${DOCKERHUB_USERNAME:-sachin4668}

# [USER] — fill these in
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID=${SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID:-}
SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET=${SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_SECRET:-}
SUPABASE_AUTH_EXTERNAL_AZURE_CLIENT_ID=${SUPABASE_AUTH_EXTERNAL_AZURE_CLIENT_ID:-}
SUPABASE_AUTH_EXTERNAL_AZURE_CLIENT_SECRET=${SUPABASE_AUTH_EXTERNAL_AZURE_CLIENT_SECRET:-}

SMTP_HOST=${SMTP_HOST:-smtp.resend.com}
SMTP_PORT=${SMTP_PORT:-465}
SMTP_USER=${SMTP_USER:-resend}
SMTP_ADMIN_EMAIL=${SMTP_ADMIN_EMAIL:-admin@dhivio.com}
SMTP_SENDER_NAME=${SMTP_SENDER_NAME:-Dhivio}
RESEND_API_KEY=${RESEND_API_KEY:-}
RESEND_DOMAIN=${RESEND_DOMAIN:-dhivio.com}

STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-}
RAZORPAY_KEY_ID=${RAZORPAY_KEY_ID:-}
RAZORPAY_KEY_SECRET=${RAZORPAY_KEY_SECRET:-}

NOVU_APPLICATION_ID=${NOVU_APPLICATION_ID:-}
NOVU_SECRET_KEY=${NOVU_SECRET_KEY:-}
POSTHOG_API_HOST=${POSTHOG_API_HOST:-https://us.posthog.com}
POSTHOG_PROJECT_PUBLIC_KEY=${POSTHOG_PROJECT_PUBLIC_KEY:-}
CLOUDFLARE_TURNSTILE_SITE_KEY=${CLOUDFLARE_TURNSTILE_SITE_KEY:-}
CLOUDFLARE_TURNSTILE_SECRET_KEY=${CLOUDFLARE_TURNSTILE_SECRET_KEY:-}
SLACK_BOT_TOKEN=${SLACK_BOT_TOKEN:-}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY:-}
OPENAI_API_KEY=${OPENAI_API_KEY:-}
GOOGLE_PLACES_API_KEY=${GOOGLE_PLACES_API_KEY:-}
GTM_EVENTS_API_SECRET_KEY=${GTM_EVENTS_API_SECRET_KEY:-}
EOF
install -m 600 "$TMP_ENV" "$ENV_FILE"
rm -f "$TMP_ENV"
ok "wrote $ENV_FILE (mode 600)"

# ── 5. Initial blue/green state ────────────────────────────────────────────
for app in erp mes; do
  [[ -f "$ROOT/state/${app}.active" ]] || echo "blue" > "$ROOT/state/${app}.active"
done

# ── 6. Docker network ──────────────────────────────────────────────────────
if ! docker network inspect dhivio_net >/dev/null 2>&1; then
  info "creating Docker network dhivio_net"
  docker network create --driver bridge dhivio_net >/dev/null
  ok "dhivio_net created"
else
  ok "dhivio_net already exists"
fi

# ── 7. Swap (2 GB) ─────────────────────────────────────────────────────────
if [[ ! -f /swapfile ]] && [[ "$(swapon --show | wc -l)" -eq 0 ]]; then
  info "provisioning 2 GB swap"
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "swap on"
fi

# ── 8. Edit prompt ─────────────────────────────────────────────────────────
echo
ok "bootstrap complete"
echo
info "next steps:"
echo "    1) Fill in the [USER] block:   \$EDITOR $ENV_FILE"
echo "    2) Issue TLS certs:            $ROOT/scripts/issue-certs.sh"
echo "    3) Boot infra:                 docker compose -f $ROOT/compose.infra.yml --env-file $ENV_FILE up -d"
echo "    4) Boot proxy:                 docker compose -f $ROOT/compose.proxy.yml --env-file $ENV_FILE up -d"
echo "    5) Trigger first deploy from GitHub Actions (workflow_dispatch)."
echo

if [[ $NON_INTERACTIVE -eq 0 ]] && [[ -t 0 ]]; then
  read -r -p "open $ENV_FILE in \$EDITOR now? [Y/n] " ans
  if [[ -z "$ans" || "$ans" =~ ^[Yy] ]]; then
    "${EDITOR:-vi}" "$ENV_FILE"
  fi
fi
