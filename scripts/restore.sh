#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh.
#
#   scripts/restore.sh BACKUP.tar.gz [--media-path NEWPATH] [--remap-mount OLD=NEW]
#
#   --media-path NEWPATH   the library now lives at a different HOST path (new drive, new mount point).
#                          Updates MEDIA_PATH in .env. Inside the containers the library is still /media,
#                          so the database needs no change for this.
#   --remap-mount OLD=NEW  rewrite storage_volumes.mount_path from OLD to NEW (in-container paths). Only
#                          needed if the volume was registered under a different in-container path;
#                          NEW must be inside MEDIA_ROOTS_ALLOWED and mounted into the containers.
#
# Steps: stop web/api/worker, pg_restore --clean --if-exists, apply remaps, start everything.
# Afterwards run Storage -> Reconcile in the web UI (or POST /api/storage/reconcile) so the catalogue
# matches the files that are actually on the drive.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
require_docker

BACKUP="${1:-}"
[[ -n "$BACKUP" && -f "$BACKUP" ]] || die "usage: $0 BACKUP.tar.gz [--media-path NEWPATH] [--remap-mount OLD=NEW]"
shift
NEW_MEDIA="" REMAP=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --media-path) NEW_MEDIA="${2:?--media-path needs a value}"; shift 2 ;;
    --remap-mount) REMAP="${2:?--remap-mount needs OLD=NEW}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

PGUSER="$(env_get POSTGRES_USER nocon)"
PGDB="$(env_get POSTGRES_DB nocon)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
tar -C "$TMP" -xzf "$BACKUP"
DIR="$(find "$TMP" -mindepth 1 -maxdepth 1 -type d | head -n1)"
[[ -f "$DIR/db.dump" ]] || die "$BACKUP does not contain db.dump"
cat "$DIR/info.txt" 2>/dev/null || true

if [[ -n "$NEW_MEDIA" ]]; then
  [[ -d "$NEW_MEDIA" ]] || die "--media-path $NEW_MEDIA is not a directory"
  NEW_MEDIA="$(cd "$NEW_MEDIA" && pwd)"
  if [[ -f .env ]] && grep -q '^MEDIA_PATH=' .env; then
    # portable in-place edit (GNU and BSD sed)
    sed "s#^MEDIA_PATH=.*#MEDIA_PATH=$NEW_MEDIA#" .env >.env.tmp && mv .env.tmp .env
  else
    echo "MEDIA_PATH=$NEW_MEDIA" >>.env
  fi
  export MEDIA_PATH="$NEW_MEDIA"
  echo "==> MEDIA_PATH set to $NEW_MEDIA in .env"
fi

echo "==> Making sure postgres and redis are running"
docker compose up -d --wait postgres redis

echo "==> Stopping web, api and worker"
docker compose stop web worker api

echo "==> Restoring database (pg_restore --clean --if-exists)"
docker compose exec -T postgres pg_restore -U "$PGUSER" -d "$PGDB" --clean --if-exists --no-owner --no-privileges <"$DIR/db.dump" \
  || echo "    pg_restore reported warnings (often harmless on a fresh database); continuing"

if [[ -n "$REMAP" ]]; then
  OLD="${REMAP%%=*}" NEW="${REMAP#*=}"
  [[ -n "$OLD" && -n "$NEW" && "$OLD" != "$REMAP" ]] || die "--remap-mount expects OLD=NEW"
  echo "==> Remapping storage volume mount_path $OLD -> $NEW"
  docker compose exec -T postgres psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=1 \
    -v old="$OLD" -v new="$NEW" <<'SQL'
update storage_volumes set mount_path = :'new' where mount_path = :'old';
SQL
fi

echo "==> Clearing stale queue/heartbeat state in redis"
docker compose exec -T redis redis-cli flushall >/dev/null

echo "==> Starting the stack"
docker compose up -d --wait

cat <<'MSG'

Restore finished.

Next:
  1. Make sure the drive holding your library is mounted at MEDIA_PATH.
  2. Sign in with the admin account from the backup.
  3. Open Storage -> Reconcile (dry run first, then run). This rebuilds catalogue rows from the
     metadata.json sidecars on the drive and reports missing files, orphans and duplicates.
  4. External player clients (Xtream/M3U) keep working only if you restored db.dump; if you only had
     clients.json, create the clients again and update the players.
MSG
