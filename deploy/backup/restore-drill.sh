#!/bin/sh
set -eu

: "${CONFIRM_RESTORE_DRILL:?Set CONFIRM_RESTORE_DRILL=openpbl-restore-drill-data}"
if [ "$CONFIRM_RESTORE_DRILL" != "openpbl-restore-drill-data" ]; then
  echo "Confirmation must exactly match openpbl-restore-drill-data." >&2
  exit 64
fi

ROOT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
ENV_FILE="$ROOT_DIR/deploy/.deploy.env"
COMPOSE_FILE="$ROOT_DIR/docker-compose.prod.yml"
COMPOSE_OVERRIDE_FILE="${OPENPBL_COMPOSE_OVERRIDE_FILE:-$ROOT_DIR/docker-compose.ip.yml}"
DRILL_VOLUME="openpbl-restore-drill-data"
INPUT_VOLUME="openpbl-restore-drill-input"
COMPOSE_PROJECT="${COMPOSE_PROJECT_NAME:-$(basename "$ROOT_DIR" | tr '[:upper:]' '[:lower:]')}"

compose() {
  if [ -n "$COMPOSE_OVERRIDE_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$COMPOSE_OVERRIDE_FILE" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  fi
}

compose --profile restore-drill stop restore-drill-db >/dev/null 2>&1 || true
compose --profile restore-drill rm -sf restore-drill-db >/dev/null 2>&1 || true
for volume in "$DRILL_VOLUME" "$INPUT_VOLUME"; do
  docker volume inspect "$volume" >/dev/null 2>&1 && docker volume rm "$volume" >/dev/null
  case "$volume" in
    "$DRILL_VOLUME") compose_volume=restore-drill-data ;;
    "$INPUT_VOLUME") compose_volume=restore-drill-input ;;
  esac
  docker volume create \
    --label "com.docker.compose.project=$COMPOSE_PROJECT" \
    --label "com.docker.compose.volume=$compose_volume" \
    "$volume" >/dev/null
done

compose --profile restore-drill run --rm restore-files
compose --profile restore-drill up -d restore-drill-db
drill_db_started=true
cleanup_drill() {
  if [ "${drill_db_started:-false}" = "true" ]; then
    compose --profile restore-drill stop restore-drill-db >/dev/null 2>&1 || true
  fi
}
trap cleanup_drill EXIT INT TERM

attempt=0
until compose exec -T restore-drill-db pg_isready -U openpbl -d openpbl >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 24 ]; then
    echo "Restored database did not become ready." >&2
    compose --profile restore-drill stop restore-drill-db
    exit 1
  fi
  sleep 5
done

compose exec -T restore-drill-db pg_restore \
  --exit-on-error \
  --clean \
  --if-exists \
  --no-owner \
  --no-privileges \
  --username openpbl \
  --dbname openpbl \
  /restore/staging/current/database/openpbl.dump

job_count="$(compose exec -T restore-drill-db \
  psql -U openpbl -d openpbl -Atc 'select count(*) from "GenerationJob";')"
migration_count="$(compose exec -T restore-drill-db \
  psql -U openpbl -d openpbl -Atc 'select count(*) from "_prisma_migrations" where finished_at is not null;')"
uploads_count="$(compose --profile restore-drill run --rm --entrypoint /bin/sh restore-files \
  -ec 'find /restore/data/uploads -type f | wc -l')"
classrooms_count="$(compose --profile restore-drill run --rm --entrypoint /bin/sh restore-files \
  -ec 'find /restore/data/classrooms -type f | wc -l')"
required_upload_rows="$(compose exec -T restore-drill-db \
  psql -U openpbl -d openpbl -AtF "$(printf '\t')" \
  -c "select id, \"storageKey\", coalesce(sha256, '') from \"FileAsset\" where \"backupPolicy\" = 'REQUIRED' and \"deletedAt\" is null order by id")"
required_uploads_verified="$(
  printf '%s\n' "$required_upload_rows" |
  compose --profile restore-drill run --rm -T --entrypoint /bin/sh restore-files -ec '
    checked=0
    while IFS="$(printf "\\t")" read -r asset_id storage_key expected_sha; do
      test -n "$asset_id" || continue
      case "$storage_key" in ""|*/*|*..*) echo "Unsafe required upload key: $asset_id" >&2; exit 1 ;; esac
      file="/restore/data/uploads/$storage_key"
      test -s "$file" || { echo "Required upload missing: $asset_id" >&2; exit 1; }
      if test -n "$expected_sha"; then
        set -- $(sha256sum "$file")
        actual_sha="$1"
        test "$actual_sha" = "$expected_sha" || { echo "Upload checksum mismatch: $asset_id" >&2; exit 1; }
      fi
      checked=$((checked + 1))
    done
    printf "%s" "$checked"
  '
)"
recovery_summary="$(compose --profile restore-drill run --rm --entrypoint /bin/sh restore-files \
  -ec '
    queue=/restore/staging/current/recovery/classroom-tts.tsv
    derived=/restore/staging/current/recovery/derived-uploads.tsv
    tts_classrooms=0
    tts_segments=0
    while IFS="$(printf "\\t")" read -r classroom_id segment_count _rest; do
      case "$classroom_id" in ""|\#*) continue ;; esac
      tts_classrooms=$((tts_classrooms + 1))
      tts_segments=$((tts_segments + segment_count))
      test -s "/restore/data/classrooms/$classroom_id.json"
      jq -e ".scenes | type == \"array\"" "/restore/data/classrooms/$classroom_id.json" >/dev/null
      test ! -d "/restore/data/classrooms/$classroom_id/audio"
    done < "$queue"
    derived_assets=0
    while IFS="$(printf "\\t")" read -r asset_id _rest; do
      case "$asset_id" in ""|\#*) continue ;; esac
      derived_assets=$((derived_assets + 1))
    done < "$derived"
    printf "%s %s %s" "$tts_classrooms" "$tts_segments" "$derived_assets"
  ')"
set -- $recovery_summary
tts_classrooms="${1:-0}"
tts_segments="${2:-0}"
derived_assets="${3:-0}"

compose --profile restore-drill stop restore-drill-db
drill_db_started=false
trap - EXIT INT TERM
mkdir -p "$ROOT_DIR/deploy/reports"
date -u +%FT%TZ > "$ROOT_DIR/deploy/reports/restore-drill.last-success"
echo "Restore drill passed: jobs=$job_count migrations=$migration_count uploads=$uploads_count required_uploads_verified=$required_uploads_verified classrooms=$classrooms_count tts_recovery_classrooms=$tts_classrooms tts_segments=$tts_segments derived_uploads=$derived_assets"
