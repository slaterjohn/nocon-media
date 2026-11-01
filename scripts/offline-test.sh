#!/usr/bin/env bash
# Brings the stack up with NO internet access for any service, seeds a small video into the media
# volume, runs tests/offline/check.mjs from inside the internal network, then tears everything down.
#   scripts/offline-test.sh [--keep]     --keep leaves the stack running for debugging
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-nocon-offline}"
export POSTGRES_PASSWORD="${POSTGRES_PASSWORD:-offline-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')}"
export NOCON_PROXY_SECRET="${NOCON_PROXY_SECRET:-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/nocon-offline.XXXXXX")"
export MEDIA_PATH="$WORK/media" DATA_PATH="$WORK/data"
mkdir -p "$MEDIA_PATH" "$DATA_PATH"
chmod 777 "$MEDIA_PATH" "$DATA_PATH" # containers run as UID 1000
export OFFLINE_TITLE="Offline Seed Video"

DC=(docker compose -f compose.yml -f compose.offline.yml)

cleanup() {
  local rc=$?
  if [[ $KEEP -eq 0 ]]; then
    "${DC[@]}" --profile offline-test down -v --remove-orphans >/dev/null 2>&1 || true
    rm -rf "$WORK" 2>/dev/null || docker run --rm -v "$WORK:/w" busybox rm -rf /w/media /w/data 2>/dev/null || true
    rm -rf "$WORK" 2>/dev/null || true
  else
    echo "Stack left running (project $COMPOSE_PROJECT_NAME, data in $WORK)."
  fi
  exit "$rc"
}
trap cleanup EXIT

echo "==> Building images (cached if unchanged)"
"${DC[@]}" build api worker web

echo "==> Seeding media (ffmpeg in the worker image, no network)"
# shellcheck disable=SC2016 # the script below is meant to expand inside the container
"${DC[@]}" run --rm --no-deps --entrypoint sh -e OFFLINE_TITLE worker -c '
set -eu
d=/media/youtube/videos/offline0001
mkdir -p "$d"
ffmpeg -v error -y -f lavfi -i testsrc=size=640x360:rate=25 -f lavfi -i sine=frequency=440 -t 4 \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -c:a aac -movflags +faststart "$d/media.mp4"
ffmpeg -v error -y -i "$d/media.mp4" -frames:v 1 -vf scale=320:-1 "$d/media.jpg"
node -e "
const fs=require(\"fs\"),c=require(\"crypto\"),d=process.argv[1];
const sha=c.createHash(\"sha256\").update(fs.readFileSync(d+\"/media.mp4\")).digest(\"hex\");
const size=fs.statSync(d+\"/media.mp4\").size;
fs.writeFileSync(d+\"/metadata.json\",JSON.stringify({version:1,canonicalKey:\"youtube:offline0001\",
 originalUrl:\"https://www.youtube.com/watch?v=offline0001\",title:process.env.OFFLINE_TITLE,
 description:\"Generated test pattern used by the offline acceptance test.\",
 creator:{id:\"UCoffline\",name:\"Offline Channel\"},publishedAt:\"2026-01-01T00:00:00.000Z\",durationSeconds:4,
 categories:[\"Education\"],tags:[\"offline\",\"test\"],downloadedAt:new Date().toISOString(),
 technical:{container:\"mp4\",videoCodec:\"h264\",audioCodec:\"aac\",width:640,height:360,sizeBytes:size},
 artwork:{thumbnail:\"media.jpg\"},subtitles:[],chapters:[],mainFile:\"media.mp4\",checksums:{sha256:sha}},null,2));
" "$d"
ls -l "$d"
'

echo "==> Starting stack (internal networks only)"
"${DC[@]}" up -d --wait postgres redis api worker web

echo "==> Egress proof from the service containers"
rc_egress=0
for svc in api worker web; do
  if "${DC[@]}" exec -T "$svc" node -e "fetch('https://www.youtube.com',{signal:AbortSignal.timeout(6000)}).then(()=>process.exit(1),()=>process.exit(0))"; then
    echo "PASS  $svc cannot reach https://www.youtube.com"
  else
    echo "FAIL  $svc REACHED https://www.youtube.com"
    rc_egress=1
  fi
done

echo "==> Running checks inside the internal network"
rc_checks=0
"${DC[@]}" --profile offline-test run --rm offline-test || rc_checks=$?

if [[ $rc_egress -ne 0 || $rc_checks -ne 0 ]]; then
  echo "OFFLINE TEST: FAIL (egress=$rc_egress checks=$rc_checks)"
  "${DC[@]}" logs --tail 40 api worker 2>&1 || true
  exit 1
fi
echo "OFFLINE TEST: PASS"
