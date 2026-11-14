#!/usr/bin/env bash
# Starts (or reuses) a local PostgreSQL 18 container for development and tests.
# Uses podman, or docker if podman isn't installed. Data lives in the container;
# `scripts/dev-db.sh reset` deletes it.
set -euo pipefail

NAME=j26-pg
PORT=${J26_PG_PORT:-55432}
IMAGE=docker.io/library/postgres:18-alpine
ENGINE=$(command -v podman || command -v docker || true)
[ -n "$ENGINE" ] || { echo "Install podman or docker first." >&2; exit 1; }

if [ "${1:-}" = "reset" ]; then
  "$ENGINE" rm -f "$NAME" >/dev/null 2>&1 || true
fi

if ! "$ENGINE" container exists "$NAME" 2>/dev/null && ! "$ENGINE" inspect "$NAME" >/dev/null 2>&1; then
  "$ENGINE" run -d --name "$NAME" \
    -e POSTGRES_USER=j26 -e POSTGRES_PASSWORD=dev -e POSTGRES_DB=j26 \
    -p "127.0.0.1:${PORT}:5432" "$IMAGE" >/dev/null
else
  "$ENGINE" start "$NAME" >/dev/null
fi

for _ in $(seq 1 30); do
  "$ENGINE" exec "$NAME" pg_isready -U j26 -d j26 >/dev/null 2>&1 && break
  sleep 1
done
"$ENGINE" exec "$NAME" pg_isready -U j26 -d j26 >/dev/null

cat <<MSG
PostgreSQL is ready.
  DATABASE_URL=postgres://j26:dev@127.0.0.1:${PORT}/j26
  TEST_DATABASE_URL=postgres://j26:dev@127.0.0.1:${PORT}/postgres
MSG
