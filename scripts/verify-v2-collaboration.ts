// Invoked only by verify-research-database.mjs against its marked disposable PostgreSQL container.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AuthClaims } from "../src/lib/auth/session";
import type { CompanionTask, CompanionConfirmation, CompanionProcessRecord } from "../src/lib/session/types";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.pathname, "/postgres");
  assert.equal(target.username, "postgres"); assert.equal(target.password, ""); assert.ok(target.port);
  const { prisma } = await import("../src/lib/db/client");
  let outputDirectory: string | undefined;
  try {
    const rows = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(rows.length, 1, "Database must carry this run's disposable marker");
    outputDirectory = await mkdtemp(path.join(tmpdir(), "openpbl-collaboration-verification-"));
    process.env.UPLOAD_DIR = outputDirectory;
    process.env.JWT_SECRET = randomUUID() + randomUUID();
    delete process.env.REDIS_URL;
    const companion = await import("../src/lib/companion/server-store");
    const audit = await import("../src/lib/ai-collaboration/audit-store");
    const { authorizeLegacyAiScope } = await import("../src/lib/ai-collaboration/legacy-scope");
    const { readAiCollaboration } = await import("../src/lib/platform/ai-collaboration");
    const { listProjectDocumentVersions } = await import("../src/lib/project-practice/versions");
    const { POST: finalize } = await import("../src/app/api/project-practice/submissions/finalize/route");
    const { signStudentToken } = await import("../src/lib/auth/session");
    const user = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role, passwordHash: "verification-only-unusable-hash" } });
    const teacher = await user("collaboration-teacher", "TEACHER");
    const alice = await user("collaboration-alice");
    const bob = await user("collaboration-bob");
    const offering = await prisma.courseOffering.create({ data: { name: "Collaboration verification", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const enrollment = await prisma.enrollment.create({ data: { offeringId: offering.id, userId: alice.id } });
    const otherEnrollment = await prisma.enrollment.create({ data: { offeringId: offering.id, userId: bob.id } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "Research", position: 0, isOpen: true } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "Document practice", type: "CLASSROOM", position: 0, isOpen: true } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "Collaboration" } });
    const templateVersion = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { title: "Verification lesson" } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: templateVersion.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
    await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: otherEnrollment.id } });
    const claims: AuthClaims = { sub: alice.id, role: "student", studentName: alice.displayName, sv: alice.sessionVersion };
    const otherClaims: AuthClaims = { sub: bob.id, role: "student", studentName: bob.displayName, sv: bob.sessionVersion };
    assert.equal((await authorizeLegacyAiScope(claims, instance.id, alice.id)).participation?.id, participation.id);
    await assert.rejects(() => authorizeLegacyAiScope(otherClaims, instance.id, alice.id), (error: { code: string }) => error.code === "STUDENT_SCOPE_MISMATCH");

    const message = companion.companionMessage({ role: "student", content: "Verification research question", visibility: "student-and-teacher", conversationId: "verification-logical" });
    const privateMessage = companion.companionMessage({ role: "system-trigger", content: "Teacher-only verification note", visibility: "teacher-only", conversationId: "verification-logical" });
    await Promise.all(Array.from({ length: 3 }, () => companion.appendCompanionMessages({ courseId: instance.id, studentId: alice.id, stageKey: "make", messages: [message, privateMessage] })));
    const thread = await companion.getCompanionThread(instance.id, alice.id, "make");
    assert.equal(thread?.messages.length, 2);
    assert.equal(await prisma.aiMessage.count({ where: { conversationId: thread!.id } }), 2);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { conversationId: thread!.id, researchKey: enrollment.researchKey } }), 2);
    assert.equal(await companion.softDeleteCompanionMessage({ courseId: instance.id, studentId: alice.id, stageKey: "make", messageId: message.id, conversationId: "verification-logical" }), true);
    assert.equal((await prisma.aiMessage.findUniqueOrThrow({ where: { id: message.id } })).content, message.content);
    assert.equal((await readAiCollaboration(claims, participation.id)).conversations.find(row => row.id === thread!.id)?.messages.length, 0);
    console.log("PASS real V2 companion append concurrency, message deduplication, research linkage and hidden-message visibility");

    const now = new Date().toISOString();
    const task: CompanionTask = { id: randomUUID(), courseId: instance.id, studentId: alice.id, stageKey: "make", kind: "formal-action", title: "Verify proposal", request: "Save a verification proposal", status: "waiting-confirmation", createdAt: now, updatedAt: now };
    const confirmation: CompanionConfirmation = { id: randomUUID(), courseId: instance.id, studentId: alice.id, stageKey: "make", action: "save", title: "Confirm test proposal", summary: "Verification only", taskId: task.id, status: "pending", createdAt: now };
    const record: CompanionProcessRecord = { id: randomUUID(), courseId: instance.id, studentId: alice.id, stageKey: "make", title: "Process evidence", summary: "Verification evidence", source: "student", taskId: task.id, createdAt: now };
    task.confirmationId = confirmation.id;
    const before = await companion.loadCompanionState(instance.id);
    await prisma.$transaction(tx => companion.persistCompanionState(tx, instance.id, before, { ...before, companionTasks: [task], companionConfirmations: [confirmation], companionProcessRecords: [record] }, alice.id));
    const pending = await companion.loadCompanionState(instance.id);
    assert.equal(pending.companionTasks?.find(row => row.id === task.id)?.status, "waiting-confirmation");
    assert.equal(pending.companionConfirmations?.find(row => row.id === confirmation.id)?.status, "pending");
    const resolvedAt = new Date(Date.now() + 1).toISOString();
    await prisma.$transaction(tx => companion.persistCompanionState(tx, instance.id, pending, { ...pending, companionTasks: [{ ...task, status: "saved", result: "Confirmed test proposal", updatedAt: resolvedAt }], companionConfirmations: [{ ...confirmation, status: "confirmed", resolvedAt }] }, alice.id));
    assert.equal((await prisma.aiActionConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } })).status, "APPROVED");
    assert.equal((await prisma.aiTask.findUniqueOrThrow({ where: { id: task.id } })).status, "SAVED");
    assert.equal(await prisma.aiSupportRecord.count({ where: { participationId: participation.id, type: "COMPANION_PROCESS" } }), 1);
    assert.equal(await prisma.domainEvent.count({ where: { participationId: participation.id, researchKey: enrollment.researchKey } }), 5);
    console.log("PASS real V2 companion task, confirmation and process-record round trips with durable domain facts");

    const auditInput = { courseId: instance.id, studentId: alice.id, stageKey: "make", conversationId: "verification-logical", source: "sidebar" as const, eventType: "decision" as const, actorRole: "student" as const, content: "Verification confirmed", requestId: "verification-audit-request" };
    await Promise.all([audit.appendAiInteractionEvents([auditInput]), audit.appendAiInteractionEvents([auditInput])]);
    const auditRows = await audit.listAiInteractionEvents({ courseId: instance.id, studentId: alice.id, stageKey: "make", limit: 1 });
    assert.equal(auditRows.events.length, 1); assert.ok(auditRows.nextCursor);
    assert.equal(auditRows.events[0].conversationId, "verification-logical");
    assert.equal(await prisma.aiInteractionEvent.count({ where: { participationId: participation.id, requestId: auditInput.requestId } }), 1);
    const invalidAudit = { ...auditInput, courseId: randomUUID(), requestId: "invalid" };
    await assert.rejects(() => audit.appendAiInteractionEvents([invalidAudit]), (error: { code: string }) => error.code === "EVENT_SCOPE_MISMATCH");
    console.log("PASS actual V2 audit logical-conversation mapping, request deduplication, scope rejection and pagination");

    const imageId = randomUUID();
    const imageName = `${imageId}.png`;
    const imageBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lM3pWQAAAABJRU5ErkJggg==", "base64");
    await writeFile(path.join(outputDirectory, imageName), imageBytes, { mode: 0o600, flag: "wx" });
    await prisma.fileAsset.create({ data: { id: imageId, originalName: "verification.png", storageKey: imageName, offeringId: offering.id, uploadedById: alice.id, mimeType: "image/png", size: BigInt(imageBytes.length) } });
    const logicalSubmissionId = randomUUID();
    const draft = { id: logicalSubmissionId, courseId: instance.id, studentId: alice.id, stageKey: "make", type: "document", title: "Verification artifact", content: `<h1>Verification artifact</h1><p>Immutable evidence from a disposable test database.</p><img src="/api/uploads/${imageId}" alt="verification">`, version: 1, status: "draft", createdAt: now, updatedAt: now };
    const submission = await prisma.classroomSubmission.create({ data: { participationId: participation.id, stageKey: "make:document", payload: { collection: "submissions", view: draft } } });
    const token = await signStudentToken({ userId: alice.id, studentName: alice.displayName, sessionVersion: alice.sessionVersion });
    const request = (requestId: string, expectedVersion = 1) => new Request("http://localhost/api/project-practice/submissions/finalize", { method: "POST", headers: { origin: "http://localhost", cookie: `${token.cookieName}=${token.token}`, "content-type": "application/json", "x-openpbl-role": "student" }, body: JSON.stringify({ courseId: instance.id, submissionId: logicalSubmissionId, studentId: alice.id, stageKey: "make", expectedVersion, requestId }) });
    const first = await finalize(request("document-first"));
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const result = await first.json() as { versionId: string; docxUploadId: string; sha256: string; sequence: number };
    assert.equal(result.sequence, 1);
    const version = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: result.versionId } });
    assert.equal(version.artifactId, `document:${submission.id}`); assert.equal(version.fileAssetId, result.docxUploadId); assert.ok(version.sourceHtml?.includes("data:image/png;base64,"));
    const file = await prisma.fileAsset.findUniqueOrThrow({ where: { id: result.docxUploadId } });
    const bytes = await readFile(path.join(outputDirectory, file.storageKey));
    assert.equal(bytes.subarray(0, 2).toString(), "PK"); assert.equal(createHash("sha256").update(bytes).digest("hex"), result.sha256);
    const retry = await finalize(request("document-first"));
    assert.equal(retry.status, 200); assert.equal((await retry.json()).versionId, result.versionId);
    assert.equal((await finalize(request("document-first", 2))).status, 409);
    assert.equal((await finalize(request("document-stale", 2))).status, 409);
    assert.equal(await prisma.artifactVersion.count({ where: { artifactId: version.artifactId } }), 1);
    assert.equal((await readdir(outputDirectory)).length, 2);
    const archiveVersions = await listProjectDocumentVersions({ courseId: instance.id, studentId: alice.id, submissionId: logicalSubmissionId, stageKey: "make" });
    assert.equal(archiveVersions[0].id, result.versionId); assert.equal(archiveVersions[0].sourceVersion, 1);
    const receipt = await prisma.domainEvent.findFirstOrThrow({ where: { participationId: participation.id, eventType: "document_version_submitted" } });
    assert.equal(receipt.researchKey, enrollment.researchKey);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { participationId: participation.id, eventType: "submit", researchKey: enrollment.researchKey } }), 1);
    console.log("PASS real authenticated DOCX finalization, FileAsset/ArtifactVersion binding, digest, receipt idempotency and stale-draft rejection");

    const { exportOfferingResearch } = await import("../src/lib/platform/research-export");
    const teacherClaims: AuthClaims = { sub: teacher.id, role: "teacher", username: teacher.username, displayName: teacher.displayName, sv: teacher.sessionVersion };
    const exportPages = async (type: "ai" | "domain", includeContent: boolean) => {
      const exported: Array<Record<string, unknown>> = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const page = await exportOfferingResearch(teacherClaims, offering.id, { type, take: "1", includeContent: String(includeContent), ...(cursor ? { cursor } : {}) });
        exported.push(...page.rows); cursor = page.nextCursor; pages += 1;
      } while (cursor);
      assert.ok(pages > 1, "Verify the actual cursor across multiple database pages");
      assert.equal(new Set(exported.map(row => row.id)).size, exported.length);
      return exported;
    };
    const aiExport = await exportPages("ai", false);
    assert.equal(aiExport.length, await prisma.aiInteractionEvent.count({ where: { offeringId: offering.id } }));
    assert.ok(aiExport.every(row => row.researchKey === enrollment.researchKey && !("userId" in row) && !("payload" in row) && !("content" in row)));
    const domainExport = await exportPages("domain", false);
    assert.equal(domainExport.length, await prisma.domainEvent.count({ where: { offeringId: offering.id } }));
    assert.ok(domainExport.some(row => row.eventType === "companion_confirmation_changed"));
    assert.ok(domainExport.some(row => row.eventType === "document_version_submitted"));
    assert.ok(domainExport.every(row => !("actorId" in row) && !("payload" in row)));
    assert.ok((await exportPages("ai", true)).some(row => row.content === "Verification confirmed"));
    assert.ok((await exportPages("domain", true)).every(row => "payload" in row));
    console.log("PASS real AI/domain research export pagination, complete category coverage and opt-in content whitelist");

    const { projectGroupStorageId, resolveProjectGroupId } = await import("../src/lib/platform/group-identity");
    const { createShowcaseStore } = await import("../src/lib/showcase/persistence");
    const { executeShowcaseAction } = await import("../src/lib/showcase/presentation-service");
    const { POST: uploadArtifact } = await import("../src/app/api/courses/[courseId]/showcase/artifacts/pdf/route");
    const secondOffering = await prisma.courseOffering.create({ data: { name: "Second collaboration class", status: "OPEN", teachers: { create: { userId: teacher.id } } } });
    const secondEnrollment = await prisma.enrollment.create({ data: { offeringId: secondOffering.id, userId: alice.id } });
    const secondChapter = await prisma.chapter.create({ data: { offeringId: secondOffering.id, title: "Second research", position: 0, isOpen: true } });
    const secondActivity = await prisma.activity.create({ data: { chapterId: secondChapter.id, title: "Second practice", type: "CLASSROOM", position: 0, isOpen: true } });
    const secondInstance = await prisma.classroomInstance.create({ data: { activityId: secondActivity.id, templateVersionId: templateVersion.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const secondParticipation = await prisma.classroomParticipation.create({ data: { instanceId: secondInstance.id, enrollmentId: secondEnrollment.id } });
    const alias = `grp-${alice.id}`;
    const store = createShowcaseStore();
    for (const scope of [{ offering, instance, participation }, { offering: secondOffering, instance: secondInstance, participation: secondParticipation }]) {
      const groupId = projectGroupStorageId(scope.offering.id, alias);
      await prisma.projectGroup.create({ data: { id: groupId, offeringId: scope.offering.id, name: "Personal project", members: { create: { userId: alice.id, participationId: scope.participation.id } } } });
      assert.equal((await store.findMember({ where: { courseId: scope.instance.id, studentId: alice.id } }))?.groupId, alias);
      const form = new FormData();
      form.set("file", new File(["Verification external artifact"], "verification.txt", { type: "text/plain" }));
      form.set("title", "Personal project evidence"); form.set("requestId", randomUUID());
      const upload = await uploadArtifact(new Request(`http://localhost/api/courses/${scope.instance.id}/showcase/artifacts/pdf`, { method: "POST", headers: { origin: "http://localhost", cookie: `${token.cookieName}=${token.token}`, "x-openpbl-role": "student" }, body: form }), { params: Promise.resolve({ courseId: scope.instance.id }) });
      assert.equal(upload.status, 201, JSON.stringify(await upload.clone().json()));
      const uploaded = await upload.json() as { versionId: string };
      const uploadedVersion = await prisma.artifactVersion.findUniqueOrThrow({ where: { id: uploaded.versionId }, include: { artifact: true } });
      assert.equal(uploadedVersion.artifact.groupId, groupId);
      assert.equal((await store.listFiles({ where: { courseId: scope.instance.id, studentId: alice.id } }))[0].groupId, alias);
      const documentVersion = scope.instance.id === instance.id ? version : await prisma.artifactVersion.create({ data: { artifact: { create: { participationId: scope.participation.id, groupId, title: "Second document", type: "DOCUMENT_ARCHIVE", status: "SUBMITTED" } }, sequence: 1, sourceHtml: "<p>Second class evidence</p>", status: "SUBMITTED", submittedAt: new Date() } });
      await prisma.classroomInstance.update({ where: { id: scope.instance.id }, data: { runtimeConfig: { version: 1, currentStageIndex: 3 } } });
      await executeShowcaseAction(scope.instance.id, { action: "assign", groupId: alias, studentId: alice.id }, teacherClaims);
      if (scope.instance.id === secondInstance.id) await assert.rejects(() => executeShowcaseAction(scope.instance.id, { action: "request", artifactKind: "document", artifactVersionId: version.id, displayMode: "continuous" }, claims), (error: { code: string }) => error.code === "ARTIFACT_NOT_LATEST");
      const requested = await executeShowcaseAction(scope.instance.id, { action: "request", artifactKind: "document", artifactVersionId: documentVersion.id, displayMode: "continuous", requestId: randomUUID() }, claims);
      assert.ok("id" in requested); assert.ok("groupId" in requested && requested.groupId === alias);
      const storedPresentation = await prisma.showcasePresentation.findUniqueOrThrow({ where: { id: requested.id } });
      assert.equal(storedPresentation.groupId, groupId); assert.equal(storedPresentation.artifactVersionId, documentVersion.id);
      await executeShowcaseAction(scope.instance.id, { action: "review", presentationId: requested.id, decision: "approve" }, teacherClaims);
      await executeShowcaseAction(scope.instance.id, { action: "end", presentationId: requested.id }, claims);
      await executeShowcaseAction(scope.instance.id, { action: "finish-evaluation", presentationId: requested.id }, teacherClaims);
    }
    assert.notEqual(projectGroupStorageId(offering.id, alias), projectGroupStorageId(secondOffering.id, alias));
    assert.equal(await resolveProjectGroupId(prisma, secondOffering.id, projectGroupStorageId(offering.id, alias)), null);
    console.log("PASS same student in two offerings: personal group aliases, uploaded artifact FKs and full document showcase lifecycle");

    for (const operation of [() => prisma.user.delete({ where: { id: alice.id } }), () => prisma.classroomParticipation.delete({ where: { id: participation.id } }), () => prisma.aiConversation.delete({ where: { id: thread!.id } }), () => prisma.artifact.delete({ where: { id: version.artifactId } }), () => prisma.fileAsset.delete({ where: { id: result.docxUploadId } })]) {
      await assert.rejects(operation, (error: { code: string }) => error.code === "P2003");
    }
    assert.equal(await prisma.artifactVersion.count({ where: { id: result.versionId } }), 1);
    assert.equal((await prisma.aiMessage.findUniqueOrThrow({ where: { id: message.id } })).content, message.content);
    console.log("PASS research delete restrictions retain AI conversation/message and submitted artifact evidence");
  } finally {
    try { await prisma.$disconnect(); }
    finally { if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true }); }
  }
}
main().catch((error: unknown) => { console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Collaboration verification failed"); process.exitCode = 1; });
