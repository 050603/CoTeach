import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/client";
import { parseTextbookDocx } from "./docx-parser";
import { embeddingProfile, embedTextbookTexts, vectorSqlLiteral } from "./embedding";
import { extractTextbookKnowledge } from "./extraction";
import { buildRetrievalChunks, normalizeTextbookText, textbookSearchTokenText } from "./text";
import { readTextbookSourceFile, textbookDataDir } from "./service";
import type { ParsedTextbookDocument } from "./types";

function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}

function stableUuid(value: string): string {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  const compact = hex.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

export function textbookConceptEvidenceId(revisionId: string, conceptKey: string, blockKey: string): string {
  return stableUuid(`${revisionId}:evidence:${conceptKey}:${blockKey}`);
}

function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function loadJob(revisionId: string) {
  return prisma.generationJob.findFirst({
    where: { targetType: "TEXTBOOK_REVISION", targetId: revisionId, jobType: "TEXTBOOK_INGEST" },
    orderBy: { createdAt: "desc" },
  });
}

async function updateJob(id: string, data: Prisma.GenerationJobUpdateInput) {
  return prisma.generationJob.update({ where: { id }, data: { ...data, heartbeatAt: new Date() } });
}

async function prepareFigureAssets(document: ParsedTextbookDocument, revision: NonNullable<Awaited<ReturnType<typeof readTextbookSourceFile>>>["revision"]) {
  await mkdir(/* turbopackIgnore: true */ textbookDataDir(), { recursive: true });
  const ids = new Map<string, string>();
  for (const figure of document.figures) {
    const sha256 = createHash("sha256").update(figure.bytes).digest("hex");
    const id = stableUuid(`${revision.id}:${figure.key}:${sha256}`);
    const extension = path.extname(figure.originalName).toLowerCase() || ".bin";
    const storageKey = `${id}${extension}`;
    const target = path.join(textbookDataDir(), storageKey);
    await writeFile(/* turbopackIgnore: true */ target, figure.bytes, { flag: "wx", mode: 0o600 }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
      const existing = await readFile(/* turbopackIgnore: true */ target);
      if (createHash("sha256").update(existing).digest("hex") !== sha256) throw new Error("教材图片文件校验失败。");
    });
    await chmod(/* turbopackIgnore: true */ target, 0o644);
    await prisma.fileAsset.upsert({
      where: { id },
      create: {
        id, storageKey, originalName: figure.originalName, mimeType: figure.mimeType, size: BigInt(figure.bytes.length), sha256,
        uploadedById: revision.textbook.maintainerId, sourceAssetId: revision.fileAssetId, assetRole: "TEXTBOOK_FIGURE",
        backupPolicy: "REQUIRED", regenerationRecipe: json({ schemaVersion: 1, operation: "extract-textbook-figure", revisionId: revision.id, relationshipId: figure.relationshipId, archivePath: figure.archivePath }),
      },
      update: { deletedAt: null, size: BigInt(figure.bytes.length), sha256 },
    });
    ids.set(figure.key, id);
  }
  return ids;
}

