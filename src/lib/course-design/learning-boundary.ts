import type {
  KnowledgeGraph,
  KnowledgePoint,
} from "@/lib/session/types";
import type {
  TeachingKnowledgeReference,
  TeachingLearningBoundary,
  TeachingPrerequisiteReference,
} from "@/lib/course-quality-review/types";

export type KnowledgeBoundaryGroup = {
  knowledgePointIds: readonly string[];
};

function lessonReference(
  point: KnowledgePoint | undefined,
): TeachingKnowledgeReference | undefined {
  return point ? { id: point.id, name: point.name } : undefined;
}

function prerequisiteReferences(
  currentIds: ReadonlySet<string>,
  graph: KnowledgeGraph | undefined,
): TeachingPrerequisiteReference[] {
  if (!graph) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const result = new Map<string, TeachingPrerequisiteReference>();
  for (const edge of graph.edges) {
    if (
      edge.type !== "required-prerequisite"
      || edge.strength !== "required"
      || !currentIds.has(edge.target)
    ) continue;
    const source = nodeById.get(edge.source);
    if (!source || source.instructionalRole !== "prerequisite") continue;
    result.set(source.id, {
      id: source.id,
      name: source.label,
      ...(source.priorKnowledgeEvidence
        ? { priorKnowledgeEvidence: source.priorKnowledgeEvidence }
        : {}),
      ...(source.diagnosticBoundary
        ? { diagnosticBoundary: source.diagnosticBoundary }
        : {}),
    });
  }
  return [...result.values()];
}

/**
 * Compile learner-state boundaries from the already confirmed teaching order.
 * This function never reorders confirmed groups and never infers mastery from
 * the mere presence of a concept in the course catalog.
 */
export function deriveTeachingLearningBoundaries(
  knowledgePoints: readonly KnowledgePoint[],
  graph: KnowledgeGraph | undefined,
  groups: readonly KnowledgeBoundaryGroup[],
): TeachingLearningBoundary[] {
  const pointById = new Map(knowledgePoints.map((point) => [point.id, point]));
  const taught = new Set<string>();
  const allOrderedIds = [...new Set(groups.flatMap((group) => group.knowledgePointIds))];
  return groups.map((group) => {
    const currentIds = new Set(group.knowledgePointIds.filter((id) => pointById.has(id)));
    const boundary: TeachingLearningBoundary = {
      prerequisiteKnowledge: prerequisiteReferences(currentIds, graph),
      previouslyTaughtKnowledge: [...taught]
        .flatMap((id) => lessonReference(pointById.get(id)) ?? []),
      currentKnowledge: [...currentIds]
        .flatMap((id) => lessonReference(pointById.get(id)) ?? []),
      futureKnowledge: allOrderedIds
        .filter((id) => !taught.has(id) && !currentIds.has(id))
        .flatMap((id) => lessonReference(pointById.get(id)) ?? []),
    };
    currentIds.forEach((id) => taught.add(id));
    return boundary;
  });
}

export function prerequisiteKnowledgeForPoints(
  knowledgePointIds: readonly string[],
  graph: KnowledgeGraph | undefined,
): TeachingPrerequisiteReference[] {
  return prerequisiteReferences(new Set(knowledgePointIds), graph);
}
