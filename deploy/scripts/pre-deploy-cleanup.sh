#!/usr/bin/env bash
###############################################################################
# pre-deploy-cleanup.sh
#
# One-shot cleanup that removes any **non-compose-managed** placeholder
# containers that share names with the real app containers (e.g. the
# `dhivio-erp-blue` / `dhivio-mes-blue` alpine+socat stubs created by
# bootstrap.sh).
#
# Safe to re-run; only removes containers that lack the
# `com.docker.compose.project=dhivio-apps` label.
#
# Run this ONCE after bootstrap, before the first `deploy-app.sh` invocation.
###############################################################################
set -euo pipefail

for name in dhivio-erp-blue dhivio-erp-green dhivio-mes-blue dhivio-mes-green; do
  if ! docker inspect "$name" >/dev/null 2>&1; then
    continue
  fi
  project="$(docker inspect "$name" --format '{{ index .Config.Labels "com.docker.compose.project" }}')"
  if [[ "$project" == "dhivio-apps" ]]; then
    echo "✓ $name is compose-managed (project=$project) — leaving alone"
  else
    echo "▶ removing stale placeholder $name (project='$project')"
    docker rm -f "$name" >/dev/null
  fi
done

echo "✓ cleanup complete"
