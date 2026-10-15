import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { normalizePlayableWav } from '@openmaic/lib/audio/wav-container';

const mocks = vi.hoisted(() => ({ readFile: vi.fn(), authorize: vi.fn() }));
vi.mock('fs', () => {
  const fsModule = { promises: { readFile: mocks.readFile } };
  return { ...fsModule, default: fsModule };
});
vi.mock('@openmaic/lib/server/classroom-storage', () => ({
  CLASSROOMS_DIR: '/classroom-media-test',
  isValidClassroomId: (value: string) => /^[a-zA-Z0-9_-]+$/.test(value),
}));
vi.mock('@/lib/platform/classroom-media-access', () => ({ authorizeClassroomMediaRead: mocks.authorize }));

import { GET } from './route';

const context = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.mp3'] }) };
function request(range?: string) {
  return new Request('http://localhost/api/openmaic/classroom-media/classroom/audio/voice.mp3', {
    headers: range === undefined ? {} : { Range: range },
  }) as NextRequest;
}

function wav(payload: Uint8Array, sentinelSizes = false): Uint8Array {
  const bytes = new Uint8Array(44 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  for (const [offset, value] of [[0, 'RIFF'], [8, 'WAVE'], [12, 'fmt '], [36, 'data']] as const) {
    bytes.set(new TextEncoder().encode(value), offset);
  }
  view.setUint32(4, sentinelSizes ? 0x7fffffff : bytes.byteLength - 8, true);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 24000, true);
  view.setUint32(28, 48000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  view.setUint32(40, sentinelSizes ? 0x7fffffff : payload.byteLength, true);
  bytes.set(payload, 44);
  return bytes;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(null);
  mocks.readFile.mockResolvedValue(Buffer.from('0123456789'));
});

describe('classroom media byte ranges', () => {
  it('keeps full responses private and announces seekable byte-range support', async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('0123456789');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-range')).toBeNull();
  });

  it.each([
    ['bytes=2-5', '2345', 'bytes 2-5/10'],
    ['bytes=7-', '789', 'bytes 7-9/10'],
    ['bytes=-4', '6789', 'bytes 6-9/10'],
    ['bytes=8-99', '89', 'bytes 8-9/10'],
    ['bytes=-20', '0123456789', 'bytes 0-9/10'],
    ['BYTES=0-1', '01', 'bytes 0-1/10'],
  ])('serves a requested single range %s', async (range, body, contentRange) => {
    const response = await GET(request(range), context);
    expect(response.status).toBe(206);
    expect(await response.text()).toBe(body);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('content-length')).toBe(String(body.length));
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.authorize).toHaveBeenCalledOnce();
  });

  it.each(['bytes=-', 'bytes=10-', 'bytes=8-7', 'bytes=-0', 'bytes=0-1,3-4', 'items=0-1', 'bytes=NaN-4', 'bytes=9007199254740992-', ''])('rejects invalid or unsatisfiable range %s', async (range) => {
    const response = await GET(request(range), context);
    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.text()).toBe('');
  });

  it('ranges the normalized WAV representation rather than raw nested file bytes', async () => {
    const samples = Uint8Array.from([1, 0, 2, 0, 3, 0, 4, 0]);
    const source = wav(wav(samples, true));
    const normalized = normalizePlayableWav(source);
    mocks.readFile.mockResolvedValue(Buffer.from(source));
    const wavContext = { params: Promise.resolve({ classroomId: 'classroom', path: ['audio', 'voice.wav'] }) };
    const full = await GET(request(), wavContext);
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(normalized);
    expect(full.headers.get('content-length')).toBe('52');
    expect(full.headers.get('content-type')).toBe('audio/wav');
    for (const [range, start, end] of [['bytes=0-43', 0, 43], ['bytes=44-', 44, 51], ['bytes=-8', 44, 51]] as const) {
      const response = await GET(request(range), wavContext);
      expect(response.status).toBe(206);
      expect(response.headers.get('content-range')).toBe(`bytes ${start}-${end}/52`);
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(normalized.slice(start, end + 1));
    }
    // This interval exists in the stored wrapper, but not in the playable WAV.
    const unsatisfiable = await GET(request('bytes=60-70'), wavContext);
    expect(unsatisfiable.status).toBe(416);
    expect(unsatisfiable.headers.get('content-range')).toBe('bytes */52');
    expect(new DataView(source.buffer).getUint32(4, true)).toBe(source.byteLength - 8);
  });

  it.each([401, 403])('authorizes range requests before reading bytes or exposing their size (%s)', async (status) => {
    const denied = new Response('Denied', { status });
    mocks.authorize.mockResolvedValue(denied);
    const response = await GET(request('bytes=0-1'), context);
    expect(response).toBe(denied);
    expect(response.headers.get('content-range')).toBeNull();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('rejects paths outside the classroom directory before reading', async () => {
    const response = await GET(request('bytes=0-1'), {
      params: Promise.resolve({ classroomId: 'classroom', path: ['..', 'outside.mp3'] }),
    });
    expect(response.status).toBe(400);
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('keeps empty files valid for a full read and rejects their byte ranges', async () => {
    mocks.readFile.mockResolvedValue(Buffer.alloc(0));
    expect((await GET(request(), context)).status).toBe(200);
    for (const range of ['bytes=0-', 'bytes=-1']) {
      const response = await GET(request(range), context);
      expect(response.status).toBe(416);
      expect(response.headers.get('content-range')).toBe('bytes */0');
    }
  });

  it('retains missing-file errors even when a range is requested', async () => {
    mocks.readFile.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect((await GET(request('bytes=0-1'), context)).status).toBe(404);
  });
});
