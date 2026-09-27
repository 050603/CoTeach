"""Local recovery safeguards, file integrity and 30-day WAL retention."""

import importlib.util
import contextlib
import gc
import json
import os
from pathlib import Path
import sqlite3
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
    "local_backup", Path(__file__).resolve().parents[2] / "deploy/backup/local-backup.py"
)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class LocalBackupTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.patch = patch.object(backup, "ROOT", self.root)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        project_patch = patch.object(backup, "PROJECT", self.root)
        project_patch.start()
        self.addCleanup(project_patch.stop)
        home_patch = patch.object(Path, "home", return_value=self.root)
        home_patch.start()
        self.addCleanup(home_patch.stop)
        backup.initialize_dirs()

    def test_only_completed_snapshots_are_eligible(self):
        unfinished = self.root / "snapshots/unfinished"
        unfinished.mkdir()
        completed = self.root / "snapshots/completed"
        completed.mkdir()
        backup.write_json(completed / "manifest.json", {})
        self.assertEqual(backup.snapshots(), [completed])
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)

    def test_missing_and_corrupted_database_references_fail_closed(self):
        snapshot = self.root / "snapshot"
        uploads = snapshot / "files/uploads"
        uploads.mkdir(parents=True)
        path = uploads / "submission.pdf"
        asset = {"id": "test-student-submission", "storageKey": path.name, "sha256": "incorrect"}
        with self.assertRaisesRegex(RuntimeError, "missing"):
            backup.validate_assets(snapshot, [asset])
        path.write_text("student work")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.validate_assets(snapshot, [asset])
        asset["sha256"] = backup.sha256(path)
        backup.validate_assets(snapshot, [asset])
        asset["storageKey"] = "../outside"
        with self.assertRaisesRegex(RuntimeError, "Unsafe"):
            backup.validate_assets(snapshot, [asset])

    def test_file_verification_detects_modification_even_with_same_size(self):
        snapshot = self.root / "snapshot"
        snapshot.mkdir()
        path = snapshot / "database.dump"
        path.write_text("original")
        backup.write_json(snapshot / "manifest.json", {
            "files": {path.name: {"sha256": backup.sha256(path), "size": path.stat().st_size}},
            "assets": [],
        })
        backup.verify_files(snapshot)
        path.write_text("modified")
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_files(snapshot)

    def test_retention_keeps_pre_boundary_base_and_its_wal(self):
        now = time.time()
        for number, days in enumerate((40, 31, 29, 1)):
            path = self.root / "bases" / f"base-{number}"
            path.mkdir()
            backup.write_json(path / "complete.json", {
                "completedEpoch": now - days * 86400,
                "firstWal": f"00000001000000000000000{number + 1}",
            })
        for name in ("000000010000000000000001", "000000010000000000000002",
                     "000000010000000000000001.partial", "00000002.history",
                     "000000020000000000000001"):
            (self.root / "wal" / name).touch()
        backup.prune()
        self.assertEqual([path.name for path in backup.bases()], ["base-1", "base-2", "base-3"])
        self.assertFalse((self.root / "wal/000000010000000000000001").exists())
        self.assertTrue((self.root / "wal/000000010000000000000002").exists())
        self.assertTrue((self.root / "wal/000000010000000000000001.partial").exists())
        self.assertTrue((self.root / "wal/000000020000000000000001").exists())

    def test_wal_flush_timeout_does_not_acknowledge_a_recovery_point(self):
        with patch.object(backup, "sql", return_value="f"):
            with self.assertRaisesRegex(RuntimeError, "not durably flushed"):
                backup.ensure_wal_received("0/123", timeout=0)

    def test_disk_write_failure_preserves_last_acknowledged_recovery_point(self):
        previous = {"snapshot": "previous", "startedEpoch": time.time()}
        backup.write_json(self.root / "status/last-success.json", previous)
        with patch.object(backup, "take_base", return_value=self.root / "bases/previous"), \
                patch.object(backup, "dump_consistent", return_value=({}, [])), \
                patch.object(backup, "snapshot_source", return_value={"gitHead": "test"}), \
                patch.object(backup, "snapshot_files", side_effect=OSError("No space left on device")):
            with self.assertRaises(OSError):
                backup.backup()
        self.assertEqual(json.loads((self.root / "status/last-success.json").read_text()), previous)
        self.assertEqual(backup.snapshots(), [])

    def test_queued_audit_survives_source_drain_after_outbox_copy(self):
        source = self.root / ".openpbl-data/ai-audit-outbox"
        source.mkdir(parents=True)
        event = source / "pending.json"
        event.write_text('{"requestId":"stable-request","content":"complete conversation"}')
        quarantine = source / "quarantine"
        quarantine.mkdir()
        malformed = quarantine / "malformed.json"
        malformed.write_bytes(b"{invalid original bytes")
        target = self.root / "snapshots/next"
        backup.snapshot_audit_outbox(target)
        event.unlink()
        malformed.unlink()
        self.assertEqual(json.loads((target / "files/ai-audit-outbox/pending.json").read_text())["requestId"], "stable-request")
        self.assertEqual((target / "files/ai-audit-outbox/quarantine/malformed.json").read_bytes(), b"{invalid original bytes")

    def evidence_snapshot(self, name, previous=None):
        for category in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / category).mkdir(parents=True, exist_ok=True)
        target = self.root / "snapshots" / name
        target.mkdir()
        files = backup.snapshot_files(target, previous)
        backup.write_json(target / "manifest.json", {"files": files, "assets": []})
        backup.verify_files(target)
        return target, files

    def test_optional_evidence_absent_keeps_older_deployment_backup_valid(self):
        _, files = self.evidence_snapshot("without-evidence")
        self.assertFalse(any(key.startswith("files/capacity-evidence/") for key in files))
        shutil.rmtree(self.root / ".openpbl-data/uploads")
        target = self.root / "snapshots/missing-business"; target.mkdir()
        with self.assertRaisesRegex(RuntimeError, "Required data directory"):
            backup.snapshot_files(target, None)

    def test_evidence_original_bytes_incremental_hashes_and_restore_corruption(self):
        directory = self.root / ".openpbl-data/capacity-evidence/capacity-00000000-0000-4000-8000-000000000001"
        directory.mkdir(parents=True)
        original = b'{"outcome":"failed","expected":{"original":"unmodified"}}\n'
        (directory / "report.json").write_bytes(original)
        first, files = self.evidence_snapshot("evidence-first")
        relative = "files/" + str(directory.relative_to(self.root / ".openpbl-data")) + "/report.json"
        self.assertEqual((first / relative).read_bytes(), original)
        self.assertEqual(files[relative]["sha256"], backup.sha256(directory / "report.json"))
        second, _ = self.evidence_snapshot("evidence-second", first)
        self.assertEqual((first / relative).stat().st_ino, (second / relative).stat().st_ino)
        (directory / "report.json").write_bytes(b'{"outcome":"partial"}\n')
        third, _ = self.evidence_snapshot("evidence-third", second)
        self.assertEqual((first / relative).read_bytes(), original)
        self.assertNotEqual((first / relative).stat().st_ino, (third / relative).stat().st_ino)
        (third / relative).write_bytes(b'corrupted')
        with self.assertRaisesRegex(RuntimeError, "checksum mismatch"):
            backup.verify_files(third)

    def test_optional_evidence_rejects_symlink_instead_of_reading_outside_root(self):
        directory = self.root / ".openpbl-data/capacity-evidence"
        directory.mkdir(parents=True)
        outside = self.root / "outside-secret"; outside.write_bytes(b'private')
        (directory / "linked.json").symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "symlinks"):
            self.evidence_snapshot("evidence-symlink")

    def test_nonempty_live_sqlite_wal_snapshot_is_complete_and_readable(self):
        for name in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / name).mkdir(parents=True)
        source = self.root / ".openpbl-data/whiteboards/synthetic.sqlite"
        target = self.root / "snapshots/sqlite-check"
        target.mkdir()
        with contextlib.closing(sqlite3.connect(source)) as live:
            live.execute("PRAGMA journal_mode=WAL")
            live.execute("CREATE TABLE documents (id TEXT PRIMARY KEY, content TEXT NOT NULL)")
            expected = [("first", '{"shape":"rect"}'), ("second", '{"text":"complete evidence"}')]
            live.executemany("INSERT INTO documents VALUES (?, ?)", expected)
            live.commit()
            self.assertTrue(Path(str(source) + "-wal").exists())
            checksums = backup.snapshot_files(target, None)
        # Explicit close must stabilize the manifest before a later GC pass.
        gc.collect()
        self.assertTrue(all((target / relative).is_file() for relative in checksums))
        self.assertFalse(any(relative.endswith(("-wal", "-shm")) for relative in checksums))
        restored = target / "files/whiteboards/synthetic.sqlite"
        with contextlib.closing(sqlite3.connect(f"file:{restored}?mode=ro&immutable=1", uri=True)) as recovered:
            self.assertEqual(recovered.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(recovered.execute("SELECT id, content FROM documents ORDER BY id").fetchall(), expected)
        self.assertEqual(checksums["files/whiteboards/synthetic.sqlite"]["sha256"], backup.sha256(restored))
        self.assertFalse(Path(str(restored) + "-wal").exists())

    @unittest.skipIf(os.geteuid() == 0, "Root bypasses filesystem permission failures")
    def test_actual_isolated_write_denial_preserves_previous_status(self):
        status = self.root / "status/last-success.json"
        backup.write_json(status, {"snapshot": "verified"})
        status.parent.chmod(0o500)
        try:
            with self.assertRaises(PermissionError):
                backup.write_json(status, {"snapshot": "incomplete"})
            self.assertEqual(json.loads(status.read_text()), {"snapshot": "verified"})
        finally:
            status.parent.chmod(0o700)

    def test_health_rejects_old_snapshot_or_lost_receiver(self):
        backup.write_json(self.root / "status/last-success.json", {"startedEpoch": time.time() - 901})
        with patch.object(backup, "sql", return_value=json.dumps([{"active": True, "status": "reserved"}])):
            self.assertEqual(backup.status(), 1)
        backup.write_json(self.root / "status/last-success.json", {"startedEpoch": time.time()})
        with patch.object(backup, "sql", return_value=json.dumps([{"active": False, "status": "lost"}])):
            self.assertEqual(backup.status(), 1)
        with patch.object(backup, "sql", return_value=json.dumps([{"active": True, "status": "reserved"}])):
            self.assertEqual(backup.status(), 0)

    def test_local_monitor_reports_stale_state_and_recovery_only_on_changes(self):
        def unit_state(_unit, property_name):
            return "success" if property_name == "Result" else "active"

        with patch.object(backup, "unit_property", side_effect=unit_state), patch("builtins.print") as emit:
            with patch.object(backup, "health_snapshot", return_value={"healthy": False}):
                self.assertEqual(backup.monitor(), 1)
                self.assertEqual(backup.monitor(), 1)
                self.assertEqual(emit.call_count, 1)
                self.assertEqual(json.loads((self.root / "status/health.json").read_text())["state"], "alert")
            with patch.object(backup, "health_snapshot", return_value={"healthy": True}):
                self.assertEqual(backup.monitor(), 0)
                self.assertEqual(emit.call_count, 2)
                self.assertEqual(json.loads((self.root / "status/health.json").read_text())["state"], "ok")

    def test_local_monitor_fails_when_services_fail_even_if_snapshot_is_fresh(self):
        def unit_state(_unit, property_name):
            return "exit-code" if property_name == "Result" else "inactive"

        with patch.object(backup, "unit_property", side_effect=unit_state), \
                patch.object(backup, "health_snapshot", return_value={"healthy": True}), patch("builtins.print"):
            self.assertEqual(backup.monitor(), 1)
        state = json.loads((self.root / "status/health.json").read_text())
        self.assertEqual(len(state["reasons"]), 3)

    def prepare_source_fixture(self):
        files = set(backup.SOURCE_REQUIRED_FILES) | {"patches/docx.patch", "prisma/migrations/20260101_initial/migration.sql",
                                                   "src/deleted.ts", "public/font.woff2", ".gitignore"}
        for relative in files:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("original source\n")
        (self.root / ".gitignore").write_text("node_modules/\n.env.local\ndeploy/secrets/\n")
        (self.root / "package.json").write_text(json.dumps({"scripts": {"build": "node scripts/build-document-converter-worker.mjs"},
            "pnpm": {"patchedDependencies": {"@platejs/docx-io@53.3.2": "patches/docx.patch"}}}))
        subprocess.run(["git", "init", "--quiet", self.root], check=True, capture_output=True)
        subprocess.run(["git", "-C", self.root, "add", "--", *sorted(files)], check=True, capture_output=True)
        subprocess.run(["git", "-C", self.root, "-c", "user.name=Backup Test", "-c", "user.email=backup-test@invalid",
                        "commit", "--quiet", "-m", "isolated source fixture"], check=True, capture_output=True)

    def source_target(self, name="source-check"):
        target = self.root / "snapshots" / name
        target.mkdir()
        return target

    def test_source_snapshot_preserves_working_tree_and_excludes_credentials_and_generated_data(self):
        self.prepare_source_fixture()
        engine = "src/lib/project-practice/document-conversion-engine.ts"
        (self.root / engine).write_text("uncommitted engine change\n")
        (self.root / "src/new-worker-helper.ts").write_text("untracked build input\n")
        artifact_route = self.root / "src/app/api/showcase/artifacts/route.ts"
        artifact_route.parent.mkdir(parents=True)
        artifact_route.write_text("authored artifact route\n")
        (self.root / "src/deleted.ts").unlink()
        forbidden = ("src/credentials/credential.json", "public/node_modules/package.js", "prisma/production.db",
                     "scripts/.npmrc", "deploy/secrets/token.txt", ".git-credentials", "test-results/huge.bin",
                     "workers/docx-converter.cjs", ".openpbl-data/database.dump", "packages/component/dist/generated.js",
                     "tests/load/reports/large.json")
        for relative in forbidden:
            path = self.root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("private or generated fixture")
            # Even force-tracked forbidden paths may not leak into source.
            subprocess.run(["git", "-C", self.root, "add", "-f", "--", relative], check=True, capture_output=True)
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        report = backup.verify_source(target, metadata)
        self.assertTrue(metadata["gitDirty"])
        self.assertTrue(report["workerBuildInputsVerified"])
        self.assertFalse(report["applicationRebuilt"])
        self.assertEqual((target / "source" / engine).read_text(), "uncommitted engine change\n")
        self.assertTrue((target / "source/src/new-worker-helper.ts").is_file())
        self.assertTrue((target / "source/src/app/api/showcase/artifacts/route.ts").is_file())
        self.assertFalse((target / "source/src/deleted.ts").exists())
        self.assertTrue((target / "source/public/font.woff2").is_file())
        self.assertTrue(all(not (target / "source" / path).exists() for path in forbidden))
        self.assertFalse((target / "source/.git").exists())

    def test_source_snapshot_fails_if_worker_or_pinned_patch_or_migration_is_missing(self):
        self.prepare_source_fixture()
        for index, relative in enumerate(("scripts/build-document-converter-worker.mjs", "patches/docx.patch",
                                          "prisma/migrations/20260101_initial/migration.sql")):
            path = self.root / relative
            content = path.read_bytes()
            path.unlink()
            with self.assertRaisesRegex(RuntimeError, "build inputs|patch|migrations"):
                backup.snapshot_source(self.source_target(f"missing-{index}"))
            path.write_bytes(content)

    def test_source_snapshot_rejects_symlink_instead_of_copying_external_bytes(self):
        self.prepare_source_fixture()
        outside = self.root / "outside-secret"
        outside.write_text("private fixture")
        (self.root / "src/link.ts").symlink_to(outside)
        with self.assertRaisesRegex(RuntimeError, "symlink"):
            backup.snapshot_source(self.source_target())

    def test_isolated_source_restore_is_independent_and_detects_corruption_and_mode_changes(self):
        self.prepare_source_fixture()
        script = "scripts/build-document-converter-worker.mjs"
        (self.root / script).chmod(0o750)
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        recovered = self.root / "isolated-recovered-source"
        shutil.copytree(target, recovered)
        (self.root / script).write_text("later production edit\n")
        self.assertTrue(backup.verify_source(recovered, metadata)["verified"])
        path = recovered / "source" / script
        path.chmod(0o700)
        with self.assertRaisesRegex(RuntimeError, "mode mismatch"):
            backup.verify_source(recovered, metadata)
        path.chmod(0o750)
        path.write_text("modified source\n")
        with self.assertRaisesRegex(RuntimeError, "checksum or mode mismatch"):
            backup.verify_source(recovered, metadata)

    def test_source_manifest_and_inventory_cannot_silently_drop_or_add_inputs(self):
        self.prepare_source_fixture()
        target = self.source_target()
        metadata = backup.snapshot_source(target)
        extra = target / "source/src/unlisted.ts"
        extra.write_text("unlisted")
        with self.assertRaisesRegex(RuntimeError, "inventory mismatch"):
            backup.verify_source(target, metadata)
        extra.unlink()
        manifest = target / "source-manifest.json"
        manifest.write_text(manifest.read_text() + " ")
        with self.assertRaisesRegex(RuntimeError, "manifest checksum mismatch"):
            backup.verify_source(target, metadata)
        self.assertFalse(backup.source_path_allowed("src/../private.ts"))
        self.assertFalse(backup.source_path_allowed("/src/private.ts"))
        self.assertFalse(backup.source_path_allowed("src\\private.ts"))

    def test_source_changes_while_copying_are_not_acknowledged(self):
        self.prepare_source_fixture()
        original_copy = shutil.copy2
        def changing_copy(source, destination, **kwargs):
            result = original_copy(source, destination, **kwargs)
            if Path(source).name == "document-conversion-engine.ts":
                Path(source).write_text("changed during snapshot")
            return result
        with patch.object(backup.shutil, "copy2", side_effect=changing_copy):
            with self.assertRaisesRegex(RuntimeError, "changed during snapshot"):
                backup.snapshot_source(self.source_target())

    def test_source_failure_preserves_last_acknowledged_checkpoint(self):
        previous = {"snapshot": "previous", "startedEpoch": time.time()}
        backup.write_json(self.root / "status/last-success.json", previous)
        with patch.object(backup, "take_base", return_value=self.root / "bases/previous"), \
                patch.object(backup, "dump_consistent", return_value=({}, [])), \
                patch.object(backup, "snapshot_source", side_effect=RuntimeError("source incomplete")):
            with self.assertRaisesRegex(RuntimeError, "source incomplete"):
                backup.backup()
        self.assertEqual(json.loads((self.root / "status/last-success.json").read_text()), previous)
        self.assertEqual(backup.snapshots(), [])

    def test_incremental_dedup_preserves_changed_source_and_configuration_modes(self):
        for name in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / name).mkdir(parents=True)
        config = self.root / ".env.local"
        config.write_text("nonsecret fixture")
        config.chmod(0o600)
        first = self.source_target("first")
        first_source = first / "source/src/executable.ts"
        first_source.parent.mkdir(parents=True)
        first_source.write_text("same source bytes")
        first_source.chmod(0o600)
        first_files = backup.snapshot_files(first, None)
        backup.write_json(first / "manifest.json", {"files": first_files, "assets": []})
        config.chmod(0o640)
        second = self.source_target("second")
        second_source = second / "source/src/executable.ts"
        second_source.parent.mkdir(parents=True)
        second_source.write_text("same source bytes")
        second_source.chmod(0o700)
        second_files = backup.snapshot_files(second, first)
        backup.write_json(second / "manifest.json", {"files": second_files, "assets": []})
        backup.verify_files(second)
        self.assertEqual(second_source.stat().st_mode & 0o777, 0o700)
        self.assertNotEqual(second_source.stat().st_ino, first_source.stat().st_ino)
        self.assertEqual((second / "configuration/.env.local").stat().st_mode & 0o777, 0o640)
        third = self.source_target("third")
        third_source = third / "source/src/executable.ts"
        third_source.parent.mkdir(parents=True)
        shutil.copy2(second_source, third_source)
        backup.snapshot_files(third, second)
        self.assertEqual(third_source.stat().st_ino, second_source.stat().st_ino)


if __name__ == "__main__":
    unittest.main()
