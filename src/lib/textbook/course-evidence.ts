import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import type { ResourcePackageTeachingPoint } from "@/lib/course-design/resource-package-knowledge";
import type { KnowledgePoint } from "@/lib/session/types";
import { searchTextbookEvidence } from "@/lib/textbook/service";
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
    include: { textbook: true, sections: { select: { id: true, title: true, path: true, kind: true, position: true } } },
  });
  if (revisions.length !== revisionIds.length) {
    throw new CourseEvidenceError("TEXTBOOK_REVISION_NOT_FOUND", "部分教材版本不存在，请重新选择。", 404);
  }
  const revisionById = new Map(revisions.map((revision) => [revision.id, revision]));
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
      concept: { include: { evidence: { include: { sourceBlock: { include: { figures: { select: { id: true } } } } }, orderBy: { sourceBlock: { position: "asc" } }, take: 1 }, figures: true } },
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
  const itemById = new Map(items.map((item) => [item.id, item]));
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
    items,
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
  const items = snapshot?.items ?? [];
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

  const requiredFigureIds = new Set<string>();
  for (const mapping of snapshot?.mappings ?? []) {
    if (mapping.status !== "direct") continue;
    const firstDirectItem = mapping.evidenceItemIds
      .map((evidenceId) => items.find((item) => item.id === evidenceId))
      .find((item) => item?.figureRefs?.some((reference) => reference.direct));
    const direct = firstDirectItem?.figureRefs?.filter((reference) => reference.direct) ?? [];
    if (!direct.length) continue;
    const groupKey = direct[0]?.groupKey;
    for (const reference of groupKey
      ? direct.filter((candidate) => candidate.groupKey === groupKey)
      : direct.slice(0, 1)) {
      requiredFigureIds.add(reference.figureId);
    }
  }
  const figures = await prisma.textbookFigure.findMany({
    where: { id: { in: figureIds } },
    include: { fileAsset: true, revision: { include: { textbook: true } }, section: true },
  });
  const byId = new Map(figures.map((figure) => [figure.id, figure]));
  return figureIds.map((figureId, index): CourseTextbookFigureResource => {
    const figure = byId.get(figureId);
    const references = referencesByFigure.get(figureId) ?? [];
    const direct = references.some(({ reference }) => reference.direct);
    const required = requiredFigureIds.has(figureId);
    const evidenceItemIds = [...new Set(references.map(({ item }) => item.id))];
    const sourceKnowledgePointIds = [...new Set((snapshot?.mappings ?? []).flatMap((mapping) => (
      mapping.evidenceItemIds.some((evidenceId) => evidenceItemIds.includes(evidenceId))
        ? [mapping.sourceKnowledgePointId]
        : []
    )))];
    const sourceIds = new Set(sourceKnowledgePointIds);
    const sourceTargets = lessonKnowledgePoints?.filter((point) => (
      [point.id, point.sourceId, ...(point.sourceKnowledgePointIds ?? [])]
        .some((id) => id && sourceIds.has(id))
    )) ?? [];
    const evidenceTargets = lessonKnowledgePoints?.filter((point) => (
      point.evidenceItemIds?.some((id) => evidenceItemIds.includes(id))
    )) ?? [];
    const evidenceTargetIds = new Set(evidenceTargets.map((point) => point.id));
    const preciseTargets = sourceTargets.filter((point) => evidenceTargetIds.has(point.id));
    const knowledgePointIds = lessonKnowledgePoints
      ? (preciseTargets.length ? preciseTargets : sourceTargets.length ? sourceTargets : evidenceTargets)
          .map((point) => point.id)
      : sourceKnowledgePointIds;
    const sourceTitle = figure?.revision.textbook.title
      ?? references[0]?.item.source.textbookTitle
      ?? "教材";
    const relation = direct ? "direct" as const : "candidate" as const;
    const groupKey = references.find(({ reference }) => reference.direct && reference.groupKey)?.reference.groupKey;
    const base = {
      id: `textbook_fig_${createHash("sha256").update(figureId).digest("hex").slice(0, 12)}`,
      figureId,
      pageNumber: (figure?.position ?? index) + 1,
      relation,
      required,
      ...(groupKey ? { groupKey } : {}),
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
