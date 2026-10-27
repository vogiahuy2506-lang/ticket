#!/bin/bash
# Local dev runner: starts the API and the web app, waits for them, then runs
# whatever command was passed in. Used to verify the app end to end.
set -e
cd "$(dirname "$0")/.."

# Defaults match the compose stack: the database is the one published by
# `docker compose up -d db` on DB_PORT (55432), and the apps listen on the
# same ports the compose services are published on. Override any of them
# with an environment variable if the ports are taken.
DB_URL="${DB_URL:-postgres://postgres:postgres@127.0.0.1:55432/tickets}"
API_PORT="${API_PORT:-3101}"
WEB_PORT="${WEB_PORT:-3000}"

cleanup() {
  kill ${API_PID:-} ${WEB_PID:-} 2>/dev/null || true
  pkill -P $$ 2>/dev/null || true
}
trap cleanup EXIT

(cd apps/api && DATABASE_URL="$DB_URL" npx tsx src/db/init.ts >/tmp/tce-api-init.log 2>&1)
(cd apps/api && DATABASE_URL="$DB_URL" MOCK_GATEWAY=true PORT="$API_PORT" \
  PUBLIC_BASE_URL="http://127.0.0.1:$API_PORT" WEB_BASE_URL="http://127.0.0.1:$WEB_PORT" \
  npx tsx src/main.ts >/tmp/tce-api.log 2>&1) &
API_PID=$!

(cd apps/web && API_BASE_URL="http://127.0.0.1:$API_PORT" npx next dev -p "$WEB_PORT" >/tmp/tce-web.log 2>&1) &
WEB_PID=$!

for i in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:$API_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "http://127.0.0.1:$WEB_PORT/" 2>/dev/null; then break; fi
  sleep 1
done

"$@"
status=$?
exit $status
