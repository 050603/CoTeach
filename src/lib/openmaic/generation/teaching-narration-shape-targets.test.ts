import { describe, expect, it, vi } from 'vitest';
import type { PPTElement, PPTShapeElement, TeachingVisualComponent } from '@openmaic/dsl';
import type { DiagramPlan, TextMeasure } from '@openmaic/generation/browser';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { compileAdoptedGrid } from './teaching-visual-adopted-grid';
import { extractVisibleElementText } from './semantic-visual-cues';
import { auditSlideDensity } from './slide-layout-audit';
import {
  compileTeachingNarrationActions,
  generateTeachingSectionNarration,
  normalizeTeachingNarration,
} from './teaching-narration';

const facts = [
  '只有A < B时才逐个撤除支持；不能一次性撤销。',
  '比较实际值与预期值，保留A & B两个条件。',
  '在同一修复范围内重新运行检查。',
  '检查相关回归后再结束。',
];
const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => ({
  naturalWidth: text.length * fontSize * 0.7,
  height: Math.max(1, Math.ceil(text.length * fontSize * 0.7 / (width - padding * 2)))
    * fontSize * lineHeight + padding * 2,
  lines: [text],
});

async function gridFixture() {
  const graph: DiagramPlan = { topology: 'sequence', nodes: [
    { id: 'reproduce', label: '重现问题' }, { id: 'inspect', label: '核对条件' },
    { id: 'fix', label: '修复并复查' }, { id: 'finish', label: '回归检查' },
  ], edges: [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' }, { from: 'fix', to: 'finish' }] };
  const component: TeachingVisualComponent = { id: 'grid', kind: 'process', useAdoptedDiagram: true,
    nodes: facts.map((text, index) => ({ id: `note-${index + 1}`, text, anchorId: graph.nodes[index]!.id,
      sourceContentIds: [`adopted-content-${index + 1}`] })) };
  const result = await compileAdoptedGrid(component, graph, { left: 44, top: 112, width: 912, height: 420.5 }, measure);
  if (!result) throw new Error('The complete native grid fixture must fit');
  const outline: SceneOutline = { id: 'page-grid', type: 'slide', title: '观察完整条件', description: facts.join(''),
    order: 0, keyPoints: facts, audience: 'student', generationPurpose: 'knowledge-teaching',
    visualIntent: { representation: 'native-diagram', observationGoal: '沿真实顺序观察条件', diagram: graph } };
  const content: GeneratedSlideContent = { elements: result.elements,
    presentationProjection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
      items: component.nodes.map((node) => ({ id: node.id, text: node.text!, sourceContentIds: node.sourceContentIds })),
      elementIdsBySource: result.mapping },
    teachingVisual: { scene: { schemaVersion: 1, designVersion: 'teaching-visual-v2', pages: [{ id: outline.id,
      title: outline.title, focus: '观察完整条件与真实顺序', components: [component] }] },
    pageId: outline.id, candidateId: 'native-grid-test', compilerVersion: 'test', themeVersion: 'test', adoptedDiagram: graph,
    sourceCatalog: facts.map((text, index) => ({ id: `adopted-content-${index + 1}`, text })),
    components: [{ id: component.id, kind: component.kind, elementIds: result.elements.map((element) => element.id),
      sourceContentIds: component.nodes.flatMap((node) => node.sourceContentIds) }] } };
  const plates = content.elements.filter((element): element is PPTShapeElement => element.type === 'shape');
  return { graph, component, outline, content, plates };
}

function narrationFor(outline: SceneOutline, index = 0, target?: { elementId: string; selector?: { quote: string } }) {
  const semanticId = `${outline.id}:visible-${index + 1}`;
  return normalizeTeachingNarration({ pageId: outline.id, segments: [{
    text: '现在观察这个条件，再解释它为什么决定下一步。', semanticIds: [semanticId],
    anchors: [{ semanticId, quote: '观察这个条件', visualCue: {
      type: 'spotlight', necessity: 'helpful', ...(target ? { target } : {}),
    } }],
  }] }, outline);
}

async function authoringPrompt(pages: Array<{ outline: SceneOutline; content: GeneratedSlideContent }>) {
  const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: pages.map(({ outline }) => ({
    pageId: outline.id, segments: [{ text: '按照已核实的条件解释当前对象。', semanticIds: [`${outline.id}:teaching`] }],
  })) }));
  await generateTeachingSectionNarration({ sectionId: 'native-grid-section', pages,
    requirements: { requirement: '解释真实条件' }, aiCall });
  expect(aiCall).toHaveBeenCalledOnce();
  return JSON.parse(aiCall.mock.calls[0]![1]) as { pages: Array<{
    actualSlide: { elements: Array<{ id: string; text?: string; content?: string }> };
    continuityContract: { previousActualVisibleEvidence?: string[] };
  }> };
}

