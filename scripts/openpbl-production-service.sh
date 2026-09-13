#!/bin/sh
set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
SECRET_DIR="${OPENPBL_SECRET_DIR:-$PROJECT_ROOT/deploy/secrets}"
APP_PORT="${OPENPBL_PORT:-3000}"
RUNNER_PORT="${OPENPBL_CODE_RUNNER_PORT:-3002}"

read_secret() {
  secret_path="$SECRET_DIR/$1"
  if [ ! -r "$secret_path" ] || [ ! -s "$secret_path" ]; then
    echo "CoTeach 配置文件不可读或为空：$secret_path" >&2
    exit 1
  fi
  tr -d '\r\n' < "$secret_path"
}

wait_for_tcp() {
  dependency_name="$1"
  dependency_host="$2"
  dependency_port="$3"
  attempt=0

  while [ "$attempt" -lt 60 ]; do
    if /usr/bin/node -e '
      const net = require("node:net");
      const socket = net.connect(Number(process.argv[2]), process.argv[1]);
      socket.setTimeout(1000);
      socket.once("connect", () => { socket.end(); process.exit(0); });
      socket.once("error", () => process.exit(1));
      socket.once("timeout", () => { socket.destroy(); process.exit(1); });
    ' "$dependency_host" "$dependency_port"; then
      return 0
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -eq 1 ]; then
      echo "等待 $dependency_name（$dependency_host:$dependency_port）就绪……"
    fi
    sleep 2
  done

  echo "$dependency_name 在 120 秒内未就绪。" >&2
  return 1
}

tcp_available() {
  /usr/bin/node -e '
    const net = require("node:net");
    const socket = net.connect(Number(process.argv[2]), process.argv[1]);
    socket.setTimeout(800);
    socket.once("connect", () => { socket.end(); process.exit(0); });
    socket.once("error", () => process.exit(1));
    socket.once("timeout", () => { socket.destroy(); process.exit(1); });
  ' "$1" "$2"
}

load_shared_environment() {
  export DATABASE_URL="$(read_secret database_url.txt)"
  export JWT_SECRET="$(read_secret jwt_secret.txt)"
  export PROVIDER_ENCRYPTION_KEY="$(read_secret provider_encryption_key.txt)"
  export INTERNAL_MONITOR_TOKEN="$(read_secret monitor_token.txt)"
  export REDIS_URL="redis://127.0.0.1:16379"
  export NEXT_TELEMETRY_DISABLED="1"
}

apply_database_migrations() {
  echo "检查 PostgreSQL 数据库迁移……"
  (
    cd "$PROJECT_ROOT"
    /usr/bin/node scripts/run-prisma.mjs migrate deploy
  )
}

