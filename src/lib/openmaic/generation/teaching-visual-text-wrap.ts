import type { TextMeasure, TextMeasureInput, TextMeasureResult } from '@openmaic/generation/browser';

const normalized = (value: string) => value.replace(/\s+/gu, '');
const forbiddenStart = /^[，。！？、；：,.;:!?%％)\]】》」』]/u;
const forbiddenEnd = /[(\[【《「『]$/u;

function orphan(value: string): boolean {
  const letters = value.trim().replace(/[^\p{L}\p{N}]/gu, '');
  return letters.length > 0 && (/[\p{Script=Han}]/u.test(letters)
    ? [...letters].length <= 2 : /^[\p{L}\p{N}]+[.!?,;:]?$/u.test(value.trim()));
}

/** Balance a short label's two measured lines, preserving its exact content,
 * authored breaks, size and width. At most three browser measurements are used;
 * failure keeps the original measured text rather than changing its meaning. */
export async function balanceTeachingText(value: string, input: TextMeasureInput,
  measurement: TextMeasureResult, measure: TextMeasure, render: (value: string) => string
): Promise<{ value: string; html: string; measurement: TextMeasureResult }> {
  const original = { value, html: input.html, measurement };
  if (/[\r\n]/u.test(value) || measurement.lines.length !== 2
    || !orphan(measurement.lines[1]!)
    || normalized(measurement.lines.join('')) !== normalized(value)) return original;
  const segments = [...new Intl.Segmenter('zh-CN', { granularity: 'word' }).segment(value)];
  const candidates = segments.slice(1).map(({ index }) => {
    const first = value.slice(0, index), second = value.slice(index);
    return { first, second, score: Math.abs(normalized(first).length - normalized(second).length) };
  }).filter(({ first, second }) => !orphan(first) && !orphan(second)
    && !forbiddenEnd.test(first.trimEnd()) && !forbiddenStart.test(second.trimStart()))
    .sort((a, b) => a.score - b.score).slice(0, 3);
  for (const { first, second } of candidates) {
    const display = `${first}\n${second}`, html = render(display);
    const next = await measure({ ...input, html, text: display });
    if (normalized(display) === normalized(value) && next.lines.length === 2
      && next.lines.every((line) => !orphan(line) && !forbiddenStart.test(line.trimStart()))
      && Number.isFinite(next.height) && next.height <= measurement.height + 1
      && (next.inkRight ?? 0) <= input.width + 1) return { value: display, html, measurement: next };
  }
  return original;
}
