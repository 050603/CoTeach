import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { ResourcePackageTeachingPoint } from "@/lib/course-design/resource-package-knowledge";
import type { KnowledgePoint } from "@/lib/session/types";
import { searchTextbookEvidence } from "@/lib/textbook/service";
import {
  SOURCE_SEQUENCE_POLICY_VERSION,
  extractFigureSequence,
  extractOrderedSourceSequences,
} from "@/lib/textbook/figure-sequence";
import { normalizeTextbookText } from "@/lib/textbook/text";
import {
  COURSE_EVIDENCE_SCHEMA_VERSION,
  type CourseEvidenceItem,
  type CourseEvidenceFigureReference,
  type CourseEvidenceMapping,
  type CourseEvidenceSnapshot,
  type CourseTextbookSelection,
  type CourseTextbookFigureResource,
} from "@/lib/textbook/course-evidence-types";

export class CourseEvidenceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CourseEvidenceError";
  }
}

function stableFingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sectionPath(path: string, title: string): string[] {
  const values = path.split(/[/>]/u).map((part) => part.trim()).filter(Boolean);
  return values.length ? values : [title];
}

function retrievalBlockIds(metadata: unknown, firstId?: string): string[] {
  const value = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as { sourceBlockIds?: unknown }).sourceBlockIds : undefined;
  return [...new Set([
    ...(Array.isArray(value) ? value.filter((id): id is string => typeof id === "string" && Boolean(id)) : []),
    ...(firstId ? [firstId] : []),
  ])];
}

export const COURSE_SOURCE_CONTEXT_POLICY_VERSION = 1;

/** Resolve the real topical section, rather than just paragraphs with example
 * markers. A case may start before the retrieved chunk and finish after it. */
async function hydrateSectionAuthoringContext(
  items: readonly CourseEvidenceItem[],
  idsByItem: ReadonlyMap<string, readonly string[]>,
  blockById: ReadonlyMap<string, { id: string; revisionId: string; sectionId: string; position: number }>,
): Promise<CourseEvidenceItem[]> {
  const needsContext = (item: CourseEvidenceItem) => item.sourceContext?.policyVersion !== COURSE_SOURCE_CONTEXT_POLICY_VERSION
    || item.sourceContext.status !== 'complete' || item.sourceContext.sectionId !== item.source.sectionId;
  const anchorsByItem = new Map(items.filter(needsContext).map((item) => [item.id,
    (idsByItem.get(item.id) ?? []).flatMap((id) => {
      const block = blockById.get(id);
      return block && block.revisionId === item.source.revisionId && block.sectionId
        && (!item.source.sectionId || block.sectionId === item.source.sectionId) ? [block] : [];
    }),
  ]));
  const revisionIds = [...new Set([...anchorsByItem.values()].flat().map((block) => block.revisionId))];
  if (!revisionIds.length) return items.map((item) => needsContext(item)
    ? { ...item, sourceContext: { policyVersion: COURSE_SOURCE_CONTEXT_POLICY_VERSION,
      status: 'partial' as const, sectionId: item.source.sectionId, sourceBlockIds: [] } } : item);
  const sections = await prisma.textbookSection.findMany({
    where: { revisionId: { in: revisionIds } },
    select: { id: true, revisionId: true, parentId: true, title: true, path: true,
      kind: true, level: true, position: true },
  });
  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const scopesByItem = new Map([...anchorsByItem].map(([id, anchors]) => {
    const roots = [...new Set(anchors.map((block) => block.sectionId))].flatMap((sectionId) => {
      const section = sectionById.get(sectionId);
      return section && section.revisionId === anchors[0]?.revisionId ? [section] : [];
    });
    const scope = roots.flatMap((root) => {
      // A retrieved chapter introduction does not authorize expanding its
      // unrelated topics. Within a topic, child subsections retain case prose.
      const included = new Set([root.id]);
      if (root.kind !== 'CHAPTER' && root.kind !== 'FRONT_MATTER') {
        let changed = true;
        while (changed) {
          changed = false;
          for (const section of sections) {
            if (section.revisionId === root.revisionId && section.parentId && included.has(section.parentId)
              && !included.has(section.id) && section.kind !== 'CHAPTER' && section.kind !== 'FRONT_MATTER') {
              included.add(section.id); changed = true;
            }
          }
        }
      }
      return [{ root, revisionId: root.revisionId, sectionId: { in: [...included] } }];
    });
    return [id, scope] as const;
  }));
  const scopes = [...new Map([...scopesByItem.values()].flat().map((scope) => [scope.root.id, scope])).values()];
  const blocks = scopes.length ? await prisma.textbookSourceBlock.findMany({
    where: { OR: scopes.map(({ revisionId, sectionId }) => ({ revisionId, sectionId })) },
    orderBy: { position: 'asc' },
    select: { id: true, revisionId: true, sectionId: true, position: true, blockType: true, content: true },
  }) : [];
  return items.map((item) => {
    if (!needsContext(item)) return item;
    const scopes = scopesByItem.get(item.id) ?? [];
    const contextBlocks = blocks.filter((block) => scopes.some((scope) => block.revisionId === scope.revisionId
      && scope.sectionId.in.includes(block.sectionId)) && block.blockType !== 'HEADING' && block.blockType !== 'TITLE'
      && Boolean(normalizeTextbookText(block.content)));
    const complete = scopes.length === 1 && scopes[0]!.root.kind !== 'CHAPTER' && scopes[0]!.root.kind !== 'FRONT_MATTER'
      && Boolean(contextBlocks.length) && (idsByItem.get(item.id) ?? []).every((id) =>
        contextBlocks.some((block) => block.id === id));
    const additions = new Map((item.completeSourceBlocks ?? []).map((block) => [block.sourceBlockId, block]));
    for (const block of contextBlocks) {
      const section = sectionById.get(block.sectionId);
      if (!section) continue;
      const hierarchy: NonNullable<CourseEvidenceItem['source']['sectionHierarchy']> = [];
      let ancestor: typeof section | undefined = section;
      const visited = new Set<string>();
      while (ancestor && ancestor.revisionId === item.source.revisionId && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        hierarchy.unshift({ id: ancestor.id, title: ancestor.title, kind: ancestor.kind, level: ancestor.level });
        ancestor = ancestor.parentId ? sectionById.get(ancestor.parentId) : undefined;
      }
      additions.set(block.id, { sourceBlockId: block.id, content: block.content,
        source: { textbookId: item.source.textbookId, textbookTitle: item.source.textbookTitle,
          revisionId: block.revisionId, revisionVersion: item.source.revisionVersion,
          sectionId: section.id, sectionPath: sectionPath(section.path, section.title), sectionHierarchy: hierarchy,
          sectionPosition: section.position, sourceBlockId: block.id, sourceBlockPosition: block.position,
          quote: block.content } });
    }
    return { ...item, ...(additions.size ? { completeSourceBlocks: [...additions.values()] } : {}),
      sourceContext: { policyVersion: COURSE_SOURCE_CONTEXT_POLICY_VERSION,
        status: complete ? 'complete' as const : 'partial' as const,
        sectionId: item.source.sectionId, sourceBlockIds: contextBlocks.map((block) => block.id) } };
  });
}

