import { describe, expect, it } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { SceneOutline, TeachingToolPlanItem } from '@openmaic/lib/types/generation';
import { compileWhiteboardDiagram, whiteboardDiagramElementId, type WhiteboardDiagram } from '../whiteboard/diagram';
import { splitLongSpeechActions } from '../audio/tts-utils';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';
import {
  applyPlannedTeachingToolActions,
  ensureTeachingToolPlans,
  findMissingRequiredTeachingTools,
  formatTeachingToolPlanForPrompt,
  hasUsableInteractiveSurface,
  normalizeTeachingToolPlan,
  summarizeActualTeachingTools,
  findWhiteboardPlanIssues,
} from './teaching-tool-plan';

function slide(patch: Partial<SceneOutline> = {}): SceneOutline {
  return {
    id: 'scene-1',
    type: 'slide',
    title: '图像分类流程',
    description: '逐步解释数据、特征与模型之间的关系',
    keyPoints: ['输入标注图像', '提取可区分特征', '模型输出类别'],
    order: 0,
    audience: 'student',
    generationPurpose: 'knowledge-teaching',
    ...patch,
  };
}

describe('teaching tool plan', () => {
  it('preserves semantic plan contents without truncating them to six items', () => {
    const content = Array.from({ length: 8 }, (_, i) => `完整要点${i}`);
    const [plan] = normalizeTeachingToolPlan([{
      tool: 'whiteboard', trigger: '逐项说明时', purpose: '完整展示', content,
    }]);
    expect(plan.content).toEqual(content);
  });

  it('preserves every board step and diagnoses an omitted group instead of accepting one draw', () => {
    const [plan] = normalizeTeachingToolPlan([{
      tool: 'whiteboard', trigger: '逐项说明时', purpose: '补充尚未显示的内容', content: ['已有知识', '评价标准'],
      whiteboard: { title: '分析', steps: [
        { content: '已有知识', speechId: 'speech', speechAnchor: { quote: '学习者' } },
        { content: '评价标准', speechId: 'speech', speechAnchor: { quote: '教学目标' } },
      ], exit: { speechId: 'speech', speechAnchor: { quote: '实施阶段' } } },
    }]);
    expect(plan.content).toEqual(['已有知识', '评价标准']);
    expect(plan.whiteboard?.steps).toHaveLength(2);
    const actions: Action[] = [
      { id: 'speech', type: 'speech', text: '学习者分析。教学目标分析。实施阶段。' },
      { id: 'title', type: 'wb_draw_text', content: '分析', x: 40, y: 40, fontSize: 30 },
      { id: 'first', type: 'wb_draw_text', content: '已有知识', x: 40, y: 100, fontSize: 24,
        speechId: 'speech', speechAnchor: { quote: '学习者' } },
      { id: 'close', type: 'wb_close', speechId: 'speech', speechAnchor: { quote: '实施阶段' } },
    ];
    expect(findWhiteboardPlanIssues(plan, actions)).toEqual([expect.stringContaining('评价标准')]);
    expect(findMissingRequiredTeachingTools({ teachingToolPlan: [plan] }, { sceneType: 'slide', actions })).toEqual(['whiteboard']);
    actions.push({ id: 'second', type: 'wb_draw_text', content: '评价标准', x: 40, y: 200, fontSize: 24,
      speechId: 'speech', speechAnchor: { quote: '教学目标' } });
    expect(findWhiteboardPlanIssues(plan, actions)).toEqual([]);
    expect(findMissingRequiredTeachingTools({ teachingToolPlan: [plan] }, { sceneType: 'slide', actions })).toEqual([]);
  });

  it('does not infer a whiteboard from broad outline language', () => {
    const [planned] = ensureTeachingToolPlans([slide()]);
    expect(planned.teachingToolPlan).toBeUndefined();
  });

  it('removes inherited tool contracts from non-teaching scenes', () => {
    const quiz = slide({
      type: 'quiz',
      teachingToolPlan: [{
        id: 'inherited-board',
        tool: 'whiteboard',
        trigger: '作答前',
        purpose: '展示提示',
        content: ['提示内容'],
        required: true,
      }],
    });

    expect(ensureTeachingToolPlans([quiz])[0].teachingToolPlan).toBeUndefined();
    expect(findMissingRequiredTeachingTools(quiz, {
      sceneType: 'quiz',
      content: { type: 'quiz', questions: [] },
      actions: [{ id: 'speech', type: 'speech', text: '请开始作答。' }],
    })).toEqual([]);
  });

  it('preserves and sanitizes a model-authored tool plan', () => {
    const plan = normalizeTeachingToolPlan([{
      tool: 'whiteboard',
      trigger: '讲到卷积核移动时',
      purpose: '保留局部计算过程',
      content: ['输入窗口', '逐元素相乘', '求和得到特征值'],
      required: true,
    }]);
    expect(plan).toHaveLength(1);
    expect(formatTeachingToolPlanForPrompt(slide({ teachingToolPlan: plan }))).toContain('求和得到特征值');
  });

  it('does not fabricate whiteboard content when a required plan is missing actions', () => {
    const planned = slide({
      teachingToolPlan: [{
        id: 'wb-plan',
        tool: 'whiteboard',
        trigger: '推导分类边界时',
        purpose: '保留逐步推导过程',
        content: ['样本坐标', '决策边界'],
        required: true,
      }],
    });
    const actions: Action[] = [{ id: 'speech-1', type: 'speech', text: '我们逐步看这条处理链。' }];
    const result = applyPlannedTeachingToolActions(planned, actions);
    expect(result).toEqual(actions);
  });

  it('does not fabricate a widget action when generation omitted it', () => {
    const result = applyPlannedTeachingToolActions({
      teachingToolPlan: [{
        id: 'widget-plan',
        tool: 'interactive-widget',
        trigger: '完成讲解后',
        purpose: '引导学生操作',
        content: ['尝试调整参数并观察结果'],
        required: true,
      }],
    }, [{ id: 'speech', type: 'speech', text: '请开始操作。' }]);

    expect(result).toEqual([{ id: 'speech', type: 'speech', text: '请开始操作。' }]);
  });

  it('reports the actual page trigger and visible whiteboard content', () => {
    const actions: Action[] = [
      { id: 'speech-1', type: 'speech', text: '现在把三个步骤画出来。' },
      { id: 'open', type: 'wb_open' },
      { id: 'draw-1', type: 'wb_draw_text', content: '数据 → 特征 → 分类', x: 20, y: 20 },
    ];
    expect(summarizeActualTeachingTools(actions)).toEqual([{
      tool: 'whiteboard',
      actionCount: 2,
      trigger: '现在把三个步骤画出来。',
      content: ['数据 → 特征 → 分类'],
    }]);
  });

  it('accepts a generated interactive surface as the planned widget itself', () => {
    const planned = {
      teachingToolPlan: [{
        id: 'widget-plan',
        tool: 'interactive-widget' as const,
        trigger: '完成讲解后',
        purpose: '引导学生操作',
        content: ['输入提示词并比较结果'],
        required: true,
      }],
    };
    const evidence = {
      sceneType: 'interactive',
      content: {
        type: 'interactive',
        url: '',
        html: '<!doctype html><html><body><label>提示词<input id="prompt"></label><button>生成</button><script>document.querySelector("button")</script></body></html>',
      },
      actions: [{ id: 'speech', type: 'speech' as const, text: '请开始操作。' }],
    };

    expect(hasUsableInteractiveSurface(evidence)).toBe(true);
    expect(findMissingRequiredTeachingTools(planned, evidence)).toEqual([]);
  });

  it('rejects an empty interactive shell and lifecycle-only whiteboard actions', () => {
    expect(findMissingRequiredTeachingTools({
      teachingToolPlan: [
        {
          id: 'widget-plan',
          tool: 'interactive-widget',
          trigger: '开始练习时',
          purpose: '让学生操作',
          content: ['输入内容'],
          required: true,
        },
        {
          id: 'whiteboard-plan',
          tool: 'whiteboard',
          trigger: '开始推导时',
          purpose: '展示推导',
          content: ['关键步骤'],
          required: true,
        },
      ],
    }, {
      sceneType: 'interactive',
      content: { type: 'interactive', url: '', html: '<html><body></body></html>' },
      actions: [{ id: 'open', type: 'wb_open' }],
    })).toEqual(['interactive-widget', 'whiteboard']);
  });

  it('allows semantic cue validation to omit an unreliable planned visual target', () => {
    expect(findMissingRequiredTeachingTools({
      teachingToolPlan: [
        {
          id: 'spotlight-plan',
          tool: 'spotlight',
          trigger: '解释表格中的学段差异时',
          purpose: '聚焦当前单元格',
          content: ['小学内容形态'],
          required: true,
        },
        {
          id: 'laser-plan',
          tool: 'laser-pointer',
          trigger: '点名术语时',
          purpose: '指出精确术语',
          content: ['PBL'],
          required: true,
        },
      ],
    }, {
      sceneType: 'slide',
      actions: [{ id: 'speech', type: 'speech', text: '这一段没有可可靠定位的目标。' }],
    })).toEqual([]);
  });
});

