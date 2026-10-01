import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { SLIDE_VISUAL_LAYOUT_VERSION, slideVisualOperation, usesSlideVisualProjection } from '@/lib/openmaic/generation/slide-visual-projection';
import { fingerprintGenerationValue } from './page-checkpoints';

/** Only the unfinished PPT content stage changes identity. Narration and
 * completed page checkpoints keep their original source/request contracts. */
export function slideVisualContentFingerprint(outline: SceneOutline, pageInputFingerprint: string): string {
  return usesSlideVisualProjection(outline)
    ? fingerprintGenerationValue({ pageInputFingerprint, slideVisualLayoutVersion: SLIDE_VISUAL_LAYOUT_VERSION })
    : pageInputFingerprint;
}

export function slideVisualRequestFingerprint(contentInputFingerprint: string, system: string, prompt: string): string {
  return fingerprintGenerationValue({ contentInputFingerprint, operation: slideVisualOperation(system),
    // A single visual response belongs to its exact adopted source catalog.
    // It must never replay a legacy native response or a different page prompt.
    request: fingerprintGenerationValue({ system, prompt }) });
}
