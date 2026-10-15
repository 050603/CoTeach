import { describe, expect, it } from 'vitest';
import type { Action, WbDrawTextAction } from '../types/action';
import {
  compileWhiteboardDiagram, parseWhiteboardDiagram, whiteboardDiagramElementId, whiteboardDiagramKeyEntries,
  type WhiteboardDiagram, type WhiteboardDiagramStep,
} from './diagram';
import { auditWhiteboardLayout } from './layout';
import { normalizeWhiteboardActionLayout } from '../generation/whiteboard-layout';

const binding = (quote: string) => ({ speechId: 'speech', speechAnchor: { quote, occurrence: 0 } });
const step = (quote: string, reveal: string[], emphasize?: string[]): WhiteboardDiagramStep => ({ ...binding(quote), reveal, ...(emphasize ? { emphasize } : {}) });
const compile = (diagram: WhiteboardDiagram, steps?: WhiteboardDiagramStep[]) => compileWhiteboardDiagram({
  id: 'lesson-board', title: '课堂板书', diagram,
  steps: steps ?? [step('全部', whiteboardDiagramKeyEntries(diagram).map((entry) => entry.key))], exit: binding('结束'),
});
const textAction = (actions: Action[], key: string): WbDrawTextAction => actions.find((action): action is WbDrawTextAction =>
  action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', key))!;

const branches: WhiteboardDiagram = { panels: [{ key: 'interaction-panel', kind: 'branches', nodes: [
  { key: 'hub', label: '交互活动', role: 'focus', icon: 'body' },
  { key: 'goal', label: '目标', icon: 'target', lines: [{ key: 'goal-rule', text: '具体、可达成' }] },
  { key: 'task', label: '任务', icon: 'task', lines: [{ key: 'task-rule', text: '围绕内容、激发兴趣' }] },
  { key: 'strategy', label: '策略', icon: 'strategy', lines: [{ key: 'strategy-rule', text: '方法＋工具＋身体动作' }] },
  { key: 'community', label: '共同体', icon: 'group', lines: [{ key: 'community-rule', text: '按兴趣、能力、需求分组' }] },
], relations: ['goal', 'task', 'strategy', 'community'].map((key) => ({ key: `hub-${key}`, from: 'hub', to: key, kind: 'branch' })) }] };

describe('teacher whiteboard diagram compiler', () => {
  it('strictly parses the semantic shape without pruning duplicate keys or invalid endpoints', () => {
    expect(parseWhiteboardDiagram(branches)).toEqual(branches);
    const duplicate = structuredClone(branches);
    duplicate.panels[0].nodes[1].lines![0].key = 'hub';
    expect(parseWhiteboardDiagram(duplicate)).toBeUndefined();
    const invalid = structuredClone(branches);
    invalid.panels[0].relations![0].to = 'goal-rule';
    expect(parseWhiteboardDiagram(invalid)).toBeUndefined();
    expect(compile(invalid).issues).toEqual(expect.arrayContaining([expect.stringContaining('不存在的关系端点')]));
  });

  it('reserves a complete four-branch composition and reveals only requested native objects', () => {
    const result = compile(branches, [step('中心', ['hub']), step('目标', ['goal', 'goal-rule', 'hub-goal'], ['goal-rule']),
      step('任务', ['task', 'task-rule', 'hub-task']), step('策略', ['strategy', 'strategy-rule', 'hub-strategy']),
      step('共同体', ['community', 'community-rule', 'hub-community'])]);
    expect(result.issues).toEqual([]);
    const first = result.actions.filter((action) => action.speechAnchor.quote === '中心');
    expect(first.some((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'hub'))).toBe(true);
    expect(first.some((action) => 'elementId' in action && action.elementId === whiteboardDiagramElementId('lesson-board', 'goal'))).toBe(false);
    expect(first.some((action) => action.type === 'wb_draw_line')).toBe(false);
    expect(result.actions.findIndex((action) => action.type === 'wb_draw_line' && action.elementId === whiteboardDiagramElementId('lesson-board', 'hub-goal')))
      .toBeGreaterThan(result.actions.findIndex((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'goal')));
    expect(result.actions.filter((action) => action.type === 'wb_draw_text').every((action) => action.fontSize! >= 24)).toBe(true);
    expect(result.actions.filter((action) => action.type === 'wb_draw_image').every((action) => action.src.startsWith('data:image/svg+xml'))).toBe(true);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
  });

  it('fits learner/content convergence and preserves full conditions and explicit arrows', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'analysis', kind: 'converge', nodes: [
      { key: 'learner', label: '学习者（身心特征）', role: 'source', icon: 'person', lines: [
        { key: 'interest', text: '人工智能兴趣' }, { key: 'knowledge', text: '已有知识' }, { key: 'ability', text: '身体动作学习能力' },
      ] },
      { key: 'content', label: '教学内容', role: 'source', icon: 'book', lines: [
        { key: 'suitable', text: '适合具身活动的AI概念与技能' }, { key: 'understand', text: '更易理解与掌握' },
      ] },
      { key: 'goal', label: '教学目标', role: 'focus', icon: 'target', lines: [
        { key: 'guiding', text: '指导性' }, { key: 'operable', text: '可操作性' },
      ] },
      { key: 'design', label: '活动设计依据', role: 'result', icon: 'task' },
      { key: 'evaluation', label: '评价标准', role: 'result', icon: 'check' },
    ], relations: [
      { key: 'learner-goal', from: 'learner', to: 'goal', kind: 'supports' },
      { key: 'content-goal', from: 'content', to: 'goal', kind: 'supports' },
      { key: 'goal-design', from: 'goal', to: 'design', kind: 'supports' },
      { key: 'goal-evaluation', from: 'goal', to: 'evaluation', kind: 'supports' },
    ] }] };
    const result = compile(diagram);
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'wb_clear')).toHaveLength(1);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    expect(textAction(result.actions, 'goal').x).toBeGreaterThan(textAction(result.actions, 'learner').x);
    expect(textAction(result.actions, 'design').x).toBeGreaterThan(textAction(result.actions, 'goal').x);
    expect(result.visibleTextByKey.suitable).toBe('适合具身活动的AI概念与技能');
  });

  it('fits two body/environment panels on one board with a true case sequence and parallel environment details', () => {
    const diagram: WhiteboardDiagram = { panels: [
      { key: 'body', title: '身体：概念与体验相结合', kind: 'branches', nodes: [
        { key: 'concept', label: '关键概念', icon: 'book' }, { key: 'experience', label: '身体体验', icon: 'body' },
        { key: 'game', label: '分类游戏', icon: 'task' }, { key: 'algorithm', label: '体验算法原理' }, { key: 'pattern', label: '理解模式识别' },
      ], relations: [
        { key: 'integration', from: 'concept', to: 'experience', kind: 'association' },
        { key: 'first', from: 'game', to: 'algorithm', kind: 'sequence' },
        { key: 'next', from: 'algorithm', to: 'pattern', kind: 'sequence' },
      ] },
      { key: 'environment', title: '环境：三个并列层面', kind: 'branches', nodes: [
        { key: 'environment-design', label: '环境设计', icon: 'environment', lines: [
          { key: 'physical', text: '物理环境' }, { key: 'social', text: '社会环境' }, { key: 'rules', text: '规范环境' },
        ] },
      ] },
    ] };
    const result = compile(diagram);
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'wb_clear')).toHaveLength(1);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    const lines = result.actions.filter((action) => action.type === 'wb_draw_line');
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.points)).toEqual([['', ''], ['', 'arrow'], ['', 'arrow']]);
  });

  it('uses native 24px text for a progressively constructed evaluation dimension table', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'evaluation', kind: 'matrix', nodes: [
      { key: 'focus', label: '围绕教学目标', role: 'focus', icon: 'target', lines: [
        { key: 'multiple', text: '多元评价策略' }, { key: 'application', text: '重点：新知识用于实际情境' },
      ] },
      { key: 'form', label: '评价方式', icon: 'check', lines: [
        { key: 'summative', text: '总结性评价' }, { key: 'formative', text: '形成性评价' },
      ] },
      { key: 'reviewers', label: '参与主体', icon: 'group', lines: [
        { key: 'self', text: '自我反思' }, { key: 'peer', text: '同伴互评' }, { key: 'teacher', text: '教师评定' },
      ] },
      { key: 'method', label: '评价方法', icon: 'strategy', lines: [
        { key: 'data', text: '量化：数据' }, { key: 'experience', text: '质性：学习过程与身体体验' },
      ] },
    ] }] };
    const result = compile(diagram, [step('目标', ['focus', 'multiple']), step('应用', ['application']),
      step('方式', ['form', 'summative', 'formative']), step('主体', ['reviewers', 'self', 'peer', 'teacher']),
      step('方法', ['method', 'data', 'experience'])]);
    expect(result.issues).toEqual([]);
    expect(result.actions.some((action) => action.type === 'wb_draw_table')).toBe(false);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    expect(result.actions.filter((action) => action.speechAnchor.quote === '目标')
      .some((action) => 'elementId' in action && action.elementId?.includes('form'))).toBe(false);
  });

  it('diagnoses early links, waits for both endpoints, and reports every omitted key', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'panel', kind: 'branches', nodes: [
      { key: 'a', label: '概念' }, { key: 'b', label: '体验', lines: [{ key: 'detail', text: '身体参与' }] },
    ], relations: [{ key: 'link', from: 'a', to: 'b', kind: 'association' }] }] };
    const result = compile(diagram, [step('先讲概念', ['a', 'link']), step('再讲体验', ['b'])]);
    expect(result.issues).toEqual(expect.arrayContaining([expect.stringContaining('两端节点显示前'), expect.stringContaining('detail 没有有效显示步骤')]));
    expect(result.actions.filter((action) => action.type === 'wb_draw_line').map((action) => action.speechAnchor.quote)).toEqual(['再讲体验']);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
  });

  it('moves blue emphasis by deleting the previous marker while retaining readable content', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'panel', kind: 'branches', nodes: [
      { key: 'a', label: '学习者', lines: [{ key: 'interest', text: '兴趣' }, { key: 'knowledge', text: '已有知识' }] },
    ] }] };
    const result = compile(diagram, [step('学习者', ['a']), step('兴趣', ['interest']), step('知识', ['knowledge'], [])]);
    expect(result.actions.filter((action) => action.type === 'wb_delete').map((action) => action.elementId))
      .toEqual([`${whiteboardDiagramElementId('lesson-board', 'a')}:emphasis`, `${whiteboardDiagramElementId('lesson-board', 'interest')}:emphasis`]);
    expect(result.actions.filter((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'a'))).toHaveLength(1);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
  });

  it('aligns blue underlines with centered body/example labels and native left-aligned flow text', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'body', kind: 'branches', nodes: [
      { key: 'concept', label: '关键概念', icon: 'book' }, { key: 'experience', label: '身体体验', icon: 'body' },
      { key: 'game', label: '分类游戏（机器学习）', icon: 'task' },
      { key: 'algorithm', label: '体验算法原理' }, { key: 'pattern', label: '理解模式识别' },
      { key: 'environment', label: '环境', lines: [{ key: 'physical', text: '物理环境' }] },
    ], relations: [
      { key: 'association', from: 'concept', to: 'experience', kind: 'association' },
      { key: 'first', from: 'game', to: 'algorithm', kind: 'sequence' },
      { key: 'next', from: 'algorithm', to: 'pattern', kind: 'sequence' },
    ] }] };
    const result = compile(diagram, [step('身体', ['concept', 'experience', 'association']), step('分类', ['game']),
      step('算法', ['algorithm', 'first']), step('模式', ['pattern', 'next']), step('环境', ['environment', 'physical'], ['physical'])]);
    expect(result.issues).toEqual([]);
    for (const key of ['concept', 'experience', 'game', 'algorithm', 'pattern']) {
      const label = textAction(result.actions, key);
      const mark = result.actions.find((action) => action.type === 'wb_draw_image'
        && action.elementId === `${whiteboardDiagramElementId('lesson-board', key)}:emphasis`)!;
      expect(mark.type).toBe('wb_draw_image');
      if (mark.type !== 'wb_draw_image') continue;
      expect(label.content).toContain('text-align:center');
      expect(mark.x + mark.width / 2).toBeCloseTo(label.x + label.width! / 2, 8);
      expect(mark.x).toBeGreaterThanOrEqual(label.x + 10);
      expect(mark.x + mark.width).toBeLessThanOrEqual(label.x + label.width! - 10);
      expect(mark.y).toBe(label.y + label.height! + 1);
    }
    const physical = textAction(result.actions, 'physical');
    const flowMark = result.actions.find((action) => action.type === 'wb_draw_image'
      && action.elementId === `${whiteboardDiagramElementId('lesson-board', 'physical')}:emphasis`);
    expect(flowMark).toMatchObject({ x: physical.x + 10, width: 4 * 24, y: physical.y + physical.height! + 1 });
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    const wrapped: WhiteboardDiagram = { panels: [{ key: 'wrapped', kind: 'branches', nodes: [
      { key: 'long', label: '需要换行并完整保留的关键概念和必要条件' }, { key: 'short', label: '身体体验' },
    ], relations: [{ key: 'association', from: 'long', to: 'short', kind: 'association' }] }] };
    const wrappedResult = compile(wrapped);
    const wrappedLabel = textAction(wrappedResult.actions, 'long');
    const wrappedMark = wrappedResult.actions.find((action) => action.type === 'wb_draw_image'
      && action.elementId === `${whiteboardDiagramElementId('lesson-board', 'long')}:emphasis`);
    expect(wrappedLabel.height).toBeGreaterThan(59);
    expect(wrappedMark).toMatchObject({ x: wrappedLabel.x + 10, width: wrappedLabel.width! - 20 });
    expect(auditWhiteboardLayout(wrappedResult.actions)).toEqual([]);
  });

  it('clears at complete panel boundaries and preserves overflowing complete facts with a real diagnostic', () => {
    const diagram: WhiteboardDiagram = { panels: Array.from({ length: 2 }, (_, panel) => ({
      key: `panel-${panel}`, kind: 'branches', nodes: Array.from({ length: 5 }, (_, node) => ({
        key: `${panel}-${node}`, label: `维度${node}`, lines: [{ key: `${panel}-${node}-detail`, text: '完整的教学内容' }],
      })),
    })) };
    const result = compile(diagram, diagram.panels.map((panel) => step(panel.key, whiteboardDiagramKeyEntries({ panels: [panel] }).map((entry) => entry.key))));
    expect(result.actions.filter((action) => action.type === 'wb_clear')).toHaveLength(2);
    expect(result.issues).toEqual([]);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    const overloaded: WhiteboardDiagram = { panels: [{ key: 'too-large', kind: 'branches', nodes: [{ key: 'node', label: '条件',
      lines: [{ key: 'all-facts', text: '必要条件必须保留。'.repeat(100) }] }] }] };
    const overflow = compile(overloaded);
    expect(overflow.issues.some((issue) => issue.includes('超出单板容量'))).toBe(true);
    expect(textAction(overflow.actions, 'all-facts').content).toContain('必要条件必须保留。'.repeat(100));
    expect(textAction(overflow.actions, 'all-facts').fontSize).toBe(24);
  });

  it('uses deterministic encoded IDs and retains the complete composition through layout normalization', () => {
    const first = compile(branches);
    expect(first).toEqual(compile(branches));
    expect(new Set(first.actions.map((action) => action.id)).size).toBe(first.actions.length);
    expect(whiteboardDiagramElementId('board', 'a"[b]')).toBe('board:diagram:a%22%5Bb%5D');
    const normalized = normalizeWhiteboardActionLayout(first.actions);
    for (const key of ['hub', 'goal', 'goal-rule', 'community-rule']) {
      expect(textAction(normalized, key)).toMatchObject({ x: textAction(first.actions, key).x, y: textAction(first.actions, key).y,
        width: textAction(first.actions, key).width, height: textAction(first.actions, key).height, fontSize: textAction(first.actions, key).fontSize });
    }
  });

  it('continues an oversized independent hub diagram by complete child rows and only repeats taught hub context', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'analysis', title: '前期分析三维度', kind: 'branches', nodes: [
      { key: 'hub', label: '前期分析', role: 'focus', icon: 'target', lines: [
        { key: 'hub-context', text: '依据学生与内容' }, { key: 'hub-later', text: '条件与标准' },
      ] },
      { key: 'learner', label: '学习者分析', icon: 'person', lines: [
        { key: 'learner-body', text: '身心特征' }, { key: 'learner-interest', text: '人工智能领域兴趣、已有知识' },
        { key: 'learner-action', text: '通过身体动作学习的能力' },
      ] },
      { key: 'content', label: '教学内容分析', icon: 'book', lines: [
        { key: 'content-what', text: '确定哪些人工智能概念和技能' }, { key: 'content-embodied', text: '通过具身活动更有效地理解掌握' },
      ] },
      { key: 'goal', label: '教学目标分析', icon: 'target', lines: [
        { key: 'goal-combine', text: '结合学习者特征和教学内容' }, { key: 'goal-operable', text: '目标具指导性、可操作' },
        { key: 'goal-standard', text: '为活动设计与评价设定标准' },
      ] },
    ], relations: ['learner', 'content', 'goal'].map((key) => ({ key: `hub-${key}`, from: 'hub', to: key, kind: 'branch' })) }] };
    const result = compile(diagram, [step('中心', ['hub', 'hub-context']),
      step('学习者', ['learner', 'hub-learner']), step('身心特征', ['learner-body']),
      step('兴趣知识', ['learner-interest']), step('动作能力', ['learner-action']),
      step('内容', ['content', 'hub-content']), step('内容范围', ['content-what']), step('具身适用', ['content-embodied']),
      step('目标', ['goal', 'hub-goal'], ['hub', 'goal']), step('分析依据', ['goal-combine']),
      step('目标要求', ['goal-operable']), step('标准', ['goal-standard', 'hub-later'])]);
    expect(result.issues).toEqual([]);
    const clears = result.actions.flatMap((action, index) => action.type === 'wb_clear' ? [index] : []);
    expect(clears).toHaveLength(2);
    const firstBoard = result.actions.slice(clears[0], clears[1]);
    const continuation = result.actions.slice(clears[1]);
    expect(firstBoard.some((action) => 'elementId' in action && action.elementId === whiteboardDiagramElementId('lesson-board', 'goal'))).toBe(false);
    expect(continuation.filter((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'hub')))
      .toEqual([expect.objectContaining({ speechAnchor: { quote: '目标', occurrence: 0 } })]);
    expect(continuation.filter((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'hub-context')))
      .toEqual([expect.objectContaining({ speechAnchor: { quote: '目标', occurrence: 0 } })]);
    const later = continuation.find((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'hub-later'));
    expect(later?.speechAnchor.quote).toBe('标准');
    expect(result.actions.find((action) => action.type === 'wb_draw_text' && action.elementId === whiteboardDiagramElementId('lesson-board', 'hub'))?.speechAnchor.quote).toBe('中心');
    expect(continuation.filter((action) => action.type === 'wb_draw_line').map((action) => action.elementId))
      .toEqual([whiteboardDiagramElementId('lesson-board', 'hub-goal')]);
    for (const entry of whiteboardDiagramKeyEntries(diagram).filter((entry) => entry.text)) expect(textAction(result.actions, entry.key).content).toContain(entry.text!);
    expect(result.actions.filter((action) => action.type === 'wb_draw_text').every((action) => action.fontSize! >= 24)).toBe(true);
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
  });

  it('does not cut relationships between children or split an individually oversized child', () => {
    const nodes = [{ key: 'hub', label: '中心', role: 'focus' as const }, ...Array.from({ length: 3 }, (_, index) => ({
      key: `child-${index}`, label: `维度${index}`, lines: Array.from({ length: 3 }, (_, line) => ({ key: `${index}-${line}`, text: '需要保留完整的学习条件和行为要求' })),
    }))];
    const complex: WhiteboardDiagram = { panels: [{ key: 'complex', kind: 'branches', nodes,
      relations: [{ key: 'child-link', from: 'child-0', to: 'child-1', kind: 'sequence' }] }] };
    const complexResult = compile(complex);
    expect(complexResult.actions.filter((action) => action.type === 'wb_clear')).toHaveLength(1);
    expect(complexResult.issues.some((issue) => issue.includes('超出单板容量'))).toBe(true);
    const indivisible = structuredClone(complex);
    indivisible.panels[0].relations = [{ key: 'hub-child', from: 'hub', to: 'child-0', kind: 'branch' }];
    indivisible.panels[0].nodes[1].lines = [{ key: 'large', text: '必要条件与完整事实。'.repeat(100) }];
    const oversized = compile(indivisible);
    expect(oversized.actions.filter((action) => action.type === 'wb_clear')).toHaveLength(2);
    expect(oversized.issues.some((issue) => issue.includes('超出单板容量'))).toBe(true);
    expect(textAction(oversized.actions, 'large').fontSize).toBe(24);
  });

  it('fits one complete long child by placing its full panel title in unused space above the repeated hub', () => {
    const diagram: WhiteboardDiagram = { panels: [{ key: 'core', title: '核心要素设计', kind: 'branches', nodes: [
      { key: 'hub', label: '核心要素设计', role: 'focus', icon: 'target' },
      { key: 'body', label: '身体设计', lines: [{ key: 'body-rule', text: '关键概念与身体体验结合' }] },
      { key: 'interaction', label: '交互设计', icon: 'group', lines: [
        { key: 'goal', text: '活动目标：具体、可达成，引导身体参与' },
        { key: 'task', text: '活动任务：围绕教学内容，有教育意义且激发兴趣' },
        { key: 'strategy', text: '活动策略：综合教学方法、工具、身体动作' },
        { key: 'community', text: '活动共同体：按兴趣、能力、需求分组，有效合作' },
      ] },
    ], relations: [{ key: 'hub-body', from: 'hub', to: 'body', kind: 'branch' },
      { key: 'hub-interaction', from: 'hub', to: 'interaction', kind: 'branch' }] }] };
    const steps = [step('中心', ['hub']), step('身体', ['body', 'body-rule', 'hub-body']),
      step('交互', ['interaction', 'hub-interaction']), step('目标', ['goal']), step('任务', ['task']),
      step('策略', ['strategy']), step('共同体', ['community'])];
    const result = compile(diagram, steps);
    expect(result.issues).toEqual([]);
    const clears = result.actions.flatMap((action, index) => action.type === 'wb_clear' ? [index] : []);
    expect(clears).toHaveLength(2);
    const continuation = result.actions.slice(clears[1]);
    const title = continuation.filter((action) => action.type === 'wb_draw_text')
      .find((action) => action.elementId === 'lesson-board:panel:core:title')!;
    const focus = textAction(continuation, 'hub');
    expect(title.content).toContain('核心要素设计');
    expect(title).toMatchObject({ width: 194, fontSize: 24 });
    expect(title.y + title.height! + 14).toBeLessThanOrEqual(focus.y);
    expect(textAction(continuation, 'interaction').y).toBe(title.y);
    expect(textAction(continuation, 'community').speechAnchor?.quote).toBe('共同体');
    expect(auditWhiteboardLayout(result.actions)).toEqual([]);
    const crowdedTitle = structuredClone(diagram);
    crowdedTitle.panels[0].title = '需要完整保留的长标题'.repeat(4);
    const rejected = compile(crowdedTitle, steps);
    expect(rejected.issues.some((issue) => issue.includes('超出单板容量'))).toBe(true);
    expect(textAction(rejected.actions, 'community').content).toContain('活动共同体：按兴趣、能力、需求分组，有效合作');
  });
});
