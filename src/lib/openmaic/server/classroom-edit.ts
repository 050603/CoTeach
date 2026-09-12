import { validateScene, validateStage } from '@openmaic/dsl';
import type { Action } from '@openmaic/lib/types/action';
import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';
import type { Scene, Stage } from '@openmaic/lib/types/stage';

const MAX_EDITED_SCENES = 200;

export class InvalidClassroomEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidClassroomEditError';
  }
}

function firstValidationIssue(result: ReturnType<typeof validateScene>): string {
  return result.valid
    ? ''
    : result.errors?.[0]
      ? `${result.errors[0].path}: ${result.errors[0].message}`
      : 'unknown validation error';
}

/** A narration edit must never retain audio synthesized from the previous text. */
export function invalidateChangedSpeechAudio(previous: Scene, next: Scene): Scene {
  const previousById = new Map(
    (previous.actions ?? [])
      .filter((action): action is Extract<Action, { type: 'speech' }> => action.type === 'speech')
      .map((action) => [action.id, action]),
  );
  let changed = false;
  const actions = (next.actions ?? []).map((action) => {
    if (action.type !== 'speech') return action;
    const before = previousById.get(action.id);
    if (!before || before.text === action.text) return action;
    const cleaned = { ...action } as typeof action & { audioId?: string; audioUrl?: string };
    delete cleaned.audioId;
    delete cleaned.audioUrl;
    changed = true;
    return cleaned;
  });
  return changed ? { ...next, actions } as Scene : next;
}

/** Repoint generated media after a published classroom is forked into a draft. */
export function rewriteClassroomMediaReferences<T>(
  value: T,
  sourceClassroomId: string,
  targetClassroomId: string,
): T {
  if (sourceClassroomId === targetClassroomId) return value;
  if (typeof value === 'string') {
    return value.replaceAll(
      `/api/openmaic/classroom-media/${sourceClassroomId}/`,
      `/api/openmaic/classroom-media/${targetClassroomId}/`,
    ) as T;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteClassroomMediaReferences(
      entry,
      sourceClassroomId,
      targetClassroomId,
    )) as T;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      rewriteClassroomMediaReferences(entry, sourceClassroomId, targetClassroomId),
    ])) as T;
  }
  return value;
}

export function prepareClassroomEdit(input: {
  existing: PersistedClassroomData;
  stage: Stage;
  scenes: Scene[];
  targetClassroomId: string;
}): { stage: Stage; scenes: Scene[]; narrationChanged: boolean } {
  if (input.scenes.length === 0) {
    throw new InvalidClassroomEditError('课堂至少需要保留一个页面');
  }
  if (input.scenes.length > MAX_EDITED_SCENES) {
    throw new InvalidClassroomEditError(`课堂页面不能超过 ${MAX_EDITED_SCENES} 页`);
  }
  const sceneIds = new Set<string>();
  const previousById = new Map(input.existing.scenes.map((scene) => [scene.id, scene]));
  let narrationChanged = false;
  const now = Date.now();
  const stage = rewriteClassroomMediaReferences({
    ...input.stage,
    id: input.targetClassroomId,
    updatedAt: now,
  }, input.existing.id, input.targetClassroomId);
  const stageValidation = validateStage(stage);
  if (!stageValidation.valid) {
    throw new InvalidClassroomEditError(`课堂信息无效：${firstValidationIssue(stageValidation)}`);
  }

  const scenes = input.scenes.map((rawScene, index) => {
    if (sceneIds.has(rawScene.id)) {
      throw new InvalidClassroomEditError(`页面 ID 重复：${rawScene.id}`);
    }
    sceneIds.add(rawScene.id);
    const previous = previousById.get(rawScene.id);
    const withFreshNarration = previous
      ? invalidateChangedSpeechAudio(previous, rawScene)
      : rawScene;
    if (withFreshNarration !== rawScene) narrationChanged = true;
    const next = rewriteClassroomMediaReferences({
      ...withFreshNarration,
      stageId: input.targetClassroomId,
      order: index,
      updatedAt: now,
    }, input.existing.id, input.targetClassroomId) as Scene;
    const validation = validateScene(next);
    if (!validation.valid) {
      throw new InvalidClassroomEditError(
        `第 ${index + 1} 页“${next.title || '未命名'}”无效：${firstValidationIssue(validation)}`,
      );
    }
    return next;
  });

  return { stage, scenes, narrationChanged };
}
