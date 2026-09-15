import type { SlideTheme } from '@openmaic/dsl';
import type {
  CourseVisualTheme,
  GeneratedSlideContent,
  SceneOutline,
} from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import { auditSlideDensity } from './slide-layout-audit';

/** Visual roles measured from the supplied OpenMAIC v1.0.2 course export.
 * This is an audit reference, not a first-draft theme injection contract. */
export const OPENMAIC_BLUE_COURSE_THEME: CourseVisualTheme = {
  schemaVersion: 1,
  name: 'OpenMAIC v1.0.2 Blue Editorial Reference',
  background: '#FFFFFF',
  surface: '#F1F5F9',
  primary: '#1E3A8A',
  secondary: '#1E40AF',
  accent: '#ED7D31',
  text: '#334155',
  mutedText: '#64748B',
  motif: '深蓝标题、slate 正文、浅灰蓝内容面与语义关系结构',
  editorialStyle: '清晰、现代、信息充分且结构优先的 OpenMAIC 教学演示风格',
};

/**
 * The current OpenMAIC baseline owns the theme. Model-selected or stale local
 * palettes are intentionally ignored so a resumed job cannot mix deck styles.
 */
export function normalizeCourseVisualTheme(
  _value: unknown,
  _courseSeed: string,
): CourseVisualTheme {
  return { ...OPENMAIC_BLUE_COURSE_THEME };
}

export function resolveOutlineCourseVisualTheme(outline: SceneOutline): CourseVisualTheme {
  return normalizeCourseVisualTheme(
    outline.courseVisualTheme,
    outline.courseVisualDirection?.trim() || 'OpenMAIC course visual theme',
  );
}

/**
 * New CoTeach lecture outlines carry an explicit theme object before the
 * application adds its generation-purpose metadata. Treat that object as the
 * durable opt-in so teacher edits and persisted outline round-trips cannot
 * accidentally disable the course-wide style contract.
 */
export function outlineUsesCourseVisualTheme(outline: SceneOutline): boolean {
  return outline.type === 'slide' && (
    outline.generationPurpose === 'knowledge-teaching'
    || outline.courseVisualTheme !== undefined
  );
}

export function summarizeCourseVisualTheme(theme: CourseVisualTheme): string {
  return `${theme.name}：统一使用 ${theme.background} 背景、${theme.primary} 主色、${theme.secondary} 辅色与 ${theme.accent} 强调色，以${theme.motif}为贯穿母题，呈现${theme.editorialStyle}。`;
}

/**
 * Compact generation-time visual roles measured from the teacher-supplied
 * OpenMAIC web export. This is not a template or deterministic layout plan:
 * the upstream generator still chooses every element and composition. The
 * shared context only supplies the course-level visual information that the
 * public package API does not otherwise carry between independently generated
 * pages.
 */
export function formatOpenMaicWebsiteReferenceProfile(): string {
  return [
    '## OpenMAIC website course-deck reference profile',
    '- Keep the whole deck in one professional editorial system: white or very light slate-blue canvas; deep navy #1E3A8A/#1E40AF for page titles and structural anchors; slate #334155/#475569 for body text; #64748B for subtitles; pale #F1F5F9/#F8FAFC/#EFF6FF content surfaces. Orange #ED7D31 or semantic red may appear once for a genuine emphasis, not as a competing page theme. Keep defaultColor and every inline HTML color consistent with the same role. Do not invent green, purple, yellow, or per-page palettes for decoration.',
    '- Every ordinary lecture page needs a clear title, a distinct explanatory subtitle, and enough visible teaching content to stand on its own: normally 5-7 meaningful content units that develop the supplied description and key points with concise definitions, relationships, conditions, examples, contrasts, or conclusions. Concise must not mean sparse, and topic labels alone are not sufficient.',
    '- Required pre-output structure check for an ordinary lecture page: emit the title as its own navy text element; emit a one-line 18-20px slate subtitle as a second, separate text element directly below it; organize the body into at least three separately positioned groups; and use at least eight editable elements in total across text, meaningful surfaces, dividers, connectors, charts, or tables. Do not place all body content in one oversized text box or paragraph.',
    '- Required pre-output density check for an ordinary text-led lecture page: count meaningful visible Chinese characters and Latin letters after stripping HTML. The complete page must contain 160-230. If it has fewer than 160, add compact supporting explanation, a condition, a contrast, or a concrete example grounded in the supplied key points; do not return a sparse page. Formula-, media-, or diagram-led pages may use less text only when the visible semantic elements themselves carry the missing teaching information.',
    '- Required projection-legibility check: every visible body, label, and native-table cell must render at 16px or larger; only a short, non-essential source note may use 14-15px. If 160-230 meaningful characters do not fit at that size, tighten redundant wording or choose a roomier semantic composition. Never solve fit by shrinking teaching text below 16px.',
    '- Choose the composition from the meaning of this page. Use editorial split panels for definition plus example, connectors for mappings and causal/process relations, hierarchy for levels, charts for quantitative data, and native tables only for a genuine two-dimensional comparison or matrix. Never use a table merely as a grid, card substitute, or default layout.',
    '- Vary the semantic composition across pages while keeping typography, colour roles, spacing rhythm, and line treatment recognizably one deck. Do not repeat a uniform card grid on every page.',
    '- A bottom conclusion/path band is useful only when it summarizes a real takeaway or sequence. When two or more content units have a sequence, mapping, hierarchy, contrast, or causal relation, make that relation visually explicit with aligned groups, dividers, or connectors rather than leaving unrelated cards. Shapes, lines, tables, charts, and colour must communicate meaning rather than fill empty space.',
    '- Preserve every supplied fact and qualification. You may explain or visually organize the provided description and key points, but do not introduce unsupported facts, figures, sources, or claims.',
  ].join('\n');
}

