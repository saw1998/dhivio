# Fresh-VPS Bootstrap Runbook (Dhivio prod)

Battle-tested step-by-step procedure for bringing up the Dhivio production
stack on a brand-new Linux VPS. Distilled from Features 1-5 of
`llm/workflows/vps-deployment.md`; every step records the gotchas that
took us hours to find the first time.

> **Read order:** This file is the operational checklist. For the *why*
> behind each decision read `llm/workflows/vps-deployment.md`; for the
> *what* of each script read `deploy/README.md`.

---

## 0. Preconditions

### Hardware / OS

| | Minimum | Recommended |
|---|---|---|
| RAM | 4 GB | 8 GB |
| Disk | 40 GB SSD | 80 GB SSD |
| vCPU | 2 | 4 |
| OS | Ubuntu 22.04 LTS or Debian 12 (any systemd distro with apt) | Ubuntu 24.04 LTS |
| Arch | linux/amd64 only (CI builds amd64) | — |
| Outbound 443 | required (Docker Hub, GitHub, LE, etc.) | — |
| Inbound 80 + 443 | required (LE HTTP-01 + HTTPS) | — |
| Inbound 2222 | strongly recommended (SSH; see §1.4) | — |

### Accounts / external state you need first

- A non-root sudo user on the VPS (we use `root` directly here — adjust if your
  org disallows that).
- **DNS provider access** for `dhivio.com` (Cloudflare, Route53, etc.) to point
  A records at the VPS IP. Records get checked in §3.
- **Docker Hub account** with a *paid* plan, OR pre-created repos
  `<username>/dhivio-erp` and `<username>/dhivio-mes` (free tier does not
  auto-create on first push).
- **GitHub repo** access with admin rights to set Actions secrets.
- **(Optional) Cloudflare Turnstile** site key — public bot-protection.
  Without it the login page renders without the widget (`process.env.
  CLOUDFLARE_TURNSTILE_SITE_KEY` evaluates falsy → login.tsx skips the
  `<Turnstile />` render).
- **(Optional) SMTP creds** (Resend by default), Razorpay/Stripe, PostHog,
  Novu, Slack — leave blank to defer; the app boots without them.

### Local workstation

- `ssh`, `git`, `gh` (GitHub CLI), `dig`, `curl`, `openssl`.
- This repo cloned and the deploy branch checked out
  (`direct-deployment` as of 2026-05).

---

## 1. Host hardening (one-time, run as root on VPS)

### 1.1  Fully patch the host

```bash
apt update && apt upgrade -y && apt autoremove -y
timedatectl set-timezone UTC   # avoid log/timestamp confusion
```

### 1.2  Install base tooling

```bash
apt install -y curl ca-certificates gnupg lsb-release ufw fail2ban \
               unattended-upgrades htop iotop ncdu jq rsync git \
               openssl uuid-runtime
```

### 1.3  Install Docker Engine + Compose plugin (NOT docker.io from apt)

```bash
# Add Docker's official GPG key
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo "$ID")/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Add repo
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/$(. /etc/os-release; echo "$ID") \
  $(lsb_release -cs) stable" \
  | tee /etc/apt/sources.list.d/docker.list >/dev/null

apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

systemctl enable --now docker
docker --version            # expect: Docker version 27.x or newer
docker compose version      # expect: Docker Compose version v2.27 or newer
```

> **Why not the distro `docker.io`?** Apt's Docker can be 2+ years stale and
> ships an old compose v1 (`docker-compose` not `docker compose`). Several of
> our compose features (profiles, named-volume-from, etc.) require ≥ v2.20.

### 1.4  SSH on a non-standard port (CRITICAL for India-hosted VPS)

Many providers (e.g. ezerhost) **GeoIP-block inbound port 22 from non-Indian
IPs**. CI runners (GitHub-hosted in Azure US/Europe) will time out. Move SSH
to port 2222 BEFORE you do anything else, then add your CI key.

```bash
sed -i 's/^#Port 22/Port 2222/; s/^Port 22$/Port 2222/' /etc/ssh/sshd_config
# Optional hardening
sed -i 's/^#*PermitRootLogin .*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication .*/PasswordAuthentication no/'   /etc/ssh/sshd_config

# Keep port 22 open until you've verified port 2222 works (else lockout)
# After verification, remove the 'Port 22' line.

systemctl reload ssh   # or `systemctl reload sshd` depending on distro
ss -tlnp | grep -E ':22\b|:2222\b'   # confirm sshd is listening on 2222
```

