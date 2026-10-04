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

export type CourseEvidenceFigureSequence = {
  figureId: string;
  kind: "ordered-steps";
  steps: Array<{ label: string; sourceBlockId: string; excerpt?: string; excerptBlockId?: string }>;
};

export type CourseEvidenceSourceSequence = {
  anchorSourceBlockId: string;
  kind: "ordered-steps";
  steps: CourseEvidenceFigureSequence["steps"];
};

export type CourseEvidenceSource = {
  textbookId: string;
  textbookTitle: string;
  revisionId: string;
  revisionVersion: number;
  sectionId?: string;
  sectionPath: string[];
  /** Parsed directory ancestry, including this section. Older snapshots may only have sectionPath. */
  sectionHierarchy?: Array<{ id: string; title: string; kind: string; level: number }>;
  /** Immutable positions in the selected revision, not retrieval ranks. */
  sectionPosition?: number;
  sourceBlockId?: string;
  /** Retrieval blocks plus complete source units linked to that bounded search chunk. */
  sourceBlockIds?: string[];
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
  /** Whole immutable source blocks omitted or cut by the bounded retrieval excerpt.
   * Context from a parent introduction retains its own original location. */
  completeSourceBlocks?: Array<{ sourceBlockId: string; content: string; source?: CourseEvidenceSource }>;
  /** First-authoring view of the whole adopted section, including unmarked
   * and cross-paragraph cases. This is context, not an obligation to teach it all. */
  sourceContext?: {
    policyVersion: number;
    status: 'complete' | 'partial';
    sectionId?: string;
    sourceBlockIds: string[];
  };
  /** Relation-aware references used for visual planning. */
  figureRefs?: CourseEvidenceFigureReference[];
  /** Complete ordered source facts, including paragraphs beyond the retrieved chunk boundary. */
  figureSequences?: CourseEvidenceFigureSequence[];
  /** Avoid rescanning immutable sections after complete sequence hydration. */
  figureSequencesResolved?: boolean;
  /** Numbered source sequence recovered from the adopted immutable section. */
  sourceSequences?: CourseEvidenceSourceSequence[];
  sourceSequencesResolved?: boolean;
  /** Version of the immutable numbered-list extraction, separate from retrieval metadata. */
  sourceSequencePolicyVersion?: number;
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
  orderedSteps?: CourseEvidenceFigureSequence["steps"];
  evidenceItemIds: string[];
  knowledgePointIds: string[];
  sourceTitle: string;
  status: "available" | "unavailable";
  failureReason?: string;
};

export type CourseSourceSequenceContract = {
  resourceId: string;
  required: boolean;
  /** A retrieved/adopted source is reference material, not a whole-list lesson assignment. */
  coveragePolicy?: 'authored-scope';
  knowledgePointIds: string[];
  orderedSteps: CourseEvidenceSourceSequence['steps'];
  scope: 'knowledge-point';
  /** A numbered checklist preserves every item without inventing a process order. */
  sequenceSemantics?: 'ordered-steps' | 'enumerated-items';
};

export type KnowledgeSourceSequenceReference = {
  resourceId: string;
  sourceEvidenceFingerprint: string;
  sourceEvidenceVersion: number;
  evidenceItemIds: string[];
  sequenceSemantics: 'ordered-steps' | 'enumerated-items';
  orderedSteps: CourseEvidenceSourceSequence['steps'];
};

export function sourceSequenceSemantics(
  item: Pick<CourseEvidenceItem, 'source' | 'content'>,
  steps: readonly { label: string }[],
): 'ordered-steps' | 'enumerated-items' {
  // Explicit phases and the adopted section heading take precedence over a
  // broader chapter that happens to discuss teaching principles or advice.
  if (steps.every((step) => /阶段$/u.test(step.label))) return 'ordered-steps';
  const heading = item.source?.sectionPath?.at(-1) ?? '';
  const content = typeof item.content === 'string' ? item.content : '';
  if (/流程|步骤|过程|框架/u.test(heading)) return 'ordered-steps';
  if (/原则|建议|策略|要点|特征|特点|反思/u.test(heading)
    || /(?:需|要)注意(?:以下|如下)几点/u.test(content)
    || /(?:以下|如下|具有|包括|提出).{0,20}(?:原则|建议|策略|要点|特征|特点)/u
      .test(content.split(/\n\s*[(（]?1[.．、)）]/u)[0] ?? '')) return 'enumerated-items';
  return 'ordered-steps';
}

