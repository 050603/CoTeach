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
BACKUP_STAGING_DIR="${BACKUP_STAGING_DIR:-/staging/manual-essential}"

read_secret() {
  secret_path="$1"
  if [ ! -r "$secret_path" ] || [ ! -s "$secret_path" ]; then
    printf 'Required secret is missing or empty: %s\n' "$secret_path" >&2
    exit 1
  fi
  tr -d '\r\n' < "$secret_path"
}

: "${RESTIC_REPOSITORY:?RESTIC_REPOSITORY is required}"
: "${AWS_DEFAULT_REGION:?AWS_DEFAULT_REGION is required}"
: "${MANUAL_BACKUP_OFFERING_ID:?Set MANUAL_BACKUP_OFFERING_ID to the formal course offering UUID}"

case "$MANUAL_BACKUP_OFFERING_ID" in
  ????????-????-????-????-????????????) ;;
  *) printf 'MANUAL_BACKUP_OFFERING_ID must be a UUID\n' >&2; exit 2 ;;
esac

export AWS_ACCESS_KEY_ID="$(read_secret "$S3_ACCESS_KEY_FILE")"
export AWS_SECRET_ACCESS_KEY="$(read_secret "$S3_SECRET_KEY_FILE")"
export RESTIC_PASSWORD_FILE
export PGPASSWORD="$(read_secret "$POSTGRES_PASSWORD_FILE")"

restic_repo() {
  restic \
    -o s3.bucket-lookup=dns \
    -o "s3.region=$AWS_DEFAULT_REGION" \
    "$@"
}

psql_base() {
  psql \
    --host="$POSTGRES_HOST" \
    --port="$POSTGRES_PORT" \
    --username="$POSTGRES_USER" \
    --dbname="$POSTGRES_DB" \
    --no-password \
    --set=ON_ERROR_STOP=1 \
    "$@"
}

offering_summary="$(psql_base --tuples-only --no-align --field-separator='|' --command="
  SELECT o.name,
         count(DISTINCT e.id),
         count(DISTINCT e.id) FILTER (WHERE u.role = 'STUDENT'),
         count(DISTINCT a.id) FILTER (
           WHERE c.position = (SELECT min(first_chapter.position) FROM \"Chapter\" first_chapter WHERE first_chapter.\"offeringId\" = o.id)
             AND a.type = 'FORM'
         )
  FROM \"CourseOffering\" o
  LEFT JOIN \"Enrollment\" e ON e.\"offeringId\" = o.id
  LEFT JOIN \"User\" u ON u.id = e.\"userId\"
  LEFT JOIN \"Chapter\" c ON c.\"offeringId\" = o.id
  LEFT JOIN \"Activity\" a ON a.\"chapterId\" = c.id
  WHERE o.id = '$MANUAL_BACKUP_OFFERING_ID'
  GROUP BY o.id, o.name;")"

if [ -z "$offering_summary" ]; then
  printf 'Formal course offering does not exist: %s\n' "$MANUAL_BACKUP_OFFERING_ID" >&2
  exit 2
fi

offering_name="${offering_summary%%|*}"
summary_tail="${offering_summary#*|}"
enrollment_count="${summary_tail%%|*}"
summary_tail="${summary_tail#*|}"
student_count="${summary_tail%%|*}"
form_count="${summary_tail##*|}"

if [ "$enrollment_count" -ne "$student_count" ]; then
  printf 'The formal course has non-student enrollments; refusing an ambiguous backup\n' >&2
  exit 2
fi
if [ "$form_count" -ne 1 ]; then
  printf 'Expected exactly one FORM in the first chapter, found %s\n' "$form_count" >&2
  exit 2
fi

next_dir="$BACKUP_STAGING_DIR/next"
current_dir="$BACKUP_STAGING_DIR/current"
rm -rf "$next_dir"
mkdir -p "$next_dir/data"

pg_dump \
  --schema-only \
  --no-owner \
  --no-privileges \
  --host="$POSTGRES_HOST" \
  --port="$POSTGRES_PORT" \
  --username="$POSTGRES_USER" \
  --file="$next_dir/schema.sql" \
  "$POSTGRES_DB"
# Newer pg_dump patch releases emit psql client guards that older PostgreSQL
# 16 clients do not recognize. They do not affect the schema or its integrity.
sed -i '/^\\restrict /d; /^\\unrestrict /d' "$next_dir/schema.sql"

psql_base <<SQL
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
\copy (SELECT * FROM "_prisma_migrations" ORDER BY finished_at, id) TO '$next_dir/data/_prisma_migrations.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT u.* FROM "User" u JOIN "Enrollment" e ON e."userId" = u.id WHERE e."offeringId" = '$MANUAL_BACKUP_OFFERING_ID' AND u.role = 'STUDENT' ORDER BY u.id) TO '$next_dir/data/User.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT o.* FROM "CourseOffering" o WHERE o.id = '$MANUAL_BACKUP_OFFERING_ID') TO '$next_dir/data/CourseOffering.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT e.* FROM "Enrollment" e JOIN "User" u ON u.id = e."userId" WHERE e."offeringId" = '$MANUAL_BACKUP_OFFERING_ID' AND u.role = 'STUDENT' ORDER BY e.id) TO '$next_dir/data/Enrollment.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT c.* FROM "Chapter" c WHERE c."offeringId" = '$MANUAL_BACKUP_OFFERING_ID' AND c.position = (SELECT min(first_chapter.position) FROM "Chapter" first_chapter WHERE first_chapter."offeringId" = '$MANUAL_BACKUP_OFFERING_ID') ORDER BY c.id) TO '$next_dir/data/Chapter.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT a.* FROM "Activity" a JOIN "Chapter" c ON c.id = a."chapterId" WHERE c."offeringId" = '$MANUAL_BACKUP_OFFERING_ID' AND c.position = (SELECT min(first_chapter.position) FROM "Chapter" first_chapter WHERE first_chapter."offeringId" = '$MANUAL_BACKUP_OFFERING_ID') AND a.type = 'FORM' ORDER BY a.id) TO '$next_dir/data/Activity.csv' WITH (FORMAT csv, HEADER true)
\copy (SELECT s.* FROM "ActivitySubmission" s JOIN "Enrollment" e ON e.id = s."enrollmentId" JOIN "Activity" a ON a.id = s."activityId" JOIN "Chapter" c ON c.id = a."chapterId" WHERE e."offeringId" = '$MANUAL_BACKUP_OFFERING_ID' AND c."offeringId" = '$MANUAL_BACKUP_OFFERING_ID' AND c.position = (SELECT min(first_chapter.position) FROM "Chapter" first_chapter WHERE first_chapter."offeringId" = '$MANUAL_BACKUP_OFFERING_ID') AND a.type = 'FORM' ORDER BY s."submittedAt", s.id) TO '$next_dir/data/ActivitySubmission.csv' WITH (FORMAT csv, HEADER true)
COMMIT;
SQL

