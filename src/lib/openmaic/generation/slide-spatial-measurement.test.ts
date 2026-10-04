import { afterAll, describe, expect, it } from 'vitest';
import type { TextMeasureInput } from '../../../../packages/@openmaic/generation/src/text-layout-compiler';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

afterAll(closeSpatialMeasurementBrowser);

const spec: TextMeasureInput = { html: '', text: '', width: 400, fontSize: 18, fontWeight: 400,
  fontFamily: 'Noto Sans SC', padding: 10, preserveRichText: true, lineHeight: 1.5, paragraphSpace: 5, align: 'left' };

describe('actual browser font ink for native layouts', () => {
  it('keeps capacity and component layout identical without computing native glyph ink', async () => {
    const plain: TextMeasureInput = { ...spec, preserveRichText: undefined,
      text: '控制条件保持相同\n甲乙两组才可比较', html: '<p>控制条件保持相同</p><p>甲乙两组才可比较</p>' };
    const capacity = await measureAuthoredSlideText(plain);
    const foreground = await measureAuthoredSlideText({ ...plain, preserveRichText: true });
    expect(capacity.inkRects).toBeUndefined();
    expect(foreground.inkRects).toHaveLength(16);
    expect(capacity).toMatchObject({ height: foreground.height, naturalWidth: foreground.naturalWidth, lines: foreground.lines });
  }, 20_000);

  it('measures page 8 header ink rather than the padded line box', async () => {
    const measured = await measureAuthoredSlideText({ ...spec, fontSize: 22, fontWeight: 700, lineHeight: 1.3,
      text: '设计阶段', html: '<p style="font-size:22px;font-weight:bold;">设计阶段</p>' });
    expect(measured.lines).toEqual(['设计阶段']);
    expect(measured.inkRects).toHaveLength(4);
    expect(measured.inkBottom).toBeLessThan(measured.height - 5);
    expect(Math.min(...measured.inkRects!.map((rect) => rect.top))).toBeGreaterThan(spec.padding);
  }, 20_000);

  it('uses actual rich font sizes, baseline positions and shape padding without changing content', async () => {
    const measured = await measureAuthoredSlideText({ ...spec, padding: 0, text: '标签正文',
      html: '<p style="font-size:16px;font-weight:bold;line-height:1.3;">标签</p><p style="font-size:18px;line-height:1.5;">正文</p>' });
    expect(measured.lines).toEqual(['标签', '正文']);
    expect(measured.inkRects).toHaveLength(4);
    const [label, body] = [measured.inkRects!.slice(0, 2), measured.inkRects!.slice(2)];
    expect(Math.min(...body.map((rect) => rect.top))).toBeGreaterThan(Math.max(...label.map((rect) => rect.top + rect.height)));
    expect(Math.max(...body.map((rect) => rect.height))).toBeGreaterThan(Math.max(...label.map((rect) => rect.height)));
  }, 20_000);

  it('leaves unsupported decorated foregrounds on conservative font bounds', async () => {
    const measured = await measureAuthoredSlideText({ ...spec, text: '必要条件',
      html: '<p><span style="text-decoration:underline;">必要条件</span></p>' });
    expect(measured.lines).toEqual(['必要条件']);
    expect(measured.inkRects).toBeUndefined();
    expect(measured.inkBottom).toBeGreaterThan(0);
  }, 20_000);
});
