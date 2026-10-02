import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { slideVisualOperation } from '@/lib/openmaic/generation/slide-visual-projection';
import { usesTeachingVisualScene, TEACHING_VISUAL_DESIGN_VERSION, TEACHING_VISUAL_PLANNING_VERSION } from '@/lib/openmaic/generation/teaching-visual-scene';
import { TEACHING_VISUAL_COMPILER_VERSION, TEACHING_VISUAL_THEME_VERSION } from '@/lib/openmaic/generation/teaching-visual-theme';
import { fingerprintGenerationValue } from './page-checkpoints';

/** Only the unfinished PPT content stage changes identity. Narration and
 * completed page checkpoints keep their original source/request contracts. */
export function slideVisualContentFingerprint(outline: SceneOutline, pageInputFingerprint: string): string {
  return usesTeachingVisualScene(outline)
    ? fingerprintGenerationValue({ pageInputFingerprint, slideVisualLayoutVersion: TEACHING_VISUAL_DESIGN_VERSION,
      planningVersion: TEACHING_VISUAL_PLANNING_VERSION,
      compilerVersion: TEACHING_VISUAL_COMPILER_VERSION, themeVersion: TEACHING_VISUAL_THEME_VERSION })
    : pageInputFingerprint;
}

export function slideVisualRequestFingerprint(contentInputFingerprint: string, system: string, prompt: string): string {
  return fingerprintGenerationValue({ contentInputFingerprint, operation: slideVisualOperation(system),
    // A single visual response belongs to its exact adopted source catalog.
    // It must never replay a legacy native response or a different page prompt.
    request: fingerprintGenerationValue({ system, prompt }) });
}
