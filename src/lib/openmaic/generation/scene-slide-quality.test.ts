import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { generateSceneContent } from './scene-generator';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { slideReviewEvidence } from './slide-content-review';
import { StaticTable } from '@/components/openmaic/slide-renderer/components/element/TableElement/StaticTable';

const outline: SceneOutline = {
  id: 'concept', type: 'slide', title: '主动建构', description: '用已有经验理解新证据',
  keyPoints: ['学生通过反思修正理解'], targetDurationSec: 90, order: 0,
};
const page = (text: string, extra = false) => JSON.stringify({ elements: [
  { type: 'text', left: 60, top: 55, width: 800, height: 76, content: '<p style="font-size:36px">主动建构</p>' },
  { type: 'text', left: 180, top: 260, width: 640, height: 100, content: `<p style="font-size:28px">${text}</p>` },
  ...(extra ? [{ type: 'text', left: 180, top: 270, width: 640, height: 100, content: '<p style="font-size:28px">重叠说明</p>' }] : []),
] });

describe('slide generation quality repair', () => {
  it('repairs a concrete content error with source evidence and the previous native page', async () => {
    const ai = vi.fn()
      .mockResolvedValueOnce(page('学生只能被动接受知识'))
      .mockResolvedValueOnce(JSON.stringify({ blockingIssues: [{ evidence: '学生只能被动接受知识', repair: '改为学生结合已有经验主动修正理解' }], keyPointCoverage: [{ index: 0, covered: false, quotes: [], reason: '缺少主动修正的解释' }] }))
      .mockResolvedValueOnce(page('学生结合已有经验主动修正理解'))
      .mockResolvedValueOnce(JSON.stringify({ blockingIssues: [], keyPointCoverage: [{ index: 0, covered: true, quotes: ['学生结合已有经验主动修正理解'], reason: '解释学生如何主动修正理解' }] }));
    const result = await generateSceneContent(outline, ai, {
      reviewSlideContent: true, userRequirements: { requirement: '本科一年级', teachingSourceContext: '教师确认：学生主动建构知识' },
    });
    expect(result && 'elements' in result && result.elements).toEqual(expect.arrayContaining([expect.objectContaining({ content: expect.stringContaining('主动修正理解') })]));
    expect(ai).toHaveBeenCalledTimes(4);
    const repair = ai.mock.calls[2][1] as string;
    expect(repair).toContain('教师确认：学生主动建构知识');
    expect(repair).toContain('Previous page content and geometry');
    expect(repair).toContain('"left":180');
    expect(repair).toContain('学生只能被动接受知识');
    expect(outline.targetDurationSec).toBe(90);
  });

  it('repairs overlapping text before returning the draft', async () => {
    const ai = vi.fn()
      .mockResolvedValueOnce(page('学生主动修正理解', true))
      .mockResolvedValueOnce(page('学生主动修正理解'));
    const result = await generateSceneContent(outline, ai);
    expect(result && 'elements' in result && result.elements).toHaveLength(2);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1][1]).toContain('overlap substantially');
  });

  it.each([
    { elements: [] },
    { elements: [{ type: 'text', left: 900, top: 180, width: 700, height: 100, content: '<p>越界证据</p>' }] },
  ])('still repairs concrete empty or out-of-canvas pages before returning a draft', async (invalid) => {
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify(invalid)).mockResolvedValueOnce(page('学生主动修正理解'));
    expect(await generateSceneContent(outline, ai)).toBeTruthy();
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1][1]).toContain('Repair this page');
  });

  it('preserves generated teaching tables, supplies render defaults and shares every cell with narration review', async () => {
    const table = { type: 'table', left: 80, top: 180, width: 840, height: 240, colWidths: [40, 60], data: [
      [{ text: '评价维度' }, { text: '可观察证据' }],
      [{ text: '问题拆解' }, { text: '把驱动问题拆为可检验的子问题，并说明与目标的关系' }],
    ] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [table] }));
    const result = await generateSceneContent(outline, ai);
    expect(result && 'elements' in result && result.elements).toHaveLength(1);
    if (!result || !('elements' in result) || result.elements[0].type !== 'table') throw new Error('table must survive generation');
    const generated = result.elements[0];
    expect(generated.colWidths).toEqual([0.4, 0.6]);
    expect(generated.cellMinHeight).toBe(120);
    expect(generated.outline).toMatchObject({ width: 1, style: 'solid' });
    expect(generated.data[1][1]).toMatchObject({ id: expect.any(String), colspan: 1, rowspan: 1, text: table.data[1][1].text });
    expect(JSON.stringify(slideReviewEvidence(result.elements))).toContain(table.data[1][1].text);
    const rendered = renderToStaticMarkup(createElement(StaticTable, { elementInfo: generated }));
    expect(rendered).toContain(table.data[1][1].text);
    expect(rendered.match(/<td(?:\s|>)/g)).toHaveLength(4);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('repairs a malformed table explicitly and never accepts its silent removal beside a valid title', async () => {
    const malformed = JSON.stringify({ elements: [
      { type: 'text', left: 60, top: 55, width: 800, height: 55, content: '<p>评价与拆解</p>' },
      { type: 'table', left: 80, top: 180, width: 840, height: 240, data: [[{ content: '缺少规范 text 的原始证据' }]] },
    ] });
    const ai = vi.fn().mockResolvedValue(malformed);
    expect(await generateSceneContent(outline, ai)).toBeNull();
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls[1][1]).toContain('requires its original text');
    expect(ai.mock.calls[1][1]).toContain('缺少规范 text 的原始证据');
  });
});
