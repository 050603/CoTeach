import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from '../src/scene-generator.js';
import { compileMeasuredDiagramComponent, DiagramAllocationError } from '../src/diagram-compiler.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { TextMeasure } from '../src/text-layout-compiler.js';
import type { AICallFn } from '../src/index.js';

const measure: TextMeasure = ({ text, fontSize, padding, lineHeight }) => ({
  naturalWidth: [...text].reduce((width, char) => width + fontSize * (/\s/u.test(char) ? 0.25 : /[\dA-Za-z?]/u.test(char) ? 0.5 : 1), 0),
  height: padding * 2 + fontSize * lineHeight, lines: [text],
});
const page: SceneOutline = { id: 'first-pass', type: 'slide', title: '完整关系', description: '关系及解释保持完整', keyPoints: [], order: 0,
  presentationTypography: { bodyFontSize: 18, minimumBodyFontSize: 16, titleFontSize: 32, minimumTitleFontSize: 28 } };
const branch = { topology: 'branch' as const,
  nodes: [{ id: 'new-info', label: '新信息' }, { id: 'compatible', label: '与原有认知结构相容？' },
    { id: 'assimilation', label: '同化：融入现有结构' }, { id: 'accommodation', label: '顺应：调整或重塑结构' }, { id: 'understanding', label: '新的理解' }],
  edges: [{ from: 'new-info', to: 'compatible' }, { from: 'compatible', to: 'assimilation', label: '相容' },
    { from: 'compatible', to: 'accommodation', label: '冲突或不兼容' },
    { from: 'assimilation', to: 'understanding' }, { from: 'accommodation', to: 'understanding' }] };
const stages = ['教学目标分析', '情境创设', '信息资源设计', '自主学习设计', '协作学习环境设计', '学习效果评价设计', '强化练习设计'];
const sequence = { topology: 'sequence' as const, nodes: stages.map((label, i) => ({ id: `step${i + 1}`, label: `${i + 1} ${label}` })),
  edges: stages.slice(1).map((_, i) => ({ from: `step${i + 1}`, to: `step${i + 2}` })) };