/** @deprecated Offline legacy-engine benchmark only. Production first drafts
 * never append this contract to the official OpenMAIC prompt. */
export function formatCourseVisualThemeContract(theme: CourseVisualTheme): string {
  return [
    '## Legacy offline visual reference contract (never render this text)',
    `- Every slide in this course uses the exact same solid canvas background ${theme.background}. Return exactly {"background":{"type":"solid","color":"${theme.background}"}}; do not substitute white, a nearby tint, or a gradient.`,
    `- Shared palette: surface ${theme.surface}; primary ${theme.primary}; secondary ${theme.secondary}; accent ${theme.accent}; main text ${theme.text}; muted text ${theme.mutedText}. Use these exact tokens for recurring roles. Light tints of surface/primary/secondary are allowed only for contained panels; do not invent unrelated palette colours, and reserve the orange accent for one selective emphasis rather than a second theme.`,
    `- Shared visual motif: ${theme.motif}. Editorial character: ${theme.editorialStyle}. Repeat this visual language subtly across pages without repeating one rigid layout.`,
    '- Keep the upstream body-slide scaffold recognizable across the deck: one upper-left title aligned to the 60/80px grid in the 32–36px title tier, then the semantic content below it inside the 50px safe margins. Do not turn ordinary body pages into unrelated cover-page compositions.',
    '- Layout and visual form must still follow this page\'s meaning. Vary composition when appropriate, but keep background, colour roles, typography family, corner treatment, line weight, and motif recognizably one deck.',
    '- Do not simulate a different page background with a full-canvas shape. Semantic red/green may be used sparingly only when the content itself requires warning/success meaning.',
  ].join('\n');
}

export function slideThemeFromCourseVisualTheme(theme: CourseVisualTheme): SlideTheme {
  return {
    backgroundColor: theme.background,
    themeColors: ['#1E3A8A', '#1E40AF', '#64748B', '#F1F5F9', '#ED7D31'],
    fontColor: theme.text,
    fontName: 'Microsoft YaHei',
    outline: { color: '#D14424', width: 2, style: 'solid' },
    shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
  };
}

/** @deprecated Offline legacy-engine benchmark only; production preserves the
 * official generator output exactly. */
export function applyCourseVisualThemeToSlide(
  content: GeneratedSlideContent,
  theme: CourseVisualTheme,
): GeneratedSlideContent {
  return {
    ...content,
    background: { type: 'solid', color: theme.background },
    theme: slideThemeFromCourseVisualTheme(theme),
  };
}

/** @deprecated Offline legacy-engine benchmark only. */
export function applyOutlineVisualThemeToScene(
  outline: SceneOutline,
  scene: Scene,
): Scene {
  if (
    !outlineUsesCourseVisualTheme(outline)
    || scene.content.type !== 'slide'
  ) {
    return scene;
  }
  const theme = resolveOutlineCourseVisualTheme(outline);
  return {
    ...scene,
    content: {
      ...scene.content,
      canvas: {
        ...scene.content.canvas,
        background: { type: 'solid', color: theme.background },
        theme: slideThemeFromCourseVisualTheme(theme),
      },
    },
  } as Scene;
}

export type CourseVisualConsistencyAudit = {
  expectedBackground?: string;
  slideCount: number;
  matchingBackgroundCount: number;
  distinctBackgrounds: string[];
  passed: boolean;
  deepBlueTitleCount: number;
  subtitleCount: number;
  semanticStructurePageCount: number;
  semanticStructureRequiredCount: number;
  paletteDeviationCount: number;
  repeatedLayoutPageCount: number;
  averageVisibleTextCharacters: number;
  averageElementCount: number;
  averageSemanticElementCount: number;
  referenceProfileVersion: 'openmaic-v1.0.2-export-blue-editorial-v2';
};

