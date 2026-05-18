# syntax=docker/dockerfile:1.7
#
# Multi-stage build for MES. Mirrors apps/erp/Dockerfile — see that file for
# the rationale on each stage. The two intentionally diverge only on memory
# limits and which app turbo prunes for.

ARG NODE_VERSION=22-alpine

# ──────────────────────────────────────────────────────────────────────────────
# 1. Prune the monorepo down to just what `mes` needs
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS pruner
WORKDIR /repo
RUN apk add --no-cache libc6-compat
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate
COPY . .
RUN pnpm dlx turbo@2.9.6 prune --scope=mes --docker

# ──────────────────────────────────────────────────────────────────────────────
# 2. Install dependencies against the pruned manifest
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS deps
WORKDIR /repo
RUN apk add --no-cache libc6-compat python3 make g++
RUN corepack enable && corepack prepare pnpm@10.33.4 --activate

COPY --from=pruner /repo/out/json/ ./
COPY --from=pruner /repo/out/pnpm-lock.yaml ./pnpm-lock.yaml
COPY .npmrc ./
COPY patches ./patches

RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# ──────────────────────────────────────────────────────────────────────────────
# 3. Build
# ──────────────────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY --from=pruner /repo/out/full/ ./
COPY lingui.config.js turbo.json ./

ARG VITE_CLOUDFLARE_TURNSTILE_SITE_KEY
ARG VITE_RAZORPAY_KEY_ID
ARG VITE_POSTHOG_KEY
ARG VITE_POSTHOG_HOST
ARG SUPABASE_URL
ARG SUPABASE_ANON_KEY
ARG CARBON_EDITION=community
ARG SESSION_SECRET=build-time-placeholder-not-used-at-runtime

ENV VITE_CLOUDFLARE_TURNSTILE_SITE_KEY=$VITE_CLOUDFLARE_TURNSTILE_SITE_KEY \
    VITE_RAZORPAY_KEY_ID=$VITE_RAZORPAY_KEY_ID \
    VITE_POSTHOG_KEY=$VITE_POSTHOG_KEY \
    VITE_POSTHOG_HOST=$VITE_POSTHOG_HOST \
    SUPABASE_URL=$SUPABASE_URL \
    SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY \
    CARBON_EDITION=$CARBON_EDITION \
    SESSION_SECRET=$SESSION_SECRET \
    NODE_OPTIONS=--max-old-space-size=4096

RUN pnpm turbo run build --filter=mes

RUN pnpm --filter=mes deploy --prod --legacy /prod

# ──────────────────────────────────────────────────────────────────────────────
# 4. Runtime
# ──────────────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app

RUN apk add --no-cache dumb-init curl tini

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    NODE_OPTIONS=--max-old-space-size=256

COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /repo/apps/mes/build ./build
COPY --from=build /repo/apps/mes/public ./public
COPY --from=build /repo/apps/mes/package.json ./package.json

USER node
EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "./node_modules/@react-router/serve/dist/cli.js", "./build/server/index.js"]
