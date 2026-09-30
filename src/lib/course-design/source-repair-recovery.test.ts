import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CourseDesignGenerationJob } from "@/lib/course-generation/job-storage";
import { fingerprintGenerationValue } from "@/lib/course-generation/page-checkpoints";

const mocks = vi.hoisted(() => ({
  content: vi.fn(), design: vi.fn(), replace: vi.fn(), course: vi.fn(), countPages: vi.fn(),
  checkpoints: vi.fn(), hydrate: vi.fn(), figures: vi.fn(), contracts: vi.fn(), bind: vi.fn(), assert: vi.fn(),
}));
vi.mock("@/lib/course-generation/job-storage", () => ({
  contentGenerationJobs: { findUnique: mocks.content },
  designGenerationJobs: { findUnique: mocks.design, replace: mocks.replace }, resourcePackageJobs: {},
}));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.course, updateCourse: vi.fn() }));
vi.mock("@/lib/course-generation/checkpoint-storage", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/course-generation/checkpoint-storage")>(),
  countGenerationPageCheckpoints: mocks.countPages, loadGenerationCheckpoints: mocks.checkpoints,
}));
vi.mock("@/lib/textbook/course-evidence", () => ({
  hydrateCourseEvidenceFigureReferences: mocks.hydrate, resolveCourseTextbookFigures: mocks.figures,
}));
vi.mock("@/lib/textbook/course-evidence-types", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/textbook/course-evidence-types")>(),
  resolveCourseSourceSequenceContracts: mocks.contracts,
}));
vi.mock("@/lib/textbook/course-visual-binding", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/textbook/course-visual-binding")>(),
  bindRequiredTextbookFiguresToOutlines: mocks.bind, assertSourceSequencesInOutlines: mocks.assert,
}));
import { assertCourseDesignFirstPassRequest, classroomCheckpointPolicyAfterDesign, requeueCourseDesignForSourceRepair } from "./job-runner";

function fixture() {
  const selections = [{ revisionId: "immutable-revision", sectionIds: [], primary: true }];
  const evidence = { fingerprint: "adopted-source-fingerprint", items: [{ id: "evidence-1", sourceSequencesResolved: true }] };
  const resourcePackage = { id: "package-1", revision: 3, confirmedAt: "2026-09-30T00:00:00Z" };
  const request = { courseId: "course-1", systemMode: "new", teacherBrief: "原教师要求",
    generationContractVersion: 3, generationModelString: "exact-model", textbookSelections: selections,
    textbookEvidence: evidence, resourcePackage, options: { enableImageGeneration: true } };
  const design = { id: "design-1", version: 5, status: "completed", request,
    result: { artifact: "accepted-outline" }, trace: [{ step: "knowledgePoints" }], tokenUsage: 100 };
  const contentRequest = { courseId: "course-1", systemMode: "new", sceneOutlines: [{ id: "page-1", knowledgePointIds: ["point-1"] }],
    resourcePackageIdentity: { id: resourcePackage.id, revision: resourcePackage.revision } };
  const content = { id: "content-1", version: 6, status: "failed", scenesGenerated: 0, request: contentRequest,
    error: "教材完整步骤 source-sequence:1 与课程大纲不一致：遗漏教材条目" };
  const course = { id: "course-1", content: { resourcePackage, textbookSelections: selections, courseEvidence: evidence,
    knowledgePoints: [{ id: "point-1" }], teachingBlueprint: { schemaVersion: 3 } } };
  return { request, design, content, course };
}

