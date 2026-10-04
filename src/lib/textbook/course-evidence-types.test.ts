import { describe, expect, it } from "vitest";
import { bindKnowledgeSourceSequenceReferences, formatCourseEvidenceContext, resolveCourseSourceSequenceContracts,
  sourceSequenceSemantics, type CourseEvidenceItem, type CourseEvidenceSnapshot } from "./course-evidence-types";

describe("knowledge structure evidence context", () => {
  it('shares complete original paragraphs across retrieved items while retaining each adoption and real location', () => {
    const story = '青蛙向小鱼描述牛，小鱼据已有形象想象了长腿长角的鱼。';
    const source = { textbookId: 'book', textbookTitle: '学习理论', revisionId: 'revision', revisionVersion: 1,
      sectionId: 'story', sectionPath: ['学习理论', '建构主义', '小鱼的故事'],
      sourceBlockId: 'fish', sourceBlockPosition: 17, quote: story };
    const snapshot: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1,
      fingerprint: 'shared-case', createdAt: '2026-10-02', retrievalMode: 'hybrid', warnings: [], selections: [],
      items: ['first', 'second'].map((id) => ({ id, kind: 'concept', title: '建构主义', content: '概念检索摘要',
        source, completeSourceBlocks: [{ sourceBlockId: 'fish', content: story, source }] })),
      mappings: ['first', 'second'].map((id) => ({ sourceKnowledgePointId: id, sourceKnowledgePointName: id,
        status: 'direct', evidenceItemIds: [id], rationale: '相关原文' })),
    };
    const compact = formatCourseEvidenceContext(snapshot, { deduplicateItems: true });
    expect(compact.split(story)).toHaveLength(2);
    const payload = JSON.parse(compact.split('\n\n')[1]) as {
      sourceBlocks: Array<{ content: string; source: typeof source }>;
      evidenceItems: Array<{ id: string; completeSourceBlocks: Array<{ sourceBlockId: string; source: typeof source }> }>;
    };
    expect(payload.sourceBlocks).toHaveLength(1);
    expect(payload.sourceBlocks[0]?.source.sourceBlockPosition).toBe(17);
    expect(payload.evidenceItems.map((item) => item.id)).toEqual(['first', 'second']);
    expect(payload.evidenceItems.every((item) => item.completeSourceBlocks[0]?.sourceBlockId === 'fish')).toBe(true);
    expect(payload.evidenceItems.every((item) => item.completeSourceBlocks[0]?.source.sectionId === 'story')).toBe(true);
    expect(snapshot.items[0]?.source.quote).toBe(story);
  });

  it("lists shared textbook evidence once while preserving each source mapping", () => {
    const snapshot: CourseEvidenceSnapshot = {
      schemaVersion: 2, version: 1, fingerprint: "context-test", createdAt: "2026-01-01T00:00:00.000Z", warnings: [],
      retrievalMode: "hybrid",
      items: [{
        id: "evidence-1", kind: "concept", title: "教材概念", content: "唯一教材原文",
        source: { textbookId: "book", textbookTitle: "教材", revisionId: "revision", revisionVersion: 1, sectionPath: ["第一章", "第一节"], sectionHierarchy: [
          { id: "chapter", title: "第一章", kind: "CHAPTER", level: 1 },
          { id: "section", title: "第一节", kind: "SECTION", level: 2 },
        ] },
      }],
      selections: [{ revisionId: "revision", primary: true, sectionIds: [] }],
      mappings: ["source-1", "source-2"].map((sourceKnowledgePointId) => ({
        sourceKnowledgePointId,
        sourceKnowledgePointName: sourceKnowledgePointId,
        status: "direct" as const,
        evidenceItemIds: ["evidence-1"],
        rationale: "教材明确支持",
      })),
    };

    const compact = formatCourseEvidenceContext(snapshot, { deduplicateItems: true });
    expect(compact.split("唯一教材原文")).toHaveLength(2);
    expect(compact).toContain('"sourceKnowledgePointId":"source-1"');
    expect(compact).toContain('"sourceKnowledgePointId":"source-2"');
    expect(compact).toContain('"id":"evidence-1"');
    expect(compact).toContain('"primaryRevisionId":"revision"');
    expect(compact).toContain('"sectionHierarchy":[{"id":"chapter"');
    expect(compact.length).toBeLessThan(formatCourseEvidenceContext(snapshot).length);
  });
});

