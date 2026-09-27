#!/usr/bin/env python3
"""Verify one stopped capacity run inside the local backup's isolated restore only."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess

PROJECT = Path(__file__).resolve().parents[1]
UUID = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"


def validate_report(report):
    assert re.fullmatch("capacity-" + UUID, report["runId"]), "Invalid capacity run ID"
    assert report["outcome"] in ("passed", "failed", "partial"), "Runner is still active"
    fixture = report["fixture"]
    for field in ("offeringId", "templateId", "instanceId", "activityId", "chapterId"):
        assert re.fullmatch(UUID, fixture[field]), "Invalid fixture identifier"
    assert fixture["classroomId"] == report["runId"] + "-lesson"
    assert len(fixture["userIds"]) == len(set(fixture["userIds"])) == 42
    for identifier in fixture["userIds"]:
        assert re.fullmatch(UUID, identifier), "Invalid fixture user ID"
    assert len(report["expected"]) == 40
    assert set(report["expected"]) == set(fixture["userIds"][2:]), "Student manifest differs"


def read_recovered(sql, report):
    validate_report(report)
    assert sql("SHOW default_transaction_read_only") == "on", "Recovery verification must use read-only connections"
    instance = report["fixture"]["instanceId"]
    offering = report["fixture"]["offeringId"]
    # Only strictly validated UUID literals enter SQL; content is never interpolated.
    return json.loads(sql(f"""
      WITH scope AS MATERIALIZED (
        SELECT p.id, p."enrollmentId", e."userId", u.username
        FROM "ClassroomParticipation" p JOIN "Enrollment" e ON e.id=p."enrollmentId"
        JOIN "User" u ON u.id=e."userId" WHERE p."instanceId"='{instance}'
      ) SELECT json_build_object(
        'course', (SELECT row_to_json(r) FROM (SELECT ci.id, ci.status, ci."activityId", tv."templateId", c."offeringId", o.description
          FROM "ClassroomInstance" ci JOIN "ClassroomTemplateVersion" tv ON tv.id=ci."templateVersionId"
          JOIN "Activity" a ON a.id=ci."activityId" JOIN "Chapter" c ON c.id=a."chapterId"
          JOIN "CourseOffering" o ON o.id=c."offeringId" WHERE ci.id='{instance}') r),
        'participants', (SELECT coalesce(json_agg(s), '[]') FROM scope s),
        'drafts', (SELECT coalesce(json_agg(r), '[]') FROM (SELECT sc."userId", s.payload#>>'{{view,id}}' AS id,
          s.payload#>'{{view,version}}' AS version, encode(sha256(convert_to(s.payload#>>'{{view,content}}','UTF8')),'hex') AS sha256
          FROM "ClassroomSubmission" s JOIN scope sc ON sc.id=s."participationId" WHERE s."stageKey"='make:document') r),
        'versions', (SELECT coalesce(json_agg(r), '[]') FROM (SELECT sc."userId", v.id, v.sequence, v."fileAssetId", v.sha256, a.type
          FROM "ArtifactVersion" v JOIN "Artifact" a ON a.id=v."artifactId" JOIN scope sc ON sc.id=a."participationId") r),
        'events', (SELECT coalesce(json_agg(r), '[]') FROM (SELECT e."userId", e.metadata#>>'{{legacy,id}}' AS id, e."idempotencyKey"
          FROM "LearningEvent" e JOIN scope sc ON sc.id=e."participationId"
          WHERE e."classroomInstanceId"='{instance}' AND e.source='legacy-classroom') r),
        'receipts', (SELECT coalesce(json_agg(r), '[]') FROM (SELECT d."actorId" AS "userId", d.payload#>>'{{ack,requestId}}' AS "requestId",
          d.payload#>'{{ack,submissionVersion}}' AS version,
          encode(sha256(convert_to(d.payload#>>'{{action,payload,submission,content}}','UTF8')),'hex') AS sha256
          FROM "DomainEvent" d WHERE d."classroomInstanceId"='{instance}' AND d."eventType"='COURSE_ACTION'
          AND d.payload#>>'{{action,type}}'='UPSERT_SUBMISSION') r),
        'assets', (SELECT coalesce(json_agg(r), '[]') FROM (SELECT id, "storageKey", "offeringId", "uploadedById", sha256, size
          FROM "FileAsset" WHERE "offeringId"='{offering}' AND "deletedAt" IS NULL) r)
      )
    """))


def recovered_file(root, relative):
    parts = relative.split("/")
    assert not Path(relative).is_absolute() and "\\" not in relative and all(part not in ("", ".", "..") for part in parts), "Unsafe recovered file path"
    path = root / relative
    assert path.resolve().is_relative_to(root.resolve()), "Unsafe recovered file path"
    for index in range(1, len(parts) + 1):
        assert not root.joinpath(*parts[:index]).is_symlink(), "Unsafe recovered file symlink"
    assert path.is_file(), "Recovered file is missing"
    return path


def checked_file(root, relative, expected_sha, expected_size=None):
    path = recovered_file(root, relative)
    if expected_size is not None:
        assert path.stat().st_size == expected_size, "Recovered file size differs"
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    assert digest.hexdigest() == expected_sha, "Recovered file hash differs"


def verify_lecture_playback(report, files, classroom):
    lecture = report["fixture"].get("lectureAudio")
    if not lecture or "playbackUrl" not in lecture:
        return {"verified": False, "status": "not-recorded"}
    classroom_id = report["fixture"]["classroomId"]
    prefix = "/api/openmaic/classroom-media/" + classroom_id + "/audio/lecture."
    match = re.fullmatch(re.escape(prefix) + r"(wav|wave|x-wav|mp3|mpeg)", lecture["playbackUrl"])
    assert match, "Unsafe classroom media URL"
    checked_file(files, "classrooms/" + classroom_id + "/audio/lecture." + match[1], lecture["sha256"], lecture["size"])
    # Raw on-disk bytes remain exactly the acknowledged teacher upload. The
    # HTTP route can normalize WAV headers in memory, without changing that file.
    scene_id = report["fixture"].get("lectureSceneId", report["runId"] + "-student-lecture")
    assert scene_id == report["runId"] + "-student-lecture", "Lecture scene is outside the run"
    scenes = [scene for scene in classroom.get("scenes", []) if scene.get("id") == scene_id]
    assert len(scenes) == 1, "Recovered lecture scene is missing or duplicated"
    speeches = [action for action in scenes[0].get("actions", []) if action.get("type") == "speech"]
    assert speeches, "Recovered lecture has no speech actions"
    urls = []
    for speech in speeches:
        url = speech.get("audioUrl", "")
        assert re.fullmatch(re.escape(lecture["playbackUrl"]) + r"(?:\?capacityClip=(?:0|[1-9][0-9]*))?", url), "Recovered speech references another media file"
        if "durationSec" in lecture:
            assert speech.get("audioDurationSec") == lecture["durationSec"], "Recovered speech duration differs"
        urls.append(url)
    assert len(set(urls)) == len(urls), "Duplicate recovered lecture clip"
    if "servedSha256" not in lecture:
        return {"verified": True, "status": "raw-and-references-verified", "servedVerified": False,
                "servedStatus": "not-recorded", "speechActionsVerified": len(speeches)}
    # Reuse the same read-only media verifier and normalization implementation
    # used by the independent file audit. Never invoke its CLI/DB entry point.
    program = """
      import { readFileSync } from 'node:fs';
      import { verifyLecturePlayback } from './scripts/verify-capacity-files.mjs';
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const result = await verifyLecturePlayback(input);
      console.log(JSON.stringify(result));
    """
    minimal = {"runId": report["runId"], "fixture": {"classroomId": classroom_id, "lectureSceneId": scene_id, "lectureAudio": lecture}}
    environment = {key: value for key, value in os.environ.items()
                   if key not in ("DATABASE_URL", "CAPACITY_DATABASE_URL", "PROVIDER_CONFIG_DATABASE_URL", "REDIS_URL")}
    result = subprocess.run(["node", "--input-type=module", "-e", program], cwd=PROJECT,
        input=json.dumps({"report": minimal, "classroomsDirectory": str((files / "classrooms").resolve()),
                          "asset": {"size": lecture["size"], "sha256": lecture["sha256"]}}),
        capture_output=True, text=True, timeout=30, env=environment)
    assert result.returncode == 0, "Recovered playable media SHA/duration verification failed"
    playback = json.loads(result.stdout)
    assert playback["verified"] is True and playback["servedSha256"] == lecture["servedSha256"]
    if "servedSize" in lecture:
        assert playback["servedSize"] == lecture["servedSize"], "Recovered served audio size differs"
    return {**playback, "servedVerified": True}


def verify_required_source(backup, work, snapshot, required):
    manifest = json.loads((snapshot / "manifest.json").read_text())
    source = manifest.get("source")
    if not source:
        assert not required, "This restore requires a complete source snapshot"
        return False
    result = backup.verify_source(work, source)
    assert result["verified"] is True and result["workerBuildInputsVerified"] is True
    return True


def verify_records(report, records, files):
    validate_report(report)
    fixture = report["fixture"]; course = records["course"]
    assert course and course["id"] == fixture["instanceId"] and course["status"] == "FINISHED"
    for field in ("offeringId", "templateId", "activityId"):
        assert course[field] == fixture[field], "Recovered course ownership differs"
    assert course["description"] == report["runId"]
    expected_students = set(report["expected"])
    assert len(records["participants"]) == 40
    assert {row["userId"] for row in records["participants"]} == expected_students
    for row in records["participants"]:
        assert re.fullmatch(re.escape(report["runId"]) + r"-[0-9]+", row["username"])
    assets = {row["id"]: row for row in records["assets"]}
    assert len(assets) == len(records["assets"])
    expected_asset_ids = set(); students = []

    def asset(expected_id, expected_sha, owner, size=None):
        assert expected_id not in expected_asset_ids, "Duplicate asset in run manifest"
        expected_asset_ids.add(expected_id)
        row = assets[expected_id]
        assert row["offeringId"] == fixture["offeringId"] and row["uploadedById"] == owner
        assert row["sha256"] == expected_sha
        if size is not None:
            assert row["size"] == size
        key = row["storageKey"]
        assert key and Path(key).name == key and key not in (".", ".."), "Unsafe recovered upload key"
        checked_file(files, "uploads/" + key, expected_sha, row["size"])

    for user_id, state in report["expected"].items():
        drafts = [row for row in records["drafts"] if row["userId"] == user_id]
        assert len(drafts) == 1
        assert drafts[0]["id"] == state["submissionId"] and drafts[0]["version"] == state["version"]
        assert drafts[0]["sha256"] == hashlib.sha256(state["content"].encode()).hexdigest()
        versions = [row for row in records["versions"] if row["userId"] == user_id]
        expected_versions = [*state["archives"], *state.get("externalArtifacts", [])]
        assert {row["id"] for row in versions} == {row["versionId"] for row in expected_versions}
        assert len(versions) == len(expected_versions)
        for expected in expected_versions:
            version = next(row for row in versions if row["id"] == expected["versionId"])
            upload = expected.get("docxUploadId") or expected["uploadId"]
            assert version["fileAssetId"] == upload and version["sha256"] == expected["sha256"]
            assert version["sequence"] == expected["sequence"]
            assert version["type"] == ("DOCUMENT_ARCHIVE" if "docxUploadId" in expected else "FILE_ARCHIVE")
            asset(upload, expected["sha256"], user_id, expected.get("size"))
        for upload in state.get("uploads", []):
            asset(upload["id"], upload["sha256"], user_id, upload["size"])
        events = [row for row in records["events"] if row["userId"] == user_id]
        event_ids = {row["id"] for row in events}
        assert len(event_ids) == len(events) == state["reconciledLearningEvents"]["total"]
        assert len({row["idempotencyKey"] for row in events}) == len(events)
        acknowledged = set(state["events"] + state.get("browserEvents", []))
        assert acknowledged <= event_ids
        receipts = [row for row in records["receipts"] if row["userId"] == user_id]
        by_request = {row["requestId"]: row for row in receipts}
        assert len(receipts) == len(by_request) == state["saves"] == len(state["receipts"])
        for expected in state["receipts"]:
            row = by_request[expected["requestId"]]
            assert row["version"] == expected["version"] and row["sha256"] == expected["contentSha256"]
        students.append({"studentId": user_id, "finalVersion": state["version"], "saveReceipts": len(receipts),
                         "artifactVersions": len(versions), "learningEvents": len(events), "acknowledgedEvents": len(acknowledged)})
    lecture = fixture.get("lectureAudio")
    if lecture:
        asset(lecture["id"], lecture["sha256"], lecture["userId"], lecture["size"])
    assert expected_asset_ids == set(assets), "Recovered run has missing or additional assets"
    classroom = json.loads(recovered_file(files, "classrooms/" + fixture["classroomId"] + ".json").read_text())
    assert classroom["id"] == fixture["classroomId"]
    playback = verify_lecture_playback(report, files, classroom)
    return {"runId": report["runId"], "sourceOutcome": report["outcome"], "courseId": fixture["instanceId"],
            "readOnlyRestoredDatabase": True, "studentsVerified": len(students), "students": students,
            "artifactVersionsVerified": len(records["versions"]), "saveReceiptsVerified": sum(item["saveReceipts"] for item in students),
            "learningEventsVerified": sum(item["learningEvents"] for item in students), "uploadFilesVerified": len(expected_asset_ids),
            "classroomJsonVerified": True, "lectureMediaVerified": playback["verified"], "lecturePlayback": playback}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report", type=Path)
    parser.add_argument("--require-source", action="store_true", help="Reject historical recovery points without a verified source tree")
    args = parser.parse_args()
    report = json.loads(args.report.read_text()); validate_report(report)
    spec = importlib.util.spec_from_file_location("local_backup", PROJECT / "deploy/backup/local-backup.py")
    backup = importlib.util.module_from_spec(spec); spec.loader.exec_module(backup)

    def verify(sql, work, snapshot):
        source_verified = verify_required_source(backup, work, snapshot, args.require_source)
        return {**verify_records(report, read_recovered(sql, report), work / "files"), "sourceRecoveryVerified": source_verified}

    backup.drill(verify_recovered=verify)


if __name__ == "__main__":
    main()
