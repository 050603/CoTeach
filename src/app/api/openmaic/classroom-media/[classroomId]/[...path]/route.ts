import { promises as fs } from 'fs';
import path from 'path';
import { type NextRequest } from 'next/server';
import { CLASSROOMS_DIR, isValidClassroomId } from '@openmaic/lib/server/classroom-storage';
import { authorizeLegacyClassroomRead } from '@/lib/platform/access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.png': 'image/png',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
  '.webp': 'image/webp',
};

function bytesToAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset < 0 || offset + length > bytes.byteLength) return '';
  let value = '';
  for (let i = 0; i < length; i++) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

function normalizePlayableWav(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 44) return bytes;
  if (bytesToAscii(bytes, 0, 4) !== 'RIFF' || bytesToAscii(bytes, 8, 4) !== 'WAVE') {
    return bytes;
  }

  const normalized = new Uint8Array(bytes);
  const view = new DataView(normalized.buffer, normalized.byteOffset, normalized.byteLength);
  view.setUint32(4, normalized.byteLength - 8, true);

  let offset = 12;
  while (offset + 8 <= normalized.byteLength) {
    const chunkId = bytesToAscii(normalized, offset, 4);
    const chunkSizeOffset = offset + 4;
    const chunkDataOffset = offset + 8;
    const chunkSize = view.getUint32(chunkSizeOffset, true);

    if (chunkId === 'data') {
      view.setUint32(chunkSizeOffset, normalized.byteLength - chunkDataOffset, true);
      break;
    }

    const nextOffset = chunkDataOffset + chunkSize + (chunkSize % 2);
    if (nextOffset <= offset || nextOffset > normalized.byteLength) break;
    offset = nextOffset;
  }

  return normalized;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathParts } = await context.params;
  const authorization = await authorizeLegacyClassroomRead(_request, classroomId);
  if (authorization) return authorization;
  if (!isValidClassroomId(classroomId) || !Array.isArray(pathParts) || pathParts.length === 0) {
    return new Response('Invalid classroom media path', { status: 400 });
  }

  const classroomDir = path.resolve(CLASSROOMS_DIR, classroomId);
  const filePath = path.resolve(classroomDir, ...pathParts);
  if (filePath !== classroomDir && !filePath.startsWith(`${classroomDir}${path.sep}`)) {
    return new Response('Invalid classroom media path', { status: 400 });
  }

  try {
    const raw = await fs.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const bytes = ext === '.wav' ? normalizePlayableWav(raw) : raw;

    return new Response(toArrayBuffer(bytes), {
      headers: {
        // Authorization is evaluated for every request. Do not let a shared
        // cache replay a student's classroom media to another account after
        // a membership is removed or the activity is locked.
        'Cache-Control': 'private, no-store',
        'Content-Length': String(bytes.byteLength),
        'Content-Type': contentType,
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response('Classroom media not found', { status: 404 });
    }
    return new Response('Failed to read classroom media', { status: 500 });
  }
}
