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

function parseByteRange(header: string, totalSize: number): { start: number; end: number } | null {
  if (totalSize === 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, totalSize - suffix), end: totalSize - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : totalSize - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start >= totalSize || end < start) return null;
  return { start, end: Math.min(end, totalSize - 1) };
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
    // Byte positions refer to the playable representation. WAV normalization
    // can replace its header and unwrap an extra container, changing its size.
    const rangeHeader = _request.headers.get('range');
    const range = rangeHeader === null ? null : parseByteRange(rangeHeader, bytes.byteLength);
    const headers = {
      // Authorization is evaluated for every request. Do not let a shared
      // cache replay a student's classroom media to another account after
      // a membership is removed or the activity is locked.
      'Cache-Control': 'private, no-store',
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
    };
    if (rangeHeader !== null && !range) {
      return new Response(null, {
        status: 416,
        headers: { ...headers, 'Content-Range': `bytes */${bytes.byteLength}`, 'Content-Length': '0' },
      });
    }
    const body = range ? bytes.subarray(range.start, range.end + 1) : bytes;

    return new Response(toArrayBuffer(body), {
      status: range ? 206 : 200,
      headers: {
        ...headers,
        'Content-Length': String(body.byteLength),
        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${bytes.byteLength}` } : {}),
      },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new Response('Classroom media not found', { status: 404 });
    }
    return new Response('Failed to read classroom media', { status: 500 });
  }
}
