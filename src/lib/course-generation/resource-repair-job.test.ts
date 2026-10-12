import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import type { PersistedClassroomData } from "@/lib/openmaic/server/classroom-storage";
import type { Action, SpeechAction } from "@/lib/openmaic/types/action";
import { SPEECH_ALIGNMENT_VERSION } from "@/lib/openmaic/server/speech-alignment";

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
const calibrateGeneratedVisualCues = vi.fn();
const recoverLegacyVisualCueAnchors = vi.fn();
const audioDirectories: string[] = [];

vi.mock("@/lib/session/server-store", () => ({ getCourse, updateCourse }));
vi.mock("@/lib/openmaic/server/classroom-storage", () => ({
  CLASSROOMS_DIR: "/tmp/openpbl-resource-repair-tests", readClassroom,
  updatePersistedClassroomScenes, updatePersistedClassroomScenesIfRevision,
}));
vi.mock("@/lib/openmaic/server/classroom-asset-recovery", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/openmaic/server/classroom-asset-recovery")>(),
  planClassroomTtsRecovery,
}));
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
  calibrateGeneratedVisualCues, recoverLegacyVisualCueAnchors,
}));

function alignment(text: string, bytes: Uint8Array): NonNullable<SpeechAction["speechAlignment"]> {
  return { version: SPEECH_ALIGNMENT_VERSION, status: "aligned", language: "Chinese",
    textHash: createHash("sha256").update(text, "utf8").digest("hex"),
    audioHash: createHash("sha256").update(bytes).digest("hex"),
    spans: [{ text, startChar: 0, endChar: text.length, startMs: 100, endMs: 900 }] };
}

async function speechFixture() {
  const root = "/tmp/openpbl-resource-repair-tests";
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "speech-"));
  audioDirectories.push(directory);
  await mkdir(path.join(directory, "audio"));
  const bytes = Buffer.from("original audio bytes");
  await writeFile(path.join(directory, "audio", "narration.wav"), bytes);
  const classroomId = path.basename(directory);
  const speech: SpeechAction = { id: "healthy", type: "speech", text: "正常讲稿。", audioDurationSec: 1,
    audioUrl: `/api/openmaic/classroom-media/${classroomId}/audio/narration.wav`,
    speechAlignment: alignment("正常讲稿。", bytes) };
  const scene: PersistedClassroomData["scenes"][number] = { id: "slide", outlineId: "page", type: "slide",
    stageId: "stage", title: "课件页面", order: 0,
    content: { type: "slide", canvas: { id: "canvas", viewportSize: 1000, viewportRatio: 16 / 9,
      theme: { backgroundColor: "#ffffff", themeColors: [], fontColor: "#000000", fontName: "Arial" }, elements: [] } },
    actions: [speech] };
  const classroom = { id: classroomId, revision: 7, scenes: [scene] } as PersistedClassroomData;
  const course = { id: classroomId, aiLearningClassroomId: classroomId,
    content: { _openmaicSceneOutlines: [{ id: "page" }], unrelated: "preserved" } } as unknown as Course;
  getCourse.mockResolvedValue(course);
  readClassroom.mockResolvedValue(classroom);
  return { directory, bytes, speech, scene, classroom, course };
}

function cue(id: string, speechId: string): Action {
  return { id, type: "laser", elementId: "content", speechId, speechOffsetMs: 100,
    speechAnchor: { quote: "讲稿" }, duration: 800, color: "#123456" };
}

function mockSuccessfulAlignment() {
  alignClassroomSpeechActions.mockImplementation(async ({ scenes, actionKeys, onProgress }) => {
    let completed = 0;
    for (const scene of scenes) {
      for (const action of scene.actions ?? []) {
        if (action.type !== "speech" || !actionKeys.has(JSON.stringify([scene.id, action.id]))) continue;
        const relative = action.audioUrl.slice("/api/openmaic/classroom-media/".length);
        const bytes = await readFile(path.join("/tmp/openpbl-resource-repair-tests", relative));
        action.speechAlignment = alignment(action.text, bytes);
        onProgress({ completed: ++completed, total: actionKeys.size, actionId: action.id, status: "aligned" });
      }
    }
    return { total: completed, aligned: completed, failed: 0 };
  });
}

