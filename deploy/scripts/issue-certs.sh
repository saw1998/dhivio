#!/usr/bin/env bash
###
# issue-certs.sh
#
# Issues / renews Let's Encrypt certs for erp.dhivio.com, mes.dhivio.com,
# api.dhivio.com.
#
# Solves the chicken-and-egg of the first issuance: nginx vhosts hard-
# reference the cert files, so the nginx container refuses to start with no
# certs on disk. On the very first run we therefore use certbot's
# `--standalone` plugin (certbot itself binds :80) instead of webroot.
# Subsequent renewals are handled by the certbot sidecar in compose.proxy.yml
# in webroot mode (no downtime).
#
# Pre-req: DNS A/AAAA records already point to this VPS, and ports 80/443
# are open in any host or provider firewall.
###
set -euo pipefail

ROOT="${DHIVIO_ROOT:-/srv/dhivio}"

# Load env vars from .env file (if present) — lets users set LETSENCRYPT_SERVER
# (and other certbot-related vars) without needing sudo to preserve them.
if [[ -f "$ROOT/.env" ]]; then
  set -a
  source "$ROOT/.env"
  set +a
fi

EMAIL="${LETSENCRYPT_EMAIL:-admin@dhivio.com}"
SERVER="${LETSENCRYPT_SERVER:-}"

# Build --server args when a non-production ACME server is configured
SERVER_ARGS=()
if [[ -n "$SERVER" ]]; then
  SERVER_ARGS=(--server "$SERVER")
fi

DOMAINS=(erp.dhivio.com mes.dhivio.com api.dhivio.com)
ENV_FILE="$ROOT/.env"

if [[ -t 1 ]]; then GR=$'\e[32m'; YE=$'\e[33m'; CY=$'\e[36m'; RS=$'\e[0m'
else GR=; YE=; CY=; RS=; fi
ok()   { printf '%s✓%s %s\n' "$GR" "$RS" "$*"; }
info() { printf '%s•%s %s\n' "$CY" "$RS" "$*"; }
warn() { printf '%s!%s %s\n' "$YE" "$RS" "$*"; }

# Volume names (compose prefixes them with the project name `dhivio-proxy`).
VOL_ETC="dhivio-proxy_certbot-etc"
VOL_WWW="dhivio-proxy_certbot-www"

# Make sure both volumes exist even if the proxy stack was never `up`'d yet.
docker volume create "$VOL_ETC" >/dev/null
docker volume create "$VOL_WWW" >/dev/null

# Make sure the docker network exists (bootstrap creates it; harmless if so).
docker network inspect dhivio_net >/dev/null 2>&1 \
  || docker network create --driver bridge dhivio_net >/dev/null

# ── Seed self-signed snake-oil certs for any missing domain ────────────────
# nginx vhosts hard-reference the cert paths, so the container refuses to
# start without them. Drop a 30-day self-signed cert in place so nginx can
# always boot; certbot will overwrite with a real cert below.
info "seeding placeholder certs for domains with no real cert yet"
for D in "${DOMAINS[@]}"; do
  docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 sh -c "
    set -e
    if [ ! -f /etc/letsencrypt/live/$D/fullchain.pem ]; then
      apk add --no-cache openssl >/dev/null
      mkdir -p /etc/letsencrypt/live/$D
      openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
        -keyout /etc/letsencrypt/live/$D/privkey.pem \
        -out    /etc/letsencrypt/live/$D/fullchain.pem \
        -subj '/CN=$D' >/dev/null 2>&1
      echo '  seeded $D'
    fi
  "
done

# ── Determine which domains still need a cert ──────────────────────────────
NEED=()
for D in "${DOMAINS[@]}"; do
  if docker run --rm -v "$VOL_ETC":/etc/letsencrypt certbot/certbot \
       certificates 2>/dev/null | grep -q "Domains: $D\b"; then
    ok "$D already has a cert — skipping"
  else
    NEED+=("$D")
  fi
done

if [[ ${#NEED[@]} -eq 0 ]]; then
  ok "all certs present; nothing to do"
  exit 0
fi

# ── Free port 80 for certbot --standalone ──────────────────────────────────
if docker ps --format '{{.Names}}' | grep -qx dhivio-nginx; then
  info "stopping dhivio-nginx so certbot can bind :80"
  docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" stop nginx
fi

# Sanity check: anything still on :80?
if ss -tln '( sport = :80 )' | grep -q ':80\b'; then
  warn "something is still listening on :80 — certbot will fail. Free it first:"
  ss -tlnp '( sport = :80 )' || true
  exit 1
fi

# ── Issue certs in --standalone mode (certbot binds :80 itself) ────────────
# certbot refuses to write into a `live/<domain>/` directory it didn't
# create itself, so we wipe the snake-oil scaffolding for the domains we're
# about to issue. nginx is stopped at this point, so nothing is reading
# those files; the proxy stack will pick up the real certs when it restarts.
for D in "${NEED[@]}"; do
  info "clearing placeholder for $D"
  docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 sh -c "
    rm -rf /etc/letsencrypt/live/$D \
           /etc/letsencrypt/archive/$D \
           /etc/letsencrypt/renewal/$D.conf
  "

  info "issuing cert for $D (standalone mode)"
  docker run --rm \
    -p 80:80 \
    -v "$VOL_ETC":/etc/letsencrypt \
    -v "$VOL_WWW":/var/www/certbot \
    certbot/certbot certonly \
      --standalone \
      --preferred-challenges http \
      --non-interactive --agree-tos \
      -m "$EMAIL" \
      -d "$D" \
      "${SERVER_ARGS[@]}"
done

# ── Bring nginx back up with the new certs ─────────────────────────────────
info "starting proxy stack with freshly-issued certs"
docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" up -d

# Reload (in case nginx was already up but pre-cert)
sleep 2
docker exec dhivio-nginx nginx -t
docker exec dhivio-nginx nginx -s reload || true

ok "all certs issued; proxy stack live on :80 + :443"
echo
echo "    Verify: curl -I https://erp.dhivio.com/_nginx_health"
