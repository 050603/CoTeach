// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ configured: vi.fn(), find: vi.fn(), query: vi.fn(), legacy: vi.fn(), decode: vi.fn() }));
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: mocks.configured, prisma: { classroomInstance: { findUnique: mocks.find }, $queryRaw: mocks.query } }));
vi.mock("@/lib/session/server-store", () => ({ getCourse: mocks.legacy }));
vi.mock("@/lib/platform/pbl-template", () => ({ decodePblTemplate: mocks.decode }));
import { loadAiProgressContext } from "./ai-progress-context";

describe("narrow AI progress reads", () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.configured.mockReturnValue(true);
    mocks.decode.mockReturnValue({ aiLearningClassroomId: "lesson", content: {} });
    mocks.query.mockResolvedValue([{ id: 'course', snapshot: {}, studentId: 'student', progress: { completedScenes: ['scene'] } }]);
    mocks.find.mockResolvedValue({ id: "course", templateVersion: { snapshot: {} }, participations: [
      { enrollment: { userId: "student" }, workspace: { projectState: { aiLearningProgress: { completedScenes: ["scene"] }, unrelated: "private draft" } } },
    ] });
  });
  it("limits learner records in the query and returns only progress context", async () => {
    const context = await loadAiProgressContext("course", "student");
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls[0].slice(1)).toEqual(['student', 'course']);
    expect(mocks.find).not.toHaveBeenCalled();
    expect(context).toMatchObject({ aiLearningClassroomId: "lesson", students: [{ id: "student" }], aiLearningProgress: { student: { completedScenes: ["scene"] } } });
    expect(JSON.stringify(context)).not.toContain("private draft");
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("retains a teacher's whole-class progress query without loading whole Course", async () => {
    await loadAiProgressContext("course");
    expect(mocks.find.mock.calls[0][0].select.participations.where).toBeUndefined();
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("keeps the database-free development fallback and missing-course behavior", async () => {
    mocks.query.mockResolvedValue([]);
    expect(await loadAiProgressContext("missing", "student")).toBeUndefined();
    mocks.configured.mockReturnValue(false); mocks.legacy.mockResolvedValue({ id: "demo" });
    expect(await loadAiProgressContext("demo", "student")).toEqual({ id: "demo" });
    expect(mocks.legacy).toHaveBeenCalledWith("demo", { studentId: "student" });
  });
  it('preserves an empty learner context when the instance exists without their participation or workspace', async () => {
    mocks.query.mockResolvedValueOnce([{ id: 'course', snapshot: {}, studentId: null, progress: null }]);
    expect(await loadAiProgressContext('course', 'student')).toMatchObject({ students: [], aiLearningProgress: {} });
    mocks.query.mockResolvedValueOnce([{ id: 'course', snapshot: {}, studentId: 'student', progress: null }]);
    expect(await loadAiProgressContext('course', 'student')).toMatchObject({ students: [{ id: 'student' }], aiLearningProgress: {} });
    expect(mocks.legacy).not.toHaveBeenCalled();
  });
  it("preserves template preview progress when no classroom instance exists", async () => {
    mocks.find.mockResolvedValue(null);
    mocks.legacy.mockResolvedValue({ id: "template", aiLearningProgress: {} });
    expect(await loadAiProgressContext("template")).toEqual({ id: "template", aiLearningProgress: {} });
    expect(mocks.legacy).toHaveBeenCalledWith("template", undefined);
  });
});