function alias(plate: PPTShapeElement, id: string): PPTShapeElement {
  return { id, type: 'shape', left: plate.left, top: plate.top, width: plate.width, height: plate.height, rotate: 0,
    viewBox: [plate.width, plate.height], path: 'M0 0H100V100H0Z', fixedRatio: false, fill: 'none', opacity: 0 };
}

describe('native grid text in independently sourced teaching narration', () => {
  it('projects the complete actual shape labels and notes, with decoded symbols and paragraph boundaries', async () => {
    const { outline, content, plates } = await gridFixture();
    const before = structuredClone(content);
    const prompt = await authoringPrompt([{ outline, content }]);
    for (const plate of plates) {
      const actual = prompt.pages[0]!.actualSlide.elements.find((element) => element.id === plate.id);
      expect(actual?.text).toBe(extractVisibleElementText(plate));
      expect(actual?.text).toContain('\n');
      expect(actual?.text).not.toMatch(/<p\b|&lt;|&amp;/u);
    }
    expect(prompt.pages[0]!.actualSlide.elements.find((element) => element.id === 'grid-node-reproduce')?.text)
      .toContain(facts[0]);
    expect(content).toEqual(before);
  });

  it('uses the real prior shape copy as the next page visible evidence without inventing source facts', async () => {
    const { outline, content, plates } = await gridFixture();
    const next: SceneOutline = { ...outline, id: 'page-next', title: '解释检查结果', order: 1 };
    const prompt = await authoringPrompt([{ outline, content }, { outline: next, content: { elements: [] } }]);
    expect(prompt.pages[1]!.continuityContract.previousActualVisibleEvidence)
      .toEqual(plates.map(extractVisibleElementText));
    for (const [index, node] of outline.visualIntent!.diagram!.nodes.entries()) {
      const plate = plates.find((element) => element.id === `grid-node-${node.id}`)!;
      expect(content.presentationProjection!.elementIdsBySource[`diagram-node:${node.id}`]).toEqual([plate.id]);
      expect(content.presentationProjection!.elementIdsBySource[`adopted-content-${index + 1}`]).toEqual([plate.id]);
    }
  });

  it('does not promote a hidden native shape into actual visible copy or next-page evidence', async () => {
    const { outline, content, plates } = await gridFixture();
    const hiddenId = plates[0]!.id;
    const hiddenContent = { ...content, elements: content.elements.map((element) => element.id === hiddenId
      ? { ...plates[0]!, opacity: 0 } : element) };
    const next: SceneOutline = { ...outline, id: 'page-next', title: '解释检查结果', order: 1 };
    const prompt = await authoringPrompt([{ outline, content: hiddenContent }, { outline: next, content: { elements: [] } }]);
    expect(prompt.pages[0]!.actualSlide.elements.find((element) => element.id === hiddenId)?.text).toBeUndefined();
    expect(prompt.pages[1]!.continuityContract.previousActualVisibleEvidence)
      .toEqual(plates.slice(1).map(extractVisibleElementText));
  });

  it.each([0, 1, 2, 3])('binds complete native shape statement %i when no exact semantic ID or direct target exists', async (index) => {
    const { outline, content, plates } = await gridFixture();
    const narration = narrationFor(outline, index);
    const result = compileTeachingNarrationActions({ outline, content, narration });
    expect(result.issues).toEqual([]);
    expect(result.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'spotlight', elementId: plates[index]!.id,
        speechAnchor: { quote: '观察这个条件', occurrence: 0 } }),
      expect.objectContaining({ type: 'speech', text: narration.segments[0]!.text }),
    ]));
  });

  it('supports a real direct shape target and exact note selector without requiring speech to repeat the label', async () => {
    const { outline, content, plates } = await gridFixture();
    const narration = narrationFor(outline, 0, { elementId: plates[0]!.id, selector: { quote: facts[0]! } });
    const result = compileTeachingNarrationActions({ outline, content, narration });
    expect(result.issues).toEqual([]);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'spotlight', elementId: plates[0]!.id,
      selector: { quote: facts[0] }, speechAnchor: { quote: '观察这个条件', occurrence: 0 } }));
    expect(result.actions.filter((action) => action.type === 'speech').map((action) => action.text))
      .toEqual(narration.segments.map((segment) => segment.text));
  });

  it('preserves both comparison signs and the complete negation when matching a shape condition', async () => {
    const { outline, content, plates } = await gridFixture();
    const wording = '只有 A < B 且 C > D 时继续；不能一次性撤销。';
    const conditionalOutline = { ...outline, keyPoints: [wording] };
    const first = plates[0]!;
    const complete = { ...first, text: { ...first.text!, content:
      '<p>条件</p><p>只有 A &lt; B 且 C &gt; D 时继续；不能一次性撤销。</p>' } };
    const replace = (plate: PPTShapeElement) => ({ ...content, elements: content.elements.map((element) => element.id === first.id ? plate : element) });
    const narration = narrationFor(conditionalOutline);
    const result = compileTeachingNarrationActions({ outline: conditionalOutline, content: replace(complete), narration });
    expect(result.issues).toEqual([]);
    expect(result.actions).toContainEqual(expect.objectContaining({ type: 'spotlight', elementId: first.id }));
    const incomplete = { ...complete, text: { ...complete.text, content: '<p>只有 A &lt; B 且 C &gt; D 时继续。</p>' } };
    const omitted = compileTeachingNarrationActions({ outline: conditionalOutline, content: replace(incomplete), narration });
    expect(omitted.actions).toEqual([{ id: narration.segments[0]!.id, type: 'speech', text: narration.segments[0]!.text }]);
    expect(omitted.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-element-binding' })]));
  });

  it('keeps the established exact-ID and transparent region-alias priority for legacy playback', async () => {
    const { outline, content, plates } = await gridFixture();
    const id = `${outline.id}:visible-1`;
    const legacy: PPTElement = { type: 'text', id, left: 44, top: 112, width: 220, height: 64, rotate: 0,
      content: '<p>已确认的精炼改写</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#334155' };
    for (const exact of [legacy, alias(plates[0]!, id)]) {
      const result = compileTeachingNarrationActions({ outline, content: { ...content, elements: [...content.elements, exact] },
        narration: narrationFor(outline) });
      expect(result.issues).toEqual([]);
      expect(result.actions).toContainEqual(expect.objectContaining({ type: 'spotlight', elementId: id }));
    }
  });

  it('omits ambiguous, hidden or incomplete shape matches locally and leaves the authored speech intact', async () => {
    const { outline, content, plates } = await gridFixture();
    const first = plates[0]!, rest = content.elements.filter((element) => element.id !== first.id);
    const incomplete = { ...first, text: { ...first.text!, content: '<p>只有A &lt; B时才逐个撤除支持。</p>' } };
    const variants = [
      [...content.elements, { ...first, id: 'duplicate-visible-plate' }],
      [...rest, { ...first, opacity: 0 }],
      [...rest, incomplete],
    ];
    const narration = narrationFor(outline);
    for (const elements of variants) {
      const result = compileTeachingNarrationActions({ outline, content: { ...content, elements }, narration });
      expect(result.actions).toEqual([{ id: narration.segments[0]!.id, type: 'speech', text: narration.segments[0]!.text }]);
      expect(result.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing-element-binding', severity: 'warning' })]));
    }
  });

  it('never uses source mappings or empty transparent aliases as visible factual coverage', async () => {
    const { outline, content, plates } = await gridFixture();
    const missingCopy = { ...content, elements: [
      ...content.elements.map((element) => element.type === 'shape' ? { ...element, text: undefined } : element),
      ...plates.map((plate, index) => alias(plate, `${outline.id}:visible-${index + 1}`)),
    ] };
    const audit = auditSlideDensity(outline, missingCopy);
    expect(audit.underrepresentedKeyPoints.length).toBeGreaterThan(0);
    expect(audit.semanticStructureSatisfied).toBe(false);
    expect(missingCopy.presentationProjection).toBe(content.presentationProjection);
  });
});
