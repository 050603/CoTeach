import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";

const mocks = vi.hoisted(() => {
  class TestLessonPromotionError extends Error {
    constructor(readonly code: string, message: string, readonly status: number) { super(message); }
  }
  class TestLessonSelectionError extends Error {
    readonly code = "INVALID_TEST_LESSON_SELECTION";
    readonly status = 400;
  }
  class SavedCourseDesignFirstDraftResumeError extends Error {
    constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
  }
  return { find: vi.fn(), packageJob: vi.fn(), create: vi.fn(), update: vi.fn(), replace: vi.fn(), resolve: vi.fn(), references: vi.fn(), promote: vi.fn(), resume: vi.fn(), savedResume: vi.fn(), checkpoints: vi.fn(), authorize: vi.fn(), course: vi.fn(), recover: vi.fn(), TestLessonPromotionError, TestLessonSelectionError, SavedCourseDesignFirstDraftResumeError };
});
vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: vi.fn().mockResolvedValue({ id: "course-1" }) }));
vi.mock("@/lib/course-generation/job-storage", () => ({ designGenerationJobs: { findUnique: mocks.find, create: mocks.create, update: mocks.update, replace: mocks.replace }, resourcePackageJobs: { findUnique: mocks.packageJob } }));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: () => true }));
vi.mock('@/lib/course-generation/checkpoint-storage', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/course-generation/checkpoint-storage')>(),
  loadGenerationCheckpoints: mocks.checkpoints,
}));
vi.mock("@/lib/course-design/job-runner", () => ({
  initialQuickGenerationEstimateSeconds: () => 60,
  cancelCourseDesignJob: vi.fn(),
  pauseCourseDesignForOutlineReview: vi.fn(),
  promoteTestLessonToFullCourse: mocks.promote,
  resumeCourseDesignAfterOutlineReview: mocks.resume,
  runCourseDesignJob: vi.fn(),
  resumeRecoverableCourseDesignJob: mocks.recover,
  TestLessonPromotionError: mocks.TestLessonPromotionError,
  TestLessonSelectionError: mocks.TestLessonSelectionError,
}));
vi.mock("@/lib/course-design/saved-first-draft-resume", () => ({
  resumeSavedCourseDesignFirstDraft: mocks.savedResume,
  SavedCourseDesignFirstDraftResumeError: mocks.SavedCourseDesignFirstDraftResumeError,
}));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.course }));
vi.mock("@/lib/course-design/generation-references", () => ({ GenerationReferenceError: class extends Error {}, resolveGenerationReferenceMaterials: mocks.references }));
vi.mock("@/lib/resource-package/server", () => ({ ResourcePackageError: class extends Error {}, resolveConfirmedResourcePackage: mocks.resolve }));
vi.mock("@openmaic/lib/server/classroom-media-readiness", () => ({ assertRequestedClassroomMediaProviders: vi.fn(), classroomMediaConfigurationErrorResponse: vi.fn() }));
vi.mock("@/lib/openmaic/server/provider-config", () => ({
  findServerDefaultModelString: () => "deepseek:deepseek-v4-flash",
}));

