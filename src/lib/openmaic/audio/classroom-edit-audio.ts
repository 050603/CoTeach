import type { Scene } from '@openmaic/lib/types/stage';
import { db } from '@openmaic/lib/utils/database';

export interface ClassroomAudioUpload {
  sceneId: string;
  actionId: string;
  audioId: string;
  text: string;
  format: string;
  base64: string;
}

/** Only upload clips synthesized for the exact submitted narration. A late
 * synthesis response must never attach old speech to a newly edited line. */
export async function collectClassroomAudioUploads(scenes: Scene[]): Promise<ClassroomAudioUpload[]> {
  const uploads: ClassroomAudioUpload[] = [];
  for (const scene of scenes) {
    for (const action of scene.actions ?? []) {
      if (action.type !== 'speech' || !action.id || !action.audioId || action.audioUrl) continue;
      const record = await db.audioFiles.get(action.audioId);
      if (!record || record.text?.trim() !== action.text.trim()) continue;
      const bytes = new Uint8Array(await record.blob.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      }
      uploads.push({
        sceneId: scene.id,
        actionId: action.id,
        audioId: action.audioId,
        text: action.text,
        format: record.format,
        base64: btoa(binary),
      });
    }
  }
  return uploads;
}