describe("course resource repair", () => {
  beforeEach(() => {
    for (const mock of [getCourse, updateCourse, readClassroom, updatePersistedClassroomScenes,
      updatePersistedClassroomScenesIfRevision, planClassroomTtsRecovery, generateClassroomAssets,
      findUnresolvedClassroomMedia, generateTTSForClassroom, alignClassroomSpeechActions,
      findMissingTtsResources, repairMissingTeachingToolResources, generateAdaptiveBranchResource,
      resolveDurableCourseSceneOutlines, calibrateGeneratedVisualCues, recoverLegacyVisualCueAnchors]) mock.mockReset();
    planClassroomTtsRecovery.mockImplementation(async (classroom) => ({ classroom, missingActionIds: [] }));
    repairMissingTeachingToolResources.mockImplementation((_outlines, scenes) => ({ changed: false, scenes }));
    findMissingTtsResources.mockReturnValue([]);
    findUnresolvedClassroomMedia.mockReturnValue([]);
    resolveDurableCourseSceneOutlines.mockImplementation(async (_id, outlines) => outlines);
    recoverLegacyVisualCueAnchors.mockImplementation(({ actions }) => ({ actions, issues: [] }));
    calibrateGeneratedVisualCues.mockImplementation(({ actions }) => actions);
  });

  afterEach(async () => {
    await Promise.all(audioDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
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

  it("retries only the failed narration and keeps healthy speech and cues exactly unchanged", async () => {
    const { bytes, speech, scene, classroom, course } = await speechFixture();
    const retry = { ...structuredClone(speech), id: "retry", text: "需要重试的讲稿。",
      speechAlignment: { ...alignment("需要重试的讲稿。", bytes), status: "failed", error: "服务暂不可用" } } as SpeechAction;
    const healthyCue = cue("healthy-cue", speech.id);
    scene.actions = [healthyCue, speech, cue("retry-cue", retry.id), retry];
    const original = structuredClone(classroom);
    mockSuccessfulAlignment();
    // A whole-page calibration would also alter the healthy cue and action order.
    calibrateGeneratedVisualCues.mockImplementation(({ actions }) => actions.toReversed().map((action: Action) =>
      action.type === "laser" ? { ...action, speechOffsetMs: 500, duration: 300 } : action));

    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({
      status: "completed", total: 1, completed: 1, failed: 0,
    });
    expect([...alignClassroomSpeechActions.mock.calls[0][0].actionKeys]).toEqual([JSON.stringify([scene.id, retry.id])]);
    const saved = updatePersistedClassroomScenesIfRevision.mock.calls[0][1][0].actions as Action[];
    expect(saved.map((action) => action.id)).toEqual(scene.actions.map((action) => action.id));
    expect(saved[0]).toEqual(healthyCue);
    expect(saved[1]).toEqual(speech);
    expect(saved[2]).toMatchObject({ speechOffsetMs: 500, duration: 300 });
    expect(classroom).toEqual(original);
    expect(updatePersistedClassroomScenesIfRevision).toHaveBeenCalledWith(classroom.id, expect.any(Array), 7);
    expect(updateCourse).not.toHaveBeenCalled();
    expect(generateTTSForClassroom).not.toHaveBeenCalled();
    expect(generateAdaptiveBranchResource).not.toHaveBeenCalled();
  });

  it.each(["text", "audio", "version", "language", "span-coverage"] as const)(
    "retries an aligned narration when its %s no longer matches, preserving valid narration", async (changed) => {
      const { directory, speech, scene, course } = await speechFixture();
      const stale = { ...structuredClone(speech), id: "stale" };
      if (changed === "text") stale.text += "新增讲解。";
      if (changed === "audio") {
        const newBytes = Buffer.from("updated audio bytes");
        await writeFile(path.join(directory, "audio", "changed.wav"), newBytes);
        stale.audioUrl = stale.audioUrl!.replace("narration.wav", "changed.wav");
      }
      if (changed === "version") stale.speechAlignment!.version = "old-aligner-version";
      if (changed === "language") stale.speechAlignment!.language = "English";
      if (changed === "span-coverage") stale.speechAlignment!.spans = [{
        text: stale.text.slice(1), startChar: 1, endChar: stale.text.length, startMs: 100, endMs: 900,
      }];
      scene.actions = [speech, stale];
      mockSuccessfulAlignment();

      const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
      await startCourseResourceRepair(course.id, "", "speech-sync").completion;

      expect([...alignClassroomSpeechActions.mock.calls[0][0].actionKeys]).toEqual([JSON.stringify([scene.id, stale.id])]);
      expect(updatePersistedClassroomScenesIfRevision.mock.calls[0][1][0].actions[0]).toEqual(speech);
      expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({ status: "completed", total: 1, failed: 0 });
    },
  );

  it("completes an empty retry without calibration or a new classroom revision", async () => {
    const { speech, scene, course } = await speechFixture();
    scene.actions = [cue("healthy-cue", speech.id), speech];
    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({
      status: "completed", total: 0, completed: 0, failed: 0,
    });
    expect(alignClassroomSpeechActions).not.toHaveBeenCalled();
    expect(recoverLegacyVisualCueAnchors).not.toHaveBeenCalled();
    expect(calibrateGeneratedVisualCues).not.toHaveBeenCalled();
    expect(updatePersistedClassroomScenesIfRevision).not.toHaveBeenCalled();
  });

  it("repairs only a binding error without resubmitting its valid alignment", async () => {
    const { bytes, speech, scene, course } = await speechFixture();
    const binding = { ...structuredClone(speech), id: "binding",
      speechAlignment: { ...alignment(speech.text, bytes), error: "原绑定失败" } };
    scene.actions = [cue("healthy-cue", speech.id), speech, cue("binding-cue", binding.id), binding];
    recoverLegacyVisualCueAnchors.mockImplementation(({ actions }) => ({ issues: [], actions: actions.map((action: Action) =>
      action.type === "laser" ? { ...action, speechAnchor: { quote: "正常讲稿" } } : action) }));
    const originalSpeech = structuredClone(speech);
    const originalCue = structuredClone(scene.actions[0]);

    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(alignClassroomSpeechActions).not.toHaveBeenCalled();
    const saved = updatePersistedClassroomScenesIfRevision.mock.calls[0][1][0].actions as Action[];
    expect(saved[0]).toEqual(originalCue);
    expect(saved[1]).toEqual(originalSpeech);
    expect(saved[3]).toMatchObject({ speechAlignment: { status: "aligned", spans: binding.speechAlignment.spans } });
    expect((saved[3] as SpeechAction).speechAlignment?.error).toBeUndefined();
    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({ status: "completed", total: 1, failed: 0 });
  });

  it("retains a real binding diagnostic when calibration cannot retain the affected cue", async () => {
    const { speech, scene, course } = await speechFixture();
    speech.speechAlignment!.error = "原绑定失败";
    scene.actions = [cue("binding-cue", speech.id), speech];
    calibrateGeneratedVisualCues.mockImplementation(({ actions }) => actions.filter((action: Action) => action.type !== "laser"));
    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(alignClassroomSpeechActions).not.toHaveBeenCalled();
    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({
      status: "failed", total: 1, completed: 1, failed: 1, error: "指示动作未能绑定到有效的讲稿范围",
    });
    expect(updatePersistedClassroomScenesIfRevision.mock.calls[0][1][0].actions[0]).toMatchObject({
      type: "speech", speechAlignment: { status: "aligned", error: "指示动作未能绑定到有效的讲稿范围" },
    });
  });

  it.each(["missing", "external"] as const)("preserves an unreadable %s audio alignment and exposes the target failure", async (kind) => {
    const { directory, speech, scene, classroom, course } = await speechFixture();
    if (kind === "missing") await rm(path.join(directory, "audio", "narration.wav"));
    else speech.audioUrl = "https://audio.example.test/narration.wav";
    scene.actions = [cue("healthy-cue", speech.id), speech];
    const original = structuredClone(classroom);
    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({ status: "failed", total: 1, completed: 1, failed: 1 });
    expect(alignClassroomSpeechActions).not.toHaveBeenCalled();
    expect(updatePersistedClassroomScenesIfRevision).not.toHaveBeenCalled();
    expect(classroom).toEqual(original);
  });

  it("keeps failure progress scoped to the retry while service failure leaves healthy narration untouched", async () => {
    const { bytes, speech, scene, course } = await speechFixture();
    const retry = { ...structuredClone(speech), id: "retry", speechAlignment: { ...alignment(speech.text, bytes), status: "failed" } } as SpeechAction;
    scene.actions = [cue("healthy-cue", speech.id), speech, cue("retry-cue", retry.id), retry];
    alignClassroomSpeechActions.mockImplementation(async ({ scenes, actionKeys, onProgress }) => {
      const target = scenes[0].actions.find((action: Action) => actionKeys.has(JSON.stringify([scene.id, action.id])));
      target.speechAlignment = { ...target.speechAlignment, status: "failed", error: "GPU 正忙" };
      onProgress({ completed: 1, total: 1, actionId: target.id, status: "failed" });
      return { total: 1, aligned: 0, failed: 1 };
    });
    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({ status: "failed", mode: "speech-sync", total: 1, completed: 1, failed: 1 });
    const saved = updatePersistedClassroomScenesIfRevision.mock.calls[0][1][0].actions as Action[];
    expect(saved[0]).toEqual(scene.actions[0]);
    expect(saved[1]).toEqual(speech);
    expect(saved[2]).toEqual(scene.actions[2]);
    expect(recoverLegacyVisualCueAnchors).not.toHaveBeenCalled();
    expect(calibrateGeneratedVisualCues).not.toHaveBeenCalled();
  });

  it("retains retry progress if the classroom revision changed before saving", async () => {
    const { speech, course } = await speechFixture();
    speech.speechAlignment!.status = "failed";
    mockSuccessfulAlignment();
    updatePersistedClassroomScenesIfRevision.mockRejectedValue(new Error("Classroom revision conflict"));
    const { startCourseResourceRepair, getCourseResourceRepairStatus } = await import("./resource-repair-job");
    await startCourseResourceRepair(course.id, "", "speech-sync").completion;

    expect(getCourseResourceRepairStatus(course.id, "speech-sync")).toMatchObject({
      status: "failed", total: 1, completed: 1, failed: 0, error: "Classroom revision conflict",
    });
    expect(updateCourse).not.toHaveBeenCalled();
  });
});
