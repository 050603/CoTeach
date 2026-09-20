/**
 * Post-response classroom asset generation.
 *
 * The classroom body is useful before any external media provider responds.
 * This module fills in image/video placeholders and TTS URLs after the body
 * has been persisted, updating each split classroom snapshot atomically.
 */

import { createLogger } from '@openmaic/lib/logger';
import {
  updatePersistedClassroomScenes,
  updatePersistedClassroomAssetStatus,
} from '@openmaic/lib/server/classroom-storage';
import {
  generateMediaForClassroom,
  generateTTSForClassroom,
  findUnresolvedClassroomMedia,
  replaceMediaPlaceholders,
  type ClassroomMediaItemProgress,
  type ServerTtsTimingSelection,
} from '@openmaic/lib/server/classroom-media-generation';
import { runIndependentClassroomAssetTasks } from '@openmaic/lib/server/classroom-asset-tasks';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import type { TeachingTimingAudit } from '@/lib/session/types';
import type { MediaGenerationRequest } from '@openmaic/lib/media/types';
import { throwIfAborted } from '@openmaic/lib/generation/generation-retry';
import { assertRequestedClassroomMediaProviders } from '@openmaic/lib/server/classroom-media-readiness';

const log = createLogger('ClassroomAssets');

type MediaFailure = {
  elementId: string;
  type: 'image' | 'video';
  error: string;
};

type AssetFailure = MediaFailure | {
  elementId: string;
  type: 'tts';
  error: string;
};

export function formatClassroomMediaItemProgress(item: ClassroomMediaItemProgress): string {
  const label = item.type === 'image' ? '课堂配图' : '课堂视频';
  const ordinal = Math.min(
    item.total,
    item.completed + (item.status === 'completed' || item.status === 'failed' ? 0 : 1),
  );
  if (item.status === 'retrying') {
    return `${label} ${ordinal} / ${item.total} 正在进行第 ${item.attempt} / ${item.maxAttempts} 次生成，约 ${Math.max(1, Math.ceil((item.nextDelayMs ?? 0) / 1_000))} 秒后继续`;
  }
  if (item.status === 'completed') return `${label}已完成 ${item.completed} / ${item.total}`;
  if (item.status === 'failed') return `${label} ${item.completed} / ${item.total} 未通过审校，正在继续处理其余资源`;
  return `正在生成${label} ${ordinal} / ${item.total}`;
}

function mediaRequestKey(request: Pick<MediaGenerationRequest, 'elementId' | 'type'>): string {
  return `${request.type}:${request.elementId}`;
}

export function collectRequestedClassroomMedia(
  outlines: SceneOutline[],
  capabilities: { image: boolean; video: boolean },
): MediaGenerationRequest[] {
  const unique = new Map<string, MediaGenerationRequest>();
  for (const request of outlines.flatMap((outline) => outline.mediaGenerations ?? [])) {
    if (request.type === 'image' ? !capabilities.image : !capabilities.video) continue;
    unique.set(mediaRequestKey(request), request);
  }
  return Array.from(unique.values());
}

export function buildMediaRepairOutlines(
  outlines: SceneOutline[],
  failures: MediaFailure[],
): SceneOutline[] {
  const failureByKey = new Map(failures.map((failure) => [mediaRequestKey(failure), failure]));
  return outlines.flatMap((outline) => {
    const mediaGenerations = (outline.mediaGenerations ?? []).flatMap((request) => {
      const failure = failureByKey.get(mediaRequestKey(request));
      if (!failure) return [];
      return [{
        ...request,
        // Retry the teacher-confirmed request unchanged. Never replace failed
        // course media with generic/generated filler that could misrepresent
        // the intended teaching content.
        prompt: request.prompt,
      }];
    });
    return mediaGenerations.length > 0 ? [{ ...outline, mediaGenerations }] : [];
  });
}

export function reconcileMediaFailures(
  requestedMedia: MediaGenerationRequest[],
  mediaMap: Record<string, string>,
  latestFailures: MediaFailure[],
): MediaFailure[] {
  const failureByKey = new Map(latestFailures.map((failure) => [mediaRequestKey(failure), failure]));
  return requestedMedia.flatMap((request) => {
    if (mediaMap[request.elementId]) return [];
    return [failureByKey.get(mediaRequestKey(request)) ?? {
      elementId: request.elementId,
      type: request.type,
      error: '素材生成未返回可用文件',
    }];
  });
}

