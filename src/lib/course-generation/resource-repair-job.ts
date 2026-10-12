import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import {
  CLASSROOMS_DIR,
  readClassroom,
  updatePersistedClassroomScenes,
  updatePersistedClassroomScenesIfRevision,
} from "@/lib/openmaic/server/classroom-storage";
import { classroomAudioStoragePath, planClassroomTtsRecovery } from "@/lib/openmaic/server/classroom-asset-recovery";
import { generateClassroomAssets } from "@/lib/openmaic/server/classroom-asset-generation";
import {
  findUnresolvedClassroomMedia,
  alignClassroomSpeechActions,
  generateTTSForClassroom,
  resolveServerTtsTimingSelection,
} from "@/lib/openmaic/server/classroom-media-generation";
import {
  findMissingTtsResources,
  repairMissingTeachingToolResources,
} from "@/lib/course-generation/resource-readiness";
import { generateAdaptiveBranchResource } from "@/lib/course-generation/job-runner";
import { resolveDurableCourseSceneOutlines } from "@/lib/course-generation/course-resource-outlines";
import { mapWithConcurrency } from "@openmaic/lib/utils/concurrency";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { Action, SpeechAction } from "@/lib/openmaic/types/action";
import {
  normalizeSpeechAlignmentLanguage,
  SPEECH_ALIGNMENT_VERSION,
} from "@/lib/openmaic/server/speech-alignment";
import { resolveAlignedSpeechCueRange } from "@/lib/openmaic/generation/speech-cue-boundaries";
import {
  calibrateGeneratedVisualCues,
  recoverLegacyVisualCueAnchors,
} from "@/lib/openmaic/generation/semantic-visual-cues";

export type CourseResourceRepairMode = "missing-resources" | "speech-sync";

export type CourseResourceRepairStatus = {
  status: "idle" | "running" | "completed" | "failed";
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  mode?: CourseResourceRepairMode;
  completed?: number;
  total?: number;
  failed?: number;
};

type CourseResourceRepairJob = {
  status: CourseResourceRepairStatus;
  completion: Promise<void>;
};

type ResourceRepairRuntimeState = {
  jobs: Map<string, CourseResourceRepairJob>;
};

const RESOURCE_REPAIR_STATE_KEY = Symbol.for("openpbl.course-resource-repair");

function runtimeState(): ResourceRepairRuntimeState {
  const scope = globalThis as typeof globalThis & {
    [RESOURCE_REPAIR_STATE_KEY]?: ResourceRepairRuntimeState;
  };
  return scope[RESOURCE_REPAIR_STATE_KEY] ??= { jobs: new Map() };
}

function repairKey(courseId: string, mode: CourseResourceRepairMode): string {
  return `${courseId}:${mode}`;
}

export function getCourseResourceRepairStatus(
  courseId: string,
  mode: CourseResourceRepairMode = "missing-resources",
): CourseResourceRepairStatus {
  return runtimeState().jobs.get(repairKey(courseId, mode))?.status ?? { status: "idle", mode };
}

