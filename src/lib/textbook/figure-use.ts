import type { CourseTextbookFigureResource } from './course-evidence-types';

/** Fields shared by authored blueprint pages and their compiled outlines. */
export type FigureUsePage = {
  sourceSequenceUses?: readonly unknown[];
  caseObservation?: { kind?: string; resourceIds?: readonly string[] };
  resourceNeeds?: readonly { kind: string; assetId?: string }[];
  teachingBrief?: {
    teachingPlan?: { sourceSequenceUses?: readonly unknown[] };
    resourceNeeds?: readonly { kind: string; assetId?: string }[];
  };
  visualIntent?: {
    resourceRefs?: readonly { kind: string; resourceId: string; required: boolean }[];
  };
  suggestedImageIds?: readonly string[];
};

export function selectedFigureIds(page: FigureUsePage): string[] {
  return [
    ...(page.caseObservation?.kind === 'source-image' ? page.caseObservation.resourceIds ?? [] : []),
    ...[...(page.resourceNeeds ?? []), ...(page.teachingBrief?.resourceNeeds ?? [])]
      .flatMap((need) => need.kind === 'source-image' && need.assetId ? [need.assetId] : []),
    ...(page.visualIntent?.resourceRefs ?? [])
      .filter((reference) => reference.kind === 'source-image' && reference.required)
      .map((reference) => reference.resourceId),
    ...(page.suggestedImageIds ?? []),
  ];
}

export function hasExplicitFigureScope(pages: readonly FigureUsePage[]): boolean {
  return pages.some((page) => Array.isArray(page.sourceSequenceUses)
    || Array.isArray(page.teachingBrief?.teachingPlan?.sourceSequenceUses));
}

/** A source diagnostic for logs or final teacher review; never an authoring exception. */
export function findCourseTextbookFigureUseIssues(
  resources: readonly CourseTextbookFigureResource[], pages: readonly FigureUsePage[],
): string[] {
  if (!hasExplicitFigureScope(pages)) return [];
  const knownIds = new Set(resources.flatMap((resource) => [resource.id, ...(resource.assetId ? [resource.assetId] : [])]));
  // Other uploaded images share source-image fields and have their own catalog.
  const unknownIds = [...new Set(pages.flatMap(selectedFigureIds))]
    .filter((id) => id.startsWith('textbook_fig_') && !knownIds.has(id));
  return unknownIds.map((id) => `实际采用的教材原图不在当前教材资源目录中：${id}`);
}

/**
 * Evidence adoption makes a figure available as a reference. In the explicit
 * authoring protocol, only actual page choices make it a required visual.
 * Old accepted pages retain their original obligations and resource order.
 */
export function scopeCourseTextbookFigures(
  resources: readonly CourseTextbookFigureResource[], pages: readonly FigureUsePage[],
): CourseTextbookFigureResource[] {
  if (!hasExplicitFigureScope(pages)) return [...resources];

  const chosenIds = new Set(pages.flatMap(selectedFigureIds));
  const selected = (resource: CourseTextbookFigureResource) => chosenIds.has(resource.id)
    || Boolean(resource.assetId && chosenIds.has(resource.assetId));
  const groups = new Set(resources.filter((resource) => selected(resource) && resource.groupKey)
    .map((resource) => resource.groupKey!));
  return resources.map((resource) => ({ ...resource,
    required: selected(resource) || Boolean(resource.groupKey && groups.has(resource.groupKey)),
  }));
}
