import type {
  TeachingBlueprintPage,
  TeachingBlueprintSection,
  TeachingBlueprintUnit,
  TeachingExplanationNode,
} from '@/lib/session/types';
import { canonicalVisibleContent } from '@/lib/openmaic/generation/semantic-page-capacity';

function unitExplanationNodes(unit: TeachingBlueprintUnit): TeachingExplanationNode[] {
  if (unit.explanationNodes?.length) return unit.explanationNodes;
  return [{
    id: `${unit.id}:legacy-explanation`,
    kind: unit.mechanism.trim() ? 'mechanism' : 'concept',
    content: unit.mechanism.trim() || unit.explanation.trim() || unit.learningOutcome.trim(),
    knowledgePointIds: [...unit.knowledgePointIds],
    prerequisiteNodeIds: [],
    provenance: unit.sourceKind === 'course-source' ? 'course-source' : 'general-knowledge',
  }];
}

/** Separate the authored display points from this page's full teaching meaning. */
export function projectTeachingPageContent(
  section: Pick<TeachingBlueprintSection, 'units'>,
  page?: TeachingBlueprintPage,
) {
  const unitIds = new Set(page?.unitIds ?? section.units.map((unit) => unit.id));
  const units = section.units.filter((unit) => unitIds.has(unit.id));
  const nodeById = new Map(section.units.flatMap((unit) =>
    unitExplanationNodes(unit).map((node) => [node.id, node] as const)));
  const ownedNodeIds = page
    ? [...(page.introducesNodeIds ?? []), ...(page.deepensNodeIds ?? [])]
    : units.flatMap((unit) => unitExplanationNodes(unit).map((node) => node.id));
  const ownedNodes = ownedNodeIds.flatMap((id) => nodeById.get(id) ?? []);
  const explanation = ownedNodes
    .filter((node) => node.kind === 'term' || node.kind === 'concept' || node.kind === 'relation')
    .map((node) => node.content);
  const reasoningSteps = ownedNodes
    .filter((node) => node.kind !== 'term' && node.kind !== 'concept' && node.kind !== 'relation')
    .map((node) => node.content);
  if (!explanation.length) explanation.push(...ownedNodes.map((node) => node.content));
  const introducedNodeIds = new Set(page?.introducesNodeIds ?? []);
  const introducedConceptDefinitions = ownedNodes
    .filter((node) => introducedNodeIds.has(node.id) && (node.kind === 'term' || node.kind === 'concept'))
    .map((node) => node.content);
  const independentVisibleContent = page?.type === 'interactive' && page.learningTask?.caseUse === 'independent'
    ? [
        ...introducedConceptDefinitions,
        ...(introducedConceptDefinitions.length ? [] : [page.keyPoints[0]]),
        page.learningTask.learnerAction,
        ...page.learningTask.changedConditions,
        ...page.learningTask.preservedConditions,
      ].filter((item): item is string => Boolean(item?.trim()))
    : undefined;
  const visibleContent = canonicalVisibleContent({
    // Interactive tasks still need their full operating conditions. A lecture
    // slide owns its authored display, while its definitions are spoken.
    required: page?.type === 'interactive' ? introducedConceptDefinitions : [],
    proposed: independentVisibleContent ?? page?.keyPoints ?? [],
  });
  // The blueprint author has already selected the self-contained points for
  // the slide. Full source definitions still belong to the teaching channel;
  // promoting them here would undo that selection and invalidate capacity
  // planning. Exact deduplication preserves distinct conditions and wording.
  const presentationContent = [...new Set((page?.keyPoints ?? [])
    .map((point) => point.trim()).filter(Boolean))];
  return {
    ownedNodes,
    explanation,
    reasoningSteps,
    introducedConceptDefinitions,
    visibleContent,
    presentationContent,
  };
}
