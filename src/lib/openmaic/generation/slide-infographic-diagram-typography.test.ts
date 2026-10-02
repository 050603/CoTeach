import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PPTLineElement, PPTShapeElement, SlidePresentationProjection } from '@openmaic/dsl';
import type { DiagramPlan, TextMeasure } from '@openmaic/generation';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { compileOriginalSlideDraft, compileSlideInfographic } from './slide-infographic-layout';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

const fonts = { nodeFontSize: 20, edgeFontSize: 18 };
const branch: DiagramPlan = { topology: 'branch', nodes: [
  { id: 'condition', label: '支持需要吗' }, { id: 'retain', label: '继续支持' }, { id: 'withdraw', label: '逐个撤除' },
], edges: [{ from: 'condition', to: 'retain', label: '需要' }, { from: 'condition', to: 'withdraw', label: '能独立完成' }] };
const source = { id: 'condition', text: '能独立完成时才逐个撤除支持，不能等到最后一次性撤销。' };
const outline = (graph: DiagramPlan): SceneOutline => ({ id: 'page', title: '支持的退出条件', type: 'slide', order: 0,
  description: '保留实际教学关系与必要条件', keyPoints: [source.text],
  visualIntent: { representation: 'native-diagram', observationGoal: '观察实际节点与分支', diagram: graph } });
const strip = (html: string) => html.replace(/<br\s*\/?\s*>/giu, '\n').replace(/<[^>]+>/gu, '')
  .replace(/&lt;/gu, '<').replace(/&gt;/gu, '>').replace(/&amp;/gu, '&');
const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const units = (value: string) => [...value].reduce((sum, char) => sum + (/[\u2E80-\u9FFF]/u.test(char) ? 1 : 0.55), 0);
  const available = Math.max(fontSize, width - padding * 2);
  const lineCount = text.split('\n').reduce((count, line) => count + Math.max(1, Math.ceil(units(line) * fontSize / available)), 0);
  return { naturalWidth: Math.max(...text.split('\n').map((line) => units(line) * fontSize)),
    height: lineCount * fontSize * lineHeight + padding * 2, lines: [text] };
};
const nodes = (content: GeneratedSlideContent) => content.elements.filter((element): element is PPTShapeElement =>
  element.type === 'shape' && Boolean(element.text));
const edgeLabels = (content: GeneratedSlideContent) => content.elements.filter((element) =>
  element.type === 'text' && /-edge-label-/.test(element.id));
const typography = (html: string) => Number(html.match(/font-size\s*:\s*([\d.]+)px/iu)![1]);
afterAll(closeSpatialMeasurementBrowser);

