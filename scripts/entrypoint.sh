#!/bin/sh
# Container entrypoint: SERVICE_ROLE selects the process (api is the default).
# exec hands PID 1 to node so SIGTERM reaches the graceful-shutdown handler.
set -e
case "${SERVICE_ROLE:-api}" in
  api)     exec node apps/api/dist/main.js ;;
  worker)  exec node apps/worker/dist/main.js ;;
  migrate) exec node packages/db/dist/cli.js migrate ;;
  *) echo "Unknown SERVICE_ROLE: $SERVICE_ROLE (expected api, worker or migrate)" >&2; exit 2 ;;
esac