async function repairCourseResources(courseId: string, baseUrl: string): Promise<void> {
  const course = await getCourse(courseId);
  if (!course) throw new Error("Course not found");
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  const classroom = classroomId ? await readClassroom(classroomId) : null;
  const storedOutlines = course.content._openmaicSceneOutlines ?? [];
  const outlines = await resolveDurableCourseSceneOutlines(courseId, storedOutlines);
  if (JSON.stringify(outlines) !== JSON.stringify(storedOutlines)) {
    await updateCourse(courseId, (current) => ({
      ...current,
      content: { ...current.content, _openmaicSceneOutlines: outlines },
    }));
  }

  if (classroom && classroomId) {
    const repairedTools = repairMissingTeachingToolResources(outlines, classroom.scenes);
    let scenes = repairedTools.scenes;
    if (repairedTools.changed) await updatePersistedClassroomScenes(classroomId, scenes);

    // An audioUrl is not proof that its local file is still usable. Clear only
    // missing/corrupt managed clips so the ordinary TTS pipeline can rebuild
    // them while preserving all healthy and external narration.
    const recovery = await planClassroomTtsRecovery(
      { ...classroom, scenes },
      CLASSROOMS_DIR,
    );
    scenes = recovery.classroom.scenes;
    if (recovery.missingActionIds.length > 0) {
      await updatePersistedClassroomScenes(classroomId, scenes);
    }

    // A persisted provider failure may refer to a placeholder that the teacher
    // already replaced or removed. Only retry media still unresolved on a page.
    const mediaFailures = findUnresolvedClassroomMedia(outlines, scenes);
    if (mediaFailures.length > 0) {
      const missingElementIds = new Set(mediaFailures.map((failure) => failure.elementId));
      const repairOutlines = outlines.flatMap((outline) => {
        const mediaGenerations = (outline.mediaGenerations ?? []).filter((candidate) => {
          if (!candidate || typeof candidate !== "object") return false;
          const elementId = (candidate as { elementId?: unknown }).elementId;
          return typeof elementId === "string" && missingElementIds.has(elementId);
        });
        return mediaGenerations.length > 0 ? [{ ...outline, mediaGenerations }] : [];
      }) as unknown as SceneOutline[];
      try {
        await generateClassroomAssets({
          outlines: repairOutlines,
          baseUrl,
          studentClassroomId: classroomId,
          studentScenes: scenes,
          enableImageGeneration: mediaFailures.some((failure) => failure.type === "image"),
          enableVideoGeneration: mediaFailures.some((failure) => failure.type === "video"),
          enableTTS: false,
          isPblCourse: true,
          ttsTimingSelection: resolveServerTtsTimingSelection(),
        });
      } catch {
        // Exact provider failures are persisted by the asset generator. Keep
        // repairing independent resources and expose them through the audit.
      }
    }

    if (findMissingTtsResources(scenes).length > 0) {
      try {
        await generateTTSForClassroom(
          scenes,
          classroomId,
          baseUrl,
          undefined,
          resolveServerTtsTimingSelection(),
        );
      } catch {
        // Keep successfully generated clips and continue with adaptive assets.
      } finally {
        await updatePersistedClassroomScenes(classroomId, scenes);
      }
    }
  }

  const plan = course.content.adaptiveLearningPlan;
  const branchIds = course.content.classroomGenerationRun?.scope !== "test-lesson" && plan?.enabled
    ? plan.branches.flatMap((branch) =>
        branch.enabled !== false
        && branch.status === "teacher-confirmed"
        && (branch.preparedResource?.status !== "ready" || !branch.preparedResource.classroomId)
          ? [branch.id]
          : [],
      )
    : [];
  const repairController = new AbortController();
  await mapWithConcurrency(branchIds, 2, async (branchId) => {
    try {
      await generateAdaptiveBranchResource(courseId, branchId, repairController.signal);
    } catch {
      // The branch helper persists its exact failure; continue other branches.
    }
  });
}

function hasCurrentSpeechAlignment(speech: SpeechAction, audioHash: string, language: string): boolean {
  const alignment = speech.speechAlignment;
  if (alignment?.status !== "aligned" || alignment.version !== SPEECH_ALIGNMENT_VERSION
    || alignment.audioHash !== audioHash || alignment.language !== language
    || alignment.textHash !== createHash("sha256").update(speech.text, "utf8").digest("hex")
    || !Array.isArray(alignment.spans) || !alignment.spans.length) return false;
  let previousChar = 0;
  let previousMs = 0;
  for (const span of alignment.spans) {
    if (![span.startChar, span.endChar, span.startMs, span.endMs].every((value) => Number.isSafeInteger(value) && value >= 0)
      || span.startChar < previousChar || span.endChar <= span.startChar || span.endChar > speech.text.length
      || span.startMs < previousMs || span.endMs < span.startMs
      || span.text !== speech.text.slice(span.startChar, span.endChar)
      || (speech.audioDurationSec && span.endMs > speech.audioDurationSec * 1000 + 1000)) return false;
    previousChar = span.endChar;
    previousMs = span.endMs;
  }
  return Boolean(resolveAlignedSpeechCueRange(speech.text, alignment.spans, 0, speech.text.length));
}

/** Keep every unaffected action, including its position and authored metadata. */
function replaceAffectedVisualCues(actions: Action[], replacements: Action[], affected: ReadonlySet<string>): Action[] {
  const byId = new Map(replacements.map((action) => [action.id, action]));
  return actions.flatMap((action) => affected.has(action.id)
    ? byId.has(action.id) ? [byId.get(action.id)!] : []
    : [action]);
}

