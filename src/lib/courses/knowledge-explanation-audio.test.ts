// @vitest-environment node
import { mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  directory: '', query: vi.fn(), execute: vi.fn(), settings: vi.fn(), generate: vi.fn(),
  disabled: vi.fn(), apiKey: vi.fn(), model: vi.fn(), voice: vi.fn(),
}));
vi.mock('@/lib/db/client', () => ({ prisma: { $queryRaw: mocks.query, $executeRaw: mocks.execute } }));
vi.mock('@/lib/knowledge-lecture-settings', () => ({ getKnowledgeLectureTutorSettings: mocks.settings }));
vi.mock('@/lib/observability/classroom-ai', () => ({ recordAiCacheEvent: vi.fn() }));
vi.mock('@openmaic/lib/server/classroom-storage', async (original) => ({
  ...await original<typeof import('@openmaic/lib/server/classroom-storage')>(),
  get CLASSROOMS_DIR() { return mocks.directory; },
}));
vi.mock('@openmaic/lib/server/provider-config', () => ({
  getServerTTSProviders: () => ({ 'openai-tts': {} }),
  isServerTTSProviderDisabled: mocks.disabled,
  resolveTTSApiKey: mocks.apiKey, resolveTTSBaseUrl: () => 'https://tts.example.test/v1',
  resolveTTSModel: mocks.model, resolveTTSVoice: mocks.voice, getTtsConcurrencyLimit: () => 1,
}));
vi.mock('@openmaic/lib/audio/tts-providers', () => ({ generateTTS: mocks.generate }));
import { prepareExplanationAudio, readableExplanationAudio } from './knowledge-explanation-audio';

type Audio = {
  filename: string; audioUrl: string; audioDurationSec: number; bytes: number; fingerprint: string;
};
type Row = {
  id: string; status: string; raw: string; audio: Audio | null;
  audioToken: string | null; audioLeaseUntil: Date | null; audioError: string | null;
};
const input = { id: 'prepared-question', classroomId: 'test-classroom', text: '逐项比较证据与结论。' };
const committedText = '{"introduction":"已完成的统一讲解"}';
let directory: string;
let row: Row;

function wav(seconds = 2): Uint8Array {
  const sampleRate = 8_000;
  const dataSize = sampleRate * seconds;
  const audio = new Uint8Array(44 + dataSize);
  const view = new DataView(audio.buffer);
  const ascii = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) view.setUint8(offset + index, value.charCodeAt(index));
  };
  ascii(0, 'RIFF'); view.setUint32(4, audio.length - 8, true); ascii(8, 'WAVE'); ascii(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  ascii(36, 'data'); view.setUint32(40, dataSize, true); audio.fill(128, 44);
  return audio;
}
const audioPath = () => path.join(mocks.directory, input.classroomId, 'audio', row.audio!.filename);
const prepare = () => prepareExplanationAudio({ ...input, audio: row.audio }, AbortSignal.timeout(5_000));

