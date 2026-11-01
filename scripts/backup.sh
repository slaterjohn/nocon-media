#!/usr/bin/env bash
# Backs up the NoConMedia database and library manifests into ./backups/nocon-backup-<timestamp>.tar.gz
#
# Contents:
#   db.dump              pg_dump custom format (everything, including client secret hashes)
#   settings.json        settings table
#   sources.json         sources table
#   storage_volumes.json storage volumes
#   clients.json         external clients WITHOUT secret hashes (names/usernames/flags only)
#   manifests/           every library metadata.json sidecar, in library layout (small)
#   info.txt             version/time information
#
# Media files themselves are NOT included (they are large and already on your drive).
# clients.json is informational: after restoring from clients.json alone, clients must be re-created
# because plaintext passwords are never stored. Restoring db.dump restores clients with working credentials.
#
# Usage: scripts/backup.sh [OUTPUT_DIR]      (run from anywhere; uses the compose project in the repo root)
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
require_docker

OUT_DIR="${1:-./backups}"
PGUSER="$(env_get POSTGRES_USER nocon)"
PGDB="$(env_get POSTGRES_DB nocon)"
MEDIA_PATH="$(env_get MEDIA_PATH ./media)"
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="nocon-backup-$STAMP"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
STAGE="$TMP/$NAME"
mkdir -p "$STAGE/manifests" "$OUT_DIR"

psql_json() { # $1 = SQL select; prints a JSON array
  docker compose exec -T postgres psql -U "$PGUSER" -d "$PGDB" -At -c \
    "select coalesce(json_agg(t), '[]'::json) from ($1) t"
}

echo "==> Database dump (custom format)"
docker compose exec -T postgres pg_dump -U "$PGUSER" -d "$PGDB" -Fc >"$STAGE/db.dump"
[[ -s "$STAGE/db.dump" ]] || die "pg_dump produced an empty file"

echo "==> Exporting settings, sources, volumes, clients (no secret hashes)"
psql_json "select * from settings" >"$STAGE/settings.json"
psql_json "select * from sources" >"$STAGE/sources.json"
psql_json "select * from storage_volumes" >"$STAGE/storage_volumes.json"
psql_json "select id, name, kind, username, status, allow_xtream, allow_m3u, last_used_at, created_at, rotated_at, revoked_at from external_clients" >"$STAGE/clients.json"

echo "==> Copying library manifests from $MEDIA_PATH"
count=0
if [[ -d "$MEDIA_PATH" ]]; then
  while IFS= read -r -d '' f; do
    rel="${f#"$MEDIA_PATH"/}"
    mkdir -p "$STAGE/manifests/$(dirname "$rel")"
    cp "$f" "$STAGE/manifests/$rel"
    count=$((count + 1))
  done < <(find "$MEDIA_PATH" -name metadata.json -not -path '*/.noconmedia/*' -print0)
  if [[ -f "$MEDIA_PATH/.noconmedia/volume.json" ]]; then
    mkdir -p "$STAGE/manifests/.noconmedia"
    cp "$MEDIA_PATH/.noconmedia/volume.json" "$STAGE/manifests/.noconmedia/volume.json"
  fi
else
  echo "    (MEDIA_PATH $MEDIA_PATH not found on this host; skipping manifests)"
fi

{
  echo "created=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "nocon_version=$(env_get NOCON_VERSION latest)"
  echo "postgres=$(docker compose exec -T postgres postgres --version | tr -d '\r')"
  echo "manifests=$count"
} >"$STAGE/info.txt"

tar -C "$TMP" -czf "$OUT_DIR/$NAME.tar.gz" "$NAME"
SIZE="$(wc -c <"$OUT_DIR/$NAME.tar.gz" | tr -d ' ')"

echo
echo "Saved $OUT_DIR/$NAME.tar.gz ($(human_size "$SIZE"))"
echo "  db.dump, settings.json, sources.json, storage_volumes.json, clients.json (no hashes), $count manifest file(s)"
echo "Media files are not included. Copy the backup off this machine."