function affectedVisualCues(actions: Action[], speechIds: ReadonlySet<string>): Map<string, Set<string>> {
  const affected = new Map<string, Set<string>>();
  actions.forEach((action, index) => {
    if (action.type !== "spotlight" && action.type !== "laser") return;
    const next = actions.slice(index + 1).find((candidate) => candidate.type !== "spotlight" && candidate.type !== "laser");
    const startId = action.speechId ?? (next?.type === "speech" && next.text.trim() ? next.id : undefined);
    const endId = action.type === "spotlight" ? action.endSpeechId ?? startId : startId;
    const related = new Set([startId, endId].filter((id): id is string => Boolean(id && speechIds.has(id))));
    if (related.size) affected.set(action.id, related);
  });
  return affected;
}

async function repairSpeechSynchronization(
  courseId: string,
  onProgress: (completed: number, total: number, failed: number) => void,
): Promise<{ total: number; failed: number }> {
  const course = await getCourse(courseId);
  if (!course) throw new Error("Course not found");
  const classroomId = course.aiLearningClassroomId || course.content._openmaicClassroomId;
  if (!classroomId) throw new Error("课程尚未生成 AI 课堂，无法修复朗读同步");
  const classroom = await readClassroom(classroomId);
  if (!classroom) throw new Error("课程课堂文件不存在，无法修复朗读同步");
  const expectedRevision = classroom.revision ?? 0;
  const scenes = structuredClone(classroom.scenes);
  const targets: Array<{ sceneId: string; speech: SpeechAction; key: string; needsAlignment: boolean; error?: string }> = [];
  const audioHashes = new Map<string, Promise<string>>();
  for (const scene of scenes) {
    for (const speech of scene.actions ?? []) {
      if (speech.type !== "speech" || !speech.text.trim() || !speech.audioUrl) continue;
      const target = { sceneId: scene.id, speech, key: JSON.stringify([scene.id, speech.id]), needsAlignment: false };
      try {
        if (speech.audioInvalidated) throw new Error("讲稿音频已失效，请先修复缺失资源，再重试朗读同步");
        const audioPath = classroomAudioStoragePath(CLASSROOMS_DIR, speech.audioUrl);
        if (!audioPath) throw new Error("无法在本机核验讲稿音频，原有对齐已保留");
        let hash = audioHashes.get(audioPath);
        if (!hash) {
          hash = readFile(audioPath).then((bytes) => {
            if (!bytes.length) throw new Error("讲稿音频为空");
            return createHash("sha256").update(bytes).digest("hex");
          });
          audioHashes.set(audioPath, hash);
        }
        const audioHash = await hash;
        const language = normalizeSpeechAlignmentLanguage(scene.timingPlan?.language);
        target.needsAlignment = !hasCurrentSpeechAlignment(speech, audioHash, language);
        if (target.needsAlignment || speech.speechAlignment?.error) targets.push(target);
      } catch (error) {
        // An unreadable/opaque asset is not evidence that a saved timeline is
        // disposable. Report the target without overwriting that alignment.
        targets.push({ ...target, error: error instanceof Error ? error.message : "无法读取讲稿音频，原有对齐已保留" });
      }
    }
  }
  const total = targets.length;
  onProgress(0, total, 0);
  if (!total) return { total: 0, failed: 0 };
  const unavailable = targets.filter((target) => target.error).length;
  const actionKeys = new Set(targets.filter((target) => target.needsAlignment && !target.error).map((target) => target.key));
  let completed = unavailable;
  let failed = unavailable;
  onProgress(completed, total, failed);
  if (actionKeys.size) {
    await alignClassroomSpeechActions({
      scenes,
      classroomId,
      actionKeys,
      onProgress: (progress) => {
        if (progress.status === "failed") failed += 1;
        completed = unavailable + progress.completed;
        onProgress(completed, total, failed);
      },
    });
  }
  const bindingScenes = scenes.flatMap((scene) => {
    const sceneTargets = targets.filter((target) => target.sceneId === scene.id && !target.error
      && target.speech.speechAlignment?.status === "aligned");
    if (!sceneTargets.length || scene.content.type !== "slide") return [];
    const affected = affectedVisualCues(scene.actions ?? [], new Set(sceneTargets.map((target) => target.speech.id)));
    return affected.size ? [{ scene, sceneTargets, affected }] : [];
  });
  const outlines = bindingScenes.length ? await resolveDurableCourseSceneOutlines(
    courseId, course.content._openmaicSceneOutlines ?? [],
  ) : [];
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  for (const { scene, sceneTargets, affected } of bindingScenes) {
    if (scene.content.type !== "slide") continue;
    const affectedIds = new Set(affected.keys());
    const recovered = recoverLegacyVisualCueAnchors({
      elements: scene.content.canvas.elements, actions: structuredClone(scene.actions ?? []),
    });
    const issues = recovered.issues.filter((issue) => affectedIds.has(issue.actionId));
    scene.actions = replaceAffectedVisualCues(scene.actions ?? [], recovered.actions, affectedIds);
    const outline = outlineById.get(scene.outlineId ?? scene.id);
    if (outline) {
      const calibrated = calibrateGeneratedVisualCues({ outline: outline as SceneOutline,
        elements: scene.content.canvas.elements, actions: structuredClone(scene.actions ?? []) });
      scene.actions = replaceAffectedVisualCues(scene.actions ?? [], calibrated, affectedIds);
    }
    for (const target of sceneTargets) {
      const cueIds = new Set([...affected].filter(([, speechIds]) => speechIds.has(target.speech.id)).map(([id]) => id));
      if (!cueIds.size) continue;
      const issue = issues.find((candidate) => cueIds.has(candidate.actionId));
      if (issue) target.speech.speechAlignment!.error = issue.reason;
      else if (!outline) target.speech.speechAlignment!.error = "缺少页面教学大纲，无法校准指示动作";
      else if ([...cueIds].some((id) => !scene.actions?.some((action) => action.id === id))) {
        target.speech.speechAlignment!.error = "指示动作未能绑定到有效的讲稿范围";
      }
      else delete target.speech.speechAlignment!.error;
    }
  }
  const reportedFailed = targets.filter((target) => target.error
    || target.speech.speechAlignment?.status !== "aligned" || target.speech.speechAlignment.error).length;
  onProgress(total, total, reportedFailed);
  if (JSON.stringify(scenes) !== JSON.stringify(classroom.scenes)) {
    await updatePersistedClassroomScenesIfRevision(classroomId, scenes, expectedRevision);
  }
  if (reportedFailed === total) {
    const reason = targets.find((target) => target.error)?.error
      ?? targets.find((target) => target.speech.speechAlignment?.error)?.speech.speechAlignment?.error;
    if (reason) throw new Error(reason);
    throw new Error("语音对齐服务未能完成任何讲稿，请检查本机对齐服务后重试");
  }
  return { total, failed: reportedFailed };
}

