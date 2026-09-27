"""Run-specific checks only use synthetic records and temporary restored files."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

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

    def lecture_fixture(self):
        report, records, files = self.fixture()
        pcm = bytes(1600)
        raw = b'RIFF' + struct.pack('<I', 0xffffffff) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 8000, 16000, 2, 16) + b'data' + struct.pack('<I', 0xffffffff) + pcm
        normalized = bytearray(raw)
        struct.pack_into('<I', normalized, 4, len(raw) - 8)
        struct.pack_into('<I', normalized, 40, len(pcm))
        fixture = report['fixture']; fixture['lectureSceneId'] = report['runId'] + '-student-lecture'
        lecture = {'id': identifier(9000), 'userId': fixture['userIds'][0], 'size': len(raw),
                   'sha256': hashlib.sha256(raw).hexdigest(), 'servedSha256': hashlib.sha256(normalized).hexdigest(),
                   'servedSize': len(normalized), 'durationSec': .1,
                   'playbackUrl': '/api/openmaic/classroom-media/' + fixture['classroomId'] + '/audio/lecture.wav'}
        fixture['lectureAudio'] = lecture
        filename = lecture['id'] + '.wav'
        (files / 'uploads' / filename).write_bytes(raw)
        records['assets'].append({'id': lecture['id'], 'storageKey': filename, 'offeringId': fixture['offeringId'],
                                  'uploadedById': lecture['userId'], 'sha256': lecture['sha256'], 'size': lecture['size']})
        media = files / 'classrooms' / fixture['classroomId'] / 'audio/lecture.wav'
        media.parent.mkdir(parents=True)
        media.write_bytes(raw)
        classroom = {'id': fixture['classroomId'], 'scenes': [{'id': fixture['lectureSceneId'], 'actions': [
            {'type': 'speech', 'audioUrl': lecture['playbackUrl'] + '?capacityClip=0', 'audioDurationSec': .1},
            {'type': 'speech', 'audioUrl': lecture['playbackUrl'] + '?capacityClip=1', 'audioDurationSec': .1},
        ]}]}
        (files / 'classrooms' / (fixture['classroomId'] + '.json')).write_text(json.dumps(classroom))
        return report, records, files, classroom

    def test_restored_media_keeps_raw_sha_and_verifies_actual_wav_normalization(self):
        report, records, files, _ = self.lecture_fixture()
        lecture = report['fixture']['lectureAudio']
        self.assertNotEqual(lecture['sha256'], lecture['servedSha256'])
        result = verify.verify_records(report, records, files)
        playback = result['lecturePlayback']
        self.assertTrue(result['lectureMediaVerified'])
        self.assertTrue(playback['servedVerified'])
        self.assertEqual(playback['sourceSha256'], lecture['sha256'])
        self.assertEqual(playback['servedSha256'], lecture['servedSha256'])
        self.assertEqual(playback['speechActionsVerified'], 2)
        self.assertEqual(result['uploadFilesVerified'], 41)

    def test_old_media_report_marks_missing_served_evidence_without_inventing_it(self):
        report, records, files, _ = self.lecture_fixture()
        lecture = report['fixture']['lectureAudio']; del lecture['servedSha256']; del lecture['servedSize']
        result = verify.verify_records(report, records, files)
        self.assertTrue(result['lectureMediaVerified'])
        self.assertFalse(result['lecturePlayback']['servedVerified'])
        self.assertEqual(result['lecturePlayback']['servedStatus'], 'not-recorded')
        del lecture['playbackUrl']
        result = verify.verify_records(report, records, files)
        self.assertFalse(result['lectureMediaVerified'])
        self.assertEqual(result['lecturePlayback']['status'], 'not-recorded')

    def test_restored_media_rejects_incorrect_served_sha_or_size(self):
        report, records, files, _ = self.lecture_fixture()
        changed = copy.deepcopy(report)
        changed['fixture']['lectureAudio']['servedSha256'] = changed['fixture']['lectureAudio']['sha256']
        with self.assertRaisesRegex(AssertionError, 'playable media'):
            verify.verify_records(changed, records, files)
        changed = copy.deepcopy(report); changed['fixture']['lectureAudio']['servedSize'] += 1
        with self.assertRaisesRegex(AssertionError, 'served audio size'):
            verify.verify_records(changed, records, files)

    def test_restored_media_rejects_normalized_bytes_replacing_original_disk_bytes(self):
        report, records, files, _ = self.lecture_fixture()
        media = files / 'classrooms' / report['fixture']['classroomId'] / 'audio/lecture.wav'
        normalized = bytearray(media.read_bytes())
        struct.pack_into('<I', normalized, 4, len(normalized) - 8)
        struct.pack_into('<I', normalized, 40, len(normalized) - 44)
        media.write_bytes(normalized)
        with self.assertRaisesRegex(AssertionError, 'Recovered file hash differs'):
            verify.verify_records(report, records, files)

    def test_restored_media_rejects_other_classroom_references_and_unsafe_paths(self):
        report, records, files, classroom = self.lecture_fixture()
        filename = files / 'classrooms' / (report['fixture']['classroomId'] + '.json')
        changed = copy.deepcopy(classroom)
        changed['scenes'][0]['actions'][0]['audioUrl'] = '/api/openmaic/classroom-media/foreign/audio/lecture.wav'
        filename.write_text(json.dumps(changed))
        with self.assertRaisesRegex(AssertionError, 'another media file'):
            verify.verify_records(report, records, files)
        filename.write_text(json.dumps(classroom))
        changed = copy.deepcopy(report); changed['fixture']['lectureAudio']['playbackUrl'] += '/../secret.wav'
        with self.assertRaisesRegex(AssertionError, 'Unsafe'):
            verify.verify_records(changed, records, files)
        media = files / 'classrooms' / report['fixture']['classroomId'] / 'audio/lecture.wav'
        original = media.with_name('original.wav'); media.rename(original); media.symlink_to(original)
        with self.assertRaisesRegex(AssertionError, 'symlink'):
            verify.verify_records(report, records, files)

    def test_required_source_rejects_historical_snapshot_and_calls_isolated_verifier(self):
        _, _, files = self.fixture()
        snapshot = files / 'snapshot'; snapshot.mkdir()
        work = files / 'isolated'; work.mkdir()
        manifest = snapshot / 'manifest.json'; manifest.write_text('{}')
        function = Mock(return_value={'verified': True, 'workerBuildInputsVerified': True})
        backup = SimpleNamespace(verify_source=function)
        self.assertFalse(verify.verify_required_source(backup, work, snapshot, False))
        with self.assertRaisesRegex(AssertionError, 'complete source'):
            verify.verify_required_source(backup, work, snapshot, True)
        function.assert_not_called()
        expected = {'manifestSha256': 'source-manifest-digest'}
        manifest.write_text(json.dumps({'source': expected}))
        self.assertTrue(verify.verify_required_source(backup, work, snapshot, True))
        function.assert_called_once_with(work, expected)
        for result in ({'verified': False, 'workerBuildInputsVerified': True},
                       {'verified': True, 'workerBuildInputsVerified': False}):
            function.return_value = result
            for required in (False, True):
                with self.assertRaises(AssertionError):
                    verify.verify_required_source(backup, work, snapshot, required)
        function.side_effect = RuntimeError('source file checksum mismatch')
        with self.assertRaisesRegex(RuntimeError, 'checksum mismatch'):
            verify.verify_required_source(backup, work, snapshot, True)


if __name__ == "__main__":
    unittest.main()
