#!/usr/bin/env bash
###
# run-migrations.sh <staged-folder>
#
# Applies Supabase migrations against the self-hosted postgres on the VPS.
# Called by .github/workflows/supabase.yml after rsync'ing the migrations to
# /srv/dhivio/migrations-staging/<run-id>/.
#
# Strategy:
#   1. Take a pre-migration pg_dump (backup-db.sh).
#   2. Spin up a throwaway `supabase/cli` container joined to dhivio_net.
#   3. Run `supabase db push --include-all` against postgres://postgres@postgres:5432.
#   4. Deploy edge functions into the live edge-runtime volume.
#   5. Promote the staged folder to /srv/dhivio/migrations-current/<sha>.
###
set -euo pipefail

STAGED="${1:?staged migrations folder required}"
[[ -d "$STAGED/supabase/migrations" ]] || {
  echo "✗ $STAGED/supabase/migrations not found" >&2; exit 1; }

ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
ENV_FILE="$ROOT/.env"
set -a; source "$ENV_FILE"; set +a

RUN_ID="$(basename "$STAGED")"
DUMP_LABEL="pre-migration-${RUN_ID}"

# ── 1. Backup ──────────────────────────────────────────────────────────────
"$ROOT/scripts/backup-db.sh" "$DUMP_LABEL"

# ── 2. Push migrations from a Supabase CLI sidecar ─────────────────────────
echo "▶ applying migrations from $STAGED"
docker run --rm \
  --network dhivio_net \
  -v "$STAGED/supabase:/workspace/supabase:ro" \
  -w /workspace \
  -e SUPABASE_DB_URL="postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/postgres" \
  -e PGSSLMODE=disable \
  supabase/cli:latest \
  db push \
    --db-url "postgresql://postgres:${POSTGRES_PASSWORD}@postgres:5432/postgres" \
    --include-all

# ── 3. Deploy edge functions (copy into the volume, restart edge-runtime) ──
if [[ -d "$STAGED/supabase/functions" ]]; then
  echo "▶ syncing edge functions"
  rsync -a --delete \
    "$STAGED/supabase/functions/" \
    "$ROOT/functions/"
  docker restart dhivio-edge-runtime >/dev/null
fi

# ── 4. Promote ─────────────────────────────────────────────────────────────
mkdir -p "$ROOT/migrations-current"
rsync -a --delete "$STAGED/" "$ROOT/migrations-current/${RUN_ID}/"
ln -sfn "$ROOT/migrations-current/${RUN_ID}" "$ROOT/migrations-current/latest"

echo "✓ migrations applied (run $RUN_ID)"