Then on your laptop:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/dhivio_gh_actions -C "github-actions@dhivio" -N ''
sshpass -p '<root-password>' ssh-copy-id -p 2222 -i ~/.ssh/dhivio_gh_actions.pub root@<VPS_IP>
ssh -p 2222 -i ~/.ssh/dhivio_gh_actions root@<VPS_IP> 'echo OK'
```

The private key (`~/.ssh/dhivio_gh_actions`) is what you'll paste into
GitHub Actions secret `VPS_SSH_KEY` in §5.

### 1.5  Firewall (ufw)

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow 2222/tcp comment 'SSH (custom port)'
ufw allow 80/tcp   comment 'HTTP (Let''s Encrypt + redirect)'
ufw allow 443/tcp  comment 'HTTPS'
ufw --force enable
ufw status numbered
```

**Do NOT open the database / Redis / Kong ports publicly.** They are reached
only via docker internal networking + nginx upstream rules.

### 1.6  Auto-updates (security patches only)

```bash
dpkg-reconfigure -plow unattended-upgrades   # answer "Yes"
```

### 1.7  Swap (mandatory on ≤ 4 GB VPS)

The bootstrap script will do this for you (`step 8`), but if you want to
front-load it:

```bash
fallocate -l 2G /swapfile
chmod 600 /swapfile
mkswap /swapfile
swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
free -h   # confirm Swap row shows 2.0Gi
```

Without swap, postgres + edge-runtime + kong + 2× node apps will OOM-kill
each other under load.

---

## 2. Bootstrap the project layout

### 2.1  Clone the repo into root's homedir

```bash
cd /root
git clone https://github.com/<org>/dhivio.git
cd dhivio
git checkout direct-deployment      # or `main` if direct-deployment is merged
```

### 2.2  Run the one-shot bootstrap

```bash
sudo bash deploy/scripts/bootstrap.sh
```

What `bootstrap.sh` does (in order; everything is idempotent — safe to re-run):

1. Creates `/srv/dhivio/{state,backups,migrations-staging,functions}`
2. Generates `POSTGRES_PASSWORD`, `SESSION_SECRET`, `REALTIME_*` keys,
   `INNGEST_*` keys with `openssl rand`
3. Mints `SUPABASE_JWT_SECRET` + matching `ANON` + `SERVICE_ROLE` HS256 JWTs
   (10-year expiry) using the same algorithm as `packages/dev/src/lib/jwt.ts`
4. Templates `deploy/postgres/init.sql.template → deploy/postgres/init.sql`
   substituting the generated `$POSTGRES_PASSWORD`
5. rsyncs every needed asset to `/srv/dhivio/` (compose files, scripts,
   nginx configs, kong config, edge-runtime stub, etc.)
6. Writes `/srv/dhivio/.env` from `deploy/.env.example` with the auto-minted
   values pre-filled
7. Opens `$EDITOR` so you can fill in the `[USER]` block (OAuth, SMTP,
   Razorpay, Turnstile, etc.)
8. Creates the external `dhivio_net` Docker bridge network
9. Provisions a 2 GB swapfile if none exists

> **`--rotate-jwt`** re-runs steps 2-7 but only refreshes the JWT-related
> secrets. Use it during incident response or scheduled key rotation.
> Requires rebuilding the app images afterwards because the `ANON` key is
> baked into the client bundle at build time.

### 2.3  Fill in the `[USER]` block in `/srv/dhivio/.env`

The editor opens automatically. At minimum you need:

