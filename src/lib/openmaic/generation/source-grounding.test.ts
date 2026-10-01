import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { buildAuthoringSourceCatalog, pageOriginalTeachingSources } from './source-grounding';
import { resolveNarrationSourceParts } from './source-narration-authoring';

const definition = '只有各个个体具有明确的被抽取机会，随机抽样才能减少人为选择产生的偏差。';
const sourceEvidence: CourseEvidenceSnapshot = {
  schemaVersion: 2, version: 1, fingerprint: 'source-v1', createdAt: '2026-09-30',
  retrievalMode: 'hybrid', selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }],
  mappings: [], warnings: [], items: [{
    id: 'sampling-original', kind: 'concept', title: '随机抽样', content: '模型整理过的概念摘要，不能当原文。',
    source: { textbookId: 'book', textbookTitle: '统计教材', revisionId: 'book-v1', revisionVersion: 1,
      sectionPath: ['抽样方法'], sourceBlockId: 'original-paragraph', quote: definition },
    completeSourceBlocks: [{ sourceBlockId: 'original-paragraph', content: definition }],
  }, {
    id: 'later-topic', kind: 'source-block', title: '来源独立性', content: '尚未分配给本页的下一节教材。',
    source: { textbookId: 'book', textbookTitle: '统计教材', revisionId: 'book-v1', revisionVersion: 1,
      sectionPath: ['其他主题'] },
  }],
};
const outline: SceneOutline = { id: 'sampling-page', type: 'slide', title: '随机抽样',
  description: '观察选择机会', keyPoints: ['按随机规则抽取'], order: 0, knowledgePointIds: ['lesson-sampling'],
  teachingBrief: { schemaVersion: 1, explanation: '教学设计也被压缩过。', examples: [], conditions: [],
    evidence: [{ sourceId: 'source', quote: definition }, { sourceId: 'stale', quote: '旧错误定义' }], assessmentFocus: '' },
};

