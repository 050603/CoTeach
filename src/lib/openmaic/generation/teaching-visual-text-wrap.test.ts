import { afterAll, describe, expect, it } from 'vitest';
import type { TextMeasureInput } from '@openmaic/generation/browser';
import { balanceTeachingText } from './teaching-visual-text-wrap';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

afterAll(closeSpatialMeasurementBrowser);
const render = (value: string) => `<p style="margin:0;font-family:Noto Sans SC;font-size:20px;line-height:1.25">${value.replace(/\n/gu, '<br>')}</p>`;
function input(value: string, width: number): TextMeasureInput {
  return { html: render(value), text: value, width, fontSize: 20, fontWeight: 400,
    fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.25, paragraphSpace: 0, align: 'left', preserveRichText: true };
}

describe('short native text wrapping with actual renderer fonts', () => {
  it.each([
    ['共享观点，启发并完善理解。', 245],
    ['Check related regressions and finish', 310],
  ])('balances the final orphan without changing content or typography: %s', async (value, width) => {
    const authored = input(value, width), before = await measureAuthoredSlideText(authored);
    expect(before.lines).toHaveLength(2);
    let measurements = 0;
    const result = await balanceTeachingText(value, authored, before, (request) => {
      measurements++;
      expect(request.width).toBe(width);
      expect(request.fontSize).toBe(20);
      expect(request.fontFamily).toBe('Noto Sans SC');
      return measureAuthoredSlideText(request);
    }, render);
    expect(result.value).toContain('\n');
    expect(result.value.replace(/\s+/gu, '')).toBe(value.replace(/\s+/gu, ''));
    expect(result.measurement.lines).toHaveLength(2);
    expect(result.measurement.lines[1]!.trim().split(/\s+/u).length > 1
      || [...result.measurement.lines[1]!.replace(/[^\p{L}\p{N}]/gu, '')].length > 2).toBe(true);
    expect(result.measurement.height).toBeLessThanOrEqual(before.height + 1);
    expect(measurements).toBeLessThanOrEqual(3);
  });

  it('preserves an explicitly authored line break and exact numeric conditions', async () => {
    const value = '若 b = 0，不计算 a / b\n应报错并停止', authored = input(value, 240);
    const before = await measureAuthoredSlideText(authored);
    const result = await balanceTeachingText(value, authored, before, () => { throw new Error('Should keep authored breaks'); }, render);
    expect(result).toEqual({ value, html: authored.html, measurement: before });
  });

  it('keeps an unsplittable English term rather than cutting its characters', async () => {
    const value = 'Counterexample', authored = input(value, 95), before = await measureAuthoredSlideText(authored);
    const result = await balanceTeachingText(value, authored, before, measureAuthoredSlideText, render);
    expect(result.value).toBe(value);
    expect(result.html).toBe(authored.html);
  });
});
