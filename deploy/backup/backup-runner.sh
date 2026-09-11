#!/bin/sh
set -eu

umask 077

S3_ACCESS_KEY_FILE="${S3_ACCESS_KEY_FILE:-/run/secrets/s3_access_key}"
S3_SECRET_KEY_FILE="${S3_SECRET_KEY_FILE:-/run/secrets/s3_secret_key}"
RESTIC_PASSWORD_FILE="${RESTIC_PASSWORD_FILE:-/run/secrets/restic_password}"
POSTGRES_PASSWORD_FILE="${POSTGRES_PASSWORD_FILE:-/run/secrets/postgres_password}"
POSTGRES_HOST="${POSTGRES_HOST:-postgres}"
POSTGRES_PORT="${POSTGRES_PORT:-5432}"
POSTGRES_DB="${POSTGRES_DB:-openpbl}"
POSTGRES_USER="${POSTGRES_USER:-openpbl}"
BACKUP_INTERVAL_SECONDS="${BACKUP_INTERVAL_SECONDS:-600}"
BACKUP_UPLOADS_DIR="${BACKUP_UPLOADS_DIR:-/data/uploads}"
BACKUP_CLASSROOMS_DIR="${BACKUP_CLASSROOMS_DIR:-/data/classrooms}"
BACKUP_WHITEBOARDS_DIR="${BACKUP_WHITEBOARDS_DIR:-/data/whiteboards}"
BACKUP_STAGING_DIR="${BACKUP_STAGING_DIR:-/staging}"
BACKUP_STATUS_DIR="${BACKUP_STATUS_DIR:-/status}"
BACKUP_INCLUDE_REGENERABLE_ASSETS="${BACKUP_INCLUDE_REGENERABLE_ASSETS:-false}"

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"
}

read_secret() {
  secret_path="$1"
  if [ ! -r "$secret_path" ] || [ ! -s "$secret_path" ]; then
    log "Required secret is missing or empty: $secret_path" >&2
    exit 1
  fi
  tr -d '\r\n' < "$secret_path"
}

export AWS_ACCESS_KEY_ID="$(read_secret "$S3_ACCESS_KEY_FILE")"
export AWS_SECRET_ACCESS_KEY="$(read_secret "$S3_SECRET_KEY_FILE")"
export RESTIC_PASSWORD_FILE
export PGPASSWORD="$(read_secret "$POSTGRES_PASSWORD_FILE")"

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

case "$BACKUP_INTERVAL_SECONDS" in
  ''|*[!0-9]*) log "BACKUP_INTERVAL_SECONDS must be an integer" >&2; exit 2 ;;
esac
if [ "$BACKUP_INTERVAL_SECONDS" -lt 60 ]; then
  log "BACKUP_INTERVAL_SECONDS must be at least 60" >&2
  exit 2
fi
case "$BACKUP_INCLUDE_REGENERABLE_ASSETS" in
  true|false) ;;
  *) log "BACKUP_INCLUDE_REGENERABLE_ASSETS must be true or false" >&2; exit 2 ;;
esac

restic_repo() {
  restic \
    -o s3.bucket-lookup=dns \
    -o "s3.region=$AWS_DEFAULT_REGION" \
    "$@"
}

directory_stats() {
  directory="$1"
  files=0
  bytes=0
  if [ -d "$directory" ]; then
    while IFS= read -r file_path; do
      [ -n "$file_path" ] || continue
      size="$(wc -c < "$file_path")"
      files=$((files + 1))
      bytes=$((bytes + size))
    done <<EOF
$(find "$directory" -type f -print)
EOF
  fi
  printf '%s\t%s\n' "$files" "$bytes"
}

