#!/bin/bash
#
# Frees the host ports the local (non-Docker) dev servers need.
#
# Why: this repo has two ways to run it.
#
#   ./scripts/dev.sh   -> the whole stack inside Docker. Docker publishes
#                         API_PORT (3101) and WEB_PORT (3000) on the host.
#   npm run dev        -> the API and the storefront run on the host, and
#                         only the database stays in Docker.
#
# Running the host servers while the Docker stack is up fails with
#
#   listen EADDRINUSE: address already in use 0.0.0.0:3101
#   Error: listen EADDRINUSE: address already in use :::3000
#
# This script releases API_PORT and WEB_PORT so the host servers can bind.
# The database port is deliberately left alone: the host servers talk to the
# very same Postgres container that `docker compose up -d db` provides.
#
# Usage:
#   ./scripts/free-ports.sh
#
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

read_port() {
  local name="$1"
  local value
  value="$(sed -n "s/^${name}=\([0-9]*\).*/\1/p" .env 2>/dev/null || true)"
  echo "${value:-}"
}

API_PORT="$(read_port API_PORT)"
WEB_PORT="$(read_port WEB_PORT)"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3000}"

echo "==> Freeing host ports $API_PORT (api) and $WEB_PORT (web)"

# 0. The host servers need Postgres. Make sure the database container is up
#    before anything else, so `npm run dev` always has a database to talk to.
if command -v docker >/dev/null 2>&1; then
  if docker compose ps --status running --services 2>/dev/null | grep -qx 'db'; then
    echo "    database container is already running"
  else
    echo "    starting database container"
    docker compose up -d db >/dev/null
  fi
fi

# 1. Docker containers publishing those ports. `docker ps --format` prints the
#    mapping as "0.0.0.0:3101->3001/tcp", so match on ":PORT->".
running="$(docker ps --format '{{.ID}}|{{.Names}}|{{.Ports}}' 2>/dev/null || true)"

for port in "$API_PORT" "$WEB_PORT"; do
  ids="$(printf '%s\n' "$running" | grep -F ":$port->" | cut -d'|' -f1 || true)"
  if [ -n "$ids" ]; then
    names="$(printf '%s\n' "$running" | grep -F ":$port->" | cut -d'|' -f2 | tr '\n' ' ')"
    echo "    stopping container(s) on port $port: $names"
    # shellcheck disable=SC2086
    docker stop $ids >/dev/null
  fi
done

# 2. Local processes still listening on those ports (a previous `npm run dev`
#    that was interrupted leaves `tsx watch` and `next dev` behind).
for port in "$API_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "    killing local process(es) on port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 1
    pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$pids" ]; then
      # shellcheck disable=SC2086
      kill -9 $pids 2>/dev/null || true
    fi
  fi
done

# 3. Report the final state so a failure is visible immediately.
sleep 1
for port in "$API_PORT" "$WEB_PORT"; do
  left="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$left" ]; then
    echo "    WARNING: port $port is still held by: $left" >&2
  else
    echo "    port $port is free"
  fi
done
