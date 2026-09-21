import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { TextbookError } from "./errors";
import { embedTextbookTexts, TextbookEmbeddingUnavailableError, vectorSqlLiteral } from "./embedding";
import { parseTextbookDocx, TEXTBOOK_DOCX_LIMITS } from "./docx-parser";
import { chineseSearchTokens } from "./text";
import type { TextbookEvidenceSearchHit, TextbookEvidenceSearchResult, TextbookJobSnapshot } from "./types";

export const TEXTBOOK_PARSE_VERSION = "docx-ooxml-v1";
export const TEXTBOOK_EXTRACTION_VERSION = "deterministic-headings-v1";
export const textbookDataDir = () => process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");

type UploadedTextbookInput = {
  bytes: Buffer;
  originalName: string;
  mimeType?: string;
  title?: string;
  author?: string;
  maintainerId: string;
};

const detailInclude = {
  currentRevision: true,
  revisions: { orderBy: { revision: "desc" as const } },
} satisfies Prisma.TextbookInclude;

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

function jobSnapshot(job: {
  id: string; status: string; step: string | null; progress: number; error: string | null; attempt: number; createdAt: Date; updatedAt: Date;
} | null): TextbookJobSnapshot | null {
  return job ? {
    id: job.id,
    status: job.status.toLowerCase(),
    step: job.step,
    progress: job.progress,
    error: job.error,
    attempt: job.attempt,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  } : null;
}

async function latestJob(revisionId: string) {
  return prisma.generationJob.findFirst({
    where: { targetType: "TEXTBOOK_REVISION", targetId: revisionId, jobType: "TEXTBOOK_INGEST" },
    orderBy: { createdAt: "desc" },
  });
}

function revisionSummary(revision: { id: string; revision: number; status: string; error: string | null; readyAt: Date | null; createdAt: Date; updatedAt: Date }) {
  return {
    id: revision.id,
    version: revision.revision,
    status: revision.status,
    error: revision.error,
    readyAt: revision.readyAt?.toISOString() ?? null,
    createdAt: revision.createdAt.toISOString(),
    updatedAt: revision.updatedAt.toISOString(),
  };
}

function textbookSummary(textbook: Prisma.TextbookGetPayload<{ include: typeof detailInclude }>) {
  const current = textbook.currentRevision ?? textbook.revisions[0] ?? null;
  return {
    id: textbook.id,
    title: textbook.title,
    author: textbook.author,
    description: textbook.description,
    maintainerId: textbook.maintainerId,
    ownerId: textbook.maintainerId,
    status: textbook.status,
    archivedAt: textbook.archivedAt?.toISOString() ?? null,
    currentRevision: current ? revisionSummary(current) : null,
    createdAt: textbook.createdAt.toISOString(),
    updatedAt: textbook.updatedAt.toISOString(),
  };
}