export interface ClassroomAssetGenerationInput {
  outlines: SceneOutline[];
  baseUrl: string;
  studentClassroomId: string;
  studentScenes: Scene[];
  teacherClassroomId?: string;
  teacherScenes?: Scene[];
  enableImageGeneration: boolean;
  enableVideoGeneration: boolean;
  enableTTS: boolean;
  isPblCourse: boolean;
  ttsTimingSelection: ServerTtsTimingSelection;
  signal?: AbortSignal;
  onProgress?: (progress: ClassroomAssetGenerationProgress) => Promise<void> | void;
}

export type ClassroomAssetGenerationProgress = {
  phase: 'media' | 'tts' | 'persisting';
  status: 'running' | 'completed' | 'partial-failure';
  completed: number;
  total: number;
  message: string;
};

const TEACHING_DURATION_TOLERANCE_RATIO = 0.1;

export function summarizeTeachingTimingAudit(input: Pick<ClassroomAssetGenerationInput, "outlines" | "studentScenes" | "enableTTS">): TeachingTimingAudit {
  const outlineById = new Map(input.outlines.map((outline) => [outline.id, outline]));
  const sceneByOutlineId = new Map(input.studentScenes.map((scene) => [scene.outlineId ?? scene.id, scene]));
  let measuredSegmentCount = 0;
  let narrationSegmentCount = 0;
  let measuredTeachingSec = 0;
  let measuredAssessmentSec = 0;
  for (const scene of input.studentScenes) {
    const outline = outlineById.get(scene.outlineId ?? scene.id);
    const role = outline?.plannedTiming?.role ?? (scene.type === "quiz" ? "assessment" : "teaching");
    for (const action of scene.actions ?? []) {
      if (action.type !== "speech" || !action.text.trim()) continue;
      narrationSegmentCount += 1;
      if (!input.enableTTS) continue;
      if (typeof action.audioDurationSec !== "number" || !Number.isFinite(action.audioDurationSec) || action.audioDurationSec <= 0) continue;
      measuredSegmentCount += 1;
      if (role === "assessment") measuredAssessmentSec += action.audioDurationSec;
      else measuredTeachingSec += action.audioDurationSec;
    }
  }
  const totalBudgetSec = input.outlines.reduce((sum, outline) => sum + Math.max(0, outline.targetDurationSec ?? outline.estimatedDuration ?? 0), 0);
  const plannedSubstantiveTeachingSec = input.outlines
    .filter((outline) => outline.type !== "quiz" && outline.plannedTiming?.role !== "assessment")
    .reduce((sum, outline) => sum + (outline.plannedTiming?.narrationSec
      ?? sceneByOutlineId.get(outline.id)?.timingPlan?.targetDurationSec
      ?? 0), 0);
  const plannedAssessmentSec = input.outlines
    .filter((outline) => outline.type === "quiz" || outline.plannedTiming?.role === "assessment")
    .reduce((sum, outline) => sum + Math.max(0, outline.targetDurationSec ?? outline.estimatedDuration ?? 0), 0);
  const plannedLearnerActivitySec = Math.max(0, totalBudgetSec - plannedSubstantiveTeachingSec - plannedAssessmentSec);
  const substantiveTeachingDurationSec = Math.round((input.enableTTS ? measuredTeachingSec : plannedSubstantiveTeachingSec) * 10) / 10;
  const substantiveTeachingRatio = substantiveTeachingDurationSec / Math.max(1, totalBudgetSec);
  const teachingDurationDeviationRatio = plannedSubstantiveTeachingSec > 0
    ? Math.abs(substantiveTeachingDurationSec - plannedSubstantiveTeachingSec) / plannedSubstantiveTeachingSec
    : Number.POSITIVE_INFINITY;
  const teachingRatioValid = plannedSubstantiveTeachingSec > 0
    ? teachingDurationDeviationRatio <= TEACHING_DURATION_TOLERANCE_RATIO
    : substantiveTeachingDurationSec > 0 && substantiveTeachingDurationSec <= totalBudgetSec;
  return {
    schemaVersion: 1,
    totalBudgetSec: Math.round(totalBudgetSec),
    plannedSubstantiveTeachingSec: Math.round(plannedSubstantiveTeachingSec),
    plannedAssessmentSec: Math.round(plannedAssessmentSec),
    plannedLearnerActivitySec: Math.round(plannedLearnerActivitySec),
    substantiveTeachingDurationSec,
    assessmentAudioDurationSec: Math.round(measuredAssessmentSec * 10) / 10,
    narrationDurationSource: input.enableTTS ? "actual-audio" : "estimated-script",
    measuredSegmentCount,
    narrationSegmentCount,
    complete: !input.enableTTS || (narrationSegmentCount > 0 && measuredSegmentCount === narrationSegmentCount),
    substantiveTeachingRatio: Math.round(substantiveTeachingRatio * 10_000) / 10_000,
    teachingDurationDeviationRatio: Math.round(teachingDurationDeviationRatio * 10_000) / 10_000,
    teachingDurationToleranceRatio: TEACHING_DURATION_TOLERANCE_RATIO,
    teachingRatioValid,
    generatedAt: new Date().toISOString(),
  };
}

