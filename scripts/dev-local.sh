#!/bin/bash
# Local dev runner: starts the API and the web app, waits for them, then runs
# whatever command was passed in. Used to verify the app end to end.
set -e
cd "$(dirname "$0")/.."

DB_URL="${DB_URL:-postgres://$(whoami)@127.0.0.1:5433/tce_local}"
API_PORT="${API_PORT:-3011}"
WEB_PORT="${WEB_PORT:-3010}"

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
