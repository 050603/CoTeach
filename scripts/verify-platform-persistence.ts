// Invoked only by verify-research-database.mjs against its disposable container.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { AuthClaims } from "../src/lib/auth/session";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/,
    "Run through verify-research-database.mjs; an isolation marker is required");
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.pathname, "/postgres");
  assert.equal(target.username, "postgres");
  assert.equal(target.password, "");
  assert.ok(target.port, "A disposable container port is required");
  const { prisma } = await import("../src/lib/db/client");
  try {
    // Verify a nonce stored by the parent before importing any business mutation code.
    const matching = await prisma.$queryRaw<Array<{ marker: string }>>`
      SELECT "marker" FROM "_OpenpblVerification" WHERE "marker" = ${marker}`;
    assert.equal(matching.length, 1, "Database does not carry this run's isolation marker");
    const repo = await import("../src/lib/platform/repository");
    const { submitActivity } = await import("../src/lib/platform/submissions");
    const { appendValidatedLearningEvents } = await import("../src/lib/platform/learning-events");
    const password = randomUUID();
    const teacher = await prisma.user.create({ data: {
      username: "verification-teacher", usernameKey: "verification-teacher", displayName: "Verification teacher",
      role: "TEACHER", passwordHash: "test-only-unusable-hash",
    } });
    const teacherClaims: AuthClaims = { sub: teacher.id, role: "teacher", username: teacher.username, displayName: teacher.displayName, sv: 1 };
    const course = await repo.createOffering(teacherClaims, { name: "Persistence verification" });
    const invite = await repo.resetOfferingInvitation(teacherClaims, course.id, {});
    const registration = (username: string, invitationCode = invite.code) => repo.registerStudent({
      invitationCode, username, displayName: username, password,
    });
    const alice = await registration("verification-alice");
    const bob = await registration("verification-bob");
    const studentClaims = (user: typeof alice.user): AuthClaims => ({ sub: user.id, role: "student", studentName: user.displayName, sv: user.sessionVersion });
    const aliceClaims = studentClaims(alice.user);
    const bobClaims = studentClaims(bob.user);
    assert.equal((await repo.loginStudent(alice.user.username, password)).id, alice.user.id);
    assert.ok((await repo.listTeacherOfferings(teacherClaims)).some((row) => row.id === course.id));
    assert.ok((await repo.listStudentOfferings(aliceClaims)).some((row) => row.id === course.id));

    const chapters = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      repo.createChapter(teacherClaims, course.id, { title: `Chapter ${index}` })));
    assert.deepEqual(chapters.map((row) => row.position).sort(), [0, 1, 2, 3]);
    const template = await repo.createPrivateTemplate(teacherClaims, { title: "Reusable lesson", snapshot: { slides: [] } });
    const versions = await Promise.all(Array.from({ length: 4 }, (_, index) =>
      repo.createTemplateVersion(teacherClaims, template.id, { snapshot: { revision: index } })));
    assert.deepEqual(versions.map((row) => row.version).sort(), [2, 3, 4, 5]);
    const chapter = chapters[0];
    const activity = await repo.createActivity(teacherClaims, course.id, chapter.id, {
      type: "Assignment", title: "Original assignment", config: { schemaVersion: 1, prompt: "Original prompt" },
    });
    await repo.updateChapter(teacherClaims, chapter.id, { isOpen: true });
    await repo.updateActivity(teacherClaims, activity.id, { isOpen: true });
    await repo.updateOffering(teacherClaims, course.id, { status: "OPEN" });
    console.log("PASS actual teacher/student repository creation, login and concurrent chapter/template numbering");

    const quotaCourse = await repo.createOffering(teacherClaims, { name: "One seat" });
    const quota = await repo.resetOfferingInvitation(teacherClaims, quotaCourse.id, {});
    await prisma.courseInvitation.update({ where: { id: quota.id }, data: { maxUses: 1 } });
    const joins = await Promise.allSettled([
      repo.joinOffering(aliceClaims, quota.code), repo.joinOffering(bobClaims, quota.code),
    ]);
    assert.equal(joins.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedJoin = joins.find((result) => result.status === "rejected");
    assert.ok(rejectedJoin?.status === "rejected" && rejectedJoin.reason.code === "INVITE_CODE_EXHAUSTED");
    assert.equal(await prisma.enrollment.count({ where: { offeringId: quotaCourse.id } }), 1);
    assert.equal((await prisma.courseInvitation.findUniqueOrThrow({ where: { id: quota.id } })).useCount, 1);
    const registerQuota = await repo.resetOfferingInvitation(teacherClaims, quotaCourse.id, {});
    await prisma.courseInvitation.update({ where: { id: registerQuota.id }, data: { maxUses: 1 } });
    const registers = await Promise.allSettled([
      registration("verification-quota-a", registerQuota.code), registration("verification-quota-b", registerQuota.code),
    ]);
    assert.equal(registers.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedRegistration = registers.find((result) => result.status === "rejected");
    assert.ok(rejectedRegistration?.status === "rejected" && rejectedRegistration.reason.code === "INVITE_CODE_EXHAUSTED");
    assert.equal(await prisma.user.count({ where: { usernameKey: { in: ["verification-quota-a", "verification-quota-b"] } } }), 1);
    assert.equal((await prisma.courseInvitation.findUniqueOrThrow({ where: { id: registerQuota.id } })).useCount, 1);

    const multiInviteCourse = await repo.createOffering(teacherClaims, { name: "Two invitation paths" });
    const firstInvite = await repo.resetOfferingInvitation(teacherClaims, multiInviteCourse.id, {});
    // The UI rotates invitations; this fixture also exercises historical/multi-invitation concurrency.
    const secondInvite = await prisma.courseInvitation.create({ data: { offeringId: multiInviteCourse.id, code: "VERIFYSECOND", maxUses: 1 } });
    const sameStudentJoins = await Promise.all([
      repo.joinOffering(aliceClaims, firstInvite.code), repo.joinOffering(aliceClaims, secondInvite.code),
    ]);
    assert.equal(sameStudentJoins[0].id, sameStudentJoins[1].id);
    assert.equal(await prisma.enrollment.count({ where: { offeringId: multiInviteCourse.id, userId: alice.user.id } }), 1);
    assert.equal((await prisma.courseInvitation.aggregate({ where: { offeringId: multiInviteCourse.id }, _sum: { useCount: true } }))._sum.useCount, 1);
    console.log("PASS actual concurrent registration/join quotas and same-student enrollment deduplication");

    const reset = await repo.requestStudentPasswordReset(teacherClaims, alice.enrollment.id);
    const resetPassword = randomUUID();
    const resets = await Promise.allSettled([
      repo.resetStudentPassword(reset.token, resetPassword), repo.resetStudentPassword(reset.token, resetPassword),
    ]);
    assert.equal(resets.filter((result) => result.status === "fulfilled").length, 1);
    const rejectedReset = resets.find((result) => result.status === "rejected");
    assert.ok(rejectedReset?.status === "rejected" && rejectedReset.reason.code === "RESET_TOKEN_INVALID");
    const resetUser = await repo.loginStudent(alice.user.username, resetPassword);
    assert.equal(resetUser.sessionVersion, alice.user.sessionVersion + 1);
    const currentClaims = studentClaims(resetUser);
    console.log("PASS actual single-use password reset under concurrent consumption");

    await submitActivity(currentClaims, activity.id, { answer: "First answer" });
    await repo.updateActivity(teacherClaims, activity.id, { title: "Revised assignment", config: { schemaVersion: 1, prompt: "Revised prompt" } });
    await Promise.all([
      submitActivity(currentClaims, activity.id, { answer: "Second answer" }),
      ...Array.from({ length: 4 }, () => repo.getStudentActivity(currentClaims, activity.id)),
    ]);
    const history = await prisma.activitySubmission.findMany({ where: { enrollmentId: alice.enrollment.id, activityId: activity.id }, orderBy: { submittedAt: "asc" } });
    assert.equal(history.length, 2);
    assert.deepEqual(history.map((row) => (row.payload as { answer: string }).answer), ["First answer", "Second answer"]);
    assert.deepEqual(history.map((row) => (row.activitySnapshot as { title: string }).title), ["Original assignment", "Revised assignment"]);
    assert.ok(history.every((row) => row.researchKey === alice.enrollment.researchKey));
    const progress = await prisma.activityProgress.findUniqueOrThrow({ where: { enrollmentId_activityId: { enrollmentId: alice.enrollment.id, activityId: activity.id } } });
    assert.equal(progress.status, "COMPLETED");
    assert.equal((progress.progressData as { answer: string }).answer, "Second answer");
    assert.equal(progress.completedAt?.toISOString(), history[1].submittedAt.toISOString());
    assert.equal((await repo.getStudentActivity(currentClaims, activity.id)).progress.status, "completed");
    console.log("PASS actual resubmission history, progress consistency and concurrent access preserving completion");

    const foreignCourse = await repo.createOffering(teacherClaims, { name: "Unenrolled course" });
    const validEvent = { idempotencyKey: "actual-repository-event", type: "assignment_viewed", activityId: activity.id, durationMs: 123 };
    assert.deepEqual(await appendValidatedLearningEvents(currentClaims, [validEvent]), [validEvent.idempotencyKey]);
    await appendValidatedLearningEvents(currentClaims, [validEvent]);
    const fact = await prisma.learningEvent.findUniqueOrThrow({ where: { userId_idempotencyKey: { userId: alice.user.id, idempotencyKey: validEvent.idempotencyKey } } });
    assert.equal(fact.researchKey, alice.enrollment.researchKey);
    assert.equal(fact.enrollmentId, alice.enrollment.id);
    assert.equal(fact.offeringId, course.id);
    assert.equal(fact.chapterId, chapter.id);
    assert.equal(fact.durationMs, 123);
    await assert.rejects(() => appendValidatedLearningEvents(currentClaims, [
      { ...validEvent, idempotencyKey: "must-rollback-valid" },
      { ...validEvent, idempotencyKey: "cross-course", offeringId: foreignCourse.id },
    ]), (error: unknown) => error instanceof repo.PlatformError && error.code === "EVENT_SCOPE_MISMATCH");
    assert.equal(await prisma.learningEvent.count({ where: { idempotencyKey: { in: ["must-rollback-valid", "cross-course"] } } }), 0);
    await assert.rejects(() => appendValidatedLearningEvents(currentClaims, [
      { ...validEvent, idempotencyKey: "other-student", enrollmentId: bob.enrollment.id },
    ]), (error: unknown) => error instanceof repo.PlatformError && error.code === "EVENT_SCOPE_MISMATCH");
    console.log("PASS actual event context derivation, research identity, retries and atomic cross-course rejection");
    const providers = await import("../src/lib/openmaic-bridge/provider-config-editor");
    await Promise.all([
      providers.saveProviderEntry('providers', 'verification-provider', { apiKey: '', models: ['first'] }),
      providers.saveProviderEntry('providers', 'verification-provider', { apiKey: '', baseUrl: 'http://127.0.0.1:9' }),
    ]);
    assert.equal(await prisma.providerCredential.count({ where: { ownerId: null, name: 'providers', provider: 'verification-provider' } }), 1);
    assert.deepEqual(await providers.getProviderEntry('providers', 'verification-provider'), { apiKey: '', models: ['first'], baseUrl: 'http://127.0.0.1:9' });
    await providers.deleteProviderEntry('providers', 'verification-provider');
    assert.equal(await providers.getProviderEntry('providers', 'verification-provider'), null);
    const { persistUpload, hasSnapshotReference } = await import('../src/lib/uploads/assets');
    const assetId = randomUUID();
    await prisma.$transaction((tx) => persistUpload(tx, { id: assetId, originalName: 'lesson.pptx', storageKey: `${assetId}.pptx`,
      offeringId: course.id, uploadedById: teacher.id, size: 20, mimeType: 'application/zip', title: 'Lesson', type: 'PPTX', bind: true,
      stageKey: 'practice', previewStorageKey: `${assetId}.pdf`, previewMimeType: 'application/pdf', previewSize: 30 }));
    const resource = await prisma.resource.findUniqueOrThrow({ where: { fileAssetId: assetId }, include: { fileAsset: true } });
    assert.equal(resource.offeringId, course.id);
    assert.equal(resource.fileAsset?.size, BigInt(20));
    const previewAssetId = (resource.metadata as { previewAssetId: string }).previewAssetId;
    assert.equal((await prisma.fileAsset.findUniqueOrThrow({ where: { id: previewAssetId } })).mimeType, 'application/pdf');
    await submitActivity(currentClaims, activity.id, { answer: `/api/uploads/${assetId}` });
    assert.equal(await prisma.$transaction((tx) => hasSnapshotReference(tx, assetId)), true);
    console.log('PASS actual V2 global provider concurrency, resource/preview persistence and research snapshot references');
    const { createPblTemplateCourse, encodePblTemplate } = await import('../src/lib/platform/pbl-template');
    const showcaseTemplate = await repo.createPrivateTemplate(teacherClaims, { title: 'Showcase verification', snapshot: encodePblTemplate(createPblTemplateCourse('draft')) });
    const showcaseActivity = await repo.createActivity(teacherClaims, course.id, chapter.id, { type: 'Classroom', title: 'Showcase classroom', templateId: showcaseTemplate.id });
    const showcaseInstance = await prisma.classroomInstance.findFirstOrThrow({ where: { activityId: showcaseActivity.id } });
    await prisma.classroomInstance.update({ where: { id: showcaseInstance.id }, data: { status: 'TEACHING', runtimeConfig: { version: 1, currentStageIndex: 3 } } });
    const aliceParticipation = await prisma.classroomParticipation.create({ data: { instanceId: showcaseInstance.id, enrollmentId: alice.enrollment.id } });
    await prisma.classroomParticipation.create({ data: { instanceId: showcaseInstance.id, enrollmentId: bob.enrollment.id } });
    const group = await prisma.projectGroup.create({ data: { offeringId: course.id, name: 'Showcase team', members: { create: [{ userId: alice.user.id, participationId: aliceParticipation.id }, { userId: bob.user.id }] } } });
    const documentArtifact = await prisma.artifact.create({ data: { participationId: aliceParticipation.id, groupId: group.id, title: 'Student evidence', type: 'DOCUMENT_ARCHIVE', status: 'SUBMITTED' } });
    const documentVersion = await prisma.artifactVersion.create({ data: { artifactId: documentArtifact.id, sequence: 1, sourceHtml: '<p>Research evidence</p>', status: 'SUBMITTED', submittedAt: new Date() } });
    const showcase = await import('../src/lib/showcase/presentation-service');
    await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'assign', groupId: group.id, studentId: alice.user.id }, teacherClaims);
    const requested = await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'request', artifactKind: 'document', artifactVersionId: documentVersion.id, displayMode: 'continuous', requestId: 'showcase-retry' }, currentClaims);
    assert.ok('id' in requested);
    const retried = await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'request', artifactKind: 'document', artifactVersionId: documentVersion.id, displayMode: 'continuous', requestId: 'showcase-retry' }, currentClaims);
    assert.ok('id' in retried && requested.id === retried.id);
    assert.equal(await prisma.showcasePresentation.count({ where: { participationId: aliceParticipation.id } }), 1);
    await assert.rejects(() => showcase.executeShowcaseAction(showcaseInstance.id, { action: 'request', artifactKind: 'document', artifactVersionId: documentVersion.id, displayMode: 'continuous' }, bobClaims), (error: unknown) => error instanceof showcase.ShowcasePresentationError && error.code === 'PRESENTER_NOT_ASSIGNED');
    const approved = await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'review', presentationId: requested.id, decision: 'approve' }, teacherClaims);
    assert.ok('status' in approved && approved.status === 'active');
    const updated = await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'update', presentationId: requested.id, viewState: { scrollRatio: 0.5 } }, currentClaims);
    assert.ok('viewState' in updated && updated.viewState?.scrollRatio === 0.5);
    const ended = await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'end', presentationId: requested.id }, currentClaims);
    assert.ok('status' in ended && ended.status === 'evaluating');
    await showcase.executeShowcaseAction(showcaseInstance.id, { action: 'finish-evaluation', presentationId: requested.id, note: 'Private teacher assessment' }, teacherClaims);
    const projectedShowcase = await showcase.loadShowcaseState(showcaseInstance.id);
    assert.equal(projectedShowcase.showcasePresentations[0].status, 'ended');
    assert.equal(projectedShowcase.showcasePresentations[0].evaluationNote, 'Private teacher assessment');
    const peerShowcase = await showcase.getShowcaseData(showcaseInstance.id, bobClaims);
    assert.ok(!JSON.stringify(peerShowcase).includes('Private teacher assessment'));
    const boundPresentation = await prisma.showcasePresentation.findUniqueOrThrow({ where: { id: requested.id } });
    assert.equal(boundPresentation.artifactId, documentArtifact.id); assert.equal(boundPresentation.artifactVersionId, documentVersion.id);
    console.log('PASS actual showcase assignment, idempotent request, review, projection, evaluation and private evidence lifecycle');
  } finally { await prisma.$disconnect(); }
}

main().catch((error: unknown) => {
  // Never print runtime passwords or password-reset tokens, including on assertion failures.
  console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Persistence verification failed");
  process.exitCode = 1;
});
