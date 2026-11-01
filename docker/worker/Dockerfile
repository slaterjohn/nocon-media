# syntax=docker/dockerfile:1.7
# NoConMedia worker (yt-dlp + ffmpeg). Build context: repository root.
ARG NODE_IMAGE=node:24-trixie-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
ENV CI=true
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
    pnpm install --frozen-lockfile --filter "@nocon/worker..."
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
RUN pnpm --filter @nocon/worker build

FROM ${NODE_IMAGE} AS runtime
ARG YTDLP_VERSION=2026.10.26
ENV NODE_ENV=production \
    XDG_CACHE_HOME=/data/cache
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv ca-certificates tini \
 && python3 -m venv /opt/yt-dlp \
 && /opt/yt-dlp/bin/pip install --no-cache-dir "yt-dlp[default]==${YTDLP_VERSION}" \
 && ln -s /opt/yt-dlp/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/* /root/.cache
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/worker/dist/ ./dist/
COPY --chown=node:node docker/worker/healthcheck.mjs ./healthcheck.mjs
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD ["node", "/app/healthcheck.mjs"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
