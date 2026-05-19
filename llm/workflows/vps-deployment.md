# VPS Direct Deployment Workflow

This workflow documents the **single-VPS Docker Compose deployment system** that replaces the legacy AWS ECR + SST/ECS pipeline. Builds run on GitHub Actions, push to Docker Hub, and roll out via blue/green on a single Ubuntu VPS.

## Architecture Overview

```
GitHub Actions:
  build-and-push.yml → Docker Hub: sachin4668/dhivio-{erp,mes}:<sha>
  supabase.yml       → rsync supabase/ → SSH run-migrations.sh
  deploy.yml         → SSH VPS deploy-app.sh erp <sha> → mes <sha>

VPS (160.250.205.220):
  Three compose projects on `dhivio_net` (external network):
    dhivio-infra : postgres, gotrue, postgrest, realtime, storage, meta,
                   edge-runtime, kong, redis, inngest, [studio]
    dhivio-apps  : erp-blue, erp-green, mes-blue, mes-green
    dhivio-proxy : nginx, certbot
```

Image registry: **Docker Hub** `sachin4668/dhivio-{erp,mes}` (single namespace — Docker Hub does not accept nested namespaces like `dhivio/sachin/erp`).

## Prerequisites

- VPS access (SSH on port **2222** — port 22 is GeoIP-blocked by the Indian hosting provider for non-IN IPs)
- Docker Hub credentials: `sachin4668` + PAT
- GitHub repo secrets configured: `VPS_HOST`, `VPS_USER`, `VPS_SSH_PORT=2222`, `VPS_SSH_KEY`, `DOCKERHUB_USERNAME`, `DOCKERHUB_TOKEN`

## Features Implemented

### Feature 1: Infra Stack ✅
Self-hosted Supabase + Redis + Inngest. All 10 services healthy.

**Key fixes during bring-up:**
- Studio: added `HOSTNAME=0.0.0.0` env var (Next.js was binding to container hostname; healthcheck on `localhost:3000` got ECONNREFUSED)
- Realtime: 16-byte hex AES-128 key (NOT 32-byte hex, which `:crypto.crypto_one_time/4` rejects)
- Inngest: bare-hex signing key (NOT `signkey-prod-<hex>` prefix)
- Edge-runtime: stub `main/index.ts` required to avoid "could not find an appropriate entrypoint" crash loop
- `init.sql.template`: made idempotent (use `IF NOT EXISTS` everywhere)
- Realtime schema split into `02-realtime-schema.sql` (runs as `supabase_admin`, not `postgres`)

### Feature 2: Build & Push ✅
GitHub Actions builds linux/amd64 images and pushes to Docker Hub.

**Key fixes:**
- Image path: `${DOCKERHUB_USERNAME}/dhivio-<app>` (was `dhivio/sachin/erp` — invalid)
- Dockerfiles upgraded from VPS `docker2` branch: `turbo prune` + `pnpm deploy --prod` + Alpine runtime (~200 MB final, down from ~1 GB)
- Health endpoint: standardized on `/health` (was `/healthcheck` in some places — apps actually expose `/health` via `_public+/health.tsx`)
- MES `EXPOSE` corrected from `3001` to `3000`
- Build workflow: QEMU removed (amd64-only), weekly cron disabled during bring-up
- Build args declared as `ARG ... ENV` BEFORE `pnpm run build` so Vite includes `VITE_*`/`SUPABASE_*` in client bundle

### Feature 3: Migrations ✅
psql-based migration applier (no Supabase CLI dependency).

**Critical bugs in the original scaffold:**

1. **`supabase/cli:latest` Docker image does not exist** — Supabase ships CLI as binary only. Original `run-migrations.sh` would fail with "pull access denied" immediately.
2. **`postgres` user cannot `CREATE POLICY ON storage.objects`** — that table is owned by `supabase_storage_admin`. Must use `supabase_admin` (the actual superuser; shares `POSTGRES_PASSWORD` by image convention).
3. **`pg_net` extension requires `shared_preload_libraries`** — was empty. Blocked migrations #253 (webhooks) and #317 (embeddings).
4. **No `supabase_migrations.schema_migrations` table** — no way to track applied migrations / be idempotent.
5. **`rsync --delete` on functions wipes the `main/` stub** — causes edge-runtime crash-loop after first migration run.

