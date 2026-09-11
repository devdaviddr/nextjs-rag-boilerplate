# syntax=docker/dockerfile:1

# ---------- Base ----------
FROM node:22-alpine AS base
# libc6-compat helps some native addons resolve on Alpine/musl.
#
# `font-liberation` is not a nicety. Alpine ships NO fonts, and a PDF is not
# required to embed the ones it names — the standard 14 (Helvetica, Times,
# Courier) may simply be referenced and left to the reader. With no font on the
# box, `@napi-rs/canvas` draws no glyphs and a page of text renders as a blank
# sheet: no error, no log line.
#
# That is not a cosmetic bug. The rendered PNG is what `nemotron-parse` is
# shown, so a blank render means the parser is handed an empty page, reports
# "no elements", and the document is indexed from its text layer if it has one
# — or from the few vector rules that did draw, if it does not. Measured on a
# real clinical guideline (2026-09-11): 0.32% of pixels inked instead of 4.7%,
# and three pages whose parse "succeeded" indexed 16-32 tokens each, all of it
# table borders. Ingestion reported success throughout.
#
# It never reproduced in development because macOS has Helvetica installed.
# Liberation Sans is metric-compatible with Helvetica/Arial, so substituted
# text keeps the layout the boxes are positioned against.
#
# pdf.js's own bundled `standard_fonts` are NOT an alternative: it loads them
# over a `file://` URL, which Node's `fetch` refuses, so every one fails with
# "Unable to load font data" and the page still comes out blank.
RUN apk add --no-cache libc6-compat font-liberation fontconfig
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Skip git hooks (husky) inside the container — there is no .git here.
ENV HUSKY=0
RUN corepack enable
WORKDIR /app

# ---------- Dependencies ----------
FROM base AS deps
# pnpm-workspace.yaml carries the `allowBuilds` approvals for native addons;
# without it pnpm refuses to run their install scripts under --frozen-lockfile.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ---------- Builder ----------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Env validation runs at import time, so `next build` needs these vars present.
# We pass throwaway placeholders inline on the RUN line so they are scoped to
# this single command — never persisted to a layer's env. Real secrets are
# injected at runtime in the runner stage.
RUN DATABASE_URL="postgresql://build:build@localhost:5432/build" \
    AUTH_SECRET="placeholder-not-used-at-runtime" \
    S3_ENDPOINT="http://localhost:9000" \
    S3_ACCESS_KEY_ID="build" \
    S3_SECRET_ACCESS_KEY="build" \
    S3_BUCKET="build" \
    pnpm build

# ---------- Runner ----------
FROM base AS runner
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# Run as an unprivileged user.
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# The standalone output includes a minimal node_modules with the traced native
# binaries — argon2, and @napi-rs/canvas for PDF page rendering (spec 0031).
# Both are listed in next.config.ts's serverExternalPackages, which is what
# makes them resolvable rather than bundled. Copy migrations + runner deps so
# we can migrate too.
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# Baked-in build identity, surfaced in the app's Settings page. CI passes these
# as build-args (APP_VERSION=git ref, APP_GIT_SHA=commit); the defaults keep
# local and un-baked builds working. Placed late so a per-commit SHA change only
# rebuilds this tiny final layer, not the whole image.
ARG APP_VERSION=unknown
ARG APP_GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION
ENV APP_GIT_SHA=$APP_GIT_SHA

USER nextjs
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
