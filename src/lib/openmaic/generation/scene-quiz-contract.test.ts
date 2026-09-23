import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  generateSceneContent,
  objectiveQuestionRequiresWrittenExplanation,
} from './scene-generator';

const outline: SceneOutline = {
  id: 'section-check',
  type: 'quiz',
  title: '第一节 · 节末小测',
  description: '检查学生能否解释抽样偏差',
  keyPoints: ['随机抽样减少选择偏差'],
  knowledgePointIds: ['kp-sampling'],
  assessmentUnitIds: ['unit-sampling'],
  assessmentUnitMap: [{ unitId: 'unit-sampling', knowledgePointIds: ['kp-sampling'] }],
  order: 1,
  quizConfig: {
    difficulty: 'medium',
    questionCount: 1,
    questionTypes: ['short_answer'],
    minShortAnswerQuestions: 1,
    maxShortAnswerQuestions: 1,
    coveragePolicy: 'section-synthesis',
  },
};

describe('section short-answer quiz contract', () => {
  it('distinguishes a selection stem about reasons from an added written response', () => {
    expect(objectiveQuestionRequiresWrittenExplanation(
      '请从下列选项中选择最能说明这种现象原因的一项。',
    )).toBe(false);
    expect(objectiveQuestionRequiresWrittenExplanation(
      'Which option best explains why the observation changed?',
    )).toBe(false);
    expect(objectiveQuestionRequiresWrittenExplanation(
      '请选择一项，并简要说明你的理由。',
    )).toBe(true);
    expect(objectiveQuestionRequiresWrittenExplanation(
      'Choose one option and justify your answer.',
    )).toBe(true);
  });

  it('accepts an objective item whose selected option explains a reason', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['single'], questionTypePlan: ['single'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'single', format: 'single_choice',
      question: '请从下列选项中选择最能说明抽样偏差产生原因的一项。',
      options: [
        { label: '样本选择依赖了研究者的便利条件', value: 'A' },
        { label: '总体中的每个成员都有随机入样机会', value: 'B' },
      ],
      answer: ['A'], analysis: 'A 使入样机会取决于便利条件。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions[0]?.format).toBe('single_choice');
    expect(ai.mock.calls[0][1]).toContain('responseMode is selection_only');
    expect(ai.mock.calls[0][1]).toContain('put complete candidate responses with their reasoning in the options');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('adapts a planned true-false item with an open assessment verb to selection-only evidence', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      keyPoints: ['能写出一个开放问题并分解为可探究的子问题'],
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['true_false'], questionTypePlan: ['true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'single', format: 'true_false',
      question: '“怎样让校园垃圾分类更准确”没有固定答案，并可拆成资料调查与对照实验两个子问题，因此是可探究的开放问题。',
      answer: true, analysis: '该候选问题同时满足开放性与可分解性。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions[0]?.format).toBe('true_false');
    expect(ai.mock.calls[0][1]).toContain('Present one complete candidate conclusion as the proposition');
    expect(ai.mock.calls[0][1]).toContain('The learner only marks true or false');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('rejects an objective item that truly adds a written explanation', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 1,
        questionTypes: ['single'], questionTypePlan: ['single'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1', type: 'single', format: 'single_choice',
      question: '请选择能减少抽样偏差的一项，并简要说明你的理由。',
      options: [
        { label: '随机抽取不同年级的学号', value: 'A' },
        { label: '只询问最先离场的学生', value: 'B' },
      ],
      answer: ['A'], analysis: 'A 减少人为选择。',
      knowledgePointIds: ['kp-sampling'], points: 10,
    }]));

    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow(
      'choice or true/false item that also requires a written explanation',
    );
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('prompts for short answers only and repairs a provider type violation', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{
      id: 'q1',
      type: 'single',
      question: '哪一种方法能减少选择偏差？',
      options: [{ label: '随机抽样', value: 'A' }, { label: '方便抽样', value: 'B' }],
      answer: ['A'],
      analysis: '随机抽样使总体成员有公平的入样机会。',
      knowledgePointIds: ['kp-sampling'],
      points: 10,
    }]));

    const result = await generateSceneContent(outline, ai);
    expect(ai.mock.calls[0][1]).toContain('every generated question must use type="short_answer"');
    expect(ai.mock.calls[0][1]).toContain('single comprehensive short-answer question');
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(1);
    expect(result && 'questions' in result ? result.questions.every((question) =>
      question.type === 'short_answer' && !question.options && !question.answer && question.hasAnswer === false,
    ) : false).toBe(true);
    expect(result && 'questions' in result ? result.questions[0]?.knowledgePointIds : []).toEqual(['kp-sampling']);
    expect(result && 'questions' in result ? result.questions[0]?.teachingUnitIds : []).toEqual(['unit-sampling']);
  });

  it('rejects an open response in normal mode without a second model call', async () => {
    const adaptive = {
      ...outline,
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'fill_blank' as const, 'matching' as const],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'short_answer', format: 'short_answer', question: '解释随机抽样。', analysis: '公平入样。',
        knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q2', type: 'single', question: '哪项属于随机抽样？',
        options: [{ label: '随机抽取学号', value: 'A' }, { label: '只问前排', value: 'B' }],
        answer: ['A'], analysis: '随机抽取学号让成员有公平机会。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      ]));
    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow('returned 1 open-response questions; maximum is 0');
    expect(ai.mock.calls[0][1]).toContain('use at least 0 and at most 0');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('requires the complete normal-mode question set to cover every section knowledge point', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      quizConfig: {
        difficulty: 'medium' as const,
        questionCount: 2,
        questionTypes: ['single' as const, 'true_false' as const, 'fill_blank' as const, 'matching' as const],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis' as const,
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'single', question: '哪一组数据用于学习参数？', options: [{ label: '训练集', value: 'A' }, { label: '测试集', value: 'B' }], answer: ['A'], analysis: '训练集用于学习参数。', knowledgePointIds: ['kp-role'], points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试数据参与调参会造成数据泄漏。', answer: true, analysis: '独立测试信息不能进入调参。', knowledgePointIds: ['kp-leak'], points: 10 },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('cover every allowed knowledgePointId at least once');
    expect(new Set(questions.flatMap((question) => question.knowledgePointIds ?? []))).toEqual(new Set(['kp-role', 'kp-leak']));
    expect(questions.filter((question) => question.format === 'short_answer' || question.format === 'scenario_task')).toHaveLength(0);
  });

  it('follows the compiled ordered question plan instead of treating fill-blank as an optional format', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      keyPoints: [
        '第 1 题综合考查：识别训练数据的职责',
        '第 2 题综合考查：填空补全独立测试的作用',
      ],
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'fill_blank'],
        questionTypePlan: ['single', 'fill_blank'],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q1', type: 'single', question: '哪一组数据用于学习参数？',
        options: [{ label: '训练集', value: 'A' }, { label: '测试集', value: 'B' }],
        answer: ['A'], analysis: '训练集用于学习参数。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q2', type: 'fill_blank', format: 'fill_blank', question: '测试集用于____模型在新数据上的表现。',
        analysis: '应填独立检验。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('question 1 must use type="single"; question 2 must use type="fill_blank"');
    expect(ai.mock.calls[0][1]).toContain('Each numbered Test Point maps to the same-numbered question');
    expect(questions.map((question) => question.format)).toEqual(['single_choice', 'fill_blank']);
  });

  it('rejects a provider response that replaces a compiled fill-blank question with another format', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      keyPoints: ['第 1 题综合考查：识别职责', '第 2 题综合考查：填空补全作用'],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'fill_blank'],
        questionTypePlan: ['single', 'fill_blank'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'single', question: '训练集用于什么？', options: [{ label: '学习参数', value: 'A' }, { label: '最终评分', value: 'B' }], answer: ['A'], analysis: '学习参数。', knowledgePointIds: ['kp-sampling'], points: 10 },
      { id: 'q2', type: 'single', question: '测试集用于什么？', options: [{ label: '独立检验', value: 'A' }, { label: '反复调参', value: 'B' }], answer: ['A'], analysis: '独立检验。', knowledgePointIds: ['kp-sampling'], points: 10 },
    ]));

    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow(
      'returned question formats single_choice, single_choice; expected exact plan single_choice, fill_blank',
    );
  });

  it('rejects a pseudo fill blank without making a correction call', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['fill_blank', 'single'],
        questionTypePlan: ['fill_blank', 'single'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
        { id: 'q1', type: 'fill_blank', format: 'fill_blank', question: '解释随机抽样为什么公平。', analysis: '公平入样。', knowledgePointIds: ['kp-sampling'], points: 10 },
        { id: 'q2', type: 'single', question: '哪项属于随机抽样？', options: [{ label: '随机抽取学号', value: 'A' }, { label: '只问前排', value: 'B' }], answer: ['A'], analysis: '公平入样。', knowledgePointIds: ['kp-sampling'], points: 10 },
      ]));

    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow('fill_blank stem has no explicit blank slot');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('rejects missing attribution without making a correction call', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'true_false'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const first = [
      { id: 'q1', type: 'single', question: '哪项正确？', options: [{ label: '训练数据学习参数', value: 'A' }, { label: '测试数据学习参数', value: 'B' }], answer: ['A'], analysis: '训练集用于学习参数。', points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试集用于独立评估。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(first));

    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow('missing explicit knowledgePointIds');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('rejects an incomplete quiz result so the affected page can be retried', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([]));
    await expect(generateSceneContent(outline, ai)).rejects.toThrow('returned 0/1 questions');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('rejects a normal-mode result that leaves a section knowledge point untested', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      quizConfig: {
        difficulty: 'medium', questionCount: 2,
        questionTypes: ['single', 'true_false', 'fill_blank', 'matching'],
        minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { id: 'q1', type: 'true_false', format: 'true_false', question: '训练集用于学习参数。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
      { id: 'q2', type: 'true_false', format: 'true_false', question: '测试集用于独立评估。', answer: true, analysis: '正确。', knowledgePointIds: ['kp-role'], points: 10 },
    ]));

    await expect(generateSceneContent(adaptive, ai)).rejects.toThrow('does not cover knowledge points: kp-leak');
  });

  it('covers each adaptive teaching-unit target once and keeps matching objective', async () => {
    const adaptive: SceneOutline = {
      ...outline,
      knowledgePointIds: ['kp-role', 'kp-leak'],
      assessmentUnitIds: ['unit-role', 'unit-leak'],
      assessmentUnitMap: [
        { unitId: 'unit-role', knowledgePointIds: ['kp-role'] },
        { unitId: 'unit-leak', knowledgePointIds: ['kp-leak'] },
      ],
      assessmentTargets: [
        { unitId: 'unit-role', knowledgePointId: 'kp-role', unitTitle: '数据角色', learningOutcome: '区分训练与测试' },
        { unitId: 'unit-leak', knowledgePointId: 'kp-leak', unitTitle: '数据泄漏', learningOutcome: '识别泄漏' },
      ],
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'matching', 'true_false'],
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'each-target',
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      {
        id: 'q-leak', type: 'single', format: 'true_false', question: '测试数据参与调参会造成泄漏。',
        answer: true, analysis: '测试信息进入训练会高估泛化效果。',
        teachingUnitIds: ['unit-leak'], knowledgePointIds: ['kp-leak'], points: 10,
      },
      {
        id: 'q-role', type: 'matching', format: 'matching', question: '匹配数据角色与用途。',
        pairs: [
          { left: '训练集', right: '学习参数' },
          { left: '测试集', right: '独立评估' },
        ],
        analysis: '两个集合承担不同职责。',
        teachingUnitIds: ['unit-role'], knowledgePointIds: ['kp-role'], points: 10,
      },
    ]));

    const result = await generateSceneContent(adaptive, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(ai.mock.calls[0][1]).toContain('generate one question for each ordered assessment target');
    expect(questions.map((question) => [question.teachingUnitIds, question.knowledgePointIds])).toEqual([
      [['unit-role'], ['kp-role']],
      [['unit-leak'], ['kp-leak']],
    ]);
    expect(questions[0]).toMatchObject({ id: 'q-role', type: 'matching', format: 'matching' });
  });

  it('rejects deterministic quality failures after the single generation call', async () => {
    const qualityOutline: SceneOutline = {
      ...outline,
      quizConfig: {
        difficulty: 'medium',
        questionCount: 2,
        questionTypes: ['single', 'multiple'],
        minShortAnswerQuestions: 0,
        maxShortAnswerQuestions: 0,
        coveragePolicy: 'section-synthesis',
      },
    };
    const invalid = [
      {
        id: 'q1', type: 'single', format: 'single_choice', question: '哪种抽样更合理？',
        options: [{ label: '随机抽样', value: 'A' }, { label: ' 随机抽样 ', value: 'B' }],
        answer: ['A'], analysis: ' ', knowledgePointIds: ['kp-sampling'], points: 10,
      },
      {
        id: 'q1', type: 'multiple', format: 'multiple_choice', question: '哪些做法正确？',
        options: [{ label: '随机抽取', value: 'A' }, { label: '分层抽取', value: 'B' }],
        answer: ['A', 'B'], analysis: '两种做法都正确。', knowledgePointIds: ['kp-sampling'], points: 10,
      },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(invalid));

    await expect(generateSceneContent(qualityOutline, ai)).rejects.toThrow('duplicate question id "q1"');
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('There is no later model review or rewrite');
    expect(ai.mock.calls[0][0]).toContain('private design card');
    expect(ai.mock.calls[0][0]).toContain('about one third longer than the shortest');
    expect(ai.mock.calls[0][0]).toContain('Do not make a distractor wrong merely by inserting');
  });

  it('does not retry when analysis is empty', async () => {
    const missingAnalysis = JSON.stringify([{
      id: 'q1', type: 'short_answer', format: 'short_answer', question: '解释随机抽样如何减少选择偏差。',
      analysis: ' ', knowledgePointIds: ['kp-sampling'], points: 10,
    }]);
    const ai = vi.fn().mockResolvedValue(missingAnalysis);

    await expect(generateSceneContent(outline, ai)).rejects.toThrow(
      'failed deterministic quality checks: question 1 has empty analysis',
    );
    expect(ai).toHaveBeenCalledTimes(1);
  });
});
