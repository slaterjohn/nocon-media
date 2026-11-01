#!/usr/bin/env bash
# Measures idle resource use and basic latency of a running NoConMedia stack. Prints Markdown that can be
# pasted into docs/benchmarks.md.
#
#   NOCON_ADMIN_USER=admin NOCON_ADMIN_PASSWORD=... scripts/benchmark.sh [--api URL] [--requests N] [--streams N]
#
# Needs: a running stack with setup complete and at least one playable item in the library, curl, awk.
# IMPORTANT: numbers from a laptop or desktop say nothing about a Raspberry Pi. Publish results in
# docs/benchmarks.md only when this ran on the target hardware, and record the board, OS, storage and
# profile in the header this script prints.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
# shellcheck source=scripts/lib.sh
source scripts/lib.sh
require_docker
command -v curl >/dev/null || die "curl is required"

API="http://127.0.0.1:$(env_get API_PORT_PUBLIC 3001)"
N=50 STREAMS=4
while [[ $# -gt 0 ]]; do
  case "$1" in
    --api) API="${2:?}"; shift 2 ;;
    --requests) N="${2:?}"; shift 2 ;;
    --streams) STREAMS="${2:?}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done
USER_="${NOCON_ADMIN_USER:-admin}"
PASS_="${NOCON_ADMIN_PASSWORD:-}"
[[ -n "$PASS_" ]] || die "set NOCON_ADMIN_PASSWORD (and optionally NOCON_ADMIN_USER)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
JAR="$TMP/cookies"
H=(-H 'X-NoCon-CSRF: 1' -H 'Content-Type: application/json')

# ---- latency helper: prints "p50 p95 max" in ms for N requests of the given curl args
latency() {
  local i
  : >"$TMP/times"
  for ((i = 0; i < N; i++)); do
    curl -s -o /dev/null -w '%{time_total}\n' "$@" >>"$TMP/times"
  done
  sort -n "$TMP/times" | awk -v n="$N" '{a[NR]=$1*1000} END {
    p50=a[int((n+1)*0.50)]; i=int((n+1)*0.95); if (i>n) i=n
    printf "%.1f %.1f %.1f\n", p50, a[i], a[n] }'
}

curl -sf -c "$JAR" "${H[@]}" -X POST "$API/api/auth/login" \
  -d "{\"username\":\"$USER_\",\"password\":\"$PASS_\"}" >/dev/null || die "login failed"

ITEM="$(curl -sf -b "$JAR" "$API/api/library/media?limit=1")"
MEDIA_ID="$(printf '%s' "$ITEM" | sed -n 's/.*"items":\[{"id":"\([^"]*\)".*/\1/p')"
[[ -n "$MEDIA_ID" ]] || die "no media in the library; add or import something first"

CLIENT="$(curl -sf -b "$JAR" "${H[@]}" -X POST "$API/api/clients" -d '{"name":"benchmark","kind":"xtream"}')"
XT_USER="$(printf '%s' "$CLIENT" | sed -n 's/.*"xtream":{[^}]*"username":"\([^"]*\)".*/\1/p')"
XT_PASS="$(printf '%s' "$CLIENT" | sed -n 's/.*"xtream":{[^}]*"password":"\([^"]*\)".*/\1/p')"
CLIENT_ID="$(printf '%s' "$CLIENT" | sed -n 's/.*"client":{"id":"\([^"]*\)".*/\1/p')"
[[ -n "$XT_USER" && -n "$XT_PASS" ]] || die "could not create a benchmark client"
cleanup_client() { [[ -n "${CLIENT_ID:-}" ]] && curl -s -b "$JAR" "${H[@]}" -X DELETE "$API/api/clients/$CLIENT_ID" >/dev/null || true; }
trap 'cleanup_client; rm -rf "$TMP"' EXIT

echo "# Benchmark run $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo
echo "| Item | Value |"
echo "|---|---|"
echo "| Host | $(uname -sm) |"
[[ -r /proc/device-tree/model ]] && echo "| Board | $(tr -d '\0' </proc/device-tree/model) |"
# shellcheck disable=SC1091
[[ -r /etc/os-release ]] && echo "| OS | $(. /etc/os-release && echo "$PRETTY_NAME") |"
echo "| Docker | $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo unknown) |"
echo "| Profile | $(env_get DEPLOYMENT_PROFILE lightweight) |"
echo "| Requests per latency test | $N |"
echo
echo "## Idle resource use"
echo
echo "| Container | CPU % | Memory |"
echo "|---|---|---|"
# shellcheck disable=SC2046
docker stats --no-stream --format '| {{.Name}} | {{.CPUPerc}} | {{.MemUsage}} |' $(docker compose ps -q)
echo

echo "## API latency (ms)"
echo
echo "| Endpoint | p50 | p95 | max |"
echo "|---|---|---|---|"
read -r a b c < <(latency -b "$JAR" "$API/api/library/search?q=a")
echo "| GET /api/library/search | $a | $b | $c |"
read -r a b c < <(latency -b "$JAR" "$API/api/library/media?limit=50")
echo "| GET /api/library/media?limit=50 | $a | $b | $c |"
read -r a b c < <(latency "$API/player_api.php?username=$XT_USER&password=$XT_PASS&action=get_vod_streams")
echo "| Xtream get_vod_streams | $a | $b | $c |"
read -r a b c < <(latency "$API/healthz")
echo "| GET /healthz | $a | $b | $c |"
echo

echo "## Concurrent range streams"
echo
SIZE_LIMIT=$((32 * 1024 * 1024 - 1))
start="$(date +%s.%N 2>/dev/null || date +%s)"
pids=()
for ((i = 0; i < STREAMS; i++)); do
  curl -s -o /dev/null -b "$JAR" -H "Range: bytes=0-$SIZE_LIMIT" -w '%{size_download} %{time_total}\n' \
    "$API/api/media/$MEDIA_ID/stream" >"$TMP/stream.$i" &
  pids+=($!)
done
wait "${pids[@]}"
end="$(date +%s.%N 2>/dev/null || date +%s)"
echo "| Stream | Bytes | Seconds | MiB/s |"
echo "|---|---|---|---|"
for ((i = 0; i < STREAMS; i++)); do
  awk -v n="$((i + 1))" '{ printf "| %d | %d | %.2f | %.1f |\n", n, $1, $2, ($2 > 0 ? $1 / $2 / 1048576 : 0) }' "$TMP/stream.$i"
done
awk -v s="$start" -v e="$end" -v n="$STREAMS" 'BEGIN { printf "\n%d parallel streams, wall time %.2f s\n", n, e - s }'
echo
echo "_Measured with scripts/benchmark.sh. Real numbers must come from a Raspberry Pi; results from other hardware are for regression comparison only._"
