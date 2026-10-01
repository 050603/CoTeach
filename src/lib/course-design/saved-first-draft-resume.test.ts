import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { CourseDesignGenerationJob } from "@/lib/course-generation/job-storage";
import type { QuickDesignRequest } from "./job-runner";
import type { TeachingBlueprintInput } from "./teaching-blueprint";
import { buildNewSystemAiTimingPlan } from "@/lib/classroom/new-system-course";
import fixture from "./__fixtures__/teaching-methods-blueprint-first-draft.json";
import exampleFixture from "./__fixtures__/blueprint-definition-ownership-first-draft.json";

const mocks = vi.hoisted(() => ({
  job: vi.fn(), replace: vi.fn(), package: vi.fn(), course: vi.fn(), checkpoints: vi.fn(), raw: vi.fn(), save: vi.fn(),
  prepare: vi.fn(), model: vi.fn(), modelFingerprint: vi.fn(), migrate: vi.fn(), restore: vi.fn(), provider: vi.fn(),
  generate: vi.fn(), bindBlueprint: vi.fn(), bindOutlines: vi.fn(), figures: vi.fn(), source: vi.fn(),
  preflight: vi.fn(), applyPlan: vi.fn(), revalidate: vi.fn(), budget: vi.fn(),
}));
vi.mock("@/lib/db/client", () => ({ prisma: { generationCheckpoint: { findUnique: mocks.raw } } }));
vi.mock("@/lib/course-generation/job-storage", () => ({
  designGenerationJobs: { findUnique: mocks.job, replace: mocks.replace }, resourcePackageJobs: { findUnique: mocks.package },
}));
vi.mock("@/lib/course-generation/checkpoint-storage", () => ({
  loadGenerationCheckpoints: mocks.checkpoints, saveGenerationCheckpoint: mocks.save,
}));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.course }));
vi.mock("@/lib/openmaic/server/resolve-model", () => ({ resolveModel: mocks.model }));
vi.mock("@/lib/openmaic/server/provider-config", () => ({ findServerDefaultModelString: () => "original:model" }));
vi.mock("./job-runner", () => ({
  prepareTeachingBlueprintInput: mocks.prepare, resolvedCourseDesignModelFingerprint: mocks.modelFingerprint,
  migrateCourseDesignCheckpointIdentity: mocks.migrate, restoreTeachingBlueprintRepairSource: mocks.restore,
}));
vi.mock("@/lib/course-generation/job-runner", () => ({ applyVersionedOutlinePlanToCourseContent: mocks.applyPlan }));
vi.mock("./teaching-blueprint", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./teaching-blueprint")>();
  mocks.generate.mockImplementation(actual.generateTeachingBlueprint);
  mocks.revalidate.mockImplementation(actual.revalidateStoredTeachingBlueprint);
  mocks.budget.mockImplementation(actual.validateTeachingBlueprintBudget);
  return { ...actual, generateTeachingBlueprint: mocks.generate,
    revalidateStoredTeachingBlueprint: mocks.revalidate, validateTeachingBlueprintBudget: mocks.budget };
});
vi.mock("@/lib/textbook/course-visual-binding", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/textbook/course-visual-binding")>(),
  assertRequiredTextbookFiguresAvailable: mocks.figures, assertSourceSequencesInOutlines: mocks.source,
  bindRequiredTextbookFiguresToBlueprint: mocks.bindBlueprint, bindRequiredTextbookFiguresToOutlines: mocks.bindOutlines,
}));
vi.mock("@/lib/openmaic/generation/teaching-page-preflight", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openmaic/generation/teaching-page-preflight")>(),
  prepareTeachingPageCapacity: mocks.preflight,
}));

import { teachingBlueprintInputFingerprint, teachingBlueprintContentFingerprint, teachingBlueprintToOutlines } from "./teaching-blueprint";
import { fingerprintGenerationValue } from "@/lib/course-generation/page-checkpoints";
import { assertSavedCourseDesignReplayInput, hasAcceptedSavedCourseDesignOutline,
  resumeSavedCourseDesignFirstDraft } from "./saved-first-draft-resume";