import { GET, PATCH, POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };
function request(body: unknown) {
  return new NextRequest("http://localhost/api/courses/course-1/design-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function patchRequest(body: unknown) {
  return new NextRequest("http://localhost/api/courses/course-1/design-generation", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function storedJob(request: unknown, status = "completed") {
  return { id: "job-1", courseId: "course-1", status, step: "completed", progress: 100, request, trace: [], updatedAt: new Date("2026-09-12T00:00:00Z") };
}

describe("saved course design details", () => {
  const outlinePreview = [{ id: "slide-1", title: "模型评估", type: "slide", lectureSectionId: "section-1" }];
  const blueprintPreview = { schemaVersion: 2, sections: [{ id: "section-1", title: "模型评估", pages: outlinePreview }] };
  const content = {
    knowledgePoints: [{ id: "knowledge-1", title: "模型评估" }],
    knowledgeScopePlan: { sections: [{ id: "section-1" }] },
    courseEvidence: { revisionId: "evidence-1" },
    _openmaicSceneOutlines: outlinePreview,
    teachingBlueprint: blueprintPreview,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue("teacher-1");
    mocks.find.mockResolvedValue(null);
    mocks.recover.mockResolvedValue(null);
    mocks.course.mockResolvedValue({ id: "course-1", content });
  });

  it.each(["queued", "running", "completed", "failed", "cancelling", "cancelled", null])(
    "keeps saved page outlines and blueprints available outside the review window (%s)",
    async (status) => {
      const job = status ? storedJob({ courseId: "course-1" }, status) : null;
      mocks.find.mockResolvedValue(job);
      mocks.recover.mockResolvedValue(job);

      const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ knowledgePreview: null, outlinePreview, blueprintPreview });
      expect(body.job?.status ?? null).toBe(status);
      expect(mocks.course).toHaveBeenCalledWith("course-1");
      if (status === "failed") {
        expect(mocks.recover).toHaveBeenCalledWith("course-1");
      } else {
        expect(mocks.recover).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["review_available", "paused"])("preserves knowledge review previews during the confirmation window (%s)", async (status) => {
    mocks.find.mockResolvedValue(storedJob({ courseId: "course-1" }, status));

    const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      knowledgePreview: {
        knowledgePoints: content.knowledgePoints,
        knowledgeGraph: { nodes: [], edges: [] },
        knowledgeScopePlan: content.knowledgeScopePlan,
        courseEvidence: content.courseEvidence,
      },
      outlinePreview,
      blueprintPreview,
    });
  });

  it("returns saved details alongside the job resumed by the existing recovery flow", async () => {
    mocks.find.mockResolvedValue(storedJob({ courseId: "course-1" }, "failed"));
    mocks.recover.mockResolvedValue(storedJob({ courseId: "course-1" }, "queued"));

    const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

    expect(await response.json()).toMatchObject({
      job: { status: "queued" },
      knowledgePreview: null,
      outlinePreview,
      blueprintPreview,
    });
    expect(mocks.recover).toHaveBeenCalledWith("course-1");
  });

  it("returns empty previews before any course design has been saved", async () => {
    mocks.course.mockResolvedValue(undefined);

    const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      job: null,
      knowledgePreview: null,
      outlinePreview: [],
      blueprintPreview: null,
    });
  });

  it("keeps legacy page outlines available when no teaching blueprint was saved", async () => {
    mocks.course.mockResolvedValue({ id: "course-1", content: { _openmaicSceneOutlines: outlinePreview } });

    const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

    expect(await response.json()).toMatchObject({ outlinePreview, blueprintPreview: null });
  });

  it.each([401, 403, 404])("rejects unauthorized access before reading jobs or saved details (%s)", async (status) => {
    mocks.authorize.mockResolvedValue(Response.json({ error: "ACCESS_DENIED" }, { status }));

    const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: "ACCESS_DENIED" });
    expect(mocks.find).not.toHaveBeenCalled();
    expect(mocks.course).not.toHaveBeenCalled();
    expect(mocks.recover).not.toHaveBeenCalled();
  });
});

