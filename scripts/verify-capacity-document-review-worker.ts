// Invoked only by the marked, disposable PostgreSQL verification harness.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import type { DocumentRequestInput } from "../src/lib/ai-collaboration/document-request-store";

async function main() {
  const marker = process.env.OPENPBL_VERIFICATION_MARKER;
  assert.match(marker ?? "", /^openpbl-research-check-[0-9a-f-]{36}$/);
  const target = new URL(process.env.DATABASE_URL ?? "");
  assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.username, "postgres");
  assert.equal(target.password, ""); assert.equal(target.pathname, "/postgres"); assert.ok(target.port);
  const { prisma } = await import("../src/lib/db/client");
  let temporary: string | undefined;
  const originalDirectory = process.cwd();
  const responses: string[] = [];
  let modelCalls = 0;
  const modelServer = createServer(async (request, response) => {
    for await (const chunk of request) void chunk;
    modelCalls++;
    const content = responses.shift();
    if (content === undefined) { response.writeHead(500).end(); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
  try {
    const nonce = await prisma.$queryRaw<Array<{ marker: string }>>`SELECT marker FROM "_OpenpblVerification" WHERE marker = ${marker}`;
    assert.equal(nonce.length, 1, "Disposable database nonce is required");
    delete process.env.REDIS_URL;
    const { claimDocumentRequest, completeDocumentRequest, getDocumentRequest } = await import("../src/lib/ai-collaboration/document-request-store");
    const { appendAiInteractionEvents } = await import("../src/lib/ai-collaboration/audit-store");
    const { companionMessage } = await import("../src/lib/companion/server-store");
    const user = (name: string, role = "STUDENT") => prisma.user.create({ data: { username: name, usernameKey: name, displayName: name, role, passwordHash: "test-only-unusable" } });
    const teacher = await user("review-teacher", "TEACHER");
    const offering = await prisma.courseOffering.create({ data: { name: "Isolated review verification", status: "OPEN" } });
    const chapter = await prisma.chapter.create({ data: { offeringId: offering.id, title: "Verification", position: 0 } });
    const activity = await prisma.activity.create({ data: { chapterId: chapter.id, title: "Practice", type: "CLASSROOM", position: 0 } });
    const template = await prisma.classroomTemplate.create({ data: { ownerId: teacher.id, title: "Review" } });
    const version = await prisma.classroomTemplateVersion.create({ data: { templateId: template.id, version: 1, status: "PUBLISHED", snapshot: { title: "Review" } } });
    const instance = await prisma.classroomInstance.create({ data: { activityId: activity.id, templateVersionId: version.id, status: "TEACHING", runtimeConfig: { version: 1, currentStageIndex: 2 } } });
    const students = await Promise.all(Array.from({ length: 40 }, async (_, index) => {
      const student = await user(`review-student-${index}`);
      const enrollment = await prisma.enrollment.create({ data: { userId: student.id, offeringId: offering.id } });
      const participation = await prisma.classroomParticipation.create({ data: { instanceId: instance.id, enrollmentId: enrollment.id } });
      const input: DocumentRequestInput = { requestId: randomUUID(), participationId: participation.id, studentId: student.id,
        courseId: instance.id, stageKey: "make", workspaceKind: "document", threadStageKey: "ai-collaboration-comments:make",
        conversationId: "proactive-document-comment", documentVersion: `document-${index}`, message: `Paragraph ${index}`,
        intent: "proactive-document-comment", fingerprint: `fingerprint-${index}`, history: [] };
      return { input, enrollment, comment: index % 2 === 0 };
    }));
    const prepare = async (student: typeof students[number]) => {
      const claim = await claimDocumentRequest(student.input); assert.equal(claim.kind, "run");
      if (claim.kind !== "run") throw new Error("Expected a new review claim");
      const raw = JSON.stringify({ shouldComment: student.comment, reason: "完整独立模型证据".repeat(2000) });
      const rawSha256 = createHash("sha256").update(raw).digest("hex");
      await appendAiInteractionEvents([{ id: `document-review-model:${claim.token}:1`, ...student.input, source: "proactive-comment",
        eventType: "response", actorRole: "system", content: raw,
        payload: { kind: "model-output", requestAttemptId: claim.token, modelAttempt: 1, rawSha256, rawLength: raw.length } }]);
      const reviewDecision = { outcome: student.comment ? "comment" : "no-comment", reasonCodes: student.comment ? [] : ["MODEL_NO_COMMENT"],
        modelShouldComment: student.comment, reviewVersion: 4, rawSha256 };
      const messages = student.comment ? [companionMessage({ role: "system-trigger", content: "Review anchor", visibility: "teacher-only" }),
        companionMessage({ role: "agent", content: "Independent supported comment", visibility: "student-and-teacher" })] : [];
      const response = { requestId: student.input.requestId, status: "completed", commentThread: student.comment ? { id: messages[1].id } : null, reviewDecision };
      const auditEvents = [{ idempotencyKey: `document-review-decision:${student.input.participationId}:${student.input.requestId}`,
        eventType: "policy", actor: "system" as const, content: reviewDecision.outcome,
        payload: { schemaVersion: 1, detail: { kind: "document-comment-review", ...reviewDecision } } }];
      return { ...student.input, token: claim.token, messages, response, auditEvents, raw, rawSha256 };
    };
    const prepared = await Promise.all(students.map(prepare));
    await Promise.all(prepared.map(async completion => assert.equal(await completeDocumentRequest(completion), true)));
    await Promise.all(prepared.map(async (completion, index) => {
      const duplicate = await claimDocumentRequest(completion); assert.equal(duplicate.kind, "existing");
      if (duplicate.kind === "existing") assert.deepEqual(duplicate.state.response, completion.response);
      assert.equal(await completeDocumentRequest(completion), false);
      assert.equal((await claimDocumentRequest({ ...completion, fingerprint: "different" })).kind, "conflict");
      const events = await prisma.aiInteractionEvent.findMany({ where: { participationId: completion.participationId, requestId: completion.requestId } });
      assert.equal(events.length, 2); assert.ok(events.every(row => row.userId === completion.studentId && row.researchKey === students[index].enrollment.researchKey));
      assert.equal(events.find(row => row.eventType === "response")?.content, completion.raw);
      assert.equal(createHash("sha256").update(events.find(row => row.eventType === "response")!.content!).digest("hex"), completion.rawSha256);
      assert.equal(await prisma.aiMessage.count({ where: { conversation: { participationId: completion.participationId } } }), students[index].comment ? 2 : 0);
    }));
    console.log("PASS 40 concurrent reviews: 20 comments / 20 no-comment; full 16K+ raw evidence, ownership, exact completed replay, conflicting input rejected, no fake no-comment messages");

    const failureInput = { ...students[0], input: { ...students[0].input, requestId: randomUUID(), fingerprint: "fault" } };
    const failure = await prepare(failureInput);
    const beforeMessages = await prisma.aiMessage.count();
    await prisma.$executeRawUnsafe(`CREATE FUNCTION reject_review_decision() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW."eventType" = 'policy' THEN RAISE EXCEPTION 'injected review decision failure'; END IF; RETURN NEW; END; $$`);
    await prisma.$executeRawUnsafe('CREATE TRIGGER reject_review_decision BEFORE INSERT ON "AiInteractionEvent" FOR EACH ROW EXECUTE FUNCTION reject_review_decision()');
    await assert.rejects(() => completeDocumentRequest(failure));
    assert.equal(await prisma.aiMessage.count(), beforeMessages);
    assert.equal((await getDocumentRequest(failure))?.status, "processing");
    assert.equal(await prisma.aiInteractionEvent.count({ where: { requestId: failure.requestId } }), 1, "Raw evidence survives; transactional decision and message facts roll back");
    await prisma.$executeRawUnsafe('DROP TRIGGER reject_review_decision ON "AiInteractionEvent"');
    assert.equal(await completeDocumentRequest(failure), true);
    assert.equal((await getDocumentRequest(failure))?.status, "completed");
    assert.equal(await prisma.aiMessage.count(), beforeMessages + 2);
    console.log("PASS injected audit failure rolls back actual PostgreSQL messages and task completion, preserves original raw, and then completes once after recovery");

    // Import the actual HTTP route only after moving into an empty directory:
    // neither local deployment settings nor supplier credentials are accessible.
    temporary = await mkdtemp(path.join(tmpdir(), "openpbl-review-http-"));
    process.chdir(temporary);
    process.env.JWT_SECRET = randomUUID() + randomUUID();
    process.env.AI_AUDIT_OUTBOX_DIR = path.join(temporary, "audit-outbox");
    process.env.DOCUMENT_AI_PROACTIVE_REVIEW_ENABLED = "true";
    await new Promise<void>(resolve => modelServer.listen(0, "127.0.0.1", resolve));
    const binding = modelServer.address(); assert.ok(binding && typeof binding === "object");
    process.env.OPENPBL_LLM_ENDPOINT = `http://127.0.0.1:${binding.port}`;
    process.env.OPENPBL_LLM_API_KEY = "isolated-test-placeholder";
    process.env.OPENPBL_LLM_MODEL = "isolated-model";
    for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[key];
    process.env.NO_PROXY = "*"; process.env.no_proxy = "*";
    const { NextRequest } = await import("next/server");
    const { signStudentToken } = await import("../src/lib/auth/session");
    const { POST, GET } = await import("../src/app/api/ai-collaboration/document/route");
    const student = students[1];
    const account = await prisma.user.findUniqueOrThrow({ where: { id: student.input.studentId } });
    const auth = await signStudentToken({ userId: account.id, studentName: account.displayName, sessionVersion: account.sessionVersion });
    const send = (body: Record<string, unknown>) => POST(new NextRequest("http://localhost/api/ai-collaboration/document", {
      method: "POST", headers: { origin: "http://localhost", cookie: `${auth.cookieName}=${auth.token}`, "content-type": "application/json", "x-openpbl-role": "student" },
      body: JSON.stringify({ courseId: instance.id, studentId: account.id, stageKey: "make", workspaceKind: "document", ...body }),
    }));
    const singleId = randomUUID();
    const single = { requestId: singleId, action: "proactive-document-comment", targetText: "这是有据可查且没有矛盾的课堂记录。", blockIndex: 0,
      blockId: "isolated-single", documentHtml: " \n<p>这是有据可查且没有矛盾的课堂记录。</p>\t " };
    const singleRaw = JSON.stringify({ shouldComment: false, reason: "未发现必须立即介入的问题。".repeat(2000) });
    responses.push(singleRaw);
    const singleResponse = await send(single); assert.equal(singleResponse.status, 200, await singleResponse.clone().text());
    const singleReceipt = await singleResponse.json();
    assert.equal(singleReceipt.documentVersion, createHash("sha256").update(JSON.stringify(single.documentHtml)).digest("hex"), "Accepted whitespace is part of the exact document digest");
    assert.equal(singleReceipt.reviewDecision.outcome, "no-comment"); assert.deepEqual(singleReceipt.reviewDecision.reasonCodes, ["MODEL_NO_COMMENT"]);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { requestId: singleId } }), 2);
    assert.equal((await prisma.aiInteractionEvent.findFirstOrThrow({ where: { requestId: singleId, eventType: "response" } })).content, singleRaw);
    const callsBeforeReplay = modelCalls;
    assert.deepEqual(await (await send(single)).json(), singleReceipt); assert.equal(modelCalls, callsBeforeReplay);
    assert.equal((await send({ ...single, documentHtml: "<p>Changed document</p>" })).status, 409);
    const tooLongId = randomUUID();
    assert.equal((await send({ ...single, requestId: tooLongId, documentHtml: "稿".repeat(120_001) })).status, 413);
    assert.equal(await prisma.aiTask.count({ where: { input: { path: ["requestId"], equals: tooLongId } } }), 0);
    assert.equal(modelCalls, callsBeforeReplay, "Oversized context must not reach the model");

    const batchId = randomUUID(); const candidate = { candidateId: "p1", blockId: "isolated-batch", blockIndex: 1, targetText: "另一段有据可查且没有矛盾的课堂记录。" };
    const batch = { requestId: batchId, action: "proactive-document-comments", paragraphs: [candidate], documentHtml: `<p>${candidate.targetText}</p>` };
    const invalidRaw = '{"checkedCandidateIds":';
    const batchRaw = JSON.stringify({ checkedCandidateIds: [candidate.candidateId], complete: true, comments: [], reason: "未发现关键问题。".repeat(2000) });
    responses.push(invalidRaw, batchRaw);
    const batchResponse = await send(batch); assert.equal(batchResponse.status, 200, await batchResponse.clone().text());
    const batchReceipt = await batchResponse.json();
    assert.equal(batchReceipt.reviewDecision.outcome, "no-comment");
    assert.equal(batchReceipt.reviewDecision.rawOutputs.length, 2);
    const batchFacts = await prisma.aiInteractionEvent.findMany({ where: { requestId: batchId } });
    assert.equal(batchFacts.length, 3); assert.ok(batchFacts.some(row => row.content === invalidRaw)); assert.ok(batchFacts.some(row => row.content === batchRaw));
    const callsBeforeBatchReplay = modelCalls;
    assert.deepEqual(await (await send(batch)).json(), batchReceipt); assert.equal(modelCalls, callsBeforeBatchReplay);

    const positiveId = randomUUID();
    const positiveText = "改造前用电10度，改造后用电12度，所以节省2度电。";
    responses.push(JSON.stringify({ shouldComment: true, severity: "critical", needsInterventionNow: true, issueType: "数据矛盾",
      quotedText: "所以节省2度电", evidenceSource: "document", evidenceQuote: "改造前用电10度，改造后用电12度",
      impact: "这会导致错误评价项目的节能效果", comment: "可以先核对改造前后的数值，再计算节能量。" }));
    const positive = await send({ ...single, requestId: positiveId, blockId: "positive", blockIndex: 2,
      targetText: positiveText, documentHtml: `<p>${positiveText}</p>` });
    assert.equal(positive.status, 200, await positive.clone().text());
    const positiveReceipt = await positive.json();
    assert.equal(positiveReceipt.reviewDecision.outcome, "comment"); assert.equal(positiveReceipt.commentThread.comments.length, 1);
    assert.equal(await prisma.aiInteractionEvent.count({ where: { requestId: positiveId } }), 3);
    assert.equal(await prisma.aiMessage.count({ where: { metadata: { path: ["conversationId"], equals: positiveReceipt.commentThread.id } } }), 2);

    const failedId = randomUUID();
    const failedCandidate = { candidateId: "p-error", blockId: "error", blockIndex: 3, targetText: "供结构错误恢复验证的独立课堂记录。" };
    const retryBatch = { ...batch, requestId: failedId, paragraphs: [failedCandidate], documentHtml: `<p>${failedCandidate.targetText}</p>` };
    responses.push(invalidRaw, invalidRaw);
    assert.equal((await send(retryBatch)).status, 503);
    const historicalFailures = await prisma.aiInteractionEvent.findMany({ where: { requestId: failedId } });
    assert.equal(historicalFailures.length, 3); assert.equal(historicalFailures.filter(row => row.content === invalidRaw).length, 2);
    const polling = await GET(new NextRequest(`http://localhost/api/ai-collaboration/document?courseId=${instance.id}&studentId=${account.id}&stageKey=make&requestId=${failedId}`, {
      headers: { cookie: `${auth.cookieName}=${auth.token}`, "x-openpbl-role": "student" },
    }));
    assert.equal(polling.status, 200); assert.equal((await polling.json()).status, "failed");
    responses.push(JSON.stringify({ checkedCandidateIds: [failedCandidate.candidateId], complete: true, comments: [] }));
    const recovered = await send(retryBatch); assert.equal(recovered.status, 200, await recovered.clone().text());
    assert.equal((await recovered.json()).reviewDecision.outcome, "no-comment");
    const recoveredFacts = await prisma.aiInteractionEvent.findMany({ where: { requestId: failedId } });
    assert.equal(recoveredFacts.length, 5);
    for (const original of historicalFailures) assert.deepEqual(recoveredFacts.find(row => row.id === original.id), original);
    assert.equal(recoveredFacts.filter(row => row.eventType === "policy").length, 1);
    assert.equal(responses.length, 0);
    console.log("PASS actual document HTTP route with local controlled model: single no-comment raw/decision receipt, batch invalid+valid full raw, exact replay without another model call and request conflict");
    console.log("PASS actual comment route creates one real comment and two message facts; failed batch preserves both malformed originals and error across same-ID recovery, with one completed decision");
  } finally {
    await new Promise<void>(resolve => modelServer.close(() => resolve()));
    process.chdir(originalDirectory); await prisma.$disconnect();
    if (temporary) await rm(temporary, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error instanceof Error ? error.stack : error); process.exitCode = 1; });
