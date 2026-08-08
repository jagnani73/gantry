# Backend container for Railway or Fly.
#
# Vercel is deliberately not an option for this half: the dashboard feed is a
# long-lived SSE stream and serverless functions time it out. The web package
# goes to Vercel (see vercel.json at the repo root); this goes to a host that
# keeps a process alive.
#
# Build context is the REPO ROOT, not this directory:
#   docker build -f packages/backend/Dockerfile -t gantry-backend .
FROM node:22-bookworm-slim

# better-sqlite3 compiles a native addon, and pnpm-workspace.yaml lists it under
# onlyBuiltDependencies, so the toolchain has to exist at install time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Manifests first, so editing source does not re-resolve the whole tree. Every
# workspace member's package.json must be here or pnpm cannot expand the filter
# below, even though only two of them get installed.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json    packages/shared/
COPY packages/backend/package.json   packages/backend/
COPY packages/web/package.json       packages/web/
COPY packages/agent/package.json     packages/agent/
COPY packages/contracts/package.json packages/contracts/

# The trailing `...` pulls in @gantry/shared. No --prod: the backend runs its
# TypeScript through tsx (a devDependency), and @gantry/shared exports
# src/index.ts directly rather than a build artifact — so the runner and the
# shared source are both needed at runtime, not just at build time.
RUN pnpm install --frozen-lockfile --filter @gantry/backend...

COPY packages/shared  packages/shared
COPY packages/backend packages/backend

ENV NODE_ENV=production
# Railway and Fly inject PORT; config.ts reads it and falls back to 4000.
EXPOSE 4000

# SQLite lives at packages/backend/gantry.db and is a disposable cache — the
# chain is the source of truth — so it is deliberately NOT a mounted volume. A
# redeploy starts the feed empty until the indexer's sweep repopulates it.
CMD ["pnpm", "--filter", "@gantry/backend", "start"]