prepare_regeneration_policy() {
  snapshot_dir="$1"
  recovery_dir="$snapshot_dir/recovery"
  excludes_file="$recovery_dir/restic-excludes.txt"
  classroom_queue="$recovery_dir/classroom-tts.tsv"
  upload_queue="$recovery_dir/derived-uploads.tsv"
  stats_file="$recovery_dir/omitted-stats.tsv"
  tab="$(printf '\t')"
  mkdir -p "$recovery_dir" || return 1
  : > "$excludes_file"
  : > "$classroom_queue"
  : > "$upload_queue"
  : > "$stats_file"
  printf '# classroom_id\tspeech_segments\tomitted_files\tomitted_bytes\n' > "$classroom_queue"
  printf '# asset_id\tstorage_key\tsource_storage_key\toperation\n' > "$upload_queue"

  if [ "$BACKUP_INCLUDE_REGENERABLE_ASSETS" = "true" ]; then
    log "Including regenerable assets by operator override"
    return 0
  fi

  for audio_dir in "$BACKUP_CLASSROOMS_DIR"/*/audio; do
    [ -d "$audio_dir" ] || continue
    classroom_dir="${audio_dir%/audio}"
    classroom_id="${classroom_dir##*/}"
    classroom_json="$BACKUP_CLASSROOMS_DIR/$classroom_id.json"
    recoverable=0
    nonrecoverable=0
    if [ -f "$classroom_json" ]; then
      audio_prefix="/api/openmaic/classroom-media/$classroom_id/audio/"
      counts="$(jq -er --arg prefix "$audio_prefix" '
        [.scenes[]?.actions[]? | select(.type == "speech")] as $speech
        | [.. | strings | select(startswith($prefix))] | unique as $allLocalAudio
        | [$speech[]
            | select((((.text // "") | gsub("\\s"; "")) | length > 0))
            | (.audioUrl // "")
            | select(startswith($prefix))
          ] | unique as $recoverableLocalAudio
        | [
            ($speech | map(select(
              (((.audioUrl // "") | startswith($prefix)) or ((.audioId // "") | startswith("tts_")))
              and (((.text // "") | gsub("\\s"; "")) | length > 0)
            )) | length),
            (($allLocalAudio - $recoverableLocalAudio) | length)
          ] | @tsv
      ' "$classroom_json" 2>/dev/null)" || {
        log "Keeping audio for malformed classroom script: $classroom_id" >&2
        continue
      }
      recoverable="${counts%%"$tab"*}"
      nonrecoverable="${counts#*"$tab"}"
    fi
    if [ "$nonrecoverable" -gt 0 ]; then
      log "Keeping audio without source text: classroom=$classroom_id clips=$nonrecoverable" >&2
      continue
    fi

    # An audio directory is owned by the TTS pipeline. Unknown files in it are
    # stale cache entries, not user uploads; the classroom JSON is the recipe.
    printf '%s\n%s/**\n' "$audio_dir" "$audio_dir" >> "$excludes_file"
    stats="$(directory_stats "$audio_dir")"
    omitted_files="${stats%%"$tab"*}"
    omitted_bytes="${stats#*"$tab"}"
    printf 'classroom-tts\t%s\t%s\n' "$omitted_files" "$omitted_bytes" >> "$stats_file"
    if [ -f "$classroom_json" ] && [ "$recoverable" -gt 0 ]; then
      printf '%s\t%s\t%s\t%s\n' "$classroom_id" "$recoverable" "$omitted_files" "$omitted_bytes" >> "$classroom_queue"
    fi
  done

  derived_rows="$recovery_dir/derived-upload-candidates.tsv"
  if ! psql \
      --host="$POSTGRES_HOST" \
      --port="$POSTGRES_PORT" \
      --username="$POSTGRES_USER" \
      --dbname="$POSTGRES_DB" \
      --tuples-only --no-align --field-separator="$(printf '\t')" \
      --command="SELECT derived.id, derived.\"storageKey\", source.\"storageKey\", derived.\"regenerationRecipe\"->>'operation' FROM \"FileAsset\" derived JOIN \"FileAsset\" source ON source.id = derived.\"sourceAssetId\" WHERE derived.\"backupPolicy\" = 'REGENERATE' AND derived.\"deletedAt\" IS NULL AND source.\"deletedAt\" IS NULL ORDER BY derived.id" \
      > "$derived_rows"; then
    log "Asset lifecycle columns unavailable; all upload files will be retained" >&2
    : > "$derived_rows"
  fi
  while IFS="$(printf '\t')" read -r asset_id storage_key source_key operation; do
    [ -n "$asset_id" ] || continue
    case "$storage_key:$source_key" in
      */*|*..*) log "Keeping derived upload with unsafe storage key: $asset_id" >&2; continue ;;
    esac
    if [ "$operation" != "presentation-to-pdf" ] || [ ! -f "$BACKUP_UPLOADS_DIR/$source_key" ]; then
      log "Keeping derived upload without a usable regeneration source: $asset_id" >&2
      continue
    fi
    printf '%s\t%s\t%s\t%s\n' "$asset_id" "$storage_key" "$source_key" "$operation" >> "$upload_queue"
    if [ -f "$BACKUP_UPLOADS_DIR/$storage_key" ]; then
      bytes="$(wc -c < "$BACKUP_UPLOADS_DIR/$storage_key")"
      printf '%s\n' "$BACKUP_UPLOADS_DIR/$storage_key" >> "$excludes_file"
      printf 'derived-upload\t1\t%s\n' "$bytes" >> "$stats_file"
    fi
  done < "$derived_rows"
  rm -f "$derived_rows"
}

prepare_snapshot() {
  next_dir="$BACKUP_STAGING_DIR/next"
  current_dir="$BACKUP_STAGING_DIR/current"
  previous_dir="$BACKUP_STAGING_DIR/previous"

  rm -rf "$next_dir" || return 1
  mkdir -p "$next_dir/database" "$next_dir/whiteboards" || return 1

  log "Creating a consistent PostgreSQL dump"
  pg_dump \
    --format=custom \
    --compress=6 \
    --no-owner \
    --no-privileges \
    --host="$POSTGRES_HOST" \
    --port="$POSTGRES_PORT" \
    --username="$POSTGRES_USER" \
    --file="$next_dir/database/openpbl.dump" \
    "$POSTGRES_DB" || return 1
  pg_restore --list "$next_dir/database/openpbl.dump" >/dev/null || return 1

  if [ -d "$BACKUP_WHITEBOARDS_DIR" ]; then
    for source_db in "$BACKUP_WHITEBOARDS_DIR"/*.sqlite; do
      [ -f "$source_db" ] || continue
      file_name="${source_db##*/}"
      sqlite3 "$source_db" ".backup '$next_dir/whiteboards/$file_name'" || return 1
      sqlite3 "$next_dir/whiteboards/$file_name" 'PRAGMA quick_check;' | grep -qx ok || return 1
    done
  fi

  prepare_regeneration_policy "$next_dir" || return 1

  omitted_files="$(awk -F '\t' '{ files += $2 } END { print files + 0 }' "$next_dir/recovery/omitted-stats.tsv")"
  omitted_bytes="$(awk -F '\t' '{ bytes += $3 } END { print bytes + 0 }' "$next_dir/recovery/omitted-stats.tsv")"

  {
    printf 'created_at=%s\n' "$(date -u +%FT%TZ)"
    printf 'git_sha=%s\n' "${OPENPBL_GIT_SHA:-unknown}"
    printf 'postgres=%s\n' "$(pg_dump --version)"
    printf 'asset_backup_policy=%s\n' "$(if [ "$BACKUP_INCLUDE_REGENERABLE_ASSETS" = "true" ]; then printf full; else printf source-plus-recipes; fi)"
    printf 'regenerable_files_omitted=%s\n' "$omitted_files"
    printf 'regenerable_bytes_omitted=%s\n' "$omitted_bytes"
  } > "$next_dir/manifest.txt" || return 1

  rm -rf "$previous_dir" || return 1
  if [ -d "$current_dir" ]; then mv "$current_dir" "$previous_dir" || return 1; fi
  mv "$next_dir" "$current_dir" || return 1
  rm -rf "$previous_dir" || return 1
}

mark_success() {
  completed_epoch="$(date +%s)"
  date -u +%FT%TZ > "$BACKUP_STATUS_DIR/backup.last-success" || return 1
  printf '%s\n' "$completed_epoch" > "$BACKUP_STATUS_DIR/backup.last-success.epoch" || return 1
  for kind in postgres volumes; do
    printf 'openpbl_backup_last_success_timestamp_seconds{kind="%s"} %s\n' \
      "$kind" "$completed_epoch" > "$BACKUP_STATUS_DIR/$kind.prom.tmp" || return 1
    mv "$BACKUP_STATUS_DIR/$kind.prom.tmp" "$BACKUP_STATUS_DIR/$kind.prom" || return 1
  done
}

run_maintenance_if_due() {
  today="$(date -u +%F)"
  last_maintenance=""
  if [ -r "$BACKUP_STATUS_DIR/restic-maintenance-day" ]; then
    last_maintenance="$(cat "$BACKUP_STATUS_DIR/restic-maintenance-day")"
  fi
  [ "$last_maintenance" = "$today" ] && return 0

  log "Applying Restic retention and checking repository metadata"
  if restic_repo forget \
      --host openpbl-production \
      --tag openpbl-production \
      --keep-within 24h \
      --keep-daily 7 \
      --prune && restic_repo check; then
    printf '%s\n' "$today" > "$BACKUP_STATUS_DIR/restic-maintenance-day"
  else
    log "Restic maintenance failed; the completed backup remains available" >&2
  fi
}

run_backup() {
  for required_dir in "$BACKUP_UPLOADS_DIR" "$BACKUP_CLASSROOMS_DIR"; do
    if [ ! -d "$required_dir" ]; then
      log "Backup source directory is missing: $required_dir" >&2
      return 1
    fi
  done

  mkdir -p "$BACKUP_STAGING_DIR" "$BACKUP_STATUS_DIR" || return 1
  exec 9>"$BACKUP_STATUS_DIR/backup.lock"
  if ! flock -n 9; then
    log "Another backup is still running; skipping this interval"
    return 0
  fi

  prepare_snapshot || return 1
  log "Uploading encrypted snapshot to object storage"
  set -- backup \
    "$BACKUP_UPLOADS_DIR" \
    "$BACKUP_CLASSROOMS_DIR" \
    "$BACKUP_STAGING_DIR/current" \
    --host openpbl-production \
    --tag openpbl-production \
    --exclude-caches
  excludes_file="$BACKUP_STAGING_DIR/current/recovery/restic-excludes.txt"
  if [ -s "$excludes_file" ]; then
    set -- "$@" "--exclude-file=$excludes_file"
  fi
  restic_repo "$@" || return 1
  mark_success || return 1
  run_maintenance_if_due
  log "Backup completed"
}

if ! restic_repo snapshots >/dev/null 2>&1; then
  log "Initializing the encrypted Restic repository"
  restic_repo init
fi

while :; do
  if ! run_backup; then
    log "Backup attempt failed; the previous successful snapshot is unchanged" >&2
    if [ "${BACKUP_RUN_ONCE:-false}" = "true" ]; then exit 1; fi
  fi
  if [ "${BACKUP_RUN_ONCE:-false}" = "true" ]; then exit 0; fi
  sleep "$BACKUP_INTERVAL_SECONDS" &
  wait $!
done
