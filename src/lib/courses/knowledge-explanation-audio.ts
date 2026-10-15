import { createHash, randomUUID } from 'node:crypto';
import { mkdir, stat, rename, writeFile, unlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { prisma } from '@/lib/db/client';
import { getKnowledgeLectureTutorSettings } from '@/lib/knowledge-lecture-settings';
import { CLASSROOMS_DIR, isValidClassroomId } from '@openmaic/lib/server/classroom-storage';
import { prepareGeneratedClassroomAudio, mediaServingUrl } from '@openmaic/lib/server/classroom-media-generation';
import { getServerTTSProviders, getTtsConcurrencyLimit, isServerTTSProviderDisabled, resolveTTSApiKey, resolveTTSBaseUrl, resolveTTSModel, resolveTTSVoice } from '@openmaic/lib/server/provider-config';
import { DEFAULT_TTS_VOICES } from '@openmaic/lib/audio/constants';
import { qwenAudioTtsModelForVoice } from '@openmaic/lib/audio/qwen-audio-tts-catalog';
import { generateTTS } from '@openmaic/lib/audio/tts-providers';
import type { TTSModelConfig, TTSProviderId } from '@openmaic/lib/audio/types';
import { runWithGlobalTtsProviderSlot } from '@openmaic/lib/server/tts-provider-limiter';
import { cachedTtsResult } from '@openmaic/lib/server/tts-result-cache';
import { TUTOR_LEASE_MS } from './knowledge-tutor-payload';

type StoredAudio = { filename: string; audioUrl: string; audioDurationSec: number; bytes: number; fingerprint: string };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const runFile = promisify(execFile);
function storedAudio(value: unknown): StoredAudio | undefined {
  if (!value || typeof value !== 'object') return;
  const audio = value as StoredAudio;
  if (!/^explanation-[a-f0-9]{64}\.(?:wav|mp3|aac|flac|m4a|ogg|opus|webm)$/.test(audio.filename ?? '')
    || !Number.isFinite(audio.audioDurationSec) || audio.audioDurationSec <= 0 || !Number.isSafeInteger(audio.bytes) || audio.bytes <= 0) return;
  return audio;
}
export async function readableExplanationAudio(classroomId: string, value: unknown, verifyContent = false): Promise<{ audioUrl?: string; audioDurationSec?: number }> {
  const audio = storedAudio(value);
  if (!audio || !isValidClassroomId(classroomId)) return {};
  const filename = path.join(CLASSROOMS_DIR, classroomId, 'audio', audio.filename);
  const info = await stat(filename).catch(() => null);
  if (!info?.isFile() || info.size !== audio.bytes) return {};
  if (verifyContent) {
    const content = await readFile(filename).catch(() => null);
    if (!content || !audio.filename.startsWith(`explanation-${createHash('sha256').update(content).digest('hex')}.`)) return {};
  }
  return { audioUrl: mediaServingUrl('', classroomId, `audio/${audio.filename}`), audioDurationSec: audio.audioDurationSec };
}
export async function resolveExplanationTtsConfig(): Promise<TTSModelConfig | null> {
  const settings = await getKnowledgeLectureTutorSettings();
  if (settings.ttsProviderId === 'browser-native-tts') return null;
  const providerId = (settings.ttsProviderId || Object.entries(getServerTTSProviders()).find(([id, info]) => id !== 'browser-native-tts' && !info.disabled)?.[0]) as TTSProviderId | undefined;
  if (!providerId) return null;
  if (isServerTTSProviderDisabled(providerId)) throw new Error('EXPLANATION_TTS_PROVIDER_DISABLED');
  const modelId = resolveTTSModel(providerId, settings.ttsModelId, 'realtime-interaction');
  const preferredVoice = settings.ttsVoice || DEFAULT_TTS_VOICES[providerId as keyof typeof DEFAULT_TTS_VOICES];
  const scenarioVoice = resolveTTSVoice(providerId, preferredVoice, 'realtime-interaction');
  const voice = providerId === 'qwen-tts' && preferredVoice && qwenAudioTtsModelForVoice(preferredVoice) !== modelId
    ? scenarioVoice : preferredVoice || scenarioVoice;
  if (!voice) throw new Error('EXPLANATION_TTS_VOICE_MISSING');
  return { providerId, modelId, voice, speed: settings.ttsSpeed ?? 1,
    apiKey: resolveTTSApiKey(providerId), baseUrl: resolveTTSBaseUrl(providerId) };
}
/** A separate durable lease coalesces audio after the text has already committed. */
export async function prepareExplanationAudio(input: { id: string; classroomId: string; text: string; audio?: unknown }, signal: AbortSignal): Promise<{ audioUrl?: string; audioDurationSec?: number }> {
  if (!isValidClassroomId(input.classroomId)) throw new Error('INVALID_CLASSROOM_ID');
  const config = await resolveExplanationTtsConfig();
  if (!config) return {};
  const fingerprint = hash(['question-audio-v1', input.text, config]);
  if (storedAudio(input.audio)?.fingerprint === fingerprint) {
    const ready = await readableExplanationAudio(input.classroomId, input.audio, true);
    if (ready.audioUrl) return ready;
  }
  const token = randomUUID();
  for (;;) {
    signal.throwIfAborted();
    const count = await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET "audioToken" = ${token}, "audioLeaseUntil" = ${new Date(Date.now() + TUTOR_LEASE_MS)}, "audioError" = NULL
      WHERE id = ${input.id} AND status = 'COMPLETED' AND ("audioToken" IS NULL OR "audioLeaseUntil" < NOW())`;
    if (count === 1) break;
    const [row] = await prisma.$queryRaw<Array<{ audio: unknown; audioToken: string | null }>>`SELECT audio, "audioToken" FROM "KnowledgeExplanation" WHERE id = ${input.id}`;
    if (!row) throw new Error('EXPLANATION_TEXT_MISSING');
    if (storedAudio(row.audio)?.fingerprint === fingerprint) {
      const ready = await readableExplanationAudio(input.classroomId, row.audio, true);
      if (ready.audioUrl) return ready;
    }
    await sleep(500, undefined, { signal });
  }
  let temporary: string | undefined;
  try {
    // Re-read after taking the lease: another worker may have completed between checks.
    const [current] = await prisma.$queryRaw<Array<{ audio: unknown }>>`SELECT audio FROM "KnowledgeExplanation" WHERE id = ${input.id}`;
    if (storedAudio(current?.audio)?.fingerprint === fingerprint) {
      const ready = await readableExplanationAudio(input.classroomId, current.audio, true);
      if (ready.audioUrl) return ready;
    }
    const executionSignal = AbortSignal.any([signal, AbortSignal.timeout(120_000)]);
    const generated = await cachedTtsResult(config, input.text, () => runWithGlobalTtsProviderSlot(config.providerId,
      getTtsConcurrencyLimit(config.providerId), () => generateTTS({ ...config, signal: executionSignal }, input.text), executionSignal));
    executionSignal.throwIfAborted();
    const prepared = prepareGeneratedClassroomAudio(generated.audio, generated.format);
    const directory = path.join(CLASSROOMS_DIR, input.classroomId, 'audio');
    await mkdir(directory, { recursive: true });
    const filename = `explanation-${createHash('sha256').update(prepared.audio).digest('hex')}.${prepared.format}`;
    const destination = path.join(directory, filename);
    temporary = `${destination}.${token}.tmp`;
    await writeFile(temporary, prepared.audio);
    let duration = prepared.durationSec;
    if (!duration) {
      const { stdout } = await runFile('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', temporary], { timeout: 30_000 });
      duration = Number(JSON.parse(stdout).format?.duration);
    }
    if (!Number.isFinite(duration) || duration! <= 0) throw new Error('EXPLANATION_AUDIO_INVALID_DURATION');
    executionSignal.throwIfAborted();
    await rename(temporary, destination); temporary = undefined;
    const audio: StoredAudio = { filename, audioUrl: mediaServingUrl('', input.classroomId, `audio/${filename}`),
      audioDurationSec: duration!, bytes: prepared.audio.length, fingerprint };
    const committed = await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET audio = ${JSON.stringify(audio)}::jsonb, "audioError" = NULL,
      "audioToken" = NULL, "audioLeaseUntil" = NULL WHERE id = ${input.id} AND "audioToken" = ${token}`;
    if (committed !== 1) throw new Error('EXPLANATION_AUDIO_LEASE_EXPIRED');
    return { audioUrl: audio.audioUrl, audioDurationSec: audio.audioDurationSec };
  } catch (error) {
    let diagnostic = error instanceof Error ? error.message : 'Unknown audio failure';
    if (config.apiKey) diagnostic = diagnostic.split(config.apiKey).join('[redacted]');
    diagnostic = diagnostic.replace(/https?:\/\/\S+/g, '[provider-endpoint]').slice(0, 4_000);
    await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET "audioError" = ${`EXPLANATION_AUDIO_FAILED: ${diagnostic}`} WHERE id = ${input.id} AND "audioToken" = ${token}`;
    throw error;
  } finally {
    if (temporary) await unlink(temporary).catch(() => undefined);
    await prisma.$executeRaw`UPDATE "KnowledgeExplanation" SET "audioToken" = NULL, "audioLeaseUntil" = NULL WHERE id = ${input.id} AND "audioToken" = ${token}`;
  }
}