function sample() {
  const section = structuredClone(fixture.section);
  const nodes = new Set(section.units.flatMap((unit) => unit.explanationNodes.map((node) => node.id)));
  section.pages.forEach((page) => { page.referencesNodeIds = page.referencesNodeIds.filter((id) => nodes.has(id)); });
  section.units.forEach((unit) => { unit.requirementIds = []; unit.difficultyStrategies = []; });
  const point = { ...fixture.point, teachingRole: "core-concept", level: "core", teachingDepth: "detailed",
    parentKnowledgePointIds: [], sourceSequenceReferences: [] };
  const candidate = { authoringContract: "blueprint-v1", sections: [section] };
  const evidence = { fingerprint: "immutable-evidence", items: [] };
  const selections = [{ revisionId: "textbook-revision-1", primary: true, sectionIds: [] }];
  const resourcePackage = { schemaVersion: 2, id: "package-1", revision: 2,
    confirmedAt: "2026-10-01T00:00:00Z", source: { id: "source-1" }, draft: { courseName: "教学方法" } };
  const timing = buildNewSystemAiTimingPlan({ durationMin: 10, rationale: "固定范围", confidence: "high",
    teachingClusterBudgets: [{ clusterId: "methods", title: "教学方法", durationMin: 10,
      knowledgePointIds: [point.id], rationale: "完整讲解" }], evidence: [], assumptions: [] },
    [point as unknown as Course["content"]["knowledgePoints"][number]], "2026-10-01T00:00:00Z");
  const course = { id: "course-1", version: 7, name: "教学方法", subject: "教育学", grade: "大学", hours: 0.5,
    drivingQuestion: "设计人工智能教案", learningObjectives: ["解释并比较两种方法"],
    content: { resourcePackage, textbookSelections: selections, courseEvidence: evidence,
      knowledgePoints: [point], knowledgeGraph: { nodes: [{ id: point.id }], edges: [] }, moduleTimingPlan: timing,
      _openmaicSceneOutlines: [], lessonOutline: [] } } as unknown as Course;
  const request = { courseId: "course-1", authoringRequestId: "original-request-identity", systemMode: "new",
    generationContractVersion: 3, generationModelString: "original:model", generationScope: "full-course",
    assessmentMode: "adaptive", generationMode: "standard", teacherBrief: "原教学要求",
    resourcePackage, textbookEvidence: evidence, textbookSelections: selections,
    options: { enableImageGeneration: false, enableTTS: true, enableVideoGeneration: false } } as unknown as QuickDesignRequest;
  const inputFor = (current: Course, currentRequest: QuickDesignRequest): TeachingBlueprintInput => ({
    courseTitle: current.name, subject: current.subject, grade: current.grade,
    learningObjectives: current.learningObjectives ?? [], projectContext: current.drivingQuestion,
    totalDurationSec: current.content.moduleTimingPlan!.totalMinutes * 60,
    assessmentMode: currentRequest.assessmentMode ?? "adaptive", generationMode: currentRequest.generationMode ?? "standard",
    generationModelFingerprint: "model-fingerprint", knowledgePoints: current.content.knowledgePoints,
    knowledgeGraph: current.content.knowledgeGraph, teacherBrief: currentRequest.teacherBrief,
    teachingRequirements: current.content.teachingRequirements, teachingOrder: current.content.knowledgeScopePlan?.teachingOrder,
    sourceContext: section.units.flatMap((unit) => unit.evidenceQuotes).join("\n"), sourceSequences: [],
    priorSourceExamples: current.content.teachingBlueprint?.sections.flatMap((entry) => entry.units
      .filter((unit) => unit.workedExample?.trim()).map((unit) => ({ knowledgePointIds: unit.knowledgePointIds,
        workedExample: unit.workedExample!, sourceQuote: unit.evidenceQuotes[0] ?? "", imagePlanned: false }))) ?? [],
  });
  const input = inputFor(course, request);
  const inputFingerprint = teachingBlueprintInputFingerprint(input), contentFingerprint = teachingBlueprintContentFingerprint(input);
  const rawResponse = JSON.stringify(candidate);
  const saved = { knowledgeStructure: { schemaVersion: 1, status: "validated" }, aiDuration: { schemaVersion: 1, status: "validated" },
    teachingBlueprint: { schemaVersion: 1, status: "invalid-output", inputFingerprint, contentFingerprint,
      modelFingerprint: "model-fingerprint", rawResponse, bestCandidate: candidate, validationIssues: ["旧匹配误判"] },
    teachingBlueprintAttempt: { schemaVersion: 1, inputFingerprint, modelFingerprint: "model-fingerprint", attemptsStarted: 1 } };
  const raw = { state: { schemaVersion: 1, status: "response-complete", complete: true,
    inputFingerprint, modelFingerprint: "model-fingerprint", rawResponse } };
  const job = { id: "design-1", courseId: "course-1", version: 506, status: "failed", step: "failed", stepIndex: 2,
    progress: 68, request, reviewStatus: "auto-continued", tokenUsage: 326863, tokenUsageCalls: 3,
    trace: [{ step: "base", status: "completed" }, { step: "knowledgePoints", status: "completed" },
      { step: "aiDurationPlanning", status: "completed" }], error: "原失败", result: null } as unknown as CourseDesignGenerationJob;
  const resources = [{ id: "textbook-image-1", required: true, status: "available", width: 1600, height: 900 }];
  return { course, request, job, input, inputFor, candidate, saved, raw, resources };
}

