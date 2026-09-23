import type {
  SceneOutline,
  SceneVisualIntent,
  VisualResourceReference,
} from '@/lib/openmaic/types/generation';
import type { CourseTextbookFigureResource } from './course-evidence-types';

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function assertRequiredTextbookFiguresAvailable(
  resources: readonly CourseTextbookFigureResource[],
): void {
  const unavailable = resources.filter((resource) => resource.required && resource.status !== 'available');
  if (!unavailable.length) return;
  throw new Error([
    '教材中与本课知识点直接关联的必用原图不可读取，课程不能标记为完整生成。',
    ...unavailable.map((resource) => `${resource.sourceTitle} / ${resource.figureId}：${resource.failureReason ?? '图片不可用'}`),
  ].join('\n'));
}

function withoutResource(
  intent: SceneVisualIntent | undefined,
  resourceId: string,
): SceneVisualIntent | undefined {
  if (!intent?.resourceRefs?.some((reference) => reference.resourceId === resourceId)) return intent;
  const resourceRefs = intent.resourceRefs.filter((reference) => reference.resourceId !== resourceId);
  return { ...intent, ...(resourceRefs.length ? { resourceRefs } : { resourceRefs: undefined }) };
}

function representationWithRequiredSource(intent: SceneVisualIntent | undefined): SceneVisualIntent['representation'] {
  if (!intent || intent.representation === 'text' || intent.representation === 'source-image') {
    return 'source-image';
  }
  return 'mixed';
}

function bindResource(
  outline: SceneOutline,
  resource: CourseTextbookFigureResource,
): SceneOutline {
  const reference: VisualResourceReference = {
    resourceId: resource.id,
    kind: 'source-image',
    required: true,
    reason: resource.description ?? `Use the original figure from ${resource.sourceTitle}.`,
    observationGoal: resource.description,
  };
  const existingRefs = outline.visualIntent?.resourceRefs ?? [];
  return {
    ...outline,
    suggestedImageIds: unique([...(outline.suggestedImageIds ?? []), resource.id]),
    visualIntent: {
      observationGoal: outline.visualIntent?.observationGoal
        || resource.description
        || `Observe the source figure from ${resource.sourceTitle}.`,
      ...outline.visualIntent,
      representation: representationWithRequiredSource(outline.visualIntent),
      resourceRefs: [
        ...existingRefs.filter((candidate) => candidate.resourceId !== resource.id),
        reference,
      ],
      rationale: outline.visualIntent?.rationale
        || 'The textbook directly associates this original figure with the knowledge point introduced here.',
    },
  };
}

/**
 * Place each required textbook figure exactly on the first complete slide for
 * its linked knowledge point. The model still chooses optional visuals, while
 * this direct evidence contract cannot be silently moved to a review page.
 */
export function bindRequiredTextbookFiguresToOutlines<T extends SceneOutline>(
  outlines: readonly T[],
  resources: readonly CourseTextbookFigureResource[],
): T[] {
  let result = outlines.map((outline) => ({ ...outline })) as T[];
  for (const resource of resources.filter((candidate) => candidate.required)) {
    const knowledgePointIds = new Set(resource.knowledgePointIds);
    const targetIndex = result.findIndex((outline) => (
      outline.type === 'slide'
      && outline.generationPurpose === 'knowledge-teaching'
      && (outline.knowledgePointIds ?? []).some((id) => knowledgePointIds.has(id))
    ));
    if (targetIndex < 0) {
      throw new Error(`必用教材原图 ${resource.figureId} 没有可绑定的首次知识讲解页。`);
    }

    result = result.map((outline, index) => {
      if (index === targetIndex) return bindResource(outline, resource) as T;
      const suggestedImageIds = outline.suggestedImageIds?.filter((id) => id !== resource.id);
      const visualIntent = withoutResource(outline.visualIntent, resource.id);
      return {
        ...outline,
        ...(suggestedImageIds?.length ? { suggestedImageIds } : { suggestedImageIds: undefined }),
        ...(visualIntent ? { visualIntent } : { visualIntent: undefined }),
      } as T;
    });
  }
  return result;
}