| Key | Where it comes from | Required? |
|---|---|---|
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID` / `_SECRET` | Google Cloud Console → OAuth 2.0 credentials | Required if `AUTH_PROVIDERS` includes `google` |
| `SUPABASE_AUTH_EXTERNAL_AZURE_*` | Azure AD app registration | Optional |
| `RESEND_API_KEY` + `RESEND_DOMAIN` | resend.com dashboard | Required for any email (signup, password reset) |
| `CLOUDFLARE_TURNSTILE_SITE_KEY` + `_SECRET_KEY` | dash.cloudflare.com → Turnstile | Optional (defer to use test key `1x00000000000000000000AA`) |
| `RAZORPAY_KEY_ID` + `_SECRET` | razorpay.com dashboard | Required for Cloud edition; placeholder OK otherwise |
| `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` | dashboard.stripe.com | Required for Cloud edition outside India |
| `NOVU_APPLICATION_ID` + `_SECRET_KEY` | novu.co | Optional |
| `POSTHOG_PROJECT_PUBLIC_KEY` + `POSTHOG_API_HOST` | posthog.com | Optional |
| `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_PLACES_API_KEY` | respective providers | Optional |
| `STRIPE_WEBHOOK_SECRET`, `GTM_EVENTS_API_SECRET_KEY` | provider dashboards | Optional |

> **DO NOT** edit the `[AUTO]` block — those values must match what got baked
> into postgres' init.sql at step 4. Re-run `bootstrap.sh --rotate-jwt` if you
> need to refresh them.

---

## 3. DNS

Set A records at your DNS provider:

```
erp.dhivio.com    A    <VPS_IP>    300 TTL
mes.dhivio.com    A    <VPS_IP>    300 TTL
api.dhivio.com    A    <VPS_IP>    300 TTL
```

Verify from your laptop (must resolve BEFORE you run `issue-certs.sh`):

```bash
for h in erp.dhivio.com mes.dhivio.com api.dhivio.com; do
  echo "$h -> $(dig +short $h)"
done
# expect all three to print <VPS_IP>
```

> **Why no `dhivio.com` apex record?** The apex is reserved for the marketing
> site (currently elsewhere). All app traffic uses subdomains.

---

## 4. Bring up the infra stack (postgres + supabase + redis + inngest)

```bash
cd /srv/dhivio
docker compose --env-file .env -f compose.infra.yml up -d
```

This boots **10 containers**:

| Container | Purpose | Health gate |
|---|---|---|
| `dhivio-postgres` | Postgres 15 with Supabase extensions | pg_isready |
| `dhivio-realtime` | Supabase Realtime (websockets, Phoenix) | HTTP /api/health |
| `dhivio-rest` | PostgREST (REST API on Postgres) | HTTP /ready |
| `dhivio-auth` | GoTrue (Supabase Auth) | HTTP /health |
| `dhivio-storage` | Supabase Storage | HTTP /status |
| `dhivio-meta` | postgres-meta | HTTP /metadata |
| `dhivio-edge-runtime` | Deno functions runtime | HTTP /main |
| `dhivio-kong` | Kong gateway (Supabase API → microservices) | HTTP /status |
| `dhivio-redis` | Redis 7 | redis-cli ping |
| `dhivio-inngest` | Inngest dev server (event queue) | HTTP /health |

Wait for all to be healthy:

```bash
watch -n 2 'docker ps --filter "name=dhivio-" --format "{{.Names}}: {{.Status}}"'
# expect all 10 to read "Up X minutes (healthy)" within 60-90 seconds
```

> **If `dhivio-realtime` crash-loops** with an `AES_128_ECB` error, the
> `REALTIME_DB_ENC_KEY` is wrong length (must be **16 raw bytes**, not 32 hex
> chars). The bootstrap script handles this; if you hand-edited the .env,
> re-run `bootstrap.sh --rotate-jwt`.

> **If `dhivio-inngest` crash-loops** with `invalid signing key`, your
> `INNGEST_SIGNING_KEY` has the `signkey-prod-` prefix it shouldn't have.
> `bootstrap.sh` strips it; hand-edited values may have re-added it.

> **If `dhivio-studio` is in this list at all**, you are on an older
> compose.infra.yml. We removed Studio (port conflict + healthcheck issues
> on Next 16 binding to `container hostname` instead of `0.0.0.0`).

---

## 5. Configure GitHub Actions secrets

In the GitHub repo: **Settings → Secrets and variables → Actions → New repository secret**

### Required for build-and-push.yml

| Secret | Value |
|---|---|
| `DOCKERHUB_USERNAME` | Docker Hub username (e.g. `sachin4668`) |
| `DOCKERHUB_TOKEN` | Docker Hub PAT with `Read, Write, Delete` scopes |
| `BUILD_SUPABASE_URL` | `https://api.dhivio.com` |
| `BUILD_SUPABASE_ANON_KEY` | value from `/srv/dhivio/.env` SUPABASE_ANON_KEY |
| `BUILD_VITE_CLOUDFLARE_TURNSTILE_SITE_KEY` | Cloudflare site key (or test `1x000...AA`) |
| `BUILD_VITE_RAZORPAY_KEY_ID` | Razorpay key id (or empty) |
| `BUILD_VITE_POSTHOG_KEY` | PostHog public key (or empty) |
| `BUILD_VITE_POSTHOG_HOST` | `https://us.posthog.com` (or empty) |

