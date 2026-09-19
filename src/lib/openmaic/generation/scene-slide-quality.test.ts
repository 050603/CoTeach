import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { generateSceneContent } from './scene-generator';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { slideReviewEvidence } from './slide-content-review';
import { StaticTable } from '@/components/openmaic/slide-renderer/components/element/TableElement/StaticTable';
import { deriveTeachingConstraints } from '@/lib/openmaic/pedagogy/teaching-constraints';

const outline: SceneOutline = {
  id: 'concept', type: 'slide', title: '主动建构', description: '用已有经验理解新证据',
  keyPoints: ['学生通过反思修正理解'], targetDurationSec: 90, order: 0,
};
const page = (text: string, extra = false) => JSON.stringify({ elements: [
  { type: 'text', left: 60, top: 55, width: 800, height: 76, content: '<p style="font-size:36px">主动建构</p>' },
  { type: 'text', left: 180, top: 260, width: 640, height: 100, content: `<p style="font-size:28px">${text}</p>` },
  ...(extra ? [{ type: 'text', left: 180, top: 270, width: 640, height: 100, content: '<p style="font-size:28px">重叠说明</p>' }] : []),
] });

describe('first-pass slide generation', () => {
  it('does not inject the full private source context into the official slide prompt', async () => {
    const ai = vi.fn().mockResolvedValue(page('学生结合已有经验主动修正理解'));
    const result = await generateSceneContent(outline, ai, {
      reviewSlideContent: true,
      userRequirements: { requirement: '本科一年级', teachingSourceContext: '教师确认：学生主动建构知识',
        teachingConstraints: deriveTeachingConstraints({ grade: '本科一年级', subject: '教育学', topic: '主动建构', hours: 1,
          learnerProfile: { priorKnowledge: '有观察课堂的经验', learningNeeds: '不熟悉教育学术语', familiarContexts: '校园广播' },
          learningObjectives: ['根据证据修正解释'],
        }),
      },
    });
    expect(result).toBeTruthy();
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0][1]).not.toContain('教师确认：学生主动建构知识');
    expect(ai.mock.calls[0][1]).toContain('有观察课堂的经验');
    expect(ai.mock.calls[0][1]).toContain('不熟悉教育学术语');
    expect(ai.mock.calls[0][1]).toContain('校园广播');
    expect(ai.mock.calls[0][1]).toContain('根据证据修正解释');
  });

  it('preserves first-pass coordinates even when visual findings remain', async () => {
    const ai = vi.fn().mockResolvedValue(page('学生主动修正理解', true));
    const result = await generateSceneContent(outline, ai);
    expect(result && 'elements' in result && result.elements).toHaveLength(3);
    expect(result && 'elements' in result && result.elements[2]).toMatchObject({ left: 180, top: 270, height: 100 });
    expect(ai).toHaveBeenCalledOnce();
  });

  it('keeps the official empty-array parse behavior for the later evidence audit', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [] }));
    expect(await generateSceneContent(outline, ai)).toMatchObject({ elements: [] });
    expect(ai).toHaveBeenCalledOnce();
  });

  it('rejects an output without an elements array', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ invalid: true }));
    expect(await generateSceneContent(outline, ai)).toBeNull();
    expect(ai).toHaveBeenCalledOnce();
  });

  it('keeps the official first-draft table payload unchanged', async () => {
    const table = { type: 'table', left: 80, top: 180, width: 840, height: 240, colWidths: [40, 60], data: [
      [{ text: '评价维度' }, { text: '可观察证据' }],
      [{ text: '问题拆解' }, { text: '把驱动问题拆为可检验的子问题，并说明与目标的关系' }],
    ] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ elements: [table] }));
    const result = await generateSceneContent(outline, ai);
    expect(result && 'elements' in result && result.elements).toHaveLength(1);
    if (!result || !('elements' in result) || result.elements[0].type !== 'table') throw new Error('table must survive generation');
    const generated = result.elements[0];
    expect(generated.colWidths).toEqual([40, 60]);
    expect(generated.data[1][1]).toMatchObject({ text: table.data[1][1].text });
    expect(JSON.stringify(slideReviewEvidence(result.elements))).toContain(table.data[1][1].text);
    const rendered = renderToStaticMarkup(createElement(StaticTable, { elementInfo: generated }));
    expect(rendered).toContain(table.data[1][1].text);
    expect(rendered.match(/<td(?:\s|>)/g)).toHaveLength(4);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('leaves malformed first-draft table evidence for the browser/structure audit', async () => {
    const malformed = JSON.stringify({ elements: [
      { type: 'text', left: 60, top: 55, width: 800, height: 55, content: '<p>评价与拆解</p>' },
      { type: 'table', left: 80, top: 180, width: 840, height: 240, data: [[{ content: '缺少规范 text 的原始证据' }]] },
    ] });
    const ai = vi.fn().mockResolvedValue(malformed);
    const result = await generateSceneContent(outline, ai);
    expect(result && 'elements' in result && result.elements).toHaveLength(2);
    expect(ai).toHaveBeenCalledOnce();
  });
});
