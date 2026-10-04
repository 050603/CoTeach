import { describe, expect, it } from 'vitest';
import { buildTeachingSpeechBudget } from './teaching-speech-budget';
import type { TtsTimingProfile } from '@/lib/openmaic/audio/tts-timing';

const profile: TtsTimingProfile = { id: 'test-voice', providerId: 'test', modelId: 'test', voiceId: 'teacher',
  label: '校准音色', cjkCharsPerMinute: 240, latinWordsPerMinute: 120, punctuationPauseSec: 0.5,
  fixedOverheadSec: 2, defaultSpeed: 1.5, source: 'configured' };

describe('first-authoring section speech budget', () => {
  it('reserves silent time and uses calibrated pauses at natural speed instead of multiplying a fixed character rate', () => {
    const budget = buildTeachingSpeechBudget({ targetDurationSec: 120, narrationDurationSec: 90, profile,
      pageHints: [{ pageId: 'definition', narrationDurationSec: 30 }, { pageId: 'case', narrationDurationSec: 60 }] });
    expect(budget.narrationDurationSec).toBe(90);
    expect(budget.reservedDurationSec).toBe(30);
    expect(budget.naturalSpeed).toBe(1);
    expect(budget.targetUnits).toBeLessThan(360);
    expect(budget.profile.source).toBe('configured');
    expect(budget.pageHints.map((page) => page.narrationDurationSec)).toEqual([30, 60]);
    expect(budget.pageHints[1]!.targetUnits).toBeGreaterThan(budget.pageHints[0]!.targetUnits);
    expect(budget.quoteExpansionIncluded).toBe(true);
  });

  it('keeps page shares advisory and does not turn a silent page into a speech minimum', () => {
    const budget = buildTeachingSpeechBudget({ targetDurationSec: 100, narrationDurationSec: 80,
      pageHints: [{ pageId: 'silent-observation', narrationDurationSec: 0 }, { pageId: 'case', narrationDurationSec: 40 }] });
    expect(budget.pageHints[0]).toMatchObject({ targetUnits: 0, minUnits: 0, maxUnits: 0 });
    expect(budget.pageHints[1]!.narrationDurationSec).toBe(40);
    expect(budget.narrationDurationSec).toBe(80);
    expect(budget.allocation).toBe('section-total-with-soft-page-hints');
    expect(budget.enforcement).toBe('reference-only');
    expect(budget.priority).toBe('clear-and-complete-explanation');
    expect(budget.guidance).toContain('必要超时允许');
    expect(budget.guidance).toContain('不作为质量通过或失败的条件');
    expect(budget.guidance).toContain('不靠加速、重复、填充或删减必需教学内容');
  });

  it('uses word units for an English lesson and preserves a zero narration allocation', () => {
    const english = buildTeachingSpeechBudget({ targetDurationSec: 60, language: 'en-US', profile });
    expect(english.unit).toBe('latin-word');
    const silent = buildTeachingSpeechBudget({ targetDurationSec: 60, narrationDurationSec: 0, profile });
    expect(silent.targetUnits).toBe(0);
    expect(silent.reservedDurationSec).toBe(60);
  });

  it('keeps the selected voice identity when its duration estimate uses a provider default', () => {
    const budget = buildTeachingSpeechBudget({ targetDurationSec: 60, providerId: 'qwen-tts',
      modelId: 'qwen-audio-3.0-tts-plus', voiceId: 'longanlingxin', language: 'zh-CN' });
    expect(budget.profile).toMatchObject({ providerId: 'qwen-tts',
      modelId: 'qwen-audio-3.0-tts-plus', voiceId: 'longanlingxin' });
    expect(budget.naturalSpeed).toBe(1);
    expect(budget.enforcement).toBe('reference-only');
  });
});
