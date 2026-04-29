#!/usr/bin/env sh
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

echo "[entrypoint] Waiting for Postgres..."
ATTEMPTS=0
MAX_ATTEMPTS=60
until pg_isready -d "$DATABASE_URL" -q; do
  ATTEMPTS=$((ATTEMPTS+1))
  if [ "$ATTEMPTS" -ge "$MAX_ATTEMPTS" ]; then
    echo "[entrypoint] Postgres not reachable after ${MAX_ATTEMPTS}s — aborting." >&2
    exit 1
  fi
  sleep 1
done
echo "[entrypoint] Postgres is ready."

if [ "${RUN_MIGRATIONS_ON_BOOT:-true}" = "true" ]; then
  echo "[entrypoint] Running migrations from /app/migrations..."
  for f in /app/migrations/*.sql; do
    [ -f "$f" ] || continue
    echo "[entrypoint]   applying $(basename "$f")"
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f "$f"
  done
  echo "[entrypoint] Migrations complete."
else
  echo "[entrypoint] RUN_MIGRATIONS_ON_BOOT=false — skipping migrations."
fi

exec "$@"
