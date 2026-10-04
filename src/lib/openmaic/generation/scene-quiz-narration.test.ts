import { describe, expect, it, vi } from 'vitest';
import type { GeneratedQuizContent, SceneOutline } from '@openmaic/lib/types/generation';
import { addPageTimingPauses } from './activity-gate';
import { generateSceneActions, generateSceneContent } from './scene-generator';

const outline = {
  id: 'quiz', type: 'quiz', title: '第一节 · 节末小测', order: 2,
  description: '检验抽样偏差的判断依据', keyPoints: ['判断抽样偏差'],
  timingPlan: { studentActivitySec: 80, transitionSec: 3, targetUnits: 200, unit: 'cjk-char' },
} as SceneOutline;

const content = { questions: [{
  id: 'q1', type: 'single', question: '哪种方式减少选择偏差？',
  options: [{ value: 'A', label: '随机抽取' }, { value: 'B', label: '只问熟人' }],
  answer: ['A'], analysis: '随机抽取让总体成员获得入样机会。',
}] } as GeneratedQuizContent;

describe('three-phase quiz narration', () => {
  it('uses actual neighboring narration and question explanations in one authoring call', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { type: 'text', phase: 'intro', content: '刚才学习了入样机会。请独立作答。' },
      { type: 'text', phase: 'review-guidance', content: '解析显示后，对照检查判断依据，读完后确认理解。' },
      { type: 'text', phase: 'handoff', content: '入样的判断还要联系结果的解释。接下来进入实验设计。' },
    ]));

    const actions = await generateSceneActions(outline, content, ai, {
      quizNarrationContext: JSON.stringify({
        precedingSection: [{ actualNarration: ['抽样方式决定谁有机会进入样本。'] }],
        nextPage: { actualOpening: '实验设计首先要控制其他因素。' },
      }),
    });
    const timed = addPageTimingPauses(outline, actions);

    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('review-guidance');
    expect(ai.mock.calls[0][1]).toContain('随机抽取让总体成员获得入样机会');
    expect(ai.mock.calls[0][1]).toContain('实验设计首先要控制其他因素');
    expect(ai.mock.calls[0][1]).toContain('三段口播共用约 200');
    expect(ai.mock.calls[0][1]).toContain('不设段落比例或句数配额');
    expect(ai.mock.calls[0][1]).not.toContain('答题前约 40');
    expect(ai.mock.calls[0][1]).not.toContain('确认理解后约 120');
    expect(actions.map((action) => action.type === 'speech' ? action.quizNarrationPhase : undefined))
      .toEqual(['intro', 'review-guidance', 'handoff']);
    expect(timed.flatMap((action) => action.type === 'speech' && 'activityPausePurpose' in action
      ? [action.activityPausePurpose] : [])).toEqual(['quiz-submit', 'quiz']);
  });

  it('authors questions and phase narration together, then compiles gates without a second model request', async () => {
    const page = { ...outline, knowledgePointIds: ['sampling'], quizConfig: {
      questionCount: 1, difficulty: 'medium' as const, questionTypes: ['single' as const],
    } };
    const question = { ...content.questions[0], knowledgePointIds: ['sampling'] };
    const phaseNarration = [
      { type: 'text', phase: 'intro', content: '抽样机会影响偏差，请独立判断。' },
      { type: 'text', phase: 'review-guidance', content: '请等解析显示后核对依据，再确认理解。' },
      { type: 'text', phase: 'handoff', content: '抽样之外，还需要控制实验条件。' },
    ];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ questions: [question], phaseNarration }));
    const generated = await generateSceneContent(page, ai, { singlePassQuiz: true,
      quizNarrationContext: '先前已讲入样机会，接下来讲实验控制。' });
    expect(generated).toMatchObject({ phaseNarration });
    const actions = await generateSceneActions(page, generated as GeneratedQuizContent, ai);
    expect(ai).toHaveBeenCalledOnce();
    const gates = addPageTimingPauses(page, actions).flatMap((action) => action.type === 'speech'
      && 'activityPausePurpose' in action ? [action.activityPausePurpose] : []);
    expect(gates).toEqual(['quiz-submit', 'quiz']);
    expect(ai.mock.calls[0][1]).toContain('先前已讲入样机会');
  });

  it('does not accept or rewrite a combined quiz whose phase narration is incomplete', async () => {
    const page = { ...outline, knowledgePointIds: ['sampling'], quizConfig: {
      questionCount: 1, difficulty: 'medium' as const, questionTypes: ['single' as const],
    } };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ questions: [{ ...content.questions[0], knowledgePointIds: ['sampling'] }],
      phaseNarration: [{ type: 'text', phase: 'intro', content: '请作答。' }] }));
    await expect(generateSceneContent(page, ai, { singlePassQuiz: true })).rejects.toThrow(/invalid phase narration/);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('rejects an incomplete phase response rather than synthesizing feedback', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify([
      { type: 'text', phase: 'intro', content: '请独立作答。' },
      { type: 'text', phase: 'handoff', content: '进入下一节。' },
    ]));
    await expect(generateSceneActions(outline, content, ai)).rejects.toThrow('expected intro, review-guidance, handoff');
    expect(ai).toHaveBeenCalledTimes(1);
  });
});
