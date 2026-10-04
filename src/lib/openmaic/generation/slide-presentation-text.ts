import type { SlidePresentationItem } from '@openmaic/dsl';

const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/\n/gu, '<br>');

/** The same source-bound keyword styling is measured and rendered in prose,
 * tables and native nodes. It never changes the author's words. */
export function presentationRichText(value: string, emphasis: readonly string[] = [],
  style: SlidePresentationItem['emphasisStyle'] = 'color', color = '#334155', unbrokenLimit = 12): string {
  const terms = [...new Set(emphasis.filter((term) => term && value.includes(term)))].sort((a, b) => b.length - a.length);
  let result = '', cursor = 0;
  while (cursor < value.length) {
    const term = terms.find((candidate) => value.startsWith(candidate, cursor));
    if (!term) { result += escape(value[cursor]!); cursor += 1; continue; }
    const treatment = style === 'bold' ? `color:${color}` : style === 'highlight'
      ? `color:${color};background-color:#FEF3C7` : 'color:#C2410C';
    result += `<strong style="${treatment}${Array.from(term).length <= unbrokenLimit ? ';white-space:nowrap' : ''}">${escape(term)}</strong>`;
    cursor += term.length;
  }
  return result;
}
