import { describe, expect, it } from 'vitest';
import { validateQuizQuestionDrafts } from './authoring-evidence';

const evidence = (id: string, observableResponse = '选择使每位成员都有入样机会的做法') => [
  { knowledgePointId: id, observableResponse },
];
const choice = (id = 'kp-sampling') => ({
  id: 'q1', type: 'single', question: '哪种抽样做法可减少选择偏差？',
  knowledgePointIds: [id], assessmentEvidence: evidence(id),
  options: [{ value: 'A', label: '按学号随机抽取学生' }, { value: 'B', label: '只询问最先离场的学生' }],
  answer: ['A'],
  optionReasoning: [
    { value: 'A', correct: true, reason: '入样机会不依赖学生是否方便接触' },
    { value: 'B', correct: false, reason: '把离场时间误当作随机抽样依据' },
  ],
  analysis: '按学号随机抽取减少人为选择；只问先离场学生会产生选择偏差。',
});

describe('quiz authoring evidence', () => {
  it('accepts one question with evidence for several knowledge points', () => {
    const item = choice();
    item.knowledgePointIds = ['kp-sampling', 'kp-bias'];
    item.assessmentEvidence = [
      ...evidence('kp-sampling'),
      ...evidence('kp-bias', '排除仅询问先离场学生的选择偏差'),
    ];
    expect(validateQuizQuestionDrafts([item], ['kp-sampling', 'kp-bias'])).toEqual([]);
  });

  it('rejects missing, extra, and empty evidence instead of trusting attached IDs', () => {
    const item = choice();
    item.assessmentEvidence = evidence('kp-outside');
    expect(validateQuizQuestionDrafts([item], ['kp-sampling', 'kp-bias']).join(' '))
      .toContain('assessmentEvidence');
    expect(validateQuizQuestionDrafts([item], ['kp-sampling', 'kp-bias']).join(' '))
      .toContain('kp-bias');
    item.assessmentEvidence = evidence('kp-sampling', '');
    expect(validateQuizQuestionDrafts([item], ['kp-sampling']).join(' '))
      .toContain('observable response');
  });

  it('rejects ambiguous answer keys and misleading option rationale', () => {
    const item = choice();
    item.answer = ['A', 'B'];
    expect(validateQuizQuestionDrafts([item], ['kp-sampling']).join(' ')).toContain('invalid choice answer');
    item.answer = ['A'];
    item.optionReasoning[1]!.correct = true;
    expect(validateQuizQuestionDrafts([item], ['kp-sampling']).join(' ')).toContain('optionReasoning');
    item.options[1]!.label = item.options[0]!.label;
    expect(validateQuizQuestionDrafts([item], ['kp-sampling']).join(' ')).toContain('distinct');
  });

  it('requires a specific reference and rubric for a text response', () => {
    const item = {
      type: 'fill_blank', question: '测试集用于____模型在新数据上的表现。',
      knowledgePointIds: ['kp-test'], assessmentEvidence: evidence('kp-test', '填写独立检验'),
      analysis: '测试集在模型确定后用于独立检验。', referenceAnswer: '独立检验',
      commentPrompt: '独立检验或语义等价短语得满分。',
    };
    expect(validateQuizQuestionDrafts([item], ['kp-test'])).toEqual([]);
    expect(validateQuizQuestionDrafts([{ ...item, question: '解释测试集用途。', referenceAnswer: '' }], ['kp-test']).join(' '))
      .toContain('referenceAnswer');
  });

  it('rejects matching pairs that normalization would silently deduplicate', () => {
    const item = {
      type: 'matching', question: '将方法与用途配对。',
      knowledgePointIds: ['kp-sampling'], assessmentEvidence: evidence('kp-sampling'),
      analysis: '两个方法各有不同的入样机会和偏差来源。',
      pairs: [{ left: '随机学号', right: '公平入样' }, { left: '随机学号', right: '便利入样' }],
    };
    expect(validateQuizQuestionDrafts([item], ['kp-sampling']).join(' ')).toContain('matching pairs must be complete and distinct');
  });
});