### Required for deploy.yml + supabase.yml

| Secret | Value |
|---|---|
| `VPS_HOST` | VPS IP (e.g. `160.250.205.220`) |
| `VPS_USER` | `root` |
| `VPS_SSH_PORT` | `2222` (matches §1.4) |
| `VPS_SSH_KEY` | contents of `~/.ssh/dhivio_gh_actions` (the **private** key, full PEM) |
| `SUPABASE_DB_PASSWORD` | value of `POSTGRES_PASSWORD` from `/srv/dhivio/.env` |

> **Common pitfall:** `VITE_*` build args appear in the *client* JS bundle.
> They are public by nature. Server-only secrets (DB password, service-role
> key) must NEVER be set as `VITE_*` build args — only as runtime env vars
> in `/srv/dhivio/.env` (which `compose.apps.yml` exposes via its
> `x-app-env` block).

---

## 6. Issue Let's Encrypt certs (multi-SAN)

`issue-certs.sh` requests ONE certificate covering all three hostnames.
This intentionally bypasses LE's "duplicate certificate" rate-limit
(5 identical identifier sets per 168h) — a SAN cert is a *different*
identifier set than its components, so re-issuance during incident
response doesn't burn slots.

### 6.1  Pre-flight (recommended)

```bash
# DNS check
for h in erp.dhivio.com mes.dhivio.com api.dhivio.com; do
  echo "$h -> $(dig +short $h)"
done   # all must equal VPS_IP

# Port :80 must be reachable from outside
curl -sI -m 8 -o /dev/null -w "HTTP=%{http_code}\n" \
  http://erp.dhivio.com/.well-known/acme-challenge/probe-preflight
# expect HTTP=404 (file doesn't exist, but connection completed)

# Optional: dry-run against LE STAGING (no rate limits, no real cert)
# — strongly recommended on a brand-new VPS or after .env changes.
docker compose --env-file /srv/dhivio/.env -f /srv/dhivio/compose.proxy.yml stop nginx
docker run --rm -p 80:80 \
  -v dhivio-proxy_certbot-etc:/etc/letsencrypt \
  -v dhivio-proxy_certbot-www:/var/www/certbot \
  certbot/certbot certonly --dry-run --standalone \
    --preferred-challenges http --non-interactive --agree-tos \
    --cert-name dhivio.com \
    -m admin@dhivio.com \
    -d erp.dhivio.com -d mes.dhivio.com -d api.dhivio.com
docker compose --env-file /srv/dhivio/.env -f /srv/dhivio/compose.proxy.yml up -d nginx
# look for: "The dry run was successful."
```

### 6.2  Issue real certs

```bash
sudo bash /srv/dhivio/scripts/issue-certs.sh
```

The script will:

1. Seed self-signed snake-oil placeholder at
   `/etc/letsencrypt/live/dhivio.com/` (and per-host paths for back-compat),
   so nginx vhosts can boot before LE has issued
2. Stop nginx (frees :80 for certbot --standalone)
3. Clear the placeholder lineage
4. Run `certbot certonly --cert-name dhivio.com -d erp -d mes -d api`
   against LE prod (or staging if `LETSENCRYPT_SERVER` env var is set)
5. **Patch the renewal config from `authenticator = standalone` to
   `authenticator = webroot`** so the certbot sidecar can renew via the
   running nginx without taking it down (otherwise renewals silently fail
   and the cert expires in 90 days)
6. Restart nginx, `nginx -t`, `nginx -s reload`

**Failure recovery (built-in):** an `EXIT` trap re-seeds placeholders and
restarts nginx if anything between stop and start fails — so the proxy stack
is never left in a non-bootable state. Prior behaviour (before this trap was
added) was to leave nginx down + cert files deleted, taking all 3 sites
offline.

### 6.3  Verify

From the VPS:

