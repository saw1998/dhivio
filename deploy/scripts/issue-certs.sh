#!/usr/bin/env bash
###
# issue-certs.sh
#
# Issues / renews a single multi-SAN Let's Encrypt certificate that covers
# erp.dhivio.com, mes.dhivio.com, and api.dhivio.com. The cert is stored
# at /etc/letsencrypt/live/dhivio.com/ (the lineage name is the first -d
# domain, which we force to the base 'dhivio.com' via --cert-name so the
# path is stable regardless of SAN ordering).
#
# Why multi-SAN instead of one cert per host:
#   1. Sidesteps LE's "duplicate certificate" rate-limit (5 identical
#      identifier sets per 168h). A SAN cert is a *different* identifier
#      set than its components.
#   2. Single renewal job → simpler ops and lower failure surface.
#   3. All 3 hostnames share the same VPS and same root-user surface
#      anyway; per-host private-key isolation buys ~nothing in this
#      architecture.
#
# Solves the chicken-and-egg of the first issuance: nginx vhosts hard-
# reference the cert files, so the nginx container refuses to start with no
# certs on disk. On the very first run we therefore use certbot's
# `--standalone` plugin (certbot itself binds :80) instead of webroot.
# Subsequent renewals are handled by the certbot sidecar in compose.proxy.yml
# in webroot mode (no downtime).
#
# Failure safety: if anything fails between stopping nginx and starting it
# again, an EXIT trap re-seeds the placeholder cert and restarts nginx so
# the proxy stack is never left in a broken / non-bootable state. Prior
# behaviour: `set -e` could leave nginx down with a deleted cert file.
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

# All SANs go into ONE cert, stored under live/$CERT_NAME/.
CERT_NAME="dhivio.com"
SANS=(erp.dhivio.com mes.dhivio.com api.dhivio.com)
ENV_FILE="$ROOT/.env"

if [[ -t 1 ]]; then GR=$'\e[32m'; YE=$'\e[33m'; CY=$'\e[36m'; RD=$'\e[31m'; RS=$'\e[0m'
else GR=; YE=; CY=; RD=; RS=; fi
ok()   { printf '%s✓%s %s\n' "$GR" "$RS" "$*"; }
info() { printf '%s•%s %s\n' "$CY" "$RS" "$*"; }
warn() { printf '%s!%s %s\n' "$YE" "$RS" "$*"; }
err()  { printf '%s✗%s %s\n' "$RD" "$RS" "$*" >&2; }

# Volume names (compose prefixes them with the project name `dhivio-proxy`).
VOL_ETC="dhivio-proxy_certbot-etc"
VOL_WWW="dhivio-proxy_certbot-www"

# Make sure both volumes exist even if the proxy stack was never `up`'d yet.
docker volume create "$VOL_ETC" >/dev/null
docker volume create "$VOL_WWW" >/dev/null

# Make sure the docker network exists (bootstrap creates it; harmless if so).
docker network inspect dhivio_net >/dev/null 2>&1 \
  || docker network create --driver bridge dhivio_net >/dev/null

