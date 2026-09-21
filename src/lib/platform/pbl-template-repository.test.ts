import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ template: vi.fn(), createTemplate: vi.fn(), updateTemplate: vi.fn(), createVersion: vi.fn(), updateVersion: vi.fn(), files: vi.fn(), transaction: vi.fn(), lock: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { $transaction: mocks.transaction } }));
import { createPblTemplateCourse, encodePblTemplate } from "./pbl-template";
import { getPblTemplatePublicationState, savePblTemplateCourse } from "./pbl-template-repository";
const now = new Date("2026-09-01T00:00:00Z");
const course = createPblTemplateCourse("template", { name: "Original" });
function template(status = "DRAFT") { return { id: "template", ownerId: "teacher", status: "ACTIVE", createdAt: now, updatedAt: now, versions: [{ id: "v1", version: 1, status, snapshot: encodePblTemplate(course) }] }; }
beforeEach(() => {
  vi.resetAllMocks(); mocks.template.mockResolvedValue(template()); mocks.files.mockResolvedValue([]);
  mocks.transaction.mockImplementation((fn) => fn({
    $executeRaw: mocks.lock, classroomTemplate: { findUnique: mocks.template, create: mocks.createTemplate, update: mocks.updateTemplate },
    classroomTemplateVersion: { create: mocks.createVersion, update: mocks.updateVersion }, fileAsset: { findMany: mocks.files },
  }));
});
describe("V2 PBL template persistence", () => {
  it("reports the immutable published version separately from the editable draft", async () => {
    const state = await getPblTemplatePublicationState("template", {
      classroomTemplate: {
        findUnique: vi.fn().mockResolvedValue({
          versions: [
            { version: 3, status: "DRAFT" },
            { version: 2, status: "PUBLISHED" },
          ],
        }),
      },
    } as never);
    expect(state).toEqual({ latestVersion: 3, publishedVersion: 2, draftVersion: 3 });
  });

  it("uses the immutable published snapshot as the source of a new editable draft", async () => {
    mocks.template.mockResolvedValue(template("PUBLISHED"));
    await savePblTemplateCourse({ ...course, name: "Revised", version: now.getTime(), status: "ready" }, "teacher");
    expect(mocks.updateVersion).not.toHaveBeenCalled();
    expect(mocks.createVersion).toHaveBeenCalledWith({ data: expect.objectContaining({ templateId: "template", version: 2, status: "DRAFT", snapshot: expect.objectContaining({ design: expect.objectContaining({ name: "Revised" }) }) }) });
  });
  it("publishes a draft without mutating any previous version", async () => {
    await savePblTemplateCourse({ ...course, version: now.getTime(), status: "ready" }, "teacher");
    expect(mocks.updateVersion).toHaveBeenCalledWith({ where: { id: "v1" }, data: expect.objectContaining({ status: "PUBLISHED" }) });
    expect(mocks.createVersion).not.toHaveBeenCalled();
  });
  it("rejects stale authoring writes before touching the template", async () => {
    await expect(savePblTemplateCourse({ ...course, version: now.getTime() - 1 }, "teacher")).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
    expect(mocks.updateTemplate).not.toHaveBeenCalled();
  });
  it("requires ownership of the template and referenced upload assets", async () => {
    await expect(savePblTemplateCourse(course, "other")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(savePblTemplateCourse({ ...course, resources: [{ id: "foreign", title: "Private file", type: "PDF", size: "1 MB", downloadedBy: [] }] }, "teacher")).rejects.toMatchObject({ code: "INVALID_TEMPLATE_RESOURCE" });
    expect(mocks.files).toHaveBeenCalledWith({ where: { id: { in: ["foreign"] }, uploadedById: "teacher", deletedAt: null }, select: { id: true } });
  });
  it("preserves published version identity on a content-identical save", async () => {
    const snapshot = JSON.parse(JSON.stringify(encodePblTemplate(course)));
    mocks.template.mockResolvedValue({ ...template("PUBLISHED"), versions: [{ ...template("PUBLISHED").versions[0], snapshot }] });
    await savePblTemplateCourse(course, "teacher");
    expect(mocks.updateVersion).not.toHaveBeenCalled(); expect(mocks.createVersion).not.toHaveBeenCalled();
  });
});