run_app() {
  if [ ! -f "$PROJECT_ROOT/.next-build/standalone/server.js" ]; then
    echo "未找到平台生产构建，请先运行：pnpm build" >&2
    exit 1
  fi

  load_shared_environment
  wait_for_tcp "PostgreSQL" "127.0.0.1" "15432"
  wait_for_tcp "Redis" "127.0.0.1" "16379"
  # Keep the production schema in lockstep with the Prisma Client embedded in
  # the build. `migrate deploy` is idempotent and only applies pending,
  # committed migrations; it never creates development migrations here.
  apply_database_migrations

  # DashScope returns generated images from an OSS acceleration hostname that
  # is not directly reachable on this server even though its API endpoint is.
  # Keep this proxy media-scoped: exporting HTTP_PROXY/HTTPS_PROXY here would
  # also route LLM calls through the optional local proxy, so a proxy outage
  # would disable AI companions and course text generation together.
  outbound_proxy="${OPENPBL_OUTBOUND_PROXY:-}"
  if [ -z "$outbound_proxy" ] && tcp_available "127.0.0.1" "9999"; then
    outbound_proxy="http://127.0.0.1:9999"
  fi
  if [ -n "$outbound_proxy" ]; then
    export OPENPBL_OUTBOUND_PROXY="$outbound_proxy"
  fi

  mkdir -p \
    "$PROJECT_ROOT/.openpbl-data/uploads" \
    "$PROJECT_ROOT/.openpbl-data/whiteboards"

  export PUBLIC_BASE_URL="${OPENPBL_PUBLIC_BASE_URL:-https://coteach.cn}"
  export TRUST_PROXY_HEADERS="true"
  # Keep durable generation owned by the server lifecycle so navigation or a
  # completed route response cannot terminate the task that started it.
  export COURSE_GENERATION_BACKGROUND_ENABLED="true"
  # Resource/page/media controls use the dedicated realtime channel. Durable
  # course-event polling remains enabled as a one-second outage fallback.
  export ENABLE_WEBSOCKET="true"
  export WEBSOCKET_PORT="${OPENPBL_WEBSOCKET_PORT:-3001}"
  export WEBSOCKET_HOST="${OPENPBL_WEBSOCKET_HOST:-127.0.0.1}"
  export UPLOAD_DIR="$PROJECT_ROOT/.openpbl-data/uploads"
  export WHITEBOARD_DATA_DIR="$PROJECT_ROOT/.openpbl-data/whiteboards"
  export CLASSROOM_DATA_DIR="$PROJECT_ROOT/.openpbl-data/classrooms"
  export CODE_RUNNER_URL="http://127.0.0.1:$RUNNER_PORT"
  export CODE_RUNNER_TOKEN="$INTERNAL_MONITOR_TOKEN"

  cd "$PROJECT_ROOT"
  export PORT="$APP_PORT"
  export HOSTNAME="${OPENPBL_HOSTNAME:-127.0.0.1}"
  exec /usr/bin/node scripts/run-next-production.mjs start
}

run_code_runner() {
  export CODE_RUNNER_TOKEN="$(read_secret monitor_token.txt)"
  export CODE_RUNNER_HOST="127.0.0.1"
  export CODE_RUNNER_PORT="$RUNNER_PORT"

  cd "$PROJECT_ROOT"
  exec /usr/bin/node scripts/code-runner-server.mjs
}

run_survey_nlp() {
  export HANLP_HOME="$PROJECT_ROOT/.openpbl-runtime/nlp-models"
  export OPENPBL_NLP_MODEL_PATH="$HANLP_HOME/coarse_electra_small_20220616_012050"
  nlp_python="${OPENPBL_NLP_PYTHON:-$PROJECT_ROOT/.openpbl-runtime/nlp-venv/bin/python}"
  cd "$PROJECT_ROOT"
  exec "$nlp_python" scripts/survey-nlp-server.py
}

cleanup_data() {
  load_shared_environment
  wait_for_tcp "PostgreSQL" "127.0.0.1" "15432"
  export UPLOAD_DIR="$PROJECT_ROOT/.openpbl-data/uploads"
  export CLASSROOM_DATA_DIR="$PROJECT_ROOT/.openpbl-data/classrooms"
  cd "$PROJECT_ROOT"
  exec /usr/local/bin/pnpm exec tsx scripts/cleanup-storage.ts
}

rehydrate_data() {
  load_shared_environment
  wait_for_tcp "PostgreSQL" "127.0.0.1" "15432"
  export UPLOAD_DIR="$PROJECT_ROOT/.openpbl-data/uploads"
  export CLASSROOM_DATA_DIR="$PROJECT_ROOT/.openpbl-data/classrooms"
  cd "$PROJECT_ROOT"
  exec /usr/local/bin/pnpm exec tsx scripts/rehydrate-storage.ts "$@"
}

case "${1:-}" in
  run-app)
    run_app
    ;;
  run-code-runner)
    run_code_runner
    ;;
  run-survey-nlp)
    run_survey_nlp
    ;;
  cleanup-data)
    cleanup_data
    ;;
  rehydrate-data)
    shift
    rehydrate_data "$@"
    ;;
  *)
    echo "用法：$0 {run-app|run-code-runner|run-survey-nlp|cleanup-data|rehydrate-data [参数]}" >&2
    exit 2
    ;;
esac
