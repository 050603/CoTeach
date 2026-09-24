import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechAction } from '@openmaic/lib/types/action';
import { makeScene, type Scene } from '@openmaic/lib/types/stage';
import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';
import { isMediaPlaceholder } from '@openmaic/lib/store/media-generation';
import { audioDurationSec } from '@openmaic/lib/audio/audio-duration';

const CLASSROOM_MEDIA_PREFIX = '/api/openmaic/classroom-media/';
// Keep legacy `:` filenames readable for recovery. New generated clips use
// content hashes and therefore stay within `[a-zA-Z0-9_.-]`.
const SAFE_PATH_PART = /^[a-zA-Z0-9_.:-]+$/;

export type ClassroomTtsRecoveryPlan = {
  classroom: PersistedClassroomData;
  missingActionIds: string[];
  unrecoverableActionIds: string[];
};

/**
 * Resolve only same-origin classroom audio URLs. External/user-supplied audio
 * remains opaque and is never treated as a disposable generated asset.
 */
export function classroomAudioStoragePath(
  rootDir: string,
  audioUrl: string,
): string | null {
  const pathname = audioUrl.split(/[?#]/, 1)[0];
  if (!pathname.startsWith(CLASSROOM_MEDIA_PREFIX)) return null;
  const encodedParts = pathname.slice(CLASSROOM_MEDIA_PREFIX.length).split('/');
  let parts: string[];
  try {
    parts = encodedParts.map((part) => decodeURIComponent(part));
  } catch {
    return null;
  }
  if (parts.length !== 3 || parts[1] !== 'audio'
    || parts.some((part) => part === '.' || part === '..' || !SAFE_PATH_PART.test(part))) {
    return null;
  }
  return path.join(rootDir, ...parts);
}

async function isReadableAudio(filePath: string): Promise<boolean> {
  try {
    const bytes = await readFile(filePath);
    if (!bytes.length) return false;
    const format = path.extname(filePath).slice(1).toLowerCase();
    return format === 'wav' || format === 'mp3'
      ? Boolean(audioDurationSec(bytes, format))
      : true;
  } catch {
    return false;
  }
}

/**
 * Produce a copy safe for TTS rehydration. Only missing generated audio refs
 * are cleared, allowing the normal generator to resume a partial restore
 * without paying for clips that are already present.
 */
export async function planClassroomTtsRecovery(
  classroom: PersistedClassroomData,
  rootDir: string,
): Promise<ClassroomTtsRecoveryPlan> {
  const copy = structuredClone(classroom);
  const missingActionIds: string[] = [];
  const unrecoverableActionIds: string[] = [];

  for (const scene of copy.scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech') continue;
      const speech = action as SpeechAction;
      const localPath = speech.audioUrl
        ? classroomAudioStoragePath(rootDir, speech.audioUrl)
        : null;
      const audioMissing = speech.audioInvalidated
        || (!speech.audioUrl && !speech.audioId)
        || Boolean(localPath && !await isReadableAudio(localPath));
      if (!audioMissing) continue;

      if (!speech.text.trim()) {
        if (localPath) unrecoverableActionIds.push(speech.id);
        continue;
      }
      delete speech.audioId;
      delete speech.audioUrl;
      delete speech.audioDurationSec;
      delete speech.audioInvalidated;
      missingActionIds.push(speech.id);
    }
  }

  return { classroom: copy, missingActionIds, unrecoverableActionIds };
}

export function classroomTtsTimingOptions(scenes: Scene[]): {
  providerId?: string;
  modelId?: string;
  voiceId?: string;
  speed?: number;
  language?: string;
} {
  for (const scene of scenes) {
    const timing = scene.timingPlan as Record<string, unknown> | undefined;
    if (!timing) continue;
    return {
      ...(typeof timing.providerId === 'string' ? { providerId: timing.providerId } : {}),
      ...(typeof timing.modelId === 'string' ? { modelId: timing.modelId } : {}),
      ...(typeof timing.voiceId === 'string' ? { voiceId: timing.voiceId } : {}),
      ...(typeof timing.speed === 'number' ? { speed: timing.speed } : {}),
      ...(typeof timing.language === 'string' ? { language: timing.language } : {}),
    };
  }
  return {};
}

/** Reattach assets for the same stable page and matching speech/media identities. */
export function reusePersistedSceneAssets(restored: Scene, previous?: Scene): Scene {
  if (!previous || previous.id !== restored.id) return restored;
  const priorActions = new Map((previous.actions ?? []).map((action) => [action.id, action]));
  const actions = restored.actions?.map((action) => {
    const prior = priorActions.get(action.id);
    if (action.type !== 'speech' || prior?.type !== 'speech') return action;
    if (prior.audioInvalidated) {
      const invalidated = { ...action, audioInvalidated: true };
      delete invalidated.audioId;
      delete invalidated.audioUrl;
      delete invalidated.audioDurationSec;
      delete invalidated.speechAlignment;
      return invalidated;
    }
    if (action.text !== prior.text || !prior.audioUrl) return action;
    return { ...action, audioId: prior.audioId, audioUrl: prior.audioUrl,
      audioDurationSec: prior.audioDurationSec, speechAlignment: prior.speechAlignment };
  });
  if (restored.content.type !== 'slide' || previous.content.type !== 'slide') return { ...restored, actions };
  const resourceKey = (element: { id: string; src?: string; resourceId?: unknown; mediaRef?: unknown }) =>
    typeof element.resourceId === 'string' ? element.resourceId
      : typeof element.mediaRef === 'string' ? element.mediaRef
        : element.src && isMediaPlaceholder(element.src) ? element.src
          : isMediaPlaceholder(element.id) ? element.id : null;
  const priorElements = new Map(previous.content.canvas.elements.map((element) => [element.id, element]));
  const elements = restored.content.canvas.elements.map((element) => {
    const prior = priorElements.get(element.id);
    if ((element.type !== 'image' && element.type !== 'video') || prior?.type !== element.type
      || !element.src || !isMediaPlaceholder(element.src) || !prior.src || isMediaPlaceholder(prior.src)) return element;
    // A group can keep its element ID while switching from one planned image
    // to another. Ambiguous legacy slots must not substitute the wrong image.
    if (!resourceKey(element) || resourceKey(element) !== resourceKey(prior)) return element;
    return { ...element, src: prior.src };
  });
  return makeScene({ ...restored, actions }, {
    ...restored.content,
    canvas: {
      ...restored.content.canvas,
      // The page keeps its identity when a test lesson is extended. A fresh
      // generation stage must not rename the accepted canvas under that page.
      id: previous.content.canvas.id ?? restored.content.canvas.id,
      elements,
    },
  });
}
