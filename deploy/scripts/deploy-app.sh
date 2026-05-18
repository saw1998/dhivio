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
  [[ -f "$PREV_TAG_FILE" ]] || { echo "no previous tag recorded — cannot rollback" >&2; exit 1; }
  PREV_TAG="$(cat "$PREV_TAG_FILE")"
  echo "↩ rolling back $APP to tag $PREV_TAG (color $IDLE)"
  IMAGE_TAG="$PREV_TAG" docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
    --profile "$IDLE" up -d "${APP}-${IDLE}"
  "$SCRIPTS/wait-healthy.sh" "dhivio-${APP}-${IDLE}" 60
  "$SCRIPTS/switch-traffic.sh" "$APP" "$IDLE"
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
IMAGE_TAG="$TARGET" docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
  --profile "$IDLE" up -d "${APP}-${IDLE}"

echo "▶ waiting for health"
"$SCRIPTS/wait-healthy.sh" "dhivio-${APP}-${IDLE}" 120 || {
  echo "✗ new color unhealthy — aborting, traffic stays on $ACTIVE" >&2
  docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
    --profile "$IDLE" stop "${APP}-${IDLE}" || true
  exit 1
}

# Record current tag as "previous" BEFORE flipping (for rollback).
docker inspect --format='{{index .Config.Labels "org.opencontainers.image.version"}}' \
  "dhivio-${APP}-${ACTIVE}" 2>/dev/null > "$ROOT/state/${APP}.previous_tag" || \
  echo "latest" > "$ROOT/state/${APP}.previous_tag"

echo "▶ flipping nginx upstream"
"$SCRIPTS/switch-traffic.sh" "$APP" "$IDLE"

echo "▶ draining old color (15s)"
sleep 15

echo "▶ stopping old color ($ACTIVE)"
docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
  --profile "$ACTIVE" stop "${APP}-${ACTIVE}" || true

echo "$IDLE"   > "$STATE_FILE"
echo "$TARGET" > "$ROOT/state/${APP}.current_tag"

echo "✓ $APP deployed: tag=$TARGET color=$IDLE"
