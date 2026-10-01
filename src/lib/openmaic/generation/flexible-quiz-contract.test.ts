import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { generateSceneContent } from './scene-generator';

const outline: SceneOutline = {
  id: 'check', type: 'quiz', title: '节末检测', description: '检查抽样方法',
  keyPoints: ['辨认随机抽样', '解释选择偏差'], knowledgePointIds: ['kp-sampling'], order: 1,
  quizConfig: {
    questionCount: 3, questionCountRange: { min: 2, max: 4 }, qualityContract: 'grounded-v1',
    difficulty: 'medium', questionTypes: ['single', 'multiple', 'true_false', 'matching', 'fill_blank'],
    coveragePolicy: 'section-synthesis', minShortAnswerQuestions: 0, maxShortAnswerQuestions: 0,
  },
};

const single = (id: string) => ({
  id, type: 'single', format: 'single_choice', question: '哪种做法能减少抽样偏差？',
  knowledgePointIds: ['kp-sampling'],
  assessmentEvidence: [{ knowledgePointId: 'kp-sampling', observableResponse: '选出不依赖便利条件的抽样方法' }],
  options: [{ value: 'A', label: '按学号随机抽取学生' }, { value: 'B', label: '只问最先离场的学生' }],
  answer: ['A'],
  optionReasoning: [
    { value: 'A', correct: true, reason: '随机入样减少便利选择偏差' },
    { value: 'B', correct: false, reason: '离场先后被误当作随机抽样' },
  ],
  analysis: '随机学号使不同学生都有入样机会；只问先离场者会引入便利选择偏差。', points: 10,
});
const text = (id: string) => ({
  id, type: 'short_answer', format: 'short_answer', question: '解释只询问先离场学生为何会有选择偏差。',
  knowledgePointIds: ['kp-sampling'],
  assessmentEvidence: [{ knowledgePointId: 'kp-sampling', observableResponse: '指出先离场者不能代表全校并说明依据' }],
  referenceAnswer: '先离场者的入样机会更高，样本可能无法代表全校学生。',
  commentPrompt: '指出入样机会不等和代表性后果各占一半；接受语义等价表达。',
  analysis: '离场时间决定是否进入样本，使样本不能公平代表全校学生。', points: 10,
});

function expectAuthoredQuiz(result: Awaited<ReturnType<typeof generateSceneContent>>, authored: Array<{ question: string; analysis?: string }>) {
  const questions = result && 'questions' in result ? result.questions : [];
  expect(questions).toHaveLength(authored.length);
  expect(questions.map(({ question, analysis }) => ({ question, analysis })))
    .toEqual(authored.map(({ question, analysis }) => ({ question, analysis })));
}

