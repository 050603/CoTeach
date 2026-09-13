import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { ClassroomAudioUpload } from '@openmaic/lib/audio/classroom-edit-audio';
import type { Scene } from '@openmaic/lib/types/stage';
import { InvalidClassroomEditError } from './classroom-edit';
import { CLASSROOMS_DIR, isValidClassroomId } from './classroom-storage';

const AUDIO_FORMATS = new Set(['mp3', 'wav', 'ogg', 'opus', 'aac', 'm4a', 'flac', 'webm']);
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;

export interface PreparedClassroomAudio {
  scenes: Scene[];
  files: Array<{ filename: string; bytes: Buffer }>;
}

/** Match uploaded clips to validated narration before touching disk. Filenames
 * are immutable so a later synthesis cannot replace a published clip. */
export function prepareClassroomAudioUploads(input: {
  uploads: unknown;
  submittedScenes: Scene[];
  scenes: Scene[];
  classroomId: string;
}): PreparedClassroomAudio {
  if (input.uploads !== undefined && !Array.isArray(input.uploads)) {
    throw new InvalidClassroomEditError('课堂语音内容无效');
  }
  const uploads = input.uploads ?? [];
  const byAction = new Map<string, { audioId: string; audioUrl: string }>();
  const files: PreparedClassroomAudio['files'] = [];
  for (const raw of uploads) {
    if (!raw || typeof raw !== 'object') throw new InvalidClassroomEditError('课堂语音内容无效');
    const upload = raw as ClassroomAudioUpload;
    const scene = input.submittedScenes.find((entry) => entry.id === upload.sceneId);
    const action = scene?.actions?.find((entry) => entry.id === upload.actionId);
    const format = typeof upload.format === 'string' ? upload.format.toLowerCase() : '';
    if (!action || action.type !== 'speech' || action.audioId !== upload.audioId
      || action.text !== upload.text || !AUDIO_FORMATS.has(format)
      || typeof upload.base64 !== 'string' || !upload.base64
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(upload.base64)) {
      throw new InvalidClassroomEditError('语音与当前讲稿不匹配，请重新生成后保存');
    }
    const key = JSON.stringify([upload.sceneId, upload.actionId]);
    if (byAction.has(key)) throw new InvalidClassroomEditError('同一讲稿包含重复语音');
    const bytes = Buffer.from(upload.base64, 'base64');
    if (!bytes.length || bytes.length > MAX_AUDIO_BYTES) {
      throw new InvalidClassroomEditError('单段语音大小无效或超过 8 MB');
    }
    const digest = createHash('sha256').update(upload.text).update(bytes).digest('hex');
    const filename = `edit-${digest}.${format}`;
    byAction.set(key, {
      audioId: `edit-${digest}`,
      audioUrl: `/api/openmaic/classroom-media/${input.classroomId}/audio/${filename}`,
    });
    files.push({ filename, bytes });
  }
  const scenes = input.scenes.map((scene) => ({
    ...scene,
    actions: (scene.actions ?? []).map((action) => {
      if (action.type !== 'speech') return action;
      const uploaded = byAction.get(JSON.stringify([scene.id, action.id]));
      if (uploaded) {
        const next = { ...action, ...uploaded };
        delete next.audioInvalidated;
        return next;
      }
      // An IndexedDB id alone is not a resource another browser can play.
      if (action.audioId && !action.audioUrl) {
        const next = { ...action };
        delete next.audioId;
        next.audioInvalidated = true;
        return next;
      }
      return action;
    }),
  })) as Scene[];
  return { scenes, files };
}

export async function persistClassroomAudioUploads(
  classroomId: string,
  files: PreparedClassroomAudio['files'],
): Promise<void> {
  if (!files.length) return;
  if (!isValidClassroomId(classroomId)) throw new InvalidClassroomEditError('课堂 ID 无效');
  const directory = path.join(CLASSROOMS_DIR, classroomId, 'audio');
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(files.map(async ({ filename, bytes }) => {
    try {
      await fs.writeFile(path.join(directory, filename), bytes, { flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }));
}
