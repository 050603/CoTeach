/**
 * Offline TTS timing evaluation. Never rewrites narration or persists provider settings.
 * Run: pnpm exec tsx scripts/evaluate-tts-first-pass.ts --deployment-secrets
 * Successful audio is cached; rerunning reuses it instead of synthesizing again.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import type { TTSModelConfig } from '../src/lib/openmaic/audio/types';
import type { TtsVoiceTimingCalibration } from '../src/lib/openmaic/audio/tts-timing';

const samples: Record<string, string[]> = {
  'zh-CN': [
    '观察杯中的水和冰块。冰块逐渐变小，水面缓慢上升。这个过程说明物质可以改变状态，但不会凭空消失。请说出你观察到的证据。',
    '比较两组幼苗的生长情况。两组使用相同的土壤和水量，只有每天接受的光照时间不同。这样设计实验，可以帮助我们判断光照的作用。',
    '阅读图中的三条河流，找出它们共同流向的位置。地势较高的地方通常是河流的源头，水在重力作用下流向较低的地方。',
    '解决问题时，先写出已知条件，再确定需要求出的量。把文字转成图形或表格，可以帮助我们发现条件之间的联系，减少遗漏。',
    '讨论小组意见时，先复述同伴的观点，再说明自己的理由。如果出现分歧，可以共同寻找证据，而不是只比较谁的声音更大。',
    '观察这个长方形，把它平均分成六个小格。每个小格表示整体的六分之一。取出其中两个小格，就可以表示整体的三分之一。',
    '制作纸桥之前，请先预测哪一种形状更牢固。测试时每次只增加一枚相同的硬币，并记录桥面开始弯曲的位置。最后比较预测与结果。',
    '植物的根吸收水分，茎把水分运输到叶片。叶片利用阳光进行光合作用。这些结构相互配合，帮助植物持续生长。',
    '故事中的人物改变了原来的决定。请回到前面的段落，找到促使他改变想法的事件，并用一句完整的话解释事件与决定之间的关系。',
    '评价一个方案时，需要同时考虑效果、成本和使用条件。先确定最重要的目标，再比较不同方案，最后说明选择的依据和可能的限制。',
  ],
  'en-US': [
    'Observe the water and the ice in the glass. The ice becomes smaller while the amount of liquid increases. Describe the evidence before you explain the change. A careful observation helps us separate what we can see from what we assume.',
    'Compare the two groups of seedlings. They receive the same soil and the same amount of water, but different hours of sunlight. This controlled comparison helps us investigate whether light affects plant growth. Explain why changing only one condition matters.',
    'Follow the three rivers on the map and identify where they meet. Water usually travels from higher ground toward lower ground. Use the direction of each river and the shape of the land to support your explanation.',
    'Before solving the problem, list the information that is given and identify what you need to find. A diagram or a small table can reveal connections between the quantities. Check that every step uses information from the problem.',
    'When your group disagrees, first restate the other idea in your own words. Then explain your reasons and ask what evidence would help everyone decide. The aim is to improve the explanation through discussion and careful listening.',
    'Imagine a rectangle divided into six equal parts. Each small part represents one sixth of the whole. Shade two parts and compare the shaded area with one third. Explain why the two descriptions refer to the same amount.',
    'Before building a paper bridge, predict which shape will carry more weight. During testing, add one identical coin at a time and record when the bridge begins to bend. Compare the results with your prediction and explain what you learned.',
    'Roots absorb water, and stems carry it toward the leaves. Leaves use sunlight to support the production of food. These structures work together rather than acting alone. Describe how a change in one structure might affect the entire plant.',
    'The character changes an earlier decision after an unexpected event. Return to the previous paragraph and find the sentence that explains this change. Use evidence from the story to connect the event with the new decision.',
    'A useful design must balance its intended effect, its cost, and the conditions in which people will use it. Identify the main goal first. Then compare the alternatives and explain both the strengths and the limits of your choice.',
  ],
  mixed: [
    '今天我们学习 observation，也就是观察。请先描述水和冰块的变化，再提出 explanation。把看到的证据和自己的推测分开，是科学探究的重要步骤。',
    '比较两组幼苗时，我们使用 control variable 的方法。保持土壤和水量相同，只改变光照时间。这样才能更清楚地判断 cause and effect 之间的关系。',
    '地图中的 river 从高处流向低处。请跟随箭头寻找三条河流的交汇点，再用 direction 和地形变化说明你的判断依据。',
    '解决问题之前，先列出 input，也就是已知条件。然后确定 output，也就是需要求出的量。画出简单的 diagram，可以帮助我们连接这些信息。',
    '小组讨论需要 active listening。先复述同伴的观点，再说明自己的 evidence。如果意见不同，可以提出一个能够验证想法的小实验。',
    '把长方形平均分成六份，每一份是 one sixth。取出其中两份，得到 two sixths。比较图形后，你会发现它与 one third 表示相同的面积。',
    '制作纸桥时，先提出 prediction，再开始 test。每次增加一枚相同的硬币，记录 bridge 的变化。最后比较预测与结果，并解释差异。',
    '植物的 roots 吸收水分，stem 运输水分，leaves 利用阳光。请画出这些结构之间的联系，说明整个 system 如何共同支持植物生长。',
    '故事中的 character 改变了决定。请寻找导致变化的 event，并引用一句 evidence。用完整的句子说明事件和决定之间的联系。',
    '评价设计时，需要考虑 effect、cost 和使用条件。先确定主要 goal，再比较不同方案。最后解释你的 choice，同时指出方案可能存在的限制。',
  ],
};

const independentCalibrationSamples: Record<string, string[]> = {
  'zh-CN': [
    '请观察这片叶子。',
    '冰遇到热会融化成水，这是一种状态变化。把观察到的现象写下来，并说明你使用了哪些证据。',
    '地球表面既有陆地也有海洋。陆地包括平原、高山和沙漠。不同地区的气温和降水并不相同，所以生活在那里的植物也各有特点。我们可以通过观察环境来解释这些差异。',
    '做调查之前需要确定问题和调查对象，然后设计所有人都能理解的问题并使用相同的方式记录答案，最后把收集的信息整理成表格，再根据表格找出有意义的规律，这样得出的结论才有明确的依据。',
    '设计一个节约用水的方案，需要先了解家庭中哪些活动会用到水。请连续记录洗手、清洁和浇花时的用水情况，区分必须使用的水和可以减少的浪费。记录完成以后，选择一个容易实施的改进措施，说明需要谁来参与、怎样操作，以及如何判断措施是否有效。实行一段时间后，再用相同的方法记录用水情况，比较前后的变化。注意季节、人数和活动数量的变化也可能影响结果，不能把所有差异都归因于新的措施。',
    '信息可能来自观察、测量、访谈和已有资料。使用信息时，要记录它来自哪里、什么时候获得，以及是否适合回答当前的问题。如果两份资料的结论不同，先比较研究对象和使用的方法，再判断差异是否有合理的解释。可靠的说明应当让别人能够追溯证据，并理解从证据到结论的推理过程。遇到证据不足的情况，可以明确指出还需要了解什么，而不是把猜测当成已经确定的事实。',
  ],
  'en-US': [
    'Observe this leaf carefully.',
    'When ice receives heat, it can melt into liquid water. Describe what you observe and explain which evidence supports your description.',
    'The surface of Earth includes land and oceans. Land can contain plains, mountains, and deserts. Temperature and rainfall vary between these places. These differences help explain why different kinds of plants grow in different environments.',
    'Before conducting a survey we need to define the question and identify the people who can help answer it, then ask clear questions in the same way and record each answer consistently so that we can organize the information and find meaningful patterns.',
    'To design a plan for saving water, first identify the activities that use water at home. Record washing, cleaning, and watering plants over several days. Separate necessary use from avoidable waste. Then choose a practical change and explain who will take part, how they will act, and how you will judge its effect. After trying the change, collect information in the same way and compare the results.',
    'Information can come from observation, measurement, interviews, or existing documents. Record where it came from and when it was collected. If two sources disagree, compare their subjects and methods before deciding which explanation is stronger. A reliable account allows other people to trace the evidence and understand the reasoning. When evidence is missing, describe what you still need to learn instead of presenting an assumption as a fact.',
  ],
  mixed: [
    '请观察这片 leaf。',
    '冰遇到 heat 会融化成水，这叫 state change。请写下 evidence，说明你看到了什么。',
    '地球表面包括 land 和 oceans。不同地区的 temperature 和 rainfall 不同，所以植物的种类也不一样。观察环境，可以帮助我们解释这些 differences。',
    'Before conducting a survey，我们先确定问题，再选择合适的 participants，然后用一致的方法 record each answer，最后通过整理 information 找出有意义的 patterns。',
    '设计节水方案需要先进行 observation。请记录家庭里 washing、cleaning 和 watering plants 的情况，区分必要用水和 waste。然后选择一个 practical change，说明由谁参与、怎样实施，以及用什么 evidence 判断效果。实行一段时间以后，再用相同的 method 收集数据，比较前后的变化。注意人数和活动也可能改变，所以需要解释其他可能影响 results 的条件。',
    'Information can come from observation、measurement 和 interviews。使用资料时，要记录 source 和收集时间。如果 two sources disagree，先比较研究对象和 methods，再判断差异是否合理。Reliable reasoning 应当让别人能够追溯 evidence，理解从信息到 conclusion 的过程。遇到证据不足时，要指出 what we still need to learn，不把 assumption 当成已经确定的 fact。',
  ],
};

async function main() {
  if (process.argv.includes('--deployment-secrets')) {
    const secretDir = process.env.OPENPBL_SECRET_DIR || path.resolve('deploy/secrets');
    for (const [key, file] of [['DATABASE_URL', 'database_url.txt'], ['PROVIDER_ENCRYPTION_KEY', 'provider_encryption_key.txt']]) {
      process.env[key] = (await fs.readFile(path.join(secretDir, file), 'utf8')).trim();
    }
  }
  const providers = await import('../src/lib/openmaic/server/provider-config');
  const media = await import('../src/lib/openmaic/server/classroom-media-generation');
  const timing = await import('../src/lib/openmaic/audio/tts-timing');
  const { generateTTS } = await import('../src/lib/openmaic/audio/tts-providers');
  const { withGenerationRetry } = await import('../src/lib/openmaic/generation/generation-retry');
  await providers.initializeServerProviderConfig();
  const selected = media.resolveServerTtsTimingSelection();
  if (selected.providerId === 'default') throw new Error('No deployed server TTS provider is configured');
  const outputIndex = process.argv.indexOf('--output');
  const output = path.resolve(outputIndex >= 0 ? process.argv[outputIndex + 1] : '.cache/tts-first-pass');
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const results: Array<Record<string, unknown>> = [];
  const calibrations: Record<string, TtsVoiceTimingCalibration | undefined> = {};
  try {
    for (const [language, texts] of Object.entries(samples)) {
      const identity = { ...selected, language };
      providers.resolveTTSTimingCalibration(identity.providerId, identity.modelId, identity.voiceId, language, identity.speed);
      const trainingTexts = independentCalibrationSamples[language];
      const combined = [...trainingTexts, ...texts];
      for (const [index, text] of combined.entries()) {
        const isTraining = index < trainingTexts.length;
        const predictedSec = timing.estimateSpeechDurationSec(text, identity);
        const seedPredictedSec = timing.estimateSpeechDurationSec(text, { ...identity, profile: timing.getTtsTimingProfile(identity.providerId, identity.modelId) });
        const config: TTSModelConfig = {
          providerId: selected.providerId as TTSModelConfig['providerId'], modelId: selected.modelId,
          voice: selected.voiceId, speed: selected.speed, language,
          apiKey: providers.resolveTTSApiKey(selected.providerId),
          baseUrl: providers.resolveTTSBaseUrl(selected.providerId),
          signal: AbortSignal.timeout(120_000),
        };
        const key = createHash('sha256').update(JSON.stringify({ identity, text })).digest('hex').slice(0, 20);
        const audioPath = path.join(output, `${key}.audio`);
        const started = Date.now();
        let cached = true;
        try {
          let audio: Buffer;
          try { audio = await fs.readFile(audioPath); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            cached = false;
            const result = await withGenerationRetry(() => generateTTS(config, text), { label: `offline TTS ${language}-${index + 1}`, maxRetries: 2, signal: config.signal });
            audio = Buffer.from(result.audio);
            await fs.writeFile(audioPath, audio);
          }
          const actualSec = await page.evaluate(async (base64) => {
            const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
            const context = new AudioContext();
            try { return (await context.decodeAudioData(bytes.buffer)).duration; }
            finally { await context.close(); }
          }, audio.toString('base64'));
          const assessment = timing.assessTtsDurationError({ targetSec: predictedSec, actualSec });
          const sample = timing.createTtsVoiceTimingCalibration({ ...identity, text, measuredDurationSec: actualSec });
          if (isTraining) calibrations[language] = timing.mergeTtsVoiceTimingCalibrations(calibrations[language], sample);
          if (index === trainingTexts.length - 1 && calibrations[language]) timing.registerTtsVoiceTimingCalibration(calibrations[language]!);
          results.push({ language, index: isTraining ? index + 1 : index - trainingTexts.length + 1, phase: isTraining ? 'independent-calibration' : 'held-out', text, predictedSec, seedPredictedSec, seedPass: timing.assessTtsDurationError({ targetSec: seedPredictedSec, actualSec }).withinTolerance, actualSec, errorRatio: assessment.errorRatio, pass: assessment.withinTolerance, cached, elapsedMs: Date.now() - started, audioPath });
          console.log(JSON.stringify({ language, sample: index + 1, phase: isTraining ? 'calibration' : 'held-out', predictedSec, actualSec: Math.round(actualSec * 100) / 100, pass: assessment.withinTolerance, cached }));
        } catch (error) {
          results.push({ language, index: index + 1, error: error instanceof Error ? error.message.slice(0, 500) : String(error), cached });
          console.log(JSON.stringify({ language, sample: index + 1, failed: true }));
        }
        await fs.writeFile(path.join(output, 'results.json'), JSON.stringify({ identity: selected, algorithmVersion: timing.TTS_TIMING_ALGORITHM_VERSION, generatedAt: new Date().toISOString(), results, offlineCalibrations: calibrations }, null, 2));
      }
    }
  } finally {
    await browser.close();
    const { prisma } = await import('../src/lib/db/client');
    await prisma.$disconnect();
  }
  const completed = results.filter((result) => typeof result.actualSec === 'number');
  const heldOut = completed.filter((result) => result.phase === 'held-out');
  const aggregateTiming = Object.fromEntries(['all', ...Object.keys(samples)].map((language) => {
    const group = heldOut.filter((result) => language === 'all' || result.language === language);
    const predictedSec = group.reduce((sum, result) => sum + Number(result.predictedSec), 0);
    const actualSec = group.reduce((sum, result) => sum + Number(result.actualSec), 0);
    const errorRatio = actualSec / predictedSec - 1;
    return [language, { samples: group.length, predictedSec, actualSec, errorRatio, withinTolerance: group.length > 0 && Math.abs(errorRatio) <= 0.1 }];
  }));
  const summary = { configured: selected, completed: completed.length, total: results.length,
    primaryMetric: 'Total knowledge-lecture duration; individual clips are diagnostic only.', aggregateTiming,
    pass: completed.filter((result) => result.pass).length, heldOut: heldOut.length, heldOutPass: heldOut.filter((result) => result.pass).length, seedHeldOutPass: heldOut.filter((result) => result.seedPass).length, persistedCalibration: false };
  await fs.writeFile(path.join(output, 'summary.json'), JSON.stringify(summary, null, 2));
  await fs.writeFile(path.join(output, 'calibrations.json'), JSON.stringify({
    algorithmVersion: timing.TTS_TIMING_ALGORITHM_VERSION,
    source: 'Independent offline calibration; 6 varied-length samples per language.',
    profiles: Object.values(calibrations),
  }, null, 2));
  console.log(JSON.stringify(summary));
}
main().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
