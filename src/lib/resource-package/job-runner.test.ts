import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResourcePackageDraft } from "./types";
const mocks = vi.hoisted(() => ({ find: vi.fn(), update: vi.fn(), updateMany: vi.fn(), file: vi.fn(), upsert: vi.fn(), save: vi.fn(), privateFile: vi.fn(), convert: vi.fn(), stat: vi.fn(), read: vi.fn(), presentation: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ prisma: { fileAsset: { findFirst: mocks.file, upsert: mocks.upsert } } }));
vi.mock("@/lib/course-generation/job-storage", () => ({ resourcePackageJobs: { findUnique: mocks.find, update: mocks.update, updateMany: mocks.updateMany } }));
vi.mock("@/lib/session/server-store", () => ({ updateCourse: mocks.save }));
vi.mock("./server", () => ({ packageResult: (job: { result: unknown }) => job.result, resourcePackageDataDir: () => "/private/uploads", readPrivatePackageFile: mocks.privateFile }));
vi.mock("./launch-presentation", () => ({ buildAdaptedLaunchPages: () => [], writeClassroomPresentation: mocks.presentation }));
vi.mock("@/lib/uploads/presentation-converter", async (importOriginal) => ({ ...await importOriginal<typeof import("@/lib/uploads/presentation-converter")>(), convertPresentationToPdf: mocks.convert }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const overrides = { readFile: mocks.read, stat: mocks.stat, writeFile: async () => undefined, rename: async () => undefined, rm: async () => undefined };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
import { PresentationConversionError } from "@/lib/uploads/presentation-converter";
import { runResourcePackageJob } from "./job-runner";
import type { Course } from "@/lib/session/types";

let course: Course;
let job: Record<string, unknown>;
beforeEach(() => {
  vi.resetAllMocks();
  const resourcePackage = { schemaVersion: 1, id: "source", revision: 1, source: { id: "source", fileName: "资源包.zip", url: "/api/uploads/source" },
    documents: { launchPresentation: { id: "launch", fileName: "项目启动.pptx", url: "/api/uploads/launch" } }, draft: emptyResourcePackageDraft() };
  job = { id: "job", status: "queued", request: { courseId: "course", requestedBy: "teacher", uploadId: "source", revision: 1, selections: {} }, result: { package: resourcePackage } };
  course = { id: "course", resources: [], content: { resourcePackage } } as unknown as Course;
  mocks.find.mockImplementation(async () => job);
  mocks.updateMany.mockResolvedValue({ count: 1 });
  mocks.update.mockImplementation(async ({ data }) => { job = { ...job, ...data }; return job; });
  mocks.file.mockResolvedValue(null);
  mocks.privateFile.mockResolvedValue({ file: { id: "launch", size: BigInt(1000), originalName: "项目启动.pptx" }, filePath: "/private/uploads/launch.pptx" });
  mocks.convert.mockResolvedValue({ size: 100, mimeType: "application/pdf" });
  mocks.read.mockResolvedValue(Buffer.from("%PDF")); mocks.stat.mockResolvedValue({ size: 100 });
  mocks.presentation.mockResolvedValue(Buffer.from("adapted-pptx"));
  mocks.upsert.mockResolvedValue({ id: "preview" });
  mocks.save.mockImplementation(async (_id: string, updater: (course: Course) => Course) => { course = updater(course); });
});
describe("resource package presentation jobs", () => {
  it("retains parsed inputs after conversion failure and binds one launch resource after retry", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.convert.mockRejectedValueOnce(new PresentationConversionError("CONVERSION_FAILED", "failed"));
    await runResourcePackageJob("job");
    expect(job.status).toBe("failed");
    expect((job.result as { package: { documents: unknown } }).package.documents).toBeTruthy();
    expect(course.resources).toHaveLength(0);
    expect(course.content.resourcePackage?.launchResourceId).toBeUndefined();
    job.status = "queued";
    await runResourcePackageJob("job");
    expect(job.status).toBe("ready");
    expect(course.resources).toEqual([expect.objectContaining({ id: "launch", stageKey: "launch", previewType: "PDF", displayMode: "slides" })]);
    expect(course.content.resourcePackage?.launchResourceId).toBe("launch");
    expect(mocks.privateFile).toHaveBeenCalledWith("launch", "teacher");
    errorLog.mockRestore();
  });
  it("reuses an existing PDF and does not duplicate its classroom resource on recovery", async () => {
    await runResourcePackageJob("job");
    mocks.file.mockResolvedValue({ id: "preview", sourceAssetId: "launch", size: BigInt(100) });
    job.status = "queued";
    await runResourcePackageJob("job");
    expect(mocks.convert).toHaveBeenCalledTimes(1);
    expect(course.resources).toHaveLength(1);
    expect(job.status).toBe("ready");
  });
  it("does not process a job claimed by another worker", async () => {
    mocks.updateMany.mockResolvedValue({ count: 0 });
    await runResourcePackageJob("job");
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.privateFile).not.toHaveBeenCalled();
  });
  it("pauses for source conflicts before conversion or binding the original launch PPT", async () => {
    const result = job.result as { package: Record<string, unknown> };
    result.package.conflicts = [{ id: "classroom-organization" }];
    await runResourcePackageJob("job");
    expect(job.status).toBe("blocked");
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(course.resources).toHaveLength(0);
  });
  it("never falls back to the conflicting original and binds exactly one adapted resource after conversion retry", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = job.result as { package: Record<string, unknown> };
    result.package.conflicts = [{ id: "classroom-organization" }];
    result.package.adaptation = { draftSignature: "approved-content", sourceRevision: 1, conflictVersion: "v1" };
    mocks.privateFile.mockImplementation(async (id: string) => ({ file: { id, size: BigInt(1000), originalName: id === "launch" ? "原始PPT.pptx" : "适配授课版.pptx" }, filePath: `/private/uploads/${id}.pptx`, bytes: Buffer.from("pptx") }));
    mocks.convert.mockRejectedValueOnce(new PresentationConversionError("CONVERSION_FAILED", "failed"));
    await runResourcePackageJob("job");
    expect(job.status).toBe("failed");
    expect(course.resources).toHaveLength(0);
    expect(course.content.resourcePackage?.launchResourceId).toBeUndefined();
    job.status = "queued";
    await runResourcePackageJob("job");
    expect(job.status).toBe("ready");
    expect(course.resources).toHaveLength(1);
    expect(course.resources?.[0].id).not.toBe("launch");
    const adaptedId = course.resources?.[0].id;
    job.status = "queued";
    await runResourcePackageJob("job");
    expect(course.resources).toHaveLength(1);
    expect(course.resources?.[0].id).toBe(adaptedId);
    expect(course.content.resourcePackage?.documents.launchPresentation?.id).toBe("launch");
    errorLog.mockRestore();
  });
});
