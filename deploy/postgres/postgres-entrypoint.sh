#!/bin/sh
set -eu

if [ "${PGBACKREST_ENABLED:-false}" = "true" ]; then
  /usr/local/bin/openpbl-configure-pgbackrest
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
