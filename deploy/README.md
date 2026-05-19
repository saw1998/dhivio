# Dhivio prod deployment

End-to-end Docker + nginx + Supabase self-host stack for a single low-RAM VPS.
Everything in this folder is rsync'd to `/srv/dhivio/` on the VPS by
`scripts/bootstrap.sh`. Once bootstrapped, **all release activity (build →
push → migrate → rolling deploy) is driven from GitHub Actions** — no manual
docker commands required.

## Layout

```
deploy/
├── compose.infra.yml          # postgres, supabase, redis, inngest
├── compose.apps.yml           # erp-blue/green, mes-blue/green
├── compose.proxy.yml          # nginx + certbot
├── kong/kong.yml              # Supabase API gateway routes
├── postgres/                  # postgresql.conf + init.sql.template
├── nginx/                     # nginx.conf, vhosts, snippets
├── scripts/
│   ├── bootstrap.sh           # one-shot prod init (generates .env)
│   ├── issue-certs.sh         # Let's Encrypt issuance for the 3 domains
│   ├── deploy-app.sh          # blue/green rollout (called by CI)
│   ├── switch-traffic.sh      # atomic nginx upstream flip
│   ├── run-migrations.sh      # supabase db push from staged folder
│   ├── backup-db.sh           # pg_dump snapshot
│   └── wait-healthy.sh        # block until container healthcheck passes
└── .env.example               # exhaustive list of every secret
```

## First-time bootstrap (on the VPS)

```bash
git clone https://github.com/<org>/dhivio.git
cd dhivio
sudo bash deploy/scripts/bootstrap.sh
# Fill in the [USER] block when $EDITOR opens

sudo bash deploy/scripts/issue-certs.sh   # after DNS resolves

cd /srv/dhivio
docker compose --env-file .env -f compose.infra.yml up -d
docker compose --env-file .env -f compose.proxy.yml up -d
```

Trigger the first app deploy from GitHub Actions → **Build & Push** workflow
(`workflow_dispatch`). That will:

1. Build linux/amd64 images for ERP + MES (with all `VITE_*` build args).
2. Push to Docker Hub `${DOCKERHUB_USERNAME}/dhivio-erp:<sha>` and
   `${DOCKERHUB_USERNAME}/dhivio-mes:<sha>` (e.g. `sachin4668/dhivio-erp:<sha>`).
   Repos must be pre-created on Docker Hub for free-tier accounts; paid
   accounts auto-create on first push.
3. Chain into the **Deploy** workflow, which SSHes to the VPS and runs
   `deploy-app.sh` for each app — blue/green, zero downtime.

## Scheduled runs

All three workflows are scheduled at **Saturday 22:00 IST (16:30 UTC)**:

| Workflow            | Trigger                          |
| ------------------- | -------------------------------- |
| `build-and-push.yml`| `cron: "30 16 * * 6"` + dispatch |
| `supabase.yml`      | runs after build success         |
| `deploy.yml`        | runs after migrations success    |

Manual override: each workflow has a `workflow_dispatch` button in the GitHub
Actions UI.

## Rollback

```bash
ssh dhivio "/srv/dhivio/scripts/deploy-app.sh erp rollback"
```

Reverts to the previous container color (image is still cached locally —
takes ~5 seconds).

## Rotate Supabase JWT

```bash
sudo bash deploy/scripts/bootstrap.sh --rotate-jwt
docker compose --env-file /srv/dhivio/.env -f /srv/dhivio/compose.infra.yml up -d
# Rebuild & redeploy ERP/MES (anon key changed → bundled into client)
```

## Known issues / app-side fixes still needed

### MES container crashes with `Cannot find package 'tailwindcss'`

The MES app's SSR build (`build/server/index.js`) imports `tailwindcss` at
runtime. Because `tailwindcss` is in `apps/mes/package.json#dependencies`
this should work — but the import path resolves through a transitive package
that's flagged as a devDependency and gets pruned by `pnpm deploy --prod`.

**Root cause**: somewhere in `apps/mes/app/**`, server-side code accidentally
imports a tailwind plugin/config module (e.g. a postcss/tailwind transform).
That should be moved to a build-only path so it isn't bundled into the
server output.

**Workaround until fixed**: deploy ERP only via
`workflow_dispatch → apps: erp`. MES container will crash-loop until the
import is fixed in app code. ERP works fine end-to-end.

### Kong `/functions/v1/main` returns HTTP 000

Edge-runtime serves correctly on its native port (verified
`http://edge-runtime:9000/main → 200`) but Kong's `/functions/v1/` route
returns HTTP 000 (connection refused). Likely a `kong.yml` upstream config
mismatch. Investigate during Feature 5 (TLS + DNS wrap-up).

### Apps stack ↔ Proxy stack ordering

`compose.apps.yml` doesn't `depends_on` the nginx in `compose.proxy.yml`
(they are separate compose projects). `deploy-app.sh` assumes nginx is
already up; on a fresh bootstrap you must
`docker compose -f compose.proxy.yml up -d` first.
