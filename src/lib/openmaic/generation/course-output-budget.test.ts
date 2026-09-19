import { describe, expect, it } from 'vitest';
import { calculateCourseExecutionDurationMs, createCourseOutputBudget, resolveCourseExecutionBudgetOptions } from './course-output-budget';

describe('course request output budgets', () => {
  it('allocates a single slide independently of a very large model capacity', () => {
    const budget = createCourseOutputBudget({ resource: 'slide', modelOutputWindow: 393_216 });
    expect(budget('Return slide DSL.', 'Explain a concept.')).toBeGreaterThan(32_768);
    expect(budget('Return slide DSL.', 'Explain a concept.')).toBeLessThan(65_536);
  });

  it('grows with actual multilingual input and executable resource size', () => {
    const slide = createCourseOutputBudget({ resource: 'slide', thinking: { mode: 'disabled' } });
    const widget = createCourseOutputBudget({ resource: 'interactive', thinking: { mode: 'disabled' } });
    expect(slide('schema', '中文课程材料'.repeat(2000))).toBeGreaterThan(slide('schema', '概念'));
    expect(widget('schema', '概念')).toBeGreaterThan(slide('schema', '概念'));
    expect(slide('schema'.repeat(4000), '概念')).toBeGreaterThan(slide('schema', '概念'));
  });

  it('reserves reasoning space for unknown provider defaults, but not explicit off', () => {
    const defaults = createCourseOutputBudget({ resource: 'narration' });
    const off = createCourseOutputBudget({ resource: 'narration', thinking: { mode: 'disabled' } });
    const legacyOff = createCourseOutputBudget({ resource: 'narration', thinking: { enabled: false } });
    expect(defaults('', '') - off('', '')).toBe(16_384);
    expect(legacyOff('', '')).toBe(off('', ''));
  });

  it('preserves an explicit reasoning allowance without modifying its configuration', () => {
    const thinking = { mode: 'enabled' as const, budgetTokens: 40_000 };
    const budget = createCourseOutputBudget({ resource: 'slide', thinking });
    const off = createCourseOutputBudget({ resource: 'slide', thinking: { mode: 'disabled' } });
    expect(budget('', '') - off('', '')).toBeGreaterThanOrEqual(39_000);
    expect(thinking).toEqual({ mode: 'enabled', budgetTokens: 40_000 });
  });

  it('respects finite model capacity and handles unknown capacity and dynamic thinking', () => {
    expect(createCourseOutputBudget({ resource: 'slide', modelOutputWindow: 12_000 })('', '')).toBe(12_000);
    for (const modelOutputWindow of [undefined, NaN, Infinity, 0, -1]) {
      const budget = createCourseOutputBudget({
        resource: 'slide', modelOutputWindow, thinking: { mode: 'enabled', budgetTokens: -1 },
      })('', '');
      expect(Number.isFinite(budget)).toBe(true);
      expect(budget).toBeGreaterThan(32_768);
    }
  });
});

describe('course execution work estimates', () => {
  it('preserves teacher-selected depth and reserves more work for higher effort', () => {
    const low = createCourseOutputBudget({ resource: 'slide', thinking: { effort: 'low' } })('', '');
    const high = createCourseOutputBudget({ resource: 'slide', thinking: { effort: 'high' } })('', '');
    const max = createCourseOutputBudget({ resource: 'slide', thinking: { effort: 'max' } })('', '');
    expect(high).toBeGreaterThan(low);
    expect(max).toBeGreaterThan(high);
    expect(createCourseOutputBudget({ resource: 'slide', thinking: { level: 'high' } })('', '')).toBe(high);
    expect(createCourseOutputBudget({ resource: 'slide', thinking: { effort: 'high', budgetTokens: 8000 } })('', ''))
      .toBe(createCourseOutputBudget({ resource: 'slide', thinking: { effort: 'low', budgetTokens: 8000 } })('', ''));
    const policy = resolveCourseExecutionBudgetOptions({});
    expect(calculateCourseExecutionDurationMs(high, 180000, policy))
      .toBeGreaterThan(calculateCourseExecutionDurationMs(low, 180000, policy));
  });

  it('calculates per-request deadlines and independently honors the operator ceiling', () => {
    const policy = { minTokensPerSecond: 20, startupAllowanceMs: 120000, maxDurationMs: 7200000 };
    expect(calculateCourseExecutionDurationMs(10000, 180000, policy)).toBe(620000);
    expect(calculateCourseExecutionDurationMs(100000, 180000, policy)).toBe(5120000);
    expect(calculateCourseExecutionDurationMs(200000, 180000, policy)).toBe(7200000);
    expect(calculateCourseExecutionDurationMs(200000, 180000, { ...policy, maxDurationMs: 100000 })).toBe(100000);
    expect(calculateCourseExecutionDurationMs(undefined, 180000, policy)).toBe(180000);
  });

  it('supports calibrated throughput and preserves existing explicit stream ceiling configuration', () => {
    const policy = resolveCourseExecutionBudgetOptions({
      OPENPBL_COURSE_MIN_TOKENS_PER_SECOND: '12',
      OPENPBL_COURSE_STARTUP_ALLOWANCE_MS: '60000',
      OPENPBL_LLM_STREAM_MAX_DURATION_MS: '900000',
    });
    expect(policy).toEqual({ minTokensPerSecond: 12, startupAllowanceMs: 60000, maxDurationMs: 900000 });
    expect(resolveCourseExecutionBudgetOptions({ OPENPBL_COURSE_MIN_TOKENS_PER_SECOND: '-1' }).minTokensPerSecond).toBe(20);
    expect(() => calculateCourseExecutionDurationMs(1000, 1000, { ...policy, minTokensPerSecond: 0 })).toThrow('Invalid');
  });
});
