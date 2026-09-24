import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";

const getCourse = vi.fn();
const updateCourse = vi.fn();
const readClassroom = vi.fn();
const updatePersistedClassroomScenes = vi.fn();
const updatePersistedClassroomScenesIfRevision = vi.fn();
const planClassroomTtsRecovery = vi.fn();
const generateClassroomAssets = vi.fn();
const findUnresolvedClassroomMedia = vi.fn();
const generateTTSForClassroom = vi.fn();
const alignClassroomSpeechActions = vi.fn();
const findMissingTtsResources = vi.fn();
const repairMissingTeachingToolResources = vi.fn();
const generateAdaptiveBranchResource = vi.fn();
const resolveDurableCourseSceneOutlines = vi.fn();

vi.mock("@/lib/session/server-store", () => ({ getCourse, updateCourse }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({
  CLASSROOMS_DIR: "/tmp/openpbl-resource-repair-tests", readClassroom,
  updatePersistedClassroomScenes, updatePersistedClassroomScenesIfRevision,
}));
vi.mock("@/lib/openmaic/server/classroom-asset-recovery", () => ({ planClassroomTtsRecovery }));
vi.mock("@/lib/openmaic/server/classroom-asset-generation", () => ({ generateClassroomAssets }));
vi.mock("@/lib/openmaic/server/classroom-media-generation", () => ({
  findUnresolvedClassroomMedia, generateTTSForClassroom, alignClassroomSpeechActions,
  resolveServerTtsTimingSelection: () => "word",
}));
vi.mock("@/lib/course-generation/resource-readiness", () => ({
  findMissingTtsResources, repairMissingTeachingToolResources,
}));
vi.mock("@/lib/course-generation/job-runner", () => ({ generateAdaptiveBranchResource }));
vi.mock("@/lib/course-generation/course-resource-outlines", () => ({ resolveDurableCourseSceneOutlines }));
vi.mock("@/lib/openmaic/generation/semantic-visual-cues", () => ({
  calibrateGeneratedVisualCues: vi.fn(), recoverLegacyVisualCueAnchors: vi.fn(),
}));

describe("course resource repair", () => {
  beforeEach(() => {
    for (const mock of [getCourse, updateCourse, readClassroom, updatePersistedClassroomScenes,
      updatePersistedClassroomScenesIfRevision, planClassroomTtsRecovery, generateClassroomAssets,
      findUnresolvedClassroomMedia, generateTTSForClassroom, alignClassroomSpeechActions,
      findMissingTtsResources, repairMissingTeachingToolResources, generateAdaptiveBranchResource,
      resolveDurableCourseSceneOutlines]) mock.mockReset();
    planClassroomTtsRecovery.mockImplementation(async (classroom) => ({ classroom, missingActionIds: [] }));
    repairMissingTeachingToolResources.mockImplementation((_outlines, scenes) => ({ changed: false, scenes }));
    findMissingTtsResources.mockReturnValue([]);
    findUnresolvedClassroomMedia.mockReturnValue([]);
    resolveDurableCourseSceneOutlines.mockImplementation(async (_id, outlines) => outlines);
  });

  it("does not retry a provider failure after the page asset was replaced", async () => {
    const course = {
      id: "replaced-media-course", aiLearningClassroomId: "replaced-classroom",
      content: { _openmaicSceneOutlines: [{ id: "page", mediaGenerations: [{
        type: "image", elementId: "gen_img_old", prompt: "插图",
      }] }] },
    } as unknown as Course;
    const classroom = {
      id: "replaced-classroom", scenes: [{
        id: "slide", outlineId: "page", type: "slide", content: { type: "slide", canvas: { elements: [{
          id: "replacement", type: "image", src: "/api/openmaic/classroom-media/replaced-classroom/media/new.png",
        }] } }, actions: [],
      }],
      assetGeneration: { status: "partial-failure", requested: 1, completed: 0,
        failures: [{ type: "image", elementId: "gen_img_old", error: "旧失败" }], updatedAt: "2026-09-24" },
    } as unknown as PersistedClassroomData;
    getCourse.mockResolvedValue(course);
    readClassroom.mockResolvedValue(classroom);

    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    const job = startCourseResourceRepair(course.id, "");
    await job.completion;

    expect(getCourseResourceRepairStatus(course.id).status).toBe("completed");
    expect(findUnresolvedClassroomMedia).toHaveBeenCalledWith(course.content._openmaicSceneOutlines, classroom.scenes);
    expect(generateClassroomAssets).not.toHaveBeenCalled();
  });

  it("still retries media that the current page references as an unresolved placeholder", async () => {
    const course = {
      id: "current-placeholder-course", aiLearningClassroomId: "current-classroom",
      content: { _openmaicSceneOutlines: [{ id: "page", mediaGenerations: [
        { type: "image", elementId: "gen_img_current", prompt: "当前插图" },
        { type: "video", elementId: "gen_vid_replaced", prompt: "旧视频" },
      ] }] },
    } as unknown as Course;
    const classroom = {
      id: "current-classroom", scenes: [{ id: "slide", outlineId: "page", type: "slide",
        content: { type: "slide", canvas: { elements: [{ id: "image", type: "image", src: "gen_img_current" }] } }, actions: [] }],
      assetGeneration: { status: "partial-failure", requested: 2, completed: 0,
        failures: [{ type: "video", elementId: "gen_vid_replaced", error: "旧失败" }], updatedAt: "2026-09-24" },
    } as unknown as PersistedClassroomData;
    getCourse.mockResolvedValue(course);
    readClassroom.mockResolvedValue(classroom);
    findUnresolvedClassroomMedia.mockReturnValue([{ type: "image", elementId: "gen_img_current", error: "占位符" }]);

    const { startCourseResourceRepair } = await import("./resource-repair-job");
    const job = startCourseResourceRepair(course.id, "");
    await job.completion;

    expect(generateClassroomAssets).toHaveBeenCalledWith(expect.objectContaining({
      enableImageGeneration: true, enableVideoGeneration: false,
      outlines: [expect.objectContaining({ mediaGenerations: [expect.objectContaining({ elementId: "gen_img_current" })] })],
    }));
  });

  it("does not generate whole-course adaptive branches while repairing a test lesson", async () => {
    const course = {
      id: "repair-test-lesson", aiLearningClassroomId: "test-classroom",
      content: {
        _openmaicSceneOutlines: [],
        classroomGenerationRun: { scope: "test-lesson", status: "completed" },
        adaptiveLearningPlan: { enabled: true, branches: [{
          id: "outside", enabled: true, status: "teacher-confirmed",
          preparedResource: { status: "failed" },
        }] },
      },
    } as unknown as Course;
    const classroom = {
      id: "test-classroom", scenes: [{ id: "slide", type: "slide", actions: [] }],
    } as unknown as PersistedClassroomData;
    getCourse.mockResolvedValue(course);
    readClassroom.mockResolvedValue(classroom);

    const { startCourseResourceRepair } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "").completion;

    expect(generateAdaptiveBranchResource).not.toHaveBeenCalled();
  });
});
