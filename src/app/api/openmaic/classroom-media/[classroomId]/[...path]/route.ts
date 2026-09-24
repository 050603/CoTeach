import { promises as fs } from 'fs';
import path from 'path';
import { type NextRequest } from 'next/server';
import { CLASSROOMS_DIR, isValidClassroomId } from '@openmaic/lib/server/classroom-storage';
import { normalizePlayableWav } from '@openmaic/lib/audio/wav-container';
import { authorizeClassroomMediaRead } from '@/lib/platform/classroom-media-access';

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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ classroomId: string; path: string[] }> },
) {
  const { classroomId, path: pathParts } = await context.params;
  if (!isValidClassroomId(classroomId) || !Array.isArray(pathParts) || pathParts.length === 0) {
    return new Response('Invalid classroom media path', { status: 400 });
  }

  const authorization = await authorizeClassroomMediaRead(_request, classroomId, pathParts);
  if (authorization) return authorization;

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
