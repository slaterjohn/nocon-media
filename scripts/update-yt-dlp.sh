#!/usr/bin/env bash
# Rebuilds the worker image with a different yt-dlp and restarts the worker.
#   scripts/update-yt-dlp.sh 2026.10.26
# The version is also written to YTDLP_VERSION in .env so later `docker compose build` keeps it.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
require_docker

VERSION="${1:-}"
[[ "$VERSION" =~ ^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$ ]] || die "usage: $0 YYYY.MM.DD (e.g. 2026.10.26)"

if [[ -f .env ]]; then
  if grep -q '^YTDLP_VERSION=' .env; then
    sed "s/^YTDLP_VERSION=.*/YTDLP_VERSION=$VERSION/" .env >.env.tmp && mv .env.tmp .env
  else
    echo "YTDLP_VERSION=$VERSION" >>.env
  fi
fi

export YTDLP_VERSION="$VERSION"
echo "==> Building worker with yt-dlp $VERSION"
docker compose build --build-arg "YTDLP_VERSION=$VERSION" worker
echo "==> Restarting worker"
docker compose up -d --no-deps worker
docker compose exec -T worker yt-dlp --version
