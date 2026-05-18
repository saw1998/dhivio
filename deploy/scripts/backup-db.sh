#!/usr/bin/env bash
# backup-db.sh [label]
# pg_dump the live postgres into /srv/dhivio/backups/<label>-<timestamp>.dump.
# Retains the 30 most recent backups; older ones are pruned.
set -euo pipefail
LABEL="${1:-manual}"
ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
ENV_FILE="$ROOT/.env"
set -a; source "$ENV_FILE"; set +a

TS="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$ROOT/backups/${LABEL}-${TS}.dump"

echo "▶ pg_dump → $OUT"
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" dhivio-postgres \
  pg_dump -U postgres -h localhost -F c -d postgres > "$OUT"

# Retain 30 most recent
ls -1t "$ROOT/backups"/*.dump 2>/dev/null | tail -n +31 | xargs -r rm -f

echo "✓ backup complete ($(du -h "$OUT" | cut -f1))"
