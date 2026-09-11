"""Exercise the backup runner without contacting PostgreSQL or object storage."""

import os
from pathlib import Path
import subprocess
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[2] / "deploy/backup/backup-runner.sh"


class BackupRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.bin_dir = self.root / "bin"
        self.bin_dir.mkdir()
        self.log = self.root / "commands.log"
        self.uploads = self.root / "uploads"
        self.classrooms = self.root / "classrooms"
        self.whiteboards = self.root / "whiteboards"
        self.staging = self.root / "staging"
        self.status = self.root / "status"
        for directory in (self.uploads, self.classrooms, self.whiteboards):
            directory.mkdir()
        (self.uploads / "submission.txt").write_text("answer")
        (self.classrooms / "lesson.json").write_text("{}")
        (self.classrooms / "generated-lesson/audio").mkdir(parents=True)
        (self.classrooms / "generated-lesson/audio/line.wav").write_bytes(b"generated-audio")
        (self.classrooms / "generated-lesson.json").write_text(
            '{"scenes":[{"actions":[{"id":"line","type":"speech",'
            '"text":"recover me","audioId":"tts_s0_line",'
            '"audioUrl":"/api/openmaic/classroom-media/generated-lesson/audio/line.wav"}]}]}'
        )

        secrets = self.root / "secrets"
        secrets.mkdir()
        for name, value in {
            "s3_access_key": "test-key",
            "s3_secret_key": "test-secret",
            "restic_password": "test-restic-password",
            "postgres_password": "test-postgres-password",
        }.items():
            (secrets / name).write_text(value)
        self.secrets = secrets

        fake = """#!/bin/sh
set -eu
name=${0##*/}
printf '%s %s\\n' "$name" "$*" >> "$TEST_LOG"
case "$name" in
  restic)
    case " $* " in
      *" snapshots "*) exit "${SNAPSHOT_EXIT:-0}" ;;
      *" backup "*) exit "${BACKUP_EXIT:-0}" ;;
    esac
    ;;
  pg_dump)
    if [ "${1:-}" = "--version" ]; then echo 'pg_dump (PostgreSQL) 16.test'; exit 0; fi
    for argument in "$@"; do
      case "$argument" in --file=*) output=${argument#--file=} ;; esac
    done
    printf 'mock dump' > "$output"
    ;;
  pg_restore) test -s "${2:-${1:-}}" ;;
  flock) exit 0 ;;
  sqlite3) exit 0 ;;
  psql) [ -z "${PSQL_OUTPUT:-}" ] || printf '%s\n' "$PSQL_OUTPUT"; exit 0 ;;
esac
"""
        for command in ("restic", "pg_dump", "pg_restore", "flock", "sqlite3", "psql"):
            executable = self.bin_dir / command
            executable.write_text(fake)
            executable.chmod(0o755)

        jq = self.bin_dir / "jq"
        jq.write_text("""#!/usr/bin/env python3
import json
import sys

prefix = sys.argv[sys.argv.index("prefix") + 1]
with open(sys.argv[-1], encoding="utf-8") as handle:
    data = json.load(handle)
actions = [
    action
    for scene in data.get("scenes", [])
    for action in scene.get("actions", [])
    if action.get("type") == "speech"
]
recoverable = sum(
    1 for action in actions
    if (str(action.get("audioUrl", "")).startswith(prefix) or str(action.get("audioId", "")).startswith("tts_"))
    and str(action.get("text", "")).strip()
)
nonrecoverable = sum(
    1 for value in (
        [item for action in actions for item in [str(action.get("audioUrl", ""))]]
        + [
            value
            for scene in data.get("scenes", [])
            for value in scene.values()
            if isinstance(value, str)
        ]
    )
    if value.startswith(prefix)
    and not any(
        str(action.get("audioUrl", "")) == value and str(action.get("text", "")).strip()
        for action in actions
    )
)
print(f"{recoverable}\\t{nonrecoverable}")
""")
        jq.chmod(0o755)

        self.env = {
            **os.environ,
            "PATH": f"{self.bin_dir}:{os.environ['PATH']}",
            "TEST_LOG": str(self.log),
            "RESTIC_REPOSITORY": "s3:https://example.invalid/test/repository",
            "AWS_DEFAULT_REGION": "test-region",
            "S3_ACCESS_KEY_FILE": str(secrets / "s3_access_key"),
            "S3_SECRET_KEY_FILE": str(secrets / "s3_secret_key"),
            "RESTIC_PASSWORD_FILE": str(secrets / "restic_password"),
            "POSTGRES_PASSWORD_FILE": str(secrets / "postgres_password"),
            "BACKUP_UPLOADS_DIR": str(self.uploads),
            "BACKUP_CLASSROOMS_DIR": str(self.classrooms),
            "BACKUP_WHITEBOARDS_DIR": str(self.whiteboards),
            "BACKUP_STAGING_DIR": str(self.staging),
            "BACKUP_STATUS_DIR": str(self.status),
            "BACKUP_INTERVAL_SECONDS": "600",
            "BACKUP_RUN_ONCE": "true",
        }

    def run_backup(self, **environment):
        return subprocess.run(
            ["sh", str(SCRIPT)],
            env={**self.env, **environment},
            text=True,
            capture_output=True,
        )

    def test_success_creates_dump_uploads_snapshot_and_marks_status(self):
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.staging / "current/database/openpbl.dump").is_file())
        self.assertTrue((self.status / "backup.last-success.epoch").is_file())
        calls = self.log.read_text()
        self.assertIn("pg_dump --format=custom", calls)
        self.assertIn("restic -o s3.bucket-lookup=dns", calls)
        self.assertIn("backup", calls)
        self.assertIn("--exclude-file=", calls)
        excludes = (self.staging / "current/recovery/restic-excludes.txt").read_text()
        self.assertIn(str(self.classrooms / "generated-lesson/audio"), excludes)
        queue = (self.staging / "current/recovery/classroom-tts.tsv").read_text()
        self.assertIn("generated-lesson\t1\t1\t15", queue)
        manifest = (self.staging / "current/manifest.txt").read_text()
        self.assertIn("asset_backup_policy=source-plus-recipes", manifest)
        self.assertIn("regenerable_bytes_omitted=15", manifest)

    def test_operator_can_request_a_full_asset_backup(self):
        result = self.run_backup(BACKUP_INCLUDE_REGENERABLE_ASSETS="true")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertNotIn("--exclude-file=", calls)
        manifest = (self.staging / "current/manifest.txt").read_text()
        self.assertIn("asset_backup_policy=full", manifest)

    def test_audio_without_source_text_falls_back_to_full_backup(self):
        (self.classrooms / "generated-lesson.json").write_text(
            '{"scenes":[{"actions":[{"id":"line","type":"speech",'
            '"text":"","audioUrl":"/api/openmaic/classroom-media/generated-lesson/audio/line.wav"}]}]}'
        )
        result = self.run_backup()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("--exclude-file=", self.log.read_text())
        self.assertNotIn(
            "generated-lesson\t",
            (self.staging / "current/recovery/classroom-tts.tsv").read_text(),
        )

    def test_regenerable_upload_is_omitted_only_when_its_source_exists(self):
        (self.uploads / "source.pptx").write_text("source")
        (self.uploads / "preview.pdf").write_text("preview")
        result = self.run_backup(
            PSQL_OUTPUT="preview-id\tpreview.pdf\tsource.pptx\tpresentation-to-pdf"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        excludes = (self.staging / "current/recovery/restic-excludes.txt").read_text()
        self.assertIn(str(self.uploads / "preview.pdf"), excludes)
        queue = (self.staging / "current/recovery/derived-uploads.tsv").read_text()
        self.assertIn("preview-id\tpreview.pdf\tsource.pptx\tpresentation-to-pdf", queue)

    def test_failed_upload_does_not_mark_success(self):
        result = self.run_backup(BACKUP_EXIT="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.status / "backup.last-success.epoch").exists())

    def test_missing_source_fails_before_upload(self):
        result = self.run_backup(BACKUP_UPLOADS_DIR=str(self.root / "missing"))
        self.assertNotEqual(result.returncode, 0)
        calls = self.log.read_text()
        self.assertNotIn(" backup ", calls)


if __name__ == "__main__":
    unittest.main()
