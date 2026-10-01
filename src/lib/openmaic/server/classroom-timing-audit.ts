import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Scene } from "@openmaic/lib/types/stage";
import { audioDurationSec } from "@openmaic/lib/audio/audio-duration";
import { CLASSROOMS_DIR, isValidClassroomId } from "@openmaic/lib/server/classroom-storage";
import { classroomAudioStoragePath } from "./classroom-asset-recovery";

const AUDIO_FILENAME = /^[a-zA-Z0-9_.:-]+\.(?:wav|mp3|ogg|opus|aac|m4a|flac|webm)$/i;

/** Recheck saved audio files so a teacher edit cannot publish a stale duration. */
export async function remeasureClassroomSpeech(
  classroomId: string,
  scenes: Scene[],
  readAudio: (filename: string) => Promise<Uint8Array> = readFile,
): Promise<Scene[]> {
  if (!isValidClassroomId(classroomId)) throw new Error("课堂资源 ID 无效");
  const measured = new Map<string, Promise<{ exists: boolean; seconds?: number }>>();

  function audioPathFor(audioUrl?: string): string | undefined {
    if (!audioUrl) return undefined;
    let pathname: string;
    try { pathname = new URL(audioUrl, "http://localhost").pathname; }
    catch { return undefined; }
    const audioPath = classroomAudioStoragePath(CLASSROOMS_DIR, pathname);
    return audioPath && AUDIO_FILENAME.test(path.basename(audioPath)) ? audioPath : undefined;
  }

  async function durationFor(audioPath: string): Promise<{ exists: boolean; seconds?: number }> {
    const existing = measured.get(audioPath);
    if (existing) return existing;
    const measurement = readAudio(audioPath)
      .then((bytes) => ({ exists: true, seconds: audioDurationSec(bytes, path.extname(audioPath).slice(1)) }))
      .catch(() => ({ exists: false }));
    measured.set(audioPath, measurement);
    return measurement;
  }

  const result: Scene[] = [];
  for (const scene of scenes) {
    const actions = await Promise.all((scene.actions ?? []).map(async (action) => {
      if (action.type !== "speech" || !action.text.trim()) return action;
      if (action.audioInvalidated) return { ...action, audioDurationSec: undefined };
      const audioPath = audioPathFor(action.audioUrl);
      if (!audioPath) return { ...action, audioDurationSec: undefined };
      const measurement = await durationFor(audioPath);
      const extension = path.extname(audioPath).slice(1).toLowerCase();
      // The existing duration was recorded from bytes when an uploaded format
      // cannot be decoded by the local WAV/MP3 duration reader.
      const fallbackSec = extension !== "wav" && extension !== "mp3"
        && measurement.exists
        && typeof action.audioDurationSec === "number" && Number.isFinite(action.audioDurationSec)
        && action.audioDurationSec > 0
        ? action.audioDurationSec : undefined;
      return { ...action, audioDurationSec: measurement.seconds ?? fallbackSec };
    }));
    result.push({ ...scene, actions });
  }
  return result;
}