/** Keep a source list attached to the lesson nodes that adopted its evidence. */
export function resolveCourseSourceSequenceContracts(
  snapshot: Pick<CourseEvidenceSnapshot, 'items' | 'mappings'> | undefined,
  points: readonly { id: string; evidenceItemIds?: readonly string[];
    sourceId?: string; sourceKnowledgePointIds?: readonly string[] }[],
): CourseSourceSequenceContract[] {
  if (!snapshot) return [];
  const byAnchor = new Map<string, CourseSourceSequenceContract>();
  for (const item of snapshot.items) for (const sequence of item.sourceSequences ?? []) {
    const mappingIds = snapshot.mappings.filter((mapping) => mapping.evidenceItemIds.includes(item.id))
      .map((mapping) => mapping.sourceKnowledgePointId);
    const pointIds = points.filter((point) => point.evidenceItemIds !== undefined
      ? point.evidenceItemIds.includes(item.id)
      : [point.id, point.sourceId, ...(point.sourceKnowledgePointIds ?? [])]
        .some((id) => id && mappingIds.includes(id))).map((point) => point.id);
    if (!pointIds.length) continue;
    const current = byAnchor.get(sequence.anchorSourceBlockId);
    if (current) {
      current.knowledgePointIds = [...new Set([...current.knowledgePointIds, ...pointIds])];
    } else byAnchor.set(sequence.anchorSourceBlockId, {
      resourceId: `source-sequence:${sequence.anchorSourceBlockId}`, required: false,
      coveragePolicy: 'authored-scope',
      knowledgePointIds: pointIds, orderedSteps: sequence.steps,
      scope: 'knowledge-point',
      sequenceSemantics: sourceSequenceSemantics(item, sequence.steps),
    });
  }
  return [...byAnchor.values()];
}

/** Bind complete source facts mechanically after evidence adoption. Summary
 * wording remains separate from both these identities and executed teaching. */
