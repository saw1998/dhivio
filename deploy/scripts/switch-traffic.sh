#!/usr/bin/env bash
# switch-traffic.sh <app> <color>
#   app   = erp | mes
#   color = blue | green
#
# Rewrites the `upstream <app>_upstream { ... }` block in
# /srv/dhivio/nginx/conf.d/upstreams.conf, validates the new config inside
# the nginx container, then reloads. Keeps a single .bak so rollback is
# one command.
set -euo pipefail

APP="${1:?app required (erp|mes)}"
COLOR="${2:?color required (blue|green)}"
[[ "$APP"   =~ ^(erp|mes)$ ]]   || { echo "bad app: $APP"   >&2; exit 2; }
[[ "$COLOR" =~ ^(blue|green)$ ]]|| { echo "bad color: $COLOR" >&2; exit 2; }

ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
CONF="$ROOT/nginx/conf.d/upstreams.conf"
BACKUP="$CONF.bak"

[[ -f "$CONF" ]] || { echo "missing $CONF" >&2; exit 1; }

cp "$CONF" "$BACKUP"

# Replace the single `server dhivio-<app>-<anycolor>:3000` line inside the
# matching upstream block.
python3 - "$CONF" "$APP" "$COLOR" <<'PY'
import re, sys, pathlib
path, app, color = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(path).read_text()
pattern = re.compile(
    rf'(upstream\s+{app}_upstream\s*{{[^}}]*?server\s+)dhivio-{app}-(blue|green)(:3000)',
    re.S,
)
new, n = pattern.subn(rf'\1dhivio-{app}-{color}\3', text)
if n != 1:
    sys.exit(f"failed to rewrite {app} upstream (found {n} matches)")
pathlib.Path(path).write_text(new)
PY

# Validate and reload nginx atomically. If validation fails, restore backup.
if ! docker exec dhivio-nginx nginx -t 2>&1; then
  echo "✗ nginx -t failed; restoring backup" >&2
  cp "$BACKUP" "$CONF"
  docker exec dhivio-nginx nginx -t
  exit 1
fi
docker exec dhivio-nginx nginx -s reload
echo "✓ switched $APP → $COLOR"
