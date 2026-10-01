export interface ChartPresentationTypography {
  bodyFontSize: number;
  minimumBodyFontSize: number;
  /** Selected from the measured page composition before requesting a draft. */
  chartFontSize?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Apply the adopted font before chart compilation, preserving all chart data
 * and geometry. Historical drafts without a presentation profile are untouched.
 * Explicit usable fonts are retained even when they deviate from the profile. */
export function adoptChartPresentationTypography<T extends { elements?: unknown; layout?: unknown }>(
  draft: T, typography?: ChartPresentationTypography, onDiagnostic?: (detail: string) => void,
): T {
  if (!typography) return draft;
  const allowed = [typography.bodyFontSize, typography.minimumBodyFontSize];
  const selected = typography.chartFontSize ?? typography.bodyFontSize;
  if (!allowed.every((font) => Number.isFinite(font) && font > 0) || !Number.isFinite(selected) || selected <= 0) {
    onDiagnostic?.('Chart presentation typography is unavailable; retaining renderer defaults');
    return draft;
  }
  if (!allowed.includes(selected)) {
    onDiagnostic?.(`Chart presentation selected font ${selected}px differs from the adopted ordinary or compact font`);
  }
  const chart = (value: unknown): unknown => {
    if (!record(value) || value.type !== 'chart') return value;
    if (value.options !== undefined && value.options !== null && !record(value.options)) {
      onDiagnostic?.('Chart presentation options were not an object; applying font defaults without changing chart data');
    }
    const options = record(value.options) ? value.options : {};
    const fontSize = options.fontSize == null ? selected : options.fontSize;
    if (typeof fontSize !== 'number' || !Number.isFinite(fontSize) || fontSize <= 0) {
      onDiagnostic?.('Chart presentation font was invalid; applying the selected font without changing chart data');
      return { ...value, options: { ...options, fontSize: selected } };
    }
    if (!allowed.includes(fontSize)) {
      onDiagnostic?.(`Chart presentation font ${fontSize}px differs from ${allowed.join(' or ')}px; retaining the authored font`);
    }
    return { ...value, options: { ...options, fontSize } };
  };
  const block = (value: unknown): unknown => {
    if (!record(value)) return value;
    if (value.kind === 'native') return { ...value, element: chart(value.element) };
    if ((value.kind === 'row' || value.kind === 'column') && Array.isArray(value.children)) {
      return { ...value, children: value.children.map(block) };
    }
    return value;
  };
  return { ...draft,
    ...(Array.isArray(draft.elements) ? { elements: draft.elements.map(chart) } : {}),
    ...(record(draft.layout) && Array.isArray(draft.layout.groups)
      ? { layout: { ...draft.layout, groups: draft.layout.groups.map(block) } } : {}),
  };
}
