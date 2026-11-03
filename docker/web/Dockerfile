# syntax=docker/dockerfile:1.7.1@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
# NoConMedia web (Next.js standalone). Build context: repository root.
ARG NODE_IMAGE=node:24.22.2-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446

# The build stage always runs on the builder's native platform: `next build` segfaults under QEMU
# (amd64 on an Apple Silicon/arm64 builder). The standalone output is plain JS apart from sharp's
# platform binaries, which are removed below because the app does not use next/image optimisation.
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN corepack install
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
    pnpm install --frozen-lockfile --filter "@nocon/web..."
COPY tsconfig.base.json ./
COPY apps/web apps/web
RUN mkdir -p apps/web/public && pnpm --filter @nocon/web build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000 \
    API_INTERNAL_URL=http://api:3001
WORKDIR /app
# Standalone output in a monorepo nests the server under apps/web (outputFileTracingRoot = repo root).
COPY --from=build --chown=node:node /repo/apps/web/.next/standalone ./
RUN rm -rf /app/node_modules/.pnpm/@img+sharp* /app/node_modules/.pnpm/sharp@* /app/node_modules/sharp 2>/dev/null; true
COPY --from=build --chown=node:node /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /repo/apps/web/public ./apps/web/public
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/web/server.js"]