```bash
# certbot inventory
docker run --rm -v dhivio-proxy_certbot-etc:/etc/letsencrypt certbot/certbot \
  certificates --cert-name dhivio.com
# expect:
#   Certificate Name: dhivio.com
#   Domains: erp.dhivio.com mes.dhivio.com api.dhivio.com
#   Expiry Date: <now+90 days> (VALID: 89 days)
#   Certificate Path: /etc/letsencrypt/live/dhivio.com/fullchain.pem

# Auto-renewal sanity
docker run --rm \
  -v dhivio-proxy_certbot-etc:/etc/letsencrypt \
  -v dhivio-proxy_certbot-www:/var/www/certbot \
  certbot/certbot renew --webroot -w /var/www/certbot --dry-run
# expect: "Congratulations, all simulated renewals succeeded"
```

From your laptop (no `-k` flag — trust must be unbroken):

```bash
for h in erp.dhivio.com mes.dhivio.com api.dhivio.com; do
  echo | openssl s_client -connect "$h:443" -servername "$h" 2>/dev/null \
    | openssl x509 -noout -issuer -subject -dates
done
# issuer must read: C=US, O=Let's Encrypt, CN=E5/E6/E7/R10/R11
# (NOT "STAGING", NOT self-signed where issuer=subject)

for h in erp.dhivio.com mes.dhivio.com api.dhivio.com; do
  curl -sI -o /dev/null -w "$h: HTTP=%{http_code} SSL_VERIFY=%{ssl_verify_result}\n" \
    "https://$h/_nginx_health"
done
# SSL_VERIFY must be 0 (success) for all three
```

### 6.4  Bring up the proxy stack (idempotent)

```bash
cd /srv/dhivio
docker compose --env-file .env -f compose.proxy.yml up -d
docker ps --filter "name=dhivio-nginx\|dhivio-certbot" --format "{{.Names}}: {{.Status}}"
# expect:
#   dhivio-nginx:   Up X minutes (healthy)
#   dhivio-certbot: Up X minutes
```

The `dhivio-certbot` sidecar runs `certbot renew --webroot` every 12h —
no host cron needed.

---

## 7. Stage and run database migrations

This happens once during bootstrap (and on every release via the
`supabase.yml` GitHub Actions workflow).

### 7.1  Manual first-run (from the VPS root checkout)

```bash
cd /root/dhivio
sudo bash deploy/scripts/run-migrations.sh
```

The script will:

1. rsync `packages/database/supabase/migrations/` →
   `/srv/dhivio/migrations-staging/migrations/`
2. rsync `packages/database/supabase/functions/` →
   `/srv/dhivio/functions/` (with `--exclude=main --exclude=main/**` so the
   edge-runtime stub at `main/index.ts` is preserved)
3. Re-seed `main/index.ts` if missing (keeps `dhivio-edge-runtime` healthy
   across migration runs)
4. Run `supabase db push` against the local postgres
5. Print a summary (X migrations applied / Y total / 0 errors)

Expected result on a fresh DB: ~692 migrations applied successfully.

### 7.2  Automation (post-bootstrap)

After the first manual run, the `supabase.yml` GitHub Actions workflow takes
over: every Saturday 22:00 IST (or on `workflow_dispatch`) it rsyncs the
latest migrations + functions to the VPS and runs the same script.

---

## 8. Configure Cloudflare Turnstile (optional but recommended)

The login page renders the Turnstile widget only when
`CLOUDFLARE_TURNSTILE_SITE_KEY` is truthy in the running container's env.

### 8.1  Create the site key

1. Go to https://dash.cloudflare.com/?to=/:account/turnstile
2. **Add site** → name "Dhivio ERP" (or similar)
3. **Hostnames**: add `erp.dhivio.com` (and `mes.dhivio.com` if you ever
   wire the widget there — currently only ERP uses it)
4. **Widget mode**: Managed (recommended for human users)
5. Save → copy the **Site Key** (public, starts with `0x...`) and the
   **Secret Key** (server-only, longer)

### 8.2  Set both keys

Edit `/srv/dhivio/.env`:

```bash
CLOUDFLARE_TURNSTILE_SITE_KEY=0x...your-public-key...
CLOUDFLARE_TURNSTILE_SECRET_KEY=0x...your-secret-key...
```

Set the matching GitHub secret `BUILD_VITE_CLOUDFLARE_TURNSTILE_SITE_KEY` to
the **same site key** (for build-time inlining into the client bundle — though
the live ERP currently reads it at SSR time via `process.env`, not at build
time).

### 8.3  Restart the active ERP container (no rebuild needed)

