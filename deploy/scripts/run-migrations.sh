#!/usr/bin/env bash
###############################################################################
# run-migrations.sh <staged-folder>
#
# Applies Supabase-style migrations against the self-hosted postgres on the VPS.
# Called by .github/workflows/supabase.yml after rsync'ing the migrations to
#   /srv/dhivio/migrations-staging/<run-id>/
#
# Strategy (no `supabase` CLI required — that image doesn't exist on Docker Hub):
#   1. pg_dump backup via backup-db.sh.
#   2. Create supabase_migrations.schema_migrations bookkeeping table if absent.
#   3. Diff staged *.sql filenames against rows in schema_migrations.
#   4. Apply each missing migration chronologically, in its own transaction,
#      via `psql` inside the dhivio-postgres container.
#   5. Record each applied filename in schema_migrations.
#   6. rsync edge-functions, restart dhivio-edge-runtime.
#   7. Promote staged folder to migrations-current/<run-id> + latest symlink.
#
# Idempotency: re-running is safe — already-applied migrations are skipped.
# Atomicity:   each migration is wrapped in BEGIN/COMMIT. A failure halts the
#              run (set -e) and leaves the partial work rolled back; the bookkeeping
#              row is only written after COMMIT succeeds.
###############################################################################
set -euo pipefail

STAGED="${1:?staged migrations folder required}"
[[ -d "$STAGED/supabase/migrations" ]] || {
  echo "✗ $STAGED/supabase/migrations not found" >&2; exit 1; }

ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
ENV_FILE="$ROOT/.env"
[[ -f "$ENV_FILE" ]] || { echo "✗ $ENV_FILE not found" >&2; exit 1; }
set -a; source "$ENV_FILE"; set +a

RUN_ID="$(basename "$STAGED")"
MIG_DIR="$STAGED/supabase/migrations"
FUNCS_DIR="$STAGED/supabase/functions"
SRC_DIR="$STAGED/supabase/src"
PG_CONTAINER="dhivio-postgres"

# Connect as `supabase_admin` (superuser, owner of storage/auth/realtime
# schemas) rather than `postgres`. Many Supabase migrations carry policies
# and grants on storage.objects / auth.users etc. that only the schema owner
# may modify — using `postgres` produces `must be owner of table objects`.
# `supabase_admin` shares the same password (POSTGRES_PASSWORD) by image
# convention.
PG_USER="supabase_admin"

# ── 1. Backup ─────────────────────────────────────────────────────────────
"$ROOT/scripts/backup-db.sh" "pre-migration-${RUN_ID}"

# ── psql helper: runs a single statement against postgres ─────────────────
psql_run() {
  docker exec -i \
    -e PGPASSWORD="$POSTGRES_PASSWORD" \
    "$PG_CONTAINER" \
    psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres "$@"
}

