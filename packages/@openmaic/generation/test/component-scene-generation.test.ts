import { describe, expect, it, vi } from 'vitest';
import { generateSceneContent } from '../src/scene-generator.js';
import type { SceneOutline } from '../src/outline-types.js';
import type { TextMeasure } from '../src/text-layout-compiler.js';

const outline: SceneOutline = {
  id: 'first-pass-slide', type: 'slide', title: '七步设计闭环', description: '七个步骤形成循环。',
  keyPoints: ['每步衔接下一步', '整体反馈用于调整'], order: 0,
  visualIntent: {
    representation: 'native-diagram', observationGoal: '七步如何组成闭环',
    diagram: {
      topology: 'cycle',
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `s${index + 1}`, label: `设计步骤${index + 1}` })),
      annotation: '闭环用于反馈调整',
    },
  },
};

const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const lines = text.split(/\n/).filter(Boolean);
  return { naturalWidth: Math.max(...lines.map((line) => Array.from(line).length * fontSize)),
    height: padding * 2 + lines.length * fontSize * lineHeight, lines };
};

describe('first-draft component authoring in the production package', () => {
  it('keeps flow behind an explicit authoring option', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ layout: { groups: [{ kind: 'textBox', text: 'native slide expected' }] } }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith({ code: 'invalid-model-output', detail: expect.stringContaining('flow layout is opt-in') });
  });

  it('preserves native surfaces, rich text and actual tables without forcing components', async () => {
    const rich = '<p style="font-size:16px;color:#334155"><strong>同化：</strong>使用已有结构理解信息</p>';
    const source = { elements: [
      { id: 'surface', type: 'shape', left: 60, top: 120, width: 880, height: 100, path: 'M0 0 L880 0 L880 100 L0 100 Z', viewBox: [880, 100], fill: '#F0F5FA' },
      { id: 'explanation', type: 'text', left: 80, top: 140, width: 840, height: 60, content: rich },
      { id: 'comparison', type: 'table', left: 60, top: 240, width: 880, height: 100, colWidths: [0.3, 0.7], cellMinHeight: 50,
        data: [[{ id: 'a', text: '同化', colspan: 1, rowspan: 1, style: { fontsize: 16, bold: true } }, { id: 'b', text: '认知结构保持不变', colspan: 1, rowspan: 1, style: { fontsize: 16 } }]], outline: { width: 1, color: '#D0D8E0' } },
    ] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(source));
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, { componentAuthoring: true, textMeasure: measure });
    expect(slide && 'elements' in slide ? slide.elements.map((element) => element.type) : []).toEqual(['shape', 'text', 'table']);
    expect(slide && 'elements' in slide ? slide.elements.find((element) => element.id === 'explanation') : null).toMatchObject({ content: rich, width: 840, height: 60 });
    expect(ai.mock.calls[0][0]).toContain('Slide Content Philosophy');
    expect(ai.mock.calls[0][0]).toContain('TableElement');
    expect(slide).not.toHaveProperty('continuationPages');
  });

  it('deterministically disambiguates repeated model IDs without replacing valid IDs', async () => {
    const source = { elements: ['same-id', 'same-id', `${outline.id}-element-1`].map((id, index) => ({
      id, type: 'text', left: 60, top: 120 + index * 80, width: 800, height: 60,
      content: `<p style="font-size:16px">完整说明${index + 1}</p>`,
    })) };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(source));
    const options = { componentAuthoring: true, textMeasure: measure };
    const first = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, options);
    const second = await generateSceneContent({ ...outline, visualIntent: undefined }, ai, options);
    const ids = (slide: typeof first) => slide && 'elements' in slide ? slide.elements.map((element) => element.id) : [];
    expect(ids(first)).toEqual(['same-id', `${outline.id}-element-1-2`, `${outline.id}-element-1`]);
    expect(ids(second)).toEqual(ids(first));
    expect(new Set(ids(first)).size).toBe(3);
  });

  it('compiles title and authoritative circular plan in the same content request', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ background: { type: 'solid', color: '#ffffff' }, elements: [], components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 84, text: outline.title },
      { type: 'diagram', id: 'ring', left: 70, top: 160, width: 860, height: 330,
        topology: 'sequence', nodes: [{ id: 'wrong', label: 'wrong' }] },
    ] }));
    const slide = await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(ai.mock.calls[0][0]).toContain('Optional first-draft measured components');
    expect(ai.mock.calls[0][0]).toContain('Do not force introductory examples');
    expect(ai.mock.calls[0][1]).toContain('Measured feasible diagram rectangles');
    expect(ai.mock.calls[0][1]).toMatch(/\{\"width\":900,\"height\":\d+\}/);
    expect(ai.mock.calls[0][0]).toContain('Text Height Lookup Table');
    expect(ai.mock.calls[0][1]).toContain('All TextElement `height` values');
    expect(slide && 'elements' in slide ? slide.elements.filter((item) => item.type === 'line') : []).toHaveLength(7);
    expect(slide && 'elements' in slide ? slide.elements.some((item) => item.type === 'text' && item.content.includes('闭环用于反馈调整')) : false).toBe(true);
    expect(slide && 'elements' in slide ? slide.elements.some((item) => item.type === 'shape' && 'text' in item && String(item.text?.content).includes('wrong')) : false).toBe(false);
  });

  it('rejects a missing planned relationship even when native text is valid', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [
      { type: 'text', left: 60, top: 50, width: 880, height: 70, content: '<p>标题</p>' },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output', detail: expect.any(String) }));
  });

  it('accepts a component-only response that omits an unused native elements array', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 84, text: outline.title },
      { type: 'diagram', id: 'ring', left: 70, top: 160, width: 860, height: 330,
        topology: 'cycle', nodes: outline.visualIntent?.diagram?.nodes },
    ] }));
    const slide = await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure });
    expect(slide && 'elements' in slide ? slide.elements.filter((item) => item.type === 'line') : []).toHaveLength(7);
  });

  it('uses measured component height when a model guesses an undersized maximum', async () => {
    const body = '任务要承载完整的教学解释';
    const measureOverflow: TextMeasure = (input) => input.text.includes(body)
      ? { naturalWidth: 400, height: 128, lines: [body] }
      : measure(input);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', left: 60, top: 140, width: 500, maxHeight: 120, text: body, fontSize: 18 },
      { kind: 'textBox', left: 60, top: 300, width: 500, text: '下一项', fontSize: 18 },
    ] }));
    const slide = await generateSceneContent({ ...outline, visualIntent: undefined }, ai,
      { componentAuthoring: true, textMeasure: measureOverflow });
    const text = slide && 'elements' in slide ? slide.elements.find((item) => item.type === 'text' && item.content.includes(body)) : undefined;
    expect(text).toMatchObject({ top: 140, height: 128 });
    expect(ai).toHaveBeenCalledTimes(1);
  });

  it('still rejects measured growth that collides with another foreground component', async () => {
    const body = '任务要承载完整的教学解释';
    const measureOverflow: TextMeasure = (input) => input.text.includes(body)
      ? { naturalWidth: 400, height: 128, lines: [body] }
      : measure(input);
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', left: 60, top: 140, width: 500, maxHeight: 120, text: body, fontSize: 18 },
      { kind: 'textBox', left: 60, top: 260, width: 500, text: '下一项', fontSize: 18 },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent({ ...outline, visualIntent: undefined }, ai,
      { componentAuthoring: true, textMeasure: measureOverflow, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({
      code: 'invalid-model-output', detail: expect.stringContaining('overlap'),
    }));
  });

  it('rejects overlapping allocations using measured text height, not the model hint', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [], components: [
      { kind: 'textBox', role: 'title', left: 60, top: 50, width: 880, height: 20, text: outline.title },
      { type: 'diagram', id: 'ring', left: 70, top: 110, width: 860, height: 330,
        topology: 'cycle', nodes: outline.visualIntent?.diagram?.nodes },
    ] }));
    const failure = vi.fn();
    expect(await generateSceneContent(outline, ai, { componentAuthoring: true, allowLegacyComponents: true, textMeasure: measure, onFailure: failure })).toBeNull();
    expect(failure).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid-model-output', detail: expect.any(String) }));
  });
});