let state: ReturnType<typeof sample>;
beforeEach(async () => {
  // Keep the actual blueprint normalizer and validator implementations set by
  // the module mock. All persistence, resources and browser capacity are local.
  vi.clearAllMocks();
  const actual = await vi.importActual<typeof import("./teaching-blueprint")>("./teaching-blueprint");
  mocks.generate.mockReset().mockImplementation(actual.generateTeachingBlueprint);
  mocks.revalidate.mockReset().mockImplementation(actual.revalidateStoredTeachingBlueprint);
  mocks.budget.mockReset().mockImplementation(actual.validateTeachingBlueprintBudget);
  state = sample();
  mocks.job.mockReset().mockResolvedValue(state.job);
  mocks.package.mockReset().mockResolvedValue({ status: "ready" });
  mocks.course.mockReset().mockImplementation(async () => state.course);
  mocks.checkpoints.mockReset().mockResolvedValue(state.saved);
  mocks.raw.mockReset().mockResolvedValue(state.raw);
  mocks.save.mockReset().mockResolvedValue(undefined);
  mocks.model.mockReset().mockResolvedValue({ modelString: "original:model", model: { doGenerate: mocks.provider } });
  mocks.modelFingerprint.mockReset().mockReturnValue("model-fingerprint");
  mocks.prepare.mockReset().mockImplementation(async (course: Course, _content: unknown, request: QuickDesignRequest) => ({
    input: state.inputFor(course, request), textbookFigureResources: state.resources,
    legacyFingerprints: { inputFingerprint: "legacy-input", contentFingerprint: "legacy-content", previousInputs: ["previous-input"] },
  }));
  mocks.migrate.mockReset().mockImplementation((checkpoint, inputFingerprint) => ({ ...checkpoint, inputFingerprint }));
  mocks.restore.mockReset().mockImplementation((checkpoint) => ({ candidate: structuredClone(checkpoint.bestCandidate),
    issues: checkpoint.validationIssues, preserveAcceptedPagePlans: checkpoint.preserveAcceptedPagePlans }));
  mocks.bindBlueprint.mockReset().mockImplementation((blueprint) => blueprint);
  mocks.bindOutlines.mockReset().mockImplementation((outlines) => outlines);
  mocks.figures.mockReset().mockReturnValue(undefined);
  mocks.source.mockReset().mockReturnValue(undefined);
  mocks.preflight.mockReset().mockImplementation(async (outlines) => ({ outlines, assessments: [], changed: false }));
  mocks.applyPlan.mockReset().mockImplementation((content) => content);
});

