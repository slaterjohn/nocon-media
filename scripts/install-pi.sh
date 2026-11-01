#!/usr/bin/env bash
# First-run helper for a Raspberry Pi (or any arm64/amd64 Linux box). Does not use sudo and does not
# touch /etc/fstab; it checks prerequisites, creates directories, writes .env and prints next steps.
#
#   scripts/install-pi.sh [MEDIA_DIR] [DATA_DIR]       defaults: ./media ./data
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh

MEDIA_DIR="${1:-./media}"
DATA_DIR="${2:-./data}"

arch="$(uname -m)"
case "$arch" in
  aarch64|arm64) echo "Architecture: $arch (64-bit ARM)" ;;
  x86_64|amd64) echo "Architecture: $arch" ;;
  armv7l|armv6l) die "32-bit ARM ($arch) is not supported. Install Raspberry Pi OS 64-bit." ;;
  *) echo "Warning: untested architecture $arch" ;;
esac
if [[ -r /proc/device-tree/model ]]; then echo "Board: $(tr -d '\0' </proc/device-tree/model)"; fi

command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/debian/"
docker compose version >/dev/null 2>&1 || die "The Docker Compose plugin is missing (apt install docker-compose-plugin)."
if ! docker info >/dev/null 2>&1; then
  die "Cannot talk to the Docker daemon. Add your user to the docker group (sudo usermod -aG docker \$USER) and log in again."
fi
command -v openssl >/dev/null 2>&1 || die "openssl is required to generate the database password."

mkdir -p "$MEDIA_DIR" "$DATA_DIR"
MEDIA_DIR="$(cd "$MEDIA_DIR" && pwd)"
DATA_DIR="$(cd "$DATA_DIR" && pwd)"

if [[ -f .env ]]; then
  echo ".env already exists; leaving it unchanged."
else
  cp .env.example .env
  pw="$(openssl rand -hex 24)"
  proxy_secret="$(openssl rand -hex 32)"
  sed "s#^POSTGRES_PASSWORD=.*#POSTGRES_PASSWORD=$pw#; s#^NOCON_PROXY_SECRET=.*#NOCON_PROXY_SECRET=$proxy_secret#; s#^MEDIA_PATH=.*#MEDIA_PATH=$MEDIA_DIR#; s#^DATA_PATH=.*#DATA_PATH=$DATA_DIR#" .env.example >.env
  chmod 600 .env
  echo "Wrote .env with a random POSTGRES_PASSWORD and NOCON_PROXY_SECRET (mode 600)."
fi

owner_uid="$(stat -c %u "$MEDIA_DIR" 2>/dev/null || stat -f %u "$MEDIA_DIR")"
cat <<MSG

Next steps
  1. Storage: containers run as UID 1000. If $MEDIA_DIR is on a USB drive, mount it by UUID in
     /etc/fstab with the nofail option, for example:
         UUID=<your-uuid>  $MEDIA_DIR  ext4  defaults,nofail,noatime  0  2
     (find the UUID with 'lsblk -f'; this script does not edit fstab). Then make it writable:
         sudo chown -R 1000:1000 $MEDIA_DIR $DATA_DIR
     Current owner UID of the media directory: $owner_uid
  2. Start: docker compose up -d --build --wait      (first build on a Pi 4/5 takes several minutes)
  3. Open http://<this-host>:$(env_get WEB_PORT 3000) and complete the setup wizard (storage path: /media).
  4. Back up regularly: scripts/backup.sh
MSG
