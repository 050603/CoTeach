import type { KnowledgePoint } from "@/lib/session/types";
import type { CourseEvidenceSnapshot, CourseEvidenceSource } from "./course-evidence-types";

export type TextbookTeachingAnchor = {
  knowledgePointId: string;
  evidenceItemId?: string;
  sectionPath: string[];
  sectionPosition?: number;
  sourceBlockPosition?: number;
  quoteStart?: number;
  status: "primary-textbook" | "unlocated";
};

export type TeachingOrderAdjustment = {
  knowledgePointId: string;
  beforeKnowledgePointId: string;
  kind: "necessary-dependency" | "learner-obstacle";
  obstacle: string;
  basis: string;
};

export type TextbookTeachingOrder = {
  primaryRevisionId: string;
  baselineKnowledgePointIds: string[];
  knowledgePointIds: string[];
  anchors: TextbookTeachingAnchor[];
  adjustments: TeachingOrderAdjustment[];
};

function position(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value : Number.MAX_SAFE_INTEGER;
}

function compareSource(left: CourseEvidenceSource, right: CourseEvidenceSource): number {
  return position(left.sectionPosition) - position(right.sectionPosition)
    || position(left.sourceBlockPosition) - position(right.sourceBlockPosition)
    || position(left.quoteStart) - position(right.quoteStart);
}

/** Retrieval rank is intentionally absent: only the cited primary source can anchor a lesson point. */
export function textbookTeachingBaseline(
  points: readonly (Pick<KnowledgePoint, "id" | "evidenceItemIds"> & { name?: string })[],
  snapshot: CourseEvidenceSnapshot,
): { primaryRevisionId: string; anchors: TextbookTeachingAnchor[]; baselineKnowledgePointIds: string[] } {
  const primaryRevisionId = snapshot.selections.find((selection) => selection.primary)?.revisionId ?? "";
  const evidenceById = new Map(snapshot.items.map((item) => [item.id, item]));
  const anchors = points.map((point): TextbookTeachingAnchor => {
    const cited = (point.evidenceItemIds ?? [])
      .map((id) => evidenceById.get(id))
      .filter((item): item is NonNullable<typeof item> => item !== undefined);
    const pointName = point.name?.replace(/\s+/gu, "").toLocaleLowerCase() ?? "";
    const usableCited = cited.filter((item) => item.kind !== "example"
      && item.source.revisionId === primaryRevisionId
      && position(item.source.sectionPosition) !== Number.MAX_SAFE_INTEGER);
    const citedConcepts = usableCited.filter((item) => item.kind === "concept");
    const candidates = citedConcepts.length ? citedConcepts : usableCited.length ? usableCited : snapshot.items.filter((item) => item.kind === "concept"
      && pointName.length > 0
      && [item.title, ...(item.aliases ?? [])].some((name) => name.replace(/\s+/gu, "").toLocaleLowerCase() === pointName));
    const adopted = candidates
      .filter((item) => item.kind !== "example"
        && item.source.revisionId === primaryRevisionId
        && position(item.source.sectionPosition) !== Number.MAX_SAFE_INTEGER)
      .sort((left, right) => compareSource(left.source, right.source))[0];
    return adopted ? {
      knowledgePointId: point.id,
      evidenceItemId: adopted.id,
      sectionPath: adopted.source.sectionPath,
      sectionPosition: adopted.source.sectionPosition,
      sourceBlockPosition: adopted.source.sourceBlockPosition,
      quoteStart: adopted.source.quoteStart,
      status: "primary-textbook",
    } : { knowledgePointId: point.id, sectionPath: [], status: "unlocated" };
  });
  const originalIndex = new Map(points.map((point, index) => [point.id, index]));
  const anchorById = new Map(anchors.map((anchor) => [anchor.knowledgePointId, anchor]));
  const baselineKnowledgePointIds = points.map((point) => point.id).sort((leftId, rightId) => {
    const left = anchorById.get(leftId)!;
    const right = anchorById.get(rightId)!;
    if (left.status !== right.status) return left.status === "primary-textbook" ? -1 : 1;
    return position(left.sectionPosition) - position(right.sectionPosition)
      || position(left.sourceBlockPosition) - position(right.sourceBlockPosition)
      || position(left.quoteStart) - position(right.quoteStart)
      || originalIndex.get(leftId)! - originalIndex.get(rightId)!;
  });
  return { primaryRevisionId, anchors, baselineKnowledgePointIds };
}
