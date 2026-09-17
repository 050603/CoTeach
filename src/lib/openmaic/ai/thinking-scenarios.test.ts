import { describe, expect, it } from 'vitest';

import {
  getThinkingScenarioForStage,
  resolveScenarioThinkingConfig,
} from './thinking-scenarios';

describe('teacher thinking scenarios', () => {
  it('groups technical stages into teacher-facing application scenarios', () => {
    expect(getThinkingScenarioForStage('scene-content:quiz')).toBe('content-generation');
    expect(getThinkingScenarioForStage('pbl-v2-runtime:evaluate')).toBe('learning-assessment');
    expect(getThinkingScenarioForStage('pbl-v2-runtime:simulator')).toBe(
      'classroom-interaction',
    );
    expect(getThinkingScenarioForStage('web-search-query-rewrite')).toBe(
      'search-understanding',
    );
  });

  it('keeps baseline undefined and only resolves explicit overrides', () => {
    expect(resolveScenarioThinkingConfig({}, 'scene-content')).toBeUndefined();
    expect(
      resolveScenarioThinkingConfig(
        { 'content-generation': 'baseline', 'learning-assessment': 'none' },
        'scene-content',
      ),
    ).toBeUndefined();
    expect(
      resolveScenarioThinkingConfig(
        { 'content-generation': 'max', 'learning-assessment': 'none' },
        'scene-content:slide',
      ),
    ).toEqual({ mode: 'enabled', enabled: true, effort: 'max' });
    expect(
      resolveScenarioThinkingConfig(
        { 'learning-assessment': 'none' },
        'quiz-grade',
      ),
    ).toEqual({ mode: 'disabled', enabled: false, effort: 'none' });
  });
});