describe('progressive diagram teaching-tool contracts', () => {
  const diagram: WhiteboardDiagram = { panels: [{ key: 'analysis', kind: 'branches', nodes: [
    { key: 'learner', label: '学习者分析', icon: 'person', lines: [{ key: 'prior', text: '已有知识' }] },
    { key: 'goal', label: '教学目标分析', icon: 'target', lines: [{ key: 'criteria', text: '评价标准' }] },
  ], relations: [{ key: 'supports-goal', from: 'learner', to: 'goal', kind: 'sequence' }] }] };
  const at = (quote: string) => ({ speechId: 'speech', speechAnchor: { quote } });
  const board = () => ({ title: '前期分析', diagram: structuredClone(diagram), steps: [
    { reveal: ['learner', 'prior'], emphasize: ['prior'], ...at('学习者分析') },
    { reveal: ['goal', 'criteria', 'supports-goal'], emphasize: ['criteria'], ...at('教学目标分析') },
    { reveal: [], emphasize: ['prior'], ...at('再看已有知识') },
  ], exit: at('进入实施阶段') });
  const plan = (): TeachingToolPlanItem => ({ id: 'diagram:plan', tool: 'whiteboard', trigger: '学习者分析',
    purpose: '显示学习者与教学目标的关系', content: ['学习者分析：已有知识', '教学目标分析：评价标准'], required: true,
    whiteboard: board() });
  const narration: Action = { id: 'speech', type: 'speech', text: '先做学习者分析。再做教学目标分析。再看已有知识，最后进入实施阶段。' };
  const compile = (value = board()): Action[] => [...compileWhiteboardDiagram({ id: 'diagram', ...value }).actions, narration];

  it('round-trips reveal-only contracts with all diagram content, relations and emphasis intact', () => {
    const normalized = normalizeTeachingToolPlan([plan()]);
    expect(normalized).toEqual([plan()]);
    expect(normalizeTeachingToolPlan(normalized)).toEqual(normalized);
    expect(normalized[0].whiteboard?.steps[0]).not.toHaveProperty('content');
    const actions = compile();
    expect(findWhiteboardPlanIssues(normalized[0], actions)).toEqual([]);
    expect(findWhiteboardPlanIssues(normalized[0], normalizeWhiteboardActionLayout(actions))).toEqual([]);
    expect(findMissingRequiredTeachingTools({ teachingToolPlan: normalized }, { sceneType: 'slide', actions })).toEqual([]);
  });

  it.each(['goal', 'prior', 'supports-goal'])('reports an omitted declared object %s even when another draw exists', (key) => {
    const id = whiteboardDiagramElementId('diagram', key);
    const actions = compile().filter((action) => !('elementId' in action) || action.elementId !== id);
    expect(findWhiteboardPlanIssues(plan(), actions).length).toBeGreaterThan(0);
    expect(findMissingRequiredTeachingTools({ teachingToolPlan: [plan()] }, { sceneType: 'slide', actions })).toEqual(['whiteboard']);
  });

  it('keeps the complete contract when only part of a diagram was returned', () => {
    const partial = board();
    partial.steps = partial.steps.slice(0, 1);
    const issues = findWhiteboardPlanIssues(plan(), compile(partial));
    expect(issues.some((issue) => issue.includes('教学目标分析') || issue.includes('goal'))).toBe(true);
    expect(plan().content).toEqual(['学习者分析：已有知识', '教学目标分析：评价标准']);
  });

  it.each([
    (value: ReturnType<typeof board>) => { value.steps[0].reveal = ['unknown']; },
    (value: ReturnType<typeof board>) => { value.diagram.panels[0].relations![0].to = 'missing-node'; },
    (value: ReturnType<typeof board>) => { value.diagram.panels[0].nodes[1].key = 'learner'; },
  ])('retains invalid structure as an audit diagnostic instead of accepting a generic whiteboard %#', (breakBoard) => {
    const invalid = board();
    breakBoard(invalid);
    const [normalized] = normalizeTeachingToolPlan([{ ...plan(), whiteboard: invalid }]);
    expect(normalized.content).toEqual(plan().content);
    expect(normalized.whiteboardValidationIssues?.length).toBeGreaterThan(0);
    expect(normalizeTeachingToolPlan([normalized])).toEqual([normalized]);
    const generic: Action[] = [{ id: 'generic', type: 'wb_draw_text', content: '学习者分析已有知识教学目标分析评价标准', x: 40, y: 40, fontSize: 24 }];
    expect(findWhiteboardPlanIssues(normalized, generic).length).toBeGreaterThan(0);
    expect(findMissingRequiredTeachingTools({ teachingToolPlan: [normalized] }, { sceneType: 'slide', actions: generic })).toEqual(['whiteboard']);
    const repaired = normalizeTeachingToolPlan([{ ...normalized, whiteboard: board() }]);
    expect(repaired[0].whiteboardValidationIssues).toBeUndefined();
    expect(findWhiteboardPlanIssues(repaired[0], compile())).toEqual([]);
  });

  it('detects an extra early reveal while allowing later emphasis to revisit the same native text', () => {
    const actions = compile();
    const goalId = whiteboardDiagramElementId('diagram', 'goal');
    const target = actions.find((action) => action.type === 'wb_draw_text' && action.elementId === goalId)!;
    // A later correct redraw cannot conceal an earlier visible leak.
    const early = { ...target, id: 'diagram:premature-goal', ...at('学习者分析') } as Action;
    const firstGoal = actions.findIndex((action) => action === target);
    const leaked = [...actions.slice(0, firstGoal), early, ...actions.slice(firstGoal)];
    expect(findWhiteboardPlanIssues(plan(), leaked)).toContainEqual(expect.stringContaining('提前展示'));
    expect(findWhiteboardPlanIssues(plan(), actions)).toEqual([]);
  });

  it('validates a revisit anchor even when the object is already emphasized and no redraw is needed', () => {
    const value = board();
    value.steps.push({ reveal: [], emphasize: ['prior'], ...at('不存在的再次讲解') });
    const malformed = { ...plan(), whiteboard: value };
    expect(findWhiteboardPlanIssues(malformed, compile())).toContainEqual(expect.stringContaining('不存在的再次讲解'));
  });

  it('rejects a relationship shown before its endpoints, despite a correct later copy', () => {
    const actions = compile();
    const link = actions.find((action) => action.type === 'wb_draw_line' && action.elementId === whiteboardDiagramElementId('diagram', 'supports-goal'))!;
    const early = { ...link, id: 'diagram:premature-link', ...at('学习者分析') } as Action;
    const firstDraw = actions.findIndex((action) => action.type === 'wb_draw_text' && action.elementId?.includes(':diagram:'));
    const leaked = [...actions.slice(0, firstDraw), early, ...actions.slice(firstDraw)];
    expect(findWhiteboardPlanIssues(plan(), leaked)).toContainEqual(expect.stringContaining('端点显示之前'));
  });

  it('reports unreadable text, a lost emphasis mark and an incorrect return anchor', () => {
    const actions = compile();
    const unreadable = actions.map((action) => action.type === 'wb_draw_text' && action.elementId?.endsWith(':prior')
      ? { ...action, fontSize: 18 } : action);
    expect(findWhiteboardPlanIssues(plan(), unreadable)).toContainEqual(expect.stringContaining('文字过小'));
    const noEmphasis = actions.filter((action) => !('elementId' in action && action.elementId?.endsWith(':emphasis')));
    expect(findWhiteboardPlanIssues(plan(), noEmphasis).length).toBeGreaterThan(0);
    const wrongExit = actions.map((action) => action.type === 'wb_close' ? { ...action, ...at('再看已有知识') } : action);
    expect(findWhiteboardPlanIssues(plan(), wrongExit)).toContainEqual(expect.stringContaining('wb_close'));
  });

  it('does not let the diagram replace an original required teaching fact', () => {
    const required = { ...plan(), content: [...plan().content, '身体学习能力'] };
    expect(findWhiteboardPlanIssues(required, compile())).toContainEqual(expect.stringContaining('身体学习能力'));
  });

  it('keeps original anchors valid after TTS splitting and disambiguates repeated phrases by chunk position', () => {
    const text = `学习者分析。${'甲'.repeat(1015)}。学习者分析。再做教学目标分析。再看已有知识，最后进入实施阶段。`;
    const original = board();
    original.steps[0].speechAnchor = { quote: '学习者分析', occurrence: 1 } as typeof original.steps[0]['speechAnchor'];
    const originalPlan = { ...plan(), whiteboard: original };
    const actions = [...compileWhiteboardDiagram({ id: 'diagram', ...original }).actions, { id: 'speech', type: 'speech' as const, text }];
    const split = splitLongSpeechActions(actions, 'glm-tts');
    expect(split.filter((action) => action.type === 'speech')).toHaveLength(2);
    expect(findWhiteboardPlanIssues(originalPlan, split)).toEqual([]);
    const shifted = split.map((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('diagram', 'learner')
      ? { ...action, speechId: 'speech_tts_1', speechAnchor: { quote: '学习者分析', occurrence: 0 } } : action);
    expect(findWhiteboardPlanIssues(originalPlan, shifted).length).toBeGreaterThan(0);
  });
});
