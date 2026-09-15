import type { SlideTheme } from '@openmaic/dsl';

export interface CourseVisualStyle {
  id: string;
  name: string;
  background: string;
  surface: string;
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  mutedText: string;
  theme: SlideTheme;
}

// Keep the generated deck on OpenMAIC's published default theme. The former
// subject-hash palettes made CoTeach pages look unrelated to the upstream
// baseline and caused the same course to inherit a strong warm/cool treatment
// before the model had even chosen a composition.
const OPENMAIC_BASELINE: Omit<CourseVisualStyle, 'theme'> = {
  id: 'openmaic-baseline',
  name: 'OpenMAIC Baseline',
  background: '#FFFFFF',
  surface: '#F4F7FB',
  primary: '#5B9BD5',
  secondary: '#4472C4',
  accent: '#ED7D31',
  text: '#333333',
  mutedText: '#666666',
};

export function resolveCourseVisualStyle(_seed: string): CourseVisualStyle {
  const palette = OPENMAIC_BASELINE;
  return {
    ...palette,
    theme: {
      backgroundColor: palette.background,
      themeColors: ['#5B9BD5', '#ED7D31', '#A5A5A5', '#FFC000', '#4472C4'],
      fontColor: palette.text,
      fontName: 'Noto Sans SC',
      outline: { color: '#D14424', width: 2, style: 'solid' },
      shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
    },
  };
}

export function formatCourseVisualStyle(style: CourseVisualStyle): string {
  return [
    `Theme: ${style.name} (${style.id})`,
    `Canvas background: ${style.background}; content surfaces: ${style.surface}`,
    `Primary: ${style.primary}; secondary: ${style.secondary}; accent: ${style.accent}`,
    `Main text: ${style.text}; secondary text: ${style.mutedText}`,
    '- Use Noto Sans SC for all native text (defaultFontName and rich text font-family), matching the bundled measurement and playback fonts. Keep a white canvas, dark neutral text, blue structure and orange for selective emphasis.',
    '- Use 32–40px titles, 22–28px body, and 18px minimum essential labels. Preserve the exact OpenMAIC grid, text-height lookup, shape-containment, and alignment rules in the system prompt.',
    '- Sparse pages need deliberate full-canvas composition: enlarge and center the focal model with balanced whitespace; do not cluster content in the upper half.',
    '- Use this exact family across every PPT page in the course. Light tints of the baseline colors are allowed; do not invent another saturated palette.',
    '- Use primary for titles and structural anchors, secondary for relationships/comparisons, and accent only for the single most important focus or warning.',
    '- Choose the layout from the page meaning: comparison, process, evidence, hierarchy, worked example, or summary. Preserve generous whitespace and one clear visual focal point.',
  ].join('\n');
}
