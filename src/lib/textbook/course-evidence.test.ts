// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revisions: vi.fn(), retrievalItems: vi.fn(), sourceBlocks: vi.fn(), figures: vi.fn(), search: vi.fn(), transaction: vi.fn(),
}));

vi.mock("@/lib/textbook/service", () => ({ searchTextbookEvidence: mocks.search }));
vi.mock("@/lib/db/client", () => ({ prisma: {
  textbookRevision: { findMany: mocks.revisions },
  textbookRetrievalItem: { findMany: mocks.retrievalItems },
  textbookSourceBlock: { findMany: mocks.sourceBlocks },
  textbookFigure: { findMany: mocks.figures },
  $transaction: mocks.transaction,
} }));

import { hydrateCourseEvidenceFigureReferences, resolveCourseEvidenceSnapshot, resolveCourseTextbookFigures } from "./course-evidence";
import { formatCourseEvidenceContext, type CourseEvidenceItem } from './course-evidence-types';
import { SOURCE_SEQUENCE_POLICY_VERSION } from './figure-sequence';
import { bindRequiredTextbookFiguresToOutlines } from "./course-visual-binding";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

describe("course textbook evidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.sourceBlocks.mockResolvedValue([]);
    mocks.revisions.mockResolvedValue([{
      id: "revision-1", revision: 3, status: "WAITING_EMBEDDING", textbookId: "book-1",
      textbook: { id: "book-1", title: "人工智能教学", status: "ACTIVE" },
      sections: [
        { id: "chapter-3", parentId: null, title: "第三章", path: "第三章", kind: "CHAPTER", level: 1, position: 6 },
        { id: "section-1", parentId: "chapter-3", title: "具身认知", path: "第三章/具身认知", kind: "SECTION", level: 2, position: 7 },
      ],
    }]);
    mocks.search.mockResolvedValue({
      query: "具身认知", degraded: true, degradationReason: "尚未配置向量模型",
      hits: [{ retrievalItemId: "retrieval-1", revisionId: "revision-1", sectionId: "section-1",
        sourceBlockId: "block-1", conceptId: "concept-1", exampleId: null, kind: "CONCEPT",
        title: "具身认知", content: "认知形成于身体与环境的互动。", score: 0.03, lexicalRank: 1, semanticRank: null }],
    });
    mocks.retrievalItems.mockResolvedValue([{
      id: "retrieval-1", revisionId: "revision-1", sectionId: "section-1", kind: "CONCEPT",
      title: "具身认知", content: "认知形成于身体与环境的互动。",
      revision: { revision: 3, textbookId: "book-1", textbook: { title: "人工智能教学" } },
      section: { id: "section-1", title: "具身认知", path: "第三章/具身认知", position: 7, figures: [{ id: "figure-1" }] },
      sourceBlock: { id: "block-1", content: "教材原文：认知形成于身体与环境的互动。", position: 48, figures: [] },
      concept: { aliases: ["具身学习"], evidence: [], figures: [] }, example: null,
    }]);
    const tx = {
      $executeRaw: vi.fn(), classroomTemplate: { findUnique: vi.fn().mockResolvedValue({ id: "course-1" }) },
      courseTextbookBinding: { updateMany: vi.fn(), upsert: vi.fn().mockResolvedValue({ id: "binding-1" }), findMany: vi.fn().mockResolvedValue([{ id: "binding-1" }]) },
      courseTextbookSection: { deleteMany: vi.fn(), createMany: vi.fn() },
      courseEvidenceSnapshot: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), updateMany: vi.fn(), create: vi.fn().mockResolvedValue({ id: "snapshot-1" }) },
      courseEvidenceSnapshotBinding: { createMany: vi.fn() },
    };
    mocks.transaction.mockImplementation(async (work: (value: typeof tx) => unknown) => work(tx));
  });

  it('expands a numbered process across old search chunks without changing the adopted revision', async () => {
    const sourceBlocks = ['1. 选择项目', '确定主题', '2. 制定计划', '明确分工',
      '3. 活动探究', '开展探究', '4. 制作作品', '形成作品',
      '5. 成果交流', '展示成果', '6. 活动评价', '回顾并评价']
      .map((content, index) => ({ id: `b-${index}`, revisionId: 'revision-1',
        sectionId: 'section-1', position: index, blockType: 'PARAGRAPH', content }));
    mocks.sourceBlocks.mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
      select.figures ? sourceBlocks.slice(0, 9).map((block) => ({
        ...block, figures: [],
      })) : sourceBlocks);
    const item: CourseEvidenceItem = {
      id: 'retrieval-old', kind: 'source-block', title: '项目式教学',
      content: '1. 选择项目……5. 成果交流',
      source: { textbookId: 'book-1', textbookTitle: '人工智能教学',
        revisionId: 'revision-1', revisionVersion: 3, sectionId: 'section-1',
        sectionPath: ['项目式教学'], sourceBlockId: 'b-0',
        sourceBlockIds: sourceBlocks.slice(0, 9).map((block) => block.id) },
    };
    const [hydrated] = await hydrateCourseEvidenceFigureReferences([item]);
    expect(hydrated?.sourceSequences?.[0]?.steps.map((step) => step.label)).toEqual([
      '选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价',
    ]);
    expect(hydrated?.source.revisionId).toBe('revision-1');
    const context = formatCourseEvidenceContext({ schemaVersion: 2, version: 1, fingerprint: 'f',
      createdAt: '2026-01-01', retrievalMode: 'hybrid', selections: [], warnings: [],
      items: [hydrated!], mappings: [{ sourceKnowledgePointId: 'kp-1',
        sourceKnowledgePointName: '项目式教学', status: 'direct', evidenceItemIds: [item.id], rationale: '原文' }] },
    { deduplicateItems: true });
    expect(context).toContain('活动评价');
  });

  it.each([undefined, 1])('refreshes a cached list from extraction policy %s without rewriting its source evidence', async (policyVersion) => {
    const sourceBlocks = ['1. 准备阶段', '(1) 认真选择教学内容', '(2) 平衡知识传授和活动实践',
      '(3) 保持活动整体性和阶段性', '(4) 使用信息技术作为认知工具',
      '2. 实施阶段', '(1) 监督和调整自主完成项目的过程', '(2) 合理安排协作学习分工',
      '实施阶段的完整说明', '3. 评价阶段', '依据项目结果和过程综合评价']
      .map((content, index) => ({ id: `b-${index}`, revisionId: 'revision-1',
        sectionId: 'section-1', position: index, blockType: 'PARAGRAPH', content }));
    mocks.sourceBlocks.mockImplementation(async ({ select }: { select: Record<string, unknown> }) =>
      select.figures ? sourceBlocks.slice(0, 9).map((block) => ({ ...block, figures: [] })) : sourceBlocks);
    const oldSequences: NonNullable<CourseEvidenceItem['sourceSequences']> = [{
      anchorSourceBlockId: 'b-6', kind: 'ordered-steps', steps: [
        { label: '监督和调整自主完成项目的过程', sourceBlockId: 'b-6' },
        { label: '合理安排协作学习分工', sourceBlockId: 'b-7' },
        { label: '评价阶段', sourceBlockId: 'b-9' },
      ],
    }];
    const item: CourseEvidenceItem = {
      id: 'retrieval-old', kind: 'source-block', title: '项目式教学模式的实施策略',
      content: sourceBlocks.slice(0, 9).map((block) => block.content).join('\n'),
      source: { textbookId: 'book-1', textbookTitle: '教材', revisionId: 'revision-1',
        revisionVersion: 3, sectionId: 'section-1', sectionPath: ['项目式教学模式的实施策略'],
        sourceBlockId: 'b-0', sourceBlockIds: sourceBlocks.slice(0, 9).map((block) => block.id) },
      sourceSequences: oldSequences, sourceSequencesResolved: true,
      sourceSequencePolicyVersion: policyVersion,
      figureRefs: [{ figureId: 'original-figure', relation: 'source-block-direct', direct: true }],
      figureSequencesResolved: true,
    };

    const [hydrated] = await hydrateCourseEvidenceFigureReferences([item]);

    expect(hydrated?.sourceSequences?.map((sequence) => sequence.steps.map((step) => step.label))).toEqual([
      ['准备阶段', '实施阶段', '评价阶段'],
      ['认真选择教学内容', '平衡知识传授和活动实践', '保持活动整体性和阶段性', '使用信息技术作为认知工具'],
      ['监督和调整自主完成项目的过程', '合理安排协作学习分工'],
    ]);
    expect(hydrated).toMatchObject({ sourceSequencesResolved: true,
      sourceSequencePolicyVersion: SOURCE_SEQUENCE_POLICY_VERSION, content: item.content,
      source: item.source, figureRefs: item.figureRefs });
    expect(item.sourceSequences).toBe(oldSequences);
    expect(item.sourceSequences?.[0]?.steps).toHaveLength(3);
    expect(mocks.sourceBlocks).toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: [{ revisionId: 'revision-1', sectionId: 'section-1' }] },
    }));
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it.each([false, true])('reuses a current immutable sequence cache, including an empty result (%s)', async (empty) => {
    const sourceSequences: NonNullable<CourseEvidenceItem['sourceSequences']> = empty ? [] : [{
      anchorSourceBlockId: 'block-1', kind: 'ordered-steps', steps: [
        { label: '选择项目', sourceBlockId: 'block-1' },
        { label: '开展探究', sourceBlockId: 'block-2' },
      ],
    }];
    mocks.sourceBlocks.mockResolvedValue([{ id: 'block-1', revisionId: 'revision-1',
      sectionId: 'section-1', position: 1, content: '教材正文', figures: [] }]);
    const item: CourseEvidenceItem = { id: 'cached', kind: 'source-block', title: '项目式教学',
      content: '教材正文', source: { textbookId: 'book-1', textbookTitle: '教材',
        revisionId: 'revision-1', revisionVersion: 3, sectionId: 'section-1',
        sectionPath: [], sourceBlockId: 'block-1', sourceBlockIds: ['block-1'] },
      sourceSequences, sourceSequencesResolved: true,
      sourceSequencePolicyVersion: SOURCE_SEQUENCE_POLICY_VERSION };

    const [hydrated] = await hydrateCourseEvidenceFigureReferences([item]);

    expect(hydrated?.sourceSequences).toBe(sourceSequences);
    expect(mocks.sourceBlocks).toHaveBeenCalledTimes(1);
    expect(mocks.sourceBlocks).not.toHaveBeenCalledWith(expect.objectContaining({
      where: { OR: expect.any(Array) },
    }));
  });

  it('records an empty source sequence result so the next hydration does not rescan its section', async () => {
    mocks.sourceBlocks.mockResolvedValue([{ id: 'block-1', revisionId: 'revision-1',
      sectionId: 'section-1', position: 1, blockType: 'PARAGRAPH', content: '不含编号的完整教材正文', figures: [] }]);
    const item: CourseEvidenceItem = { id: 'no-list', kind: 'source-block', title: '概念',
      content: '不含编号的完整教材正文', source: { textbookId: 'book-1', textbookTitle: '教材',
        revisionId: 'revision-1', revisionVersion: 3, sectionId: 'section-1', sectionPath: [],
        sourceBlockId: 'block-1', sourceBlockIds: ['block-1'] } };
    const [hydrated] = await hydrateCourseEvidenceFigureReferences([item]);
    expect(hydrated).toMatchObject({ sourceSequences: [], sourceSequencesResolved: true,
      sourceSequencePolicyVersion: SOURCE_SEQUENCE_POLICY_VERSION });

    mocks.sourceBlocks.mockClear();
    await hydrateCourseEvidenceFigureReferences([hydrated!]);
    expect(mocks.sourceBlocks).toHaveBeenCalledTimes(1);
  });

  it('preserves frozen lists when their immutable source blocks cannot be read', async () => {
    const sourceSequences: NonNullable<CourseEvidenceItem['sourceSequences']> = [{
      anchorSourceBlockId: 'block-1', kind: 'ordered-steps', steps: [
        { label: '选择项目', sourceBlockId: 'block-1' },
        { label: '开展探究', sourceBlockId: 'block-2' },
      ],
    }];
    const item: CourseEvidenceItem = { id: 'unavailable', kind: 'source-block', title: '项目式教学',
      content: '教材正文', source: { textbookId: 'book-1', textbookTitle: '教材',
        revisionId: 'revision-1', revisionVersion: 3, sectionId: 'section-1', sectionPath: [],
        sourceBlockId: 'block-1', sourceBlockIds: ['block-1'] },
      sourceSequences, sourceSequencesResolved: true };

    const [hydrated] = await hydrateCourseEvidenceFigureReferences([item]);

    expect(hydrated?.sourceSequences).toBe(sourceSequences);
    expect(hydrated?.sourceSequencePolicyVersion).toBeUndefined();
  });

  it('restores a long source paragraph cut inside a retrieval chunk', async () => {
    const full = '完整教材段落'.repeat(250);
    mocks.sourceBlocks.mockResolvedValue([{ id: 'long-block', revisionId: 'revision-1',
      position: 12, content: full, figures: [] }]);
    const item: CourseEvidenceItem = { id: 'long-chunk', kind: 'source-block',
      title: '长段落', content: full.slice(0, 1200),
      source: { textbookId: 'book-1', textbookTitle: '教材', revisionId: 'revision-1',
        revisionVersion: 3, sectionPath: [], sourceBlockId: 'long-block',
        sourceBlockIds: ['long-block'] } };
    const [hydrated] = await hydrateCourseEvidenceFigureReferences([item]);
    expect(hydrated?.completeSourceBlocks).toEqual([{ sourceBlockId: 'long-block', content: full }]);
  });

  it("freezes traceable lexical evidence without claiming semantic retrieval succeeded", async () => {
    const snapshot = await resolveCourseEvidenceSnapshot({
      courseId: "course-1",
      selections: [{ revisionId: "revision-1", primary: true, sectionIds: ["section-1"] }],
      upstreamKnowledgePoints: [{ id: "kp-1", name: "具身认知", description: "解释身体与环境的作用" }],
    });
    expect(snapshot.retrievalMode).toBe("lexical-degraded");
    expect(snapshot.mappings[0]).toMatchObject({ status: "direct", evidenceItemIds: ["retrieval-1"] });
    expect(snapshot.items[0]).toMatchObject({
      figureRefs: [{ figureId: "figure-1", relation: "section-candidate", direct: false }],
      figureIds: ["figure-1"], source: {
      textbookTitle: "人工智能教学", revisionVersion: 3, sourceBlockId: "block-1", sectionPosition: 7, sourceBlockPosition: 48,
      sectionHierarchy: [
        { id: "chapter-3", title: "第三章", kind: "CHAPTER", level: 1 },
        { id: "section-1", title: "具身认知", kind: "SECTION", level: 2 },
      ],
      },
    });
    expect(snapshot.warnings.join(" ")).toContain("语义检索暂不可用");
  });

  it("retrieves a child concept together with its substantive parent context", async () => {
    await resolveCourseEvidenceSnapshot({
      courseId: "course-1",
      selections: [{ revisionId: "revision-1", primary: true, sectionIds: ["section-1"] }],
      upstreamKnowledgePoints: [
        { id: "theory", name: "建构主义学习理论", description: "学习者主动建构意义并调整认知结构。", teachingRole: "core-concept" },
        { id: "assimilation", name: "同化", description: "把新经验纳入已有图式。", groupName: "建构主义学习理论", parentKnowledgePointId: "theory", teachingRole: "detail-concept" },
      ],
    });

    expect(mocks.search).toHaveBeenCalledTimes(2);
    expect(mocks.search.mock.calls[1]?.[0].query).toContain("同化\n把新经验纳入已有图式。\n建构主义学习理论\n建构主义学习理论\n学习者主动建构意义并调整认知结构。");
  });

  it("protects an adopted original in the second block even when its lexical mapping is partial", async () => {
    mocks.retrievalItems.mockImplementation(async ({ select }: { select?: unknown }) => select
      ? [{ id: "retrieval-1", revisionId: "revision-1", sourceBlockId: "block-1",
        metadata: { sourceBlockIds: ["block-1", "block-2"] } }]
      : [{ id: "retrieval-1", revisionId: "revision-1", sectionId: "section-1", kind: "SOURCE_BLOCK",
        title: "项目式教学模式的基本流程", content: "原文先介绍，再展示图 32。",
        metadata: { sourceBlockIds: ["block-1", "block-2"] },
        revision: { revision: 3, textbookId: "book-1", textbook: { title: "人工智能教学" } },
        section: { id: "section-1", title: "基本流程", path: "第三章/基本流程", position: 7,
          figures: [{ id: "same-section-only" }, { id: "figure-32" }] },
        sourceBlock: { id: "block-1", content: "先介绍流程", position: 1, figures: [] },
        concept: null, example: null }]);
    mocks.sourceBlocks.mockResolvedValue([
      { id: "block-1", revisionId: "revision-1", figures: [] },
      { id: "block-2", revisionId: "revision-1", figures: [{ id: "figure-32" }] },
    ]);
    mocks.figures.mockResolvedValue(["figure-32", "same-section-only"].map((id) => ({
      id, fileAssetId: `asset-${id}`, position: 1, caption: id, status: "AVAILABLE",
      fileAsset: { mimeType: "image/png", deletedAt: null },
      revision: { textbook: { title: "人工智能教学" } }, section: { title: "基本流程" },
    })));
    const snapshot = await resolveCourseEvidenceSnapshot({
      courseId: "course-1",
      selections: [{ revisionId: "revision-1", primary: true, sectionIds: ["section-1"] }],
      upstreamKnowledgePoints: [{ id: "upstream", name: "项目式教学流程", description: "完整流程" }],
    });
    expect(snapshot.mappings[0]?.status).toBe("partial");
    expect(snapshot.items[0]?.source.sourceBlockIds).toEqual(["block-1", "block-2"]);
    expect(snapshot.items[0]?.figureRefs).toContainEqual(expect.objectContaining({
      figureId: "figure-32", direct: true,
    }));
    const resources = await resolveCourseTextbookFigures(snapshot, [{
      id: "kp-project", evidenceItemIds: ["retrieval-1"], sourceKnowledgePointIds: ["upstream"],
    }]);
    expect(resources.find((item) => item.figureId === "figure-32")).toMatchObject({
      required: true, knowledgePointIds: ["kp-project"],
    });
    expect(resources.find((item) => item.figureId === "same-section-only")?.required).toBe(false);
  });

  it("keeps project and scaffold originals required when rebuilt lesson points lose evidence item IDs", async () => {
    mocks.figures.mockResolvedValue(["figure-32", "figure-33"].map((id) => ({
      id, fileAssetId: `asset-${id}`, position: 1, caption: id, status: "AVAILABLE",
      fileAsset: { mimeType: "image/png", deletedAt: null },
      revision: { textbook: { title: "人工智能教学" } }, section: { title: id },
    })));
    const snapshot = {
      schemaVersion: 2 as const, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(),
      retrievalMode: "hybrid" as const, selections: [], warnings: [],
      mappings: [
        { sourceKnowledgePointId: "project", sourceKnowledgePointName: "项目式教学", status: "partial" as const,
          evidenceItemIds: ["e-project"], rationale: "教材原文" },
        { sourceKnowledgePointId: "scaffold", sourceKnowledgePointName: "支架式教学", status: "partial" as const,
          evidenceItemIds: ["e-scaffold"], rationale: "教材原文" },
      ],
      items: [
        { id: "e-project", kind: "source-block" as const, title: "项目式教学", content: "完整流程",
          source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1",
            revisionVersion: 3, sectionPath: ["项目式教学"] },
          figureRefs: [{ figureId: "figure-32", relation: "source-block-direct" as const, direct: true }] },
        { id: "e-scaffold", kind: "source-block" as const, title: "支架式教学", content: "最近发展区",
          source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1",
            revisionVersion: 3, sectionPath: ["支架式教学"] },
          figureRefs: [{ figureId: "figure-33", relation: "source-block-direct" as const, direct: true }] },
      ],
    };
    const figures = await resolveCourseTextbookFigures(snapshot, [
      { id: "lesson-project", sourceKnowledgePointIds: ["project"] },
      { id: "lesson-scaffold", sourceKnowledgePointIds: ["scaffold"] },
    ]);
    expect(figures).toEqual(expect.arrayContaining([
      expect.objectContaining({ figureId: "figure-32", required: true,
        knowledgePointIds: ["lesson-project"] }),
      expect.objectContaining({ figureId: "figure-33", required: true,
        knowledgePointIds: ["lesson-scaffold"] }),
    ]));
  });

  it('keeps unadopted direct figures available without imposing them on points from the same upstream topic', async () => {
    mocks.figures.mockResolvedValue(['figure-adopted', 'figure-candidate'].map((id) => ({
      id, fileAssetId: `asset-${id}`, position: 1, caption: id, status: 'AVAILABLE',
      fileAsset: { mimeType: 'image/png', deletedAt: null },
      revision: { textbook: { title: '教材' } }, section: { title: '共同上游主题' },
    })));
    const snapshot = {
      schemaVersion: 2 as const, version: 1, fingerprint: 'f', createdAt: new Date(0).toISOString(),
      retrievalMode: 'hybrid' as const, selections: [], warnings: [],
      mappings: [{ sourceKnowledgePointId: 'broad-topic', sourceKnowledgePointName: '教学设计',
        status: 'partial' as const, evidenceItemIds: ['e-adopted', 'e-other', 'e-candidate'], rationale: '候选证据' }],
      items: ['e-adopted', 'e-other', 'e-candidate'].map((id): CourseEvidenceItem => ({
        id, kind: 'source-block', title: id, content: `${id}的原文`,
        source: { textbookId: 'book-1', textbookTitle: '教材', revisionId: 'revision-1',
          revisionVersion: 3, sectionPath: ['共同上游主题'] },
        figureRefs: id === 'e-other' ? [] : [{ figureId: id === 'e-adopted' ? 'figure-adopted' : 'figure-candidate',
          relation: 'source-block-direct', direct: true, groupKey: `source-block:${id}` }],
      })),
    };

    const figures = await resolveCourseTextbookFigures(snapshot, [
      { id: 'adopted-node', sourceKnowledgePointIds: ['broad-topic'], evidenceItemIds: ['e-adopted'] },
      { id: 'other-node', sourceKnowledgePointIds: ['broad-topic'], evidenceItemIds: ['e-other'] },
      { id: 'unadopted-node', sourceKnowledgePointIds: ['broad-topic'], evidenceItemIds: [] },
    ]);

    expect(figures).toHaveLength(2);
    expect(figures.find((figure) => figure.figureId === 'figure-adopted')).toMatchObject({
      required: true, knowledgePointIds: ['adopted-node'], groupKey: 'source-block:e-adopted',
      relation: 'direct', status: 'available',
    });
    expect(figures.find((figure) => figure.figureId === 'figure-candidate')).toMatchObject({
      required: false, knowledgePointIds: [], evidenceItemIds: ['e-candidate'],
      src: '/api/uploads/asset-figure-candidate', status: 'available',
    });
  });

  it('preserves both explicit adopters and older mapped owners of the same required original', async () => {
    mocks.figures.mockResolvedValue([{
      id: 'figure-1', fileAssetId: 'asset-1', position: 1, caption: '教材原图', status: 'AVAILABLE',
      fileAsset: { mimeType: 'image/png', deletedAt: null },
      revision: { textbook: { title: '教材' } }, section: { title: '原有主题' },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: 'f', createdAt: new Date(0).toISOString(),
      retrievalMode: 'hybrid', selections: [], warnings: [],
      mappings: [{ sourceKnowledgePointId: 'original-topic', sourceKnowledgePointName: '原有主题',
        status: 'direct', evidenceItemIds: ['e-1'], rationale: '原文支持' }],
      items: [{ id: 'e-1', kind: 'concept', title: '原有主题', content: '原文说明',
        source: { textbookId: 'book-1', textbookTitle: '教材', revisionId: 'revision-1',
          revisionVersion: 3, sectionPath: ['原有主题'] },
        figureRefs: [{ figureId: 'figure-1', relation: 'concept-direct', direct: true }] }],
    }, [
      { id: 'explicit-node', sourceId: 'reorganized-topic', evidenceItemIds: ['e-1'] },
      { id: 'legacy-node', sourceId: 'original-topic' },
      { id: 'explicitly-unadopted-node', sourceId: 'original-topic', evidenceItemIds: [] },
    ]);

    expect(figures[0]).toMatchObject({ required: true,
      knowledgePointIds: ['explicit-node', 'legacy-node'] });
  });

  it("turns only adopted evidence figures into protected course image references", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 2, caption: "具身认知关系图", width: 800, height: 600, status: "AVAILABLE",
      fileAsset: { id: "asset-1", mimeType: "image/png", deletedAt: null }, revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [{ sourceKnowledgePointId: "kp-1", sourceKnowledgePointName: "具身认知", status: "direct", evidenceItemIds: ["e"], rationale: "direct" }], warnings: [], items: [{
        id: "e", kind: "concept", title: "具身认知", content: "解释",
        figureRefs: [{ figureId: "figure-1", relation: "concept-direct", direct: true }], figureIds: ["figure-1"],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["第三章"] },
      }],
    });
    expect(figures).toEqual([expect.objectContaining({
      id: expect.stringMatching(/^textbook_fig_/), figureId: "figure-1", assetId: "asset-1",
      src: "/api/uploads/asset-1", relation: "direct", required: true, status: "available",
      knowledgePointIds: ["kp-1"],
    })]);
  });

  it("binds a source-linked required figure to the first page of its mapped lesson node", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 0, caption: "具身认知关系图", status: "AVAILABLE",
      fileAsset: { id: "asset-1", mimeType: "image/png", deletedAt: null },
      revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], warnings: [],
      mappings: [{ sourceKnowledgePointId: "source-embodied", sourceKnowledgePointName: "具身认知", status: "direct", evidenceItemIds: ["e"], rationale: "direct" }],
      items: [{ id: "e", kind: "concept", title: "具身认知", content: "教材说明",
        figureRefs: [{ figureId: "figure-1", relation: "concept-direct", direct: true }],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 1, sectionPath: ["第三章"] },
      }],
    }, [{ id: "kp-4", sourceKnowledgePointIds: ["source-embodied"], evidenceItemIds: ["e"] }]);

    expect(figures[0]?.knowledgePointIds).toEqual(["kp-4"]);
    const pages: SceneOutline[] = [{
      id: "first-kp-4", type: "slide", title: "首次讲解", description: "讲解具身认知", keyPoints: ["概念"],
      order: 0, generationPurpose: "knowledge-teaching", knowledgePointIds: ["kp-4"],
    }];
    const outlines = bindRequiredTextbookFiguresToOutlines(pages, figures);
    expect(outlines[0]?.suggestedImageIds).toContain(figures[0]?.id);
    expect(outlines[0]?.visualIntent?.resourceRefs?.[0]).toMatchObject({ required: true, resourceId: figures[0]?.id });
  });

  it("keeps later figures available instead of truncating the course pool at 24", async () => {
    const refs = Array.from({ length: 26 }, (_, index) => ({
      figureId: `figure-${index + 1}`, relation: "section-candidate" as const, direct: false,
    }));
    mocks.figures.mockResolvedValue(refs.map((reference, index) => ({
      id: reference.figureId, fileAssetId: `asset-${index + 1}`, position: index,
      caption: `图 ${index + 1}`, width: 800, height: 600, status: "AVAILABLE",
      fileAsset: { id: `asset-${index + 1}`, mimeType: "image/png", deletedAt: null },
      revision: { textbook: { title: "人工智能教学" } }, section: { title: "章节" },
    })));
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [], warnings: [], items: [{
        id: "e", kind: "concept", title: "主题", content: "解释", figureRefs: refs,
        figureIds: refs.map((reference) => reference.figureId),
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["章节"] },
      }],
    });
    expect(figures).toHaveLength(26);
    expect(figures.at(-1)).toMatchObject({ figureId: "figure-26", status: "available" });
  });

  it("preserves an unavailable required textbook figure as an explicit failure", async () => {
    mocks.figures.mockResolvedValue([{
      id: "figure-1", fileAssetId: "asset-1", position: 0, caption: "核心原图", width: 800, height: 600, status: "UNSUPPORTED",
      fileAsset: { id: "asset-1", mimeType: "image/png", deletedAt: null }, revision: { textbook: { title: "人工智能教学" } }, section: { title: "具身认知" },
    }]);
    const figures = await resolveCourseTextbookFigures({
      schemaVersion: 2, version: 1, fingerprint: "f", createdAt: new Date(0).toISOString(), retrievalMode: "hybrid",
      selections: [], mappings: [{ sourceKnowledgePointId: "kp-1", sourceKnowledgePointName: "具身认知", status: "direct", evidenceItemIds: ["e"], rationale: "direct" }], warnings: [], items: [{
        id: "e", kind: "concept", title: "具身认知", content: "解释",
        figureRefs: [{ figureId: "figure-1", relation: "concept-direct", direct: true }], figureIds: ["figure-1"],
        source: { textbookId: "book-1", textbookTitle: "人工智能教学", revisionId: "revision-1", revisionVersion: 3, sectionPath: ["第三章"] },
      }],
    });
    expect(figures).toEqual([expect.objectContaining({
      figureId: "figure-1", required: true, status: "unavailable",
      failureReason: "教材图片状态为 UNSUPPORTED",
    })]);
  });
});