describe('native diagrams in the original single-response generation path', () => {
  it('keeps complete canonical branches while leaving a source explanation caption to restored page authoring', async () => {
    const plan = { ...branch, annotation: '完整解释的原文证据，不必重复成为图内大段文字。' };
    const outline = { ...page, visualIntent: { representation: 'native-diagram' as const,
      observationGoal: '完整分支及条件', diagram: plan } };
    const ai = vi.fn<AICallFn>(async () => JSON.stringify({ elements: [{ id: 'explanation', type: 'text',
      left: 520, top: 128, width: 420, height: 150, content: '<p>同化融入现有结构，冲突时通过顺应调整结构。</p>' }],
    components: [{ type: 'diagram', id: 'relationship', left: 60, top: 120, width: 420, height: 350,
      annotation: '相容与冲突带来不同路径' }] }));
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true,
      preserveNativeComposition: true, nativeDesignBaseline: '4615a98d', textMeasure: measure });
    if (!result || !('elements' in result)) throw new Error('Expected usable restored native page');
    expect(ai).toHaveBeenCalledOnce();
    expect(result.elements.filter((element) => element.id.includes('-node-'))).toHaveLength(branch.nodes.length);
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(branch.edges.length);
    const caption = result.elements.find((element) => element.id.endsWith('-annotation'));
    expect(caption?.type === 'text' ? caption.content.replace(/<[^>]+>/gu, '') : '').toBe('相容与冲突带来不同路径');
    expect(JSON.stringify(result.elements)).not.toContain(plan.annotation);
    expect(ai.mock.calls[0]?.[1]).toContain(plan.annotation);
    expect(outline.visualIntent.diagram).toEqual(plan);
    // Keeping the caption does not license an overflowing review grid when
    // the same complete graph receives an insufficient local allocation.
    await expect(compileMeasuredDiagramComponent({ ...branch, type: 'diagram', id: 'too-short',
      left: 60, top: 120, width: 420, height: 300, annotation: '相容与冲突带来不同路径' }, measure,
    { nodeFontSize: 18, preserveNativeComposition: true })).rejects.toBeInstanceOf(DiagramAllocationError);
  });

  it('compiles the same narrow seven-step response once while retaining the authored right-hand explanations', async () => {
    const plan = { topology: 'sequence' as const, nodes: stages.map((label, index) => ({ id: `step${index + 1}`, label })),
      edges: stages.slice(1).map((_, index) => ({ from: `step${index + 1}`, to: `step${index + 2}` })) };
    const outline = { ...page, visualIntent: { representation: 'native-diagram' as const,
      observationGoal: '七步完整顺序', diagram: plan } };
    const external = [
      { id: 'title', type: 'text', left: 60, top: 50, width: 880, height: 64,
        content: '<p style="font-size:28px">建构主义学习环境下的七步教学设计步骤</p>' },
      ...stages.map((label, index) => ({ id: `row${index + 1}`, type: 'text', left: 273, top: 180 + 47 * index,
        width: 661, height: 46, content: `<p style="font-size:16px">${index + 1} ${label}：保留原稿对应解释。</p>` })),
    ];
    const response = JSON.stringify({ elements: external,
      components: [{ type: 'diagram', id: 'seven', left: 60, top: 180, width: 185, height: 332, ...plan }] });
    const ai = vi.fn<AICallFn>(async () => response);
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true,
      nativeDesignBaseline: '4615a98d', textMeasure: measure });
    if (!result || !('elements' in result)) throw new Error('Expected a locally measured native diagram');
    expect(ai).toHaveBeenCalledOnce();
    for (const element of external) expect(result.elements.find((current) => current.id === element.id)).toMatchObject(element);
    const nodes = result.elements.filter((element) => element.type === 'shape' && element.id.includes('-node-'));
    expect(nodes.map((node) => node.type === 'shape' ? node.text?.content.replace(/<[^>]+>/gu, '') : '')).toEqual(stages);
    expect(nodes.every((node) => node.type === 'shape' && node.height === 42.5
      && node.top >= 180 && node.top + node.height <= 512)).toBe(true);
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(outline.visualIntent.diagram).toEqual(plan);
  });

  it.each([
    { plan: branch, presentation: 'cards', left: 60, top: 106, width: 420, height: 288 },
    { plan: sequence, presentation: 'steps', left: 60, top: 128, width: 240, height: 327 },
  ] as const)('compiles the live $presentation allocation without changing the page or growing outside its region', async ({ plan, presentation, ...rect }) => {
    const outline = { ...page, visualIntent: { representation: 'native-diagram' as const, observationGoal: '完整顺序、分叉与汇合', diagram: plan } };
    const ai = vi.fn(async () => JSON.stringify({ elements: [
      { id: 'heading', type: 'text', left: 60, top: 50, width: 880, height: 46, content: '<p style="font-size:30px">完整关系</p>' },
      { id: 'explanation', type: 'text', left: 520, top: 128, width: 420, height: 150, content: '<p style="font-size:18px">保留首次创作的独立解释区域。</p>' },
    ], components: [{ kind: 'diagram', id: 'authored-graph', orientation: 'vertical', presentation, ...rect }] }));
    const failure = vi.fn();
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true, textMeasure: measure, onFailure: failure });
    expect(ai).toHaveBeenCalledOnce();
    expect(failure).not.toHaveBeenCalled();
    if (!result || !('elements' in result)) throw new Error('Expected original native composition');
    expect(result.elements).toContainEqual(expect.objectContaining({ id: 'explanation', left: 520, top: 128, width: 420 }));
    expect(result.qualityDiagnostics ?? []).not.toContainEqual(expect.stringMatching(/not fit|retaining the complete graph|allocations overlap|collision/u));
    expect(result.elements.filter((el) => el.id.startsWith('first-pass-component-0-node-'))).toHaveLength(plan.nodes.length);
    expect(result.elements.filter((el) => el.id.startsWith('first-pass-component-0-edge-') && el.type === 'line')).toHaveLength(plan.edges.length);
    if (presentation === 'steps') for (const node of plan.nodes) {
      expect(result.contentBindings).toContainEqual({ sourceContentId: `diagram-node:${node.id}`, elementId: `first-pass-component-0-node-${node.id}` });
      expect(result.contentBindings).toContainEqual({ sourceContentId: `diagram-node:${node.id}`, elementId: `first-pass-component-0-number-${node.id}` });
    }
    for (const el of result.elements.filter((el) => el.id.startsWith('first-pass-component-0-') && el.type !== 'line')) {
      expect(el.left).toBeGreaterThanOrEqual(rect.left);
      expect(el.top).toBeGreaterThanOrEqual(rect.top);
      expect(el.left + el.width).toBeLessThanOrEqual(rect.left + rect.width + 0.5);
      expect(el.top + ('height' in el ? el.height : 0)).toBeLessThanOrEqual(rect.top + rect.height + 0.5);
    }
  });

  it('supplies reproducible measurements for the chosen orientation, presentation, font and full caption before the only model call', async () => {
    const plan = { ...sequence, annotation: '依照真实顺序执行，各阶段都有独立职责。' };
    const outline = { ...page, visualIntent: { representation: 'native-diagram' as const, observationGoal: '完整七阶段', diagram: plan } };
    const ai = vi.fn(async (_system: string, prompt: string) => {
      const entries = JSON.parse(prompt.match(/Measured complete diagram space references, scoped by rendering profile: (\[[^\n]*\])/u)![1]) as Array<{
        width: number; height: number; orientation: 'vertical' | 'horizontal'; presentation: 'cards' | 'steps'; nodeFontSize: number; annotationIncluded: boolean;
      }>;
      expect(entries.length).toBeGreaterThan(0);
      expect(entries.some((entry) => entry.presentation === 'steps' && entry.orientation === 'vertical' && entry.annotationIncluded)).toBe(true);
      expect(entries.some((entry) => entry.presentation === 'steps' && entry.orientation === 'vertical' && !entry.annotationIncluded)).toBe(true);
      for (const { nodeFontSize, annotationIncluded, ...entry } of entries) {
        expect(nodeFontSize).toBe(18);
        await expect(compileMeasuredDiagramComponent({ ...plan, annotation: annotationIncluded ? plan.annotation : undefined,
          type: 'diagram', id: 'measured', left: 50, top: 140, ...entry }, measure,
        { nodeFontSize, preserveNativeComposition: true })).resolves.toBeInstanceOf(Array);
      }
      const selected = entries.find((entry) => entry.orientation === 'vertical' && entry.presentation === 'steps' && entry.annotationIncluded)!;
      return JSON.stringify({ elements: [], components: [{ kind: 'diagram', id: 'seven-stages', left: 50, top: 140, ...selected }] });
    });
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true, textMeasure: measure,
      responseAuthoringContent: (response) => ({ response, content: [] }) });
    expect(ai).toHaveBeenCalledOnce();
    if (!result || !('elements' in result)) throw new Error('Expected native single-response slide');
    expect(result.qualityDiagnostics ?? []).toEqual([]);
  });
});
