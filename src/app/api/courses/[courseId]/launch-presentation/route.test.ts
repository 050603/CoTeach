// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  findFile: vi.fn(),
  updateCourse: vi.fn(),
}));

vi.mock("@/lib/platform/template-access", () => ({ authorizeTemplateRequest: mocks.authorize }));
vi.mock("@/lib/db/client", () => ({ prisma: { fileAsset: { findFirst: mocks.findFile } } }));
vi.mock("@/lib/session/server-store", () => ({ updateCourse: mocks.updateCourse }));

import { PATCH } from "./route";

const courseId = "course-1";
const uploadId = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ courseId }) };
const course = {
  id: courseId,
  version: 7,
  status: "ready",
  resources: [
    { id: "old-ppt", title: "原课件", type: "PPTX", size: "1 MB", stageKey: "launch", downloadedBy: [] },
    { id: "handout", title: "任务单", type: "PDF", size: "1 MB", stageKey: "launch", downloadedBy: [] },
  ],
  content: { resourcePackage: {
    id: "package-1", revision: 3, source: { id: "zip-1", fileName: "原资源包.zip", url: "/api/uploads/zip-1" },
    documents: { knowledge: { id: "knowledge", fileName: "知识点.md", url: "/api/uploads/knowledge" }, launchPresentation: { id: "old-ppt", fileName: "原课件.pptx", url: "/api/uploads/old-ppt" } },
    launchResourceId: "old-ppt", adaptation: { sourceRevision: 2 },
  } },
};

function request(expectedVersion = 7) {
  return new Request(`https://app.test/api/courses/${courseId}/launch-presentation`, {
    method: "PATCH", headers: { "Content-Type": "application/json", origin: "https://app.test" },
    body: JSON.stringify({ uploadId, expectedVersion }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue("teacher-1");
  mocks.findFile.mockResolvedValueOnce({
    id: uploadId, originalName: "新版启动课件.pptx", size: BigInt(1024),
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    sha256: "abc", regenerationRecipe: { schemaVersion: 1, operation: "launch-presentation-replacement", courseId },
  }).mockResolvedValueOnce({ id: "preview-1" });
  mocks.updateCourse.mockImplementation(async (_id, updater) => ({ courses: [updater(course)] }));
});

describe("launch presentation replacement", () => {
  it("replaces the whole first-stage PPT while retaining other resources and package documents", async () => {
    const response = await PATCH(request(), context);
    expect(response.status).toBe(200);
    expect(mocks.findFile.mock.calls[1][0].where).toMatchObject({ sourceAssetId: uploadId, storageKey: `${uploadId}.classroom.pdf`, assetRole: "CLASSROOM_PREVIEW" });
    const updated = (await response.json()).course;
    expect(updated.status).toBe("preparing");
    expect(updated.resources.map((resource: { id: string }) => resource.id)).toEqual(["handout", uploadId]);
    expect(updated.resources[1]).toMatchObject({ stageKey: "launch", type: "PPTX", displayMode: "slides", previewUrl: `/api/uploads/${uploadId}?variant=classroom` });
    expect(updated.content.resourcePackage).toMatchObject({ revision: 4, launchResourceId: uploadId, documents: { knowledge: { id: "knowledge" }, launchPresentation: { id: uploadId, fileName: "新版启动课件.pptx" } }, classroomPresentation: { id: uploadId } });
    expect(updated.content.resourcePackage.adaptation).toBeUndefined();
  });

  it("rejects an upload without provenance for this course", async () => {
    mocks.findFile.mockReset().mockResolvedValue({ id: uploadId, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", regenerationRecipe: { operation: "launch-presentation-replacement", courseId: "another-course" } });
    const response = await PATCH(request(), context);
    expect(response.status).toBe(422);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("requires a generated classroom preview before changing the draft", async () => {
    mocks.findFile.mockReset().mockResolvedValueOnce({ id: uploadId, mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", regenerationRecipe: { operation: "launch-presentation-replacement", courseId } }).mockResolvedValueOnce(null);
    const response = await PATCH(request(), context);
    expect(response.status).toBe(422);
    expect(mocks.updateCourse).not.toHaveBeenCalled();
  });

  it("rejects a stale course version without replacing its PPT", async () => {
    const response = await PATCH(request(6), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ code: "VERSION_CONFLICT" });
  });
});
