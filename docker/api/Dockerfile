# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# NoConMedia API. Build context: repository root.
ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true
# pnpm pinned to the root package.json "packageManager" field
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack install
# Manifests first so the install layer is cached until dependencies change
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/database/package.json packages/database/
COPY packages/discovery/package.json packages/discovery/
COPY packages/media-core/package.json packages/media-core/
COPY packages/shared/package.json packages/shared/
COPY packages/source-adapters/package.json packages/source-adapters/
COPY packages/storage-manager/package.json packages/storage-manager/
COPY packages/streaming/package.json packages/streaming/
COPY packages/xtream/package.json packages/xtream/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter "@nocon/api..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @nocon/api build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# The bundle is self-contained (tsup noExternal); dist/drizzle holds the migrations.
COPY --from=build --chown=node:node /repo/apps/api/dist/ ./dist/
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/index.js"]