function layoutSignature(scene: Scene): string | undefined {
  if (scene.content.type !== 'slide') return undefined;
  return scene.content.canvas.elements
    .filter((element) => element.type !== 'line')
    .map((element) => {
      const width = 'width' in element && typeof element.width === 'number' ? element.width : 0;
      const height = 'height' in element && typeof element.height === 'number' ? element.height : 0;
      return [
        element.type,
        Math.round(element.left / 50),
        Math.round(element.top / 50),
        Math.round(width / 50),
        Math.round(height / 50),
      ].join(':');
    })
    .sort()
    .join('|');
}

export function auditCourseVisualConsistency(
  outlines: readonly SceneOutline[],
  scenes: readonly Scene[],
): CourseVisualConsistencyAudit {
  const outlineById = new Map(outlines.map((outline) => [outline.id, outline]));
  const slides = scenes.filter((scene) => scene.content.type === 'slide');
  const backgrounds = slides.flatMap((scene) => {
    if (scene.content.type !== 'slide') return [];
    const background = scene.content.canvas.background;
    return background?.type === 'solid' && background.color
      ? [background.color.toUpperCase()]
      : background?.type
        ? [background.type]
        : [(scene.content.canvas.theme?.backgroundColor || '#FFFFFF').toUpperCase()];
  });
  const referenceBackgrounds = new Set([
    '#FFFFFF', '#F8FAFC', '#F1F5F9', '#F0F9FF', '#E8F4FD', '#E0F2FE',
  ]);
  const metrics = slides.map((scene, index) => {
    if (scene.content.type !== 'slide') throw new Error('Expected slide');
    const outline = outlineById.get(scene.outlineId ?? '')
      ?? outlines.filter((item) => item.type === 'slide')[index]
      ?? ({
        id: scene.id,
        type: 'slide',
        title: scene.title,
        description: scene.title,
        keyPoints: [],
        order: index,
        generationPurpose: 'knowledge-teaching',
      } as SceneOutline);
    return auditSlideDensity(outline, {
      elements: scene.content.canvas.elements,
      background: scene.content.canvas.background,
      theme: scene.content.canvas.theme,
    });
  });
  const signatures = slides.map(layoutSignature).filter((value): value is string => Boolean(value));
  const signatureCounts = new Map<string, number>();
  signatures.forEach((signature) => signatureCounts.set(signature, (signatureCounts.get(signature) ?? 0) + 1));
  const repeatedLayoutPageCount = [...signatureCounts.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 2), 0);
  const slideCount = slides.length;
  const matchingBackgroundCount = backgrounds.filter((color) => referenceBackgrounds.has(color)).length;
  const deepBlueTitleCount = metrics.filter((metric) => metric.hasDeepBlueTitle).length;
  const subtitleCount = metrics.filter((metric) => metric.hasSubtitle).length;
  const semanticStructureRequiredCount = metrics.filter((metric) => metric.semanticStructureRequired).length;
  const semanticStructurePageCount = metrics.filter((metric) =>
    metric.semanticStructureRequired && metric.semanticStructureSatisfied,
  ).length;
  const paletteDeviationCount = metrics.reduce(
    (sum, metric) => sum + (Number.isFinite(metric.paletteDeviationCount) ? metric.paletteDeviationCount : 0),
    0,
  );
  const average = (values: readonly number[]) => slideCount === 0
    ? 0
    : Number((values.reduce((sum, value) => sum + value, 0) / slideCount).toFixed(1));
  const threshold = Math.ceil(slideCount * 0.95);
  return {
    expectedBackground: 'white-or-light-gray-blue',
    slideCount,
    matchingBackgroundCount,
    distinctBackgrounds: [...new Set(backgrounds)],
    deepBlueTitleCount,
    subtitleCount,
    semanticStructurePageCount,
    semanticStructureRequiredCount,
    paletteDeviationCount,
    repeatedLayoutPageCount,
    averageVisibleTextCharacters: average(metrics.map((metric) => metric.visibleTextCharacters)),
    averageElementCount: average(metrics.map((metric) => metric.elementCount)),
    averageSemanticElementCount: average(metrics.map((metric) => metric.semanticElementCount)),
    referenceProfileVersion: 'openmaic-v1.0.2-export-blue-editorial-v2',
    passed: slideCount === 0 || (
      matchingBackgroundCount >= threshold
      && deepBlueTitleCount >= threshold
      && subtitleCount >= threshold
      && paletteDeviationCount === 0
      && semanticStructurePageCount === semanticStructureRequiredCount
      && repeatedLayoutPageCount <= Math.floor(slideCount * 0.2)
    ),
  };
}
