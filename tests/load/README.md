# CoTeach cloud load tests

Do not run `target`, `stress`, or `soak` on a developer laptop. Run the suite
from a temporary machine in the same region as the candidate server.

Before testing, set the candidate deployment to:

- `ENABLE_LOAD_TEST_API=true`
- `LOAD_TEST_CLIENT_IP=<load-generator-public-IP>`

Then recreate the active application container and Nginx. Export `BASE_URL`,
`LOAD_TEST_ADMIN_TOKEN`, `GIT_SHA`, `IMAGE_VERSION`, and `SERVER_SPECS`.

Commands:

- `docker compose -f tests/load/docker-compose.yml run --rm smoke`
- `docker compose -f tests/load/docker-compose.yml run --rm target`
- `docker compose -f tests/load/docker-compose.yml run --rm stress`
- `docker compose -f tests/load/docker-compose.yml run --rm soak`

Each run creates one isolated teacher account per configured teacher VU plus a
UUID-owned course, joins isolated students, and exercises distinct teacher
sessions concurrently against that classroom. It tests
login/state/presence/submission/teacher writes/upload/WebSocket replay,
checks duplicate request acknowledgements and event ordering, then deletes
only that run's course, students, uploads, and run-prefixed teacher accounts.
Reports are written under `tests/load/reports/`.

To stream k6 metrics to a Prometheus remote-write endpoint, add
`-o experimental-prometheus-rw` to the k6 command and provide the standard
`K6_PROMETHEUS_RW_*` environment variables. External AI, speech, and search
providers are intentionally absent from the capacity workload.

After testing, set `ENABLE_LOAD_TEST_API=false`, recreate the active app, and
verify that `/api/load-test/runs` returns 404.
