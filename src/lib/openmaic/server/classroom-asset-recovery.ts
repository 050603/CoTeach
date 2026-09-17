import { access } from 'node:fs/promises';
import path from 'node:path';
import type { SpeechAction } from '@openmaic/lib/types/action';
import type { Scene } from '@openmaic/lib/types/stage';
import type { PersistedClassroomData } from '@openmaic/lib/server/classroom-storage';

const CLASSROOM_MEDIA_PREFIX = '/api/openmaic/classroom-media/';
const SAFE_PATH_PART = /^[a-zA-Z0-9_.-]+$/;

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

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
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
        || Boolean(localPath && !await exists(localPath));
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