# ── Helper: drop a self-signed snake-oil cert in place ─────────────────────
# A 30-day RSA-2048 cert with all SANs, so nginx can boot even before LE.
seed_placeholder() {
  local name="$1"; shift
  local sans=("$@")

  # Build SAN list (DNS.1 = sans[0], DNS.2 = sans[1], ...)
  local san_lines=""
  local i=1
  for s in "${sans[@]}"; do
    san_lines+="DNS.${i} = $s"

# ── Failure-safe wrapper: if we exit non-zero between stop and start of ──
# ── nginx, restore a placeholder and bring nginx back up.                ──
NGINX_STOPPED=0
on_exit() {
  local rc=$?
  if (( rc != 0 )) && (( NGINX_STOPPED == 1 )); then
    warn "script failed (rc=$rc) with nginx stopped — restoring placeholder + restarting nginx"
    # Re-seed only if real cert isn't there
    if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
         test -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"; then
      seed_placeholder "$CERT_NAME" "${SANS[@]}"
    fi
    # Also re-seed legacy per-host placeholders if any vhost still references them
    # (back-compat for upgrades from the previous one-cert-per-host layout)
    for legacy in "${SANS[@]}"; do
      if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
           test -f "/etc/letsencrypt/live/$legacy/fullchain.pem"; then
        seed_placeholder "$legacy" "$legacy"
      fi
    done
    docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" up -d nginx || true
    err "nginx restored to placeholder state. fix the underlying error then re-run."
  fi
  exit "$rc"
}
trap on_exit EXIT

# ── Always ensure the multi-SAN placeholder exists (so nginx with the new ─
# ── shared-cert vhost configs can always boot, even before LE issues).    ─
if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
     test -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"; then
  info "seeding placeholder cert for $CERT_NAME (SAN ${SANS[*]})"
  seed_placeholder "$CERT_NAME" "${SANS[@]}"
fi

# ── Legacy per-host placeholders — keep alive only if real LE not present.
# This makes upgrades from the old layout (one cert per host) idempotent:
# we don't delete them until the SAN cert is in place, and we never break
# nginx configs that may still point to them mid-rollout.
for legacy in "${SANS[@]}"; do
  if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
       test -f "/etc/letsencrypt/live/$legacy/fullchain.pem"; then
    info "seeding legacy per-host placeholder for $legacy (back-compat)"
    seed_placeholder "$legacy" "$legacy"
  fi
done

# ── Decide if we even need to issue ────────────────────────────────────────
# certbot stores the lineage under the --cert-name we'll pass, so we look
# for it by exact name (not by domain match — `certificates | grep Domains:`
# would also match our placeholder fake-cert).
NEEDS_ISSUE=1
EXISTING_INFO="$(docker run --rm -v "$VOL_ETC":/etc/letsencrypt certbot/certbot \
  certificates --cert-name "$CERT_NAME" 2>/dev/null || true)"
if echo "$EXISTING_INFO" | grep -q "Certificate Name: $CERT_NAME"; then
  # Verify it covers all SANs — if SAN list changed, we re-issue
  MISSING=0
  for s in "${SANS[@]}"; do
    if ! echo "$EXISTING_INFO" | grep -qE "Domains:.*\b$s\b"; then
      warn "existing cert $CERT_NAME does not cover $s — will re-issue"
      MISSING=1
      break
    fi
  done
  if (( MISSING == 0 )); then
    ok "cert $CERT_NAME already covers all SANs — skipping issuance"
    NEEDS_ISSUE=0
  fi
fi

if (( NEEDS_ISSUE == 0 )); then
  # Still reload nginx in case configs changed — harmless if not.
  if docker ps --format '{{.Names}}' | grep -qx dhivio-nginx; then
    docker exec dhivio-nginx nginx -t && \
      docker exec dhivio-nginx nginx -s reload || true
  fi
  ok "nothing to do"
  exit 0
fi

# ── Free port 80 for certbot --standalone ──────────────────────────────────
if docker ps --format '{{.Names}}' | grep -qx dhivio-nginx; then
  info "stopping dhivio-nginx so certbot can bind :80"
  docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" stop nginx
  NGINX_STOPPED=1
fi

# Sanity check: anything still on :80?
if ss -tln '( sport = :80 )' | grep -q ':80\b'; then
  warn "something is still listening on :80 — certbot will fail. Free it first:"
  ss -tlnp '( sport = :80 )' || true
  exit 1
fi

# ── Issue ONE multi-SAN cert in --standalone mode ──────────────────────────
# Build -d args
D_ARGS=()
for s in "${SANS[@]}"; do D_ARGS+=(-d "$s"); done

info "issuing multi-SAN cert: $CERT_NAME (SANs: ${SANS[*]})"

# certbot refuses to write into a `live/<name>/` directory it didn't create
# itself. Wipe the snake-oil scaffolding so it can take over. nginx is
# stopped, nothing reads these files right now.
info "clearing placeholder for $CERT_NAME"
docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 sh -c "
  rm -rf /etc/letsencrypt/live/$CERT_NAME \
         /etc/letsencrypt/archive/$CERT_NAME \
         /etc/letsencrypt/renewal/$CERT_NAME.conf
"

docker run --rm \
  -p 80:80 \
  -v "$VOL_ETC":/etc/letsencrypt \
  -v "$VOL_WWW":/var/www/certbot \
  certbot/certbot certonly \
    --standalone \
    --preferred-challenges http \
    --non-interactive --agree-tos \
    --cert-name "$CERT_NAME" \
    -m "$EMAIL" \
    "${D_ARGS[@]}" \
    "${SERVER_ARGS[@]}"

ok "cert issued; lineage stored at /etc/letsencrypt/live/$CERT_NAME/"

# ── Bring nginx back up with the new cert ──────────────────────────────────
info "starting proxy stack with freshly-issued cert"
docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" up -d
NGINX_STOPPED=0   # success path — disarm the EXIT trap recovery

# Reload (in case nginx was already up but pre-cert)
sleep 2
docker exec dhivio-nginx nginx -t
docker exec dhivio-nginx nginx -s reload || true

ok "all certs issued; proxy stack live on :80 + :443"
echo
echo "    Verify: curl -I https://erp.dhivio.com/_nginx_health"
echo "    Issuer: echo | openssl s_client -connect erp.dhivio.com:443 \\"
echo "              -servername erp.dhivio.com 2>/dev/null \\"
echo "              | openssl x509 -noout -issuer"
\n'
    i=$((i+1))
  done

  # Generate openssl config on host then bind-mount into the container.
  # Doing it inside via heredoc is fragile under multi-layer quoting (SSH
  # → bash -c → docker sh -c).
  local tmp_cnf
  tmp_cnf="$(mktemp)"
  cat >"$tmp_cnf" <<CNF
[req]
distinguished_name = req_dn
x509_extensions    = v3_req
prompt             = no
[req_dn]
CN = ${sans[0]}
[v3_req]
keyUsage         = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName   = @alt_names
[alt_names]
${san_lines}
CNF

  docker run --rm \
    -v "$VOL_ETC":/etc/letsencrypt \
    -v "$tmp_cnf":/tmp/san.cnf:ro \
    alpine:3.20 sh -c "
      set -e
      apk add --no-cache openssl >/dev/null
      mkdir -p /etc/letsencrypt/live/$name
      openssl req -x509 -nodes -newkey rsa:2048 -days 30 \
        -keyout /etc/letsencrypt/live/$name/privkey.pem \
        -out    /etc/letsencrypt/live/$name/fullchain.pem \
        -config /tmp/san.cnf -extensions v3_req >/dev/null 2>&1
      echo '  seeded placeholder $name (SAN: ${sans[*]})'
    "

  rm -f "$tmp_cnf"
}