/** Add direct parent prose to an authoring view without changing adopted IDs. */
async function hydrateAncestorIntroductions(
  items: readonly CourseEvidenceItem[],
  idsByItem: ReadonlyMap<string, readonly string[]>,
  blockById: ReadonlyMap<string, {
    id: string; revisionId: string; sectionId: string; position: number;
  }>,
): Promise<CourseEvidenceItem[]> {
  const adoptedBlocks = (item: CourseEvidenceItem) => (idsByItem.get(item.id) ?? [])
    .flatMap((id) => {
      const block = blockById.get(id);
      return block && block.revisionId === item.source.revisionId && block.sectionId
        && (!item.source.sectionId || block.sectionId === item.source.sectionId) ? [block] : [];
    });
  const revisionIds = [...new Set(items.flatMap(adoptedBlocks).map((block) => block.revisionId))];
  if (!revisionIds.length) return [...items];
  const sections = await prisma.textbookSection.findMany({
    where: { revisionId: { in: revisionIds } },
    select: { id: true, revisionId: true, parentId: true, title: true, path: true,
      kind: true, level: true, position: true },
  });
  const sectionsById = new Map(sections.map((section) => [section.id, section]));
  const scopeByItem = new Map(items.map((item) => {
    const scopes = adoptedBlocks(item).flatMap((block) => {
      const section = sectionsById.get(block.sectionId);
      const parent = section?.parentId ? sectionsById.get(section.parentId) : undefined;
      if (!section || !parent || section.revisionId !== item.source.revisionId
        || parent.revisionId !== section.revisionId || parent.position >= section.position) return [];
      const firstChildPosition = Math.min(...sections.filter((child) => child.parentId === parent.id
        && child.revisionId === parent.revisionId).map((child) => child.position));
      if (!Number.isFinite(firstChildPosition) || firstChildPosition <= parent.position) return [];
      return [{ revisionId: parent.revisionId, sectionId: parent.id,
        position: { gt: parent.position, lt: firstChildPosition } }];
    });
    return [item.id, [...new Map(scopes.map((scope) => [scope.sectionId, scope])).values()]] as const;
  }));
  const scopes = [...new Map([...scopeByItem.values()].flat().map((scope) => [scope.sectionId, scope])).values()];
  if (!scopes.length) return [...items];
  const introductions = await prisma.textbookSourceBlock.findMany({
    where: { OR: scopes, blockType: "PARAGRAPH" }, orderBy: { position: "asc" },
    select: { id: true, revisionId: true, sectionId: true, position: true, blockType: true, content: true },
  });
  return items.map((item) => {
    const representedText = [item.content, item.source.quote ?? "",
      ...(item.completeSourceBlocks ?? []).map((block) => block.content)].map(normalizeTextbookText);
    const representedIds = new Set((item.completeSourceBlocks ?? []).map((block) => block.sourceBlockId));
    const additions = introductions.flatMap((block) => {
      const scope = scopeByItem.get(item.id)?.find((candidate) => candidate.revisionId === block.revisionId
        && candidate.sectionId === block.sectionId && block.position > candidate.position.gt
        && block.position < candidate.position.lt);
      const content = normalizeTextbookText(block.content);
      if (!scope || block.blockType !== "PARAGRAPH" || !content || representedIds.has(block.id)
        || representedText.some((text) => text.includes(content))) return [];
      const section = sectionsById.get(scope.sectionId)!;
      const hierarchy: NonNullable<CourseEvidenceItem["source"]["sectionHierarchy"]> = [];
      const visited = new Set<string>();
      let ancestor: typeof section | undefined = section;
      while (ancestor && ancestor.revisionId === scope.revisionId && !visited.has(ancestor.id)) {
        visited.add(ancestor.id);
        hierarchy.unshift({ id: ancestor.id, title: ancestor.title, kind: ancestor.kind, level: ancestor.level });
        ancestor = ancestor.parentId ? sectionsById.get(ancestor.parentId) : undefined;
      }
      representedIds.add(block.id);
      representedText.push(content);
      return [{ sourceBlockId: block.id, content: block.content,
        source: { textbookId: item.source.textbookId, textbookTitle: item.source.textbookTitle,
          revisionId: scope.revisionId, revisionVersion: item.source.revisionVersion,
          sectionId: section.id, sectionPath: sectionPath(section.path, section.title),
          sectionHierarchy: hierarchy, sectionPosition: section.position,
          sourceBlockId: block.id, sourceBlockPosition: block.position, quote: block.content } }];
    });
    return additions.length ? { ...item,
      completeSourceBlocks: [...additions, ...(item.completeSourceBlocks ?? [])] } : item;
  });
}

