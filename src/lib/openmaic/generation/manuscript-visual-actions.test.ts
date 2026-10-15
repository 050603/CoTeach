import { describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import type { NarrationModuleOutput } from './action-binding-types';
import type { WbDrawTextAction } from '../types/action';
import { compileManuscriptVisualActions, generateManuscriptVisualActions } from './manuscript-visual-actions';
import { calibrateGeneratedVisualCues } from './semantic-visual-cues';
import { auditWhiteboardLayout } from '../whiteboard/layout';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';

const outline: SceneOutline = { id: 'page', type: 'slide', title: '核对流程', description: '解释核对与比较', keyPoints: [], order: 0 };
const content: GeneratedSlideContent = { elements: [
  ...['采集', '核验', '判断'].map((text, index) => ({ id: `node-${index}`, type: 'text',
    left: 50 + index * 280, top: 100, width: 220, height: 80, content: `<p>${text}</p>`,
    defaultFontName: 'Noto Sans SC', defaultColor: '#111111' })),
  { id: 'cases', type: 'table', left: 50, top: 230, width: 850, height: 200,
    outline: {}, colWidths: [0.3, 0.7], cellMinHeight: 40,
    data: [['情境', '判断'], ['转载同一篇报道', '一个来源'], ['分别采访当事人', '独立来源']].map((row, i) =>
      row.map((text, j) => ({ id: `cell-${i}-${j}`, colspan: 1, rowspan: 1, text }))) },
] as PPTElement[] };

function narration(text: string): NarrationModuleOutput {
  return { pageId: outline.id, segments: [{ id: 'saved-id', pageId: outline.id, text, semanticIds: ['page:teaching'] }] };
}

function compile(text: string, cues: unknown[]) {
  return compileManuscriptVisualActions({ outline, content, narration: narration(text), output: { pageId: outline.id, cues } });
}

const focus = (quote: string, rowIndex: number, extra = {}) => ({ speechId: 'saved-id', type: 'spotlight',
  target: { elementId: 'cases', selector: { rowIndex } }, speechAnchor: { quote, occurrence: 0 }, ...extra });

describe('visual orchestration on an immutable manuscript', () => {
  it('points to differently worded visible evidence while preserving every speech character and ID', () => {
    const text = '两篇文章来自同一份材料，所以还需要进一步核对。保留  空格和“引号”。';
    const result = compile(text, [focus('来自同一份材料', 1)]);
    expect(result.issues).toEqual([]);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'spotlight', elementId: 'cases', selector: { rowIndex: 1 } }));
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual([{ id: 'saved-id', type: 'speech', text }]);
  });

  it('switches rows, returns for a correction and holds the spotlight across sentences', () => {
    const text = '两家网站转发同一篇文章。它们仍然共享一个来源。再看分别访问现场的人。回到转发这个例子，并不是文章越多越可靠。';
    const result = compile(text, [focus('两家网站转发', 1, { endSpeechAnchor: { quote: '共享一个来源', occurrence: 0 } }),
      focus('分别访问现场的人', 2), focus('回到转发这个例子', 1)]);
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'spotlight').map((action) => action.selector)).toEqual([
      { rowIndex: 1 }, { rowIndex: 2 }, { rowIndex: 1 },
    ]);
    expect(result.actions[0]).toMatchObject({ endSpeechAnchor: { quote: '共享一个来源', occurrence: 0 } });
  });

  it('retains an explicit repeated-phrase occurrence', () => {
    const result = compile('先核对来源。现在比较另一种情况，再核对来源。', [focus('核对来源', 2,
      { speechAnchor: { quote: '核对来源', occurrence: 1 } })]);
    expect(result.issues).toEqual([]);
    expect(result.actions[0]).toMatchObject({ speechAnchor: { quote: '核对来源', occurrence: 1 } });
  });

  it('compiles a three-node path and a return to an earlier node using verified audio timing', () => {
    const text = '先把材料找齐。接着查明它们的出处。然后决定是否支持判断。不足时回到收集环节。';
    const result = compile(text, [{ speechId: 'saved-id', type: 'laser', target: { elementId: 'node-0' },
      speechAnchor: { quote: '先把材料找齐', occurrence: 0 }, waypoints: [
        { elementId: 'node-1', speechAnchor: { quote: '查明它们的出处', occurrence: 0 } },
        { elementId: 'node-2', speechAnchor: { quote: '决定是否支持判断', occurrence: 0 } },
        { elementId: 'node-0', speechAnchor: { quote: '回到收集环节', occurrence: 0 } },
      ] }]);
    expect(result.issues).toEqual([]);
    const timed = result.actions.map((action) => action.type === 'speech' ? { ...action,
      audioDurationSec: text.length / 10, speechAlignment: { version: 'test-v1', status: 'aligned' as const,
        textHash: 'test', audioHash: 'test', spans: Array.from(text, (character, index) => ({
          text: character, startChar: index, endChar: index + 1, startMs: index * 100, endMs: (index + 1) * 100,
        })) } } : action);
    const calibrated = calibrateGeneratedVisualCues({ outline, elements: content.elements, actions: timed });
    const laser = calibrated.find((action) => action.type === 'laser');
    expect(laser?.waypoints?.map((waypoint) => waypoint.elementId)).toEqual(['node-1', 'node-2', 'node-0']);
    expect(laser?.waypoints?.map((waypoint) => waypoint.speechOffsetMs)).toEqual([
      text.indexOf('查明它们的出处') * 100, text.indexOf('决定是否支持判断') * 100, text.indexOf('回到收集环节') * 100,
    ]);
  });

  it.each([
    { target: { elementId: 'missing' } },
    { target: { elementId: 'cases', selector: { rowIndex: 20 } } },
    { target: { elementId: 'cases', selector: { rowIndex: -1 } } },
    { speechAnchor: { quote: '不在讲稿中的话', occurrence: 0 } },
    { speechAnchor: { quote: '两篇文章', occurrence: 3 } },
    { endSpeechAnchor: { quote: '不存在的结尾' } },
    { speechId: 'unknown-speech' },
  ])('reports an invalid optional cue and retains valid guidance and speech: %j', (invalid) => {
    const text = '两篇文章来自同一篇报道。';
    const result = compile(text, [focus('两篇文章', 1), focus('两篇文章', 1, invalid)]);
    expect(result.actions.filter((action) => action.type === 'spotlight')).toHaveLength(1);
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual([{ id: 'saved-id', type: 'speech', text }]);
    expect(result.issues).toHaveLength(1);
  });

  it.each([
    { waypoints: [{ elementId: 'node-1' }, { elementId: 'node-2', speechAnchor: { quote: '最后', occurrence: 0 } }] },
    { waypoints: [{ elementId: 'node-1', speechAnchor: { quote: '最后', occurrence: 0 } }, { elementId: 'node-2', speechAnchor: { quote: '接着', occurrence: 0 } }] },
  ])('rejects an invalid path without inventing or dropping nodes', ({ waypoints }) => {
    const result = compile('首先。接着。最后。', [{ speechId: 'saved-id', type: 'laser', target: { elementId: 'node-0' },
      speechAnchor: { quote: '首先', occurrence: 0 }, waypoints }]);
    expect(result.actions).toEqual([{ id: 'saved-id', type: 'speech', text: '首先。接着。最后。' }]);
    expect(result.issues).toHaveLength(1);
  });

  it('passes the actual table rows and unchanged manuscript to action authoring', async () => {
    const aiCall = vi.fn(async (_system, prompt) => {
      const request = JSON.parse(prompt);
      expect(request.actualSlide.elements.find((element: { id: string }) => element.id === 'cases').table.rows[1])
        .toMatchObject({ rowIndex: 1, cells: [{ cellId: 'cell-1-0', text: '转载同一篇报道' }, { cellId: 'cell-1-1', text: '一个来源' }] });
      return JSON.stringify({ pageId: outline.id, cues: [focus('需要核对', 1)], segments: [{ id: 'rewritten', text: '不得执行的改写' }] });
    });
    const result = await generateManuscriptVisualActions({ outline, content, narration: narration('这还需要核对。'), aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(result.actions.at(-1)).toEqual({ id: 'saved-id', type: 'speech', text: '这还需要核对。' });
  });

  it('allows no cues when useful and keeps a silent observation page free of authoring requests', async () => {
    expect(compile('不依赖屏幕的过渡。', []).issues).toEqual([]);
    const aiCall = vi.fn();
    const result = await generateManuscriptVisualActions({ outline, content, narration: { pageId: outline.id, segments: [] }, aiCall });
    expect(aiCall).not.toHaveBeenCalled();
    expect(result.actions).toEqual([]);
  });

  it('treats malformed, empty or mismatched responses and transport failures as technical errors', async () => {
    for (const output of [{ pageId: 'wrong', cues: [] }, {}, '']) {
      const aiCall = vi.fn().mockResolvedValue(JSON.stringify(output));
      await expect(generateManuscriptVisualActions({ outline, content, narration: narration('讲稿。'), aiCall })).rejects.toThrow();
    }
    const failure = new Error('provider unavailable');
    await expect(generateManuscriptVisualActions({ outline, content, narration: narration('讲稿。'),
      aiCall: vi.fn().mockRejectedValue(failure) })).rejects.toBe(failure);
  });
});

