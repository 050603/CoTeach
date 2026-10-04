import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { SLIDE_VISUAL_LAYOUT_VERSION, SLIDE_VISUAL_AUTHORING_VERSION, slideVisualOperation, usesSlideVisualProjection } from '@/lib/openmaic/generation/slide-visual-projection';
import { NATIVE_LECTURE_AUTHORING_VERSION, usesNativeLectureAuthoring } from '@/lib/openmaic/generation/slide-native-authoring';
import { usesRestoredSlideAuthoring } from '@/lib/openmaic/generation/restored-slide-authoring';
import { fingerprintGenerationValue } from './page-checkpoints';

/** The PPT policy is independent of curriculum, narration and quiz contracts. */
export const SLIDE_VISUAL_STRATEGY_VERSION = 'openmaic-native-4615a98d-v1';

/** Only the unfinished PPT content stage changes identity. Narration and
 * completed page checkpoints keep their original source/request contracts. */
export function slideVisualContentFingerprint(outline: SceneOutline, pageInputFingerprint: string): string {
  return usesRestoredSlideAuthoring(outline)
    ? fingerprintGenerationValue({ pageInputFingerprint, slideVisualStrategyVersion: SLIDE_VISUAL_STRATEGY_VERSION })
    : pageInputFingerprint;
}

/** Read completed PPT stages saved before authoring gained its own version.
 * This is never a compatibility key for an unfinished raw model response. */
export function legacySlideVisualContentFingerprint(outline: SceneOutline, pageInputFingerprint: string): string {
  return usesSlideVisualProjection(outline)
    ? fingerprintGenerationValue({ pageInputFingerprint, slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION })
    : pageInputFingerprint;
}

/** Audited completed drafts remain reusable after the authoring input changes.
 * Their raw model responses must still match the current exact request. */
export function previousSlideVisualContentFingerprints(outline: SceneOutline, pageInputFingerprint: string): string[] {
  const nativePrevious = usesNativeLectureAuthoring(outline) ? [
    NATIVE_LECTURE_AUTHORING_VERSION,
    'native-lecture-composition-v4-source-fact-sets-and-measured-paragraphs',
    'native-lecture-composition-v1',
  ].map((nativeLectureAuthoringVersion) => fingerprintGenerationValue({
    pageInputFingerprint, nativeLectureAuthoringVersion,
  })) : [];
  if (!usesSlideVisualProjection(outline)) return nativePrevious;
  return [SLIDE_VISUAL_AUTHORING_VERSION, 'ppt-visual-authoring-v10-sentence-and-process-design',
    'ppt-visual-authoring-v5-unique-bound-goals-and-facts-only-cases',
    'ppt-visual-authoring-v4-complete-case-elements-and-canonical-basis',
    'ppt-visual-authoring-v3-owned-explanation-and-claim-correspondences',
    'ppt-visual-authoring-v2-mapping-and-optional-emphasis'].map((slideVisualAuthoringVersion) =>
    fingerprintGenerationValue({ pageInputFingerprint, slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION,
      slideVisualAuthoringVersion })).concat([
    legacySlideVisualContentFingerprint(outline, pageInputFingerprint), ...nativePrevious]);
}

export function slideVisualRequestFingerprint(contentInputFingerprint: string, system: string, prompt: string,
  images?: readonly { id: string; src: string }[]): string {
  return fingerprintGenerationValue({ contentInputFingerprint, operation: slideVisualOperation(system),
    // A single visual response belongs to its exact adopted source catalog.
    // It must never replay a legacy native response or a different page prompt.
    request: fingerprintGenerationValue({ system, prompt,
      ...(images?.length ? { images: images.map((image) => fingerprintGenerationValue(image)) } : {}) }) });
}