**Implementation (`deploy/scripts/run-migrations.sh`):**
- Connects via `psql` inside `dhivio-postgres` container as `supabase_admin`
- Creates `supabase_migrations.schema_migrations(version PK, statements text[], name, applied_at)` if absent
- Diffs `MIG_DIR/*.sql` filenames vs already-applied versions; applies only pending
- Each migration wrapped in single transaction via `psql -1 -v ON_ERROR_STOP=1`; logs last 40 lines on failure
- Functions rsync uses `--exclude=main --exclude=main/**`; re-seeds `main/index.ts` if missing
- Restarts `dhivio-edge-runtime` after sync
- Promotes staged → current with `latest` symlink

**Other:**
- `deploy/postgres/postgresql.conf`: added `shared_preload_libraries = 'pg_net, pg_cron, pgaudit'` + `cron.database_name = 'postgres'`
- `.github/workflows/supabase.yml`: dispatch-only during bring-up (cron + workflow_run chaining commented out)

**Verification (production VPS):** 692/692 migrations applied; 14 → 299 public tables; 0 → 313 public functions; 1 stub → 32 real edge functions; idempotent re-run shows `0 pending`.

### Feature 4: Rolling Blue/Green Deploy ✅
SSH-driven blue/green rollout with near-zero downtime.

**Critical bugs found and fixed during implementation:**

#### Bug 4.1: SSH GeoIP block on port 22
The Indian hosting provider (Yotta Network Services / "Own Cloud Networks") blocks inbound TCP/22 from non-Indian IPs at the upstream firewall (above the VPS OS — `iptables` is empty). GitHub Actions runners (US/Azure) get `connection timed out`. **Proved with 3 independent probes from US-LA, US-Dallas, DE-Nuremberg** (all timed out on :22; all connected on :2222, :443).

**Fix:** added port 2222 as a second sshd listener via systemd socket override:
```
/etc/systemd/system/ssh.socket.d/override.conf
[Socket]
ListenStream=
ListenStream=22
ListenStream=2222
```
GitHub secret `VPS_SSH_PORT` set to `2222`. Port 22 remains open for local Indian access (no change).

#### Bug 4.2: nginx `upstream { server <host>; }` fails when target is missing
The original nginx config used `upstream erp_upstream { server dhivio-erp-blue:3000; }` blocks. nginx resolves these at **config-load time**; if the container is missing (fresh bootstrap, rolling deploy, between blue→green cutover), `nginx -t` fails outright and reloads abort.

**Fix:** replaced `upstream` blocks with **lazy DNS resolution** using `set $target` + resolver:
```nginx
location / {
  set $target "dhivio-erp-blue:3000";
  resolver 127.0.0.11 valid=10s ipv6=off;
  proxy_pass http://$target;
  include snippets/proxy.conf;
}
```
nginx now does DNS lookup at request time — config always loads, returns 502 if container is down instead of refusing to start. Kong upstream is kept as a normal `upstream { }` block (always-on, no rolling deploys).

#### Bug 4.3: `switch-traffic.sh` sed delimiter conflict
Used `|` as both regex alternation AND sed `s|…|…|` delimiter, causing `sed: -e expression #1, char 32: unknown option to 's'`.

**Fix:** use `#` as sed delimiter (safe — nginx config never contains `#` in hostnames):
```bash
sed -i -E "s#dhivio-${APP}-(blue|green):3000#dhivio-${APP}-${COLOR}:3000#g" "$f"
```

#### Bug 4.4: nginx caches negative DNS responses across reloads
When `dhivio-erp-blue` didn't exist at first reload, nginx cached NXDOMAIN; subsequent `nginx -s reload` kept the stale negative cache. Configs were correct but probes returned 502.

**Fix:** `switch-traffic.sh` does a post-reload smoke probe; if it returns 5xx/000, falls back to a full `docker restart dhivio-nginx` which wipes the resolver cache. Idempotent — only restarts on actual failure.

#### Bug 4.5: Live `docker network disconnect`/`connect` for alias updates breaks DNS cache
Original `deploy-app.sh` set the `<app>-active` alias via:
```bash
docker network disconnect dhivio_net dhivio-erp-<old>
docker network disconnect dhivio_net dhivio-erp-<new>
docker network connect    dhivio_net dhivio-erp-<new> --alias erp-active
```
This **changes the container's IP** on dhivio_net. nginx and other clients hold the old IP in their resolver cache → 502/504 even after switch-traffic.sh completes.

**Fix (the correct architectural fix):** declare the alias **at container creation time** in compose:
```yaml
erp-blue:
  networks:
    default:
      aliases: [erp-active]
erp-green:
  networks:
    default:
      aliases: [erp-active]
```
Docker's embedded DNS returns whichever color is currently running; when the old color stops, its IP drops out of the alias automatically. **No live network juggling.** All `docker network disconnect/connect` calls removed from `deploy-app.sh`.

