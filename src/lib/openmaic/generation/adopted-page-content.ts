import type { AuthoringContentItem } from '@openmaic/generation';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { canonicalVisibleContent } from './semantic-page-capacity';

/** The adopted display text is a compiler input, independent of model prose.
 * The catalog belongs only to this page; narration and metadata stay outside it. */
export function adoptedPageAuthoringContent(outline: SceneOutline): AuthoringContentItem[] {
  if (outline.type !== 'slide' || outline.audience === 'teacher'
    || outline.generationPurpose !== 'knowledge-teaching') return [];
  // Historical visibleContent may contain complete source passages. Only an
  // explicitly adopted presentation projection is fixed on the canvas.
  const visible = canonicalVisibleContent({ proposed: outline.teachingBrief?.teachingPlan?.presentationContent });
  const diagram = outline.visualIntent?.diagram;
  const compiledDiagramText = new Set([
    diagram?.annotation,
    ...(diagram?.nodes.map((node) => node.label) ?? []),
    ...(diagram?.edges?.map((edge) => edge.label) ?? []),
  ].filter((text): text is string => Boolean(text?.trim())).map((text) => text.trim()));
  return visible.filter((text) => !compiledDiagramText.has(text)).map((text, index) => ({
    id: `adopted-content-${index + 1}`, text, required: true,
  }));
}
