import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { auditGeneratedSlide, balanceSparseSlideLayout, fitGeneratedTextBoxHeights } from './slide-quality';

describe('generated slide quality gate', () => {
  it('does not mistake a tall empty text box for balanced visible content', () => {
    const elements = [
      { id: 'title', type: 'text', left: 60, top: 50, width: 880, height: 76, content: '<p style="font-size:36px">教学概念</p>' },
      { id: 'body', type: 'text', left: 100, top: 150, width: 800, height: 330, content: '<p style="font-size:28px">学习者主动建构理解</p>' },
    ] as PPTElement[];
    const result = balanceSparseSlideLayout(elements);
    expect(result[1].top).toBeGreaterThan(250);
    expect(result[1].type !== 'line' && result[1].height).toBeLessThan(100);
    expect(result[0]).toBe(elements[0]);
    expect(elements[1].top).toBe(150);
    expect(auditGeneratedSlide(result, { checkComposition: true }).passed).toBe(true);
  });
  it('does not detach labels from a model crossing the title/body boundary', () => {
    const elements = [
      { id: 'frame', type: 'shape', left: 100, top: 120, width: 800, height: 160, fill: '#fff' },
      { id: 'label', type: 'text', left: 160, top: 150, width: 650, height: 80, content: '<p>模型中的标签</p>' },
    ] as PPTElement[];
    expect(balanceSparseSlideLayout(elements)).toEqual(elements);
  });
  it('centers a sparse body as a group while preserving the title and relative geometry', () => {
    const elements = [
      { id: 'title', type: 'text', left: 60, top: 50, width: 880, height: 60, content: '<p>核心概念</p>' },
      { id: 'body', type: 'text', left: 180, top: 150, width: 640, height: 80, content: '<p>学习者主动建构理解</p>' },
      { id: 'example', type: 'text', left: 180, top: 250, width: 640, height: 50, content: '<p>用观察证据修正最初解释</p>' },
    ] as PPTElement[];
    expect(auditGeneratedSlide(elements, { checkComposition: true }).passed).toBe(false);
    const balanced = balanceSparseSlideLayout(elements);
    expect(balanced[0].top).toBe(50);
    expect(balanced[2].top - balanced[1].top).toBe(100);
    expect(balanced[1].top).toBeGreaterThan(200);
    expect(auditGeneratedSlide(balanced, { checkComposition: true }).passed).toBe(true);
    expect(elements[1].top).toBe(150);
  });
  it('rejects clipped content, unreadable text and substantially overlapping text boxes', () => {
    const text = { id: 'text', type: 'text', left: 950, top: 480, width: 200, height: 90, content: '<p style="font-size:12px">过小且超出画布的核心内容</p>' } as PPTElement;
    const result = auditGeneratedSlide([text], { checkComposition: true });
    expect(result.reasons.join(' ')).toContain('outside');
    expect(result.reasons.join(' ')).toContain('too small');
    expect(auditGeneratedSlide([{ ...text, left: 100, top: 200 }, { ...text, id: 'another', left: 110, top: 210 }], { checkComposition: true }).reasons.join(' ')).toContain('overlap');
  });

  it('rejects the narrow wrapped labels and isolated decorative stems from the reported pages', () => {
    const sectionLabel = {
      id: 'outcome-label', type: 'text', left: 95, top: 296, width: 80, height: 30,
      content: '<p style="font-size:18px">成果导向</p>',
    } as PPTElement;
    const followingHeading = {
      id: 'next-heading', type: 'text', left: 80, top: 340, width: 300, height: 40,
      content: '<p style="font-size:26px">探究式教学</p>',
    } as PPTElement;
    const orphan = {
      id: 'orphan', type: 'line', left: 260, top: 198, width: 2,
      start: [0, 0], end: [0, 10], points: ['', ''], style: 'solid', color: '#397D72',
    } as PPTElement;
    const reasons = auditGeneratedSlide([sectionLabel, followingHeading, orphan], { checkComposition: true }).reasons;
    expect(reasons).toEqual(expect.arrayContaining([
      'line orphan is an isolated short mark, not a meaningful connector',
    ]));
    expect(reasons.some((reason) => reason.startsWith('text outcome-label needs at least'))).toBe(true);
  });

  it('fits generated text boxes to the classroom renderer before collision review', () => {
    const label = {
      id: 'outcome-label', type: 'text', left: 95, top: 296, width: 80, height: 30,
      content: '<p style="font-size:18px">成果导向</p>',
    } as PPTElement;
    const [fitted] = fitGeneratedTextBoxHeights([label]);
    expect(fitted).toMatchObject({ left: 95, top: 296, width: 80, height: 76 });
    expect(auditGeneratedSlide([fitted], { checkComposition: true }).reasons)
      .not.toContain(expect.stringContaining('needs at least'));
  });

  it('decodes non-breaking spaces instead of inflating a code panel', () => {
    const code = {
      id: 'code-text', type: 'text', left: 70, top: 165, width: 330, height: 160,
      content: '<p style="font-size:20px;font-family:monospace">import cv2</p>'
        + '<p style="font-size:20px;font-family:monospace">cap = cv2.VideoCapture(0)</p>'
        + '<p style="font-size:20px;font-family:monospace">while ____:</p>'
        + '<p style="font-size:20px;font-family:monospace">&nbsp;&nbsp;&nbsp;&nbsp;ret, frame = cap.read()</p>'
        + '<p style="font-size:20px;font-family:monospace">&nbsp;&nbsp;&nbsp;&nbsp;# 处理帧</p>',
    } as PPTElement;
    const [fitted] = fitGeneratedTextBoxHeights([code]);
    expect(fitted.type !== 'line' && fitted.height).toBeLessThan(230);
    expect(fitted.type !== 'line' && fitted.height).toBeGreaterThanOrEqual(190);
  });

  it('rejects the table-label collision from the reported evaluation slide', () => {
    const table = {
      id: 'rubric', type: 'table', left: 600, top: 150, width: 340, height: 280,
      colWidths: [0.3, 0.7], cellMinHeight: 60,
      data: [[{ id: 'a', text: '评价维度', colspan: 1, rowspan: 1 }, { id: 'b', text: '评价标准', colspan: 1, rowspan: 1 }]],
      outline: { color: '#ccc', width: 1, style: 'solid' },
    } as PPTElement;
    const connectorLabel = {
      id: 'connector-label', type: 'text', left: 565, top: 250, width: 150, height: 76,
      content: '<p style="font-size:18px;text-align:center">活动对应评价目标</p>',
    } as PPTElement;
    const reasons = auditGeneratedSlide([table, connectorLabel], { checkComposition: true }).reasons;
    expect(reasons).toContain('short label connector-label wraps unexpectedly; widen it or add an intentional line break at a meaningful boundary');
    expect(reasons).toContain('text connector-label collides with table rubric; keep the label outside its reserved rectangle or fully inside its intended background');
  });

  it('rejects intersecting panels while allowing padded text inside its background', () => {
    const answerPanel = {
      id: 'answer-panel', type: 'shape', left: 610, top: 250, width: 280, height: 80,
      fill: '#FFF3E0', path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', viewBox: [1, 1], fixedRatio: false,
    } as PPTElement;
    const answerText = {
      id: 'answer-text', type: 'text', left: 620, top: 260, width: 260, height: 55,
      content: '<p style="font-size:20px">增加有代表性的训练图片</p>',
    } as PPTElement;
    const resultPanel = {
      id: 'result-panel', type: 'shape', left: 720, top: 280, width: 220, height: 140,
      fill: '#FFFFFF', path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', viewBox: [1, 1], fixedRatio: false,
    } as PPTElement;
    const resultText = {
      id: 'result-text', type: 'text', left: 730, top: 295, width: 200, height: 126,
      content: '<p style="font-size:22px;font-weight:bold">准确率：60% → 85%</p><p style="font-size:20px">探究结论</p>',
    } as PPTElement;
    const reasons = auditGeneratedSlide([answerPanel, answerText, resultPanel, resultText], { checkComposition: true }).reasons;
    expect(reasons).toContain('content blocks answer-panel and result-panel overlap; allocate non-intersecting rectangles on the slide grid');
    expect(reasons).toContain('short label result-text wraps unexpectedly; widen it or add an intentional line break at a meaningful boundary');
    expect(reasons.some((reason) => reason.includes('text answer-text collides with shape result-panel'))).toBe(true);

    expect(auditGeneratedSlide([answerPanel, answerText], { checkComposition: true }).reasons)
      .not.toContain(expect.stringContaining('collides with shape answer-panel'));
  });

  it('does not treat line-height leading at a nearby panel edge as visible text collision', () => {
    const heading = {
      id: 'heading', type: 'text', left: 60, top: 120, width: 350, height: 52,
      content: '<p style="font-size:20px;font-weight:bold">支架：降低入门门槛</p>',
    } as PPTElement;
    const panel = {
      id: 'panel', type: 'shape', left: 60, top: 150, width: 350, height: 200,
      fill: '#fff', path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', viewBox: [1, 1], fixedRatio: false,
    } as PPTElement;
    expect(auditGeneratedSlide([panel, heading], { checkComposition: true }).reasons)
      .not.toContain(expect.stringContaining('collides with shape panel'));
  });

  it('rejects table text that cannot fit and text covered by a later opaque shape', () => {
    const table = {
      id: 'rubric', type: 'table', left: 60, top: 150, width: 500, height: 60,
      colWidths: [0.5, 0.5], data: [[
        { id: 'a', text: '需要保留的较长评价要求', colspan: 1, rowspan: 1, style: { fontsize: '24px' } },
        { id: 'b', text: '可观察的学习证据与判断依据', colspan: 1, rowspan: 1, style: { fontsize: '24px' } },
      ]], outline: { color: '#ccc', width: 1, style: 'solid' },
    } as PPTElement;
    const label = { id: 'label', type: 'text', left: 100, top: 300, width: 300, height: 50, content: '<p style="font-size:24px">核心结论</p>' } as PPTElement;
    const cover = { id: 'cover', type: 'shape', left: 90, top: 290, width: 320, height: 70, fill: '#fff', path: 'M 0 0 L 1 0 L 1 1 L 0 1 Z', viewBox: [1, 1], fixedRatio: false } as PPTElement;
    const reasons = auditGeneratedSlide([table, label, cover], { checkComposition: true }).reasons;
    expect(reasons).toEqual(expect.arrayContaining([
      'table rubric cannot fit its cell text at the chosen font size; increase row/table height or simplify optional wording',
      'text label is covered by later shape cover',
    ]));
  });
  it('rejects blank and decoration-only PPT pages', () => {
    expect(auditGeneratedSlide([]).passed).toBe(false);
    expect(auditGeneratedSlide([{
      id: 'shape', type: 'shape', left: 50, top: 50, width: 200, height: 100, rotate: 0,
      path: 'M0 0 L1 0 L1 1 Z', viewBox: [1, 1], fill: '#fff', fixedRatio: false,
    }]).reasons).toContain('slide contains only decorative shapes or lines');
  });

  it('accepts a renderable page with visible instructional content', () => {
    const element = {
      id: 'text', type: 'text', left: 60, top: 60, width: 500, height: 80,
      content: '<p>核心结论与证据</p>', defaultFontName: 'Microsoft YaHei', defaultColor: '#172033',
    } as PPTElement;
    expect(auditGeneratedSlide([element])).toEqual({ passed: true, reasons: [] });
  });
});