describe("resource-package design generation admission", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue("teacher-1");
    mocks.course.mockResolvedValue(undefined);
    mocks.find.mockResolvedValue(null);
    mocks.packageJob.mockResolvedValue(null);
    mocks.references.mockResolvedValue([]);
    mocks.checkpoints.mockResolvedValue({});
  });

  it("continues a saved first draft without replacing the task or creating an authoring request", async () => {
    mocks.savedResume.mockResolvedValue({
      ...storedJob({ courseId: "course-1", authoringRequestId: "original-request" }, "queued"),
      tokenUsage: 326863, tokenUsageCalls: 3,
    });
    const response = await PATCH(patchRequest({ action: "resume-saved-first-draft" }), context);
    expect(response.status).toBe(200);
    expect(mocks.savedResume).toHaveBeenCalledWith("course-1", "teacher-1");
    expect(await response.json()).toMatchObject({ job: { id: "job-1", status: "queued",
      tokenUsage: { totalTokens: 326863, calls: 3 } } });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it.each([409, 422])("reports saved-draft rejection without starting a replacement request (%s)", async (status) => {
    mocks.savedResume.mockRejectedValue(new mocks.SavedCourseDesignFirstDraftResumeError(
      "SAVED_FIRST_DRAFT_INVALID", "首稿仍有缺失内容，原稿和已完成成果已保留。", status,
    ));
    const response = await PATCH(patchRequest({ action: "resume-saved-first-draft" }), context);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: "SAVED_FIRST_DRAFT_INVALID",
      detail: "首稿仍有缺失内容，原稿和已完成成果已保留。" });
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.replace).not.toHaveBeenCalled();
  });

  it("passes the teacher-selected test section to the durable design task", async () => {
    mocks.resume.mockResolvedValue({
      ...storedJob({ courseId: "course-1", generationScope: "test-lesson", testSectionId: "section-b" }, "queued"),
      reviewStatus: "approved",
    });
    const sceneOutlines = [{ id: "slide-b", title: "模型评估", type: "slide", lectureSectionId: "section-b" }];
    const response = await PATCH(patchRequest({ action: "resume", reviewKind: "outline", sceneOutlines, testSectionId: "section-b" }), context);
    expect(response.status).toBe(200);
    expect(mocks.resume).toHaveBeenCalledWith("course-1", expect.objectContaining({ testSectionId: "section-b", sceneOutlines }));
    expect(await response.json()).toMatchObject({ job: { requestPreview: { testSectionId: "section-b" } } });
  });

  it("returns a correction request for an invalid test-section selection", async () => {
    mocks.resume.mockRejectedValue(new mocks.TestLessonSelectionError("请重新选择测试小节"));
    const response = await PATCH(patchRequest({ action: "resume", reviewKind: "outline", testSectionId: "missing" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_TEST_LESSON_SELECTION", detail: "请重新选择测试小节" });
  });

  it("returns the current streamed-call phase for live progress", async () => {
    mocks.find.mockResolvedValue({
      ...storedJob({ courseId: "course-1", teacherBrief: "" }, "running"),
      step: "knowledgePoints",
      currentCall: {
        stage: "knowledgePoints",
        status: "reasoning",
        attempt: 2,
        maxAttempts: 3,
      },
    });

    const response = await GET(new NextRequest("http://localhost/api/courses/course-1/design-generation"), context);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      job: {
        currentCall: { status: "reasoning", attempt: 2, maxAttempts: 3 },
        requestPreview: { assessmentMode: "adaptive" },
      },
    });
  });

  it("requires a confirmed resource package for new generation", async () => {
    const response = await POST(request({ teacherBrief: "生成新课程" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "RESOURCE_PACKAGE_REQUIRED" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });

  it("validates package revision before starting a durable task", async () => {
    const response = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: "3" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "INVALID_RESOURCE_PACKAGE" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("persists the confirmed package and its sources even with no supplementary brief", async () => {
    const resourcePackage = { schemaVersion: 1, id: "package-1", revision: 3, source: { id: "zip-1", fileName: "教学.zip", url: "/private/zip" }, documents: {}, draft: emptyResourcePackageDraft(), confirmedAt: "2026-09-12T00:00:00Z" };
    const material = { id: "plan-1", fileName: "教案.docx", mimeType: "application/docx", content: "教案关键正文" };
    mocks.resolve.mockResolvedValue({ resourcePackage, referenceMaterials: [material] });
    mocks.create.mockImplementation(({ data }: { data: { request: unknown } }) => Promise.resolve(storedJob(data.request, "queued")));
    const response = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: 3, supplementalAnswers: { brief: "" } }), context);
    expect(response.status).toBe(202);
    expect(mocks.resolve).toHaveBeenCalledWith("course-1", "package-1", 3, "teacher-1");
    expect(mocks.create.mock.calls[0][0].data.request).toMatchObject({
      teacherBrief: "",
      generationModelString: "deepseek:deepseek-v4-flash",
      resourcePackage,
      referenceMaterials: [material],
      supplementalAnswers: { brief: "" },
      generationContractVersion: 3,
      assessmentMode: "adaptive",
    });
    expect(await response.json()).toMatchObject({ job: { requestPreview: { resourcePackageId: "package-1", resourcePackageRevision: 3, assessmentMode: "adaptive" } } });
  });

  it("accepts deep response independently and rejects unknown assessment modes", async () => {
    const resourcePackage = { schemaVersion: 1, id: "package-1", revision: 3, source: { id: "zip-1", fileName: "教学.zip", url: "/private/zip" }, documents: {}, draft: emptyResourcePackageDraft(), confirmedAt: "2026-09-12T00:00:00Z" };
    mocks.resolve.mockResolvedValue({ resourcePackage, referenceMaterials: [] });
    mocks.create.mockImplementation(({ data }: { data: { request: unknown } }) => Promise.resolve(storedJob(data.request, "queued")));
    const accepted = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: 3, assessmentMode: "constructed-response" }), context);
    expect(accepted.status).toBe(202);
    expect(mocks.create.mock.calls[0][0].data.request).toMatchObject({
      generationContractVersion: 3,
      assessmentMode: "constructed-response",
    });
    const rejected = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: 3, assessmentMode: "essay" }), context);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "INVALID_ASSESSMENT_MODE" });
  });

  it("lets an explicit ordinary check replace a saved deep-response preference", async () => {
    const resourcePackage = { schemaVersion: 1, id: "package-1", revision: 3, source: { id: "zip-1", fileName: "教学.zip", url: "/private/zip" }, documents: {}, draft: emptyResourcePackageDraft(), confirmedAt: "2026-09-12T00:00:00Z" };
    const previous = {
      courseId: "course-1",
      teacherBrief: "",
      generationModelString: "deepseek:deepseek-v4-flash",
      resourcePackage,
      referenceMaterials: [],
      textbookSelections: [],
      generationScope: "full-course",
      generationMode: "standard",
      generationContractVersion: 3,
      assessmentMode: "constructed-response",
      options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false },
    };
    mocks.find.mockResolvedValue(storedJob(previous));
    mocks.resolve.mockResolvedValue({ resourcePackage, referenceMaterials: [] });
    mocks.replace.mockImplementation(({ data }: { data: { request: unknown } }) => Promise.resolve(storedJob(data.request, "queued")));

    const response = await POST(request({
      resourcePackageId: "package-1",
      resourcePackageRevision: 3,
      assessmentMode: "adaptive",
    }), context);

    expect(response.status).toBe(202);
    expect(mocks.replace.mock.calls[0][0]).toMatchObject({
      checkpointPolicy: "all",
      data: { request: expect.objectContaining({ assessmentMode: "adaptive" }) },
    });
    expect(await response.json()).toMatchObject({ job: { requestPreview: { assessmentMode: "adaptive" } } });
  });

  it("archives and replaces only the rejected design stage for an explicit submission", async () => {
    const resourcePackage = { schemaVersion: 1, id: "package-1", revision: 3, source: { id: "zip-1", fileName: "教学.zip", url: "/private/zip" }, documents: {}, draft: emptyResourcePackageDraft(), confirmedAt: "2026-09-12T00:00:00Z" };
    const previous = {
      courseId: "course-1",
      teacherBrief: "",
      generationModelString: "deepseek:deepseek-v4-flash",
      resourcePackage,
      referenceMaterials: [],
      textbookSelections: [],
      generationScope: "full-course",
      generationMode: "standard",
      generationContractVersion: 3,
      assessmentMode: "adaptive",
      options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false },
    };
    const failed = { ...storedJob(previous, "failed"), version: 9, tokenUsage: 12_345, tokenUsageCalls: 2 };
    mocks.find.mockResolvedValue(failed);
    mocks.resolve.mockResolvedValue({ resourcePackage, referenceMaterials: [] });
    mocks.checkpoints.mockResolvedValue({
      knowledgeStructure: { status: 'validated', rawResponse: 'accepted knowledge' },
      knowledgeStructureAttempt: { attemptsStarted: 1 },
      aiDuration: { status: 'invalid-output', rawResponse: 'rejected duration' },
      aiDurationAttempt: { attemptsStarted: 1 },
    });
    mocks.replace.mockImplementation(({ data }: { data: { request: unknown } }) => Promise.resolve({ ...failed, ...data, status: "queued" }));

    const response = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: 3 }), context);

    expect(response.status).toBe(202);
    expect(mocks.replace).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "job-1", status: "failed", version: 9 },
      checkpointPolicy: { steps: ['course-design:ai-duration', 'course-design-attempt:ai-duration', 'design-authoring:aiDurationPlanning'] },
      data: expect.objectContaining({
        tokenUsage: 12_345,
        tokenUsageCalls: 2,
        executionId: null,
        executionOwner: null,
        leaseExpiresAt: null,
        request: expect.objectContaining({ authoringRequestId: expect.stringMatching(/^[\da-f-]{36}$/u) }),
      }),
    }));
  });

  it("persists the bounded test scope and rejects unknown generation scopes", async () => {
    const resourcePackage = { schemaVersion: 1, id: "package-1", revision: 3, source: { id: "zip-1", fileName: "教学.zip", url: "/private/zip" }, documents: {}, draft: emptyResourcePackageDraft(), confirmedAt: "2026-09-12T00:00:00Z" };
    mocks.resolve.mockResolvedValue({ resourcePackage, referenceMaterials: [] });
    mocks.create.mockImplementation(({ data }: { data: { request: unknown } }) => Promise.resolve(storedJob(data.request, "queued")));

    const accepted = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: 3, generationScope: "test-lesson" }), context);
    expect(accepted.status).toBe(202);
    expect(mocks.create.mock.calls[0][0].data.request).toMatchObject({ generationScope: "test-lesson" });
    expect(await accepted.json()).toMatchObject({ job: { requestPreview: { generationScope: "test-lesson" } } });

    const rejected = await POST(request({ resourcePackageId: "package-1", resourcePackageRevision: 3, generationScope: "shortcut" }), context);
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ error: "INVALID_GENERATION_SCOPE" });
  });

  it("promotes a completed test lesson through the dedicated continuation action", async () => {
    const promotedJob = storedJob({
      courseId: "course-1",
      teacherBrief: "",
      generationScope: "full-course",
    });
    mocks.promote.mockResolvedValue({ designJob: promotedJob, contentJob: { id: "content-1" } });

    const response = await PATCH(patchRequest({ action: "promote-test-lesson" }), context);

    expect(response.status).toBe(202);
    expect(mocks.promote).toHaveBeenCalledWith("course-1");
    expect(await response.json()).toMatchObject({
      job: { requestPreview: { generationScope: "full-course" } },
    });
  });

  it("keeps the test lesson unchanged when it is not ready for full-course promotion", async () => {
    mocks.promote.mockRejectedValue(new mocks.TestLessonPromotionError(
      "TEST_LESSON_NOT_COMPLETED",
      "测试小节尚未完整生成",
      409,
    ));

    const response = await PATCH(patchRequest({ action: "promote-test-lesson" }), context);

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "TEST_LESSON_NOT_COMPLETED",
      detail: "测试小节尚未完整生成",
    });
  });

  it("only allows legacy requests to resume with the same parameters", async () => {
    const original = {
      courseId: "course-1",
      teacherBrief: "旧课程要求",
      generationModelString: "deepseek:deepseek-v4-flash",
    };
    mocks.find.mockResolvedValue(storedJob(original));
    expect((await POST(request({ teacherBrief: "旧课程要求" }), context)).status).toBe(202);
    const changed = await POST(request({ teacherBrief: "新课程要求" }), context);
    expect(changed.status).toBe(400);
    expect(await changed.json()).toMatchObject({ error: "RESOURCE_PACKAGE_REQUIRED" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it.each(["queued", "running", "needs_selection", "failed", "ready"])("refuses old free-form input once a resource package import exists (%s)", async (status) => {
    mocks.find.mockResolvedValue(storedJob({ courseId: "course-1", teacherBrief: "旧课程要求" }, "failed"));
    mocks.packageJob.mockResolvedValue({ id: "import-1", status });
    const response = await POST(request({ teacherBrief: "旧课程要求" }), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "RESOURCE_PACKAGE_REQUIRED" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});
