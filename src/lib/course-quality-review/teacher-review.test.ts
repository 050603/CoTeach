import { describe, expect, it } from 'vitest';
import type { CourseQualityIssue } from './types';
import { reviewableIssues, unresolvedHardIssues } from './teacher-review';

const issue = (blocking: boolean): CourseQualityIssue => ({
  id: blocking ? 'blocking' : 'advisory',
  origin: 'structure',
  severity: 'error',
  blocking,
  title: '页面结构问题',
  evidence: '存在确定的结构问题。',
  suggestion: '检查并修正。',
});

describe('teacher review issue semantics', () => {
  it('uses the explicit blocking flag as the publication authority', () => {
    expect(unresolvedHardIssues([issue(false), issue(true)])).toEqual([issue(true)]);
    expect(reviewableIssues([issue(false), issue(true)])).toEqual([issue(false)]);
  });
});
