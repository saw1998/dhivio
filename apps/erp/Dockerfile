# syntax=docker/dockerfile:1.7
#
# Multi-stage build for ERP. Optimised for low-RAM VPS:
#   1. `turbo prune` keeps the dep graph small.
#   2. `pnpm deploy --prod` extracts a prod-only node_modules.
#   3. Alpine runtime keeps the final image ~200 MB.
#
# IMPORTANT: every VITE_* / SUPABASE public var MUST be declared as ARG and
# exported as ENV BEFORE `pnpm run build`, otherwise Vite strips them from the
# client bundle (this was the cause of the previous Turnstile / Google-login
# regression).

ARG NODE_VERSION=22-alpine

# ──────────────────────────────────────────────────────────────────────────────
# 1. Prune the monorepo down to just what `erp` needs
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS pruner
WORKDIR /repo
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
COPY . .
RUN pnpm dlx turbo@2.9.6 prune --scope=erp --docker

# ──────────────────────────────────────────────────────────────────────────────
# 2. Install dependencies against the pruned manifest
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat python3 make g++
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

# Workspace skeleton (only package.json + lockfile + npmrc)
COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY .npmrc ./
COPY patches ./patches

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
# 3. Build (Vite + React Router SSR)
# ──────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
COPY lingui.config.js turbo.json ./

# Public build args — baked into the client bundle.
ARG VITE_CLOUDFLARE_TURNSTILE_SITE_KEY
ARG VITE_RAZORPAY_KEY_ID
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
ARG SUPABASE_URL
ARG SUPABASE_ANON_KEY
ARG CARBON_EDITION=cloud
# Placeholder used only at build time; the real value is injected at runtime
ARG SESSION_SECRET=build-time-placeholder-not-used-at-runtime

ENV VITE_CLOUDFLARE_TURNSTILE_SITE_KEY=$VITE_CLOUDFLARE_TURNSTILE_SITE_KEY \
    VITE_RAZORPAY_KEY_ID=$VITE_RAZORPAY_KEY_ID \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    SUPABASE_URL=$SUPABASE_URL \
    SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY \
    CARBON_EDITION=$CARBON_EDITION \
    SESSION_SECRET=$SESSION_SECRET \
    NODE_OPTIONS=--max-old-space-size=8024

RUN pnpm turbo run build --filter=erp

# Extract a prod-only node_modules tree for the runtime stage.
RUN pnpm --filter=erp deploy --prod --legacy /prod

# ──────────────────────────────────────────────────────────────────────────────
# 4. Runtime — tiny Alpine image
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

RUN apk add --no-cache dumb-init curl tini && \
    addgroup -S nodejs && adduser -S -G nodejs -u 1001 carbon || true

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=384

COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /repo/apps/erp/build ./build
COPY --from=build /repo/apps/erp/public ./public
COPY --from=build /repo/apps/erp/package.json ./package.json

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "./node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"]