function classroomGroups(input: ClassroomAssetGenerationInput): Array<{
  classroomId: string;
  scenes: Scene[];
  role: 'student' | 'teacher';
}> {
  const groups: Array<{
    classroomId: string;
    scenes: Scene[];
    role: 'student' | 'teacher';
  }> = [
    {
      classroomId: input.studentClassroomId,
      scenes: input.studentScenes,
      role: 'student',
    },
  ];

  if (input.teacherClassroomId && input.teacherScenes?.length) {
    groups.push({
      classroomId: input.teacherClassroomId,
      scenes: input.teacherScenes,
      role: 'teacher',
    });
  }

  return groups;
}

async function persistSceneGroups(
  groups: ReturnType<typeof classroomGroups>,
): Promise<void> {
  await Promise.all(
    groups.map((group) =>
      updatePersistedClassroomScenes(group.classroomId, group.scenes),
    ),
  );
}

/**
 * Generate and backfill all optional media for a split classroom.
 *
 * Images and videos are generated once against the student classroom media
 * directory, matching the original classroom URL contract. The resulting map
 * is applied to both student and teacher scene snapshots, avoiding duplicate
 * image/video API calls for the same course content.
 */
export async function generateClassroomAssets(
  input: ClassroomAssetGenerationInput,
): Promise<TeachingTimingAudit> {
  assertRequestedClassroomMediaProviders(input);
  const groups = classroomGroups(input);
  const allScenes = groups.flatMap((group) => group.scenes);
  const hasMediaGeneration = input.enableImageGeneration || input.enableVideoGeneration;
  const capabilities = { image: input.enableImageGeneration, video: input.enableVideoGeneration };
  const requestedMedia = collectRequestedClassroomMedia(input.outlines, capabilities);
  const ttsOnlyStatus = input.enableTTS && !hasMediaGeneration;
  const trackedAssetCount = ttsOnlyStatus ? groups.length : requestedMedia.length;

  const updateAssetStatus = async (
    status: 'running' | 'completed' | 'partial-failure',
    completed: number,
    failures: AssetFailure[],
  ) => {
    await Promise.all(groups.map((group) => updatePersistedClassroomAssetStatus(group.classroomId, {
      status,
      requested: trackedAssetCount,
      completed,
      failures,
      updatedAt: new Date().toISOString(),
    })));
  };

  const generateMediaAssets = async () => {
    if (!hasMediaGeneration) return;
    if (requestedMedia.length === 0) {
      const unplannedFailures = findUnresolvedClassroomMedia([], allScenes);
      if (unplannedFailures.length === 0) return;
      await updateAssetStatus('partial-failure', 0, unplannedFailures);
      await input.onProgress?.({
        phase: 'media',
        status: 'partial-failure',
        completed: 0,
        total: unplannedFailures.length,
        message: `检测到 ${unplannedFailures.length} 项媒体生成计划缺失`,
      });
      log.error(
        `Classroom media plan missing [studentClassroomId=${input.studentClassroomId}, placeholders=${unplannedFailures.length}]`,
      );
      return;
    }
    try {
      throwIfAborted(input.signal);
      await input.onProgress?.({
        phase: 'media',
        status: 'running',
        completed: 0,
        total: requestedMedia.length,
        message: `正在生成并插入 ${requestedMedia.length} 项图片与视频资源`,
      });
      await updateAssetStatus('running', 0, []);
      const result = await generateMediaForClassroom(
        input.outlines, input.studentClassroomId, input.baseUrl, capabilities, input.signal,
        async (item) => {
          await input.onProgress?.({ phase: 'media', status: 'running', completed: item.completed,
            total: item.total, message: formatClassroomMediaItemProgress(item) });
        },
      );
      replaceMediaPlaceholders(allScenes, result.mediaMap, input.outlines);
      await persistSceneGroups(groups);
      const failures = reconcileMediaFailures(requestedMedia, result.mediaMap, result.failures);

      const completed = requestedMedia.length - failures.length;
      await updateAssetStatus(failures.length > 0 ? 'partial-failure' : 'completed', completed, failures);
      await input.onProgress?.({
        phase: 'media',
        status: failures.length > 0 ? 'partial-failure' : 'completed',
        completed,
        total: requestedMedia.length,
        message: failures.length > 0
          ? `已插入 ${completed} / ${requestedMedia.length} 项媒体资源`
          : `已完成 ${completed} 项图片与视频资源`,
      });
      log.info(
        `Classroom media backfilled [studentClassroomId=${input.studentClassroomId}, files=${completed}, missing=${failures.length}]`,
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      log.warn('Classroom media backfill failed; content remains available:', error);
      await updateAssetStatus('partial-failure', 0, [{
        elementId: 'media-batch',
        type: input.enableImageGeneration ? 'image' : 'video',
        error: error instanceof Error ? error.message : String(error),
      }]).catch((statusError) => log.warn('Failed to persist asset failure status:', statusError));
      await input.onProgress?.({
        phase: 'media',
        status: 'partial-failure',
        completed: 0,
        total: requestedMedia.length,
        message: '视觉资源生成暂未完成，课堂正文与已生成资源均已保留',
      });
    }
  };

  const generateSpeechAssets = async () => {
    if (!input.enableTTS) return;

    // PBL teacher resources are intentionally excluded from server-side TTS.
    // Non-PBL classrooms retain the previous behavior and receive audio for
    // both split resource sets.
    const ttsGroups = input.isPblCourse
      ? groups.filter((group) => group.role === 'student')
      : groups;

    await input.onProgress?.({
      phase: 'tts',
      status: 'running',
      completed: 0,
      total: ttsGroups.length,
      message: '正在生成课堂讲授语音',
    });

    // Process split classrooms one at a time so the provider concurrency limit
    // remains global even when a non-PBL classroom has both student and teacher
    // resources. Speech segments inside each call are finite-concurrent.
    for (let index = 0; index < ttsGroups.length; index += 1) {
      const group = ttsGroups[index];
      throwIfAborted(input.signal);
      try {
        await generateTTSForClassroom(
          group.scenes,
          group.classroomId,
          input.baseUrl,
          input.signal,
          input.ttsTimingSelection,
        );
        await updatePersistedClassroomScenes(group.classroomId, group.scenes);
        log.info(
          `Classroom TTS backfilled [classroomId=${group.classroomId}, role=${group.role}]`,
        );
        await input.onProgress?.({
          phase: 'tts',
          status: index === ttsGroups.length - 1 ? 'completed' : 'running',
          completed: index + 1,
          total: ttsGroups.length,
          message: index === ttsGroups.length - 1 ? '课堂讲授语音已经生成并写入页面' : '正在继续生成课堂讲授语音',
        });
      } catch (error) {
        if (input.signal?.aborted) throw error;
        // Keep successful segments durable, but surface the remaining missing
        // audio to the caller so generation cannot be marked fully ready.
        await updatePersistedClassroomScenes(group.classroomId, group.scenes);
        log.warn(
          `Classroom TTS backfill failed [classroomId=${group.classroomId}]; content remains available:`,
          error,
        );
        if (ttsOnlyStatus) {
          await updateAssetStatus('partial-failure', 0, [{
            elementId: 'tts-batch',
            type: 'tts',
            error: error instanceof Error ? error.message : String(error),
          }]);
        }
        throw error;
      }
    }
  };

  // Media/video providers and speech providers are independent. Their existing
  // bounded pipelines can overlap without changing prompts, retry policies,
  // provider concurrency, or quality checks. Persist once more after both have
  // finished so the shared scene snapshots contain the merged asset updates.
  if (ttsOnlyStatus) await updateAssetStatus('running', 0, []);
  await runIndependentClassroomAssetTasks({
    media: generateMediaAssets,
    tts: generateSpeechAssets,
    persistMergedState: async () => {
      await input.onProgress?.({
        phase: 'persisting',
        status: 'running',
        completed: 0,
        total: groups.length,
        message: '正在合并并保存课堂资源',
      });
      await persistSceneGroups(groups);
      await input.onProgress?.({
        phase: 'persisting',
        status: 'completed',
        completed: groups.length,
        total: groups.length,
        message: '课堂页面与配套资源已经保存',
      });
    },
  });
  // Only advertise a playable classroom after the merged scene snapshot —
  // including every generated audioUrl — has been durably persisted. Keeping
  // this outside persistMergedState also prevents a rejected TTS task from
  // overwriting its partial-failure status with completed.
  if (ttsOnlyStatus) await updateAssetStatus('completed', groups.length, []);
  return summarizeTeachingTimingAudit(input);
}
