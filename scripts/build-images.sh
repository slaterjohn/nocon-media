#!/usr/bin/env bash
# Builds the api, worker and web images for linux/arm64 and linux/amd64.
#
#   scripts/build-images.sh                      build each platform separately into the local image store
#                                                (tags nocon-media/<svc>:<version>-arm64 and -amd64)
#   scripts/build-images.sh --platform arm64     one platform only
#   scripts/build-images.sh --oci DIR            multi-platform OCI archives in DIR (cannot be --load-ed)
#   scripts/build-images.sh --push REGISTRY      multi-platform build pushed to REGISTRY/nocon-media/<svc>:<version>
#
# Options: --no-cache, --version TAG (default: $NOCON_VERSION or "latest"), --services "api worker web".
# The non-native platform runs under emulation (QEMU) and is slow; that is expected.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
require_docker
docker buildx version >/dev/null 2>&1 || die "docker buildx is not available"

VERSION="$(env_get NOCON_VERSION latest)"
YTDLP_VERSION="$(env_get YTDLP_VERSION 2026.10.26)"
SERVICES="api worker web"
PLATFORMS="arm64 amd64"
MODE="local" TARGET="" NOCACHE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --push) MODE=push; TARGET="${2:?--push needs a registry}"; shift 2 ;;
    --oci) MODE=oci; TARGET="${2:?--oci needs a directory}"; shift 2 ;;
    --platform) PLATFORMS="${2:?}"; shift 2 ;;
    --version) VERSION="${2:?}"; shift 2 ;;
    --services) SERVICES="${2:?}"; shift 2 ;;
    --no-cache) NOCACHE="--no-cache"; shift ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

args_for() { [[ "$1" == "worker" ]] && echo "--build-arg YTDLP_VERSION=$YTDLP_VERSION" || true; }
now() { date +%s; }
SUMMARY=()

build() { # service platform-list tag-suffix output-args...
  local svc="$1" plats="$2" suffix="$3"; shift 3
  local start end
  start="$(now)"
  # shellcheck disable=SC2046
  docker buildx build --platform "$plats" -f "docker/$svc/Dockerfile" $(args_for "$svc") $NOCACHE "$@" .
  end="$(now)"
  SUMMARY+=("$svc ${suffix:-multi} $((end - start))s")
}

case "$MODE" in
  local)
    for p in $PLATFORMS; do
      for svc in $SERVICES; do
        echo "==> $svc linux/$p"
        build "$svc" "linux/$p" "$p" --load -t "nocon-media/$svc:$VERSION-$p"
      done
    done ;;
  oci)
    mkdir -p "$TARGET"
    for svc in $SERVICES; do
      echo "==> $svc linux/arm64,linux/amd64 -> $TARGET/$svc.oci.tar"
      build "$svc" "linux/arm64,linux/amd64" "" -o "type=oci,dest=$TARGET/$svc.oci.tar" -t "nocon-media/$svc:$VERSION"
    done ;;
  push)
    for svc in $SERVICES; do
      echo "==> $svc linux/arm64,linux/amd64 -> $TARGET"
      build "$svc" "linux/arm64,linux/amd64" "" --push -t "$TARGET/nocon-media/$svc:$VERSION"
    done ;;
esac

echo
echo "Build summary (service platform seconds):"
printf '  %s\n' "${SUMMARY[@]}"