#### Bug 4.6: `docker compose up -d` doesn't re-attach detached containers
If a container was previously `docker network disconnect`'d from dhivio_net, a subsequent `compose up -d <service>` just does `docker start` (container already exists) — it does NOT re-attach the network. The container ends up running in network isolation; nginx can't reach it.

**Fix:** added `--force-recreate` flag to compose up + belt-and-braces explicit `docker network connect dhivio_net <container>` if the network membership check fails:
```bash
IMAGE_TAG="$TARGET" docker compose --env-file "$ENV_FILE" -f "$APPS_COMPOSE" \
  --profile "$IDLE" up -d --force-recreate "${APP}-${IDLE}"

if ! docker network inspect dhivio_net --format '{{range .Containers}}{{.Name}} {{end}}' \
     | grep -qw "dhivio-${APP}-${IDLE}"; then
  docker network connect dhivio_net "dhivio-${APP}-${IDLE}"
fi
```

#### Bug 4.7: Stale `.bak` files survive failed rollouts
When `switch-traffic.sh` validation fails, it restores from `*.conf.bak`. If a `.bak` from a previous broken rollout exists, the restore reintroduces the old broken config (e.g. dangling `upstream { server dhivio-erp-blue:3000; }`). Subsequent good rollouts then load the bad backup.

**Workaround during bring-up:** delete stale `.bak` files manually:
```bash
rm -f /srv/dhivio/nginx/conf.d/*.bak
```
**Long-term:** `switch-traffic.sh` should clean stale `.bak` files at start, or use a single rolling backup naming scheme.

#### Bug 4.8: Edge-runtime stub deleted by migrations rsync
`rsync --delete` on the functions directory wipes the local-only `main/` stub. Edge-runtime then crash-loops.

**Fix:** see Feature 3 — `run-migrations.sh` excludes `main/` and re-seeds it if missing.

#### Bug 4.9: Smoke test fails when DNS isn't ready
`deploy.yml` smoke test was `curl https://<host>/health` — fails until Feature 5 sets up DNS A records.

**Fix:** added VPS-direct fallback to smoke test:
1. Try public `https://<host>/health` first
2. Fall back to `https://<host>/health` with `--resolve <host>:443:<VPS_IP>` and `-k` (staging cert)
3. Fall back to `http://<host>/health` with `--resolve <host>:80:<VPS_IP>`

Test passes if ANY of the three return 2xx.

#### Bug 4.10: `previous_tag` state file not populated
`docker inspect --format='{{index .Config.Labels "org.opencontainers.image.version"}}'` returns empty because the Dockerfiles don't set OCI labels. Rollback falls through to "latest" tag, which is wrong.

**Status:** known issue, deferred. Fix: add `LABEL org.opencontainers.image.version=$TARGET` to Dockerfiles at build time OR write tag to state file BEFORE the rollover starts.

### Feature 5: DNS + Real Let's Encrypt Certificates ✅
DNS A records live; trusted Let's Encrypt cert in place; renewal automated.

**State on completion (verified 2026-05-19):**
- DNS A records: `erp.dhivio.com`, `mes.dhivio.com`, `api.dhivio.com` → `160.250.205.220`
- One multi-SAN cert at `/etc/letsencrypt/live/dhivio.com/` covering all 3 hosts (issuer: `C=US, O=Let's Encrypt, CN=E7`; serial `5d375e...`; valid 2026-05-19 → 2026-08-17)
- Browser-trusted (`SSL_VERIFY=0` for all three; no warning on navigation)
- Auto-renewal via the certbot sidecar in webroot mode (`certbot renew --dry-run` simulates renewal successfully)

**Architectural decision: switched from per-host certs to a single multi-SAN cert.** Discussed below as Bug 5.10.

**Critical bugs found and fixed during Feature 5 bring-up:**

#### Bug 5.9: `issue-certs.sh` leaves nginx down on failure
The original script does `docker compose stop nginx` → `rm placeholder` → `certbot certonly`. With `set -e`, any failure between stop and the next `compose up` (e.g. LE rate limit, network blip, certbot crash) leaves nginx stopped, the placeholder deleted, and the cert file referenced by nginx.conf simply missing. All three sites go offline until a human notices.