describe('direct original teaching source', () => {
  it('keeps an adopted ancestor introduction at its actual source location in the first narration catalog', () => {
    const original = '分层缓存策略，又称多级缓存策略，它强调按不同缓存层的一致性和回退规则组织数据访问。';
    const item = sourceEvidence.items[0]!;
    const parentSource = { ...item.source, sectionId: 'parent', sectionPath: ['缓存策略'], sourceBlockPosition: 10, quote: original };
    const evidence = { ...sourceEvidence, items: [{ ...item, completeSourceBlocks: [
      { sourceBlockId: 'parent-intro', content: original, source: parentSource },
      { sourceBlockId: 'stale-intro', content: '另一版本的错误引言。',
        source: { ...parentSource, revisionId: 'other-version' } },
    ] }] };
    const page = { ...outline, teachingBrief: { ...outline.teachingBrief!, evidence: [{ sourceId: 'book', quote: original }] } };
    const sources = pageOriginalTeachingSources(page, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id] }] });
    expect(sources.originalSources[0]!.passages[0]).toEqual({ sourceBlockId: 'parent-intro', text: original, source: parentSource });
    expect(sources.originalSources[0]!.sectionPath).toEqual(item.source.sectionPath);
    expect(sources.authoritativeAnchors.find((anchor) => anchor.sourceDefinitionKey)?.text).toBe(original);
    const catalog = buildAuthoringSourceCatalog(new Map([[page.id, sources]]));
    expect(JSON.stringify(catalog.catalog)).toContain('"sectionId":"parent"');
    expect(JSON.stringify(catalog.catalog).split(original)).toHaveLength(2);
    expect(JSON.stringify(catalog.catalog)).not.toContain('另一版本的错误引言');
    expect(catalog.catalog.texts[catalog.pages.get(page.id)!.authoritativeAnchors
      .find((anchor) => anchor.id === 'source-definition-1')!.textRef]).toBe(original);
  });

  it('uses current lesson evidence ownership to recover the unchanged original passage', () => {
    const sources = pageOriginalTeachingSources(outline, { sourceEvidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: ['sampling-original'] }] });
    expect(sources.originalSources[0]?.passages).toEqual([{ sourceBlockId: 'original-paragraph', text: definition }]);
    expect(sources.originalQuotes).toEqual([definition]);
    expect(sources.authoritativeAnchors).toEqual([{ id: 'source-quote-1', text: definition }]);
    expect(JSON.stringify(sources)).not.toContain('模型整理过的概念摘要');
    expect(JSON.stringify(sources)).not.toContain('下一节教材');
    expect(JSON.stringify(sources)).not.toContain('旧错误定义');
  });

  it('interns shared evidence once per request without merging page ownership or source provenance', () => {
    const sources = pageOriginalTeachingSources(outline, { sourceEvidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: ['sampling-original'] }] });
    const catalog = buildAuthoringSourceCatalog(new Map([['a', sources], ['b', sources]]));
    const request = JSON.stringify({ evidenceCatalog: catalog.catalog, pages: [...catalog.pages] });
    expect(request.split(definition)).toHaveLength(2);
    expect(catalog.pages.get('a')?.originalSourceRefs).toEqual(catalog.pages.get('b')?.originalSourceRefs);
    expect(Object.values(catalog.catalog.sources)).toHaveLength(1);
    const anchor = catalog.pages.get('a')!.authoritativeAnchors[0]!;
    expect(catalog.catalog.texts[anchor.textRef]).toBe(definition);
    const secondBook = { ...sources, originalSources: sources.originalSources.map((source) => ({ ...source, revisionId: 'other-book' })) };
    const distinct = buildAuthoringSourceCatalog(new Map([['a', sources], ['b', secondBook]]));
    expect(distinct.pages.get('a')?.originalSourceRefs).not.toEqual(distinct.pages.get('b')?.originalSourceRefs);
    expect(Object.values(distinct.catalog.sources)).toHaveLength(2);
    expect(Object.values(distinct.catalog.texts).filter((text) => text === definition)).toHaveLength(1);
  });

  it('does not manufacture an original passage from a concept retrieval summary', () => {
    const item = sourceEvidence.items[0]!;
    const evidence = { ...sourceEvidence, items: [{ ...item, completeSourceBlocks: [],
      source: { ...item.source, quote: undefined } }] };
    const sources = pageOriginalTeachingSources(outline, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id] }] });
    expect(sources.originalSources).toEqual([]);
    expect(sources.originalQuotes).toEqual([]);
  });

  it('respects explicit current adoption instead of adding stale retrieval matches', () => {
    const evidence = { ...sourceEvidence, mappings: [{ sourceKnowledgePointId: 'lesson-sampling',
      sourceKnowledgePointName: '随机抽样', status: 'direct' as const,
      evidenceItemIds: ['later-topic'], rationale: '旧检索结果' }] };
    const adopted = pageOriginalTeachingSources(outline, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: ['sampling-original'] }] });
    expect(adopted.originalSources.map((source) => source.evidenceId)).toEqual(['sampling-original']);
    const declined = pageOriginalTeachingSources(outline, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [] }] });
    expect(declined.originalSources).toEqual([]);
    expect(declined.originalQuotes).toEqual([]);
    const legacy = pageOriginalTeachingSources(outline, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling' }] });
    expect(legacy.originalSources.map((source) => source.evidenceId)).toEqual(['later-topic']);
  });

  it('keeps complete numbered source explanations independent of the slide summary', () => {
    const sources = pageOriginalTeachingSources(outline, { sourceSequenceContracts: [{
      resourceId: 'conditions', required: true, knowledgePointIds: ['lesson-sampling'],
      sequenceSemantics: 'enumerated-items', orderedSteps: [
        { label: '抽样框需要覆盖目标总体' }, { label: '个体必须有明确被抽取机会' },
      ],
    }] });
    expect(sources.requiredSourceLists[0]?.steps).toEqual([
      { label: '抽样框需要覆盖目标总体' }, { label: '个体必须有明确被抽取机会' },
    ]);
    expect(sources.authoritativeAnchors.slice(0, 2)).toEqual([
      { id: 'source-list-1-item-1', text: '抽样框需要覆盖目标总体。', sourceListId: 'conditions', sourceLabel: '抽样框需要覆盖目标总体' },
      { id: 'source-list-1-item-2', text: '个体必须有明确被抽取机会。', sourceListId: 'conditions', sourceLabel: '个体必须有明确被抽取机会' },
    ]);
    expect(outline.keyPoints).toEqual(['按随机规则抽取']);
  });

  it('binds independent source lists separately and excludes another page’s source duties', () => {
    const sources = pageOriginalTeachingSources(outline, { sourceEvidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: ['sampling-original'] }],
      sourceSequenceContracts: [
        { resourceId: 'coverage', required: true, knowledgePointIds: ['lesson-sampling'],
          orderedSteps: [{ label: '抽样框覆盖目标总体' }] },
        { resourceId: 'probability', required: true, knowledgePointIds: ['lesson-sampling'],
          orderedSteps: [{ label: '每个个体具有明确机会' }] },
        { resourceId: 'other-topic', required: true, knowledgePointIds: ['another-point'],
          orderedSteps: [{ label: '下一页的新知识' }] },
      ] });
    expect(sources.authoritativeAnchors).toEqual([
      { id: 'source-list-1-item-1', text: '抽样框覆盖目标总体。', sourceListId: 'coverage', sourceLabel: '抽样框覆盖目标总体' },
      { id: 'source-list-2-item-1', text: '每个个体具有明确机会。', sourceListId: 'probability', sourceLabel: '每个个体具有明确机会' },
      { id: 'source-quote-1', text: definition },
    ]);
  });

  it('binds a short concept heading to its adopted source explanation without borrowing another list’s meaning', () => {
    const label = '学习空间的延展性';
    const explanation = '拓展性资源帮助学生自主探索和解决问题，将学到的知识和技能迁移到新的情境，形成深层理解。';
    const item = sourceEvidence.items[0]!;
    const evidence = { ...sourceEvidence, items: [{ ...item, sourceSequences: [
      { anchorSourceBlockId: 'authentic-learning', kind: 'ordered-steps' as const,
        steps: [{ label, sourceBlockId: 'authentic-item-5', excerpt: explanation }] },
      { anchorSourceBlockId: 'another-list', kind: 'ordered-steps' as const,
        steps: [{ label, sourceBlockId: 'other-item', excerpt: '另一个列表使用同名标签但解释不同。' }] },
    ] }] };
    const sources = pageOriginalTeachingSources(outline, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id] }],
      sourceSequenceContracts: [{ resourceId: 'source-sequence:authentic-learning', required: true,
        knowledgePointIds: ['lesson-sampling'], orderedSteps: [{ label }] }] });
    expect(sources.requiredSourceLists[0]?.steps).toEqual([{ label, sourceDescriptions: [explanation] }]);
    expect(sources.authoritativeAnchors[0]).toEqual({ id: 'source-list-1-item-1', text: `${label}。${explanation}`, sourceLabel: label,
      sourceListId: 'source-sequence:authentic-learning', meaningSourceRef: 'source-list-1-item-1-meaning' });
    expect(sources.authoritativeAnchors[1]).toEqual({ id: 'source-list-1-item-1-meaning', text: explanation });
    const declined = pageOriginalTeachingSources(outline, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [] }],
      sourceSequenceContracts: [{ resourceId: 'source-sequence:authentic-learning', required: true,
        knowledgePointIds: ['lesson-sampling'], orderedSteps: [{ label }] }] });
    expect(declined.requiredSourceLists[0]?.steps).toEqual([{ label }]);
  });

  it('authors a named characteristic as a complete source claim without copying its whole explanatory paragraph', () => {
    const item = sourceEvidence.items[0]!;
    const definition = '学生在探究中获得知识和技能，并将它们迁移到新的情境。';
    const rest = '教师可据此组织拓展活动，并用具体案例进一步讲解。';
    const sources = pageOriginalTeachingSources(outline, { sourceEvidence: { ...sourceEvidence,
      items: [{ ...item, sourceSequences: [{ anchorSourceBlockId: 'transfer-features', kind: 'ordered-steps',
        steps: [{ label: '学习空间的延展性', sourceBlockId: 'feature-5', excerpt: definition + rest }] }] }] },
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id] }],
      sourceSequenceContracts: [{ resourceId: 'source-sequence:transfer-features', required: true,
        knowledgePointIds: ['lesson-sampling'], orderedSteps: [{ label: '学习空间的延展性' }] }] });
    expect(sources.authoritativeAnchors[0]?.text).toBe(`学习空间的延展性。${definition}`);
    expect(sources.authoritativeAnchors[0]?.text).not.toContain(rest);
    expect(sources.requiredSourceLists[0]?.steps[0]?.sourceDescriptions).toEqual([definition + rest]);
    expect(outline.keyPoints).toEqual(['按随机规则抽取']);
  });

  it.each(['。', '！', '？', '.', '!', '?', '；', ';', '。”', '？）'])('retains an existing source sentence boundary without adding punctuation: %s', (ending) => {
    const label = `个体必须有明确被抽取机会${ending}`;
    const sources = pageOriginalTeachingSources(outline, { sourceSequenceContracts: [{
      resourceId: 'conditions', required: true, knowledgePointIds: ['lesson-sampling'], orderedSteps: [{ label }],
    }] });
    expect(sources.authoritativeAnchors.filter((anchor) => anchor.sourceListId)).toEqual([{ id: 'source-list-1-item-1', text: label,
      sourceListId: 'conditions', sourceLabel: label }]);
    expect(sources.requiredSourceLists[0]?.steps).toEqual([{ label }]);
  });

  it('closes short source slots before compiling adjacent authored explanation while keeping original labels and facts unchanged', () => {
    const labels = ['创设情境,提出任务', '教学支架是可调节的'];
    const explanation = '教师应根据学生的需要调整支持，并保留逐渐撤出的安排。';
    const item = sourceEvidence.items[0]!;
    const adopted = { ...sourceEvidence, items: [{ ...item, sourceSequences: [{ anchorSourceBlockId: 'teaching-slots',
      kind: 'ordered-steps' as const, steps: labels.map((label, index) => ({ label, sourceBlockId: `item-${index + 1}`, excerpt: explanation })) }] }] };
    const input = { sourceEvidence: adopted, sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id] }],
      sourceSequenceContracts: [{ resourceId: 'source-sequence:teaching-slots', required: true,
        knowledgePointIds: ['lesson-sampling'], orderedSteps: labels.map((label) => ({ label })) }] };
    const before = structuredClone(input);
    const sources = pageOriginalTeachingSources(outline, input);
    expect(sources.authoritativeAnchors.filter((anchor) => anchor.sourceListId).map((anchor) => ({
      text: anchor.text, sourceLabel: anchor.sourceLabel,
    }))).toEqual(labels.map((label) => ({ text: `${label}。`, sourceLabel: label })));
    expect(sources.requiredSourceLists[0]?.steps).toEqual(labels.map((label) => ({ label, sourceDescriptions: [explanation] })));
    expect(sources.originalQuotes).toEqual([definition]);
    expect(sources.originalSources[0]?.passages).toEqual([{ sourceBlockId: 'original-paragraph', text: definition }]);
    expect(input).toEqual(before);
    const scoped = new Map([[outline.id, new Map(sources.authoritativeAnchors.map((anchor) => [anchor.id, anchor.text]))]]);
    expect(resolveNarrationSourceParts({ pageId: outline.id, segments: [{ textParts: [
      { sourceRef: 'source-list-1-item-1' }, { text: '任务必须与教学目标紧密联系。' },
      { sourceRef: 'source-list-1-item-2' }, { text: '。第二条强调逐渐撤出支持。' },
    ] }] }, scoped)).toEqual({ pageId: outline.id, segments: [{
      text: '创设情境,提出任务。任务必须与教学目标紧密联系。教学支架是可调节的。第二条强调逐渐撤出支持。',
    }] });
  });
});