describe('flexible section quiz generation', () => {
  it.each([2, 3, 4])('accepts %i same-format questions in one generation call', async (count) => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify(Array.from({ length: count }, (_, index) => single(`q${index + 1}`))));
    const result = await generateSceneContent(outline, ai);
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(count);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][1]).toContain('2–4');
    expect(ai.mock.calls[0][1]).not.toContain('Each numbered Test Point maps');
    expect(ai.mock.calls[0][0]).toContain('This ordinary section quiz can use only single, multiple, true_false, matching, and fill_blank');
    expect(ai.mock.calls[0][0]).not.toContain('### Short Answer');
    expect(ai.mock.calls[0][0]).not.toContain('scenario_task');
    expect(result && 'questions' in result ? result.questions[0] : {}).not.toHaveProperty('assessmentEvidence');
  });

  it('accepts mixed formats and keeps the reference answer in the grading rubric', async () => {
    const fill = {
      ...text('q2'), format: 'fill_blank', question: '只问先离场者属于____抽样。',
      referenceAnswer: '方便抽样', commentPrompt: '填写方便抽样或便利抽样得满分，接受等价词。',
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([single('q1'), fill]));
    const result = await generateSceneContent(outline, ai);
    const questions = result && 'questions' in result ? result.questions : [];
    expect(questions.map((question) => question.format)).toEqual(['single_choice', 'fill_blank']);
    expect(questions[1]?.commentPrompt).toContain('方便抽样');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it.each(['short_answer', 'scenario_task'] as const)('retains %s first-draft text responses for final teacher review', async (format) => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      single('q1'), { ...text('q2'), format },
    ]));
    expectAuthoredQuiz(await generateSceneContent(outline, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('supports multiple choice, matching, and fill blank in one ordinary quiz', async () => {
    const multiple = {
      ...single('q1'), type: 'multiple', format: 'multiple_choice',
      question: '哪些抽样方式能减少人为选择偏差？（多选）',
      options: [
        { value: 'A', label: '随机抽取学号' }, { value: 'B', label: '随机抽取座位号' },
        { value: 'C', label: '只问先离场的人' }, { value: 'D', label: '只问社团成员' },
      ],
      answer: ['A', 'B'],
      optionReasoning: [
        { value: 'A', correct: true, reason: '每个学号有随机入样机会' },
        { value: 'B', correct: true, reason: '每个座位有随机入样机会' },
        { value: 'C', correct: false, reason: '误把方便接触当成随机抽取' },
        { value: 'D', correct: false, reason: '误把社团成员当成总体' },
      ],
    };
    const matching = {
      id: 'q2', type: 'matching', format: 'matching', question: '将抽样方式与偏差来源配对。',
      knowledgePointIds: ['kp-sampling'],
      assessmentEvidence: [{ knowledgePointId: 'kp-sampling', observableResponse: '将两种抽样方式与对应的选择机制配对' }],
      pairs: [{ left: '随机学号', right: '每人有入样机会' }, { left: '只问先离场者', right: '便利性决定入样' }],
      analysis: '随机学号让全体有入样机会；只问先离场者受便利性影响。', points: 10,
    };
    const fill = {
      ...text('q3'), type: 'fill_blank', format: 'fill_blank', question: '只问先离场者属于____抽样。',
      referenceAnswer: '方便', commentPrompt: '填写方便抽样或便利抽样得满分，接受等价词。',
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([multiple, matching, fill]));
    const twoQuestionEstimate: SceneOutline = {
      ...outline, quizConfig: { ...outline.quizConfig!, questionCount: 2 },
    };
    const result = await generateSceneContent(twoQuestionEstimate, ai);
    expect(result && 'questions' in result ? result.questions.map((question) => question.format) : [])
      .toEqual(['multiple_choice', 'matching', 'fill_blank']);
    expect(ai).toHaveBeenCalledTimes(1);
    const prompt = ai.mock.calls[0]?.[1] as string;
    expect(prompt).toContain('Question Count: 2–4 (select the final count in this response)');
    expect(prompt).not.toContain('estimated 2');
  });

  it('honors an exact count confirmed by the teacher', async () => {
    const confirmed: SceneOutline = {
      ...outline, quizConfig: {
        ...outline.quizConfig!, questionCount: 3, questionCountRange: { min: 3, max: 3 },
      },
    };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([single('q1'), single('q2'), single('q3')]));
    const result = await generateSceneContent(confirmed, ai);
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(3);
    expect(ai.mock.calls[0]?.[1]).toContain('Question Count: 3');
  });

  it.each([1, 5])('retains all %i authored questions when the count differs from first-draft guidance', async (count) => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify(Array.from({ length: count }, (_, index) => single(`q${index + 1}`))));
    expectAuthoredQuiz(await generateSceneContent(outline, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains a first draft lacking internal evidence metadata without another call', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([{ ...single('q1'), assessmentEvidence: [] }, single('q2')]));
    expectAuthoredQuiz(await generateSceneContent(outline, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('keeps deep response at one substantive answer', async () => {
    const deep: SceneOutline = { ...outline, quizConfig: {
      ...outline.quizConfig!, questionCount: 1, questionCountRange: undefined,
      questionTypes: ['short_answer'], questionTypePlan: ['short_answer'],
      minShortAnswerQuestions: 1, maxShortAnswerQuestions: 1,
    } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([text('q1')]));
    const result = await generateSceneContent(deep, ai);
    expect(result && 'questions' in result ? result.questions : []).toHaveLength(1);
    expect(result && 'questions' in result ? result.questions[0]?.format : undefined).toBe('short_answer');
    expect(ai.mock.calls[0][0]).toContain('Deep-response Construction Contract');
    expect(ai.mock.calls[0][0]).not.toContain('### Fill Blank');
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains both authored questions without silently deleting one in deep-response mode', async () => {
    const deep: SceneOutline = { ...outline, quizConfig: {
      ...outline.quizConfig!, questionCount: 1, questionCountRange: undefined,
      questionTypes: ['short_answer'], questionTypePlan: ['short_answer'],
      minShortAnswerQuestions: 1, maxShortAnswerQuestions: 1,
    } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([text('q1'), text('q2')]));
    expectAuthoredQuiz(await generateSceneContent(deep, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('retains the authored fill blank without converting it into an essay', async () => {
    const deep: SceneOutline = { ...outline, quizConfig: {
      ...outline.quizConfig!, questionCount: 1, questionCountRange: undefined,
      questionTypes: ['short_answer'], questionTypePlan: ['short_answer'],
      minShortAnswerQuestions: 1, maxShortAnswerQuestions: 1,
    } };
    const fill = { ...text('q1'), format: 'fill_blank', question: '只问先离场者属于____抽样。',
      referenceAnswer: '方便抽样', commentPrompt: '填写方便抽样或便利抽样得满分，接受等价词。' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify([fill]));
    expectAuthoredQuiz(await generateSceneContent(deep, ai), JSON.parse(await ai.mock.results[0]!.value));
    expect(ai).toHaveBeenCalledTimes(1);
  });
});
