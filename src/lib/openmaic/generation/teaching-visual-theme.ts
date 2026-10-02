import type { SlideTheme } from '@openmaic/dsl';

/** Versioned authoring choices, shared by browser edits and production. */
export const TEACHING_VISUAL_THEME_VERSION = 'teaching-visual-theme-v3';
export const TEACHING_VISUAL_COMPILER_VERSION = 'teaching-visual-compiler-v5';
export const TEACHING_VISUAL_THEME = {
  background: '#FFFFFF', text: '#24364B', muted: '#6A7C8D',
  blue: '#365D95', teal: '#167D73', warm: '#A96522',
  line: '#D9E4EC', pale: '#F2F6FA', mint: '#EDF7F3', warmPale: '#FFF6E9',
  font: 'Noto Sans SC', title: 32, label: 24, body: 20, minimum: 18,
} as const;

export function teachingVisualSlideTheme(): SlideTheme {
  const t = TEACHING_VISUAL_THEME;
  return { backgroundColor: t.background, fontName: t.font, fontColor: t.text,
    themeColors: [t.blue, t.teal, t.warm, t.pale, t.mint],
    outline: { color: t.line, width: 1, style: 'solid' },
    shadow: { h: 0, v: 0, blur: 0, color: '#00000000' } };
}