# ── 2. Bookkeeping table ──────────────────────────────────────────────────
echo "▶ ensuring supabase_migrations.schema_migrations exists"
psql_run <<'SQL'
CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (
  version    text PRIMARY KEY,
  statements text[],
  name       text,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

# ── 3. Compute diff ───────────────────────────────────────────────────────
mapfile -t ALL_MIGS < <(ls -1 "$MIG_DIR"/*.sql | sort)
mapfile -t APPLIED  < <(psql_run -tAc "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version;" || true)

declare -A APPLIED_SET
for v in "${APPLIED[@]}"; do APPLIED_SET["$v"]=1; done

PENDING=()
for path in "${ALL_MIGS[@]}"; do
  fname="$(basename "$path")"
  # version = numeric prefix (e.g. 20230123003711)
  version="${fname%%_*}"
  if [[ -z "${APPLIED_SET[$version]:-}" ]]; then
    PENDING+=("$path")
  fi
done

echo "▶ migrations: ${#ALL_MIGS[@]} total, ${#APPLIED[@]} applied, ${#PENDING[@]} pending"

# ── 4. Apply pending migrations ───────────────────────────────────────────
if [[ ${#PENDING[@]} -eq 0 ]]; then
  echo "✓ schema already up-to-date"
else
  i=0
  total=${#PENDING[@]}
  for path in "${PENDING[@]}"; do
    i=$((i+1))
    fname="$(basename "$path")"
    version="${fname%%_*}"
    name="${fname#*_}"; name="${name%.sql}"

    printf "  [%3d/%3d] %s ... " "$i" "$total" "$fname"

    # Stream the SQL through stdin to psql so we don't have to copy files
    # into the container. Each migration runs inside a single transaction;
    # ON_ERROR_STOP=1 + set -e propagates any failure.
    if docker exec -i \
        -e PGPASSWORD="$POSTGRES_PASSWORD" \
        "$PG_CONTAINER" \
        psql -v ON_ERROR_STOP=1 -U "$PG_USER" -d postgres \
        -1 \
        -f - < "$path" > /tmp/_mig.log 2>&1; then
      # Record success (separate connection so it commits independently)
      psql_run -q -c "INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('${version}', '${name//\'/\'\'}') ON CONFLICT (version) DO NOTHING;"
      echo "ok"
    else
      echo "FAILED"
      echo "──── error ────"
      tail -40 /tmp/_mig.log >&2
      echo "──── end ────"
      exit 1
    fi
  done
  echo "✓ ${#PENDING[@]} migrations applied"
fi

# ── 5. Edge functions ─────────────────────────────────────────────────────
# IMPORTANT: --exclude=main keeps the local-only `main/` stub directory that
# edge-runtime's --main-service points at. The Dhivio codebase doesn't ship a
# `main` function; if we let rsync --delete remove it, edge-runtime crash-loops
# with "could not find an appropriate entrypoint".
if [[ -d "$FUNCS_DIR" ]]; then
  echo "▶ syncing edge functions → $ROOT/functions/  (preserving main/ stub)"
  mkdir -p "$ROOT/functions"
  rsync -a --delete --exclude='main' --exclude='main/**' "$FUNCS_DIR/" "$ROOT/functions/"

  # Re-seed main/ stub if missing (e.g. fresh VPS bootstrap). This ensures
  # edge-runtime always has a valid entrypoint regardless of repo state.
  if [[ ! -f "$ROOT/functions/main/index.ts" ]]; then
    mkdir -p "$ROOT/functions/main"
    cat > "$ROOT/functions/main/index.ts" <<'STUB'
// Auto-generated stub kept by run-migrations.sh. edge-runtime requires a
// `main` service entrypoint even when no Dhivio function is invoked here.
// All real functions live in sibling directories (mrp/, sync/, etc.) and
// are routed by Kong via /functions/v1/<name>.
Deno.serve(() => new Response(
  JSON.stringify({ status: "no-functions-deployed" }),
  { headers: { "content-type": "application/json" } },
));
STUB
    echo "▶ re-seeded main/ stub"
  fi

  # Sync database package source → /srv/dhivio/src/, mounted at /home/src in
  # edge-runtime so Deno functions can import shared types/clients. Mirrors
  # dev's ./packages/database/src:/home/src:ro mount. Staged by
  # .github/workflows/supabase.yml's `cp -r packages/database/src` step.
  if [[ -d "$SRC_DIR" ]]; then
    echo "▶ syncing database/src → $ROOT/src/"
    mkdir -p "$ROOT/src"
    rsync -a --delete "$SRC_DIR/" "$ROOT/src/"
  fi

  echo "▶ restarting dhivio-edge-runtime"
  docker restart dhivio-edge-runtime >/dev/null
fi

# ── 6. Promote staged folder ──────────────────────────────────────────────
mkdir -p "$ROOT/migrations-current"
rsync -a --delete "$STAGED/" "$ROOT/migrations-current/${RUN_ID}/"
ln -sfn "$ROOT/migrations-current/${RUN_ID}" "$ROOT/migrations-current/latest"

echo "✓ migrations applied (run $RUN_ID)"