submission_count="$(psql_base --tuples-only --no-align --command="
  SELECT count(*)
  FROM \"ActivitySubmission\" s
  JOIN \"Enrollment\" e ON e.id = s.\"enrollmentId\"
  JOIN \"Activity\" a ON a.id = s.\"activityId\"
  JOIN \"Chapter\" c ON c.id = a.\"chapterId\"
  WHERE e.\"offeringId\" = '$MANUAL_BACKUP_OFFERING_ID'
    AND c.\"offeringId\" = '$MANUAL_BACKUP_OFFERING_ID'
    AND c.position = (SELECT min(first_chapter.position) FROM \"Chapter\" first_chapter WHERE first_chapter.\"offeringId\" = '$MANUAL_BACKUP_OFFERING_ID')
    AND a.type = 'FORM';")"

cat > "$next_dir/restore-data.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
\copy "_prisma_migrations" FROM 'data/_prisma_migrations.csv' WITH (FORMAT csv, HEADER true)
\copy "User" FROM 'data/User.csv' WITH (FORMAT csv, HEADER true)
\copy "CourseOffering" FROM 'data/CourseOffering.csv' WITH (FORMAT csv, HEADER true)
\copy "Enrollment" FROM 'data/Enrollment.csv' WITH (FORMAT csv, HEADER true)
\copy "Chapter" FROM 'data/Chapter.csv' WITH (FORMAT csv, HEADER true)
\copy "Activity" FROM 'data/Activity.csv' WITH (FORMAT csv, HEADER true)
\copy "ActivitySubmission" FROM 'data/ActivitySubmission.csv' WITH (FORMAT csv, HEADER true)
COMMIT;
SQL

cat > "$next_dir/RESTORE.txt" <<'EOF'
Restore into a new, empty PostgreSQL database only.

1. Change to this directory.
2. Run: psql --set=ON_ERROR_STOP=1 --file=schema.sql "$DATABASE_URL"
3. Run: psql --set=ON_ERROR_STOP=1 --file=restore-data.sql "$DATABASE_URL"

The archive intentionally contains only formal-course student accounts,
the minimum course structure required by foreign keys, and first-chapter
FORM submissions. It is not a full production restore.
EOF

{
  printf 'created_at=%s\n' "$(date -u +%FT%TZ)"
  printf 'backup_scope=formal-student-accounts-and-first-chapter-form\n'
  printf 'offering_id=%s\n' "$MANUAL_BACKUP_OFFERING_ID"
  printf 'offering_name=%s\n' "$offering_name"
  printf 'student_accounts=%s\n' "$student_count"
  printf 'enrollments=%s\n' "$enrollment_count"
  printf 'form_activities=%s\n' "$form_count"
  printf 'form_submissions=%s\n' "$submission_count"
} > "$next_dir/manifest.txt"

(cd "$next_dir" && sha256sum schema.sql restore-data.sql data/*.csv > SHA256SUMS)
rm -rf "$current_dir"
mv "$next_dir" "$current_dir"

if ! restic_repo snapshots >/dev/null 2>&1; then
  restic_repo init
fi

restic_repo backup "$current_dir" \
  --host openpbl-manual \
  --tag formal-students \
  --tag first-chapter-form

restic_repo check
printf 'Manual essential backup completed: %s students, %s submissions\n' "$student_count" "$submission_count"
rm -rf "$current_dir"
