import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from '../src/scene-generator.js';
import { buildCompleteScene } from '../src/scene-builder.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { TextMeasure } from '../src/text-layout-compiler.js';

const outline: SceneOutline = {
  id: 'native-page', type: 'slide', title: '比较方法的条件', description: '依据资料选择合适方法。',
  keyPoints: ['比较方法'], order: 0,
  presentationTypography: { bodyFontSize: 18, minimumBodyFontSize: 16, titleFontSize: 32, minimumTitleFontSize: 28 },
};
const measure: TextMeasure = ({ text, fontSize, padding, lineHeight }) => {
  const lines = text.split(/\n/).filter(Boolean);
  return { naturalWidth: Math.max(...lines.map((line) => [...line].length * fontSize)),
    height: padding * 2 + lines.length * fontSize * lineHeight, lines };
};

describe('native display authoring and persisted content bindings', () => {
  it('adopts the response catalogue before resolving references and measuring in one model call', async () => {
    const content = [{ id: 'display-condition', text: '条件满足后，再选择方法。' },
      { id: 'display-feedback', text: '根据反馈调整设计。' }];
    const response = JSON.stringify({ displayItems: content, elements: [
      { id: 'explanation', type: 'text', left: 60, top: 140, width: 880, height: 130,
        paragraphRefs: content.map((item) => item.id), emphasis: [{ text: '条件', color: '#2563EB' }] },
    ] });
    const ai = vi.fn().mockResolvedValue(response);
    const adoption = vi.fn((raw: string) => ({ response: raw, content, diagnostics: ['资料精炼保留条件。'] }));
    const measured = vi.fn(measure);
    const failure = vi.fn();
    const slide = await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measured,
      authoringContent: [{ id: 'old-duty', text: '旧展示职责。' }], responseAuthoringContent: adoption, onFailure: failure });
    expect(ai).toHaveBeenCalledOnce();
    expect(adoption).toHaveBeenCalledExactlyOnceWith(response);
    expect(failure).not.toHaveBeenCalled();
    expect(slide).toMatchObject({ contentBindings: content.map((item) => ({ sourceContentId: item.id, elementId: 'explanation' })),
      qualityDiagnostics: expect.arrayContaining(['资料精炼保留条件。']) });
    const html = slide && 'elements' in slide && slide.elements[0].type === 'text' ? slide.elements[0].content : '';
    expect(html).toContain('<span style="color:#2563EB;font-weight:700">条件</span>');
    expect(html).toContain(content[1].text);
    expect(html).not.toContain('旧展示职责');
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 18,
      text: expect.stringContaining(content[0].text), html: expect.stringContaining('color:#2563EB') }));
    expect(slide).not.toHaveProperty('displayItems');
  });

  it('maps shape text, separate table cells and compiled grid slots to their actual playback targets', async () => {
    const points = [{ id: 'shape-point', text: '先明确适用条件。' }, { id: 'row', text: '反馈方式' },
      { id: 'column', text: '方法甲' }, { id: 'value', text: '依据反馈调整。' }, { id: 'grid', text: '完整的比较结论。' }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'callout', type: 'shape', left: 60, top: 140, width: 880, height: 60,
        text: { contentRef: 'shape-point' } },
      { id: 'comparison', type: 'table', left: 60, top: 215, width: 880, height: 60,
        colWidths: [0.3, 0.3, 0.4], cellMinHeight: 60,
        data: [[{ id: 'dimension', contentRef: 'row', rowspan: 1, colspan: 1 },
          { id: 'object', contentRef: 'column', rowspan: 1, colspan: 1 },
          { contentRef: 'value', rowspan: 1, colspan: 1 }]] },
    ], components: [{ kind: 'labelGrid', left: 60, top: 305, width: 880, height: 80,
      rows: [{ header: { contentRef: 'row' }, cells: [{ contentRef: 'grid' }] }] }] }));
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measure, authoringContent: points });
    if (!result || !('elements' in result)) throw new Error('Expected native slide');
    expect(result.contentBindings).toEqual([
      { sourceContentId: 'shape-point', elementId: 'callout' },
      { sourceContentId: 'row', elementId: 'comparison', selector: { cellId: 'dimension' } },
      { sourceContentId: 'column', elementId: 'comparison', selector: { cellId: 'object' } },
      { sourceContentId: 'value', elementId: 'comparison', selector: { cellId: 'comparison-cell-0-2' } },
      { sourceContentId: 'row', elementId: 'native-page-component-0-0-0-text' },
      { sourceContentId: 'grid', elementId: 'native-page-component-0-0-1-text' },
    ]);
    const table = result.elements.find((element) => element.type === 'table');
    expect(table && table.type === 'table' ? table.data[0][2] : null).toMatchObject({ id: 'comparison-cell-0-2', text: points[3].text });
    expect(JSON.stringify(result)).not.toContain('contentRef');
    expect(buildCompleteScene(outline, result, [], 'stage')).toMatchObject({ content: { canvas: { contentBindings: result.contentBindings } } });
  });

  it('keeps binding identities through emphasized component migration and duplicate authored IDs', async () => {
    const points = [{ id: 'a', text: '甲方式的条件。' }, { id: 'b', text: '乙方式的条件。' },
      { id: 'c', text: '关键条件须满足。' }, { id: 'd', text: '完整讲解仍保留。' }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'same', type: 'text', left: 60, top: 140, width: 400, height: 55, contentRef: 'a' },
      { id: 'same', type: 'text', left: 520, top: 140, width: 400, height: 55, contentRef: 'b' },
    ], components: [
      { kind: 'textBox', left: 60, top: 235, width: 880, contentRef: 'c', emphasis: ['关键条件'] },
      { kind: 'textBox', left: 60, top: 330, width: 880, contentRef: 'd' },
    ] }));
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measure, authoringContent: points });
    expect(result).toMatchObject({ contentBindings: [
      { sourceContentId: 'a', elementId: 'same' }, { sourceContentId: 'b', elementId: 'native-page-element-1' },
      { sourceContentId: 'c', elementId: 'native-page-component-0' }, { sourceContentId: 'd', elementId: 'native-page-component-1' },
    ] });
    expect(JSON.stringify(result)).toContain('<strong>关键条件</strong>');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('keeps distinct native and compiled targets when the author uses a compiler-generated cell ID', async () => {
    const points = [{ id: 'native', text: '原生正文。' }, { id: 'grid', text: '比较内容。' }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'native-page-component-0-0-0-text', type: 'text', left: 60, top: 140, width: 880, height: 70, contentRef: 'native' },
    ], components: [{ kind: 'labelGrid', left: 60, top: 250, width: 880, height: 100,
      rows: [{ cells: [{ contentRef: 'grid' }] }] }] }));
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, authoringContent: points, textMeasure: measure });
    expect(result).toMatchObject({ contentBindings: [
      { sourceContentId: 'native', elementId: 'native-page-component-0-0-0-text' },
      { sourceContentId: 'grid', elementId: 'native-page-component-0-2-0-0-text' },
    ] });
    if (!result || !('elements' in result)) throw new Error('Expected compiled slide');
    for (const point of points) {
      const target = result.elements.find((element) => element.id === result.contentBindings!.find((binding) => binding.sourceContentId === point.id)!.elementId);
      expect(target && target.type === 'text' ? target.content : '').toContain(point.text);
    }
  });

  it.each(['edge-0', 'edge-label-0', 'group-method-a', 'number-a'])('preserves the actual body target when its ID matches a compiled diagram %s', async (suffix) => {
    const diagram = suffix.startsWith('group')
      ? { topology: 'sequence' as const, nodes: [{ id: 'a1', label: '观察' }, { id: 'a2', label: '说明' },
        { id: 'b1', label: '提问' }, { id: 'b2', label: '实践' }],
        edges: [{ from: 'a1', to: 'a2' }, { from: 'b1', to: 'b2' }],
        sequenceGroups: [{ id: 'method-a', label: '第一种方法', nodeIds: ['a1', 'a2'] },
          { id: 'method-b', label: '第二种方法', nodeIds: ['b1', 'b2'] }] }
      : { topology: 'sequence' as const, nodes: [{ id: 'a', label: '开始' }, { id: 'b', label: '完成' }],
        edges: [{ from: 'a', to: 'b', label: '之后' }] };
    const nativeId = `native-page-component-0-${suffix}`;
    const point = { id: 'body', text: '这一整段正文必须绑定到真实说明。' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [{ id: nativeId, type: 'text',
      left: 60, top: 100, width: 880, height: 60, contentRef: point.id }],
    components: [{ kind: 'diagram', left: 60, top: 170, width: 880, height: 340,
      ...(suffix.startsWith('number') ? { orientation: 'vertical', presentation: 'steps' } : {}) }] }));
    const result = await generateSceneContent({ ...outline,
      visualIntent: { representation: 'native-diagram', observationGoal: '完整图示与正文各有实际归属。', diagram } }, ai,
    { componentAuthoring: true, preserveNativeComposition: true, textMeasure: measure, authoringContent: [point] });
    if (!result || !('elements' in result)) throw new Error('Expected native page');
    const target = result.elements.find((element) => element.id === result.contentBindings?.find((binding) => binding.sourceContentId === point.id)?.elementId);
    expect(target).toMatchObject({ id: nativeId, type: 'text', content: expect.stringContaining(point.text) });
    expect(result.elements.some((element) => element.id === `native-page-component-0-2-${suffix}`)).toBe(true);
    expect(new Set(result.elements.map((element) => element.id)).size).toBe(result.elements.length);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('emits final compatibility IDs rather than model IDs when component authoring is disabled', async () => {
    const point = { id: 'display', text: '兼容正文。' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'model-id', type: 'text', left: 60, top: 140, width: 880, height: 70, contentRef: 'display' },
    ] }));
    const result = await generateSceneContent(outline, ai, { responseAuthoringContent: (response) => ({ response, content: [point] }) });
    if (!result || !('elements' in result)) throw new Error('Expected native slide');
    expect(result.elements[0].id).not.toBe('model-id');
    expect(result.contentBindings).toEqual([{ sourceContentId: 'display', elementId: result.elements[0].id }]);
  });

  it('preserves the complete native composition after measured collision instead of vertically repaginating', async () => {
    const points = ['完整陈述一。', '完整陈述二。', '完整陈述三。'].map((text, index) => ({ id: `p${index}`, text }));
    const surfaces = points.map((_, index) => ({ id: `panel-${index}`, type: 'shape',
      left: 56, top: 146 + 90 * index, width: 512, height: 68, fill: '#E8EEF6' }));
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: surfaces,
      components: points.map((point, index) => ({ kind: 'textBox', left: 62, top: 150 + 90 * index,
        width: 500, height: 60, contentRef: point.id })) }));
    const failure = vi.fn();
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true,
      preserveNativeComposition: true, authoringContent: points, onFailure: failure,
      textMeasure: ({ text }) => ({ naturalWidth: 300, height: 150, lines: [text] }) });
    if (!result || !('elements' in result)) throw new Error('Expected usable native slide');
    expect(failure).not.toHaveBeenCalled();
    expect(ai).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('continuationPages');
    expect(result.qualityDiagnostics).toEqual(expect.arrayContaining([
      expect.stringContaining('Authored native composition retained'), expect.stringContaining('collision'),
    ]));
    for (const surface of surfaces) expect(result.elements.find((element) => element.id === surface.id)).toMatchObject(surface);
    for (const [index, point] of points.entries()) {
      expect(result.elements.find((element) => element.id === `native-page-component-${index}`))
        .toMatchObject({ top: 150 + 90 * index, left: 62, width: 500, content: expect.stringContaining(point.text) });
      expect(result.contentBindings).toContainEqual({ sourceContentId: point.id, elementId: `native-page-component-${index}` });
    }
  });

  it('keeps native geometry and emphasis when an unsolicited flow layout accompanies the real native page', async () => {
    const point = { id: 'body', text: '条件明确后再选择方法。' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [{ type: 'text', id: 'body-slot',
      left: 170, top: 210, width: 600, height: 80, contentRef: point.id, emphasis: ['条件'] }],
    layout: { groups: [{ kind: 'textBox', paragraphRefs: [point.id], left: 50, top: 140, width: 900 }] } }));
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true,
      textMeasure: measure, authoringContent: [point] });
    expect(result).toMatchObject({ elements: [expect.objectContaining({ id: 'body-slot', left: 170, top: 210, width: 600,
      content: expect.stringContaining('<strong>条件</strong>') })],
    contentBindings: [{ sourceContentId: point.id, elementId: 'body-slot' }],
    qualityDiagnostics: [expect.stringContaining('Unexpected flow layout was ignored')] });
    expect(result).not.toHaveProperty('continuationPages');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('binds the authoritative complete diagram nodes and annotation after native compilation', async () => {
    const diagram = { topology: 'sequence' as const,
      nodes: [{ id: 'before', label: '明确条件' }, { id: 'after', label: '选择方法' }], annotation: '满足条件后再选择方法。' };
    const measured = vi.fn(measure);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'diagram', left: 50, top: 140, width: 900, height: 300, ...diagram },
    ] }));
    const result = await generateSceneContent({ ...outline,
      visualIntent: { representation: 'native-diagram', observationGoal: '两个步骤有先后关系。', diagram } }, ai,
    { componentAuthoring: true, preserveNativeComposition: true, textMeasure: measured });
    expect(result).toMatchObject({ contentBindings: [
      { sourceContentId: 'diagram-node:before', elementId: 'native-page-component-0-node-before' },
      { sourceContentId: 'diagram-node:after', elementId: 'native-page-component-0-node-after' },
      { sourceContentId: 'diagram-annotation', elementId: 'native-page-component-0-annotation' },
    ] });
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ text: '明确条件', fontSize: 18 }));
    const node = result && 'elements' in result ? result.elements.find((element) => element.id.endsWith('-node-before')) : undefined;
    expect(node && node.type === 'shape' ? node.text?.content : '').toContain('font-size:18px');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('does not pre-allocate a whole-page diagram or impose a measured pair before native authoring', async () => {
    const diagram = { topology: 'cycle' as const,
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `n${index}`, label: `步骤${index + 1}` })),
      annotation: '全部流程节点和完整解释必须保留。'.repeat(50) };
    const measured = vi.fn(measure);
    const ai = vi.fn(async (system: string, user: string) => {
      expect(measured).not.toHaveBeenCalled();
      expect(system).toContain('components');
      expect(system).not.toContain('"layout":{"groups":[]}}');
      expect(system).not.toContain('All TextElement heights must come from this table');
      expect(system).not.toContain('Verbose explanations or lecture-style paragraphs');
      expect(system).not.toContain('Prefer measured textBox components');
      expect(system).toContain('body 18px, compact text and table cells at least 16px');
      expect(user).not.toContain('Measured feasible diagram rectangles');
      expect(user).not.toContain('Select ONE complete pair');
      expect(user).not.toContain('All TextElement `height` values must be selected');
      expect(user).toContain('without a whole-page template');
      return JSON.stringify({ elements: [{ id: 'usable-draft', type: 'text', left: 60, top: 140, width: 880, height: 100,
        content: '<p style="font-size:18px">保留可用原生草稿。</p>' }] });
    });
    const result = await generateSceneContent({ ...outline,
      visualIntent: { representation: 'native-diagram', observationGoal: '保留完整流程。', diagram } }, ai,
    { componentAuthoring: true, preserveNativeComposition: true, textMeasure: measured });
    expect(ai).toHaveBeenCalledOnce();
    expect(result).not.toHaveProperty('continuationPages');
    expect(result).toMatchObject({ elements: [expect.objectContaining({ id: 'usable-draft' })] });
    expect(result).not.toHaveProperty('qualityDiagnostics');
  });

  it('defaults native text and tables to the lecture profile before local measurement without a supplied profile', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'comparison', type: 'table', left: 60, top: 260, width: 880, height: 70,
        colWidths: [1], cellMinHeight: 70, data: [[{ id: 'fact', text: '比较事实。', rowspan: 1, colspan: 1 }]] },
    ], components: [{ kind: 'textBox', left: 60, top: 140, width: 880, text: '完整认识。' }] }));
    const measured = vi.fn(measure);
    const result = await generateSceneContent({ ...outline, presentationTypography: undefined }, ai,
      { componentAuthoring: true, preserveNativeComposition: true, textMeasure: measured });
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ text: '完整认识。', fontSize: 18 }));
    expect(measured).toHaveBeenCalledWith(expect.objectContaining({ text: '比较事实。', fontSize: 16 }));
    const text = result && 'elements' in result ? result.elements.find((element) => element.type === 'text') : undefined;
    expect(text && text.type === 'text' ? text.content : '').toContain('font-size:18px');
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each([false, true])('honors external annotation placement only with trusted upstream permission (%s)', async (allowExternalDiagramAnnotations) => {
    const diagram = { topology: 'branch' as const,
      nodes: [{ id: 'info', label: '新信息或经验' }, { id: 'compatible', label: '与原有结构兼容' },
        { id: 'assimilation', label: '同化' }, { id: 'conflict', label: '与原有结构冲突' },
        { id: 'accommodation', label: '顺应' }, { id: 'development', label: '认知发展' }],
      edges: [{ from: 'info', to: 'compatible' }, { from: 'compatible', to: 'assimilation' },
        { from: 'info', to: 'conflict' }, { from: 'conflict', to: 'accommodation' },
        { from: 'assimilation', to: 'development' }, { from: 'accommodation', to: 'development' }],
      annotation: '两条路径共同推动认知发展。' };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { id: 'external-note', type: 'text', left: 300, top: 444, width: 640, height: 68,
        contentRef: 'diagram-annotation', content: '<p style="font-size:16px"></p>' },
    ], components: [{ kind: 'diagram', left: 60, top: 176, width: 460, height: 260,
      ...diagram, annotationPlacement: 'external' }] }));
    const result = await generateSceneContent({ ...outline,
      visualIntent: { representation: 'native-diagram', observationGoal: '观察完整分支关系。', diagram } }, ai,
    { componentAuthoring: true, preserveNativeComposition: true, allowExternalDiagramAnnotations,
      authoringContent: [{ id: 'diagram-annotation', text: diagram.annotation }], textMeasure: measure });
    if (!result || !('elements' in result)) throw new Error('Expected native branch');
    const nodes = result.elements.filter((element) => element.type === 'shape');
    expect(nodes).toHaveLength(6);
    expect(nodes.map((node) => node.id)).toEqual(diagram.nodes.map((node) => `native-page-component-0-node-${node.id}`));
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(result.contentBindings).toContainEqual({ sourceContentId: 'diagram-annotation', elementId: 'external-note' });
    expect(result.elements.some((element) => element.id === 'native-page-component-0-annotation')).toBe(!allowExternalDiagramAnnotations);
    if (allowExternalDiagramAnnotations) {
      for (const node of nodes) {
        expect(node.top).toBeGreaterThanOrEqual(176);
        expect(node.top + node.height).toBeLessThanOrEqual(436);
        expect(node.text?.content).toContain('font-size:18px');
      }
      expect(result.qualityDiagnostics).toBeUndefined();
    }
    expect(ai).toHaveBeenCalledOnce();
  });

  it('offers source measurements as optional references without fixing the final display wording or region', async () => {
    const source = { id: 'source-duty', text: '完整概念包含必要条件。' };
    const ai = vi.fn(async (system: string, user: string) => {
      expect(system).not.toContain('FINAL selected display content');
      expect(system).not.toContain('host owns the adopted point text');
      expect(user).not.toContain('Required display-reference ids');
      expect(user).toContain('"measurementSourceId":"source-duty"');
      expect(user).toContain('you own left/top');
      return JSON.stringify({ elements: [{ id: 'combined', type: 'text', left: 130, top: 190, width: 600, height: 70,
        contentRef: 'display-new', content: '<p style="font-size:18px"></p>' }] });
    });
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true,
      authoringContent: [source], textMeasure: measure,
      responseAuthoringContent: (response) => ({ response, content: [{ id: 'display-new', text: '概念须满足必要条件。' }] }) });
    expect(result).toMatchObject({ elements: [expect.objectContaining({ left: 130, top: 190, width: 600,
      content: expect.stringContaining('概念须满足必要条件。') })] });
    expect(result).not.toHaveProperty('qualityDiagnostics');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('continues native authoring without a layout finding when no source measurement hint is feasible', async () => {
    const source = { id: 'long-source', text: '完整来源中的必要概念与解释。'.repeat(40) };
    const ai = vi.fn(async (_system: string, user: string) => {
      expect(user).toContain('Optional measured source-text examples: []');
      return JSON.stringify({ components: [{ kind: 'textBox', left: 80, top: 170, width: 700, contentRef: 'display' }] });
    });
    const result = await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true,
      authoringContent: [source], textMeasure: (input) => input.text === source.text
        ? { height: 2000, naturalWidth: 500, lines: [input.text] } : measure(input),
      responseAuthoringContent: (response) => ({ response, content: [{ id: 'display', text: '准确的必要概念与条件。' }] }) });
    expect(result).not.toHaveProperty('qualityDiagnostics');
    expect(JSON.stringify(result)).toContain('准确的必要概念与条件。');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('keeps invalid component and catalogue-adoption failures technical despite composition preservation', async () => {
    const failure = vi.fn();
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [{ kind: 'labelGrid', left: 60, top: 140, width: 880,
      height: 100, rows: [{ cells: [] }] }] }));
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, preserveNativeComposition: true,
      textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output' }));
    failure.mockClear();
    expect(await generateSceneContent(outline, ai, { responseAuthoringContent: () => { throw new Error('display protocol is unparseable'); },
      onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith({ code: 'invalid-model-output', detail: 'display protocol is unparseable' });
    expect(ai).toHaveBeenCalledTimes(2);
  });

  it('classifies a valid graph whose natural labels cannot fit as layout conflict without certifying a fake draft', async () => {
    const diagram = { topology: 'sequence' as const, nodes: [{ id: 'a', label: '搭脚手架' }, { id: 'b', label: '进入情境' }],
      edges: [{ from: 'a', to: 'b' }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [{ kind: 'diagram',
      left: 50, top: 400, width: 880, height: 100, ...diagram }] }));
    const failure = vi.fn();
    const result = await generateSceneContent({ ...outline,
      visualIntent: { representation: 'native-diagram', observationGoal: '保留真实步骤。', diagram } }, ai,
    { componentAuthoring: true, preserveNativeComposition: true, onFailure: failure,
      textMeasure: () => ({ naturalWidth: 1000, height: 10000, lines: ['actual measurement reports overflow'] }) });
    expect(result).toBeNull();
    expect(failure).toHaveBeenCalledExactlyOnceWith({ code: 'invalid-model-output', category: 'layout-conflict',
      detail: expect.stringMatching(/do not fit inside the container.*880×100px/u) });
    expect(ai).toHaveBeenCalledOnce();
  });
});
