export type CloudTerm = { label: string; value: number };

// Conservative width estimate for allocating space before the browser measures glyphs.
function textUnits(label: string) {
  return [...label].reduce((units, character) => units + (/[^\u0000-\u00ff]/u.test(character) ? 1 : 0.65), 0);
}

export function planSurveyCloud(terms: CloudTerm[], width: number, height: number, large: boolean) {
  const sorted = [...terms].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "zh-CN"));
  const min = Math.min(...sorted.map((term) => term.value));
  const max = Math.max(...sorted.map((term) => term.value));
  const factors = sorted.map((term) => max === min ? 1 : 0.42 + 0.58 * Math.sqrt((term.value - min) / (max - min)));
  const weightedArea = sorted.reduce((area, term, i) => area + (textUnits(term.label) + 0.8) * factors[i] ** 2, 0);
  // Sparse clouds stay readable and compact instead of expanding to all four edges.
  const maximum = Math.max(1, Math.min(
    large ? 96 : 72,
    height * 0.34,
    Math.sqrt(width * height * 0.28 / Math.max(1, weightedArea)),
    ...sorted.map((term, i) => width * 0.82 / Math.max(1, textUnits(term.label) * factors[i])),
  ));
  return sorted.map((term, i) => ({ text: term.label, value: term.value, size: maximum * factors[i], rotate: 0 }));
}
