import { describe, expect, it } from 'vitest';
import type { QuizScoringRubric } from '@openmaic/dsl';
import { parseStructuredGrade, rubricCriterionPoints, structuredGradePrompt, validScoringRubric } from './rubric';

const rubric: QuizScoringRubric = { version: 1, criteria: [
  { id: 'conclusion', description: '判断结论', weight: 40, fullCredit: '结论正确', noCredit: '结论错误' },
  { id: 'reason', description: '必要依据', weight: 60, fullCredit: '依据完整', partialCredit: '依据部分正确', noCredit: '依据错误或缺失' },
] };
const answer = '结论是同化，因为使用旧框架理解新现象。';
const rows = [
  { id: 'conclusion', level: 'full', evidence: '同化', reason: '判断准确' },
  { id: 'reason', level: 'partial', evidence: '旧框架', reason: '已有正确依据，必要条件不完整' },
];
describe('criterion-based subjective grading', () => {
  it('keeps criterion subpoints and reported totals consistent', () => {
    const three: QuizScoringRubric = { version: 1, criteria: [34, 33, 33].map((weight, index) => ({
      id: `c${index}`, description: `要点${index}`, weight, fullCredit: '正确', noCredit: '错误',
    })) };
    expect(rubricCriterionPoints(0.05, three)).toEqual([0.02, 0.02, 0.01]);
    const grade = parseStructuredGrade(JSON.stringify({ criteria: three.criteria.map((criterion) => ({
      id: criterion.id, level: 'full', evidence: '正确', reason: '要点正确',
    })) }), 0.05, three, '正确');
    expect(grade.score).toBe(0.05);
  });
  it('calculates the score from criterion weights, ignoring a model-invented total', () => {
    const grade = parseStructuredGrade(JSON.stringify({ score: 999, criteria: rows }), 5, rubric, answer);
    expect(grade.score).toBe(3.5);
    expect(grade.comment).toContain('判断结论：2/2分');
    expect(grade.comment).toContain('必要依据：1.5/3分');
  });
  it('rejects nonexistent answer evidence, missing criteria, and unsupported partial credit', () => {
    for (const criteria of [[rows[0]], [rows[0], rows[0]], [{ ...rows[0], level: 'partial' }, rows[1]],
      [rows[0], { ...rows[1], evidence: '学生没有写的理由' }]]) {
      expect(() => parseStructuredGrade(JSON.stringify({ criteria }), 5, rubric, answer)).toThrow();
    }
  });
  it('requires valid weights and concrete criteria and accepts zero credit', () => {
    expect(validScoringRubric({ version: 1, criteria: [null] })).toBe(false);
    expect(validScoringRubric({ ...rubric, criteria: [{ ...rubric.criteria[0], weight: 20 }] })).toBe(false);
    expect(parseStructuredGrade(JSON.stringify({ criteria: rows.map((row) => ({ ...row, level: 'none', evidence: '' })) }), 5, rubric, answer).score).toBe(0);
  });
  it('constrains assessment to actual content and equivalent wording', () => {
    const prompt = structuredGradePrompt({ question: '概念____', answer, points: 5, rubric });
    expect(prompt.system).toContain('不得自行给总分');
    expect(prompt.system).toContain('不额外要求题目未要求的解释');
    expect(prompt.prompt).toContain(answer);
  });
});
