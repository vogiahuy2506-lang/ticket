#!/bin/bash
#
# Starts the Docker stack and frees the ports it needs first.
#
# Why: a previous clone of this repo is often still running on the same
# machine. Docker keeps those containers alive after the terminal is closed,
# so `docker compose up` fails with
#
#   Bind for 0.0.0.0:55432 failed: port is already allocated
#
# This script stops the containers that hold the ports before starting the
# stack, which is safe: they are throwaway demo containers. It also stops a
# host-run server that holds the same ports, because Docker cannot publish
# a port that is already taken:
#
#   ports are not available: exposing port TCP 0.0.0.0:3000: bind:
#   address already in use
#
# The two ways of running the app (the Docker stack and `npm run dev` on
# the host) are mutually exclusive - they want the same ports.
#
# Usage:
#   ./scripts/dev.sh
#
set -euo pipefail
cd "$(cd "$(dirname "$0")/.." && pwd)"

# Read the ports from .env so the script follows the configuration.
DB_PORT="$(sed -n 's/^DB_PORT=\([0-9]*\).*/\1/p' .env 2>/dev/null || true)"
API_PORT="$(sed -n 's/^API_PORT=\([0-9]*\).*/\1/p' .env 2>/dev/null || true)"
WEB_PORT="$(sed -n 's/^WEB_PORT=\([0-9]*\).*/\1/p' .env 2>/dev/null || true)"

DB_PORT="${DB_PORT:-55432}"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3000}"

echo "==> Looking for containers holding ports $DB_PORT, $API_PORT, $WEB_PORT"

# `docker ps --format` prints the port mapping as "0.0.0.0:3101->3001/tcp",
# so matching the published port is a matter of grepping for ":PORT->".
running="$(docker ps --format '{{.ID}}|{{.Names}}|{{.Ports}}' 2>/dev/null || true)"

for port in "$DB_PORT" "$API_PORT" "$WEB_PORT"; do
  ids="$(printf '%s\n' "$running" | grep -F ":$port->" | cut -d'|' -f1 || true)"
  if [ -n "$ids" ]; then
    names="$(printf '%s\n' "$running" | grep -F ":$port->" | cut -d'|' -f2 | tr '\n' ' ')"
    echo "    stopping (port $port): $names"
    # shellcheck disable=SC2086
    docker rm -f $ids >/dev/null
  fi
done

# A host-run server (`npm run dev`) holds the very same ports. Docker cannot
# publish a port that is already taken, and the failure reads like a Docker
# problem ("ports are not available ... address already in use") even though
# the cause is a leftover `next dev` on the host. So the host processes are
# stopped too - the two ways of running the app are mutually exclusive.
for port in "$API_PORT" "$WEB_PORT"; do
  pids="$(lsof -ti "tcp:$port" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then
    echo "    stopping local process(es) on port $port: $pids"
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

echo "==> Starting the stack"
docker compose up --build

echo ""
echo "Storefront: http://localhost:${WEB_PORT}"
echo "API:       http://localhost:${API_PORT}"
echo ""
echo "The end-to-end money flow:"
echo "  docker compose exec api npm run e2e"