# ── Failure-safe wrapper: if we exit non-zero between stop and start of ──
# ── nginx, restore a placeholder and bring nginx back up.                ──
NGINX_STOPPED=0
on_exit() {
  local rc=$?
  if (( rc != 0 )) && (( NGINX_STOPPED == 1 )); then
    warn "script failed (rc=$rc) with nginx stopped — restoring placeholder + restarting nginx"
    # Re-seed only if real cert isn't there
    if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
         test -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"; then
      seed_placeholder "$CERT_NAME" "${SANS[@]}"
    fi
    # Also re-seed legacy per-host placeholders if any vhost still references them
    # (back-compat for upgrades from the previous one-cert-per-host layout)
    for legacy in "${SANS[@]}"; do
      if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
           test -f "/etc/letsencrypt/live/$legacy/fullchain.pem"; then
        seed_placeholder "$legacy" "$legacy"
      fi
    done
    docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" up -d nginx || true
    err "nginx restored to placeholder state. fix the underlying error then re-run."
  fi
  exit "$rc"
}
trap on_exit EXIT

# ── Always ensure the multi-SAN placeholder exists (so nginx with the new ─
# ── shared-cert vhost configs can always boot, even before LE issues).    ─
if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
     test -f "/etc/letsencrypt/live/$CERT_NAME/fullchain.pem"; then
  info "seeding placeholder cert for $CERT_NAME (SAN ${SANS[*]})"
  seed_placeholder "$CERT_NAME" "${SANS[@]}"
fi

# ── Legacy per-host placeholders — keep alive only if real LE not present.
# This makes upgrades from the old layout (one cert per host) idempotent:
# we don't delete them until the SAN cert is in place, and we never break
# nginx configs that may still point to them mid-rollout.
for legacy in "${SANS[@]}"; do
  if ! docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 \
       test -f "/etc/letsencrypt/live/$legacy/fullchain.pem"; then
    info "seeding legacy per-host placeholder for $legacy (back-compat)"
    seed_placeholder "$legacy" "$legacy"
  fi
