import type { SceneOutline } from '../types/generation';

/** Match the established lecture slides at authoring time. This is an adopted
 * presentation choice, not a font reduction applied to a failed model draft. */
export const REFERENCE_LECTURE_TYPOGRAPHY = {
  profile: 'reference-lecture-v1',
  bodyFontSize: 18,
  minimumBodyFontSize: 16,
  titleFontSize: 32,
  minimumTitleFontSize: 28,
} as const;

/** Shared by native first-response authoring and local measured compilation. */
export const REFERENCE_LECTURE_STYLE = {
  canvasWidth: 1000, canvasHeight: 562.5, safeMargin: 50,
  fontFamily: 'Noto Sans SC', title: '#1E3A8A', text: '#334155', muted: '#64748B',
  panel: '#EFF6FF', tableBody: '#FFFFFF', border: '#CBD5E1',
  accent: '#ED7D31', emphasis: '#C2410C', highlight: '#FEF3C7',
  lineHeight: 1.5, paragraphSpace: 5,
} as const;

export function hasReferenceLectureTypography(outline: SceneOutline): boolean {
  return outline.teachingBrief?.teachingPlan?.presentationTypography?.profile === REFERENCE_LECTURE_TYPOGRAPHY.profile;
}

export function slideBodyFontSizes(outline: SceneOutline): readonly [number, number] {
  return hasReferenceLectureTypography(outline)
    ? [REFERENCE_LECTURE_TYPOGRAPHY.bodyFontSize, REFERENCE_LECTURE_TYPOGRAPHY.minimumBodyFontSize]
    // Saved pages keep the font contract used to author their raw responses.
    : [24, 22];
}

/** Both title alternatives are chosen before authoring; saved responses are
 * never scaled down to satisfy a changed font profile. */
export function slideTitleFontSizes(outline: SceneOutline): readonly [number, number] {
  return hasReferenceLectureTypography(outline)
    ? [REFERENCE_LECTURE_TYPOGRAPHY.titleFontSize, REFERENCE_LECTURE_TYPOGRAPHY.minimumTitleFontSize]
    : [32, 32];
}

export function slideTypography(outline: SceneOutline): {
  bodyFontSize: number; minimumBodyFontSize: number; titleFontSize: number; minimumTitleFontSize: number;
} {
  const [bodyFontSize, minimumBodyFontSize] = slideBodyFontSizes(outline);
  const [titleFontSize, minimumTitleFontSize] = slideTitleFontSizes(outline);
  return { bodyFontSize, minimumBodyFontSize, titleFontSize, minimumTitleFontSize };
}

export function formatSlidePresentationTypography(outline: SceneOutline): string {
  if (!outline.teachingBrief?.teachingPlan?.presentationTypography) return '';
  const [body, minimum] = slideBodyFontSizes(outline);
  const [title, minimumTitle] = slideTitleFontSizes(outline);
  return `## Adopted lecture-slide typography\nThis page was planned on the existing 1000×562.5 lecture canvas with ${body}px ordinary body text and a ${minimum}px minimum for essential teaching text and table cells. A comparison sharing the page with an observation image uses the planned ${minimum}px compact table font, with ${body}px ordinary explanations. Keep titles at ${minimumTitle}–${title}px. These page-specific values supersede generic 22–28px body and 32–40px title examples. Use Noto Sans SC, the supplied measured padding, line height and paragraph spacing. Select a feasible composition before this first response; preserve complete adopted points, source conditions, images and real diagram relationships. Do not reduce the adopted font of a returned draft to conceal overflow. Detailed oral explanation and case narration do not expand the adopted on-screen text.`;
}
