import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";

const mocks = vi.hoisted(() => ({ find: vi.fn(), packageJob: vi.fn(), create: vi.fn(), update: vi.fn(), resolve: vi.fn(), references: vi.fn() }));
vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: vi.fn().mockResolvedValue("teacher-1") }));
vi.mock("@/lib/platform/pbl-template-repository", () => ({ loadPblTemplateCourse: vi.fn().mockResolvedValue({ id: "course-1" }) }));
vi.mock("@/lib/course-generation/job-storage", () => ({ designGenerationJobs: { findUnique: mocks.find, create: mocks.create, update: mocks.update }, resourcePackageJobs: { findUnique: mocks.packageJob } }));
vi.mock("@/lib/course-generation/capability", () => ({ isBackgroundCourseGenerationEnabled: () => true }));
vi.mock("@/lib/course-design/job-runner", () => ({ initialQuickGenerationEstimateSeconds: () => 60, cancelCourseDesignJob: vi.fn(), pauseCourseDesignForOutlineReview: vi.fn(), resumeCourseDesignAfterOutlineReview: vi.fn(), runCourseDesignJob: vi.fn(), resumeRecoverableCourseDesignJob: vi.fn() }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: vi.fn() }));
vi.mock("@/lib/course-design/generation-references", () => ({ GenerationReferenceError: class extends Error {}, resolveGenerationReferenceMaterials: mocks.references }));
vi.mock("@/lib/resource-package/server", () => ({ ResourcePackageError: class extends Error {}, resolveConfirmedResourcePackage: mocks.resolve }));
vi.mock("@openmaic/lib/server/classroom-media-readiness", () => ({ assertRequestedClassroomMediaProviders: vi.fn(), classroomMediaConfigurationErrorResponse: vi.fn() }));
vi.mock("@/lib/openmaic/server/provider-config", () => ({
  findServerDefaultModelString: () => "deepseek:deepseek-v4-flash",
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };
function request(body: unknown) {
  return new NextRequest("http://localhost/api/courses/course-1/design-generation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
function storedJob(request: unknown, status = "completed") {
  return { id: "job-1", courseId: "course-1", status, step: "completed", progress: 100, request, trace: [], updatedAt: new Date("2026-09-12T00:00:00Z") };
}

describe("resource-package design generation admission", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.find.mockResolvedValue(null); mocks.packageJob.mockResolvedValue(null); mocks.references.mockResolvedValue([]); });

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
    });
    expect(await response.json()).toMatchObject({ job: { requestPreview: { resourcePackageId: "package-1", resourcePackageRevision: 3 } } });
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