describe('adopted source sequence contracts', () => {
  const flow: CourseEvidenceItem = {
    id: 'flow', kind: 'source-block', title: '教学设计步骤', content: '完整流程',
    source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'revision', revisionVersion: 1,
      sectionPath: ['教学设计步骤'] },
    sourceSequences: [{ kind: 'ordered-steps', anchorSourceBlockId: 'a-1',
      steps: ['确定目标', '设计活动', '评价效果'].map((label, index) => ({ label, sourceBlockId: `b-${index}` })) }],
  };
  const snapshot = { items: [flow], mappings: [{ sourceKnowledgePointId: 'broad-topic',
    sourceKnowledgePointName: '教学概念', status: 'partial' as const,
    evidenceItemIds: ['flow'], rationale: '检索候选包含多个相邻子主题' }] };

  it('binds complete facts to explicitly adopted evidence rather than broad retrieval candidates', () => {
    const contracts = resolveCourseSourceSequenceContracts(snapshot, [
      { id: 'definition', evidenceItemIds: ['definition-evidence'], sourceKnowledgePointIds: ['broad-topic'] },
      { id: 'design', evidenceItemIds: ['flow'], sourceKnowledgePointIds: ['broad-topic'] },
      { id: 'supplement', evidenceItemIds: [], sourceKnowledgePointIds: ['broad-topic'] },
    ]);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.knowledgePointIds).toEqual(['design']);
    expect(contracts[0]?.orderedSteps).toEqual(flow.sourceSequences![0]!.steps);
  });

  it('uses source mappings for legacy points that have no evidence adoption field', () => {
    expect(resolveCourseSourceSequenceContracts(snapshot,
      [{ id: 'legacy', sourceKnowledgePointIds: ['broad-topic'] }])[0]?.knowledgePointIds).toEqual(['legacy']);
  });

  it('merges the same complete source unit only across actual adopting points', () => {
    const other = { ...flow, id: 'flow-other' };
    const contracts = resolveCourseSourceSequenceContracts({ ...snapshot, items: [flow, other] }, [
      { id: 'first', evidenceItemIds: ['flow'] }, { id: 'second', evidenceItemIds: ['flow-other'] },
    ]);
    expect(contracts).toHaveLength(1);
    expect(contracts[0]?.knowledgePointIds).toEqual(['first', 'second']);
  });

  it('binds immutable complete references without trusting model fields or broad retrieval candidates', () => {
    const evidence: CourseEvidenceSnapshot = { ...snapshot, schemaVersion: 2, version: 3,
      fingerprint: 'current-evidence', createdAt: '2026-09-30T00:00:00Z',
      selections: [], warnings: [], retrievalMode: 'hybrid' };
    const sourceReferences = [{ resourceId: 'invented', sourceEvidenceFingerprint: 'stale',
      sourceEvidenceVersion: 0, evidenceItemIds: ['unadopted'],
      sequenceSemantics: 'ordered-steps' as const, orderedSteps: [] }];
    const points = [
      { id: 'design', name: '教学设计', description: '概述教学设计', evidenceItemIds: ['flow'], sourceSequenceReferences: sourceReferences },
      { id: 'unadopted', name: '补充概念', description: '不采用该流程', evidenceItemIds: [],
        sourceKnowledgePointIds: ['broad-topic'], sourceSequenceReferences: sourceReferences },
      { id: 'legacy', name: '旧知识点', description: '概述该来源', sourceKnowledgePointIds: ['broad-topic'] },
    ];
    const [design, unadopted, legacy] = bindKnowledgeSourceSequenceReferences(points, evidence);

    expect(design.sourceSequenceReferences).toEqual([{
      resourceId: 'source-sequence:a-1', sourceEvidenceFingerprint: evidence.fingerprint,
      sourceEvidenceVersion: evidence.version, evidenceItemIds: ['flow'],
      sequenceSemantics: 'ordered-steps', orderedSteps: flow.sourceSequences![0].steps,
    }]);
    expect(unadopted.sourceSequenceReferences).toBeUndefined();
    expect(legacy.sourceSequenceReferences).toEqual(design.sourceSequenceReferences);
    expect(design.description).toBe(points[0].description);
    expect(points[0].sourceSequenceReferences).toBe(sourceReferences);
    design.sourceSequenceReferences![0].orderedSteps[0].label = '不能反向改原来源';
    expect(flow.sourceSequences![0].steps[0].label).toBe('确定目标');
  });

  it('distinguishes numbered advice from an ordered process without weakening explicit phases', () => {
    const principle = { ...flow, source: { ...flow.source, sectionPath: ['教学设计原则'] } };
    expect(sourceSequenceSemantics(principle, [{ label: '提供认知支架' }, { label: '留出探索空间' }]))
      .toBe('enumerated-items');
    expect(sourceSequenceSemantics(principle, [{ label: '分析阶段' }, { label: '实施阶段' }]))
      .toBe('ordered-steps');
    expect(sourceSequenceSemantics({ ...principle,
      source: { ...flow.source, sectionPath: ['教学原则', '教学设计步骤'] } }, flow.sourceSequences![0]!.steps))
      .toBe('ordered-steps');
  });
});
