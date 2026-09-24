import { describe, expect, it } from 'vitest';
import { normalizeQuizQuestions, selectQuizFormats } from './quality';

describe('quiz quality normalization', () => {
  it('normalizes a true-false alias into a renderable single choice', () => {
    const result = normalizeQuizQuestions([{ type: 'judgment', question: '文本分类只能处理英文。', answer: false, analysis: '文本分类可以处理多种语言，关键在于数据和处理方法。' }]);
    expect(result.questions[0]).toMatchObject({ type: 'single', format: 'true_false', answer: ['false'] });
    expect(result.questions[0]?.options).toHaveLength(2);
  });

  it('normalizes matching pairs into a locally gradable drag response', () => {
    const result = normalizeQuizQuestions([{
      type: 'matching',
      question: '关联数据角色与用途',
      pairs: [
        { left: '训练集', right: '学习参数' },
        { left: '测试集', right: '独立评估' },
      ],
    }]);
    expect(result.questions[0]).toMatchObject({
      type: 'matching',
      format: 'matching',
      hasAnswer: true,
      answer: ['L1:R1', 'L2:R2'],
    });
    expect(result.questions[0]?.matchingPairs).toHaveLength(2);
    expect(result.issues).toEqual([]);
  });

  it('repairs an incomplete matching item as a one-line fill blank instead of an essay', () => {
    const result = normalizeQuizQuestions([{ type: 'matching', question: '关联概念与例子', pairs: [{ left: '分类', right: '垃圾邮件识别' }] }]);
    expect(result.questions[0]).toMatchObject({ type: 'short_answer', format: 'fill_blank', hasAnswer: false });
    expect(result.questions[0]?.question).toContain('最关键的一组对应关系');
  });

  it('repairs malformed choice questions instead of storing an ungradable choice', () => {
    const result = normalizeQuizQuestions([{ type: 'single', question: '哪个描述正确？', options: ['A', 'B'] }]);
    expect(result.questions[0]).toMatchObject({ type: 'short_answer', format: 'fill_blank' });
    expect(result.questions[0]?.question).toContain('只填写关键概念');
    expect(result.questions[0]?.commentPrompt).toBeTruthy();
  });

  it('adds analysis and maps label answers to stable option values', () => {
    const result = normalizeQuizQuestions([{ type: 'single', question: '选择生活中的文本分类例子', options: ['垃圾邮件识别', '调节屏幕亮度'], correctAnswer: '垃圾邮件识别' }]);
    expect(result.questions[0]?.answer).toEqual(['A']);
    expect(result.questions[0]?.analysis?.length).toBeGreaterThan(12);
  });

  it('flags ambiguous choice keys and invalid true-false answers', () => {
    const result = normalizeQuizQuestions([
      { type: 'single', question: '哪项正确？', options: [{ value: 'A', label: '甲' }, { value: 'A', label: '乙' }], answer: ['A', 'B'] },
      { type: 'true_false', format: 'true_false', question: '该说法正确。', answer: '不确定' },
    ]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('choice options must have unique values and labels'),
      expect.stringContaining('true_false must provide one explicit boolean answer'),
    ]));
  });

  it('preserves valid knowledge-point attribution without synthesizing missing labels', () => {
    const result = normalizeQuizQuestions([
      { id: 'q1', type: 'single', question: '题目一', options: ['A', 'B'], answer: 'A', knowledgePointIds: ['kp-1', 'outside'] },
      { id: 'q2', type: 'single', question: '题目二', options: ['A', 'B'], answer: 'A' },
    ], {
      allowedKnowledgePointIds: ['kp-1', 'kp-2'],
    });

    expect(result.questions[0]?.knowledgePointIds).toEqual(['kp-1']);
    expect(result.questions[1]?.knowledgePointIds).toEqual([]);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.stringContaining('outside the allowed section: outside'),
      expect.stringContaining('missing explicit knowledgePointIds'),
    ]));
  });

  it('flags a fill-blank label that does not contain an actual blank', () => {
    const result = normalizeQuizQuestions([{
      id: 'q1',
      type: 'fill_blank',
      format: 'fill_blank',
      question: '解释训练集与测试集的区别。',
      knowledgePointIds: ['kp-role'],
    }], { allowedKnowledgePointIds: ['kp-role'] });
    expect(result.questions[0]?.format).toBe('fill_blank');
    expect(result.issues).toContain('question 1: fill_blank stem has no explicit blank slot');
  });

  it('accepts a concise fill blank with an explicit slot', () => {
    const result = normalizeQuizQuestions([{
      id: 'q1',
      type: 'fill_blank',
      format: 'fill_blank',
      question: '测试集用于____模型在新数据上的表现。',
      knowledgePointIds: ['kp-role'],
    }], { allowedKnowledgePointIds: ['kp-role'] });
    expect(result.issues).toEqual([]);
  });

  it('preserves explicit teaching-unit attribution through later quality passes', () => {
    const result = normalizeQuizQuestions([{
      id: 'q1',
      type: 'judgment',
      question: '测试集可以反复用于调参。',
      answer: false,
      knowledgePointIds: ['kp-test'],
      teachingUnitIds: ['unit-isolation', 'unit-leakage'],
    }]);

    expect(result.questions[0]?.teachingUnitIds).toEqual(['unit-isolation', 'unit-leakage']);
  });

  it('treats requested assessment forms as a strict allowlist', () => {
    expect(selectQuizFormats({
      objectiveText: '比较两种分类结果并应用到校园情境', difficulty: 'medium', questionCount: 3, requested: ['single'],
    })).toEqual(['single']);
    expect(selectQuizFormats({
      objectiveText: '比较两种分类结果并应用到校园情境', difficulty: 'medium', questionCount: 3,
    })).toEqual(['multiple', 'scenario_task']);
    expect(selectQuizFormats({
      objectiveText: '匹配术语与对应含义', difficulty: 'easy', questionCount: 2, requested: ['single', 'matching'],
    })).toEqual(['single', 'matching']);
    expect(selectQuizFormats({
      objectiveText: '匹配术语与对应含义', difficulty: 'easy', questionCount: 2,
    })).toEqual(['single', 'true_false']);
  });
});
