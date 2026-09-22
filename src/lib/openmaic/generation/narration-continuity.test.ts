import { describe, expect, it } from 'vitest';
import type { Action } from '../types/action';
import type { SceneOutline } from '../types/generation';
import {
  buildNarrationContext,
  enforceNarrationContinuity,
  mergeFragmentedNarrationActions,
  normalizeCourseFinalClosing,
  rewriteFalseFutureSessionReferences,
  stripRepeatedNarrationOpening,
  stripFormalNarrationFarewell,
} from './narration-continuity';

const outlines: SceneOutline[] = [
  { id: 'a', type: 'slide', title: '认识变量', description: '理解变量表示会变化的量', keyPoints: ['变量含义'], estimatedDuration: 60, order: 0, stageKey: 'ai-learning' },
  { id: 'b', type: 'slide', title: '变量关系', description: '用关系式连接两个变量', keyPoints: ['对应关系'], estimatedDuration: 60, order: 1, stageKey: 'ai-learning' },
  { id: 'c', type: 'interactive', title: '动手验证', description: '操作滑块观察变量变化', keyPoints: ['观察证据'], estimatedDuration: 60, order: 2, stageKey: 'project-practice' },
];

describe('narration continuity', () => {
  it('normalizes contradictory punctuation and invalidates mismatched audio', () => {
    const [speech] = enforceNarrationContinuity([{
      id: 's1',
      type: 'speech',
      text: '先观察共同特征。；再比较差异；。',
      audioId: 'old-audio',
      audioUrl: '/old.wav',
      audioDurationSec: 3,
      speechAlignment: {
        version: 'test-v1',
        status: 'pending',
        textHash: 'old-text',
        audioHash: 'old-audio',
        spans: [],
      },
    }]);

    expect(speech).toMatchObject({
      type: 'speech',
      text: '先观察共同特征；再比较差异。',
      audioInvalidated: true,
    });
    expect(speech).not.toHaveProperty('audioId');
    expect(speech).not.toHaveProperty('audioUrl');
    expect(speech).not.toHaveProperty('audioDurationSec');
    expect(speech).not.toHaveProperty('speechAlignment');
  });

  it('builds previous-page context before concurrent generation', () => {
    const context = buildNarrationContext(outlines, 1);
    expect(context.pageIndex).toBe(2);
    expect(context.sectionPosition).toBe('continuation');
    expect(context.previousPageTitle).toBe('认识变量');
    expect(context.previousPageSummary).toContain('变量含义');
    expect(context.currentTeachingObjective).toContain('对应关系');
  });

  it('marks the first page of a new section without treating it as a new class', () => {
    const context = buildNarrationContext(outlines, 2);
    expect(context.sectionPosition).toBe('section-first');
    expect(context.pageIndex).toBe(3);
  });

  it('greets when the AI lecture begins after a teacher-led launch page', () => {
    const progression: SceneOutline[] = [
      { ...outlines[0], id: 'launch', order: 0, stageKey: 'launch', audience: 'teacher' },
      { ...outlines[0], id: 'ai-first', order: 1, stageKey: 'ai-learning', audience: 'student' },
    ];
    const context = buildNarrationContext(progression, 1, { courseTitle: '变量与关系' });
    expect(context.sectionPosition).toBe('course-first');
    expect(enforceNarrationContinuity([
      { id: 's1', type: 'speech', text: '先从一个会变化的量开始。' },
    ], context)[0]).toMatchObject({
      type: 'speech',
      text: expect.stringMatching(/^同学们好，欢迎来到《变量与关系》课程。/),
    });
  });

  it('removes repeated greetings and course restarts after page one', () => {
    expect(stripRepeatedNarrationOpening('大家好，欢迎来到今天的课堂。下面看变量关系。')).toBe('下面看变量关系。');
    expect(stripRepeatedNarrationOpening('同学们，今天我们来学习变量关系。先看这个式子。')).toBe('先看这个式子。');
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '欢迎同学们来到变量课堂。现在观察关系式。' }];
    const result = enforceNarrationContinuity(actions, buildNarrationContext(outlines, 1));
    expect(result[0]).toMatchObject({
      type: 'speech',
      text: '现在观察关系式。 接下来进入项目实践，把刚才形成的认识用于具体任务。',
    });
  });

  it('keeps the course-first greeting intact', () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '大家好，欢迎来到今天的课堂。' }];
    expect(enforceNarrationContinuity(actions, buildNarrationContext(outlines, 0))).toEqual(actions);
  });

  it('uses the known course title when the model omits the opening greeting', () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '先比较这两种变量变化。' }];
    const context = buildNarrationContext(outlines, 0, { courseTitle: '变量与关系' });

    expect(enforceNarrationContinuity(actions, context)[0]).toMatchObject({
      type: 'speech',
      text: expect.stringMatching(/^同学们好，欢迎来到《变量与关系》课程。/),
    });
  });

  it('makes the main course opening independent from prerequisite pages', () => {
    const actions: Action[] = [{
      id: 's1',
      type: 'speech',
      text: '上一页我们看到了计算机视觉在生活中的应用，现在认识图像分类。',
    }];
    const result = enforceNarrationContinuity(actions, buildNarrationContext(outlines, 0));

    expect(result[0]).toMatchObject({
      type: 'speech',
      text: '同学们好，欢迎来到今天的课堂。这节课我们先来了解计算机视觉在生活中的应用，现在认识图像分类。',
    });
  });

  it('adds a greeting when a generated main course starts without one', () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '今天我们来认识变量。' }];
    expect(enforceNarrationContinuity(actions, buildNarrationContext(outlines, 0))[0]).toMatchObject({
      type: 'speech',
      text: '同学们好，欢迎来到今天的课堂。今天我们来认识变量。',
    });
  });

  it('keeps a section-first opening and adds the final resource closing when it is also the last page', () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '下面进入项目实践这一章，先把刚才的变量关系用于操作。' }];
    const result = enforceNarrationContinuity(actions, buildNarrationContext(outlines, 2));
    expect(result[0]).toMatchObject({
      type: 'speech',
      text: expect.stringMatching(/^下面进入项目实践这一章，先把刚才的变量关系用于操作。.*同学们再见。$/),
    });
  });

  it('treats an independently generated resource as an embedded lesson segment', () => {
    const embedded: SceneOutline[] = [{
      ...outlines[0],
      id: 'review',
      narrationMode: 'embedded-segment',
    }];
    const actions: Action[] = [
      { id: 's1', type: 'speech', text: '同学们好，欢迎来到今天的课程。先回顾训练集的作用。' },
      { id: 's2', type: 'speech', text: '这能帮助我们进入后面的学习。谢谢大家，下节课再见！' },
    ];
    expect(enforceNarrationContinuity(actions, buildNarrationContext(embedded, 0))).toEqual([
      { id: 's1', type: 'speech', text: '先回顾训练集的作用。' },
      { id: 's2', type: 'speech', text: '这能帮助我们进入后面的学习。 接下来，让我们继续后面的学习。' },
    ]);
  });

  it('merges comma-ended micro-lesson fragments into complete semantic sentences', () => {
    const actions: Action[] = [
      { id: 's1', type: 'speech', text: '计算机视觉的基本原理，' },
      { id: 's2', type: 'speech', text: '就是让计算机能够看懂图像或视频，' },
      { id: 's3', type: 'speech', text: '包括识别其中的物体、场景和动作。' },
      { id: 's4', type: 'speech', text: '这是整个领域的核心目标。' },
    ];

    expect(mergeFragmentedNarrationActions(actions)).toEqual([
      {
        id: 's1',
        type: 'speech',
        text: '计算机视觉的基本原理，就是让计算机能够看懂图像或视频，包括识别其中的物体、场景和动作。',
      },
      { id: 's4', type: 'speech', text: '这是整个领域的核心目标。' },
    ]);
  });

  it('rewrites false previous-session references on adjacent pages', () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '上一节课我们认识了变量，现在继续看关系。' }];
    expect(enforceNarrationContinuity(actions, buildNarrationContext(outlines, 1))[0]).toMatchObject({
      type: 'speech',
      text: '刚才我们认识了变量，现在继续看关系。 接下来进入项目实践，把刚才形成的认识用于具体任务。',
    });
  });

  it('rewrites future-class wording when it actually points to a later page in this lesson', () => {
    const actions: Action[] = [{
      id: 's1',
      type: 'speech',
      text: '这一页先认识变量，下节课我们再打开系统完成操作。',
    }];

    expect(enforceNarrationContinuity(actions, buildNarrationContext(outlines, 0))[0]).toMatchObject({
      type: 'speech',
      text: '同学们好，欢迎来到今天的课堂。这一页先认识变量，接下来我们再打开系统完成操作。',
    });
    expect(rewriteFalseFutureSessionReferences('In the next lesson, we will try the system.'))
      .toBe('later in this lesson, we will try the system.');
  });

  it('keeps an explicitly planned future lesson and still formally closes the terminal course page', () => {
    const actions: Action[] = [{ id: 's1', type: 'speech', text: '下节课我们将学习新的主题。' }];

    expect(enforceNarrationContinuity(actions, buildNarrationContext(outlines, 2))[0]).toMatchObject({
      type: 'speech',
      text: expect.stringContaining('下节课我们将学习新的主题。'),
    });
    expect((enforceNarrationContinuity(actions, buildNarrationContext(outlines, 2))[0] as Extract<Action, { type: 'speech' }>).text)
      .toMatch(/感谢大家的认真参与，同学们再见。$/);
  });

  it('hands the AI-learning stage into project practice without saying goodbye', () => {
    const aiOnly = outlines.slice(0, 2);
    const result = enforceNarrationContinuity([
      { id: 's1', type: 'speech', text: '现在已经能依据变量关系作出判断。今天的课程就到这里，谢谢大家，同学们再见。' },
    ], buildNarrationContext(aiOnly, 1));
    const text = (result[0] as Extract<Action, { type: 'speech' }>).text;
    expect(text).toContain('接下来进入项目实践');
    expect(text).not.toMatch(/课程就到这里|谢谢大家|再见/);
  });

  it('invalidates changed audio and removes a visual cue whose speech anchor was trimmed', () => {
    const actions: Action[] = [
      {
        id: 'focus', type: 'spotlight', elementId: 'summary', speechId: 's1',
        speechAnchor: { quote: '谢谢大家', occurrence: 0 },
      },
      { id: 's1', type: 'speech', text: '记住这个判断。谢谢大家，同学们再见。', audioUrl: '/stale.mp3', audioDurationSec: 8 },
    ];
    const result = enforceNarrationContinuity(actions, buildNarrationContext(outlines.slice(0, 2), 1));
    expect(result).toEqual([expect.objectContaining({
      id: 's1',
      type: 'speech',
      audioInvalidated: true,
      text: expect.stringContaining('接下来进入项目实践'),
    })]);
    expect(result[0]).not.toHaveProperty('audioUrl');
    expect(result[0]).not.toHaveProperty('audioDurationSec');
  });

  it('bridges into an actual quiz and does not announce mastery or a course ending', () => {
    const quiz: SceneOutline = {
      id: 'quiz', type: 'quiz', title: '理解检测', description: '检查理解', keyPoints: [], order: 2, stageKey: 'ai-learning',
    };
    const progression = [...outlines.slice(0, 2), quiz];
    const result = enforceNarrationContinuity([
      { id: 's1', type: 'speech', text: '这一页讲清了判断依据。感谢大家，同学们再见。' },
    ], buildNarrationContext(progression, 1));
    const text = (result[0] as Extract<Action, { type: 'speech' }>).text;
    expect(text).toContain('接下来通过“理解检测”检验理解');
    expect(text).not.toMatch(/已经掌握|再见/);
  });

  it('does not treat a single later-page preview as the course ending', () => {
    const preview = [{ ...outlines[0], stageKey: undefined, order: 4 }];
    const context = buildNarrationContext(preview, 0);
    expect(context.endingDisposition).toBe('partial-preview');
    expect(enforceNarrationContinuity([
      { id: 's1', type: 'speech', text: '先完成这一页的比较。谢谢大家，同学们再见。' },
    ], context)[0]).toMatchObject({ type: 'speech', text: '先完成这一页的比较。' });
  });

  it('preserves an authored formal ending and fills a missing one once', () => {
    expect(normalizeCourseFinalClosing('今天的课程就到这里，感谢大家参与，同学们再见。'))
      .toBe('今天的课程就到这里，感谢大家参与，同学们再见。');
    const filled = normalizeCourseFinalClosing('现在你已经能依据变化判断变量关系。');
    expect(filled).toContain('带到后续的判断与实践中');
    expect(filled.match(/同学们再见/g)).toHaveLength(1);
    const deduplicated = normalizeCourseFinalClosing('记住判断依据。谢谢大家，同学们再见。谢谢大家，同学们再见。');
    expect(deduplicated.match(/同学们再见/g)).toHaveLength(1);
  });

  it('recognizes formal farewells without removing the learning takeaway', () => {
    expect(stripFormalNarrationFarewell('记住这个判断依据。感谢同学们的聆听！')).toBe('记住这个判断依据。');
  });
});