**Fix:** added an `EXIT` trap to `issue-certs.sh` that:
1. Watches a `NGINX_STOPPED` flag set right after the `compose stop nginx` call
2. On non-zero exit with the flag set: re-seeds the multi-SAN placeholder cert (and legacy per-host placeholders for back-compat), then `docker compose up -d nginx`
3. Prints a clear "fix the underlying error then re-run" message

The trap is disarmed (`NGINX_STOPPED=0`) on the success path so it doesn't interfere with normal shutdown.

#### Bug 5.10: LE "duplicate certificate" rate-limit hit during bring-up
Prior bring-up attempts had issued 5 separate `erp.dhivio.com` certs in 7 days (logged in the LE account, files never persisted to disk). LE's [duplicate-certificate limit](https://letsencrypt.org/docs/rate-limits/#new-certificates-per-exact-set-of-identifiers) is 5 identical identifier sets per 168h — we were maxed out. First `issue-certs.sh` run failed with `too many certificates (5) already issued for this exact set of identifiers`.

**Architectural fix (not a workaround):** switched from three per-host certs to **one multi-SAN cert** covering `erp + mes + api`:
- The SAN cert is a *different* identifier set, so it bypasses the duplicate-cert limit immediately
- The overall "certificates per registered domain" limit (50/week for `dhivio.com`) still has plenty of headroom
- Simpler ops: one cert, one renewal job, one private-key rotation
- No security regression — all 3 hostnames live on the same VPS and the same root surface, so per-host key isolation was buying nothing

Changes:
- `issue-certs.sh`: now issues `certbot certonly --cert-name dhivio.com -d erp -d mes -d api`. Idempotency check is by `--cert-name` + SAN-list verification (re-issues if SAN list drifts).
- `seed_placeholder()` helper: generates an OpenSSL SAN config on the host, bind-mounts it into the alpine container. Earlier inline heredoc approach was breaking under SSH → bash -c → docker sh -c multi-layer quoting (`invalid field name distinguished_name` errors — root cause: missing `[req_dn]` section).
- `deploy/nginx/conf.d/{erp,mes,api}.dhivio.com.conf`: all three vhosts now reference `/etc/letsencrypt/live/dhivio.com/{fullchain,privkey}.pem` instead of per-host paths.