export async function listTextbooks(input: { query?: string; includeArchived?: boolean; revisionStatus?: string } = {}) {
  const query = input.query?.normalize("NFC").trim().slice(0, 200);
  const textbooks = await prisma.textbook.findMany({
    where: {
      ...(input.includeArchived ? {} : { status: { not: "ARCHIVED" } }),
      ...(input.revisionStatus ? { currentRevision: { is: { status: input.revisionStatus } } } : {}),
      ...(query ? { OR: [{ title: { contains: query, mode: "insensitive" } }, { author: { contains: query, mode: "insensitive" } }] } : {}),
    },
    include: detailInclude,
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return { textbooks: textbooks.map(textbookSummary), total: textbooks.length };
}

export async function createTextbookFromUpload(input: UploadedTextbookInput) {
  if (!input.bytes.length || input.bytes.length > TEXTBOOK_DOCX_LIMITS.compressedBytes) {
    throw new TextbookError("TEXTBOOK_FILE_SIZE_INVALID", "教材 Word 必须大于 0 且不能超过 80 MiB。", 413);
  }
  if (!/\.docx$/i.test(input.originalName)) throw new TextbookError("TEXTBOOK_FORMAT_UNSUPPORTED", "首期教材库仅支持 .docx 文件。", 415);
  const sha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = await prisma.textbookRevision.findUnique({ where: { sha256 }, include: { textbook: { include: detailInclude } } });
  if (existing) return {
    textbook: textbookSummary(existing.textbook),
    revision: revisionSummary(existing),
    job: jobSnapshot(await latestJob(existing.id)),
    deduplicated: true,
  };
  const parsed = parseTextbookDocx(input.bytes);

  const assetId = randomUUID();
  const textbookId = randomUUID();
  const revisionId = randomUUID();
  const storageKey = `${assetId}.docx`;
  const targetPath = path.join(textbookDataDir(), storageKey);
  await mkdir(/* turbopackIgnore: true */ textbookDataDir(), { recursive: true });
  await writeFile(/* turbopackIgnore: true */ targetPath, input.bytes, { flag: "wx", mode: 0o600 });
  await chmod(/* turbopackIgnore: true */ targetPath, 0o644);
  try {
    const created = await prisma.$transaction(async (tx) => {
      await tx.fileAsset.create({ data: {
        id: assetId,
        storageKey,
        originalName: input.originalName.normalize("NFC").slice(0, 500),
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: BigInt(input.bytes.length),
        sha256,
        assetRole: "SOURCE",
        backupPolicy: "REQUIRED",
        uploadedById: input.maintainerId,
        regenerationRecipe: json({ schemaVersion: 1, operation: "textbook-source-upload" }),
      } });
      const textbook = await tx.textbook.create({ data: {
        id: textbookId,
        title: input.title?.trim().slice(0, 300) || parsed.title,
        author: input.author?.trim().slice(0, 300) || parsed.author || null,
        maintainerId: input.maintainerId,
      } });
      const revision = await tx.textbookRevision.create({ data: {
        id: revisionId,
        textbookId,
        revision: 1,
        fileAssetId: assetId,
        sha256,
        status: "PENDING",
        parseVersion: TEXTBOOK_PARSE_VERSION,
        extractionVersion: TEXTBOOK_EXTRACTION_VERSION,
        metadata: json({ titleProvided: Boolean(input.title?.trim()), authorProvided: Boolean(input.author?.trim()), warnings: parsed.warnings }),
      } });
      const job = await tx.generationJob.create({ data: {
        targetType: "TEXTBOOK_REVISION",
        targetId: revisionId,
        jobType: "TEXTBOOK_INGEST",
        status: "QUEUED",
        step: "validation",
        progress: 0,
        request: json({ requestedBy: input.maintainerId, textbookId, revisionId }),
      } });
      return { textbook, revision, job };
    });
    return {
      textbook: { ...created.textbook, ownerId: created.textbook.maintainerId, currentRevision: null, createdAt: created.textbook.createdAt.toISOString(), updatedAt: created.textbook.updatedAt.toISOString(), archivedAt: null },
      revision: revisionSummary(created.revision),
      job: jobSnapshot(created.job),
      deduplicated: false,
    };
  } catch (error) {
    await unlink(/* turbopackIgnore: true */ targetPath).catch(() => undefined);
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const duplicate = await prisma.textbookRevision.findUnique({ where: { sha256 }, include: { textbook: { include: detailInclude } } });
      if (duplicate) return {
        textbook: textbookSummary(duplicate.textbook), revision: revisionSummary(duplicate), job: jobSnapshot(await latestJob(duplicate.id)), deduplicated: true,
      };
    }
    throw error;
  }
}

export async function getTextbookDetails(id: string) {
  const textbook = await prisma.textbook.findUnique({ where: { id }, include: detailInclude });
  if (!textbook) throw new TextbookError("TEXTBOOK_NOT_FOUND", "教材不存在。", 404);
  const revision = textbook.currentRevision ?? textbook.revisions[0] ?? null;
  if (!revision) return { textbook: { ...textbookSummary(textbook), revisions: [] }, revision: null, sections: [], sourceBlocks: [], concepts: [], relations: [], examples: [], figures: [], job: null };
  const [sections, sourceBlocks, concepts, relations, examples, figures, job] = await Promise.all([
    prisma.textbookSection.findMany({ where: { revisionId: revision.id }, orderBy: { position: "asc" } }),
    prisma.textbookSourceBlock.findMany({ where: { revisionId: revision.id }, orderBy: { position: "asc" } }),
    prisma.textbookConcept.findMany({ where: { revisionId: revision.id, status: "ACTIVE" }, include: { evidence: { include: { sourceBlock: true } }, examples: true, figures: true }, orderBy: { createdAt: "asc" } }),
    prisma.textbookConceptRelation.findMany({ where: { revisionId: revision.id }, orderBy: { createdAt: "asc" } }),
    prisma.textbookExample.findMany({ where: { revisionId: revision.id }, include: { concepts: true }, orderBy: { createdAt: "asc" } }),
    prisma.textbookFigure.findMany({ where: { revisionId: revision.id }, include: { concepts: true }, orderBy: { position: "asc" } }),
    latestJob(revision.id),
  ]);
  return {
    textbook: { ...textbookSummary(textbook), revisions: textbook.revisions.map(revisionSummary) },
    revision: revisionSummary(revision),
    sections: sections.map((section) => ({ ...section, createdAt: section.createdAt.toISOString() })),
    sourceBlocks: sourceBlocks.map((block) => ({ ...block, createdAt: block.createdAt.toISOString() })),
    concepts: concepts.map((concept) => {
      const evidence = concept.evidence.map((item) => ({
        sourceBlockId: item.sourceBlockId,
        quoteStart: item.quoteStart,
        quoteEnd: item.quoteEnd,
        quote: item.sourceBlock.content.slice(item.quoteStart, item.quoteEnd),
      }));
      return {
        id: concept.id, sectionId: concept.sectionId, name: concept.name, normalizedName: concept.normalizedName,
        aliases: concept.aliases, kind: concept.kind, explanation: concept.explanation, status: concept.status, origin: concept.origin,
        metadata: concept.metadata, sourceBlockIds: evidence.map((item) => item.sourceBlockId), sourceExcerpt: evidence[0]?.quote ?? "", evidence,
        exampleIds: concept.examples.map((item) => item.exampleId), figureIds: concept.figures.map((item) => item.figureId),
        createdAt: concept.createdAt.toISOString(), updatedAt: concept.updatedAt.toISOString(),
      };
    }),
    relations,
    examples: examples.map((example) => ({ ...example, conceptIds: example.concepts.map((item) => item.conceptId), createdAt: example.createdAt.toISOString(), updatedAt: example.updatedAt.toISOString() })),
    figures: figures.map((figure) => ({ ...figure, assetId: figure.fileAssetId, url: `/api/uploads/${figure.fileAssetId}`, conceptIds: figure.concepts.map((item) => item.conceptId), createdAt: figure.createdAt.toISOString() })),
    job: jobSnapshot(job),
  };
}

export async function updateTextbook(id: string, maintainerId: string, patch: { title?: string; author?: string | null; archived?: boolean }) {
  const textbook = await prisma.textbook.findUnique({ where: { id }, select: { maintainerId: true } });
  if (!textbook) throw new TextbookError("TEXTBOOK_NOT_FOUND", "教材不存在。", 404);
  if (textbook.maintainerId !== maintainerId) throw new TextbookError("TEXTBOOK_FORBIDDEN", "只有上传者可以维护这本教材。", 403);
  const updated = await prisma.textbook.update({
    where: { id },
    data: {
      ...(patch.title !== undefined ? { title: patch.title.trim().slice(0, 300) } : {}),
      ...(patch.author !== undefined ? { author: patch.author?.trim().slice(0, 300) || null } : {}),
      ...(patch.archived !== undefined ? { status: patch.archived ? "ARCHIVED" : "ACTIVE", archivedAt: patch.archived ? new Date() : null } : {}),
    },
    include: detailInclude,
  });
  return textbookSummary(updated);
}

export async function getTextbookJob(id: string) {
  const textbook = await prisma.textbook.findUnique({ where: { id }, include: detailInclude });
  if (!textbook) throw new TextbookError("TEXTBOOK_NOT_FOUND", "教材不存在。", 404);
  const revision = textbook.currentRevision ?? textbook.revisions[0] ?? null;
  return revision ? jobSnapshot(await latestJob(revision.id)) : null;
}

export async function retryTextbookIngest(id: string, maintainerId: string) {
  const textbook = await prisma.textbook.findUnique({ where: { id }, include: detailInclude });
  if (!textbook) throw new TextbookError("TEXTBOOK_NOT_FOUND", "教材不存在。", 404);
  if (textbook.maintainerId !== maintainerId) throw new TextbookError("TEXTBOOK_FORBIDDEN", "只有上传者可以重试教材解析。", 403);
  const revision = textbook.currentRevision ?? textbook.revisions[0];
  if (!revision) throw new TextbookError("TEXTBOOK_REVISION_NOT_FOUND", "教材没有可重试的版本。", 404);
  const current = await latestJob(revision.id);
  if (current && ["QUEUED", "RUNNING"].includes(current.status)) throw new TextbookError("TEXTBOOK_JOB_BUSY", "教材正在处理中。", 409);
  const hasParsedStructure = await prisma.textbookSection.count({ where: { revisionId: revision.id } }) > 0;
  const vectorOnly = hasParsedStructure && (
    revision.status === "WAITING_EMBEDDING"
    || revision.status === "READY"
    || current?.step === "embedding"
  );
  const job = current
    ? await prisma.generationJob.update({ where: { id: current.id }, data: { status: "QUEUED", error: null, completedAt: null, retryAt: null, progress: vectorOnly ? 88 : 0, step: vectorOnly ? "embedding" : "validation" } })
    : await prisma.generationJob.create({ data: {
      targetType: "TEXTBOOK_REVISION", targetId: revision.id, jobType: "TEXTBOOK_INGEST", status: "QUEUED",
      step: vectorOnly ? "embedding" : "validation", progress: vectorOnly ? 88 : 0,
      request: json({ requestedBy: maintainerId, textbookId: id, revisionId: revision.id }),
    } });
  await prisma.textbookRevision.update({
    where: { id: revision.id },
    data: { status: vectorOnly ? "WAITING_EMBEDDING" : "PENDING", readyAt: null, error: null },
  });
  return { revisionId: revision.id, job: jobSnapshot(job) };
}

/** Queue vector-only rebuilds after the embedding model identity changes. */
export async function queueTextbookEmbeddingReindex(requestedBy: string): Promise<string[]> {
  const revisions = await prisma.textbookRevision.findMany({
    where: { status: { in: ["READY", "WAITING_EMBEDDING"] }, sections: { some: {} } },
    select: { id: true, textbookId: true },
  });
  const queued: string[] = [];
  for (const revision of revisions) {
    const current = await latestJob(revision.id);
    if (current && ["QUEUED", "RUNNING"].includes(current.status)) continue;
    if (current) {
      await prisma.generationJob.update({ where: { id: current.id }, data: {
        status: "QUEUED", step: "embedding", progress: 88, error: null, completedAt: null, retryAt: null,
        request: json({ requestedBy, textbookId: revision.textbookId, revisionId: revision.id, reason: "embedding-profile-changed" }),
      } });
    } else {
      await prisma.generationJob.create({ data: {
        targetType: "TEXTBOOK_REVISION", targetId: revision.id, jobType: "TEXTBOOK_INGEST", status: "QUEUED", step: "embedding", progress: 88,
        request: json({ requestedBy, textbookId: revision.textbookId, revisionId: revision.id, reason: "embedding-profile-changed" }),
      } });
    }
    await prisma.textbookRevision.update({
      where: { id: revision.id },
      data: { status: "WAITING_EMBEDDING", readyAt: null, error: null },
    });
    queued.push(revision.id);
  }
  return queued;
}

type RankedRow = {
  id: string; revisionId: string; sectionId: string | null; sourceBlockId: string | null; conceptId: string | null; exampleId: string | null;
  kind: string; title: string | null; content: string; rank: number | bigint;
};

function tsQuery(value: string): string {
  return chineseSearchTokens(value).slice(0, 80).map((token) => `'${token.replaceAll("'", "''")}'`).join(" | ");
}

export async function searchTextbookEvidence(input: {
  revisionIds: string[];
  sectionIds?: string[];
  query: string;
  limit?: number;
}): Promise<TextbookEvidenceSearchResult> {
  const revisionIds = [...new Set(input.revisionIds)].slice(0, 20);
  const sectionIds = [...new Set(input.sectionIds ?? [])].slice(0, 200);
  const query = input.query.normalize("NFC").trim().slice(0, 2_000);
  const limit = Math.min(100, Math.max(1, input.limit ?? 20));
  if (!revisionIds.length || !query) return { query, degraded: true, degradationReason: "没有可检索的教材版本或查询内容。", hits: [] };
  const queryExpression = tsQuery(query);
  const sectionFilter = sectionIds.length ? Prisma.sql`AND ri."sectionId" IN (${Prisma.join(sectionIds)})` : Prisma.empty;
  const lexical = queryExpression ? await prisma.$queryRaw<RankedRow[]>(Prisma.sql`
    SELECT ri."id", ri."revisionId", ri."sectionId", ri."sourceBlockId", ri."conceptId", ri."exampleId",
      ri."kind", ri."title", ri."content",
      ROW_NUMBER() OVER (ORDER BY
        CASE WHEN LOWER(COALESCE(ri."title", '')) = LOWER(${query}) THEN 0 ELSE 1 END,
        ts_rank_cd(ri."searchVector", to_tsquery('simple', ${queryExpression})) DESC,
        ri."position" ASC) AS rank
    FROM "TextbookRetrievalItem" ri
    WHERE ri."revisionId" IN (${Prisma.join(revisionIds)})
      ${sectionFilter}
      AND ri."searchVector" @@ to_tsquery('simple', ${queryExpression})
    ORDER BY rank
    LIMIT 30
  `) : [];

  let semantic: RankedRow[] = [];
  let degraded = false;
  let degradationReason: string | null = null;
  try {
    const embedded = await embedTextbookTexts([query]);
    const profile = await prisma.embeddingProfile.findUnique({ where: { configFingerprint: embedded.profile.fingerprint } });
    if (!profile || profile.status !== "ACTIVE" || !profile.isActive) {
      throw new TextbookEmbeddingUnavailableError("当前向量配置尚未完成全库索引和原子切换。");
    }
    const literal = vectorSqlLiteral(embedded.vectors[0]);
    semantic = await prisma.$queryRaw<RankedRow[]>(Prisma.sql`
      SELECT ri."id", ri."revisionId", ri."sectionId", ri."sourceBlockId", ri."conceptId", ri."exampleId",
        ri."kind", ri."title", ri."content",
        ROW_NUMBER() OVER (ORDER BY embedding.embedding <=> ${literal}::vector, ri."position" ASC) AS rank
      FROM "TextbookEmbedding" embedding
      JOIN "TextbookRetrievalItem" ri ON ri."id" = embedding."retrievalItemId"
      WHERE embedding."profileId" = ${profile.id} AND embedding."status" = 'READY'
        AND ri."revisionId" IN (${Prisma.join(revisionIds)}) ${sectionFilter}
      ORDER BY rank
      LIMIT 30
    `);
    if (!semantic.length) throw new TextbookEmbeddingUnavailableError("所选教材版本尚未完成当前模型的向量索引。");
  } catch (error) {
    degraded = true;
    degradationReason = error instanceof Error ? error.message.slice(0, 500) : "向量检索暂不可用。";
  }

  const fused = new Map<string, { row: RankedRow; score: number; lexicalRank: number | null; semanticRank: number | null }>();
  const add = (row: RankedRow, mode: "lexical" | "semantic", index: number) => {
    const current = fused.get(row.id) ?? { row, score: 0, lexicalRank: null, semanticRank: null };
    current.score += 1 / (60 + index + 1);
    if (mode === "lexical") current.lexicalRank = index + 1;
    else current.semanticRank = index + 1;
    fused.set(row.id, current);
  };
  lexical.forEach((row, index) => add(row, "lexical", index));
  semantic.forEach((row, index) => add(row, "semantic", index));
  const hits: TextbookEvidenceSearchHit[] = [...fused.values()]
    .sort((left, right) => right.score - left.score || Number(left.row.rank) - Number(right.row.rank))
    .slice(0, limit)
    .map(({ row, score, lexicalRank, semanticRank }) => ({
      retrievalItemId: row.id, revisionId: row.revisionId, sectionId: row.sectionId, sourceBlockId: row.sourceBlockId,
      conceptId: row.conceptId, exampleId: row.exampleId, kind: row.kind, title: row.title, content: row.content,
      score, lexicalRank, semanticRank,
    }));
  return { query, degraded, degradationReason, hits };
}

export async function readTextbookSourceFile(revisionId: string) {
  const revision = await prisma.textbookRevision.findUnique({ where: { id: revisionId }, include: { fileAsset: true, textbook: true } });
  if (!revision || path.basename(revision.fileAsset.storageKey) !== revision.fileAsset.storageKey) throw new TextbookError("TEXTBOOK_SOURCE_NOT_FOUND", "教材原文件不存在。", 404);
  const filePath = path.join(textbookDataDir(), revision.fileAsset.storageKey);
  const info = await stat(/* turbopackIgnore: true */ filePath).catch(() => null);
  if (!info?.isFile() || info.size !== Number(revision.fileAsset.size) || info.size > TEXTBOOK_DOCX_LIMITS.compressedBytes) throw new TextbookError("TEXTBOOK_SOURCE_UNAVAILABLE", "教材原文件缺失或已损坏。", 422);
  const bytes = await readFile(/* turbopackIgnore: true */ filePath);
  if (createHash("sha256").update(bytes).digest("hex") !== revision.sha256) throw new TextbookError("TEXTBOOK_SOURCE_CORRUPTED", "教材原文件校验失败。", 422);
  return { revision, bytes };
}