```bash
cur=$(cat /srv/dhivio/state/erp.active)   # blue or green
docker compose --env-file /srv/dhivio/.env -f /srv/dhivio/compose.apps.yml \
  up -d --force-recreate "erp-$cur"
```

> If using the well-known test key `1x00000000000000000000AA`, the widget
> renders with a red **"For testing only. If seen, report to site owner"**
> banner and auto-passes. Fine for staging; replace before prod traffic.

> `--force-recreate` is required so docker compose picks up the new env var
> (it doesn't recreate just because `.env` changed).

---

## 9. First app deploy (CI-driven)

Everything above only needs to happen once. From this point on, all app
releases flow through GitHub Actions.

### 9.1  Trigger the build

```bash
# from laptop
gh workflow run build-and-push.yml --repo <org>/dhivio \
  --ref direct-deployment \
  --field apps=both \
  --field tag=""
```

Or click **Run workflow** in the Actions UI. The two `Build erp` and
`Build mes` jobs each take ~5-8 min.

### 9.2  Trigger the deploy

When build completes, get the commit SHA you built from
(`gh run view <run-id>` shows `head_sha`):

```bash
gh workflow run deploy.yml --repo <org>/dhivio \
  --ref direct-deployment \
  --field apps=both \
  --field tag=<full-40-char-sha-from-build>
```

The deploy workflow SSHes to the VPS (using `VPS_SSH_KEY`) and runs
`/srv/dhivio/scripts/deploy-app.sh` per app. Each app's job:

1. Detects the currently-active color (blue or green) by reading
   `/srv/dhivio/state/<app>.active`
2. Pulls the new image from Docker Hub
3. Boots the IDLE color with the new image
4. `wait-healthy.sh` blocks until the new container's healthcheck passes
5. `switch-traffic.sh` rewrites nginx's upstream variable and reloads
6. Stops the previous color
7. Updates `/srv/dhivio/state/<app>.active` to the new color
8. Smoke test from CI: tries 3 endpoint variants in order:
   - VPS-direct HTTP `/health`
   - VPS-direct HTTPS `/health` with `-k`
   - Public HTTPS `/health` (succeeds once Feature 5 / §6 is done)

Expected result: both apps reachable at:

- https://erp.dhivio.com/login
- https://mes.dhivio.com/
- https://api.dhivio.com/ → Kong returns `{"message":"no Route matched with those values"}` for the root path; valid Kong routes (e.g. `/auth/v1/health`) return 200

---

## 10. Validate the bring-up

From your laptop, after the deploy succeeds:

```bash
# All three hostnames serve trusted TLS
for h in erp.dhivio.com mes.dhivio.com api.dhivio.com; do
  curl -sI -o /dev/null -w "$h /health = %{http_code}  SSL=%{ssl_verify_result}\n" \
    "https://$h/health"
done
# expect:
#   erp.dhivio.com /health = 200  SSL=0
#   mes.dhivio.com /health = 200  SSL=0
#   api.dhivio.com /health = 404  SSL=0   (no /health route on api; SSL still trusted)
```

Then browser-test https://erp.dhivio.com/login — you should see the Dhivio
"d" logo, Sign in with Google, email input, and (if you set a real Turnstile
key) the Cloudflare challenge widget.

---

## 11. Set up backups

`deploy/scripts/backup-db.sh` is a pg_dump wrapper. Schedule it via host
cron (the script itself is intentionally non-scheduling so you can target
your own off-site storage):

```bash
crontab -e
# Daily at 03:30 UTC (09:00 IST)
30 3 * * * /srv/dhivio/scripts/backup-db.sh >> /var/log/dhivio-backup.log 2>&1
```

Backups land in `/srv/dhivio/backups/` as `dhivio-YYYYMMDD-HHMMSS.sql.gz`.
**Add your off-site copy step** (rsync to S3, b2, restic, etc.) — the
script does NOT do this for you.

---

## 12. Re-enable scheduled releases

During bring-up, the cron triggers on all three workflows are commented out
so they only fire on manual dispatch. Once everything is stable, re-enable:

| File | Find | Uncomment |
|---|---|---|
| `.github/workflows/build-and-push.yml` | `# - cron: "30 16 * * 6"` | Saturday 22:00 IST builds |
| `.github/workflows/supabase.yml` | `# - cron: ...` | Migrations after build |
| `.github/workflows/deploy.yml` | (uses `workflow_run` of supabase.yml — no cron needed) | — |

Commit the changes and push. From the next Saturday onwards, the full
build → migrate → deploy chain runs unattended.

---

## 13. Operational quick-reference

### Day-to-day commands

```bash
# Container health
docker ps --filter "name=dhivio-" --format "{{.Names}}: {{.Status}}"

# Tail logs for an app
docker logs -f dhivio-erp-blue       # or -green; check state/erp.active
docker logs -f dhivio-mes-blue

# Check the active color
cat /srv/dhivio/state/erp.active
cat /srv/dhivio/state/mes.active

# Rollback (image still cached locally — ~5s)
/srv/dhivio/scripts/deploy-app.sh erp rollback
/srv/dhivio/scripts/deploy-app.sh mes rollback

# Rotate Supabase JWT (rebuild + redeploy required after)
sudo bash /root/dhivio/deploy/scripts/bootstrap.sh --rotate-jwt
docker compose --env-file /srv/dhivio/.env -f /srv/dhivio/compose.infra.yml up -d

# Manual cert renewal (sidecar usually handles this — only if it failed)
docker run --rm \
  -v dhivio-proxy_certbot-etc:/etc/letsencrypt \
  -v dhivio-proxy_certbot-www:/var/www/certbot \
  certbot/certbot renew --webroot -w /var/www/certbot

# Reload nginx after cert renewal
docker exec dhivio-nginx nginx -s reload
```

### Picking the right env-var location

| Where to put it | Why |
|---|---|
| Build-time only (e.g. `VITE_PUBLIC_*`) | GitHub Actions secret `BUILD_*` + Dockerfile `ARG`. Inlined into client JS bundle at build time. |
| Runtime, server-only (DB password, service-role key, OAuth secrets) | `/srv/dhivio/.env` only. Exposed to containers via `compose.apps.yml` `x-app-env` block. |
| Runtime, BOTH server AND client (e.g. `CLOUDFLARE_TURNSTILE_SITE_KEY`) | `/srv/dhivio/.env` AND added to `x-app-env` in compose.apps.yml. Read SSR via `process.env`; forwarded to client by `root.tsx` setting `window.env`. |

---

## 14. Common bring-up failures and fixes

This table is the condensed "stuff that went wrong during the first
bring-up" — see `llm/workflows/vps-deployment.md` for the full root-cause
analysis of each.

| Symptom | Root cause | Fix |
|---|---|---|
| `dhivio-realtime` CrashLoopBackOff with `AES_128_ECB error` | `REALTIME_DB_ENC_KEY` is 32 hex chars (= 32 bytes); realtime wants **16 raw bytes** | `bootstrap.sh --rotate-jwt` |
| `dhivio-inngest` exits with `invalid signing key` | `INNGEST_SIGNING_KEY` has the `signkey-prod-` prefix | `bootstrap.sh --rotate-jwt` (strips it) |
| `dhivio-studio` healthcheck red even though service responds | Next 16 binds to container hostname, not `0.0.0.0`. Studio removed in our compose.infra.yml entirely. | upgrade compose.infra.yml from the repo |
| `docker push` rejected with `repository name must have only one slash` | Image path `dhivio/sachin/erp` is illegal — Docker Hub doesn't allow nested namespaces | use `<dockerhub-username>/dhivio-erp` (single slash) |
| GH Actions smoke test times out | `*.dhivio.com` DNS not yet pointing at VPS; or LE certs not issued; or smoke-test probe order wrong | smoke test now probes VPS-direct HTTP first (works without DNS); see `deploy.yml` step "Smoke test" |
| `Cannot find package 'tailwindcss'` on app start | `tailwindcss` was in `devDependencies` → pruned by `pnpm deploy --prod` → missing in `/prod/node_modules` → SSR bundle's top-level `import 'tailwindcss'` fails | move `tailwindcss: 'catalog:'` from devDeps → deps in both `apps/erp/package.json` and `apps/mes/package.json`; rebuild |
| Turnstile widget missing on /login | `CLOUDFLARE_TURNSTILE_SITE_KEY` not exposed to the container by `compose.apps.yml` (env line missing) | add `CLOUDFLARE_TURNSTILE_SITE_KEY: ${CLOUDFLARE_TURNSTILE_SITE_KEY}` to `x-app-env`; force-recreate container |
| `issue-certs.sh` failed and now nginx won't start (cert files missing) | Script's earlier version did `stop nginx → rm placeholder → certbot crashed → never restarted nginx` | current script has an `EXIT` trap that re-seeds placeholder + restarts nginx; if you're on an older script, manually: `docker run --rm -v dhivio-proxy_certbot-etc:/etc/letsencrypt alpine:3.20 sh -c "mkdir -p /etc/letsencrypt/live/dhivio.com && openssl req -x509 ... > fullchain.pem"` then `docker compose -f compose.proxy.yml up -d nginx` |
| LE: `too many certificates (5) already issued for this exact set of identifiers in the last 168h` | "Duplicate certificate" rate-limit. Bring-up retries against the SAME hostname accumulate. | Use the multi-SAN issuance (already implemented in `issue-certs.sh` — one cert covering all 3 hosts, which is a DIFFERENT identifier set and bypasses the limit) |
| Cert silently expires after 90 days even with the sidecar running | `certbot --standalone` issuance writes `authenticator=standalone` in the renewal config; sidecar runs `--webroot` and skips standalone lineages | `issue-certs.sh` now patches the renewal config to `authenticator=webroot` after issuance (added 2026-05-19) |
| `nginx -s reload` succeeds but app still 502 | nginx's negative-DNS cache holds old container IP after blue/green flip | `switch-traffic.sh` has auto-restart fallback when post-reload smoke probe returns 5xx/000 |
| Inngest can't reach app after blue/green flip | `docker network disconnect/connect` during the flip changed the container's IP, but Inngest cached the old DNS lookup | declare network aliases (`erp-active` / `mes-active`) at compose-level in `compose.apps.yml`, not via runtime disconnect/connect |
| Rollback says `no previous_tag set` | `/srv/dhivio/state/<app>.previous_tag` file is empty because `deploy-app.sh` reads it from a docker label that isn't set on the image | open issue: needs `LABEL org.opencontainers.image.version=$TARGET` in both Dockerfiles |

---

## 15. What this runbook deliberately does NOT cover

- **DR / restore from backup.** Out of scope here — `backup-db.sh` produces
  the dump; restoring is `gunzip < backup.sql.gz | psql -U postgres -d postgres`
  but you'd want to think carefully about row-counts and FK constraints first.
- **Multi-VPS HA.** This stack is single-VPS by design. HA would require
  postgres replication, distributed Redis, shared volumes for cert renewals,
  and a proper load balancer — none of which the current setup supports.
- **Scaling the apps horizontally.** Both ERP and MES are stateful enough
  (in-memory caches, SSE / WebSocket connections) that horizontal scaling
  requires app-side changes first.
- **Migrating from this stack to AWS/Vercel.** The old `sst.config.ts` is
  still in the repo for reference but the codepath is dead. See
  `llm/cache/sst-deployment-infrastructure.md` for what that used to look
  like; treat it as archeology.

---

## 16. Reference paths (memorize these)

| Path | Purpose |
|---|---|
| `/srv/dhivio/.env` | All runtime secrets. Owned by root, mode 600. |
| `/srv/dhivio/compose.{infra,apps,proxy}.yml` | The 3 compose projects |
| `/srv/dhivio/scripts/` | All operational scripts (rsync'd from `deploy/scripts/`) |
| `/srv/dhivio/nginx/conf.d/` | nginx vhosts (rsync'd from `deploy/nginx/conf.d/`) |
| `/srv/dhivio/state/<app>.active` | "blue" or "green" — read by deploy + switch scripts |
| `/srv/dhivio/state/<app>.{current,previous}_tag` | Last + previous image SHA per app |
| `/srv/dhivio/backups/` | pg_dump output lands here |
| `/srv/dhivio/migrations-staging/` | rsync target for `supabase.yml` workflow |
| `/srv/dhivio/functions/` | edge-runtime function bundle (with `main/index.ts` stub) |
| Docker volume `dhivio-proxy_certbot-etc` | LE certs + renewal configs |
| Docker volume `dhivio-proxy_certbot-www` | webroot for HTTP-01 challenges |
| Docker network `dhivio_net` | external bridge connecting all 3 stacks |

---

*Last updated: 2026-05-19, after Feature 5 (DNS + LE certs) bring-up.
Future updates should be added at the bottom of `llm/workflows/vps-deployment.md`
first; this file is the steady-state checklist and should only change when a
step's procedure (not just its rationale) materially shifts.*
