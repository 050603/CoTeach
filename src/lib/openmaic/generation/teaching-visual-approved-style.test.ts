import { afterAll, describe, expect, it } from 'vitest';
import type { PPTElement, PPTLineElement, PPTShapeElement, PPTTextElement, TeachingVisualComponent, TeachingVisualIcon, TeachingVisualScene } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { compileTeachingVisualScene } from './teaching-visual-compiler';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideDensity } from './slide-layout-audit';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { slideVisualSourceContent } from './slide-visual-projection';

afterAll(closeSpatialMeasurementBrowser);

function outline(facts: string[]): SceneOutline {
  return { id: 'approved-style', type: 'slide', title: '观察真实关系', order: 0, description: facts.join('。'),
    keyPoints: facts, audience: 'student', generationPurpose: 'knowledge-teaching', targetDurationSec: 97,
    teachingBrief: { schemaVersion: 1, explanation: facts.join('。'), examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '理解对象及其关系', priorKnowledge: '', newContent: facts.join('。'), learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: facts, presentationContent: facts, narrationFocus: facts } } };
}
function scene(components: TeachingVisualComponent[], title: string): TeachingVisualScene {
  return { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: 'approved-style', title,
    focus: title, components }] };
}
function compile(page: SceneOutline, visual: TeachingVisualScene) {
  return compileTeachingVisualScene(page, visual, { measure: measureAuthoredSlideText, sourceCatalog: slideVisualSourceContent(page) });
}
function plain(html: string): string {
  return html.replace(/<br\s*\/?>/giu, '\n').replace(/<[^>]+>/gu, '').replace(/&(amp|lt|gt|quot);/gu,
    (_, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"' })[entity as 'amp']);
}
function displayed(elements: PPTElement[]): string[] {
  return elements.flatMap((element) => element.type === 'text' ? [plain(element.content)]
    : element.type === 'shape' ? [plain(element.text?.content ?? '')]
      : element.type === 'table' ? element.data.flat().map((cell) => plain(cell.text)) : []);
}
function visibleText(content: GeneratedSlideContent, id: string): PPTTextElement {
  const element = content.elements.find((item) => item.id === id);
  expect(element?.type, id).toBe('text');
  if (element?.type !== 'text') throw new Error(`Missing native text ${id}`);
  expect(element.opacity ?? 1, id).toBeGreaterThan(0);
  return element;
}
function nativeShape(content: GeneratedSlideContent, id: string): PPTShapeElement {
  const element = content.elements.find((item) => item.id === id);
  expect(element?.type, id).toBe('shape');
  if (element?.type !== 'shape') throw new Error(`Missing editable shape ${id}`);
  expect(element.opacity ?? 1, id).toBeGreaterThan(0);
  return element;
}
function point(line: PPTLineElement, endpoint: 'start' | 'end') {
  return { x: line.left + line[endpoint][0], y: line.top + line[endpoint][1] };
}
function expectReadableNative(content: GeneratedSlideContent) {
  expect(content.elements.some((element) => element.type === 'text')).toBe(true);
  for (const element of content.elements) {
    if (element.type !== 'line') {
      expect(element.top, element.id).toBeGreaterThanOrEqual(0);
      expect(element.top + element.height, element.id).toBeLessThanOrEqual(532.5);
      expect(element.left, element.id).toBeGreaterThanOrEqual(0);
      expect(element.left + element.width, element.id).toBeLessThanOrEqual(1000);
    }
    for (const [, size] of JSON.stringify(element).matchAll(/font-size:\s*([\d.]+)px/gu)) {
      expect(Number(size), element.id).toBeGreaterThanOrEqual(18);
    }
  }
}
function processFixture(reverse = false) {
  const labels = ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'];
  const shortNotes = ['最近发展区\n概念框架、分层支架', '生活中的问题\n范例与问题分解', '由引导走向自主',
    '共享观点\n启发、完善理解', '检验学习成效'];
  const facts = [...shortNotes, '先引导，再探索；充足的时间与空间；按水平和阶段提供个性化支架',
    '自评 · 小组互评 · 教师评价', '自主学习能力 · 协作贡献 · 意义建构'];
  const page = outline(facts);
  page.visualIntent = { representation: 'native-diagram', observationGoal: '五个真实环节及局部条件', diagram: {
    topology: 'sequence', nodes: labels.map((label, i) => ({ id: `c${i + 1}`, label })),
    edges: labels.slice(1).map((_, i) => ({ from: `c${i + 1}`, to: `c${i + 2}` })),
  } };
  const icons: TeachingVisualIcon[] = ['layers', 'context', 'book', 'people', 'checklist'];
  const main: TeachingVisualComponent = { id: 'process', kind: 'process', role: 'primary', useAdoptedDiagram: true,
    nodes: shortNotes.map((text, i) => ({ id: `note-${i + 1}`, label: labels[i], text, icon: icons[i], anchorId: `c${i + 1}`,
      sourceContentIds: [`adopted-content-${i + 1}`] })) };
  const exploration: TeachingVisualComponent = { id: 'exploration', kind: 'text', role: 'support', anchorNodeId: 'c3', title: '探索中的支持',
    nodes: [{ id: 'exploration-conditions', label: '先引导，再探索', text: '充足的时间与空间\n按水平和阶段提供个性化支架', sourceContentIds: ['adopted-content-6'] }] };
  const evaluation: TeachingVisualComponent = { id: 'evaluation', kind: 'text', role: 'support', anchorNodeId: 'c5', nodes: [
    { id: 'evaluation-actors', label: '谁来评', text: facts[6], sourceContentIds: ['adopted-content-7'] },
    { id: 'evaluation-criteria', label: '评什么', text: facts[7], sourceContentIds: ['adopted-content-8'] },
  ] };
  return { page, visual: scene(reverse ? [evaluation, exploration, main] : [main, exploration, evaluation], '支架式教学的五个环节'), labels };
}

describe('approved teaching visual style with renderer font measurement', () => {
  it.each([false, true])('keeps the five-step icon axis and locates support by ownership, even with reversed components: %s', async (reverse) => {
    const { page, visual, labels } = processFixture(reverse);
    const original = structuredClone(visual);
    const result = await compile(page, visual);
    expect(result).not.toBeNull();
    if (!result) throw new Error('The approved short-label process should fit one readable page');
    expect(result.continuationPages ?? []).toHaveLength(0);
    expect(visual).toEqual(original);
    expect(result.background).toEqual({ type: 'solid', color: '#FFFFFF' });
    expectReadableNative(result);
    const plates = labels.map((label, i) => {
      const plate = nativeShape(result, `process-node-c${i + 1}`);
      const caption = visibleText(result, `${plate.id}:label`);
      expect(plain(caption.content)).toBe(label);
      expect(caption.top).toBeGreaterThanOrEqual(plate.top + plate.height);
      expect(Math.abs(caption.left + caption.width / 2 - plate.left - plate.width / 2)).toBeLessThanOrEqual(1);
      const glyph = nativeShape(result, `${plate.id}:icon`);
      expect(glyph.path).toBeTruthy();
      expect(glyph.left).toBeGreaterThanOrEqual(plate.left);
      expect(glyph.top).toBeGreaterThanOrEqual(plate.top);
      expect(glyph.left + glyph.width).toBeLessThanOrEqual(plate.left + plate.width);
      expect(glyph.top + glyph.height).toBeLessThanOrEqual(plate.top + plate.height);
      expect(result.presentationProjection?.elementIdsBySource[`diagram-node:c${i + 1}`]).toEqual(expect.arrayContaining([plate.id, caption.id]));
      return plate;
    });
    const arrows = result.elements.filter((element): element is PPTLineElement => element.type === 'line');
    expect(arrows).toHaveLength(4);
    for (let i = 0; i < arrows.length; i++) {
      const arrow = arrows.find((element) => element.id === `process-edge-${i}`)!;
      expect(arrow, `adjacent relationship ${i}`).toBeDefined();
      const from = plates[i]!, to = plates[i + 1]!, start = point(arrow, 'start'), end = point(arrow, 'end');
      expect(arrow.points).toEqual(['', 'arrow']);
      expect(Math.abs(start.y - end.y)).toBeLessThanOrEqual(1);
      expect(Math.abs(start.y - from.top - from.height / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(end.y - to.top - to.height / 2)).toBeLessThanOrEqual(1);
      expect(start.x).toBeGreaterThanOrEqual(from.left + from.width);
      expect(end.x).toBeLessThanOrEqual(to.left);
      expect(start.x).toBeLessThan(end.x);
      expect(start.x - from.left - from.width).toBeLessThan(from.width / 4);
      expect(to.left - end.x).toBeLessThan(to.width / 4);
    }
    const exploration = nativeShape(result, 'exploration:panel'), evaluation = nativeShape(result, 'evaluation:panel');
    expect(exploration.left + exploration.width).toBeLessThanOrEqual(evaluation.left);
    expect(exploration.top).toBe(evaluation.top);
    expect(exploration.height).toBe(evaluation.height);
    expect(exploration.width).toBe(evaluation.width);
    expect(exploration.top).toBeGreaterThan(plates[2]!.top + plates[2]!.height);
    expect(evaluation.top).toBeGreaterThan(plates[4]!.top + plates[4]!.height);
    expect(exploration.top - Math.max(...result.elements.filter((element): element is PPTTextElement =>
      element.type === 'text' && element.groupId === 'process').map((element) => element.top + element.height))).toBeLessThan(60);
    expect(visibleText(result, 'evaluation-actors').top).toBeLessThan(visibleText(result, 'evaluation-criteria').top);
    for (const component of visual.pages[0]!.components) for (const node of component.nodes) {
      const native = result.elements.filter((element) => result.presentationProjection?.elementIdsBySource[node.sourceContentIds[0]!]!.includes(element.id));
      expect(displayed(native).join('\n').replace(/\s/gu, '')).toContain(node.text!.replace(/\s/gu, ''));
    }
    expect(auditSlideDensity(page, result).underrepresentedKeyPoints).toEqual([]);
    expect(auditSlideDensity(page, result).semanticStructureSatisfied).toBe(true);
    const lostCaption = structuredClone(result);
    lostCaption.elements = lostCaption.elements.filter((element) => element.id !== 'process-node-c4:label');
    expect(auditSlideDensity(page, lostCaption).underrepresentedKeyPoints).toContainEqual({ keyPoint: '协作学习', coverage: 0 });
    const lostFact = structuredClone(result);
    lostFact.elements = lostFact.elements.filter((element) => element.id !== 'evaluation-criteria');
    expect(auditSlideDensity(page, lostFact).underrepresentedKeyPoints.length).toBeGreaterThan(0);
  }, 20_000);

  it('keeps one learner across qualitative support states and makes the negative takeaway visibly distinct', async () => {
    const facts = ['暂时性：帮助跨越最近发展区', '渐消性：随能力提升逐个撤除', '能独立解决问题时撤离', '逐个撤除，不能等到最后一次性撤销'];
    const page = outline(facts);
    const visual = scene([
      { id: 'states', kind: 'state-change', role: 'primary', nodes: [
        { id: 'supported', label: '需要支持', text: facts[0], sourceContentIds: ['adopted-content-1'], supportLevel: 'present' },
        { id: 'fading', label: '能力逐步提升', text: facts[1], sourceContentIds: ['adopted-content-2'], supportLevel: 'fading' },
        { id: 'independent', label: '能够独立解决', text: facts[2], sourceContentIds: ['adopted-content-3'], supportLevel: 'withdrawn' },
      ], edges: [{ from: 'supported', to: 'fading', kind: 'sequence' }, { from: 'fading', to: 'independent', kind: 'sequence' }] },
      { id: 'boundary', kind: 'text', role: 'takeaway', nodes: [{ id: 'negative', text: facts[3], sourceContentIds: ['adopted-content-4'] }] },
    ], '支架如何逐步撤除');
    const result = await compile(page, visual);
    expect(result).not.toBeNull();
    if (!result) throw new Error('The approved qualitative states should fit');
    expect(result.continuationPages ?? []).toHaveLength(0);
    expectReadableNative(result);
    expect(result.elements.some((element) => ['chart', 'image', 'video'].includes(element.type))).toBe(false);
    const identities = ['supported', 'fading', 'independent'];
    const bodies = identities.map((id) => nativeShape(result, `${id}:learner`));
    const heads = identities.map((id) => nativeShape(result, `${id}:head`));
    for (const parts of [bodies, heads]) for (const part of parts.slice(1)) {
      const original = parts[0]!;
      expect({ path: part.path, width: part.width, height: part.height, fill: part.fill })
        .toEqual({ path: original.path, width: original.width, height: original.height, fill: original.fill });
    }
    expect(bodies[0]!.left).toBeLessThan(bodies[1]!.left);
    expect(bodies[1]!.left).toBeLessThan(bodies[2]!.left);
    const full = nativeShape(result, 'supported:support'), faded = nativeShape(result, 'fading:support');
    expect(faded.opacity ?? 1).toBeLessThan(full.opacity ?? 1);
    expect(faded.outline?.style).toBe('dashed');
    expect(result.elements.some((element) => element.id === 'independent:support')).toBe(false);
    const arrows = result.elements.filter((element): element is PPTLineElement => element.type === 'line' && element.points.includes('arrow'));
    expect(arrows).toHaveLength(2);
    for (const arrow of arrows) expect(point(arrow, 'start').x).toBeLessThan(point(arrow, 'end').x);
    const negative = visibleText(result, 'negative'), panel = nativeShape(result, 'boundary:panel');
    expect(plain(negative.content)).toBe(facts[3]);
    expect(negative.content).toMatch(/font-weight:\s*700|<strong/u);
    expect(panel.fill).not.toBe('#FFFFFF');
    expect(negative.top).toBeGreaterThan(bodies[0]!.top + bodies[0]!.height);
    expect(displayed(result.elements).join('')).toContain('非固定发展阶段');
    expect(auditSlideDensity(page, result).underrepresentedKeyPoints).toEqual([]);
  }, 20_000);

  it.each([3, 18])('preserves long explanations at readable size or returns a capacity miss, without clipping or silently editing: %s clauses', async (count) => {
    const { page, visual } = processFixture();
    const main = visual.pages[0]!.components.find((component) => component.role === 'primary')!;
    const long = Array.from({ length: count }, (_, index) => `条件${index + 1}要求教师根据学生当前水平安排必要引导，并给予充足的时间与空间自主探索，不能在学生尚未独立解决问题时一次性撤掉支持。`).join('');
    main.nodes[2]!.text = long;
    page.keyPoints[2] = long;
    page.teachingBrief!.teachingPlan!.presentationContent = [...page.keyPoints];
    page.teachingBrief!.teachingPlan!.visibleContent = [...page.keyPoints];
    const unchanged = structuredClone({ page, visual });
    const result = await compile(page, visual);
    expect({ page, visual }).toEqual(unchanged);
    if (!result) return; // The caller retains its usable draft for a measured miss.
    const pages = [result, ...(result.continuationPages ?? [])];
    expect(pages.length).toBeLessThanOrEqual(3);
    pages.forEach(expectReadableNative);
    const text = displayed(pages.flatMap((part) => part.elements)).join('\n').replace(/\s/gu, '');
    expect(text).toContain(long);
    for (const component of visual.pages[0]!.components) for (const node of component.nodes) {
      expect(text, node.id).toContain(node.text!.replace(/\s/gu, ''));
    }
    const expanded = expandCompiledSlidePages(page, result);
    expect(expanded.reduce((sum, part) => sum + part.outline.targetDurationSec!, 0)).toBe(97);
    const graphHosts = expanded.filter((part) => part.outline.visualIntent?.diagram);
    expect(graphHosts).toHaveLength(1);
    for (const part of expanded) expect(auditSlideDensity(part.outline, part.content).underrepresentedKeyPoints).toEqual([]);
  }, 20_000);
});
