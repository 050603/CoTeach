import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { formatCourseEvidenceContext, type CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { buildAuthoringSourceCatalog, pageOriginalTeachingSources } from './source-grounding';

/** The quiz receives adopted original passages separately. Remove only the
 * exact rendering of that same course evidence, keeping teacher instructions,
 * supplementary sources and evidence from any other immutable revision. */
export function quizSupplementarySourceContext(context: string | undefined, evidence?: CourseEvidenceSnapshot): string | undefined {
  if (!context || !evidence) return context;
  let supplementary = context;
  for (const deduplicateItems of [false, true]) {
    const rendered = formatCourseEvidenceContext(evidence, { deduplicateItems });
    if (rendered) supplementary = supplementary.split(rendered).join('');
  }
  return supplementary.trim();
}

/** Preserve every original passage, list and provenance while sharing repeated
 * text between overlapping adopted evidence items inside this one request. */
export function quizOriginalTeachingSources(outline: SceneOutline, input: Parameters<typeof pageOriginalTeachingSources>[1]) {
  const original = pageOriginalTeachingSources(outline, input);
  const catalog = buildAuthoringSourceCatalog(new Map([[outline.id, original]]));
  return {
    instruction: 'Resolve source refs in catalog.sources and all text refs in catalog.texts. These are complete adopted original passages, not summaries. Scope preserves original sources, quotes, required lists and authoritative anchors; primary and revision metadata remain attached to each source.',
    catalog: catalog.catalog,
    scope: catalog.pages.get(outline.id),
  };
}