describe('original graph typography and honest fallback geometry', () => {
  it('keeps legacy defaults when the new graph option is omitted', async () => {
    const result = await compileOriginalSlideDraft(outline(branch), [source], { measure });
    expect(nodes(result).map((node) => typography(node.text!.content))).toEqual([20, 20, 20]);
    expect(edgeLabels(result).map((element) => element.type === 'text' && typography(element.content))).toEqual([16, 16]);
  });

  it('uses the same explicit fractional fonts during allocation, compilation and final native measurement', async () => {
    const spy = vi.fn(measure), graph = structuredClone(branch), before = structuredClone(graph);
    const result = await compileOriginalSlideDraft(outline(graph), [source], { measure: spy, bodyFontSize: 20,
      diagramTypography: { nodeFontSize: 20.5, edgeFontSize: 18.5 } });
    expect(graph).toEqual(before);
    expect(nodes(result).map((node) => typography(node.text!.content))).toEqual([20.5, 20.5, 20.5]);
    expect(edgeLabels(result).map((element) => element.type === 'text' && typography(element.content))).toEqual([18.5, 18.5]);
    expect(spy.mock.calls.filter(([request]) => request.text === '需要').every(([request]) => request.fontSize === 18.5)).toBe(true);
    expect(spy.mock.calls.filter(([request]) => request.text === '支持需要吗').every(([request]) => request.fontSize === 20.5)).toBe(true);
    expect(spy.mock.calls.some(([request]) => request.text === '需要' && request.width < 10000 && request.preserveRichText)).toBe(true);
    expect(result.qualityDiagnostics).toEqual([]);
    expect(result.presentationProjection!.elementIdsBySource['diagram-node:condition']).toEqual(['original-diagram-node-condition']);
  });

  it('supports the same explicit teaching minimum on a verified infographic', async () => {
    const projection: SlidePresentationProjection = { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
      items: [{ id: 'visible-condition', text: source.text, sourceContentIds: [source.id] }], elementIdsBySource: {} };
    const result = await compileSlideInfographic(outline(branch), projection, { measure, bodyFontSize: 20, diagramTypography: fonts });
    expect(result).not.toBeNull();
    expect(nodes(result!).map((node) => typography(node.text!.content))).toEqual([20, 20, 20]);
    expect(edgeLabels(result!).map((element) => element.type === 'text' && typography(element.content))).toEqual([18, 18]);
    expect(strip((result!.elements.find((element) => element.id === 'visible-condition') as { content: string }).content)).toBe(source.text);
  });

  it('retains a real feedback graph and its exit without inventing a finish-to-start edge', async () => {
    const graph: DiagramPlan = { topology: 'cycle', nodes: [
      { id: 'reproduce', label: 'Reproduce' }, { id: 'inspect', label: 'Inspect' }, { id: 'fix', label: 'Fix and rerun' }, { id: 'finish', label: 'Finish' },
    ], edges: [{ from: 'reproduce', to: 'inspect' }, { from: 'inspect', to: 'fix' },
      { from: 'fix', to: 'inspect', label: 'Still fails' }, { from: 'fix', to: 'finish', label: 'Check passes' }] };
    const saved = structuredClone(graph);
    const result = await compileOriginalSlideDraft(outline(graph), [source], { measure, bodyFontSize: 20, diagramTypography: fonts });
    const connectors = result.elements.filter((element): element is PPTLineElement => element.type === 'line');
    const objects = nodes(result);
    const touches = (point: number[], node: PPTShapeElement) => point[0]! >= node.left - 3 && point[0]! <= node.left + node.width + 3
      && point[1]! >= node.top - 3 && point[1]! <= node.top + node.height + 3;
    expect(graph).toEqual(saved);
    expect(connectors).toHaveLength(4);
    for (const edge of graph.edges!) {
      const from = objects.find((node) => node.id === `original-diagram-node-${edge.from}`)!;
      const to = objects.find((node) => node.id === `original-diagram-node-${edge.to}`)!;
      expect(connectors.some((line) => line.points[1] === 'arrow'
        && touches([line.left + line.start[0], line.top + line.start[1]], from)
        && touches([line.left + line.end[0], line.top + line.end[1]], to))).toBe(true);
    }
    expect(edgeLabels(result).map((element) => element.type === 'text' && strip(element.content))).toEqual(expect.arrayContaining(['Still fails', 'Check passes']));
  });

  it('preserves historical implicit rings without dropping their final return', async () => {
    const graph: DiagramPlan = { topology: 'cycle', nodes: [{ id: 'a', label: '观察' }, { id: 'b', label: '行动' }, { id: 'c', label: '反思' }] };
    const result = await compileOriginalSlideDraft(outline(graph), [source], { measure, diagramTypography: fonts });
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(3);
    expect(nodes(result).map((node) => strip(node.text!.content))).toEqual(['观察', '行动', '反思']);
  });

  it('keeps complete long labels, relations and quantities with explicit clipping diagnostics at the requested font', async () => {
    const graph = { ...branch, nodes: branch.nodes.map((node, index) => ({ ...node,
      label: index === 0 ? 'Only after independently completing at least 18 observable tasks under the stated condition '.repeat(3) : node.label })) };
    const sources = [{ id: 'full-condition', text: source.text.repeat(120) }];
    const result = await compileOriginalSlideDraft(outline(graph), sources, { measure, bodyFontSize: 20,
      diagramTypography: { nodeFontSize: 22, edgeFontSize: 18 } });
    expect(strip(nodes(result)[0]!.text!.content)).toBe(graph.nodes[0]!.label);
    expect(nodes(result).every((node) => typography(node.text!.content) === 22)).toBe(true);
    expect(edgeLabels(result).every((element) => element.type === 'text' && typography(element.content) === 18)).toBe(true);
    expect(result.qualityDiagnostics?.some((detail) => detail.includes('original-diagram-node-condition') && detail.includes('at 22px'))).toBe(true);
    expect(result.qualityDiagnostics?.some((detail) => detail.includes('beyond the safe bottom'))).toBe(true);
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(2);
    expect(result).not.toHaveProperty('continuationPages');
  });

  it('diagnoses horizontal glyph clipping even when the reported text height fits', async () => {
    const measured: TextMeasure = async (input) => ({ ...await measure(input),
      ...(input.width < 1000 && input.text === '需要' ? { inkRight: input.width + 12 } : {}) });
    const result = await compileOriginalSlideDraft(outline(branch), [source], { measure: measured, diagramTypography: fonts });
    expect(result.qualityDiagnostics).toEqual(expect.arrayContaining([expect.stringContaining('visible text reaches x=')]));
  });

  it('propagates actual measurement failures instead of turning them into a successful fallback', async () => {
    const failure = new Error('Actual Chromium font service unavailable');
    const measured: TextMeasure = async (input) => { if (input.fontSize === fonts.nodeFontSize) throw failure; return measure(input); };
    await expect(compileOriginalSlideDraft(outline(branch), [source], { measure: measured, diagramTypography: fonts })).rejects.toBe(failure);
    const invalid: TextMeasure = async (input) => ({ ...await measure(input), ...(input.width < 1000 && input.text === '需要' ? { inkRight: NaN } : {}) });
    await expect(compileOriginalSlideDraft(outline(branch), [source], { measure: invalid, diagramTypography: fonts })).rejects.toThrow('invalid geometry');
  });

  it('uses actual browser glyph measurements to retain readable native branch labels at 18px', async () => {
    const result = await compileOriginalSlideDraft(outline(branch), [source], { measure: measureAuthoredSlideText,
      bodyFontSize: 20, diagramTypography: fonts });
    expect(result.qualityDiagnostics).toEqual([]);
    expect(edgeLabels(result).map((element) => element.type === 'text' && typography(element.content))).toEqual([18, 18]);
    for (const node of nodes(result)) {
      const actual = await measureAuthoredSlideText({ html: node.text!.content, text: strip(node.text!.content),
        width: node.width, fontSize: 20, fontWeight: 700, fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.25,
        paragraphSpace: 0, align: 'center', preserveRichText: true });
      expect(Math.max(actual.height, actual.inkBottom ?? 0)).toBeLessThanOrEqual(node.height + 0.5);
      expect(node.top + node.height).toBeLessThanOrEqual(512.5);
    }
  }, 30_000);
});
