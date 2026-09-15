/** Real first-draft action generation -> deployed speech synthesis -> total-stage timing.
 * node scripts/run-teaching-stage-first-pass.mjs --deployment-secrets
 * Three fixed bilingual teaching groups, two editable fixture slides each, 120 seconds/group.
 * No slide generation, grading, rewriting, rate fitting, or calibration fitting occurs here.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import type { SceneOutline, GeneratedSlideContent } from '../src/lib/openmaic/types/generation';
import type { Action, SpeechAction } from '../src/lib/openmaic/types/action';
import type { TTSModelConfig } from '../src/lib/openmaic/audio/types';
import type { AICallFn } from '../src/lib/openmaic/generation/pipeline-types';

const fixtures = [
  { language: 'zh-CN', directive: '全部讲解用简体中文。', pages: [
    { title: '蒸发：液态水变成水蒸气', points: ['蒸发是液态水变为水蒸气的过程，可以在水面发生。', '水蒸气本身看不见。湿衣服变干是蒸发的日常例子。', '比较干燥条件时保持衣物、初始含水量相同，只改变一个条件，依据干燥时间作判断。'] },
    { title: '凝结：水蒸气变回液态水', points: ['空气中的水蒸气遇到较冷的表面，可能凝结成小水滴。', '冷杯外壁出现水滴，不是杯内的水穿过杯壁。用蒸发和凝结解释这两个生活现象。'] },
  ] },
  { language: 'en-US', directive: 'Deliver all narration in English.', pages: [
    { title: 'Evaporation changes liquid water into water vapor', points: ['Evaporation changes liquid water into water vapor and can occur at the water surface.', 'Water vapor itself is invisible. Wet clothes becoming dry provide an everyday example of evaporation.', 'For a fair drying comparison, keep the cloth and starting water amount the same. Change one condition and compare drying times.'] },
    { title: 'Condensation changes water vapor into liquid water', points: ['Water vapor in air can form liquid droplets when it encounters a cooler surface.', 'Droplets outside a cold glass do not mean water has passed through the glass. Connect this observation to evaporation and condensation.'] },
  ] },
  { language: 'mixed', directive: '用中文解释，并自然使用以下英文术语：evaporation、water vapor、condensation。其余讲解以中文为主。', pages: [
    { title: 'Evaporation：液态水变成水蒸气', points: ['evaporation 是液态水变为 water vapor 的过程，可以在水面发生。', 'water vapor 本身看不见，湿衣服变干是蒸发的日常例子。', 'fair comparison 应保持衣物和初始含水量相同，每次只改变一个条件，以干燥时间为证据。'] },
    { title: 'Condensation：水蒸气变回液态水', points: ['空气中的 water vapor 遇到较冷的表面，可能发生 condensation，形成小水滴。', '冷杯外壁水滴来自空气，不是杯内水穿过杯壁。联系 evaporation 与 condensation 解释生活现象。'] },
  ] },
];
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const readJson = async <T>(file: string): Promise<T | undefined> => {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
};
const writeJson = async (file: string, value: unknown) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');

async function main() {
  const args = process.argv.slice(2);
  const argument = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  if (args.includes('--deployment-secrets')) {
    const dir = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [key, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) {
      process.env[key] = (await fs.readFile(path.join(dir, file), 'utf8')).trim();
    }
  }
  const output = path.resolve(argument('--output') || '.openpbl-runtime/teaching-stage-first-pass');
  await fs.mkdir(output, { recursive: true });
  const providers = await import('../src/lib/openmaic/server/provider-config');
  await providers.initializeServerProviderConfig();
  const { resolveModel } = await import('../src/lib/openmaic/server/resolve-model');
  const { createCourseGenerationAiCall } = await import('../src/lib/openmaic/server/course-generation-ai-call');
  const { attachTtsTimingPlans } = await import('../src/lib/openmaic/server/classroom-generation');
  const { resolveServerTtsTimingSelection } = await import('../src/lib/openmaic/server/classroom-media-generation');
  const { generateSceneActions } = await import('../src/lib/openmaic/generation/scene-generator');
  const { splitLongSpeechActions } = await import('../src/lib/openmaic/audio/tts-utils');
  const { generateTTS } = await import('../src/lib/openmaic/audio/tts-providers');
  const { withGenerationRetry } = await import('../src/lib/openmaic/generation/generation-retry');
  const { estimateSpeechDurationSec, TTS_TIMING_ALGORITHM_VERSION } = await import('../src/lib/openmaic/audio/tts-timing');
  const resolved = await resolveModel({ stage: 'generate-classroom' });
  const voice = resolveServerTtsTimingSelection();
  if (voice.providerId === 'default') throw new Error('No deployed speech provider configured');
  if (voice.speed !== 1) throw new Error('Experiment requires natural speed 1');
  const sourceFiles = [
    'src/lib/openmaic/server/teaching-stage-timing-plan.ts', 'src/lib/openmaic/server/classroom-generation.ts',
    'src/lib/openmaic/generation/scene-generator.ts', 'src/lib/openmaic/audio/tts-timing.ts',
    'src/lib/openmaic/audio/tts-voice-calibrations.json', 'src/lib/openmaic/audio/tts-providers.ts',
    'src/lib/openmaic/audio/tts-utils.ts', 'src/lib/openmaic/prompts/templates/slide-actions/system.md',
    'src/lib/openmaic/prompts/templates/slide-actions/user.md',
  ];
  const sourceHashes = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, digest(await fs.readFile(file, 'utf8'))])));
  const identity = { model: resolved.modelString, thinking: resolved.thinkingConfig ?? null, voice, algorithmVersion: TTS_TIMING_ALGORITHM_VERSION, sourceHashes, fixtures };
  const existing = await readJson<{ identityHash: string }>(path.join(output, 'manifest.json'));
  if (existing && existing.identityHash !== digest(identity)) throw new Error('Frozen experiment inputs changed; use a separate output directory instead of regenerating existing content');
  if (!existing) await writeJson(path.join(output, 'manifest.json'), { identityHash: digest(identity), createdAt: new Date().toISOString(), identity, scope: 'Real first-draft actions on fixed editable slides, followed by actual deployed TTS; no slide-content generation.' });
  console.log(JSON.stringify({ started: true, model: resolved.modelString, voice, output }));
  const ai = createCourseGenerationAiCall({ model: resolved.model, vision: false, source: 'generate-classroom-scene', thinking: resolved.thinkingConfig, maxOutputTokens: resolved.modelInfo?.outputWindow, timeoutMs: 180_000 });
  const browser = await chromium.launch({ headless: true, ...(process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.OPENPBL_CHROMIUM_EXECUTABLE_PATH } : {}) });
  const decodePage = await browser.newPage();
  const groups: unknown[] = [];
  try {
    for (const fixture of fixtures) {
      const dir = path.join(output, fixture.language); await fs.mkdir(dir, { recursive: true });
      const selected = { ...voice, language: fixture.language, speed: 1 };
      const outlines = attachTtsTimingPlans(fixture.pages.map((page, index): SceneOutline => ({
        id: `${fixture.language}-${index + 1}`, title: page.title, description: page.points.join(' '), keyPoints: page.points,
        type: 'slide', order: index, audience: 'student', stageKey: 'ai-learning', generationPurpose: 'knowledge-teaching',
        ttsPolicy: 'target-duration', targetDurationSec: 60, estimatedDuration: 60, knowledgePointIds: [index ? 'condensation' : 'evaporation'],
      })), selected);
      await writeJson(path.join(dir, 'prepared-outlines.json'), outlines);
      const pageResults: Array<Record<string, unknown>> = [];
      let audioTotalSec = 0;
      for (const [index, outline] of outlines.entries()) {
        const pageDir = path.join(dir, String(index + 1)); await fs.mkdir(pageDir, { recursive: true });
        const content = { elements: [{ id: 'title', type: 'text', left: 60, top: 40, width: 880, height: 70, content: `<p>${outline.title}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#111827' },
          ...outline.keyPoints.map((point, n) => ({ id: `point-${n}`, type: 'text', left: 60, top: 150 + n * 100, width: 880, height: 85, content: `<p>${point}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#111827' }))] } as GeneratedSlideContent;
        await writeJson(path.join(pageDir, 'editable-slide.json'), content);
        let modelRequestCount = 0;
        const cachedAi: AICallFn = async (system, prompt, images) => {
          modelRequestCount++;
          if (modelRequestCount > 1) throw new Error('Only one action authoring request is allowed per page');
          const request = { system, prompt, images: images ?? [] };
          const requestPath = path.join(pageDir, 'model-request.json');
          const prior = await readJson<typeof request>(requestPath);
          if (prior && digest(prior) !== digest(request)) throw new Error('Cached model request changed');
          await writeJson(requestPath, request);
          const cached = await readJson<{ text: string }>(path.join(pageDir, 'model-response.json'));
          if (cached) return cached.text;
          const text = await ai(system, prompt, images);
          await writeJson(path.join(pageDir, 'model-response.json'), { text });
          return text;
        };
        let actions = await readJson<Action[]>(path.join(pageDir, 'actions.json'));
        if (!actions) {
          console.log(JSON.stringify({ language: fixture.language, page: index + 1, phase: 'first-draft-actions', speechTargetSec: outline.timingPlan?.targetDurationSec }));
          actions = await generateSceneActions(outline, content, cachedAi, { languageDirective: fixture.directive, teachingSourceContext: fixture.pages.map((page) => page.points.join(' ')).join('\n') });
          await writeJson(path.join(pageDir, 'actions.json'), actions);
        }
        const splitActions = splitLongSpeechActions(actions, voice.providerId as TTSModelConfig['providerId']);
        const speeches = splitActions.filter((action): action is SpeechAction => action.type === 'speech' && Boolean(action.text));
        if (!speeches.length) throw new Error('First draft contained no speech actions');
        const segments: Array<Record<string, unknown>> = [];
        for (const [speechIndex, speech] of speeches.entries()) {
          const key = digest({ selected, text: speech.text, adapter: sourceHashes['src/lib/openmaic/audio/tts-providers.ts'] });
          const audioPath = path.join(pageDir, `${key}.audio`);
          let audio: Buffer; let cached = true;
          try { audio = await fs.readFile(audioPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            cached = false;
            const config: TTSModelConfig = {
              providerId: selected.providerId as TTSModelConfig['providerId'], modelId: selected.modelId, voice: selected.voiceId, speed: 1, language: selected.language,
              apiKey: providers.resolveTTSApiKey(selected.providerId), baseUrl: providers.resolveTTSBaseUrl(selected.providerId),
            };
            const result = await withGenerationRetry(() => generateTTS({ ...config, signal: AbortSignal.timeout(120_000) }, speech.text), { label: `stage experiment ${outline.id}/${speechIndex}`, maxRetries: 2 });
            audio = Buffer.from(result.audio); await fs.writeFile(audioPath, audio);
          }
          const actualSec = await decodePage.evaluate(async (base64) => {
            const context = new AudioContext();
            try { return (await context.decodeAudioData(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)).buffer)).duration; }
            finally { await context.close(); }
          }, audio.toString('base64'));
          const predictedSec = estimateSpeechDurationSec(speech.text, selected);
          segments.push({ index: speechIndex + 1, text: speech.text, predictedSec, actualSec, cached, audioPath: path.relative(output, audioPath) });
          await writeJson(path.join(pageDir, 'segments.json'), segments);
          console.log(JSON.stringify({ language: fixture.language, page: index + 1, segment: speechIndex + 1, phase: 'audio', actualSec: Math.round(actualSec * 100) / 100, cached }));
        }
        const actualSec = segments.reduce((sum, segment) => sum + Number(segment.actualSec), 0);
        audioTotalSec += actualSec;
        pageResults.push({ page: index + 1, targetSec: outline.timingPlan?.targetDurationSec, actualSpeechSec: actualSec, segments, diagnosticOnly: true });
        await writeJson(path.join(dir, 'progress.json'), pageResults);
      }
      const transitionSec = outlines.reduce((sum, outline) => sum + (outline.timingPlan?.transitionSec ?? 0), 0);
      const targetSec = outlines[0].teachingStageTiming!.targetDurationSec;
      const actualTotalSec = audioTotalSec + transitionSec;
      const errorRatio = actualTotalSec / targetSec - 1;
      const result = { language: fixture.language, targetSec, audioTotalSec, transitionSec, actualTotalSec, errorRatio, withinTolerance: Math.abs(errorRatio) <= 0.1, pages: pageResults };
      groups.push(result); await writeJson(path.join(output, 'results.json'), { generatedAt: new Date().toISOString(), identityHash: digest(identity), groups });
      console.log(JSON.stringify({ language: fixture.language, phase: 'stage-complete', targetSec, actualTotalSec, errorRatio, withinTolerance: result.withinTolerance }));
    }
  } finally {
    await browser.close();
    const { prisma } = await import('../src/lib/db/client'); await prisma.$disconnect();
  }
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