**Validation procedure before re-running** (so we don't burn another rate-limit slot):
1. `bash -n` parse-check on local and VPS copies of `issue-certs.sh`
2. Counted-markers check: every key construct (`trap on_exit EXIT`, `seed_placeholder() {`, `on_exit() {`, `CERT_NAME=`, `SANS=`) appears exactly once
3. **Full dry-run via `certbot certonly --dry-run`** against LE staging — proves DNS resolution, port :80 binding, HTTP-01 challenge, and certbot args all work end-to-end at zero cost (staging has effectively unlimited rate limits)
4. Only after dry-run prints `The dry run was successful.` do we run the real prod command

#### Bug 5.11: Auto-renewal silently broken (`authenticator = standalone`)
`certbot --standalone` writes `authenticator = standalone` into `/etc/letsencrypt/renewal/<lineage>.conf`. The certbot sidecar in `compose.proxy.yml` runs `certbot renew --webroot -w /var/www/certbot` every 12h — but `certbot renew` honours the per-lineage authenticator setting, so a standalone-issued lineage gets skipped by webroot renewal and the cert silently expires after 90 days.

**Fix:** `issue-certs.sh` now patches the renewal config immediately after issuance:
```bash
sed -i 's|^authenticator = standalone|authenticator = webroot|' "$cfg"
# + append webroot_path + [[webroot_map]] section with each SAN
```
Verified with `certbot renew --webroot -w /var/www/certbot --dry-run` → `Congratulations, all simulated renewals succeeded.`

#### Bug 5.12: `edit` tool corrupted the script during refactor
When I refactored `seed_placeholder()` via the file-edit tool, the `old_string` apparently didn't match exactly and the new content was appended rather than replacing. Result: 416-line file with two copies of the script body, second copy starting with a stray `\n'` causing a bash syntax error at line 269 of the corrupted file.

**Symptom:** script would crash at parse time (`bash -n` failed) and never execute — so no rate-limit was burned, but the script was unusable.

**Fix:** rewrote `issue-certs.sh` cleanly from scratch (269 lines, single copy of every function).

**Lesson:** always `bash -n` script files after every `edit` tool invocation, and verify marker counts (`grep -c "^trap on_exit EXIT"` etc. should all be 1).

## Steps to Deploy

### Bootstrap (one-time, on VPS)

```bash
git clone https://github.com/saw1998/dhivio.git
cd dhivio
sudo bash deploy/scripts/bootstrap.sh
# Fill in [USER] block when $EDITOR opens

sudo bash deploy/scripts/issue-certs.sh   # after DNS resolves (Feature 5)

cd /srv/dhivio
docker compose --env-file .env -f compose.infra.yml up -d
docker compose --env-file .env -f compose.proxy.yml up -d
```

### Normal release cycle (via GitHub Actions)

1. **Build & Push** workflow dispatch → builds + pushes both images to Docker Hub. Tag = commit SHA.
2. **Migrate Supabase** workflow dispatch → rsync `packages/database/supabase/` to VPS, SSH-run `run-migrations.sh`, restart edge-runtime.
3. **Deploy** workflow dispatch (apps: erp/mes/both, optional tag override) → SSH-run `deploy-app.sh <app> <tag>` in matrix.

### Manual deploy on VPS

```bash
bash /srv/dhivio/scripts/deploy-app.sh erp <sha>
bash /srv/dhivio/scripts/deploy-app.sh mes <sha>
```

### Rollback

```bash
bash /srv/dhivio/scripts/deploy-app.sh erp rollback
```
Reverts to the previous color (image still cached locally — ~5 s).

## Files Modified Summary (Feature 1–4)

### Local repo
```
.github/workflows/build-and-push.yml   (new — Docker Hub push)
.github/workflows/deploy.yml           (new — blue/green dispatch + smoke test with VPS-direct fallback)
.github/workflows/supabase.yml         (dispatch-only during bring-up)
apps/erp/Dockerfile                    (production-grade — turbo prune + pnpm deploy + Alpine)
apps/mes/Dockerfile                    (same treatment as ERP)
deploy/.env.example                    (added DOCKERHUB_USERNAME)
deploy/README.md                       (image-path doc + known-issues section)
deploy/compose.infra.yml               (Studio HOSTNAME=0.0.0.0 + healthcheck override)
deploy/compose.apps.yml                (DOCKERHUB_USERNAME var + /health endpoint + start_period 30s + network alias erp-active/mes-active)
deploy/compose.proxy.yml               (unchanged structure; verified external dhivio_net)
deploy/edge-runtime/main/index.ts      (new — stub for empty function dir)
deploy/postgres/init.sql.template      (idempotency: IF NOT EXISTS everywhere)
deploy/postgres/02-realtime-schema.sql (new — split realtime schema run as supabase_admin)
deploy/postgres/postgresql.conf        (shared_preload_libraries = pg_net,pg_cron,pgaudit)
deploy/scripts/bootstrap.sh            (key formats + DOCKERHUB_USERNAME)
deploy/scripts/deploy-app.sh           (reads DOCKERHUB_USERNAME; --force-recreate; network re-attach guard; no live alias juggling)
deploy/scripts/pre-deploy-cleanup.sh   (new — removes stale alpine placeholder containers)
deploy/scripts/run-migrations.sh       (rewritten — psql-based, no Supabase CLI; preserves main/ stub)
deploy/scripts/switch-traffic.sh       (sed delimiter `#`; auto-restart nginx fallback on stale DNS)
deploy/nginx/conf.d/upstreams.conf     (kong_upstream only; app upstreams moved to lazy-DNS)
deploy/nginx/conf.d/erp.dhivio.com.conf (set $target + resolver + HTTP-80 /health block)
deploy/nginx/conf.d/mes.dhivio.com.conf (same pattern as erp)
deploy/nginx/conf.d/api.dhivio.com.conf (set $target for /callback/, kong_upstream for /)
```

### VPS-side state
```
/etc/systemd/system/ssh.socket.d/override.conf  (adds port 2222 listener)
/srv/dhivio/functions/main/index.ts             (edge-runtime stub, re-seeded after each migration run)
/srv/dhivio/state/<app>.active                  (current color: blue|green)
/srv/dhivio/state/<app>.current_tag             (currently-deployed SHA)
/srv/dhivio/state/<app>.previous_tag            (for rollback — currently broken, see Bug 4.10)
/srv/dhivio/nginx/conf.d/*.conf.bak             (single rolling backup per touched file)
```

### GitHub secrets
```
VPS_HOST            = 160.250.205.220
VPS_USER            = root
VPS_SSH_PORT        = 2222            (NOT 22 — see Bug 4.1)
VPS_SSH_KEY         = ed25519 from ~/.ssh/dhivio_gh_actions
DOCKERHUB_USERNAME  = sachin4668
DOCKERHUB_TOKEN     = (PAT with Read/Write/Delete)
```

## Common Issues / Debugging Commands

### "nginx returns 502, container is healthy"
```bash
# Check network membership — is the target container even on dhivio_net?
docker network inspect dhivio_net --format '{{range .Containers}}{{.Name}}{{println}}{{end}}'

# Check nginx error log via daemon (NOT via docker exec, which can hang)
docker logs --tail 30 dhivio-nginx 2>&1 | tail -25

# If DNS cache is stale, restart nginx
docker restart dhivio-nginx
```

### "container shows healthy but nginx 504s"
```bash
# Probe in-network from a sidecar
docker run --rm --network dhivio_net curlimages/curl:latest \
  -s -o /dev/null -w "HTTP=%{http_code}\n" --max-time 5 \
  http://dhivio-erp-green:3000/health

# Force re-attach to network
docker network connect dhivio_net dhivio-erp-green
```

### "compose up didn't put container on dhivio_net"
Always use `--force-recreate` for the apps stack:
```bash
docker compose --env-file .env -f compose.apps.yml \
  --profile green up -d --force-recreate erp-green
```

### "migrations failed mid-way"
Re-run is idempotent (only applies pending migrations):
```bash
nohup bash /srv/dhivio/scripts/run-migrations.sh \
  /srv/dhivio/migrations-staging/manual-test \
  > /srv/dhivio/logs/run-migrations.log 2>&1 &
```
Inspect what's applied:
```bash
docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" dhivio-postgres \
  psql -U supabase_admin -d postgres -tAc \
  "select count(*), max(applied_at) from supabase_migrations.schema_migrations;"
```

### "edge-runtime crash-loops with 'could not find an appropriate entrypoint'"
The `main/` stub got wiped. Re-seed:
```bash
mkdir -p /srv/dhivio/functions/main
# Copy from local repo:
scp -P 2222 deploy/edge-runtime/main/index.ts \
  root@160.250.205.220:/srv/dhivio/functions/main/index.ts
docker restart dhivio-edge-runtime
```

### "SSH from GitHub Actions times out"
Port 22 is GeoIP-blocked from non-Indian IPs. Confirm `VPS_SSH_PORT=2222` in GitHub secrets. Test from non-Indian IP:
```bash
# From any non-Indian host:
curl -s -m 10 "https://check-host.net/check-tcp?host=160.250.205.220:2222&max_nodes=3"
```

## Known Open Issues / Backlog

| # | Issue | Severity | Notes |
|---|---|---|---|
| 4.10 | `previous_tag` state file empty | Medium | Breaks rollback; needs OCI label in Dockerfiles |
| ~~5.1~~ | ~~DNS A records not set~~ | ✅ Done | All three hostnames A → `160.250.205.220` |
| ~~5.2~~ | ~~Real LE certs not issued~~ | ✅ Done | Multi-SAN cert at `/etc/letsencrypt/live/dhivio.com/` (expires 2026-08-17, auto-renews via webroot) |
| 5.3 | Kong `/functions/v1/main` returns HTTP 000 | Medium | Edge-runtime serves correctly on `:9000/main`; Kong routing needs check |
| ~~5.4~~ | ~~MES `tailwindcss` runtime import~~ | Medium | Fix committed (`apps/mes/package.json` moves `tailwindcss` to deps). **Image needs rebuild + redeploy** before `mes.dhivio.com` will return 200 — currently 502 because the deployed image still has the old broken bundle. |
| 5.5 | Stale `.bak` files in nginx/conf.d | Low | `switch-traffic.sh` should clean at start |
| 5.6 | `.github/workflows/{inngest,functions}.yml` (AWS-era) | Low | Delete after first successful prod deploy |
| 5.7 | `sst.config.ts`, `ci/` (AWS-era) | Low | Delete after first successful prod deploy |
| 5.8 | Cron triggers disabled on all 3 workflows | Low | Re-enable Saturday 22:00 IST now that Feature 5 is done |
| 5.13 | `ssl_stapling` warnings in nginx logs | Trivial | LE deprecated OCSP responder URLs in 2025 cert profile. Either remove `ssl_stapling` from `snippets/ssl.conf` or accept the warnings (no functional impact). |

## See Also
- `deploy/README.md` — operational quickstart
- `.github/workflows/{build-and-push,supabase,deploy}.yml` — pipeline definitions
- `deploy/scripts/*.sh` — VPS-side automation
