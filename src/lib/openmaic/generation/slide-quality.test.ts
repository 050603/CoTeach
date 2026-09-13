import { describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';
import { auditGeneratedSlide, balanceSparseSlideLayout } from './slide-quality';

describe('generated slide quality gate', () => {
  it('does not mistake a tall empty text box for balanced visible content', () => {
    const elements = [
      { id: 'title', type: 'text', left: 60, top: 50, width: 880, height: 60, content: '<p style="font-size:36px">教学概念</p>' },
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