beforeEach(async () => {
  vi.resetAllMocks();
  directory = await mkdtemp(path.join(tmpdir(), 'coteach-explanation-audio-'));
  mocks.directory = path.join(directory, 'classrooms');
  vi.stubEnv('TTS_CACHE_DIR', path.join(directory, 'tts-cache'));
  row = { id: input.id, status: 'COMPLETED', raw: committedText, audio: null, audioToken: null, audioLeaseUntil: null, audioError: null };
  mocks.settings.mockResolvedValue({ ttsProviderId: 'openai-tts', ttsModelId: 'test-model', ttsVoice: 'alloy', ttsSpeed: 1 });
  mocks.disabled.mockReturnValue(false); mocks.apiKey.mockReturnValue('test-secret');
  mocks.model.mockReturnValue('test-model'); mocks.voice.mockReturnValue('alloy');
  mocks.generate.mockResolvedValue({ audio: wav(), format: 'wav' });
  mocks.query.mockImplementation(async (_sql: TemplateStringsArray, id: unknown) => id === row.id ? [{ ...row }] : []);
  mocks.execute.mockImplementation(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (sql.includes('SET "audioToken" = ?')) {
      const [token, lease, id] = values;
      if (id !== row.id || row.status !== 'COMPLETED'
        || (row.audioToken && (!row.audioLeaseUntil || row.audioLeaseUntil.getTime() >= Date.now()))) return 0;
      row.audioToken = token as string; row.audioLeaseUntil = lease as Date; row.audioError = null;
      return 1;
    }
    const id = values.at(-2); const token = values.at(-1);
    if (id !== row.id || row.audioToken !== token) return 0;
    if (sql.includes('SET audio =')) row.audio = JSON.parse(values[0] as string) as Audio;
    else if (sql.includes('SET "audioError" =')) { row.audioError = values[0] as string; return 1; }
    else if (!sql.includes('SET "audioToken" = NULL')) throw new Error(`Unexpected audio mutation: ${sql}`);
    row.audioToken = null; row.audioLeaseUntil = null;
    return 1;
  });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('durable shared explanation audio', () => {
  it('persists playable audio and serves it without resolving model or provider settings', async () => {
    const result = await prepare();
    expect(result).toEqual({ audioUrl: `/api/openmaic/classroom-media/${input.classroomId}/audio/${row.audio!.filename}`, audioDurationSec: 2 });
    expect(row.audio).toMatchObject({ bytes: wav().length, audioDurationSec: 2, filename: expect.stringMatching(/^explanation-[a-f0-9]{64}\.wav$/) });
    expect(await readFile(audioPath())).toEqual(Buffer.from(wav()));
    expect(await readdir(path.dirname(audioPath()))).toEqual([row.audio!.filename]);
    expect(row).toMatchObject({ status: 'COMPLETED', raw: committedText, audioToken: null, audioLeaseUntil: null });

    vi.clearAllMocks();
    mocks.settings.mockRejectedValue(new Error('configuration is unavailable'));
    const saved = { ...row.audio!, audioUrl: 'https://untrusted.example.test/old-audio.wav' };
    const output = await Promise.all(Array.from({ length: 30 }, () => readableExplanationAudio(input.classroomId, saved)));
    expect(output.every(item => item.audioUrl === result.audioUrl && item.audioDurationSec === 2)).toBe(true);
    expect(mocks.settings).not.toHaveBeenCalled(); expect(mocks.apiKey).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('coalesces 30 concurrent preparations and reuses the committed result on replay', async () => {
    const output = await Promise.all(Array.from({ length: 30 }, () => prepare()));
    expect(output.every(item => item.audioUrl === output[0].audioUrl && item.audioDurationSec === 2)).toBe(true);
    expect(await prepare()).toEqual(output[0]);
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(await readdir(path.dirname(audioPath()))).toEqual([row.audio!.filename]);
    expect(row.audioToken).toBeNull();
  });

  it.each(['missing', 'truncated', 'same-size corruption'] as const)('repairs a %s classroom file using the persisted speech result', async (damage) => {
    const original = await prepare();
    const filename = audioPath();
    if (damage === 'missing') await unlink(filename);
    else if (damage === 'truncated') await writeFile(filename, wav().slice(0, 48));
    else await writeFile(filename, new Uint8Array(wav().length));
    if (damage !== 'same-size corruption') expect(await readableExplanationAudio(input.classroomId, row.audio)).toEqual({});
    expect(await prepare()).toEqual(original);
    expect(await readFile(filename)).toEqual(Buffer.from(wav()));
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ status: 'COMPLETED', raw: committedText, audioError: null, audioToken: null, audioLeaseUntil: null });
  });

  it('releases a failed audio lease, keeps committed text, redacts diagnostics and can retry', async () => {
    mocks.generate.mockRejectedValueOnce(new Error('test-secret unavailable at https://tts.example.test/v1/key'));
    await expect(prepare()).rejects.toThrow('unavailable');
    expect(row).toMatchObject({ status: 'COMPLETED', raw: committedText, audio: null, audioToken: null, audioLeaseUntil: null });
    expect(row.audioError).toContain('EXPLANATION_AUDIO_FAILED');
    expect(row.audioError).not.toContain('test-secret'); expect(row.audioError).not.toContain('https://');
    for (const [strings] of mocks.execute.mock.calls) {
      const setClause = (strings as TemplateStringsArray).join('?').split('WHERE')[0];
      expect(setClause).not.toMatch(/\b(?:status|raw)\s*=/);
    }
    expect(await prepare()).toMatchObject({ audioDurationSec: 2 });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(row.audioError).toBeNull();
  });

  it('recovers an expired audio lease without changing text ownership', async () => {
    row.audioToken = 'terminated-worker'; row.audioLeaseUntil = new Date(0);
    expect(await prepare()).toMatchObject({ audioDurationSec: 2 });
    expect(mocks.generate).toHaveBeenCalledOnce();
    expect(row).toMatchObject({ status: 'COMPLETED', raw: committedText, audioToken: null, audioLeaseUntil: null });
  });

  it('does not synthesize or acquire a database lease for browser speech', async () => {
    mocks.settings.mockResolvedValue({ ttsProviderId: 'browser-native-tts' });
    expect(await prepare()).toEqual({});
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.apiKey).not.toHaveBeenCalled();
    expect(mocks.model).not.toHaveBeenCalled(); expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('rejects a force-disabled provider before resolving credentials or synthesizing', async () => {
    mocks.disabled.mockReturnValue(true);
    await expect(prepare()).rejects.toThrow('EXPLANATION_TTS_PROVIDER_DISABLED');
    expect(mocks.generate).not.toHaveBeenCalled(); expect(mocks.apiKey).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled(); expect(mocks.execute).not.toHaveBeenCalled();
  });

  it('does not expose an invalid classroom, traversal filename or invalid duration', async () => {
    await prepare();
    expect(await readableExplanationAudio('../other-classroom', row.audio)).toEqual({});
    expect(await readableExplanationAudio(input.classroomId, { ...row.audio!, filename: `../${row.audio!.filename}` })).toEqual({});
    expect(await readableExplanationAudio(input.classroomId, { ...row.audio!, audioDurationSec: 0 })).toEqual({});
    expect(await readableExplanationAudio(input.classroomId, { ...row.audio!, bytes: row.audio!.bytes + 1 })).toEqual({});
  });
});
