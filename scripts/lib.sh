#!/usr/bin/env bash
# Shared helpers for the NoConMedia scripts. Source this file; do not execute it.

# Reads VAR from the environment, then from ./.env, then falls back to $2.
env_get() {
  local name="$1" default="${2:-}" value="${!1:-}"
  if [[ -z "$value" && -f .env ]]; then
    value="$(grep -E "^${name}=" .env | tail -n1 | cut -d= -f2- || true)"
    value="${value%\"}"; value="${value#\"}"
  fi
  printf '%s' "${value:-$default}"
}

die() { echo "error: $*" >&2; exit 1; }

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed"
  docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
}

human_size() {
  local bytes="$1"
  if command -v numfmt >/dev/null 2>&1; then numfmt --to=iec --suffix=B "$bytes"; else echo "${bytes}B"; fi
}
