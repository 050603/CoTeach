import type { Action } from '@openmaic/lib/types/action';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import { auditAndRepairSlideOnce, type SlideLayoutRepairResult } from './slide-layout-audit';
import { narrationStyleIssues } from './narration-style';

/** Shared by production and experiments: improve the initial authoring
 * contract, then report quality findings without requesting model rewrites. */
export const COURSE_GENERATION_POLICY_VERSION = 'course-first-pass-v23-semantic-components';
export const MAX_COURSE_STAGE_MODEL_REQUESTS = 2;

export function auditGeneratedSlideLocally(
  outline: SceneOutline,
  content: GeneratedSlideContent,
): Promise<SlideLayoutRepairResult> {
  return auditAndRepairSlideOnce({ outline, content, regenerate: async () => null });
}

/** Style observations are review evidence, never a length quota or a reason
 * to replace otherwise playable teacher speech. The original actions stay intact. */
export function collectNarrationAdvisories(actions: readonly Action[]): string[] {
  return narrationStyleIssues(actions.flatMap((action) => action.type === 'speech'
    && action.text.trim()
    ? [{ id: action.id, text: action.text }]
    : []));
}