describe("saved complete blueprint local resume", () => {
  it.each(['projection', 'raw'] as const)('retains a new independent-display contract recorded in the %s checkpoint', async (location) => {
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    Object.assign(location === 'projection' ? state.saved.teachingBlueprint : state.raw.state,
      { firstAuthoringContract: 'blueprint-v5' });
    const original = structuredClone(state.saved), originalRaw = structuredClone(state.raw);
    await expect(resumeSavedCourseDesignFirstDraft('course-1', 'teacher-1'))
      .resolves.toMatchObject({ status: 'queued' });
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ firstAuthoringContract: 'blueprint-v5' });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.replace).toHaveBeenCalledOnce();
    expect(mocks.preflight).toHaveBeenCalledOnce();
    expect(mocks.save.mock.calls.at(-1)?.[2]).toMatchObject({ status: 'validated',
      qualityDiagnostics: expect.arrayContaining([expect.stringContaining('缺少 presentationItems')]) });
    expect(state.saved).toEqual(original);
    expect(state.raw).toEqual(originalRaw);
  });

  it("checks the real saved draft and queues with the original identity and all receipts intact", async () => {
    const original = structuredClone(state.saved), originalRaw = structuredClone(state.raw);
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    const resumed = await resumeSavedCourseDesignFirstDraft("course-1", "teacher-1");
    expect(resumed?.status).toBe("queued");
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.generate.mock.calls[0][2]).toMatchObject({ repairFrom: { candidate: state.candidate } });
    expect(mocks.raw).toHaveBeenCalledWith({ where: { jobId_step: { jobId: "design-1", step: "design-authoring:teachingBlueprint" } }, select: { state: true } });
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "design-1", status: "failed", version: 506 }, checkpointPolicy: {},
      data: expect.objectContaining({ request: { ...state.request, savedFirstDraftReplay: {
        contentFingerprint: teachingBlueprintContentFingerprint({ ...state.input, priorSourceExamples: undefined }), modelFingerprint: "model-fingerprint",
        authoringRequestId: "original-request-identity" } } }),
    }));
    const data = mocks.replace.mock.calls[0][0].data;
    for (const key of ["tokenUsage", "tokenUsageCalls", "trace", "result", "qualityReport", "progress", "stepIndex", "reviewStatus"]) {
      expect(data).not.toHaveProperty(key);
    }
    expect(state.saved).toEqual(original);
    expect(state.raw).toEqual(originalRaw);
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0]).toEqual(["design-1", expect.stringMatching(/^course-design:local-blueprint-replay:/u),
      expect.objectContaining({ status: "validated", originalJobVersion: 506, originalJobError: "原失败",
        originalValidationIssues: ["旧匹配误判"], providerCalls: 0, authorCalls: 0, actorId: "teacher-1" })]);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
    expect(mocks.budget).toHaveBeenCalledTimes(1);
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.preflight.mock.calls[0][1]).toMatchObject({
      explanationNodes: expect.arrayContaining(state.candidate.sections[0].units[0].explanationNodes.map((node) =>
        expect.objectContaining({ content: node.content }))),
      resourceDimensions: { "textbook-image-1": { width: 1600, height: 900 } }, lockedOutlineIds: [],
    });
  });

  it.each(["queued", "running", "review_available", "paused"])("returns a duplicate %s task without revalidating or replacing", async (status) => {
    mocks.job.mockResolvedValue({ ...state.job, status });
    expect(await resumeSavedCourseDesignFirstDraft("course-1")).toMatchObject({ status });
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("rejects an incomplete original even when the candidate and JSON look valid", async () => {
    state.raw.state.complete = false;
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({ code: "SAVED_FIRST_DRAFT_INCOMPLETE" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("refuses an explicitly incomplete status even if its metadata claims complete JSON", async () => {
    state.raw.state.status = "response-incomplete";
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({ code: "SAVED_FIRST_DRAFT_INCOMPLETE" });
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it.each(["knowledge", "duration", "missing-raw", "raw-mismatch", "spent-identity", "model", "input"])(
    "stops %s before any creative fallback or checkpoint reset", async (reason) => {
      if (reason === "knowledge") state.saved.knowledgeStructure.status = "rejected";
      if (reason === "duration") state.saved.aiDuration.status = "invalid-output";
      if (reason === "missing-raw") state.raw.state.rawResponse = "";
      if (reason === "raw-mismatch") state.raw.state.rawResponse = "different response";
      if (reason === "spent-identity") state.saved.teachingBlueprintAttempt.attemptsStarted = 0;
      if (reason === "model") mocks.modelFingerprint.mockReturnValue("new-model");
      if (reason === "input") state.course.content.knowledgePoints[0]!.description += "教师修改了掌握边界";
      await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toBeInstanceOf(Error);
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(mocks.save).not.toHaveBeenCalled();
      expect(mocks.provider).not.toHaveBeenCalled();
    });

  it.each(["package", "package-body", "package-documents", "package-pending", "textbook", "evidence"])("rejects changed %s", async (reason) => {
    if (reason === "package") state.course.content.resourcePackage = { ...state.course.content.resourcePackage!, revision: 3 };
    if (reason === "package-body") state.course.content.resourcePackage = { ...state.course.content.resourcePackage!,
      draft: { ...state.course.content.resourcePackage!.draft, courseName: "同版本偷偷改变的教案" } };
    if (reason === "package-documents") state.course.content.resourcePackage = { ...state.course.content.resourcePackage!,
      documents: { ...state.course.content.resourcePackage!.documents,
        lessonPlan: { id: "changed-document", fileName: "已改变的教案.md", url: "/api/uploads/changed-document" } } };
    if (reason === "package-pending") mocks.package.mockResolvedValue({ status: "running" });
    if (reason === "textbook") state.course.content.textbookSelections = [{ revisionId: "new-revision", primary: true, sectionIds: [] }];
    if (reason === "evidence") state.course.content.courseEvidence = { ...state.course.content.courseEvidence!, fingerprint: "new-evidence" };
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({ code: "SAVED_FIRST_DRAFT_SOURCE_CHANGED" });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("keeps compatible old identities and never opens another author request", async () => {
    state.saved.teachingBlueprint.inputFingerprint = "previous-input";
    state.saved.teachingBlueprintAttempt.inputFingerprint = "previous-input";
    state.raw.state.inputFingerprint = "previous-input";
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    expect(await resumeSavedCourseDesignFirstDraft("course-1")).toMatchObject({ status: "queued" });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(state.saved.teachingBlueprintAttempt.attemptsStarted).toBe(1);
    expect(state.saved.teachingBlueprint.inputFingerprint).toBe("previous-input");
  });

  it("refuses an accidental authoring fallback and appends a failure without resetting the draft", async () => {
    mocks.generate.mockImplementationOnce(async (_input, aiCall) => aiCall("system", "prompt"));
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({ code: "SAVED_FIRST_DRAFT_AUTHORING_FORBIDDEN" });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][2]).toMatchObject({ status: "rejected", authorCalls: 0 });
    expect(state.saved.teachingBlueprintAttempt.attemptsStarted).toBe(1);
  });

  it.each(["blueprint", "figure", "capacity", "revalidation"])(
    "preserves raw and accepted stages after a %s failure", async (reason) => {
      if (reason === "blueprint") mocks.generate.mockRejectedValueOnce(new Error("原稿定义不完整"));
      if (reason === "figure") mocks.figures.mockImplementation(() => { throw new Error("必用教材原图缺失"); });
      if (reason === "capacity") mocks.preflight.mockRejectedValue(new Error("真实字体容量不合法"));
      if (reason === "revalidation") mocks.revalidate.mockReturnValueOnce({ issues: ["分页后正文丢失"], blueprint: undefined });
      const original = structuredClone(state.saved);
      await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({
        code: reason === 'revalidation' ? 'SAVED_FIRST_DRAFT_STRUCTURE_FAILED' : 'SAVED_FIRST_DRAFT_QUALITY_FAILED', status: 422 });
      expect(mocks.replace).not.toHaveBeenCalled();
      expect(mocks.provider).not.toHaveBeenCalled();
      expect(state.saved).toEqual(original);
      expect(mocks.save).toHaveBeenCalledWith("design-1", expect.stringMatching(/^course-design:local-blueprint-replay:/u),
        expect.objectContaining({ status: "rejected", providerCalls: 0, authorCalls: 0 }));
    });

  it('keeps a usable saved draft queued with nonblocking budget diagnostics', async () => {
    mocks.budget.mockReturnValueOnce(['小节时间不守恒']);
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    await expect(resumeSavedCourseDesignFirstDraft('course-1')).resolves.toMatchObject({ status: 'queued' });
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][2]).toMatchObject({ status: 'validated', qualityDiagnostics: ['小节时间不守恒'] });
  });

  it("reuses the original saved draft without calling a content audit or another author", async () => {
    mocks.source.mockImplementation(() => { throw new Error("教材步骤不完整"); });
    const original = structuredClone(state.saved);
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).resolves.toMatchObject({ status: "queued" });
    expect(mocks.source).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(state.saved).toEqual(original);
  });

  it("synchronizes deterministic pagination and rechecks its full blueprint before queueing", async () => {
    mocks.preflight.mockImplementation(async (outlines) => ({
      outlines: outlines.map((page: object) => ({ ...page, sectionPlanVersion: 1 })), assessments: [], changed: true,
    }));
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    await resumeSavedCourseDesignFirstDraft("course-1");
    expect(mocks.applyPlan).toHaveBeenCalledTimes(1);
    expect(mocks.revalidate).toHaveBeenCalledTimes(1);
    expect(mocks.budget.mock.calls[0][1][0].sectionPlanVersion).toBe(1);
    expect(mocks.save.mock.calls[0][2]).toMatchObject({ status: "validated", deterministicPaginationChanged: true });
  });

  it("locks every accepted page rather than permitting a new page plan", async () => {
    const accepted = await mocks.generate(state.input, vi.fn(), { repairFrom: { candidate: state.candidate, issues: [] } });
    Object.assign(state.saved.teachingBlueprint, { bestCandidate: accepted, preserveAcceptedPagePlans: true });
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    await resumeSavedCourseDesignFirstDraft("course-1");
    const [outlines, options] = mocks.preflight.mock.calls[0];
    expect(options.lockedOutlineIds).toEqual(outlines.map((page: { id: string }) => page.id));
  });

  it("stops a teacher edit made during the local capacity check", async () => {
    mocks.preflight.mockImplementation(async (outlines) => {
      state.course.content.knowledgePoints[0]!.description += "此时教师改变了内容";
      return { outlines, assessments: [], changed: false };
    });
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({ code: "SAVED_FIRST_DRAFT_INPUT_CHANGED" });
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.save.mock.calls[0][2].status).toBe("rejected");
  });

  it("stops before queueing if the diagnostic cannot be saved", async () => {
    mocks.save.mockRejectedValue(new Error("storage failed"));
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toThrow("storage failed");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.save).toHaveBeenCalledTimes(1);
    expect(mocks.save.mock.calls[0][2].status).toBe("validated");
  });

  it("returns a concurrent identical resume after the version comparison loses", async () => {
    const live = { ...state.job, status: "queued", request: { ...state.request, savedFirstDraftReplay: {
      contentFingerprint: teachingBlueprintContentFingerprint({ ...state.input, priorSourceExamples: undefined }), modelFingerprint: "model-fingerprint",
      authoringRequestId: state.request.authoringRequestId,
    } } };
    mocks.job.mockResolvedValueOnce(state.job).mockResolvedValueOnce(live);
    mocks.replace.mockReset().mockRejectedValue(new Error("GENERATION_JOB_NOT_FOUND"));
    expect(await resumeSavedCourseDesignFirstDraft("course-1")).toEqual(live);
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("does not overwrite a different request after a lost version comparison", async () => {
    mocks.job.mockResolvedValueOnce(state.job).mockResolvedValueOnce({ ...state.job, status: "queued",
      request: { ...state.request, authoringRequestId: "new-teacher-request" } });
    mocks.replace.mockReset().mockRejectedValue(new Error("GENERATION_JOB_NOT_FOUND"));
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toMatchObject({ code: "SAVED_FIRST_DRAFT_JOB_CONFLICT" });
    expect(mocks.replace).toHaveBeenCalledTimes(1);
    expect(state.saved.teachingBlueprintAttempt.attemptsStarted).toBe(1);
  });
});

describe("resume after an accepted outline", () => {
  async function accepted(teacherEdited = false) {
    const blueprint = await mocks.generate(state.input, vi.fn().mockResolvedValue(JSON.stringify(state.candidate)));
    Object.assign(state.saved.teachingBlueprint, { status: "validated", blueprint: structuredClone(blueprint) });
    state.course.content.teachingBlueprint = structuredClone(blueprint);
    state.course.content._openmaicSceneOutlines = teachingBlueprintToOutlines(blueprint, "使用简体中文");
    const request = { ...state.request, generationScope: "test-lesson", testSectionId: blueprint.sections[0].id,
      savedFirstDraftReplay: {
        contentFingerprint: teachingBlueprintContentFingerprint({ ...state.input, priorSourceExamples: undefined }),
        modelFingerprint: "model-fingerprint", authoringRequestId: state.request.authoringRequestId,
      }, ...(teacherEdited ? { resumeFromOutlineReview: true, resumeReviewKind: "outline" } : {}) };
    state.job.request = request as unknown as CourseDesignGenerationJob["request"];
    if (teacherEdited) state.course.content.teachingBlueprint!.sections[0].pages[0].title += "（教师确认）";
    mocks.generate.mockClear();
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    return request;
  }

  it.each([false, true])("continues an accepted plan after failure and preserves teacher edits=%s without authoring", async (teacherEdited) => {
    const request = await accepted(teacherEdited);
    const before = structuredClone(state.course);
    const queued = await resumeSavedCourseDesignFirstDraft("course-1", "teacher-1");
    expect(queued).toMatchObject({ status: "queued", request: { resumeFromOutlineReview: true,
      resumeReviewKind: "outline", testSectionId: request.testSectionId, savedFirstDraftReplay: request.savedFirstDraftReplay } });
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: state.job.id, status: "failed", version: state.job.version }, checkpointPolicy: {},
    }));
    expect(mocks.save).toHaveBeenCalledWith("design-1", expect.stringMatching(/^course-design:local-blueprint-replay:/u),
      expect.objectContaining({ preservedAcceptedBlueprintFingerprint: fingerprintGenerationValue(before.content.teachingBlueprint),
        providerCalls: 0, authorCalls: 0 }));
    expect(state.course).toEqual(before);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.preflight).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it.each(["knowledge", "source", "model", "identity"])("still rejects a real %s change before resuming an accepted plan", async (reason) => {
    const request = await accepted(true);
    if (reason === "knowledge") state.course.content.knowledgePoints[0]!.description += "教师改变知识边界";
    if (reason === "source") state.course.content.courseEvidence = { ...state.course.content.courseEvidence!, fingerprint: "new-source" };
    if (reason === "model") mocks.modelFingerprint.mockReturnValue("new-model");
    if (reason === "identity") Object.assign(request, { authoringRequestId: "new-request" });
    await expect(resumeSavedCourseDesignFirstDraft("course-1")).rejects.toBeInstanceOf(Error);
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });
});

