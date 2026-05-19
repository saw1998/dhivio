#!/usr/bin/env bash
###
# deploy-app.sh <app> <image-tag|rollback>
#
#   app       = erp | mes
#   image-tag = docker hub tag to roll out (e.g. github SHA, "latest")
#               OR the literal string "rollback" to revert to the previous
#               color (which is still on disk).
#
# Strategy (zero-downtime blue/green):
#   1. Determine active and idle colors.
#   2. `docker pull` the new image (only changed layers transfer).
#   3. Boot the idle color via compose.apps.yml — uses profile=<color> so
#      only that container starts.
#   4. wait-healthy.sh — block until the container is healthy.
#   5. switch-traffic.sh — atomic nginx upstream flip + reload.
#   6. Sleep 15s grace window so in-flight requests drain on the old color.
#   7. Stop the old color (image stays on disk for instant rollback).
#   8. Persist the new active color in /srv/dhivio/state/<app>.active.
###
set -euo pipefail

APP="${1:?app required (erp|mes)}"
TARGET="${2:?image tag or 'rollback' required}"
[[ "$APP" =~ ^(erp|mes)$ ]] || { echo "bad app: $APP" >&2; exit 2; }

ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
ENV_FILE="$ROOT/.env"
STATE_FILE="$ROOT/state/${APP}.active"
APPS_COMPOSE="$ROOT/compose.apps.yml"
SCRIPTS="$ROOT/scripts"

# Pull DOCKERHUB_USERNAME (and any other vars we need outside compose) into
# our own shell. We don't `set -a; source` the whole file because it would
# overwrite IMAGE_TAG / TARGET / etc.
if [[ -f "$ENV_FILE" ]]; then
  DOCKERHUB_USERNAME="$(grep -E '^DOCKERHUB_USERNAME=' "$ENV_FILE" | cut -d= -f2- || true)"
fi
: "${DOCKERHUB_USERNAME:=sachin4668}"

ACTIVE="$(cat "$STATE_FILE" 2>/dev/null || echo blue)"
IDLE=$([[ "$ACTIVE" == "blue" ]] && echo green || echo blue)

echo "▶ $APP : active=$ACTIVE idle=$IDLE target=$TARGET"

# ── Rollback path ──────────────────────────────────────────────────────────
if [[ "$TARGET" == "rollback" ]]; then
  PREV_TAG_FILE="$ROOT/state/${APP}.previous_tag"
  [[ -s "$PREV_TAG_FILE" ]] || {
    echo "✗ no previous tag recorded — cannot rollback (state/${APP}.previous_tag is missing or empty)" >&2
    echo "  This is normal on the very first deploy; subsequent deploys populate previous_tag automatically." >&2
    exit 1
  }
  PREV_TAG="$(cat "$PREV_TAG_FILE")"
  echo "↩ rolling back $APP to tag $PREV_TAG (color $IDLE)"
  IMAGE_TAG="$PREV_TAG" docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
    --profile "$IDLE" up -d "${APP}-${IDLE}"
  "$SCRIPTS/wait-healthy.sh" "dhivio-${APP}-${IDLE}" 60
  "$SCRIPTS/switch-traffic.sh" "$APP" "$IDLE"
  # Alias is set declaratively in compose; no manual juggling needed.
  sleep 15
  docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
    --profile "$ACTIVE" stop "${APP}-${ACTIVE}"
  echo "$IDLE" > "$STATE_FILE"
  echo "✓ rollback complete"
  exit 0
fi

# ── Forward deploy ─────────────────────────────────────────────────────────
# Image path is `${DOCKERHUB_USERNAME}/dhivio-<app>` (single-namespace; Docker
# Hub doesn't accept `a/b/c`). DOCKERHUB_USERNAME was extracted from
# $ENV_FILE near the top of the script.
IMAGE="${DOCKERHUB_USERNAME}/dhivio-${APP}:${TARGET}"
echo "▶ pulling ${IMAGE}"
docker pull "${IMAGE}"

echo "▶ booting idle color ($IDLE) with new image"
# --force-recreate ensures the container is rebuilt with the latest compose
# spec, which is critical because a previous `docker network disconnect` (e.g.
# from a failed rollover) can leave the container detached from dhivio_net.
# Without --force-recreate, `compose up` would just `docker start` the stale
# container, keeping it isolated; nginx would then fail to resolve it.
IMAGE_TAG="$TARGET" docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
  --profile "$IDLE" up -d --force-recreate "${APP}-${IDLE}"

# Belt-and-braces: explicitly ensure the new container is on dhivio_net.
# (Compose should do this automatically given `networks.default.name=dhivio_net,
# external: true`, but if something went wrong we'd rather know now than 90s
# later when wait-healthy returns but nginx 502s.)
if ! docker network inspect dhivio_net --format '{{range .Containers}}{{.Name}} {{end}}' \
     | grep -qw "dhivio-${APP}-${IDLE}"; then
  echo "  ↳ re-attaching dhivio-${APP}-${IDLE} to dhivio_net"
  docker network connect dhivio_net "dhivio-${APP}-${IDLE}"
fi

echo "▶ waiting for health"
"$SCRIPTS/wait-healthy.sh" "dhivio-${APP}-${IDLE}" 120 || {
  echo "✗ new color unhealthy — aborting, traffic stays on $ACTIVE" >&2
  docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
    --profile "$IDLE" stop "${APP}-${IDLE}" || true
  exit 1
}

# Record the currently-deployed tag as "previous" BEFORE flipping (for
# rollback). We read it from state/${APP}.current_tag, not from
# `docker inspect`, because the inspect approach relied on an OCI label
# (`org.opencontainers.image.version`) that the Dockerfiles don't set —
# leaving previous_tag empty and breaking the rollback path.
PREV_FILE="$ROOT/state/${APP}.previous_tag"
CURR_FILE="$ROOT/state/${APP}.current_tag"
if [[ -s "$CURR_FILE" ]]; then
  cp "$CURR_FILE" "$PREV_FILE"
else
  # Fresh deploy with no current_tag yet (e.g. the first ever rollout) —
  # mark rollback as unavailable so deploy-app.sh rollback fails loudly
  # instead of silently downgrading to "latest".
  : > "$PREV_FILE"
fi

echo "▶ flipping nginx upstream"
"$SCRIPTS/switch-traffic.sh" "$APP" "$IDLE"

# Internal `${APP}-active` DNS alias is set declaratively in
# compose.apps.yml (`networks.default.aliases: [erp-active]`) on BOTH the
# blue and green services. Docker's embedded DNS returns whichever color is
# currently running; when the old color stops below, its IP drops out of
# the alias automatically. No live `docker network disconnect/connect`
# is performed — that approach invalidated nginx's resolver cache.

echo "▶ draining old color (15s)"
sleep 15

echo "▶ stopping old color ($ACTIVE)"
docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
  --profile "$ACTIVE" stop "${APP}-${ACTIVE}" || true

echo "$IDLE"   > "$STATE_FILE"
echo "$TARGET" > "$ROOT/state/${APP}.current_tag"

echo "✓ $APP deployed: tag=$TARGET color=$IDLE"