describe("saved design repair for early source failures", () => {
  it('stops legacy automatic source-repair queues before any authoring work', () => {
    expect(() => assertCourseDesignFirstPassRequest({ sourceContractRepair: {
      contentJobId: 'old-content', contentJobVersion: 1, contentRequestFingerprint: 'old-request',
    } })).toThrow('旧版自动教材修复任务已停止');
    expect(() => assertCourseDesignFirstPassRequest({})).not.toThrow();
  });
  beforeEach(() => {
    vi.resetAllMocks();
    const f = fixture();
    mocks.content.mockResolvedValue(f.content); mocks.design.mockResolvedValue(f.design);
    mocks.course.mockResolvedValue(f.course); mocks.countPages.mockResolvedValue(0);
    mocks.checkpoints.mockResolvedValue({ preparedOutlines: [] });
    mocks.hydrate.mockImplementation(async (items) => items.map((item: object) => ({ ...item, sourceSequencePolicyVersion: 2 })));
    mocks.figures.mockResolvedValue([]); mocks.contracts.mockReturnValue([{ knowledgePointIds: ["point-1"] }]);
    mocks.bind.mockImplementation((outlines) => outlines);
    mocks.assert.mockImplementation(() => { throw new Error("教材完整步骤 source-sequence:1 与课程大纲不一致"); });
    mocks.replace.mockImplementation(async (input) => ({ ...f.design, ...input.data }));
  });

  it("audits hydrated adopted sources and resumes only the outline boundary without resetting accepted work", async () => {
    const f = fixture();
    await requeueCourseDesignForSourceRepair("course-1", "teacher-1");
    expect(mocks.figures.mock.calls[0][0].items[0].sourceSequencePolicyVersion).toBe(2);
    expect(mocks.contracts.mock.calls[0][0].items[0].sourceSequencePolicyVersion).toBe(2);
    const update = mocks.replace.mock.calls[0][0];
    expect(update).toMatchObject({ where: { id: "design-1", status: "completed", version: 5 }, checkpointPolicy: {},
      data: { status: "queued", step: "lessonOutline", request: { ...f.request, resumeFromOutlineReview: true,
        resumeReviewKind: "outline", reviewActorId: "teacher-1", sourceContractRepair: { contentJobId: "content-1",
          contentJobVersion: 6, contentRequestFingerprint: fingerprintGenerationValue(f.content.request) } } } });
    expect(update.data).not.toHaveProperty("result");
    expect(update.data).not.toHaveProperty("trace");
    expect(update.data).not.toHaveProperty("tokenUsage");
    expect(mocks.bind).toHaveBeenCalledWith(f.content.request.sceneOutlines, [], [{ knowledgePointIds: ["point-1"] }]);
  });

  it("also recognizes source failures thrown by the original-figure binder", async () => {
    mocks.bind.mockImplementation(() => { throw new Error("教材原图步骤与课程大纲不一致"); });
    expect(await requeueCourseDesignForSourceRepair("course-1")).toMatchObject({ status: "queued" });
  });

  it.each(["safe", "pages", "scenes", "other-error", "changed-package", "changed-revision", "changed-evidence", "old-schema", "unavailable-image"])("keeps existing recovery for %s", async (reason) => {
    const f = fixture();
    if (reason === "safe") mocks.assert.mockImplementation(() => undefined);
    if (reason === "pages") mocks.countPages.mockResolvedValue(1);
    if (reason === "scenes") f.content.scenesGenerated = 1;
    if (reason === "other-error") f.content.error = "模型网络连接中断";
    if (reason === "changed-package") f.course.content.resourcePackage = { ...f.course.content.resourcePackage, revision: 4 };
    if (reason === "changed-revision") f.course.content.textbookSelections = [{ ...f.course.content.textbookSelections[0], revisionId: "new-revision" }];
    if (reason === "changed-evidence") f.course.content.courseEvidence = { ...f.course.content.courseEvidence, fingerprint: "new-selection" };
    if (reason === "old-schema") f.course.content.teachingBlueprint.schemaVersion = 2;
    if (reason === "unavailable-image") mocks.figures.mockResolvedValue([{ required: true, status: "unavailable" }]);
    mocks.content.mockResolvedValue(f.content); mocks.course.mockResolvedValue(f.course);
    expect(await requeueCourseDesignForSourceRepair("course-1")).toBeNull();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("detects a stale preparation checkpoint even when request outlines already pass", async () => {
    mocks.checkpoints.mockResolvedValue({ preparedOutlines: [{ id: "stale-page", knowledgePointIds: ["point-1"] }] });
    mocks.assert.mockImplementation((outlines) => {
      if (outlines[0].id === "stale-page") throw new Error("教材完整步骤遗漏教材条目");
    });
    expect(await requeueCourseDesignForSourceRepair("course-1")).toMatchObject({ status: "queued" });
    expect(mocks.assert).toHaveBeenCalledTimes(2);
  });

  it("does not hide unrelated audit errors behind a design retry", async () => {
    mocks.bind.mockImplementation(() => { throw new Error("unexpected storage error"); });
    await expect(requeueCourseDesignForSourceRepair("course-1")).rejects.toThrow("unexpected storage error");
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("retains a matching queued recovery after a concurrent identical resume", async () => {
    const f = fixture();
    const queued = { ...f.design, status: "queued", request: { ...f.request,
      sourceContractRepair: { contentJobId: f.content.id, contentJobVersion: f.content.version,
        contentRequestFingerprint: fingerprintGenerationValue(f.content.request) } } };
    mocks.replace.mockRejectedValue(new Error("GENERATION_JOB_NOT_FOUND"));
    mocks.design.mockResolvedValueOnce(f.design).mockResolvedValueOnce(queued);
    expect(await requeueCourseDesignForSourceRepair("course-1")).toEqual(queued);
  });
});

describe("classroom checkpoints after saved design repair", () => {
  function repair() {
    const f = fixture();
    return { job: f.content as unknown as CourseDesignGenerationJob,
      marker: { contentJobId: f.content.id, contentJobVersion: f.content.version,
        contentRequestFingerprint: fingerprintGenerationValue(f.content.request) } };
  }

  it("invalidates only derived outlines and attempt budgets while retaining completed work and media", () => {
    const { job, marker } = repair();
    const policy = classroomCheckpointPolicyAfterDesign(job, "full-course", marker);
    expect(typeof policy).toBe("object");
    if (typeof policy !== "object") throw new Error("Unexpected broad reset");
    const steps = ["prepared-outlines", "stage-attempt:1", "page:1", "stage:1", "teaching-section:1", "classroom-media-origin:1"];
    const retained = steps.filter((step) => !policy.steps?.includes(step) && !policy.prefixes?.some((prefix) => step.startsWith(prefix)));
    expect(retained).toEqual(["page:1", "stage:1", "teaching-section:1", "classroom-media-origin:1"]);
  });

  it.each(["missing", "id", "version", "request", "status"])("refuses to overwrite a content task with changed %s", (reason) => {
    const { job, marker } = repair();
    if (reason === "id") job.id = "replacement";
    if (reason === "version") job.version += 1;
    if (reason === "request") job.request = { courseId: "course-1", requirement: "new" };
    if (reason === "status") job.status = "running";
    expect(() => classroomCheckpointPolicyAfterDesign(reason === "missing" ? null : job, "full-course", marker)).toThrow("不会覆盖新任务");
  });

  it("preserves ordinary resubmission and test-lesson promotion policies", () => {
    const { job } = repair();
    expect(classroomCheckpointPolicyAfterDesign(job, "full-course")).toBe("all");
    job.request = { generationScope: "test-lesson" };
    expect(classroomCheckpointPolicyAfterDesign(job, "full-course")).toBe("prepared-outlines");
  });
});