done

# ── Decide if we even need to issue ────────────────────────────────────────
# certbot stores the lineage under the --cert-name we'll pass, so we look
# for it by exact name (not by domain match — `certificates | grep Domains:`
# would also match our placeholder fake-cert).
NEEDS_ISSUE=1
EXISTING_INFO="$(docker run --rm -v "$VOL_ETC":/etc/letsencrypt certbot/certbot \
  certificates --cert-name "$CERT_NAME" 2>/dev/null || true)"
if echo "$EXISTING_INFO" | grep -q "Certificate Name: $CERT_NAME"; then
  # Verify it covers all SANs — if SAN list changed, we re-issue
  MISSING=0
  for s in "${SANS[@]}"; do
    if ! echo "$EXISTING_INFO" | grep -qE "Domains:.*\b$s\b"; then
      warn "existing cert $CERT_NAME does not cover $s — will re-issue"
      MISSING=1
      break
    fi
  done
  if (( MISSING == 0 )); then
    ok "cert $CERT_NAME already covers all SANs — skipping issuance"
    NEEDS_ISSUE=0
  fi
fi

if (( NEEDS_ISSUE == 0 )); then
  # Still reload nginx in case configs changed — harmless if not.
  if docker ps --format '{{.Names}}' | grep -qx dhivio-nginx; then
    docker exec dhivio-nginx nginx -t && \
      docker exec dhivio-nginx nginx -s reload || true
  fi
  ok "nothing to do"
  exit 0
fi

# ── Free port 80 for certbot --standalone ──────────────────────────────────
if docker ps --format '{{.Names}}' | grep -qx dhivio-nginx; then
  info "stopping dhivio-nginx so certbot can bind :80"
  docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" stop nginx
  NGINX_STOPPED=1
fi

# Sanity check: anything still on :80?
if ss -tln '( sport = :80 )' | grep -q ':80\b'; then
  warn "something is still listening on :80 — certbot will fail. Free it first:"
  ss -tlnp '( sport = :80 )' || true
  exit 1
fi

# ── Issue ONE multi-SAN cert in --standalone mode ──────────────────────────
# Build -d args
D_ARGS=()
for s in "${SANS[@]}"; do D_ARGS+=(-d "$s"); done

info "issuing multi-SAN cert: $CERT_NAME (SANs: ${SANS[*]})"

# certbot refuses to write into a `live/<name>/` directory it didn't create
# itself. Wipe the snake-oil scaffolding so it can take over. nginx is
# stopped, nothing reads these files right now.
info "clearing placeholder for $CERT_NAME"
docker run --rm -v "$VOL_ETC":/etc/letsencrypt alpine:3.20 sh -c "
  rm -rf /etc/letsencrypt/live/$CERT_NAME \
         /etc/letsencrypt/archive/$CERT_NAME \
         /etc/letsencrypt/renewal/$CERT_NAME.conf
"

docker run --rm \
  -p 80:80 \
  -v "$VOL_ETC":/etc/letsencrypt \
  -v "$VOL_WWW":/var/www/certbot \
  certbot/certbot certonly \
    --standalone \
    --preferred-challenges http \
    --non-interactive --agree-tos \
    --cert-name "$CERT_NAME" \
    -m "$EMAIL" \
    "${D_ARGS[@]}" \
    "${SERVER_ARGS[@]}"

ok "cert issued; lineage stored at /etc/letsencrypt/live/$CERT_NAME/"

# ── Bring nginx back up with the new cert ──────────────────────────────────
info "starting proxy stack with freshly-issued cert"
docker compose --env-file "$ENV_FILE" -f "$ROOT/compose.proxy.yml" up -d
NGINX_STOPPED=0   # success path — disarm the EXIT trap recovery

# Reload (in case nginx was already up but pre-cert)
sleep 2
docker exec dhivio-nginx nginx -t
docker exec dhivio-nginx nginx -s reload || true

ok "all certs issued; proxy stack live on :80 + :443"
echo
echo "    Verify: curl -I https://erp.dhivio.com/_nginx_health"
echo "    Issuer: echo | openssl s_client -connect erp.dhivio.com:443 \\"
echo "              -servername erp.dhivio.com 2>/dev/null \\"
echo "              | openssl x509 -noout -issuer"