describe("worker input guard before applying a saved draft", () => {
  function request() { return { ...state.request, savedFirstDraftReplay: {
    contentFingerprint: teachingBlueprintContentFingerprint({ ...state.input, priorSourceExamples: undefined }), modelFingerprint: "model-fingerprint",
    authoringRequestId: state.request.authoringRequestId,
  } }; }

  it("allows unchanged authoring inputs without any creative request", async () => {
    await expect(assertSavedCourseDesignReplayInput(state.course, request())).resolves.toBeUndefined();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("allows cases derived from the accepted same draft across review and restart without authoring", async () => {
    const example = structuredClone(exampleFixture.orphan.unit.explanationNodes.find((node) => node.kind === "example")!);
    const unit = state.candidate.sections[0].units[0];
    // Reuse the complete anchoring-method example from a real first draft.
    // The new contract derives workedExample from this owned example node.
    unit.explanationNodes.push({ ...example, id: "u6-example", knowledgePointIds: [...unit.knowledgePointIds],
      prerequisiteNodeIds: ["u6-node4"] });
    const introducedIds: string[] = state.candidate.sections[0].pages[1].introducesNodeIds;
    introducedIds.push("u6-example");
    const raw = JSON.stringify(state.candidate);
    state.saved.teachingBlueprint.rawResponse = raw;
    state.raw.state.rawResponse = raw;
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    const queued = await resumeSavedCourseDesignFirstDraft("course-1");
    const accepted = mocks.save.mock.calls[0][2].blueprint;
    expect(state.input.priorSourceExamples).toEqual([]);
    state.course.content.teachingBlueprint = structuredClone(accepted);
    const afterAdoption = state.inputFor(state.course, state.request);
    expect(afterAdoption.priorSourceExamples!.length).toBeGreaterThan(0);
    expect(afterAdoption.priorSourceExamples![0].workedExample).toBe(example.content);
    // Full raw/checkpoint identities remain sensitive to the new case
    // projection; the replay guard alone ignores this derived output.
    expect(teachingBlueprintContentFingerprint(afterAdoption)).not.toBe(teachingBlueprintContentFingerprint(state.input));
    mocks.generate.mockClear();
    await expect(assertSavedCourseDesignReplayInput(state.course, queued!.request as unknown as QuickDesignRequest))
      .resolves.toBeUndefined();
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
    expect(state.saved.teachingBlueprint.inputFingerprint).toBe(teachingBlueprintInputFingerprint(state.input));
    expect(state.saved.teachingBlueprintAttempt.attemptsStarted).toBe(1);
  });

  it("does not attach a new replay policy to ordinary generation", async () => {
    await assertSavedCourseDesignReplayInput(state.course, state.request);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled();
  });

  it.each(["knowledge", "timing", "model", "identity", "teacherBrief", "source"])("rejects changed %s before a course write", async (reason) => {
    const savedRequest = request();
    if (reason === "knowledge") state.course.content.knowledgePoints[0]!.description += "教师新增条件";
    if (reason === "timing") {
      state.course.content.moduleTimingPlan!.totalMinutes += 1;
      state.course.content.moduleTimingPlan!.allocations[0]!.durationMin += 1;
    }
    if (reason === "model") mocks.modelFingerprint.mockReturnValue("new-model");
    if (reason === "identity") savedRequest.authoringRequestId = "new-request";
    if (reason === "teacherBrief") savedRequest.teacherBrief = "已修改教师要求";
    if (reason === "source") state.course.content.courseEvidence = { ...state.course.content.courseEvidence!, fingerprint: "other-source" };
    await expect(assertSavedCourseDesignReplayInput(state.course, savedRequest)).rejects.toBeInstanceOf(Error);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it("fingerprints the original response without replacing its text", async () => {
    mocks.replace.mockReset().mockImplementation(async ({ data }) => ({ ...state.job, ...data }));
    await resumeSavedCourseDesignFirstDraft("course-1");
    expect(mocks.save.mock.calls[0][2].rawFingerprint).toBe(fingerprintGenerationValue(state.raw.state.rawResponse));
    expect(state.raw.state.rawResponse).toBe(JSON.stringify(state.candidate));
  });
});

describe("accepted saved outline identity", () => {
  async function accepted() {
    const blueprint = await mocks.generate(state.input, vi.fn(), { repairFrom: { candidate: state.candidate, issues: [] } });
    const course = { ...state.course, content: { ...state.course.content, teachingBlueprint: blueprint,
      _openmaicSceneOutlines: teachingBlueprintToOutlines(blueprint, "使用简体中文") } };
    const checkpoint = { schemaVersion: 1, status: "validated", blueprint: structuredClone(blueprint) };
    return { course, checkpoint };
  }

  it("recognizes only the exact validated blueprint with real execution pages", async () => {
    const { course, checkpoint } = await accepted();
    mocks.generate.mockClear();
    expect(hasAcceptedSavedCourseDesignOutline(course, checkpoint)).toBe(true);
    expect(mocks.generate).not.toHaveBeenCalled();
    expect(mocks.provider).not.toHaveBeenCalled();
  });

  it.each(["missing-checkpoint", "schema", "invalid-output", "missing-saved-blueprint", "missing-course-blueprint", "old-draft", "no-pages"])
    ("refuses to treat %s as a confirmed page plan", async (reason) => {
      const { course, checkpoint } = await accepted();
      let saved: unknown = checkpoint;
      if (reason === "missing-checkpoint") saved = undefined;
      if (reason === "schema") checkpoint.schemaVersion = 2;
      if (reason === "invalid-output") checkpoint.status = "invalid-output";
      if (reason === "missing-saved-blueprint") saved = { ...checkpoint, blueprint: undefined };
      if (reason === "missing-course-blueprint") course.content.teachingBlueprint = undefined;
      if (reason === "old-draft") checkpoint.blueprint.sections[0].units[0].workedExample += "另一旧稿的例子";
      if (reason === "no-pages") course.content._openmaicSceneOutlines = [];
      expect(hasAcceptedSavedCourseDesignOutline(course, saved)).toBe(false);
      expect(mocks.provider).not.toHaveBeenCalled();
    });
});