describe('progressive whiteboard orchestration on the saved manuscript', () => {
  const step = (content: string, quote: string, title?: string) => ({ content,
    ...(title ? { title } : {}), speechId: 'saved-id', speechAnchor: { quote, occurrence: 0 } });
  const exit = (quote: string) => ({ speechId: 'saved-id', speechAnchor: { quote, occurrence: 0 } });
  const board = (steps: ReturnType<typeof step>[], extra = {}) => ({ title: '前期分析', steps,
    exit: exit('返回流程'), ...extra });
  const run = (text: string, whiteboards: unknown, configuredOutline = outline, cues: unknown[] = []) =>
    compileManuscriptVisualActions({ outline: configuredOutline, content, narration: narration(text),
      output: { pageId: outline.id, cues, whiteboards } });

  it('shows one anchored point at a time and moves emphasis while preserving all speech', () => {
    const text = '先看学习者，关注兴趣和已有知识。再看内容，选择适合活动的概念。随后分析目标。返回流程。';
    const saved = narration(text);
    const result = compileManuscriptVisualActions({ outline, content, narration: saved,
      output: { pageId: outline.id, cues: [], whiteboards: [board([
        step('兴趣／已有知识／身体学习能力', '先看学习者', '学习者分析'),
        step('适合具身活动的概念与技能', '再看内容', '教学内容分析'),
        step('可操作目标与设计评价标准', '随后分析目标', '教学目标分析'),
      ])] } });
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual([{ id: 'saved-id', type: 'speech', text }]);
    expect(saved).toEqual(narration(text));
    const whiteboard = result.actions.filter((action) => action.type.startsWith('wb_'));
    expect(whiteboard.slice(0, 4).map((action) => action.type)).toEqual(['wb_open', 'wb_clear', 'wb_draw_text', 'wb_draw_text']);
    expect(whiteboard.slice(0, 5)).toEqual(whiteboard.slice(0, 5).map((action) => expect.objectContaining({
      ...action, speechId: 'saved-id', speechAnchor: { quote: '先看学习者', occurrence: 0 },
    })));
    const body = whiteboard.filter((action): action is WbDrawTextAction => action.type === 'wb_draw_text' && action.fontSize === 24);
    expect(body.map((action) => action.color)).toEqual(['#1d4ed8', '#1e293b', '#1d4ed8', '#1e293b', '#1d4ed8']);
    expect(body[1]).toMatchObject({ elementId: body[0].elementId, speechAnchor: { quote: '再看内容', occurrence: 0 } });
    expect(whiteboard.at(-1)).toMatchObject({ type: 'wb_close', speechAnchor: { quote: '返回流程', occurrence: 0 } });
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toHaveLength(3);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
  });

  it('does not repeat a subsection label and uses stable host IDs across compilation', () => {
    const text = '身体结合体验。环境需要场所。环境需要合作。交互设置任务。返回流程。';
    const groups = [board([step('关键概念与身体体验结合', '身体', '身体'),
      step('物理环境：活动场所与材料', '环境需要场所', '环境'),
      step('社会环境：合作与支持', '环境需要合作', '环境'),
      step('任务：有意义的问题与活动', '交互', '交互')])];
    const first = run(text, groups);
    const second = run(text, groups);
    expect(first.actions).toEqual(second.actions);
    expect(first.actions.every((action) => !action.id.startsWith('planned-note-'))).toBe(true);
    const environmentLabels = first.actions.filter((action) => action.type === 'wb_draw_text' && action.content === '<p>环境</p>');
    // A continuation board may repeat the current subsection heading.
    const pages = first.actions.filter((action) => action.type === 'wb_clear').length;
    expect(environmentLabels.length).toBeLessThanOrEqual(pages);
    expect(auditWhiteboardLayout(first.actions)).toEqual([]);
  });

  it('clears full boards at the next spoken anchor without shrinking or dropping notes', () => {
    const text = Array.from({ length: 12 }, (_, index) => `讲要点${index + 1}。`).join('') + '返回流程。';
    const steps = Array.from({ length: 12 }, (_, index) => step(`第${index + 1}项：必须保留的事实与必要条件`, `要点${index + 1}。`, '完整要点'));
    const result = run(text, [board(steps)]);
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'wb_clear').length).toBeGreaterThan(1);
    for (const planned of steps) expect(result.actions).toContainEqual(expect.objectContaining({ type: 'wb_draw_text',
      content: `<p>${planned.content}</p>`, speechAnchor: planned.speechAnchor, fontSize: 24 }));
    expect(result.actions.filter((action) => action.type === 'wb_draw_text').every((action) => action.fontSize! >= 24)).toBe(true);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    expect(auditWhiteboardLayout(normalizeWhiteboardActionLayout(result.actions))).toEqual([]);
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toHaveLength(12);
  });

  it('starts a fitting subsection on a new board instead of clearing at its last note', () => {
    const text = '兴趣。已有知识。身体学习。内容。目标。标准。返回流程。';
    const steps = [step('人工智能领域的兴趣', '兴趣', '学习者分析'),
      step('已有知识', '已有知识'), step('通过身体动作学习的能力', '身体学习'),
      step('适合具身活动的概念与技能', '内容', '教学内容分析'),
      step('结合学习者与内容，形成可操作目标', '目标', '教学目标分析'),
      step('为活动设计和评价设定标准', '标准')];
    const result = run(text, [board(steps)]);
    const clears = result.actions.filter((action) => action.type === 'wb_clear');
    expect(clears.map((action) => action.speechAnchor?.quote)).toEqual(['兴趣', '目标']);
    expect(result.issues).toEqual([]);
    for (const planned of steps) expect(result.actions).toContainEqual(expect.objectContaining({ type: 'wb_draw_text',
      content: `<p>${planned.content}</p>`, speechAnchor: planned.speechAnchor, fontSize: 24 }));
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toEqual(steps);
    expect(auditWhiteboardLayout(normalizeWhiteboardActionLayout(result.actions))).toEqual([]);
  });

  it('reserves enough room for all four interaction notes before revealing the first one', () => {
    const text = '身体。案例。环境。目标。任务。策略。共同体。返回流程。';
    const steps = [step('关键概念与身体体验结合', '身体', '身体'),
      step('分类游戏：通过身体参与分类，体验机器学习算法工作原理并理解模式识别', '案例'),
      step('物理环境／社会环境／规范环境', '环境', '环境'),
      step('目标：具体、可达成', '目标', '交互'), step('任务：围绕内容，激发兴趣', '任务'),
      step('策略：综合方法、工具和身体动作', '策略'), step('共同体：按兴趣、能力和需求分组', '共同体')];
    const result = run(text, [board(steps, { title: '核心要素设计' })]);
    expect(result.actions.filter((action) => action.type === 'wb_clear').map((action) => action.speechAnchor?.quote))
      .toEqual(['身体', '目标']);
    const interactionStart = result.actions.findIndex((action) => action.type === 'wb_draw_text' && action.content === '<p>交互</p>');
    expect(result.actions.slice(interactionStart).filter((action) => action.type === 'wb_clear')).toEqual([]);
    expect(result.issues).toEqual([]);
    for (const planned of steps) expect(result.actions).toContainEqual(expect.objectContaining({ type: 'wb_draw_text',
      content: `<p>${planned.content}</p>`, speechAnchor: planned.speechAnchor, fontSize: 24 }));
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toEqual(steps);
    expect(auditWhiteboardLayout(normalizeWhiteboardActionLayout(result.actions))).toEqual([]);
  });

  it('returns to PPT before its process cue at the same spoken anchor', () => {
    const text = '先分析学习者。再分析内容。返回流程，采集后核验。接着判断。';
    const result = run(text, [board([step('兴趣和已有知识', '先分析'), step('活动适用内容', '再分析')])], outline, [
      { speechId: 'saved-id', type: 'laser', target: { elementId: 'node-0' }, speechAnchor: { quote: '返回流程', occurrence: 0 } },
    ]);
    expect(result.issues).toEqual([]);
    const closeIndex = result.actions.findIndex((action) => action.type === 'wb_close');
    expect(result.actions[closeIndex + 1]).toMatchObject({ type: 'laser', elementId: 'node-0' });
  });

  it('keeps explicit repeated-phrase occurrences and steps across saved speech segments', () => {
    const saved: NarrationModuleOutput = { pageId: outline.id, segments: [
      { id: 'a', pageId: outline.id, semanticIds: [], text: '先看环境。环境分为三类。' },
      { id: 'b', pageId: outline.id, semanticIds: [], text: '现在讨论规范，最后返回PPT。' },
    ] };
    const result = compileManuscriptVisualActions({ outline, content, narration: saved, output: { pageId: outline.id, cues: [],
      whiteboards: [{ title: '环境', steps: [
        { content: '物理／社会／规范', speechId: 'a', speechAnchor: { quote: '环境', occurrence: 1 } },
        { content: '规范：共同规则与支持', speechId: 'b', speechAnchor: { quote: '现在讨论规范' } },
      ], exit: { speechId: 'b', speechAnchor: { quote: '最后返回PPT' } } }] } });
    expect(result.issues).toEqual([]);
    expect(result.actions.find((action) => action.type === 'wb_open')).toMatchObject({ speechId: 'a', speechAnchor: { quote: '环境', occurrence: 1 } });
    expect(result.actions.filter((action) => action.type === 'speech').map((action) => ({ id: action.id, text: action.text })))
      .toEqual(saved.segments.map(({ id, text }) => ({ id, text })));
    expect(result.actions.find((action) => action.type === 'wb_close')).toMatchObject({ speechId: 'b' });
  });

  it('records invalid anchors and excessive capacity while retaining valid groups and complete required facts', () => {
    const text = '先分析学习者。再分析内容。返回流程。';
    const tooLong = '完整事实与必要条件'.repeat(100);
    const result = run(text, [board([step('兴趣和已有知识', '先分析'), step('必须核对的遗漏项', '不存在的讲词'),
      step(tooLong, '再分析')])]);
    expect(result.issues.length).toBeGreaterThanOrEqual(2);
    expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'wb_draw_text', content: '<p>兴趣和已有知识</p>' }));
    expect(result.actions.at(-1)).toEqual({ id: 'saved-id', type: 'speech', text });
    expect(result.teachingToolPlan?.[0].content).toContain(tooLong);
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toContainEqual(expect.objectContaining({ content: tooLong }));
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
  });

  it.each([
    { title: '', steps: [step('要点', '先分析')], exit: exit('返回流程') },
    { title: '分析', steps: [step('要点', '先分析')], exit: exit('不存在的结束') },
    { title: '分析', steps: [step('要点', '返回流程')], exit: exit('先分析') },
  ])('keeps speech playable when an optional board has invalid content or timing: %j', (invalid) => {
    const text = '先分析学习者。返回流程。';
    const result = run(text, [invalid]);
    expect(result.actions).toEqual([{ id: 'saved-id', type: 'speech', text }]);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('diagnoses an omitted required group even when another whiteboard group is present', () => {
    const configured: SceneOutline = { ...outline, teachingToolPlan: [
      { id: 'learner-plan', tool: 'whiteboard', trigger: '先分析', purpose: '分析学习者', content: ['兴趣和已有知识'], required: true },
      { id: 'evaluation-plan', tool: 'whiteboard', trigger: '最后评价', purpose: '完整评价维度', content: ['形成性与总结性评价'], required: true },
      { id: 'ppt-flow', tool: 'laser-pointer', trigger: '返回流程', purpose: '指示实际顺序', content: ['采集→核验→判断'] },
    ] };
    const result = run('先分析学习者。返回流程。最后评价。', [board([step('兴趣和已有知识', '先分析')], { planId: 'learner-plan' })], configured);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('完整评价维度');
    expect(result.teachingToolPlan).toContainEqual(configured.teachingToolPlan![1]);
    expect(result.teachingToolPlan).toContainEqual(configured.teachingToolPlan![2]);
    expect(result.teachingToolPlan?.find((plan) => plan.id === 'learner-plan')?.whiteboard?.steps).toHaveLength(1);
  });

  it('keeps an accepted step contract when a later response omits one of its points', () => {
    const expected = board([step('兴趣和已有知识', '先分析'), step('评价标准', '再分析')]);
    const configured: SceneOutline = { ...outline, teachingToolPlan: [{ id: 'accepted-plan', tool: 'whiteboard',
      trigger: '先分析', purpose: '完整分析', content: ['兴趣和已有知识', '评价标准'], whiteboard: expected, required: true }] };
    const result = run('先分析学习者。再分析目标。返回流程。', [board([step('兴趣和已有知识', '先分析')], { planId: 'accepted-plan' })], configured);
    expect(result.teachingToolPlan?.[0].whiteboard?.steps).toEqual(expected.steps);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('评价标准') }));
    expect(result.actions.at(-1)).toMatchObject({ type: 'speech', text: '先分析学习者。再分析目标。返回流程。' });
  });

  it('diagnoses a missing original semantic item when creating its first step contract', () => {
    const configured: SceneOutline = { ...outline, teachingToolPlan: [{ id: 'first-plan', tool: 'whiteboard',
      trigger: '先分析', purpose: '完整分析', content: ['兴趣和已有知识', '评价标准'], required: true }] };
    const result = run('先分析学习者。再分析目标。返回流程。',
      [board([step('兴趣和已有知识', '先分析')], { planId: 'first-plan' })], configured);
    expect(result.teachingToolPlan?.[0].content).toEqual(['兴趣和已有知识', '评价标准']);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('原计划要点“评价标准”') }));
    expect(result.actions.at(-1)).toMatchObject({ type: 'speech', text: '先分析学习者。再分析目标。返回流程。' });
    const complete = run('先分析学习者。再分析目标。返回流程。',
      [board([step('兴趣和已有知识', '先分析'), step('评价标准', '再分析')], { planId: 'first-plan' })], configured);
    expect(complete.issues).toEqual([]);
  });

  it('does not accept moving a saved repeated anchor to its earlier occurrence', () => {
    const first = { ...step('兴趣和已有知识', '开始分析'), speechAnchor: { quote: '开始分析', occurrence: 0 } };
    const second = { ...step('评价标准', '开始分析'), speechAnchor: { quote: '开始分析', occurrence: 1 } };
    const expected = board([first, second]);
    const configured: SceneOutline = { ...outline, teachingToolPlan: [{ id: 'accepted-repeat', tool: 'whiteboard',
      trigger: '开始分析', purpose: '两项分析', content: ['兴趣和已有知识', '评价标准'], whiteboard: expected, required: true }] };
    const result = run('开始分析学习者。开始分析目标。返回流程。',
      [board([first, { ...second, speechAnchor: first.speechAnchor }], { planId: 'accepted-repeat' })], configured);
    expect(result.issues).toContainEqual(expect.objectContaining({ severity: 'warning', message: expect.stringContaining('评价标准') }));
    const correct = run('开始分析学习者。开始分析目标。返回流程。',
      [board([first, second], { planId: 'accepted-repeat' })], configured);
    expect(correct.issues).toEqual([]);
  });

  it('omits a PPT cue hidden by a board and preserves later PPT teaching', () => {
    const text = '先分析学习者。再分析内容。返回流程。';
    const result = run(text, [board([step('兴趣和已有知识', '先分析')])], outline,
      [focus('先分析', 1), focus('返回流程', 2)]);
    expect(result.actions.filter((action) => action.type === 'spotlight')).toHaveLength(1);
    expect(result.actions.find((action) => action.type === 'spotlight')).toMatchObject({ selector: { rowIndex: 2 } });
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].message).toContain('不可见');
  });

  it('passes adopted sources, the actual PPT and all saved speech to authoring without forcing boards', async () => {
    const originalSources = '权威资料：学习者分析包括兴趣、已有知识与身体学习能力。';
    const aiCall = vi.fn(async (system, prompt) => {
      expect(system).toContain('specific visual gap');
      expect(system).toContain('at least 24px');
      expect(system).toContain('Never decide from narration length');
      const input = JSON.parse(prompt);
      expect(input.sourceEvidence.adoptedOriginalSources).toBe(originalSources);
      expect(input.actualSlide.elements).toHaveLength(content.elements.length);
      expect(input.segments).toEqual([{ id: 'saved-id', text: '画面已经充分展示。' }]);
      return JSON.stringify({ pageId: outline.id, cues: [], whiteboards: [], segments: [{ id: 'rewrite', text: '禁止改写' }] });
    });
    const result = await generateManuscriptVisualActions({ outline, content, narration: narration('画面已经充分展示。'),
      teachingSourceContext: originalSources, aiCall });
    expect(result.issues).toEqual([]);
    expect(result.actions).toEqual([{ id: 'saved-id', type: 'speech', text: '画面已经充分展示。' }]);
    expect(result.teachingToolPlan).toBeUndefined();
  });
});