describe('verified original definition slots', () => {
  function verified(quote: string, revisionId = 'book-v1') {
    const item = sourceEvidence.items[0]!;
    const evidence: CourseEvidenceSnapshot = { ...sourceEvidence,
      items: [{ ...item, source: { ...item.source, revisionId, quote },
        completeSourceBlocks: [{ sourceBlockId: 'definition-paragraph', content: quote }] }],
    };
    const page: SceneOutline = { ...outline, teachingBrief: { ...outline.teachingBrief!, evidence: [{ sourceId: 'book', quote }] } };
    return { page, input: { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id] }] } };
  }

  it.each([
    '项目式学习，是一种围绕真实问题开展持续探究并形成成果的学习方式。',
    '概念迁移是指把已经掌握的知识与技能应用于新的情境。',
    '所谓任务,即是将课程的知识与技能融入其中,它通常源自于真实情境。',
    '随机抽样指的是总体中的个体具有明确被抽取机会的抽样方法。',
    '教学支架被定义为帮助学生完成暂时不能独立完成任务的支持。',
    '分层缓存策略，又称多级缓存策略，它强调按不同缓存层的一致性和回退规则组织数据访问。',
    '在抛锚式教学法中,“锚”指的是教师为学生构建的真实而复杂的问题情境。',
  ])('requires an unchanged, adopted original definition sentence: %s', (sentence) => {
    const { page, input } = verified(sentence);
    const sources = pageOriginalTeachingSources(page, input);
    expect(sources.authoritativeAnchors).toEqual([
      { id: 'source-quote-1', text: sentence },
      { id: 'source-definition-1', text: sentence, sourceDefinitionKey: JSON.stringify(['book-v1', sentence]) },
    ]);
  });

  it('compiles only the first complete definition sentence while leaving its full source paragraph and selective quote unchanged', () => {
    const sentence = '任务驱动式教学法,是一种依托于趣味盎然、能唤起学生学习热情与探究欲望的教学情景,以紧贴课程内容的任务为核心,引导学习者在达成既定任务的过程中自然习得知识与技能的教学模式。';
    const rest = '任务构成了显性线索，知识与技能的培育构成了隐性脉络。教师可以进一步解释任务的设计过程。';
    const { page, input } = verified(sentence + rest);
    const before = structuredClone({ page, input });
    const sources = pageOriginalTeachingSources(page, input);
    expect(sources.authoritativeAnchors.find((anchor) => anchor.sourceDefinitionKey)).toEqual({
      id: 'source-definition-1', text: sentence, sourceDefinitionKey: JSON.stringify(['book-v1', sentence]),
    });
    expect(sources.originalQuotes).toEqual([sentence + rest]);
    expect(sources.originalSources[0]?.passages.map((passage) => passage.text)).toEqual([sentence + rest]);
    expect(sources.authoritativeAnchors.find((anchor) => anchor.id === 'source-quote-1')?.text).toBe(sentence + rest);
    expect({ page, input }).toEqual(before);
  });

  it.each([
    '教师应为学生留出自由选择、自由探索的空间。',
    '维果斯基的理论指出，教学应领先于学生的现有发展水平。',
    '1980年研究者提出了教学支架是一种临时支持。',
    '作者认为支架是一种支持学生的工具。',
    '这项建议是一种可选的组织方式。',
    '教师先组织一个真实任务。项目式学习是一种形成成果的学习方式。',
    '项目式学习是一种围绕真实问题探究并形成成果的学习方式',
  ])('keeps narratives, recommendations, later definitions and incomplete quotes selective: %s', (quote) => {
    const { page, input } = verified(quote);
    const sources = pageOriginalTeachingSources(page, input);
    expect(sources.authoritativeAnchors).toEqual([{ id: 'source-quote-1', text: quote }]);
    expect(sources.originalQuotes).toEqual([quote]);
  });

  it('does not manufacture a required definition from an unverified brief or a retrieval summary', () => {
    const sentence = '随机抽样是指每个个体具有明确被抽取机会的抽样方法。';
    const { page, input } = verified(sentence);
    const item = input.sourceEvidence.items[0]!;
    const unavailable = { ...input, sourceEvidence: { ...input.sourceEvidence, items: [{ ...item,
      content: sentence, completeSourceBlocks: [], source: { ...item.source, quote: undefined } }] } };
    expect(pageOriginalTeachingSources(page, unavailable).authoritativeAnchors).toEqual([]);
    expect(pageOriginalTeachingSources(page, {}).authoritativeAnchors).toEqual([{ id: 'source-quote-1', text: sentence }]);
  });

  it('makes both actually adopted verified definitions available for selective comparison', () => {
    const primary = '随机抽样是指每个个体具有明确被抽取机会的抽样方法。';
    const secondary = '随机抽样是指通过随机规则选择研究对象的一种抽样方法。';
    const { page, input } = verified(primary);
    const original = input.sourceEvidence.items[0]!;
    const other = { ...original, id: 'secondary-original', source: { ...original.source,
      textbookId: 'other-book', revisionId: 'other-book-v1', quote: secondary },
      completeSourceBlocks: [{ sourceBlockId: 'secondary-definition', content: secondary }] };
    const sources = pageOriginalTeachingSources({ ...page, teachingBrief: { ...page.teachingBrief!,
      evidence: [{ sourceId: 'secondary', quote: secondary }, { sourceId: 'primary', quote: primary }] } }, {
      ...input, sourceEvidence: { ...input.sourceEvidence, items: [other, original] },
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [other.id, original.id] }],
    });
    expect(sources.authoritativeAnchors.filter((anchor) => anchor.sourceDefinitionKey)).toEqual([
      { id: 'source-definition-1', text: secondary, sourceDefinitionKey: JSON.stringify(['other-book-v1', secondary]) },
      { id: 'source-definition-2', text: primary, sourceDefinitionKey: JSON.stringify(['book-v1', primary]) },
    ]);
    expect(sources.originalQuotes).toEqual([secondary, primary]);
    expect(sources.originalSources.map((source) => source.evidenceId)).toEqual([original.id, other.id]);
    expect(sources.authoritativeAnchors.find((anchor) => anchor.id === 'source-quote-1')?.text).toBe(secondary);
  });

  it('retains an actually adopted secondary definition when primary passages contain no quoted definition', () => {
    const sentence = '随机抽样是指通过随机规则选择研究对象的一种抽样方法。';
    const { page, input } = verified(sentence, 'secondary-v1');
    const primary = sourceEvidence.items[0]!;
    const sources = pageOriginalTeachingSources(page, { ...input,
      sourceEvidence: { ...input.sourceEvidence, items: [...input.sourceEvidence.items, { ...primary, id: 'primary-evidence' }] },
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: ['sampling-original', 'primary-evidence'] }],
    });
    expect(sources.originalQuotes).toEqual([sentence]);
    expect(sources.authoritativeAnchors.filter((anchor) => anchor.sourceDefinitionKey)).toEqual([
      { id: 'source-definition-1', text: sentence, sourceDefinitionKey: JSON.stringify(['secondary-v1', sentence]) },
    ]);
  });

  it('deduplicates the same original definition across evidence and pages without mixing different adopted book revisions', () => {
    const sentence = '随机抽样是指每个个体具有明确被抽取机会的抽样方法。';
    const { page, input } = verified(sentence);
    const item = input.sourceEvidence.items[0]!;
    const duplicate = { ...item, id: 'duplicate-evidence' };
    const otherBook = { ...item, id: 'other-book', source: { ...item.source, revisionId: 'other-book-v1', textbookId: 'other-book' } };
    const shared = { ...input, sourceEvidence: { ...input.sourceEvidence, selections: [], items: [item, duplicate, otherBook] },
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [item.id, duplicate.id, otherBook.id] }] };
    const first = pageOriginalTeachingSources(page, shared);
    const second = pageOriginalTeachingSources({ ...page, id: 'next-page' }, shared);
    expect(first.authoritativeAnchors.filter((anchor) => anchor.sourceDefinitionKey)).toEqual([
      { id: 'source-definition-1', text: sentence, sourceDefinitionKey: JSON.stringify(['book-v1', sentence]) },
      { id: 'source-definition-2', text: sentence, sourceDefinitionKey: JSON.stringify(['other-book-v1', sentence]) },
    ]);
    expect(second.authoritativeAnchors).toEqual(first.authoritativeAnchors);
  });

  it('excludes definitions from source candidates the teacher did not adopt, including explicit empty adoption', () => {
    const sentence = '随机抽样是指每个个体具有明确被抽取机会的抽样方法。';
    const { page, input } = verified(sentence);
    const evidence = { ...input.sourceEvidence, mappings: [{ sourceKnowledgePointId: 'lesson-sampling',
      sourceKnowledgePointName: '随机抽样', status: 'direct' as const, evidenceItemIds: ['sampling-original'], rationale: '仅候选' }] };
    const declined = pageOriginalTeachingSources(page, { sourceEvidence: evidence,
      sourceKnowledgePoints: [{ id: 'lesson-sampling', evidenceItemIds: [] }] });
    expect(declined.originalSources).toEqual([]);
    expect(declined.authoritativeAnchors).toEqual([]);
  });
});
