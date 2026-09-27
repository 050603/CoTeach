"""Run-specific checks only use synthetic records and temporary restored files."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("capacity_restore", Path(__file__).resolve().parents[2] / "scripts/verify-capacity-local-restore.py")
verify = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(verify)


def identifier(index):
    return f"00000000-0000-4000-8000-{index:012d}"


class CapacityRestoreTest(unittest.TestCase):
    def fixture(self):
        temporary = tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        files = Path(temporary.name); (files / "uploads").mkdir(); (files / "classrooms").mkdir()
        run_id = "capacity-" + identifier(999)
        fixture = {name: identifier(index) for index, name in enumerate(("offeringId", "templateId", "instanceId", "activityId", "chapterId"), 100)}
        fixture.update(classroomId=run_id + "-lesson", userIds=[identifier(i) for i in range(42)])
        report = {"runId": run_id, "outcome": "failed", "fixture": fixture, "expected": {}}
        records = {"course": {"id": fixture["instanceId"], "status": "FINISHED", "description": run_id,
                   **{field: fixture[field] for field in ("offeringId", "templateId", "activityId")}},
                   **{field: [] for field in ("participants", "drafts", "versions", "events", "receipts", "assets")}}
        content = "恢复正文"; digest = hashlib.sha256(content.encode()).hexdigest()
        for index, user_id in enumerate(fixture["userIds"][2:], 2):
            submission = identifier(1000 + index); request = identifier(2000 + index); event = identifier(3000 + index)
            file_id = identifier(4000 + index); filename = file_id + ".txt"
            (files / "uploads" / filename).write_text(content)
            report["expected"][user_id] = {"submissionId": submission, "version": 1, "content": content, "archives": [], "saves": 1,
                "receipts": [{"requestId": request, "version": 1, "contentSha256": digest}], "events": [event],
                "reconciledLearningEvents": {"total": 1}, "uploads": [{"id": file_id, "sha256": digest, "size": len(content.encode())}]}
            records["participants"].append({"userId": user_id, "username": f"{run_id}-{index}"})
            records["drafts"].append({"userId": user_id, "id": submission, "version": 1, "sha256": digest})
            records["events"].append({"userId": user_id, "id": event, "idempotencyKey": event})
            records["receipts"].append({"userId": user_id, "requestId": request, "version": 1, "sha256": digest})
            records["assets"].append({"id": file_id, "storageKey": filename, "offeringId": fixture["offeringId"], "uploadedById": user_id,
                                      "sha256": digest, "size": len(content.encode())})
        (files / "classrooms" / (fixture["classroomId"] + ".json")).write_text(json.dumps({"id": fixture["classroomId"]}))
        return report, records, files

    def test_preserves_failed_outcome_and_checks_all_40_students(self):
        report, records, files = self.fixture()
        result = verify.verify_records(report, records, files)
        self.assertEqual((result["sourceOutcome"], result["studentsVerified"], result["saveReceiptsVerified"], result["uploadFilesVerified"]), ("failed", 40, 40, 40))

    def test_missing_events_changed_content_and_foreign_ownership_fail(self):
        report, records, files = self.fixture()
        cases = []
        modified = copy.deepcopy(records); modified["events"].pop(); cases.append(modified)
        modified = copy.deepcopy(records); modified["drafts"][0]["sha256"] = "wrong"; cases.append(modified)
        modified = copy.deepcopy(records); modified["assets"][0]["uploadedById"] = identifier(900); cases.append(modified)
        modified = copy.deepcopy(records); modified["course"]["offeringId"] = identifier(900); cases.append(modified)
        modified = copy.deepcopy(records); modified["receipts"].append(modified["receipts"][0]); cases.append(modified)
        for modified in cases:
            with self.assertRaises(AssertionError):
                verify.verify_records(report, modified, files)

    def test_file_corruption_and_traversal_fail(self):
        report, records, files = self.fixture()
        (files / "uploads" / records["assets"][0]["storageKey"]).write_bytes(b"changed bytes")
        with self.assertRaises(AssertionError):
            verify.verify_records(report, records, files)
        records["assets"][0]["storageKey"] = "../outside"
        with self.assertRaises(AssertionError):
            verify.verify_records(report, records, files)

    def test_archived_versions_retain_type_sequence_asset_and_hash(self):
        report, records, files = self.fixture()
        user_id = next(iter(report["expected"])); state = report["expected"][user_id]
        original_asset = records["assets"][0]
        for index, kind in enumerate(("DOCUMENT_ARCHIVE", "FILE_ARCHIVE"), 1):
            asset = {**original_asset, "id": identifier(5000 + index), "storageKey": f"archive-{index}.bin"}
            (files / "uploads" / asset["storageKey"]).write_text(state["content"])
            records["assets"].append(asset)
            version_id = identifier(6000 + index)
            records["versions"].append({"id": version_id, "userId": user_id, "fileAssetId": asset["id"], "sha256": asset["sha256"], "sequence": 1, "type": kind})
            expected = {"versionId": version_id, "sha256": asset["sha256"], "sequence": 1}
            if kind == "DOCUMENT_ARCHIVE":
                state["archives"].append({**expected, "docxUploadId": asset["id"]})
            else:
                state["externalArtifacts"] = [{**expected, "uploadId": asset["id"], "size": asset["size"]}]
        self.assertEqual(verify.verify_records(report, records, files)["artifactVersionsVerified"], 2)
        for field, value in (("type", "WRONG"), ("sequence", 4), ("fileAssetId", identifier(999))):
            modified = copy.deepcopy(records); modified["versions"][0][field] = value
            with self.assertRaises(AssertionError):
                verify.verify_records(report, modified, files)

    def test_refuses_non_readonly_database_and_untrusted_ids_before_querying_records(self):
        report, _, _ = self.fixture()
        with self.assertRaisesRegex(AssertionError, "read-only"):
            verify.read_recovered(lambda statement: "off", report)
        report["fixture"]["instanceId"] = "x' OR true--"
        calls = []
        with self.assertRaises(AssertionError):
            verify.read_recovered(lambda statement: calls.append(statement), report)
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
