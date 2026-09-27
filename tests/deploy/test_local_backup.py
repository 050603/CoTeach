"""Local recovery safeguards, file integrity and 30-day WAL retention."""

import importlib.util
import gc
import json
import os
from pathlib import Path
import sqlite3
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

    def test_nonempty_live_sqlite_wal_snapshot_is_complete_and_readable(self):
        for name in ("uploads", "classrooms", "whiteboards"):
            (self.root / ".openpbl-data" / name).mkdir(parents=True)
        source = self.root / ".openpbl-data/whiteboards/synthetic.sqlite"
        target = self.root / "snapshots/sqlite-check"
        target.mkdir()
        with sqlite3.connect(source) as live:
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
        with sqlite3.connect(f"file:{restored}?mode=ro&immutable=1", uri=True) as recovered:
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


if __name__ == "__main__":
    unittest.main()