async function persistStructure(revisionId: string, document: ParsedTextbookDocument) {
  const source = await readTextbookSourceFile(revisionId);
  const figureAssetIds = await prepareFigureAssets(document, source.revision);
  const knowledge = extractTextbookKnowledge(document);
  const chunks = buildRetrievalChunks(document.blocks, document.sections);
  const sectionIds = new Map(document.sections.map((section) => [section.key, stableUuid(`${revisionId}:${section.key}`)]));
  const blockIds = new Map(document.blocks.filter((block) => block.metadata.isDirectory !== true && block.sectionKey && block.content.trim()).map((block) => [block.key, stableUuid(`${revisionId}:${block.key}`)]));
  const conceptIds = new Map(knowledge.concepts.map((concept) => [concept.key, stableUuid(`${revisionId}:${concept.key}`)]));
  const exampleIds = new Map(knowledge.examples.map((example) => [example.key, stableUuid(`${revisionId}:${example.key}`)]));
  const figureIds = new Map(document.figures.map((figure) => [figure.key, stableUuid(`${revisionId}:${figure.key}`)]));

  const result = await prisma.$transaction(async (tx) => {
    await tx.textbookRetrievalItem.deleteMany({ where: { revisionId } });
    await tx.textbookConceptRelation.deleteMany({ where: { revisionId } });
    await tx.textbookConceptEvidence.deleteMany({ where: { concept: { revisionId } } });
    await tx.textbookConceptFigure.deleteMany({ where: { concept: { revisionId } } });
    await tx.textbookConceptExample.deleteMany({ where: { concept: { revisionId } } });
    await tx.textbookFigure.deleteMany({ where: { revisionId } });
    await tx.textbookExample.deleteMany({ where: { revisionId } });
    await tx.textbookConcept.deleteMany({ where: { revisionId } });
    await tx.textbookSourceBlock.deleteMany({ where: { revisionId } });
    await tx.textbookSection.deleteMany({ where: { revisionId } });

    await tx.textbookSection.createMany({ data: document.sections.map((section) => ({
      id: sectionIds.get(section.key)!, revisionId, parentId: section.parentKey ? sectionIds.get(section.parentKey) ?? null : null,
      title: section.title, path: section.path, kind: section.kind, level: section.level, position: section.position,
    })) });
    const persistedBlocks = document.blocks.filter((block) => block.metadata.isDirectory !== true && block.sectionKey && block.content.trim() && sectionIds.has(block.sectionKey));
    await tx.textbookSourceBlock.createMany({ data: persistedBlocks.map((block) => ({
      id: blockIds.get(block.key)!, revisionId, sectionId: sectionIds.get(block.sectionKey!)!, blockKey: block.key,
      blockType: block.type, position: block.position, content: block.content, normalizedContent: normalizeTextbookText(block.content), metadata: json(block.metadata),
    })) });
    await tx.textbookConcept.createMany({ data: knowledge.concepts.map((concept) => ({
      id: conceptIds.get(concept.key)!, revisionId, sectionId: sectionIds.get(concept.sectionKey)!, name: concept.name,
      normalizedName: concept.normalizedName, aliases: concept.aliases, kind: concept.kind, explanation: concept.explanation,
      origin: "TEXTBOOK", metadata: json({ extraction: "deterministic-heading" }),
    })) });
    const evidence = knowledge.concepts.flatMap((concept) => concept.evidenceBlockKeys.flatMap((blockKey) => {
      const blockId = blockIds.get(blockKey);
      const block = document.blocks.find((candidate) => candidate.key === blockKey);
      return blockId && block ? [{ id: textbookConceptEvidenceId(revisionId, concept.key, blockKey), conceptId: conceptIds.get(concept.key)!, sourceBlockId: blockId, quoteStart: 0, quoteEnd: block.content.length }] : [];
    }));
    if (evidence.length) await tx.textbookConceptEvidence.createMany({ data: evidence });
    if (knowledge.relations.length) await tx.textbookConceptRelation.createMany({ data: knowledge.relations.map((relation) => ({
      id: stableUuid(`${revisionId}:${relation.key}`), revisionId, sourceConceptId: conceptIds.get(relation.sourceConceptKey)!,
      targetConceptId: conceptIds.get(relation.targetConceptKey)!, relationType: relation.relationType, origin: "TEXTBOOK",
      sourceBlockId: relation.sourceBlockKey ? blockIds.get(relation.sourceBlockKey) ?? null : null,
    })) });
    if (knowledge.examples.length) await tx.textbookExample.createMany({ data: knowledge.examples.map((example) => ({
      id: exampleIds.get(example.key)!, revisionId, sectionId: sectionIds.get(example.sectionKey)!, sourceBlockId: blockIds.get(example.sourceBlockKey) ?? null,
      title: example.title, content: example.content, origin: "TEXTBOOK", metadata: json({ extraction: "deterministic-example-marker" }),
    })) });
    const exampleLinks = knowledge.examples.flatMap((example) => example.conceptKeys.flatMap((conceptKey) => conceptIds.has(conceptKey) ? [{ conceptId: conceptIds.get(conceptKey)!, exampleId: exampleIds.get(example.key)! }] : []));
    if (exampleLinks.length) await tx.textbookConceptExample.createMany({ data: exampleLinks, skipDuplicates: true });
    if (document.figures.length) await tx.textbookFigure.createMany({ data: document.figures.map((figure) => ({
      id: figureIds.get(figure.key)!, revisionId, sectionId: figure.sectionKey ? sectionIds.get(figure.sectionKey) ?? null : null,
      sourceBlockId: figure.sourceBlockKey ? blockIds.get(figure.sourceBlockKey) ?? null : null, fileAssetId: figureAssetIds.get(figure.key)!,
      caption: figure.caption || null, position: figure.position, width: figure.width, height: figure.height,
      status: ["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].includes(figure.mimeType) ? "AVAILABLE" : "UNSUPPORTED",
      metadata: json({ relationshipId: figure.relationshipId, archivePath: figure.archivePath }),
    })) });
    const figureLinks = knowledge.conceptFigureKeys.flatMap((link) => conceptIds.has(link.conceptKey) && figureIds.has(link.figureKey) ? [{ conceptId: conceptIds.get(link.conceptKey)!, figureId: figureIds.get(link.figureKey)! }] : []);
    if (figureLinks.length) await tx.textbookConceptFigure.createMany({ data: figureLinks, skipDuplicates: true });

    const retrievalData: Prisma.TextbookRetrievalItemCreateManyInput[] = [];
    for (const [index, chunk] of chunks.entries()) retrievalData.push({
      id: stableUuid(`${revisionId}:retrieval:source:${chunk.key}`), revisionId,
      sectionId: chunk.sectionKey ? sectionIds.get(chunk.sectionKey) ?? null : null,
      sourceBlockId: blockIds.get(chunk.sourceBlockKeys[0]) ?? null, kind: "SOURCE_BLOCK", title: chunk.title,
      content: chunk.content, searchTokens: chunk.searchTokens, contentFingerprint: fingerprint(chunk.content), position: index,
      metadata: json({ sourceBlockIds: chunk.sourceBlockKeys.map((key) => blockIds.get(key)).filter(Boolean) }),
    });
    for (const [index, concept] of knowledge.concepts.entries()) retrievalData.push({
      id: stableUuid(`${revisionId}:retrieval:concept:${concept.key}`), revisionId, sectionId: sectionIds.get(concept.sectionKey)!,
      conceptId: conceptIds.get(concept.key)!, kind: "CONCEPT", title: concept.name, content: concept.explanation || concept.name,
      searchTokens: textbookSearchTokenText(`${concept.name} ${concept.aliases.join(" ")} ${concept.explanation}`),
      contentFingerprint: fingerprint(`${concept.name}\n${concept.explanation}`), position: index,
    });
    for (const [index, example] of knowledge.examples.entries()) retrievalData.push({
      id: stableUuid(`${revisionId}:retrieval:example:${example.key}`), revisionId, sectionId: sectionIds.get(example.sectionKey)!,
      sourceBlockId: blockIds.get(example.sourceBlockKey) ?? null, exampleId: exampleIds.get(example.key)!, kind: "EXAMPLE", title: example.title,
      content: example.content, searchTokens: textbookSearchTokenText(`${example.title} ${example.content}`),
      contentFingerprint: fingerprint(example.content), position: index,
    });
    if (retrievalData.length) await tx.textbookRetrievalItem.createMany({ data: retrievalData });
    const metadata = source.revision.metadata && typeof source.revision.metadata === "object" && !Array.isArray(source.revision.metadata) ? source.revision.metadata as Record<string, unknown> : {};
    await tx.textbook.update({ where: { id: source.revision.textbookId }, data: {
      currentRevisionId: revisionId,
      ...(!metadata.titleProvided ? { title: document.title } : {}),
      ...(!metadata.authorProvided && document.author ? { author: document.author } : {}),
    } });
    await tx.textbookRevision.update({ where: { id: revisionId }, data: {
      status: "WAITING_EMBEDDING", error: null, metadata: json({ ...metadata, warnings: document.warnings, counts: { sections: document.sections.length, blocks: persistedBlocks.length, concepts: knowledge.concepts.length, examples: knowledge.examples.length, figures: document.figures.length, retrievalItems: retrievalData.length } }),
    } });
    return { sections: document.sections.length, blocks: persistedBlocks.length, concepts: knowledge.concepts.length, examples: knowledge.examples.length, figures: document.figures.length, retrievalItems: retrievalData.length };
  }, { timeout: 60_000, maxWait: 10_000 });
  return result;
}

async function buildEmbeddings(revisionId: string, jobId: string) {
  const configured = embeddingProfile();
  if (!configured) return null;
  const profile = await prisma.embeddingProfile.upsert({
      where: { configFingerprint: configured.fingerprint },
      create: { name: `${configured.providerId}/${configured.model}`, provider: configured.providerId, baseUrl: configured.baseUrl, model: configured.model, dimensions: configured.dimensions, textProcessingVersion: "textbook-retrieval-v1", configFingerprint: configured.fingerprint, status: "BUILDING", isActive: false },
      update: { name: `${configured.providerId}/${configured.model}`, baseUrl: configured.baseUrl, model: configured.model },
  });
  const items = await prisma.textbookRetrievalItem.findMany({
    where: { revisionId, NOT: { embeddings: { some: { profileId: profile.id, status: "READY" } } } },
    select: { id: true, content: true, contentFingerprint: true }, orderBy: [{ kind: "asc" }, { position: "asc" }],
  });
  for (let offset = 0; offset < items.length; offset += 32) {
    await updateJob(jobId, { step: "embedding", progress: Math.min(98, 88 + Math.floor((offset / Math.max(items.length, 1)) * 10)) });
    const batch = items.slice(offset, offset + 32);
    const embedded = await embedTextbookTexts(batch.map((item) => item.content));
    for (let index = 0; index < batch.length; index++) {
      const item = batch[index];
      const record = await prisma.textbookEmbedding.upsert({
        where: { retrievalItemId_profileId_contentFingerprint: { retrievalItemId: item.id, profileId: profile.id, contentFingerprint: item.contentFingerprint } },
        create: { retrievalItemId: item.id, profileId: profile.id, contentFingerprint: item.contentFingerprint, status: "PENDING", attempt: 1 },
        update: { status: "PENDING", error: null, attempt: { increment: 1 } },
      });
      const literal = vectorSqlLiteral(embedded.vectors[index]);
      await prisma.$executeRaw(Prisma.sql`UPDATE "TextbookEmbedding" SET "embedding" = ${literal}::vector, "status" = 'READY', "embeddedAt" = NOW(), "updatedAt" = NOW(), "error" = NULL WHERE "id" = ${record.id}`);
    }
  }
  const missing = await prisma.textbookRetrievalItem.count({
    where: {
      revision: { status: { in: ["READY", "WAITING_EMBEDDING"] } },
      NOT: {
        embeddings: { some: { profileId: profile.id, status: "READY" } },
      },
    },
  });
  if (!missing && !profile.isActive) {
    await prisma.$transaction([
      prisma.embeddingProfile.updateMany({ where: { isActive: true, id: { not: profile.id } }, data: { isActive: false } }),
      prisma.embeddingProfile.update({ where: { id: profile.id }, data: { isActive: true, status: "ACTIVE" } }),
    ]);
  }
  return { profileId: profile.id, count: items.length, activated: !missing, remainingCoverage: missing };
}

export async function runTextbookIngestJob(revisionId: string): Promise<void> {
  const job = await loadJob(revisionId);
  if (!job) return;
  const claimed = await prisma.generationJob.updateMany({ where: { id: job.id, status: "QUEUED" }, data: { status: "RUNNING", attempt: { increment: 1 }, startedAt: job.startedAt ?? new Date(), heartbeatAt: new Date(), error: null } });
  if (claimed.count !== 1) return;
  try {
    const existingSections = await prisma.textbookSection.count({ where: { revisionId } });
    const canResumeEmbedding = existingSections > 0 && (job.step === "embedding" || (await prisma.textbookRevision.findUnique({ where: { id: revisionId }, select: { status: true } }))?.status === "WAITING_EMBEDDING");
    let counts: unknown = null;
    if (!canResumeEmbedding) {
      await updateJob(job.id, { step: "validation", progress: 5 });
      await prisma.textbookRevision.update({ where: { id: revisionId }, data: { status: "PARSING", error: null } });
      const { bytes } = await readTextbookSourceFile(revisionId);
      await updateJob(job.id, { step: "extracting", progress: 18 });
      const document = parseTextbookDocx(bytes);
      await updateJob(job.id, { step: "structure", progress: 35 });
      counts = await persistStructure(revisionId, document);
      await prisma.generationCheckpoint.upsert({ where: { jobId_step: { jobId: job.id, step: "structure" } }, create: { jobId: job.id, step: "structure", state: json(counts) }, update: { state: json(counts) } });
    }
    await updateJob(job.id, { step: "embedding", progress: 88, result: counts === null ? undefined : json({ counts }) });
    const embeddings = await buildEmbeddings(revisionId, job.id);
    if (!embeddings) {
      await prisma.textbookRevision.update({ where: { id: revisionId }, data: { status: "WAITING_EMBEDDING", error: null } });
      await updateJob(job.id, { status: "WAITING_CONFIGURATION", step: "embedding", progress: 90, error: "尚未配置可用的教材向量模型；关键词检索已可用。" });
      return;
    }
    await prisma.$transaction([
      prisma.textbookRevision.update({ where: { id: revisionId }, data: { status: "READY", readyAt: new Date(), error: null } }),
      prisma.generationJob.update({ where: { id: job.id }, data: { status: "COMPLETED", step: "ready", progress: 100, completedAt: new Date(), heartbeatAt: new Date(), error: null, result: json({ counts, embeddings }) } }),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 4_000) : "教材解析失败。";
    const failedStep = await prisma.generationJob.findUnique({ where: { id: job.id }, select: { step: true } })
      .then((current) => current?.step)
      .catch(() => undefined);
    const revisionStatus = failedStep === "embedding" ? "WAITING_EMBEDDING" : "FAILED";
    await prisma.$transaction([
      prisma.textbookRevision.update({ where: { id: revisionId }, data: { status: revisionStatus, error: message } }),
      prisma.generationJob.update({ where: { id: job.id }, data: { status: "FAILED", error: message, completedAt: new Date(), heartbeatAt: new Date() } }),
    ]).catch(() => undefined);
  }
}

export async function claimNextTextbookIngestJob(): Promise<string | null> {
  const job = await prisma.generationJob.findFirst({ where: { targetType: "TEXTBOOK_REVISION", jobType: "TEXTBOOK_INGEST", status: "QUEUED", OR: [{ retryAt: null }, { retryAt: { lte: new Date() } }] }, orderBy: { createdAt: "asc" } });
  return job?.targetId ?? null;
}

let workerStarted = false;
let workerStopping = false;
let workerTimer: NodeJS.Timeout | null = null;
let activeRun: Promise<void> | null = null;

async function tick(): Promise<void> {
  if (workerStopping) return;
  try {
    const revisionId = await claimNextTextbookIngestJob();
    if (revisionId) {
      activeRun = runTextbookIngestJob(revisionId);
      await activeRun;
      activeRun = null;
    }
  } catch (error) {
    console.warn("[textbook] ingest worker tick failed", error instanceof Error ? error.message : String(error));
  } finally {
    if (!workerStopping) {
      workerTimer = setTimeout(() => void tick(), 2_000);
      workerTimer.unref?.();
    }
  }
}

export async function startTextbookIngestWorker(): Promise<void> {
  if (workerStarted) return;
  workerStarted = true;
  workerStopping = false;
  // Reclaim only expired leases so overlapping rolling-deployment processes
  // cannot steal a live parser or embedding batch from each other.
  const staleHeartbeat = new Date(Date.now() - 2 * 60_000);
  await prisma.generationJob.updateMany({
    where: {
      targetType: "TEXTBOOK_REVISION",
      jobType: "TEXTBOOK_INGEST",
      status: "RUNNING",
      OR: [{ heartbeatAt: null }, { heartbeatAt: { lt: staleHeartbeat } }],
    },
    data: { status: "QUEUED", retryAt: new Date() },
  });
  void tick();
}

export async function stopTextbookIngestWorker(): Promise<void> {
  workerStopping = true;
  workerStarted = false;
  if (workerTimer) clearTimeout(workerTimer);
  workerTimer = null;
  if (activeRun) await activeRun.catch(() => undefined);
}
