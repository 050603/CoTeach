export const COURSE_EVIDENCE_SCHEMA_VERSION = 2 as const;

export type CourseTextbookSelection = {
  revisionId: string;
  /** The primary textbook wins when selected books disagree. Exactly one selected revision must be primary. */
  primary: boolean;
  /** Empty means every parsed body section in this immutable revision. */
  sectionIds: string[];
};

export type TextbookEvidenceKind = "source-block" | "concept" | "example";

export type CourseEvidenceFigureRelation =
  | "concept-direct"
  | "source-block-direct"
  | "concept-evidence-direct"
  | "example-concept"
  | "section-candidate";

export type CourseEvidenceFigureReference = {
  figureId: string;
  relation: CourseEvidenceFigureRelation;
  /** Only direct evidence may become a required textbook visual. */
  direct: boolean;
  /** Figures from one source block form one indivisible observation group. */
  groupKey?: string;
};

export type CourseEvidenceSource = {
  textbookId: string;
  textbookTitle: string;
  revisionId: string;
  revisionVersion: number;
  sectionId?: string;
  sectionPath: string[];
  /** Immutable positions in the selected revision, not retrieval ranks. */
  sectionPosition?: number;
  sourceBlockId?: string;
  sourceBlockPosition?: number;
  quoteStart?: number;
  quote?: string;
};

export type CourseEvidenceItem = {
  id: string;
  kind: TextbookEvidenceKind;
  title: string;
  content: string;
  aliases?: string[];
  source: CourseEvidenceSource;
  /** Relation-aware references used for visual planning. */
  figureRefs?: CourseEvidenceFigureReference[];
  /** Compatibility projection for older snapshots and readers. */
  figureIds?: string[];
  /** RRF score is retrieval evidence only. It is never treated as proof that the source supports a lesson target. */
  retrievalScore?: number;
};

export type CourseEvidenceMapping = {
  sourceKnowledgePointId: string;
  sourceKnowledgePointName: string;
  status: "direct" | "partial" | "none";
  evidenceItemIds: string[];
  rationale: string;
  uncoveredRequirement?: string;
};

export type CourseEvidenceSnapshot = {
  schemaVersion: typeof COURSE_EVIDENCE_SCHEMA_VERSION;
  version: number;
  fingerprint: string;
  createdAt: string;
  retrievalMode: "hybrid" | "lexical-degraded";
  selections: CourseTextbookSelection[];
  items: CourseEvidenceItem[];
  mappings: CourseEvidenceMapping[];
  warnings: string[];
};

/** Persisted course-safe reference. Workers temporarily replace src with bytes for vision, then restore publicSrc in generated slides. */
export type CourseTextbookFigureResource = {
  id: string;
  figureId: string;
  assetId?: string;
  src?: string;
  publicSrc?: string;
  pageNumber: number;
  description?: string;
  width?: number;
  height?: number;
  relation: "direct" | "candidate";
  required: boolean;
  groupKey?: string;
  evidenceItemIds: string[];
  knowledgePointIds: string[];
  sourceTitle: string;
  status: "available" | "unavailable";
  failureReason?: string;
};

export type TextbookListItem = {
  id: string;
  title: string;
  author?: string | null;
  status: string;
  ownerId: string;
  currentRevision?: {
    id: string;
    version: number;
    status: string;
  } | null;
};

export function formatCourseEvidenceContext(
  snapshot?: CourseEvidenceSnapshot,
  options: { deduplicateItems?: boolean } = {},
): string {
  if (!snapshot?.items.length) return "";
  const itemById = new Map(snapshot.items.map((item) => [item.id, item]));
  if (options.deduplicateItems) {
    const referencedIds = new Set(snapshot.mappings.flatMap((mapping) => mapping.evidenceItemIds));
    return [
      "已选教材的本课证据。先按上游要求查看映射，再按 evidenceItemIds 查看证据正文；同一证据只列一次。检索相似度本身不代表支持。",
      JSON.stringify({
        mappings: snapshot.mappings.map((mapping) => ({
          sourceKnowledgePointId: mapping.sourceKnowledgePointId,
          sourceKnowledgePointName: mapping.sourceKnowledgePointName,
          status: mapping.status,
          evidenceItemIds: mapping.evidenceItemIds,
          rationale: mapping.rationale,
          uncoveredRequirement: mapping.uncoveredRequirement,
        })),
        evidenceItems: snapshot.items.filter((item) => referencedIds.has(item.id)).map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          content: item.content,
          source: item.source,
          figureRefs: item.figureRefs ?? [],
        })),
      }),
      snapshot.retrievalMode === "lexical-degraded"
        ? "本次仅完成关键词检索；不得把未判定的相似内容说成教材已支持。"
        : "本次候选由关键词与语义检索召回，并已按原文证据保存。",
    ].join("\n\n");
  }
  return [
    "已选教材的本课证据（只把原文和明确整理结果当作教材依据；检索相似度本身不代表支持）：",
    "来源类型、出处、证据编号及‘教材原例/教学改编/AI 补充’等分类只供内部规划和教师授课前确认。学生可见的 PPT、页面文字和逐字讲稿必须直接、自然地呈现知识、案例和活动，不得宣读或显示这些分类、来源说明及审查过程。",
    ...snapshot.mappings.map((mapping) => {
      const evidence = mapping.evidenceItemIds
        .map((id) => itemById.get(id))
        .filter((item): item is CourseEvidenceItem => Boolean(item))
        .map((item) => ({
          evidenceId: item.id,
          kind: item.kind,
          title: item.title,
          content: item.content,
          source: item.source,
          figureRefs: item.figureRefs ?? [],
          figureIds: item.figureIds ?? [],
        }));
      return JSON.stringify({
        upstreamKnowledgePoint: {
          id: mapping.sourceKnowledgePointId,
          name: mapping.sourceKnowledgePointName,
        },
        support: mapping.status,
        rationale: mapping.rationale,
        uncoveredRequirement: mapping.uncoveredRequirement,
        evidence,
      });
    }),
    snapshot.retrievalMode === "lexical-degraded"
      ? "注意：本次因向量服务不可用只完成关键词检索；不得把未判定的相似内容说成教材已支持。"
      : "本次候选由关键词与语义检索召回，并已按原文证据保存。",
  ].join("\n\n");
}
