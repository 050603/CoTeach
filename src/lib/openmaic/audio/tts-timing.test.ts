import { describe, expect, it } from 'vitest';
import {
  assessTtsDurationError,
  countSpeechUnits,
  countLatinArticulationUnits,
  TTS_TIMING_ALGORITHM_VERSION,
  formatTtsParagraphBudgets,
  buildTtsTimingPlan,
  calculateTtsContentBudget,
  createTtsVoiceTimingCalibration,
  getTtsCalibrationKey,
  isActivityTimingCorrectionCloser,
  mergeTtsVoiceTimingCalibrations,
  estimateSpeechDurationSec,
  getTtsTimingProfile,
  registerTtsVoiceTimingCalibration,
} from './tts-timing';

describe('TTS timing model', () => {
  it('preserves English word boundaries separated by Chinese text', () => {
    expect(countSpeechUnits('hello世界world')).toMatchObject({ cjkChars: 2, latinWords: 2, otherChars: 0 });
  });
  it('resolves a model-specific static profile', () => {
    const qwen = getTtsTimingProfile('qwen-tts', 'qwen-audio-3.0-tts-flash');
    const azure = getTtsTimingProfile('azure-tts', '');

    expect(qwen.modelId).toBe('qwen-audio-3.0-tts-flash');
    expect(azure.providerId).toBe('azure-tts');
    expect(qwen.id).not.toBe(azure.id);
  });

  it('keeps an unknown provider/model extensible with a safe static profile', () => {
    const profile = getTtsTimingProfile('new-tts-provider', 'new-model-v1');
    expect(profile.providerId).toBe('new-tts-provider');
    expect(profile.modelId).toBe('new-model-v1');
    expect(profile.cjkCharsPerMinute).toBeGreaterThan(0);
    expect(profile.source).toBe('seed');
  });

  it('calculates enough Chinese content for a five-minute narration', () => {
    const profile = getTtsTimingProfile('qwen-tts', 'qwen-audio-3.0-tts-flash');
    const budget = calculateTtsContentBudget(300, {
      profile,
      speed: 1,
      language: 'zh-CN',
      punctuationRatio: 1 / 28,
    });

    expect(budget.unit).toBe('cjk-char');
    expect(budget.targetUnits).toBeGreaterThan(1_000);
    expect(budget.targetUnits).toBeLessThan(1_500);
    expect(budget.minUnits).toBeLessThan(budget.targetUnits);
    expect(budget.maxUnits).toBeGreaterThan(budget.targetUnits);
  });

  it('handles mixed speech with the selected speed', () => {
    const profile = getTtsTimingProfile('azure-tts', '');
    const text = 'This is an API design case. Observe request and response.';
    const normal = estimateSpeechDurationSec(text, { profile, speed: 1 });
    const faster = estimateSpeechDurationSec(text, { profile, speed: 1.5 });

    expect(normal).toBeGreaterThan(faster);
    expect(faster).toBeGreaterThan(1);
  });

  it('reports a concrete adjustment when a one-off estimate is outside ten percent', () => {
    const assessment = assessTtsDurationError({ targetSec: 300, actualSec: 105 });

    expect(assessment.status).toBe('under');
    expect(assessment.errorRatio).toBeCloseTo(-0.65, 2);
    expect(assessment.withinTolerance).toBe(false);
    expect(assessment.suggestions.length).toBeGreaterThan(0);
  });

  it('builds a static plan that can be recalculated for another model', () => {
    const plan = buildTtsTimingPlan({
      targetDurationSec: 300,
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      speed: 1,
      language: 'zh-CN',
      contentType: 'theory',
    });

    expect(plan.targetDurationSec).toBe(300);
    expect(plan.targetUnits).toBeGreaterThan(1_000);
    expect(plan.contentType).toBe('theory');
    expect(plan).not.toHaveProperty('calibration');
    expect(plan).not.toHaveProperty('expectedNaturalDurationSec');
  });

  it('calibrates and resolves an exact provider/model/voice at natural speed', () => {
    const text = '这是用于自然语速建模的一段标准课程讲解文本。';
    const calibration = createTtsVoiceTimingCalibration({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Cherry',
      text,
      measuredDurationSec: 6,
    });
    registerTtsVoiceTimingCalibration(calibration);

    const exact = getTtsTimingProfile('qwen-tts', 'qwen3-tts-flash', 'Cherry');
    const otherVoice = getTtsTimingProfile('qwen-tts', 'qwen3-tts-flash', 'Serena');

    expect(exact.source).toBe('configured');
    expect(exact.voiceId).toBe('Cherry');
    expect(exact.punctuationPauseSec).toBe(0);
    expect(otherVoice.source).toBe('seed');
  });

  it('records narration and silent student activity as separate budgets', () => {
    const plan = buildTtsTimingPlan({
      targetDurationSec: 55,
      activityTargetDurationSec: 180,
      studentActivitySec: 115,
      feedbackSec: 25,
      transitionSec: 10,
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Serena',
      contentType: 'quiz',
    });

    expect(plan.speed).toBe(1);
    expect(plan.narrationSec).toBe(55);
    expect(plan.studentActivitySec).toBe(115);
    expect(plan.feedbackSec).toBe(25);
    expect(plan.transitionSec).toBe(10);
  });

  it('uses exact voice calibration to reverse-calculate different script sizes', () => {
    const calibrationText = '这是用于音色自然语速建模的标准课程讲解样本。'.repeat(12);
    registerTtsVoiceTimingCalibration(createTtsVoiceTimingCalibration({
      providerId: 'page-budget-test',
      modelId: 'voice-model',
      voiceId: 'fast-voice',
      text: calibrationText,
      measuredDurationSec: 20,
    }));
    registerTtsVoiceTimingCalibration(createTtsVoiceTimingCalibration({
      providerId: 'page-budget-test',
      modelId: 'voice-model',
      voiceId: 'slow-voice',
      text: calibrationText,
      measuredDurationSec: 40,
    }));

    const fast = buildTtsTimingPlan({
      targetDurationSec: 120,
      providerId: 'page-budget-test',
      modelId: 'voice-model',
      voiceId: 'fast-voice',
      language: 'zh-CN',
      naturalSpeedLocked: true,
    });
    const slow = buildTtsTimingPlan({
      targetDurationSec: 120,
      providerId: 'page-budget-test',
      modelId: 'voice-model',
      voiceId: 'slow-voice',
      language: 'zh-CN',
      naturalSpeedLocked: true,
    });

    expect(fast.calibrationSource).toBe('configured');
    expect(slow.calibrationSource).toBe('configured');
    expect(fast.targetUnits).toBeGreaterThan(slow.targetUnits);
    expect(fast.effectiveUnitsPerMinute!).toBeGreaterThan(slow.effectiveUnitsPerMinute!);
    expect(fast.speed).toBe(1);
    expect(slow.speed).toBe(1);
  });

  it('locks AI narration to natural speed and carries the full page breakdown', () => {
    const plan = buildTtsTimingPlan({
      targetDurationSec: 80,
      activityTargetDurationSec: 180,
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Serena',
      speed: 1.75,
      naturalSpeedLocked: true,
      pageKind: 'interactive',
      readingThinkingSec: 35,
      operationSec: 55,
      studentActivitySec: 90,
      feedbackSec: 20,
      transitionSec: 10,
      taskComplexity: 'high',
      recommendedStudentActivitySec: 120,
      taskFitsBudget: false,
      timingRationale: ['Simplify the task to fit the confirmed page budget.'],
    });

    expect(plan.speed).toBe(1);
    expect(plan.naturalSpeedLocked).toBe(true);
    expect(plan.pageKind).toBe('interactive');
    expect(plan.readingThinkingSec).toBe(35);
    expect(plan.operationSec).toBe(55);
    expect(plan.studentActivitySec).toBe(90);
    expect(plan.taskFitsBudget).toBe(false);
  });

  it('selects a correction against the same total activity target', () => {
    expect(isActivityTimingCorrectionCloser({
      activityTargetSec: 180,
      reservedActivitySec: 80,
      firstNarrationSec: 80,
      correctedNarrationSec: 105,
    })).toBe(true);
  });

  it('binds calibration identity to provider, model, voice, language, and speed', () => {
    const base = createTtsVoiceTimingCalibration({
      providerId: 'qwen-tts',
      modelId: 'qwen3-tts-flash',
      voiceId: 'Cherry',
      language: 'zh-CN',
      speed: 1,
      text: '这是测试文本。',
      measuredDurationSec: 2,
    });
    expect(getTtsCalibrationKey(base)).not.toBe(getTtsCalibrationKey({ ...base, voiceId: 'Serena' }));
    expect(getTtsCalibrationKey(base)).not.toBe(getTtsCalibrationKey({ ...base, language: 'en-US' }));
    expect(getTtsCalibrationKey(base)).not.toBe(getTtsCalibrationKey({ ...base, speed: 1.2 }));
  });

  it('aggregates repeated samples by total units and decoded duration', () => {
    const first = createTtsVoiceTimingCalibration({
      providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry',
      text: '这是第一段标准测试文本。', measuredDurationSec: 3,
    });
    const second = createTtsVoiceTimingCalibration({
      providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Cherry',
      text: '这是第二段标准测试文本。', measuredDurationSec: 5,
    });
    const aggregate = mergeTtsVoiceTimingCalibrations(first, second);

    expect(aggregate.sampleCount).toBe(2);
    expect(aggregate.totalSampleUnits).toBe(first.sampleUnits + second.sampleUnits);
    expect(aggregate.totalMeasuredDurationSec).toBe(8);
    expect(aggregate.cjkCharsPerMinute).toBeCloseTo(
      ((first.sampleUnits + second.sampleUnits) * 60) / 8,
      1,
    );
  });
  it('counts complete English words once and excludes spaces and decimal punctuation', () => {
    expect(countSpeechUnits("Hello world, it's 3.14."))
      .toEqual({ cjkChars: 0, latinWords: 4, otherChars: 0, punctuation: 2 });
    expect(countSpeechUnits('你好 OpenAI 2026！'))
      .toEqual({ cjkChars: 2, latinWords: 2, otherChars: 0, punctuation: 1 });
  });

  it('isolates language, speed and algorithm version in runtime calibration', () => {
    const calibration = createTtsVoiceTimingCalibration({
      providerId: 'isolation-test', modelId: 'm', voiceId: 'v', language: 'en-US',
      speed: 1.5, text: 'A measured English voice sample.', measuredDurationSec: 3,
    });
    registerTtsVoiceTimingCalibration(calibration);
    expect(getTtsTimingProfile('isolation-test', 'm', 'v', 'en-US', 1.5).source).toBe('configured');
    expect(getTtsTimingProfile('isolation-test', 'm', 'v', 'zh-CN', 1.5).source).toBe('seed');
    expect(getTtsTimingProfile('isolation-test', 'm', 'v', 'en-US', 1).source).toBe('seed');
    registerTtsVoiceTimingCalibration({ ...calibration, voiceId: 'old', algorithmVersion: undefined });
    expect(getTtsTimingProfile('isolation-test', 'm', 'old', 'en-US', 1.5).source).toBe('seed');
    expect(getTtsCalibrationKey(calibration)).not.toBe(getTtsCalibrationKey({ ...calibration, algorithmVersion: undefined }));
    expect(estimateSpeechDurationSec('A measured English voice sample.', {
      providerId: 'isolation-test', modelId: 'm', voiceId: 'v', language: 'en-US', speed: 1.5,
    })).toBeCloseTo(3, 1);
  });

  it('preserves narration seconds and speech units across all first-draft paragraphs', () => {
    const plan = buildTtsTimingPlan({ targetDurationSec: 57, feedbackSec: 13, language: 'en-US' });
    expect(plan.algorithmVersion).toBe(TTS_TIMING_ALGORITHM_VERSION);
    expect(plan.paragraphBudgets!.reduce((total, part) => total + part.targetDurationSec, 0)).toBe(57);
    expect(plan.paragraphBudgets!.reduce((total, part) => total + part.targetUnits, 0)).toBe(plan.targetUnits);
    expect(plan.paragraphBudgets!.find((part) => part.role === 'feedback')!.targetDurationSec).toBe(13);
    expect(formatTtsParagraphBudgets(plan)).toContain('反馈：13 秒');
    expect(formatTtsParagraphBudgets(plan)).toContain('不要求各段分别落在±10%内');
  });

  it('uses articulation length for technical words and never counts CJK twice', () => {
    expect(countLatinArticulationUnits('observation measurement information'))
      .toBeGreaterThan(countLatinArticulationUnits('see this leaf'));
    expect(countLatinArticulationUnits('这是中文。')).toBe(0);
    expect(countLatinArticulationUnits('API')).toBe(2);
    expect(countLatinArticulationUnits('3.14')).toBeGreaterThan(countLatinArticulationUnits('3'));
  });

  it('fits independent varied-length calibration samples with nonnegative timing components', () => {
    let aggregate: ReturnType<typeof createTtsVoiceTimingCalibration> | undefined;
    for (const [chars, pauses] of [[2, 1], [6, 2], [12, 1], [24, 4], [48, 3], [96, 8]]) {
      const sample = createTtsVoiceTimingCalibration({
        providerId: 'linear-fit-test', modelId: 'm', voiceId: 'v',
        text: '学'.repeat(chars) + '。'.repeat(pauses),
        measuredDurationSec: 0.3 + chars * 0.2 + pauses * 0.15,
      });
      aggregate = mergeTtsVoiceTimingCalibrations(aggregate, sample);
    }
    const profile = registerTtsVoiceTimingCalibration(aggregate!);
    expect(aggregate!.rateModel).toBe('relative-linear-v1');
    expect(profile.fixedOverheadSec).toBeGreaterThanOrEqual(0);
    expect(profile.punctuationPauseSec).toBeGreaterThanOrEqual(0);
    const estimated = estimateSpeechDurationSec('学'.repeat(15) + '。'.repeat(5), { profile });
    expect(Math.abs(estimated - 4.05)).toBeLessThan(0.4);
  });

  it('does not reuse removed-model offline calibration for Qwen Audio 3.0', () => {
    expect(getTtsTimingProfile('qwen-tts', 'qwen-audio-3.0-tts-flash', 'longanfengyue', 'en-US', 1).source).toBe('seed');
    expect(getTtsTimingProfile('qwen-tts', 'qwen-audio-3.0-tts-plus', 'longanlingxin', 'zh-CN', 1).source).toBe('seed');
  });

  it('keeps an unusually long calibration from dominating ordinary short narration', () => {
    let aggregate: ReturnType<typeof createTtsVoiceTimingCalibration> | undefined;
    for (const [chars, duration] of [[10, 2], [20, 4], [30, 6], [40, 8], [50, 10], [1000, 300]]) {
      aggregate = mergeTtsVoiceTimingCalibrations(aggregate, createTtsVoiceTimingCalibration({
        providerId: 'relative-fit-test', text: '学'.repeat(chars), measuredDurationSec: duration,
      }));
    }
    const profile = registerTtsVoiceTimingCalibration(aggregate!);
    expect(estimateSpeechDurationSec('学'.repeat(30), { profile })).toBeLessThan(6.6);
  });

  it('rejects version-three calibration for the new relative-error model', () => {
    const sample = createTtsVoiceTimingCalibration({ providerId: 'prior-fit-version', text: '学'.repeat(60), measuredDurationSec: 5 });
    expect(registerTtsVoiceTimingCalibration({ ...sample, algorithmVersion: 3 }).source).toBe('seed');
    expect(sample.algorithmVersion).toBe(4);
  });

  it('defines mixed budgets with the locked profile equivalent-unit ratio and inverts both languages', () => {
    const profile = getTtsTimingProfile('qwen-tts', 'qwen3-tts-flash', 'Ethan', 'mixed', 1);
    const text = '学'.repeat(20) + ' one two three';
    const equivalent = 20 + countLatinArticulationUnits(text) * profile.cjkCharsPerMinute / profile.latinWordsPerMinute;
    const target = (profile.fixedOverheadSec ?? 0) + equivalent * 60 / profile.cjkCharsPerMinute;
    const budget = calculateTtsContentBudget(target, { profile, language: 'mixed', punctuationRatio: 0 });
    expect(budget.unit).toBe('mixed-unit');
    expect(budget.targetUnits).toBe(Math.round(equivalent));
    expect(estimateSpeechDurationSec(text, { profile })).toBeCloseTo(target, 1);
    const plan = buildTtsTimingPlan({ targetDurationSec: 60, providerId: 'qwen-tts', modelId: 'qwen3-tts-flash', voiceId: 'Ethan', language: 'mixed' });
    expect(plan.latinReferenceWordCjkUnits).toBe(budget.latinReferenceWordCjkUnits);
    expect(formatTtsParagraphBudgets(plan)).toContain('中文等价单位');
    expect(formatTtsParagraphBudgets(plan)).toContain(plan.latinReferenceWordCjkUnits!.toFixed(3));
  });

});
