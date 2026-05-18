#!/usr/bin/env bash
# wait-healthy.sh <container> [timeout-seconds]
# Polls `docker inspect` until the container reports Health.Status=healthy.
set -euo pipefail
CONTAINER="${1:?container name required}"
TIMEOUT="${2:-90}"

end=$(( $(date +%s) + TIMEOUT ))
while [[ $(date +%s) -lt $end ]]; do
  status=$(docker inspect --format='{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo "missing")
  case "$status" in
    healthy)   echo "✓ $CONTAINER healthy"; exit 0 ;;
    unhealthy) echo "✗ $CONTAINER reports unhealthy" >&2; docker logs --tail 80 "$CONTAINER" >&2; exit 1 ;;
    missing)   echo "? $CONTAINER not running yet…" >&2 ;;
    *)         printf '. %s\n' "$status" ;;
  esac
  sleep 2
done
echo "✗ timeout after ${TIMEOUT}s waiting for $CONTAINER" >&2
docker logs --tail 80 "$CONTAINER" >&2 || true
exit 1
