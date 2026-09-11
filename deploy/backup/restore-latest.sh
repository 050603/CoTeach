#!/bin/sh
set -eu

umask 077

export AWS_ACCESS_KEY_ID="$(tr -d '\r\n' < /run/secrets/s3_access_key)"
export AWS_SECRET_ACCESS_KEY="$(tr -d '\r\n' < /run/secrets/s3_secret_key)"
export RESTIC_PASSWORD_FILE=/run/secrets/restic_password

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"

restic_repo() {
  restic -o s3.bucket-lookup=dns -o "s3.region=$AWS_DEFAULT_REGION" "$@"
}

mkdir -p /restore
restic_repo restore latest \
  --host openpbl-production \
  --tag openpbl-production \
  --target /restore

dump_file=/restore/staging/current/database/openpbl.dump
manifest_file=/restore/staging/current/manifest.txt
recovery_dir=/restore/staging/current/recovery
test -s "$dump_file"
pg_restore --list "$dump_file" >/dev/null
test -d /restore/data/uploads
test -d /restore/data/classrooms
test -s "$manifest_file"
test -r "$recovery_dir/classroom-tts.tsv"
test -r "$recovery_dir/derived-uploads.tsv"
grep -Eq '^asset_backup_policy=(source-plus-recipes|full)$' "$manifest_file"
omitted_bytes="$(sed -n 's/^regenerable_bytes_omitted=//p' "$manifest_file")"
printf 'Latest encrypted snapshot restored and validated (regenerable bytes omitted: %s).\n' "${omitted_bytes:-0}"
