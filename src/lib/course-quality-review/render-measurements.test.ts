import { describe, expect, it } from 'vitest';
import { inspectRenderedSlide, type RenderedElement } from './render-measurements';

function text(id: string, top: number, boxHeight = 50): RenderedElement {
  return { id, type: 'text', box: { left: 100, top, width: 600, height: boxHeight }, text: '学习者主动建构理解',
    textRects: [{ left: 110, top: top + 10, width: 300, height: 30 }], fontSize: 26 };
}
describe('actual rendered teaching content', () => {
  it('detects upper-half text hidden by an oversized empty container', () => {
    expect(inspectRenderedSlide('scene', [text('body', 150, 330)]).map((issue) => issue.id)).toContain('render:scene:top-heavy:canvas');
  });
  it('allows intentional sparse centered content', () => {
    expect(inspectRenderedSlide('scene', [text('body', 310)])).toEqual([]);
  });
  it('checks glyph overlap including shape text', () => {
    const shape = { ...text('shape', 310), type: 'shape' as const };
    expect(inspectRenderedSlide('scene', [text('body', 300), shape]).some((issue) => issue.title === '两处文字相互重叠')).toBe(true);
  });
  it('does not let a footer disguise top-heavy instructional content', () => {
    expect(inspectRenderedSlide('scene', [text('body', 150, 330), text('footer', 500)]).some((issue) => issue.id.includes('top-heavy'))).toBe(true);
  });
  it('reports unreadable text, missing images and actual canvas overflow', () => {
    const small = { ...text('small', 540), fontSize: 12 };
    const image: RenderedElement = { id: 'image', type: 'image', box: { left: 600, top: 200, width: 300, height: 200 }, textRects: [], text: '', imageLoaded: false };
    const issues = inspectRenderedSlide('scene', [small, image]);
    expect(issues.map((issue) => issue.id)).toEqual(expect.arrayContaining(['render:scene:overflow:small', 'render:scene:small-type:small', 'render:scene:image-missing:image']));
  });
  it('detects rendered text that intrudes into a table even when the table was authored first', () => {
    const label = { ...text('label', 250, 76), box: { left: 565, top: 250, width: 150, height: 76 },
      textRects: [{ left: 575, top: 260, width: 125, height: 45 }] };
    const table: RenderedElement = { id: 'rubric', type: 'table', box: { left: 600, top: 150, width: 340, height: 280 }, textRects: [], text: '' };
    expect(inspectRenderedSlide('scene', [table, label]).map((issue) => issue.id))
      .toContain('render:scene:collision-rubric:label');
  });

  it('allows text fully contained by its intended opaque background', () => {
    const label = { ...text('label', 210), box: { left: 120, top: 210, width: 260, height: 50 } };
    const panel: RenderedElement = { id: 'panel', type: 'shape', box: { left: 100, top: 190, width: 300, height: 90 }, textRects: [], text: '', opaque: true };
    expect(inspectRenderedSlide('scene', [panel, label]).some((issue) => issue.id.includes('collision-panel'))).toBe(false);
  });
});
