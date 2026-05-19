#!/usr/bin/env bash
# switch-traffic.sh <app> <color>
#   app   = erp | mes
#   color = blue | green
#
# Rewrites all `set $target "dhivio-<app>-<anycolor>:3000";` lines across
# /srv/dhivio/nginx/conf.d/*.conf, validates the new config inside the nginx
# container, then reloads. Keeps a single .bak per touched file so rollback
# is one command.
#
# Why a `set` directive instead of `upstream { server ... }`? Because nginx
# resolves upstream entries at config-LOAD time; if the target container is
# missing (e.g. fresh bootstrap, between blue→green cutover), `nginx -t`
# fails and reloads abort. The `set $target` + resolver pattern resolves
# DNS at REQUEST time and returns 502 if the container is down — but the
# config always loads.
#
# NOTE: api.dhivio.com.conf also has a `set $target` for /callback/ that
# routes to ERP. When app=erp, both erp.dhivio.com.conf AND api.dhivio.com.conf
# get rewritten (any `dhivio-erp-*:3000` matches).
set -euo pipefail

APP="${1:?app required (erp|mes)}"
COLOR="${2:?color required (blue|green)}"
[[ "$APP"   =~ ^(erp|mes)$ ]]   || { echo "bad app: $APP"   >&2; exit 2; }
[[ "$COLOR" =~ ^(blue|green)$ ]]|| { echo "bad color: $COLOR" >&2; exit 2; }

ROOT="${DHIVIO_ROOT:-/srv/dhivio}"
CONF_DIR="$ROOT/nginx/conf.d"

[[ -d "$CONF_DIR" ]] || { echo "missing $CONF_DIR" >&2; exit 1; }

# Clean up stale .bak files from previous (possibly failed) rollouts. If we
# leave them around, a later failed rollout's restore step might revive an
# obsolete config (e.g. the original `upstream { server dhivio-erp-blue }`
# block from before Feature 4's lazy-DNS rewrite).
rm -f "$CONF_DIR"/*.conf.bak

# Find all conf files that reference this app's containers (typically
# erp.dhivio.com.conf and api.dhivio.com.conf for app=erp).
mapfile -t TARGETS < <(grep -lE "dhivio-${APP}-(blue|green):3000" "$CONF_DIR"/*.conf 2>/dev/null || true)
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "✗ no nginx conf references dhivio-${APP}-*:3000 — nothing to switch" >&2
  exit 1
fi

# Back up + rewrite each touched file.
# IMPORTANT: sed uses `|` as the delimiter, so the `|` inside the regex
# alternation (blue|green) would terminate the s/// expression early. Use
# `#` as the delimiter instead (safe because nginx config never contains `#`
# in container hostnames).
for f in "${TARGETS[@]}"; do
  cp "$f" "$f.bak"
  sed -i -E "s#dhivio-${APP}-(blue|green):3000#dhivio-${APP}-${COLOR}:3000#g" "$f"
  echo "  ✎ rewrote $f"
done

# Validate; on failure restore all backups + abort.
if ! docker exec dhivio-nginx nginx -t 2>&1; then
  echo "✗ nginx -t failed; restoring backups" >&2
  for f in "${TARGETS[@]}"; do
    cp "$f.bak" "$f"
  done
  docker exec dhivio-nginx nginx -t
  exit 1
fi

docker exec dhivio-nginx nginx -s reload

# Verify the reload actually serves the new upstream. nginx caches negative
# DNS responses (NXDOMAIN for `dhivio-${APP}-blue` lingers even after a SIGHUP
# reload), so we do a quick smoke probe through nginx itself. If it 502s,
# fall back to a full container restart which wipes the resolver cache.
sleep 1
HOST="${APP}.dhivio.com"
PROBE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
  --resolve "${HOST}:80:127.0.0.1" "http://${HOST}/health" || echo "000")
if [[ "$PROBE" =~ ^(5|0) ]]; then
  echo "⚠ nginx reload returned $PROBE — likely stale DNS cache. Restarting container…"
  docker restart dhivio-nginx >/dev/null
  # wait for nginx to start serving again (up to 20s)
  for i in $(seq 1 10); do
    sleep 2
    PROBE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
      --resolve "${HOST}:80:127.0.0.1" "http://${HOST}/health" || echo "000")
    [[ "$PROBE" =~ ^2 ]] && break
  done
  if [[ ! "$PROBE" =~ ^2 ]]; then
    echo "✗ nginx still failing post-restart (HTTP $PROBE)" >&2
    exit 1
  fi
fi

echo "✓ switched $APP → $COLOR (rewrote ${#TARGETS[@]} file(s), HTTP $PROBE)"
