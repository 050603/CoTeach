import type { Scene, Stage } from '@openmaic/lib/types/stage';

export interface ClassroomEditorDocument {
  stage: Stage;
  scenes: Scene[];
}

export function classroomFingerprint(stage: Stage | null, scenes: Scene[]): string {
  return JSON.stringify({ stage, scenes });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Keep edits made while a save was in flight, adopting server normalizations
 * only for values that still match the submitted snapshot. */
function reconcile(sent: unknown, live: unknown, saved: unknown): unknown {
  if (JSON.stringify(live) === JSON.stringify(sent)) return saved;
  if (Array.isArray(sent) && Array.isArray(live) && Array.isArray(saved)) {
    const hasId = (entry: unknown): entry is Record<string, unknown> & { id: string } =>
      isRecord(entry) && typeof entry.id === 'string';
    if (sent.every(hasId) && live.every(hasId) && saved.every(hasId)) {
      const sentById = new Map(sent.map((entry) => [entry.id, entry]));
      const savedById = new Map(saved.map((entry) => [entry.id, entry]));
      // Local insertion/deletion/reordering wins; matching records still absorb
      // server-side audio invalidation and other field-level normalization.
      return live.map((entry) => sentById.has(entry.id) && savedById.has(entry.id)
        ? reconcile(sentById.get(entry.id), entry, savedById.get(entry.id))
        : entry);
    }
    return live;
  }
  if (isRecord(sent) && isRecord(live) && isRecord(saved)) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(live), ...Object.keys(saved)])) {
      if (!(key in live) && key in sent) continue;
      const value = reconcile(sent[key], live[key], saved[key]);
      if (value !== undefined) result[key] = value;
    }
    if (live.type === 'speech' && (live.text !== sent.text
      || live.audioId !== sent.audioId || live.audioUrl !== sent.audioUrl)) {
      // Text and its synthesized clip form one value. Do not attach a URL
      // returned for the submitted text to a newer, locally edited sentence.
      for (const key of ['audioId', 'audioUrl', 'audioInvalidated']) {
        if (live[key] !== undefined) result[key] = live[key];
        else delete result[key];
      }
    }
    return result;
  }
  return live;
}

function rewriteMedia<T>(value: T, sourceId: string, targetId: string): T {
  if (sourceId === targetId) return value;
  if (typeof value === 'string') {
    return value.replaceAll(
      `/api/openmaic/classroom-media/${sourceId}/`,
      `/api/openmaic/classroom-media/${targetId}/`,
    ) as T;
  }
  if (Array.isArray(value)) return value.map((entry) => rewriteMedia(entry, sourceId, targetId)) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, rewriteMedia(entry, sourceId, targetId)])) as T;
  return value;
}

export function reconcileClassroomSave(
  sent: ClassroomEditorDocument,
  live: ClassroomEditorDocument,
  saved: ClassroomEditorDocument,
): ClassroomEditorDocument {
  const merged = rewriteMedia(
    reconcile(sent, live, saved) as ClassroomEditorDocument,
    sent.stage.id,
    saved.stage.id,
  );
  return {
    stage: { ...merged.stage, id: saved.stage.id },
    scenes: merged.scenes.map((scene, order) => ({ ...scene, stageId: saved.stage.id, order })),
  };
}