/** Recover figure links from all blocks of the adopted retrieval chunks. */
export async function hydrateCourseEvidenceFigureReferences(
  items: readonly CourseEvidenceItem[],
  options: { includeAncestorIntroductions?: boolean; includeSectionContext?: boolean } = {},
): Promise<CourseEvidenceItem[]> {
  const missingChunkIds = items.filter((item) => !item.source?.sourceBlockIds?.length && item.source?.revisionId && item.id)
    .map((item) => item.id);
  const retrievals = missingChunkIds.length ? await prisma.textbookRetrievalItem.findMany({
    where: { id: { in: missingChunkIds } },
    select: { id: true, revisionId: true, sourceBlockId: true, metadata: true },
  }) : [];
  const retrievalById = new Map(retrievals.map((item) => [item.id, item]));
  const idsByItem = new Map(items.map((item) => {
    const retrieval = retrievalById.get(item.id);
    const ids = item.source?.sourceBlockIds?.length
      ? item.source.sourceBlockIds
      : retrieval && retrieval.revisionId === item.source?.revisionId
        ? retrievalBlockIds(retrieval.metadata, retrieval.sourceBlockId ?? item.source?.sourceBlockId)
        : item.source?.sourceBlockId ? [item.source.sourceBlockId] : [];
    return [item.id, ids] as const;
  }));
  const allIds = [...new Set([...idsByItem.values()].flat())];
  const blocks = allIds.length ? await prisma.textbookSourceBlock.findMany({
    where: { id: { in: allIds } },
    select: { id: true, revisionId: true, sectionId: true, position: true, content: true,
      figures: { select: { id: true } } },
  }) : [];
  const blockById = new Map(blocks.map((block) => [block.id, block]));
  const linked = items.map((item) => {
    const blockIds = idsByItem.get(item.id) ?? [];
    const refs = new Map((item.figureRefs ?? []).map((ref) => [ref.figureId, ref]));
    for (const id of blockIds) {
      const block = blockById.get(id);
      if (!block || block.revisionId !== item.source?.revisionId) continue;
      for (const figure of block.figures) {
        refs.set(figure.id, { figureId: figure.id, relation: "source-block-direct",
          direct: true, groupKey: `source-block:${id}` });
      }
    }
    const figureRefs = [...refs.values()];
    const sectionIds = [...new Set(blockIds.map((id) => blockById.get(id))
      .filter((block) => block?.revisionId === item.source?.revisionId)
      .map((block) => block?.sectionId).filter((id): id is string => typeof id === "string"))];
    const omittedSourceBlocks = item.kind === "source-block"
      ? blockIds.map((id) => blockById.get(id))
        .filter((block): block is NonNullable<typeof block> => block !== undefined
          && block.revisionId === item.source?.revisionId
          && typeof block.content === "string" && typeof block.position === "number")
        .sort((left, right) => left.position - right.position)
        .filter((block) => !normalizeTextbookText(item.content)
          .includes(normalizeTextbookText(block.content)))
        .map((block) => ({ sourceBlockId: block.id, content: block.content }))
      : [];
    const completeSourceBlocks = options.includeAncestorIntroductions || options.includeSectionContext
      ? [...new Map((item.completeSourceBlocks ?? []).map((block) => [block.sourceBlockId, block])).values(),
        ...omittedSourceBlocks.filter((block) => !item.completeSourceBlocks
          ?.some((existing) => existing.sourceBlockId === block.sourceBlockId))]
      : omittedSourceBlocks;
    return {
      ...item,
      source: { ...item.source, ...(blockIds.length ? { sourceBlockIds: blockIds } : {}),
        ...(!item.source?.sectionId && sectionIds.length === 1 ? { sectionId: sectionIds[0] } : {}) } as CourseEvidenceItem['source'],
      figureRefs,
      figureIds: figureRefs.map((ref) => ref.figureId),
      ...(completeSourceBlocks.length ? { completeSourceBlocks } : {}),
    };
  });
  const missingSequenceIds = [...new Set(linked.flatMap((item) => (item.figureRefs ?? [])
    .filter((reference) => reference.direct && !item.figureSequencesResolved
      && !item.figureSequences?.some((sequence) => sequence.figureId === reference.figureId))
    .map((reference) => reference.figureId)))];
  const figures = missingSequenceIds.length ? await prisma.textbookFigure.findMany({
    where: { id: { in: missingSequenceIds } },
    select: { id: true, revisionId: true, sectionId: true, caption: true,
      sourceBlock: { select: { position: true } } },
  }) : [];
  const sequences = new Map(await Promise.all(figures.flatMap((figure) => {
    const sectionId = figure.sectionId;
    const anchorPosition = figure.sourceBlock?.position;
    if (!sectionId || anchorPosition === undefined
      || !/流程|步骤|阶段|环节|过程/u.test(figure.caption ?? "")) return [];
    return [(async () => {
      const following = await prisma.textbookSourceBlock.findMany({
        where: { revisionId: figure.revisionId, sectionId,
          position: { gt: anchorPosition } },
        orderBy: { position: "asc" }, take: 60,
        select: { id: true, position: true, blockType: true, content: true },
      });
      return [figure.id, extractFigureSequence(following)] as const;
    })()];
  })));
  const withFigureSequences = linked.map((item) => {
    const additions = (item.figureRefs ?? []).filter((reference) => reference.direct)
      .flatMap((reference) => {
        const steps = sequences.get(reference.figureId);
        return steps?.length ? [{ figureId: reference.figureId,
          kind: "ordered-steps" as const, steps }] : [];
      });
    return { ...item, figureSequences: [...(item.figureSequences ?? []), ...additions],
      figureSequencesResolved: true };
  });
  // Search excerpts are intentionally small. Resolve complete numbered units
  // from the adopted immutable section, including old indexes whose metadata
  // ends mid-list. This is independent of whether a figure is present.
  const needsSourceSequences = (item: CourseEvidenceItem) => !item.sourceSequencesResolved
    || item.sourceSequencePolicyVersion !== SOURCE_SEQUENCE_POLICY_VERSION;
  const scopes = [...new Map(withFigureSequences.filter((item) => needsSourceSequences(item) && item.source?.sectionId
    && (idsByItem.get(item.id)?.length ?? 0) > 0).map((item) => [
    `${item.source.revisionId}:${item.source.sectionId}`,
    { revisionId: item.source.revisionId, sectionId: item.source.sectionId! },
  ])).values()];
  const sectionBlocks = scopes.length ? await prisma.textbookSourceBlock.findMany({
    where: { OR: scopes }, orderBy: { position: "asc" },
    select: { id: true, revisionId: true, sectionId: true, position: true, blockType: true, content: true },
  }) : [];
  const sequencesByScope = new Map(scopes.flatMap((scope) => {
    const key = `${scope.revisionId}:${scope.sectionId}`;
    const blocks = sectionBlocks.filter((block) =>
      block.revisionId === scope.revisionId && block.sectionId === scope.sectionId);
    // Missing source data is not proof that a frozen source list disappeared.
    // Keep its previous evidence and leave it eligible for a later hydration.
    return blocks.length ? [[key, extractOrderedSourceSequences(blocks)] as const] : [];
  }));
  const hydrated = withFigureSequences.map((item) => {
    const key = `${item.source.revisionId}:${item.source.sectionId ?? ""}`;
    if (!needsSourceSequences(item) || !sequencesByScope.has(key)) return item;
    const adoptedIds = new Set(idsByItem.get(item.id) ?? []);
    const linkedSequences = (sequencesByScope.get(key) ?? []).filter((sequence) =>
      sequence.steps.some((step) => adoptedIds.has(step.sourceBlockId)
        || (step.excerptBlockId ? adoptedIds.has(step.excerptBlockId) : false)));
    const sourceSequences = linkedSequences.filter((sequence) =>
      !(item.figureSequences ?? []).some((figure) => figure.steps.map((step) => step.sourceBlockId).join("|")
        === sequence.steps.map((step) => step.sourceBlockId).join("|")))
      .map((sequence) => ({ ...sequence, kind: "ordered-steps" as const }));
    // These lists are derived from immutable source blocks. Replace stale
    // derivations rather than retaining an old list merely because its anchor
    // still exists; an older parser may have merged two numbering levels.
    return { ...item, sourceSequences, sourceSequencesResolved: true,
      sourceSequencePolicyVersion: SOURCE_SEQUENCE_POLICY_VERSION };
  });
  const withIntroductions = options.includeAncestorIntroductions
    ? await hydrateAncestorIntroductions(hydrated, idsByItem, blockById) : hydrated;
  return options.includeSectionContext
    ? hydrateSectionAuthoringContext(withIntroductions, idsByItem, blockById) : withIntroductions;
}