export function bindKnowledgeSourceSequenceReferences(
  points: readonly import('@/lib/session/types').KnowledgePoint[],
  snapshot?: CourseEvidenceSnapshot,
): import('@/lib/session/types').KnowledgePoint[] {
  const contracts = resolveCourseSourceSequenceContracts(snapshot
    ? { items: snapshot.items ?? [], mappings: snapshot.mappings ?? [] } : undefined, points);
  const itemById = new Map((snapshot?.items ?? []).map((item) => [item.id, item]));
  return points.map((point) => {
    // Never trust a model-provided reference or retain a stale adoption.
    const bound = { ...point };
    delete bound.sourceSequenceReferences;
    if (!snapshot) return bound;
    const references = contracts.filter((contract) => contract.knowledgePointIds.includes(point.id))
      .map((contract): KnowledgeSourceSequenceReference => ({
        resourceId: contract.resourceId,
        sourceEvidenceFingerprint: snapshot.fingerprint,
        sourceEvidenceVersion: snapshot.version,
        evidenceItemIds: snapshot.items.filter((item) => item.sourceSequences?.some((sequence) =>
          `source-sequence:${sequence.anchorSourceBlockId}` === contract.resourceId))
          .filter((item) => point.evidenceItemIds !== undefined ? point.evidenceItemIds.includes(item.id)
            : (snapshot.mappings ?? []).some((mapping) => mapping.evidenceItemIds.includes(item.id)
              && [point.id, point.sourceId, ...(point.sourceKnowledgePointIds ?? [])]
                .includes(mapping.sourceKnowledgePointId)))
          .map((item) => item.id),
        sequenceSemantics: contract.sequenceSemantics ?? 'ordered-steps',
        orderedSteps: contract.orderedSteps.map((step) => ({ ...step })),
      }));
    // Legacy figure-only snapshots still retain the complete original graph
    // identity. They must not depend on summary labels to reconstruct it.
    for (const evidenceId of point.evidenceItemIds ?? []) {
      for (const sequence of itemById.get(evidenceId)?.figureSequences ?? []) {
        const resourceId = `figure-sequence:${sequence.figureId}`;
        const existing = references.find((reference) => reference.resourceId === resourceId);
        if (existing) {
          if (!existing.evidenceItemIds.includes(evidenceId)) existing.evidenceItemIds.push(evidenceId);
          continue;
        }
        references.push({
          resourceId,
          sourceEvidenceFingerprint: snapshot.fingerprint,
          sourceEvidenceVersion: snapshot.version,
          evidenceItemIds: [evidenceId],
          sequenceSemantics: 'ordered-steps',
          orderedSteps: sequence.steps.map((step) => ({ ...step })),
        });
      }
    }
    if (references.length) bound.sourceSequenceReferences = references;
    return bound;
  });
}

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
    const referencedItems = snapshot.items.filter((item) => referencedIds.has(item.id));
    const sourceBlocks = new Map<string, { sourceBlockId: string; content: string; source: CourseEvidenceSource }>();
    for (const item of referencedItems) for (const block of item.completeSourceBlocks ?? []) {
      const source = block.source ?? { ...item.source, sourceBlockId: block.sourceBlockId,
        sourceBlockPosition: undefined, sourceBlockIds: undefined };
      sourceBlocks.set(`${source.revisionId}:${block.sourceBlockId}`, {
        sourceBlockId: block.sourceBlockId, content: block.content, source: { ...source, quote: undefined },
      });
    }
    return [
      "已选教材的本课证据。先按上游要求查看映射，再按 evidenceItemIds 查看证据正文；同一证据只列一次。completeSourceBlocks 保留原文块引用与位置，完整正文和真实 source 在共享 sourceBlocks 中各列一次，按 revisionId、sourceBlockId 对应。检索相似度本身不代表支持。",
      JSON.stringify({
        primaryRevisionId: snapshot.selections?.find((selection) => selection.primary)?.revisionId,
        mappings: snapshot.mappings.map((mapping) => ({
          sourceKnowledgePointId: mapping.sourceKnowledgePointId,
          sourceKnowledgePointName: mapping.sourceKnowledgePointName,
          status: mapping.status,
          evidenceItemIds: mapping.evidenceItemIds,
          rationale: mapping.rationale,
          uncoveredRequirement: mapping.uncoveredRequirement,
        })),
        sourceBlocks: [...sourceBlocks.values()],
        evidenceItems: referencedItems.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          content: item.content,
          completeSourceBlocks: (item.completeSourceBlocks ?? []).map((block) => {
            const original = sourceBlocks.get(`${block.source?.revisionId ?? item.source.revisionId}:${block.sourceBlockId}`);
            return { sourceBlockId: block.sourceBlockId, source: original?.source };
          }),
          sourceContext: item.sourceContext,
          source: item.source.sourceBlockId && sourceBlocks.has(`${item.source.revisionId}:${item.source.sourceBlockId}`)
            ? { ...item.source, quote: undefined } : item.source,
          figureRefs: item.figureRefs ?? [],
          figureSequences: item.figureSequences ?? [],
          sourceSequences: item.sourceSequences ?? [],
          figureIds: item.figureIds ?? [],
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
          completeSourceBlocks: item.completeSourceBlocks ?? [],
          sourceContext: item.sourceContext,
          source: item.source,
          figureRefs: item.figureRefs ?? [],
          figureSequences: item.figureSequences ?? [],
          sourceSequences: item.sourceSequences ?? [],
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