/**
 * Start one process-wide repair per course. The returned promise is intended
 * for Next.js `after()`, so long TTS batches do not keep the POST open until a
 * reverse proxy mistakes healthy generation for a timed-out request.
 */
export function startCourseResourceRepair(
  courseId: string,
  baseUrl: string,
  mode: CourseResourceRepairMode = "missing-resources",
): CourseResourceRepairJob & { started: boolean } {
  const state = runtimeState();
  const key = repairKey(courseId, mode);
  const existing = state.jobs.get(key);
  if (existing?.status.status === "running") return { ...existing, started: false };

  const startedAt = new Date().toISOString();
  const job = {
    status: { status: "running", startedAt, mode, completed: 0, total: 0, failed: 0 } as CourseResourceRepairStatus,
    completion: Promise.resolve(),
  };
  state.jobs.set(key, job);
  const work = mode === "speech-sync"
    ? repairSpeechSynchronization(courseId, (completed, total, failed) => {
        job.status = { ...job.status, status: "running", completed, total, failed };
      })
    : repairCourseResources(courseId, baseUrl).then(() => ({ total: 0, failed: 0 }));
  job.completion = work
    .then((result) => {
      job.status = {
        status: "completed",
        startedAt,
        finishedAt: new Date().toISOString(),
        mode,
        completed: result.total,
        total: result.total,
        failed: result.failed,
      };
    })
    .catch((error: unknown) => {
      job.status = {
        ...job.status,
        status: "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        mode,
        error: error instanceof Error ? error.message : "课程资源修复失败",
      };
    });
  return { ...job, started: true };
}