function supportStatus(point: ResourcePackageTeachingPoint, item: CourseEvidenceItem | undefined): CourseEvidenceMapping["status"] {
  if (!item) return "none";
  const query = point.name.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN");
  const names = [item.title, ...(item.aliases ?? [])]
    .map((name) => name.normalize("NFC").replace(/\s+/gu, "").toLocaleLowerCase("zh-CN"));
  return names.some((name) => name === query || (query.length >= 4 && (name.includes(query) || query.includes(name))))
    ? "direct"
    : "partial";
}

/**
 * Resolve and freeze the textbook evidence that every downstream generation
 * stage will share. Retrieval scores only choose candidates; they are never
 * represented as proof that the textbook supports an upstream requirement.
 */
export async function resolveCourseEvidenceSnapshot(input: {
  courseId: string;
  selections: CourseTextbookSelection[];
  upstreamKnowledgePoints: ResourcePackageTeachingPoint[];
  teacherBrief?: string;
}): Promise<CourseEvidenceSnapshot> {
  if (!input.selections.length) throw new CourseEvidenceError("TEXTBOOK_SELECTION_REQUIRED", "请至少选择一本教材。", 400);
  if (input.selections.filter((selection) => selection.primary).length !== 1) {
    throw new CourseEvidenceError("TEXTBOOK_PRIMARY_REQUIRED", "请选择且只选择一本主教材。", 400);
  }
  const revisionIds = input.selections.map((selection) => selection.revisionId);
  const revisions = await prisma.textbookRevision.findMany({
    where: { id: { in: revisionIds } },
    include: { textbook: true, sections: { select: { id: true, parentId: true, title: true, path: true, kind: true, level: true, position: true } } },
  });
  if (revisions.length !== revisionIds.length) {
    throw new CourseEvidenceError("TEXTBOOK_REVISION_NOT_FOUND", "部分教材版本不存在，请重新选择。", 404);
  }
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
  const sectionByRevision = new Map(revisions.map((revision) => [
    revision.id,
    new Map(revision.sections.map((section) => [section.id, section])),
  ] as const));
  const sectionHierarchy = (revisionId: string, sectionId: string | null) => {
    const byId = sectionByRevision.get(revisionId);
    const result: NonNullable<CourseEvidenceItem["source"]["sectionHierarchy"]> = [];
    const visited = new Set<string>();
    let current = sectionId ? byId?.get(sectionId) : undefined;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      result.unshift({ id: current.id, title: current.title, kind: current.kind, level: current.level });
      current = current.parentId ? byId?.get(current.parentId) : undefined;
    }
    return result;
  };
  for (const selection of input.selections) {
    const revision = revisionById.get(selection.revisionId)!;
    if (revision.textbook.status === "ARCHIVED") {
      throw new CourseEvidenceError("TEXTBOOK_ARCHIVED", `《${revision.textbook.title}》已归档，不能用于新的课程。`, 409);
    }
    if (!['READY', 'WAITING_EMBEDDING'].includes(revision.status)) {
      throw new CourseEvidenceError("TEXTBOOK_NOT_READY", `《${revision.textbook.title}》尚未完成正文解析。`, 409);
    }
    const validSectionIds = new Set(revision.sections.map((section) => section.id));
    if (selection.sectionIds.some((id) => !validSectionIds.has(id))) {
      throw new CourseEvidenceError("TEXTBOOK_SECTION_INVALID", `《${revision.textbook.title}》的章节范围已经变化，请重新选择。`, 409);
    }
  }

  const points = input.upstreamKnowledgePoints.length
    ? input.upstreamKnowledgePoints.slice(0, 120)
    : [{ id: "teacher-brief", name: input.teacherBrief?.trim().slice(0, 200) || "课程核心知识", description: input.teacherBrief?.trim().slice(0, 1_000) || "教师课程要求" }];
  const pointById = new Map(points.map((point) => [point.id, point]));
  const retrievals = await Promise.all(points.map(async (point) => {
    const parent = point.parentKnowledgePointId ? pointById.get(point.parentKnowledgePointId) : undefined;
    const query = [point.name, point.description, point.groupName, parent?.name, parent?.description, input.teacherBrief]
      .filter(Boolean).join("\n").slice(0, 2_000);
    const scoped = await Promise.all(input.selections.map(async (selection) => ({
      selection,
      result: await searchTextbookEvidence({
        revisionIds: [selection.revisionId],
        sectionIds: selection.sectionIds.length ? selection.sectionIds : undefined,
        query,
        limit: 8,
      }),
    })));
    const hits = scoped.flatMap(({ selection, result }) => result.hits.map((hit) => ({
      ...hit,
      score: hit.score + (selection.primary ? 0.000_001 : 0),
    }))).sort((left, right) => right.score - left.score).slice(0, 8);
    const degradedReasons = scoped.flatMap(({ result }) => result.degraded && result.degradationReason ? [result.degradationReason] : []);
    return {
      point,
      result: {
        query,
        degraded: scoped.some(({ result }) => result.degraded),
        degradationReason: degradedReasons[0] ?? null,
        hits,
      },
    };
  }));
  const selectedHitIds = [...new Set(retrievals.flatMap(({ result }) => result.hits.slice(0, 5).map((hit) => hit.retrievalItemId)))];
  const records = selectedHitIds.length ? await prisma.textbookRetrievalItem.findMany({
    where: { id: { in: selectedHitIds } },
    include: {
      revision: { include: { textbook: true } },
      section: { include: { figures: { select: { id: true } } } },
      sourceBlock: { include: { figures: { select: { id: true } } } },
      concept: { include: { evidence: { include: { sourceBlock: { include: { figures: { select: { id: true } } } } }, orderBy: { sourceBlock: { position: "asc" } } }, figures: true } },
      example: { include: { concepts: { include: { concept: { include: { figures: true } } } } } },
    },
  }) : [];
  const recordById = new Map(records.map((record) => [record.id, record]));
  const scoreById = new Map(retrievals.flatMap(({ result }) => result.hits.map((hit) => [hit.retrievalItemId, hit.score] as const)));
  const items: CourseEvidenceItem[] = selectedHitIds.flatMap((id) => {
    const record = recordById.get(id);
    if (!record) return [];
    const evidenceBlock = record.concept?.evidence[0]?.sourceBlock ?? record.sourceBlock;
    const figureRefsById = new Map<string, CourseEvidenceFigureReference>();
    const addFigure = (reference: CourseEvidenceFigureReference) => {
      const existing = figureRefsById.get(reference.figureId);
      if (!existing || (!existing.direct && reference.direct)) {
        figureRefsById.set(reference.figureId, reference);
      }
    };
    record.concept?.figures.forEach((link) => addFigure({
      figureId: link.figureId,
      relation: "concept-direct",
      direct: true,
    }));
    record.sourceBlock?.figures.forEach((figure) => addFigure({
      figureId: figure.id,
      relation: "source-block-direct",
      direct: true,
      groupKey: `source-block:${record.sourceBlock!.id}`,
    }));
    record.concept?.evidence.forEach((evidence) => evidence.sourceBlock.figures.forEach((figure) => addFigure({
      figureId: figure.id,
      relation: "concept-evidence-direct",
      direct: true,
      groupKey: `source-block:${evidence.sourceBlock.id}`,
    })));
    record.example?.concepts.forEach((link) => link.concept.figures.forEach((figure) => addFigure({
      figureId: figure.figureId,
      relation: "example-concept",
      direct: false,
    })));
    record.section?.figures.forEach((figure) => addFigure({
      figureId: figure.id,
      relation: "section-candidate",
      direct: false,
    }));
    const figureRefs = [...figureRefsById.values()];
    return [{
      id: record.id,
      kind: record.kind === "CONCEPT" ? "concept" : record.kind === "EXAMPLE" ? "example" : "source-block",
      title: record.title?.trim() || record.section?.title || "教材原文",
      content: record.content,
      aliases: record.concept?.aliases ?? undefined,
      source: {
        textbookId: record.revision.textbookId,
        textbookTitle: record.revision.textbook.title,
        revisionId: record.revisionId,
        revisionVersion: record.revision.revision,
        sectionId: record.sectionId ?? undefined,
        sectionPath: record.section ? sectionPath(record.section.path, record.section.title) : [],
        sectionHierarchy: sectionHierarchy(record.revisionId, record.sectionId),
        sectionPosition: record.section?.position,
        sourceBlockId: evidenceBlock?.id,
        sourceBlockPosition: evidenceBlock?.position,
        quoteStart: record.concept?.evidence[0]?.quoteStart,
        quote: evidenceBlock?.content,
      },
      figureRefs,
      figureIds: figureRefs.map((reference) => reference.figureId),
      retrievalScore: scoreById.get(record.id),
    } satisfies CourseEvidenceItem];
  });
  const completeItems = await hydrateCourseEvidenceFigureReferences(items);
  const itemById = new Map(completeItems.map((item) => [item.id, item]));
  const mappings: CourseEvidenceMapping[] = retrievals.map(({ point, result }) => {
    const evidenceItemIds = result.hits.slice(0, 5).map((hit) => hit.retrievalItemId).filter((id) => itemById.has(id));
    const strongest = itemById.get(evidenceItemIds[0] ?? "");
    const status = supportStatus(point, strongest);
    return {
      sourceKnowledgePointId: point.id,
      sourceKnowledgePointName: point.name,
      status,
      evidenceItemIds,
      rationale: status === "direct"
        ? "教材概念名称与上游知识要求明确对应，仍需在知识规划阶段核对解释边界。"
        : status === "partial"
          ? "已召回相关教材内容，但不能仅凭相似度视为完整覆盖，需在知识规划阶段判定。"
          : "限定教材和章节内没有召回可用证据。",
      ...(status === "none" ? { uncoveredRequirement: point.description || point.name } : {}),
    };
  });
  const degradedReasons = [...new Set(retrievals.flatMap(({ result }) => result.degraded && result.degradationReason ? [result.degradationReason] : []))];
  const payload = {
    schemaVersion: COURSE_EVIDENCE_SCHEMA_VERSION,
    selections: input.selections,
    items: completeItems,
    mappings,
    retrievalMode: degradedReasons.length ? "lexical-degraded" as const : "hybrid" as const,
    warnings: degradedReasons.length
      ? ["语义检索暂不可用，本次只完成关键词与教材图谱召回。", ...degradedReasons]
      : [],
  };
  const fingerprint = stableFingerprint(payload);

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${input.courseId}))`);
    const template = await tx.classroomTemplate.findUnique({ where: { id: input.courseId }, select: { id: true } });
    if (!template) throw new CourseEvidenceError("COURSE_NOT_FOUND", "课程不存在。", 404);
    await tx.courseTextbookBinding.updateMany({ where: { templateId: input.courseId }, data: { isPrimary: false } });
    for (const selection of input.selections) {
      const binding = await tx.courseTextbookBinding.upsert({
        where: { templateId_revisionId: { templateId: input.courseId, revisionId: selection.revisionId } },
        create: { templateId: input.courseId, revisionId: selection.revisionId, isPrimary: selection.primary },
        update: { isPrimary: selection.primary },
      });
      await tx.courseTextbookSection.deleteMany({ where: { bindingId: binding.id } });
      if (selection.sectionIds.length) await tx.courseTextbookSection.createMany({
        data: selection.sectionIds.map((sectionId) => ({ bindingId: binding.id, sectionId })),
        skipDuplicates: true,
      });
    }
    const existing = await tx.courseEvidenceSnapshot.findUnique({
      where: { templateId_fingerprint: { templateId: input.courseId, fingerprint } },
    });
    if (existing) {
      const snapshot = existing.payload as unknown as CourseEvidenceSnapshot;
      await tx.courseEvidenceSnapshot.updateMany({ where: { templateId: input.courseId }, data: { isCurrent: false } });
      await tx.courseEvidenceSnapshot.update({ where: { id: existing.id }, data: { isCurrent: true } });
      return snapshot;
    }
    const last = await tx.courseEvidenceSnapshot.findFirst({ where: { templateId: input.courseId }, orderBy: { version: "desc" }, select: { version: true } });
    const snapshot: CourseEvidenceSnapshot = {
      ...payload,
      version: (last?.version ?? 0) + 1,
      fingerprint,
      createdAt: new Date().toISOString(),
    };
    await tx.courseEvidenceSnapshot.updateMany({ where: { templateId: input.courseId }, data: { isCurrent: false } });
    const created = await tx.courseEvidenceSnapshot.create({
      data: {
        templateId: input.courseId,
        version: snapshot.version,
        status: "READY",
        isCurrent: true,
        fingerprint,
        payload: snapshot as unknown as Prisma.InputJsonValue,
      },
    });
    const bindings = await tx.courseTextbookBinding.findMany({ where: { templateId: input.courseId, revisionId: { in: revisionIds } }, select: { id: true } });
    if (bindings.length) await tx.courseEvidenceSnapshotBinding.createMany({ data: bindings.map((binding) => ({ snapshotId: created.id, bindingId: binding.id })) });
    return snapshot;
  });
}

export async function resolveCourseTextbookFigures(
  snapshot?: CourseEvidenceSnapshot,
  lessonKnowledgePoints?: readonly Pick<KnowledgePoint, "id" | "sourceId" | "sourceKnowledgePointIds" | "evidenceItemIds">[],
): Promise<CourseTextbookFigureResource[]> {
  const items = await hydrateCourseEvidenceFigureReferences(snapshot?.items ?? []);
  const referencesByFigure = new Map<string, Array<{
    item: CourseEvidenceItem;
    reference: CourseEvidenceFigureReference;
  }>>();
  for (const item of items) {
    const references = item.figureRefs ?? (item.figureIds ?? []).map((figureId) => ({
      figureId,
      relation: "section-candidate" as const,
      direct: false,
    }));
    for (const reference of references) {
      const values = referencesByFigure.get(reference.figureId) ?? [];
      values.push({ item, reference });
      referencesByFigure.set(reference.figureId, values);
    }
  }
  const figureIds = [...referencesByFigure.keys()];
  if (!figureIds.length) return [];

  const supportingMappings = (snapshot?.mappings ?? []).filter((mapping) => mapping.status !== "none");
  const adoptedEvidenceByPoint = new Map((lessonKnowledgePoints ?? []).map((point) => [point.id,
    new Set(point.evidenceItemIds !== undefined ? point.evidenceItemIds : supportingMappings
      .filter((mapping) => [point.id, point.sourceId, ...(point.sourceKnowledgePointIds ?? [])]
        .includes(mapping.sourceKnowledgePointId)).flatMap((mapping) => mapping.evidenceItemIds)),
  ] as const));
  // A lesson point's explicit selection is authoritative, including [].
  // Upstream mappings are retrieval candidates and only recover older points
  // that did not persist an evidence selection.
  const adoptedEvidenceIds = new Set(lessonKnowledgePoints
    ? [...adoptedEvidenceByPoint.values()].flatMap((ids) => [...ids])
    : supportingMappings.flatMap((mapping) => mapping.evidenceItemIds));
  const requiredFigureIds = new Set(items.filter((item) => adoptedEvidenceIds.has(item.id))
    .flatMap((item) => (item.figureRefs ?? []).filter((reference) => reference.direct)
      .map((reference) => reference.figureId)));
  const figures = await prisma.textbookFigure.findMany({
    where: { id: { in: figureIds } },
    include: { fileAsset: true, revision: { include: { textbook: true } }, section: true },
  });
  const byId = new Map(figures.map((figure) => [figure.id, figure]));
  return figureIds.map((figureId, index): CourseTextbookFigureResource => {
    const figure = byId.get(figureId);
    const references = referencesByFigure.get(figureId) ?? [];
    const direct = references.some(({ reference }) => reference.direct);
    const adopted = references.some(({ item, reference }) => reference.direct && adoptedEvidenceIds.has(item.id));
    const evidenceItemIds = [...new Set(references.map(({ item }) => item.id))];
    const sourceKnowledgePointIds = [...new Set((snapshot?.mappings ?? []).flatMap((mapping) => (
      mapping.evidenceItemIds.some((evidenceId) => evidenceItemIds.includes(evidenceId))
        ? [mapping.sourceKnowledgePointId]
        : []
    )))];
    const knowledgePointIds = lessonKnowledgePoints
      ? lessonKnowledgePoints.filter((point) => evidenceItemIds
        .some((id) => adoptedEvidenceByPoint.get(point.id)?.has(id))).map((point) => point.id)
      : sourceKnowledgePointIds;
    const sourceTitle = figure?.revision.textbook.title
      ?? references[0]?.item.source.textbookTitle
      ?? "教材";
    const relation = direct ? "direct" as const : "candidate" as const;
    const required = requiredFigureIds.has(figureId) && adopted && knowledgePointIds.length > 0;
    const groupKey = references.find(({ reference }) => reference.direct && reference.groupKey)?.reference.groupKey;
    const orderedSteps = references.flatMap(({ item }) => item.figureSequences ?? [])
      .find((sequence) => sequence.figureId === figureId)?.steps;
    const base = {
      id: `textbook_fig_${createHash("sha256").update(figureId).digest("hex").slice(0, 12)}`,
      figureId,
      pageNumber: (figure?.position ?? index) + 1,
      relation,
      required,
      ...(groupKey ? { groupKey } : {}),
      ...(orderedSteps?.length ? { orderedSteps } : {}),
      evidenceItemIds,
      knowledgePointIds,
      sourceTitle,
    };
    if (!figure) {
      return {
        ...base,
        status: "unavailable" as const,
        failureReason: "教材图片记录不存在",
      };
    }
    const unavailableReason = figure.status !== "AVAILABLE"
      ? `教材图片状态为 ${figure.status}`
      : figure.fileAsset.deletedAt
        ? "教材图片文件已删除"
        : !figure.fileAsset.mimeType.startsWith("image/")
          ? `教材图片文件类型无效：${figure.fileAsset.mimeType}`
          : undefined;
    if (unavailableReason) {
      return {
        ...base,
        status: "unavailable" as const,
        failureReason: unavailableReason,
      };
    }
    return {
      ...base,
      status: "available" as const,
      assetId: figure.fileAssetId,
      src: `/api/uploads/${figure.fileAssetId}`,
      description: [
        required ? "知识点首次完整讲解必须使用的教材原图" : direct ? "知识点直接关联教材原图" : "同章节候选教材图",
        figure.caption,
        figure.section?.title,
        `来源：《${sourceTitle}》`,
      ].filter(Boolean).join("；"),
      ...(figure.width ? { width: figure.width } : {}),
      ...(figure.height ? { height: figure.height } : {}),
    };
  });
}
