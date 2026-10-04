import { describe, expect, it } from 'vitest';
import { authoringEvidenceBlocks, buildAuthoringExcerptCatalog, normalizeAuthoringSourceBindings,
  normalizeKnowledgeAuthoring, resolveAuthoringAuthoritativeExcerpt, type AuthoringExcerptRef } from './knowledge-authoring';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';

const firstCase = '青蛙告诉小鱼，牛有四条腿，头上有角。';
const secondCase = '小鱼想象出来的牛仍有鱼的身体，只是添了腿和角。';
const definition = '学习者结合已有经验主动建构对新信息的理解。';
const evidence: CourseEvidenceSnapshot = {
  schemaVersion: 2, version: 1, fingerprint: 'source', createdAt: '2026-10-02',
  retrievalMode: 'hybrid', selections: [{ revisionId: 'revision', primary: true, sectionIds: [] }],
  mappings: [], warnings: [], items: [{
    id: 'theory', kind: 'concept', title: '建构主义', content: '索引摘要不作为原文',
    source: { textbookId: 'book', textbookTitle: '学习理论', revisionId: 'revision', revisionVersion: 1,
      sectionId: 'topic', sectionPath: ['建构主义'], sourceBlockId: 'definition', sourceBlockPosition: 10, quote: definition },
    completeSourceBlocks: [
      { sourceBlockId: 'first', content: firstCase, source: {
        textbookId: 'book', textbookTitle: '学习理论', revisionId: 'revision', revisionVersion: 1,
        sectionId: 'topic', sectionPath: ['建构主义'], sourceBlockPosition: 11 } },
      { sourceBlockId: 'second', content: secondCase, source: {
        textbookId: 'book', textbookTitle: '学习理论', revisionId: 'revision', revisionVersion: 1,
        sectionId: 'topic', sectionPath: ['建构主义'], sourceBlockPosition: 12 } },
    ],
    sourceContext: { policyVersion: 1, status: 'complete', sectionId: 'topic', sourceBlockIds: ['definition', 'first', 'second'] },
  }],
};

const binding = (quote = definition, sourceBlockIds = ['definition']) => ({
  evidenceItemId: 'theory', sourceBlockIds, quote, textbookId: 'forged-book', revisionId: 'forged-revision',
});

function wholeRef(snapshot: CourseEvidenceSnapshot, sourceBlockId: string, evidenceItemId = 'theory'): AuthoringExcerptRef {
  const block = buildAuthoringExcerptCatalog(snapshot).evidenceItems
    .find((item) => item.evidenceItemId === evidenceItemId)!.blocks.find((item) => item.sourceBlockId === sourceBlockId)!;
  return { evidenceItemId, sourceBlockId, excerptId: block.wholeBlockExcerptId };
}

describe('first-generation knowledge authoring provenance', () => {
  it('records related original applications before declaring one retrieved item completely read', () => {
    const original = '监测记录可以用于冷库温度预警和运输箱温度核对。';
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: '监测是按约定间隔取得读数并保存记录的过程。' },
      completeSourceBlocks: [{ sourceBlockId: 'applications', content: original,
        source: { ...evidence.items[0]!.source, sectionId: 'related', sourceBlockPosition: 9, quote: undefined } }],
      sourceContext: { policyVersion: 1, status: 'complete', sourceBlockIds: ['definition', 'applications'] } }] };
    const ref = wholeRef(snapshot, 'applications');
    const claims = [{ id: 'monitor', kind: 'textbook', excerptRefs: [wholeRef(snapshot, 'definition')],
      authoritativeExcerpts: [], logicalConditions: [] }];
    const examples = ['cold-storage', 'transport'].map((id) => ({ id, kind: 'textbook', title: id,
      factRefs: [ref], claimIds: ['monitor'] }));
    const coverage = { revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'],
      sourceReadings: [{ blockRef: wholeRef(snapshot, 'definition'), findings: [] }] };
    const partial = normalizeKnowledgeAuthoring({ claims, examples, exampleCoverage: [coverage] }, snapshot,
      ['theory'], { readingContract: 'source-blocks-v1' });
    expect(partial?.readingContract).toBe('source-blocks-v1');
    expect(partial?.exampleCoverage[0]?.status).toBe('partial');
    expect(partial?.diagnostics?.join('\n')).toContain('尚缺完整原文块的案例阅读记录：applications');
    expect(partial?.examples.map((example) => example.facts)).toEqual([[original], [original]]);
    const finding = { excerptRefs: [ref], kind: 'application', disposition: 'candidate',
      exampleIds: ['cold-storage', 'transport'], claimIds: ['monitor'], role: 'application' };
    const complete = normalizeKnowledgeAuthoring({ claims, examples, exampleCoverage: [{ ...coverage,
      sourceReadings: [...coverage.sourceReadings, { blockRef: ref, findings: [finding] }] }] }, snapshot,
    ['theory'], { readingContract: 'source-blocks-v1' });
    expect(complete?.exampleCoverage[0]).toMatchObject({ textbookId: 'book', status: 'complete',
      sourceReadings: [{ findings: [] }, { blockRef: ref, findings: [finding] }] });
    expect(complete?.diagnostics).toBeUndefined();
    expect(complete?.claims).toHaveLength(1);
    expect(JSON.stringify(complete?.exampleCoverage)).not.toContain(original);
    expect(normalizeKnowledgeAuthoring(complete, snapshot, ['theory'])).toEqual(complete);
  });

  it('does not relabel a saved v7 complete coverage when it has no block-reading contract', () => {
    const raw = { claims: [{ id: 'saved', kind: 'derived', text: '旧稿范围说明。',
      teachingScope: '旧稿的生成范围', conditions: '旧稿条件文字' }],
    exampleCoverage: [{ revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'] }] };
    const saved = normalizeKnowledgeAuthoring(raw, evidence, ['theory']);
    expect(saved).not.toHaveProperty('readingContract');
    expect(saved?.claims[0]).toMatchObject({ teachingScope: '旧稿的生成范围', conditions: '旧稿条件文字' });
    expect(saved?.exampleCoverage[0]).toMatchObject({ status: 'complete' });
    expect(saved?.exampleCoverage[0]).not.toHaveProperty('sourceReadings');
    const fresh = normalizeKnowledgeAuthoring(raw, evidence, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(fresh?.exampleCoverage[0]).toMatchObject({ status: 'partial', sourceReadings: [] });
    expect(fresh?.claims[0]).not.toHaveProperty('teachingScope');
    expect(fresh?.claims[0]).not.toHaveProperty('conditions');
    expect(fresh?.claims[0]?.text).toBe('旧稿范围说明。');
  });

  it('keeps an explicit new reading contract without textbook evidence or a fabricated coverage', () => {
    const result = normalizeKnowledgeAuthoring({ claims: [], examples: [], exampleCoverage: [] }, undefined,
      undefined, { readingContract: 'source-blocks-v1' });
    expect(result).toEqual({ readingContract: 'source-blocks-v1', claims: [], examples: [], exampleCoverage: [] });
    expect(normalizeKnowledgeAuthoring(result)).toEqual(result);
    expect(normalizeKnowledgeAuthoring({ claims: [] })).not.toHaveProperty('readingContract');
  });

  it('does not downgrade condition identity when a marked reading contract omits quote-duty metadata', () => {
    const original = '在标签存在或已有记录时，可以核对读数。';
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: original } }] };
    const result = normalizeKnowledgeAuthoring({ readingContract: 'source-blocks-v1', claims: [{
      id: 'meaning', kind: 'textbook', excerptRefs: [wholeRef(snapshot, 'definition')],
      logicalConditions: ['在标签存在或已有记录时', '所有读数必须一直有效'],
    }] }, snapshot, ['theory']);
    expect(result?.claims[0]).toMatchObject({ kind: 'textbook', text: original, authoritativeExcerpts: [],
      logicalConditions: ['在标签存在或已有记录时'] });
    expect(result?.diagnostics?.join('\n')).toContain('不回退为默认逐字朗读');
    expect(result?.diagnostics?.join('\n')).toContain('不将生成概括当作教材必要条件');
    expect(normalizeKnowledgeAuthoring(result, snapshot, ['theory'])).toEqual(result);
  });

  it('requires immutable whole-block addresses instead of one readable sentence or generated content', () => {
    const original = '记录以时间和读数成对保存。温度记录用于观察变化。';
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: original }, completeSourceBlocks: [],
      sourceContext: { policyVersion: 1, status: 'complete', sourceBlockIds: ['definition'] } }] };
    const catalog = buildAuthoringExcerptCatalog(snapshot);
    const sentenceRef = { ...wholeRef(snapshot, 'definition'), excerptId: catalog.sourceBlocks[0]!.excerpts[0]!.excerptId };
    const raw = { exampleCoverage: [{ revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'],
      sourceReadings: [{ blockRef: sentenceRef, findings: [] },
        { blockRef: { ...sentenceRef, sourceBlockId: 'invented-summary' }, findings: [] }] }] };
    const result = normalizeKnowledgeAuthoring(raw, snapshot, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]).toMatchObject({ status: 'partial', sourceReadings: [] });
    expect(result?.diagnostics?.join('\n')).toContain('不将句段阅读当作整段已读');
  });

  it('does not claim partial source context is complete when every available block has a reading', () => {
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      sourceContext: { ...evidence.items[0]!.sourceContext!, status: 'partial' } }] };
    const sourceReadings = ['definition', 'first', 'second'].map((id) => ({ blockRef: wholeRef(snapshot, id), findings: [] }));
    const result = normalizeKnowledgeAuthoring({ exampleCoverage: [{ revisionId: 'revision', status: 'complete',
      evidenceItemIds: ['theory'], sourceReadings }] }, snapshot, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]).toMatchObject({ status: 'partial', sourceReadings });
  });

  it('records a scope decision as references and an enum without adding a candidate or an authority claim', () => {
    const raw = { claims: [], examples: [], exampleCoverage: [{ revisionId: 'revision', status: 'complete',
      evidenceItemIds: ['theory'], sourceReadings: ['definition', 'first', 'second'].map((id) => ({
        blockRef: wholeRef(evidence, id), findings: id === 'first' ? [{ excerptRefs: [wholeRef(evidence, id)],
          kind: 'case', disposition: 'outside-scope', exampleIds: [], claimIds: [], role: 'illustration' }] : [],
      })) }] };
    const result = normalizeKnowledgeAuthoring(raw, evidence, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]?.status).toBe('complete');
    expect(result?.examples).toEqual([]);
    expect(result?.claims).toEqual([]);
    expect(result?.diagnostics).toBeUndefined();
  });

  it('diagnoses a forged candidate/claim identity without constructing a replacement case', () => {
    const raw = { examples: [{ id: 'new-story', kind: 'constructed', title: '自编对象', objectAndTask: '本次观察一个对象。' }],
      exampleCoverage: [{ revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'],
        sourceReadings: ['definition', 'first', 'second'].map((id) => ({ blockRef: wholeRef(evidence, id),
          findings: id === 'first' ? [{ excerptRefs: [wholeRef(evidence, 'first')], kind: 'case', disposition: 'candidate',
            exampleIds: ['new-story', 'missing'], claimIds: ['outside'], role: 'difficulty' }] : [] })) }] };
    const result = normalizeKnowledgeAuthoring(raw, evidence, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]?.status).toBe('partial');
    expect(result?.examples.map((example) => [example.id, example.kind])).toEqual([['new-story', 'constructed']]);
    expect(result?.diagnostics?.join('\n')).toContain('不自动补写');
    expect(result?.exampleCoverage[0]?.sourceReadings?.[1]?.findings[0]).toMatchObject({ exampleIds: [], claimIds: [] });
    expect(normalizeKnowledgeAuthoring(result, evidence, ['theory'])).toEqual(result);
  });

  it('deduplicates shared original blocks while requiring all actual evidence identities to be covered', () => {
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [evidence.items[0]!, { ...evidence.items[0]!, id: 'alias' }] };
    const sourceReadings = ['theory', 'alias'].flatMap((item) => ['definition', 'first', 'second']
      .map((block) => ({ blockRef: wholeRef(snapshot, block, item), findings: [] })));
    const result = normalizeKnowledgeAuthoring({ exampleCoverage: [{ revisionId: 'revision', status: 'complete',
      evidenceItemIds: ['theory', 'alias'], sourceReadings }] }, snapshot, ['theory', 'alias'],
    { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]?.status).toBe('complete');
    expect(result?.exampleCoverage[0]?.sourceReadings).toHaveLength(3);
    expect(result?.diagnostics).toBeUndefined();
  });

  it('does not bind one case to a different sentence merely because both are in the same original block', () => {
    const original = '冷库的温度记录帮助追踪升温过程。运输箱的温度记录帮助核对配送条件。';
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: original }, completeSourceBlocks: [],
      sourceContext: { policyVersion: 1, status: 'complete', sourceBlockIds: ['definition'] } }] };
    const sentences = buildAuthoringExcerptCatalog(snapshot).sourceBlocks[0]!.excerpts;
    const refs = sentences.map((sentence) => ({ evidenceItemId: 'theory', sourceBlockId: 'definition', excerptId: sentence.excerptId }));
    const result = normalizeKnowledgeAuthoring({ examples: [{ id: 'transport', kind: 'textbook', title: '运输记录', factRefs: [refs[1]] }],
      exampleCoverage: [{ revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'], sourceReadings: [{
        blockRef: wholeRef(snapshot, 'definition'), findings: [{ excerptRefs: [refs[0]], kind: 'application', disposition: 'candidate',
          exampleIds: ['transport'], claimIds: [], role: 'application' }],
      }] }] }, snapshot, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]?.status).toBe('partial');
    expect(result?.examples[0]).toMatchObject({ id: 'transport', kind: 'textbook', facts: [sentences[1]!.text] });
    expect(result?.diagnostics?.join('\n')).toContain('未绑定对应教材事实的案例：transport');
  });

  it('does not use generated item content as an original block for complete reading coverage', () => {
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, sourceBlockId: undefined, quote: undefined },
      completeSourceBlocks: [], sourceContext: { policyVersion: 1, status: 'complete', sourceBlockIds: [] } }] };
    const result = normalizeKnowledgeAuthoring({ exampleCoverage: [{ revisionId: 'revision', status: 'complete',
      evidenceItemIds: ['theory'], sourceReadings: [] }] }, snapshot, ['theory'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage[0]?.status).toBe('partial');
    expect(result?.diagnostics?.join('\n')).toContain('索引概括不能代替案例阅读记录');
  });

  it('keeps two books and their application readings separate even when their block IDs happen to match', () => {
    const auxiliary = { ...evidence.items[0]!, id: 'auxiliary',
      source: { ...evidence.items[0]!.source, textbookId: 'other-book', revisionId: 'other-revision' },
      completeSourceBlocks: evidence.items[0]!.completeSourceBlocks!.map((block) => ({ ...block,
        source: { ...block.source!, textbookId: 'other-book', revisionId: 'other-revision' } })) };
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [evidence.items[0]!, auxiliary] };
    const result = normalizeKnowledgeAuthoring({ examples: ['theory', 'auxiliary'].map((item) => ({
      id: `case-${item}`, kind: 'textbook', title: '对应案例', factRefs: [wholeRef(snapshot, 'first', item)],
    })), exampleCoverage: [['theory', 'revision'], ['auxiliary', 'other-revision']].map(([item, revisionId]) => ({
      revisionId, status: 'complete', evidenceItemIds: [item], sourceReadings: ['definition', 'first', 'second'].map((block) => ({
        blockRef: wholeRef(snapshot, block, item), findings: block === 'first' ? [{
          excerptRefs: [wholeRef(snapshot, block, item)], kind: 'case', disposition: 'candidate',
          exampleIds: [`case-${item}`], claimIds: [], role: 'illustration',
        }] : [],
      })),
    })) }, snapshot, ['theory', 'auxiliary'], { readingContract: 'source-blocks-v1' });
    expect(result?.exampleCoverage.map(({ textbookId, revisionId, status, sourceReadings }) =>
      [textbookId, revisionId, status, sourceReadings?.length]))
      .toEqual([['book', 'revision', 'complete', 3], ['other-book', 'other-revision', 'complete', 3]]);
    expect(result?.examples.map((example) => example.sources[0]?.revisionId)).toEqual(['revision', 'other-revision']);
    expect(result?.diagnostics).toBeUndefined();
    expect(normalizeKnowledgeAuthoring(result, snapshot, ['theory', 'auxiliary'])).toEqual(result);
  });

  it('binds reading duties to eligible original spans without promoting ordinary explanations in the same claim', () => {
    const statements = ['分类是按已给属性分组的操作。', '标签有助于记录分组结果。',
      '只有取得有效读数，才可执行本次操作。', '操作员应按此装置的操作规程记录结果。'];
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: statements.join('') } }] };
    const catalog = buildAuthoringExcerptCatalog(snapshot);
    const refs = statements.map((statement) => ({ evidenceItemId: 'theory', sourceBlockId: 'definition',
      excerptId: catalog.sourceBlocks.find((block) => block.sourceBlockId === 'definition')!
        .excerpts.find((excerpt) => excerpt.text === statement)!.excerptId }));
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'mixed', kind: 'textbook', excerptRefs: refs,
      authoritativeExcerpts: [
        { excerptRef: refs[0], role: 'definition' }, { excerptRef: refs[2], role: 'strict-condition' },
        { excerptRef: refs[3], role: 'normative-statement' },
        { excerptRef: refs[1], role: 'supporting-explanation' },
      ] }] }, snapshot, ['theory']);
    const claim = result!.claims[0]!;
    expect(claim.text).toBe(statements.join('\n'));
    expect(claim.authoritativeExcerpts).toEqual([
      { excerptRef: refs[0], role: 'definition' }, { excerptRef: refs[2], role: 'strict-condition' },
      { excerptRef: refs[3], role: 'normative-statement' },
    ]);
    expect(resolveAuthoringAuthoritativeExcerpt(claim, refs[0]!, snapshot, ['theory'])).toEqual({
      excerptRef: refs[0], role: 'definition', source: {
        evidenceItemId: 'theory', sourceBlockIds: ['definition'], quote: statements[0],
        textbookId: 'book', revisionId: 'revision',
      },
    });
    expect(resolveAuthoringAuthoritativeExcerpt(claim, refs[1]!, snapshot, ['theory'])).toBeUndefined();
    expect(resolveAuthoringAuthoritativeExcerpt(claim, refs[0]!, snapshot, [])).toBeUndefined();
    expect(resolveAuthoringAuthoritativeExcerpt(claim, refs[0]!)).toBeUndefined();
    const changed: CourseEvidenceSnapshot = { ...snapshot, items: [{ ...snapshot.items[0]!,
      source: { ...snapshot.items[0]!.source, revisionId: 'new-revision' } }] };
    expect(resolveAuthoringAuthoritativeExcerpt(claim, refs[0]!, changed, ['theory'])).toBeUndefined();
    expect(normalizeKnowledgeAuthoring(result, snapshot, ['theory'])).toEqual(result);
  });

  it('keeps quote eligibility local to a complete textbook claim and preserves old absent declarations', () => {
    const definitionRef = wholeRef(evidence, 'definition'), storyRef = wholeRef(evidence, 'first');
    const result = normalizeKnowledgeAuthoring({ claims: [
      { id: 'owned', kind: 'textbook', excerptRefs: [definitionRef], authoritativeExcerpts: [
        { excerptRef: storyRef, role: 'definition' }, { excerptRef: definitionRef, role: 'definition' },
        { excerptRef: definitionRef, role: 'definition' }, { excerptRef: definitionRef, role: 'normative-statement' },
      ] },
      { id: 'derived', kind: 'derived', excerptRefs: [storyRef], authoritativeExcerpts: [
        { excerptRef: storyRef, role: 'strict-condition' },
      ] },
      { id: 'ordinary', kind: 'textbook', excerptRefs: [definitionRef], authoritativeExcerpts: [] },
      { id: 'legacy', kind: 'textbook', excerptRefs: [definitionRef] },
    ] }, evidence, ['theory']);
    expect(result?.claims[0]?.authoritativeExcerpts).toEqual([{ excerptRef: definitionRef, role: 'definition' }]);
    expect(result?.claims[1]).toMatchObject({ kind: 'derived', text: firstCase, authoritativeExcerpts: [] });
    expect(result?.claims[2]?.authoritativeExcerpts).toEqual([]);
    expect(result?.claims[3]).not.toHaveProperty('authoritativeExcerpts');
    expect(result?.diagnostics?.join('\n')).toContain('不属于本条已绑定教材原文');
    expect(result?.diagnostics?.join('\n')).toContain('声明了不同引用职责');
    expect(normalizeKnowledgeAuthoring(result, evidence, ['theory'])).toEqual(result);
  });

  it('keeps an original disjunction as one condition and records unbound modern summaries without altering legacy conditions', () => {
    const statement = '在电源接通或备用电源启用时，可以读取显示数值。';
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: statement } }] };
    const ref = wholeRef(snapshot, 'definition');
    const raw = { id: 'read', kind: 'textbook', excerptRefs: [ref], conditions: '只有两个电源同时接通才可读数。',
      logicalConditions: ['电源接通或备用电源启用', '两个电源必须同时接通'] };
    const result = normalizeKnowledgeAuthoring({ claims: [{ ...raw, authoritativeExcerpts: [] }] }, snapshot);
    expect(result?.claims[0]).toMatchObject({ text: statement, authoritativeExcerpts: [],
      logicalConditions: ['电源接通或备用电源启用'] });
    expect(result?.diagnostics?.join('\n')).toContain('不将生成概括当作教材必要条件');
    expect(result?.claims[0]).not.toHaveProperty('conditions');
    expect(normalizeKnowledgeAuthoring(result, snapshot)).toEqual(result);
    const legacy = normalizeKnowledgeAuthoring({ claims: [raw] }, snapshot);
    expect(legacy?.claims[0]?.logicalConditions).toEqual(raw.logicalConditions);
    expect(legacy?.claims[0]?.conditions).toEqual(raw.conditions);
    expect(legacy?.claims[0]).not.toHaveProperty('authoritativeExcerpts');
  });

  it('keeps only referenced ability actions without turning free capability answers into assertions', () => {
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'effect', kind: 'textbook',
      excerptRefs: [wholeRef(evidence, 'definition')] }], learningTasks: [
      { claimIds: ['effect', 'effect'], operation: 'explain', capability: '只有某方法才能理解新信息。' },
      { claimIds: ['another-point', 'effect'], operation: 'compare' },
      { claimIds: [], operation: 'apply' },
      { claimIds: ['effect'], operation: 'prove-the-only-answer' },
    ] }, evidence, ['theory']);
    expect(result?.learningTasks).toEqual([
      { claimIds: ['effect'], operation: 'explain' },
      { claimIds: ['effect'], operation: 'compare' },
      { claimIds: [], operation: 'apply' },
    ]);
    expect(result?.claims[0]).toMatchObject({ kind: 'textbook', text: definition });
    expect(JSON.stringify(result)).not.toContain('只有某方法才能');
    expect(result?.diagnostics?.join('\n')).toContain('不存在或不能自证的本知识点陈述');
    expect(result?.diagnostics?.join('\n')).toContain('保留能力意图与来源缺口');
    expect(result?.diagnostics?.join('\n')).toContain('未选择有效能力动作');
    expect(normalizeKnowledgeAuthoring(result, evidence, ['theory'])).toEqual(result);
    expect(normalizeKnowledgeAuthoring({ claims: [{ id: 'legacy', kind: 'derived', text: '已有教学解释。' }] }))
      .not.toHaveProperty('learningTasks');
  });

  it('carries an analogy limit separately from its actual narrow correspondence and preserves concrete premises', () => {
    const statement = '多种成分的比例共同影响混合物的性质。分子间作用力参与其形成过程。';
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: statement } }] };
    const limitations = '纸片只展示多种成分及其比例，不展示混合物的性质、分子间作用力或化学反应。';
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'mixture', kind: 'textbook',
      excerptRefs: [wholeRef(snapshot, 'definition')] }],
      learningTasks: [{ claimIds: ['mixture'], operation: 'explain' }], examples: [{
        id: 'tiles', kind: 'constructed', form: 'analogy', objectAndTask: '用三片纸片观察组成比例。',
        assumptions: ['本次取两片红纸和一片蓝纸，仅把纸片作为成分标记'],
        actions: ['把三片纸片并排摆放', '数出红纸与蓝纸的数量'], outcome: '本次红蓝纸片的比例为二比一。',
        limitations, correspondences: [{ claimId: 'mixture', claimPhrase: '多种成分的比例',
          caseElement: { field: 'outcome' } }],
      }] }, snapshot, ['theory']);
    expect(result?.examples[0]).toMatchObject({ purpose: '', explanation: '', limitations,
      assumptions: ['本次取两片红纸和一片蓝纸，仅把纸片作为成分标记'],
      correspondences: [{ claimId: 'mixture', claimPhrase: '多种成分的比例', caseElement: { field: 'outcome' } }] });
    expect(result?.claims[0]?.text).toBe(statement);
    expect(result?.learningTasks).toEqual([{ claimIds: ['mixture'], operation: 'explain' }]);
    expect(normalizeKnowledgeAuthoring(result, snapshot, ['theory'])).toEqual(result);
  });

  it('retains a source application and its limited effect when generated copies assert an unconditional result', () => {
    const statement = '在适用配方和温度条件下，催化剂通常有利于加快反应。';
    const events = ['在一次配料试验中，操作者先确认原料配方和当前温度。',
      '若温度处于指定范围，再向这份原料加入规定量的催化剂。',
      '本次观察到这份原料较早达到设定的反应终点。'];
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: statement },
      completeSourceBlocks: events.map((content, index) => ({ sourceBlockId: `trial-${index}`, content,
        source: { ...evidence.items[0]!.source, sourceBlockId: `trial-${index}`, sourceBlockPosition: 11 + index, quote: undefined } })),
    }] };
    const claimRef = wholeRef(snapshot, 'definition');
    const factRefs = events.map((_event, index) => wholeRef(snapshot, `trial-${index}`));
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'effect', kind: 'textbook',
      excerptRefs: [claimRef], text: '催化剂总能使所有反应更快。', logicalConditions: [] }],
      examples: [{ id: 'trial', kind: 'textbook', title: '一次配料试验', purpose: '说明指定条件下的应用',
        factRefs, facts: ['所有温度下加入催化剂都立即结束反应。'],
        correspondences: [{ claimId: 'effect', claimPhrase: '通常有利于加快反应', caseElement: { field: 'facts', index: 2 } }] }],
    }, snapshot, ['theory']);
    expect(result?.claims[0]?.text).toBe(statement);
    expect(result?.claims[0]?.logicalConditions).toEqual([]);
    expect(result?.examples[0]).toMatchObject({ kind: 'textbook', facts: events, factRefs, explanation: '' });
    expect(result?.examples[0]?.sources.map((binding) => binding.quote)).toEqual(events);
    expect(result?.examples[0]?.sources.every((binding) => binding.textbookId === 'book' && binding.revisionId === 'revision')).toBe(true);
    expect(result?.diagnostics?.join('\n')).toContain('不可变原文');
    expect(normalizeKnowledgeAuthoring(result, snapshot, ['theory'])).toEqual(result);
  });

  it('binds a concrete demonstration to an actual claim phrase without generating a second explanation or removing its conditions', () => {
    const claimText = '在读数有效且比较完成的条件下，控制器按本次设定更新输出。';
    const logicalConditions = ['读数有效', '比较已经完成'];
    const objectAndTask = '操作员要让一台已配置的控制器按目标值更新输出。';
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'update', kind: 'derived', text: claimText,
      logicalConditions, teachingScope: '只观察这台已配置的装置', sources: [] }], examples: [{
      id: 'controller', kind: 'constructed', title: '一次输出更新', purpose: '演示先取得有效读数再完成比较的做法',
      objectAndTask, assumptions: ['目标值已经设定'], actions: ['补齐读数', '把有效读数与目标值比较'],
      outcome: '本次输出按设定更新。', correspondences: [
        { claimId: 'update', claimPhrase: '读数有效', caseElement: { field: 'actions', index: 0 } },
        { claimId: 'update', claimPhrase: '比较完成', caseElement: { field: 'actions', index: 1 } },
        { claimId: 'update', claimPhrase: '按本次设定更新输出', caseElement: { field: 'outcome' } },
      ],
    }] });
    expect(result?.claims[0]).toMatchObject({ text: claimText, logicalConditions,
      teachingScope: '只观察这台已配置的装置' });
    expect(result?.examples[0]).toMatchObject({ objectAndTask, explanation: '',
      correspondences: [
        { claimId: 'update', claimPhrase: '读数有效', caseElement: { field: 'actions', index: 0 } },
        { claimId: 'update', claimPhrase: '比较完成', caseElement: { field: 'actions', index: 1 } },
        { claimId: 'update', claimPhrase: '按本次设定更新输出', caseElement: { field: 'outcome' } },
      ] });
    expect(result?.examples[0]?.claimIds).toBeUndefined();
    expect(result?.examples[0]?.conceptMapping).toBeUndefined();
    expect(result?.diagnostics).toBeUndefined();
    expect(normalizeKnowledgeAuthoring(result)).toEqual(result);
  });

  it('expands a conditional source case and binds typography-only phrase variants to the real statement and version', () => {
    const statement = '在“读数有效”的条件下，控制器把读数与目标值比较后更新输出。';
    const facts = ['试验员先输入一个空读数，控制器未更新输出。', '试验员补齐有效读数，控制器比较后更新输出。'];
    const snapshot: CourseEvidenceSnapshot = { ...evidence, items: [{ ...evidence.items[0]!,
      source: { ...evidence.items[0]!.source, quote: statement },
      completeSourceBlocks: facts.map((content, index) => ({ sourceBlockId: `reading-${index}`, content,
        source: { ...evidence.items[0]!.source, sourceBlockId: `reading-${index}`, sourceBlockPosition: 11 + index, quote: undefined } })),
    }] };
    const corr = { claimId: 'update', claimPhrase: '在"读数有效"的条件下', caseElement: { field: 'facts', index: 1 } };
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'update', kind: 'textbook',
      excerptRefs: [wholeRef(snapshot, 'definition')], logicalConditions: ['读数有效'] }], examples: [{
      id: 'controller', kind: 'textbook', title: '两次读数输入', purpose: '比较困难与补齐读数后的结果',
      factRefs: [wholeRef(snapshot, 'reading-0'), wholeRef(snapshot, 'reading-1')],
      correspondences: [corr],
    }] }, snapshot, ['theory']);
    expect(result?.claims[0]?.text).toBe(statement);
    expect(result?.examples[0]).toMatchObject({ kind: 'textbook', facts, explanation: '',
      correspondences: [{ ...corr, claimPhrase: '在“读数有效”的条件下' }] });
    expect(result?.examples[0]?.sources.map((source) => [source.textbookId, source.revisionId]))
      .toEqual([['book', 'revision'], ['book', 'revision']]);
    expect(normalizeKnowledgeAuthoring(result, snapshot, ['theory'])).toEqual(result);
  });

  it('retains usable first-pass cases while diagnosing invalid claim phrases and nonexistent or misaddressed case elements', () => {
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'rule', kind: 'derived',
      text: '按本次规则比较输入后输出位置。', sources: [] }], examples: [{ id: 'sorter', kind: 'constructed',
      title: '分拣观察', actions: ['输入物体'], assumptions: ['已设定规则'], outcome: '物体进入指定位置。',
      correspondences: [
        { claimId: 'outside-point', claimPhrase: '比较输入', caseElement: { field: 'actions', index: 0 } },
        { claimId: 'rule', claimPhrase: '所有装置都不能改变规则', caseElement: { field: 'actions', index: 0 } },
        { claimId: 'rule', claimPhrase: '比较输入', caseElement: { field: 'actions', index: 1 } },
        { claimId: 'rule', claimPhrase: '比较输入', caseElement: { field: 'actions', index: -1 } },
        { claimId: 'rule', claimPhrase: '比较输入', caseElement: { field: 'actions', index: '0' } },
        { claimId: 'rule', claimPhrase: '比较输入', caseElement: { field: 'assumptions' } },
        { claimId: 'rule', claimPhrase: '输出位置', caseElement: { field: 'outcome', index: 0 } },
        { claimId: 'rule', claimPhrase: '输出位置', caseElement: { field: 'conceptMapping' } },
        { claimId: 'rule', claimPhrase: '比较输入', caseElement: { field: 'objectAndTask' } },
        { claimId: 'rule', claimPhrase: '比较输入', caseElement: { field: 'facts', index: 0 } },
        { claimId: 'rule', claimPhrase: '输出位置', caseElement: { field: 'outcome' } },
      ] }] });
    expect(result?.examples[0]?.correspondences).toEqual([
      { claimId: 'rule', claimPhrase: '输出位置', caseElement: { field: 'outcome' } },
    ]);
    expect(result?.examples[0]?.outcome).toBe('物体进入指定位置。');
    expect(result?.claims[0]?.text).toBe('按本次规则比较输入后输出位置。');
    expect(result?.diagnostics).toHaveLength(7);
    expect(result?.diagnostics?.join('\n')).toContain('未指向本知识点真实陈述短语');
  });

  it('remaps addresses through blank filtering and assumption deduplication without collapsing repeated actions', () => {
    const correspondence = (field: string, index: number) => ({ claimId: 'observe', claimPhrase: '观察结果', caseElement: { field, index } });
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'observe', kind: 'derived', text: '观察结果以比较两次操作。' }],
      examples: [{ title: '两次操作', kind: 'constructed', facts: ['第一次结果', '', '第二次结果'],
        assumptions: ['', '相同对象', '相同对象'], actions: ['', '拉动绳子', '观察结果', '拉动绳子'],
        correspondences: [correspondence('facts', 2), correspondence('assumptions', 2), correspondence('actions', 3),
          correspondence('actions', 0), correspondence('facts', 1)] }] });
    expect(result?.examples[0]?.correspondences).toEqual([
      correspondence('facts', 1), correspondence('assumptions', 0), correspondence('actions', 2),
    ]);
    expect(result?.examples[0]?.actions).toEqual(['拉动绳子', '观察结果', '拉动绳子']);
    expect(normalizeKnowledgeAuthoring(result)).toEqual(result);
  });

  it('does not let a rejected original selector silently redirect a fact correspondence to a later event', () => {
    const valid = wholeRef(evidence, 'second');
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'meaning', kind: 'textbook',
      excerptRefs: [wholeRef(evidence, 'definition')] }], examples: [{ id: 'events', kind: 'textbook', title: '观察对象',
      factRefs: [{ ...valid, excerptId: 'not-real' }, valid], correspondences: [
        { claimId: 'meaning', claimPhrase: '已有经验', caseElement: { field: 'facts', index: 0 } },
        { claimId: 'meaning', claimPhrase: '新信息', caseElement: { field: 'facts', index: 1 } },
      ] }] }, evidence, ['theory']);
    expect(result?.examples[0]?.facts).toEqual([secondCase]);
    expect(result?.examples[0]?.correspondences).toEqual([
      { claimId: 'meaning', claimPhrase: '新信息', caseElement: { field: 'facts', index: 0 } },
    ]);
    expect(result?.diagnostics?.join('\n')).toContain('对应关系未指向');
    expect(normalizeKnowledgeAuthoring(result, evidence, ['theory'])?.examples[0]?.correspondences)
      .toEqual(result?.examples[0]?.correspondences);
  });

  it('preserves older explanation bodies and absent correspondence fields when reading saved authoring', () => {
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'rule', kind: 'derived', text: '已保存的解释。' }],
      examples: [{ id: 'legacy', title: '已有例子', kind: 'constructed', facts: ['已有事件'],
        explanation: '已有完整讲解', conceptMapping: '已有对应关系', claimIds: ['rule'] }] });
    expect(result?.examples[0]).toMatchObject({ explanation: '已有完整讲解', conceptMapping: '已有对应关系', claimIds: ['rule'] });
    expect(result?.examples[0]).not.toHaveProperty('correspondences');
    expect(result?.diagnostics).toBeUndefined();
  });

  it('binds authentic cross-paragraph case quotations in immutable order', () => {
    const references = normalizeAuthoringSourceBindings([binding(`${firstCase}\n${secondCase}`, ['second', 'first'])], evidence);
    expect(references).toEqual([{ evidenceItemId: 'theory', sourceBlockIds: ['first', 'second'],
      quote: `${firstCase}\n${secondCase}`, textbookId: 'book', revisionId: 'revision' }]);
  });

  it('rejects invented locations, generated index text, foreign revisions and unadopted evidence', () => {
    expect(normalizeAuthoringSourceBindings([
      binding(definition, ['invented']), binding('索引摘要不作为原文'),
      { ...binding(), evidenceItemId: 'not-adopted' },
    ], evidence, ['theory'])).toEqual([]);
    const foreign = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [{
      sourceBlockId: 'foreign', content: definition, source: {
        ...evidence.items[0]!.source, revisionId: 'another-revision',
      },
    }] }] };
    expect(normalizeAuthoringSourceBindings([binding(definition, ['foreign'])], foreign)).toEqual([]);
  });

  it('does not promote a point-wide summary or generated recommendation into a textbook conclusion', () => {
    const recommendation = '支架式只适合技能初期，抛锚式只适合综合应用阶段。';
    const result = normalizeKnowledgeAuthoring({ claims: [
      { id: 'definition', kind: 'textbook', text: definition, sources: [binding()] },
      { id: 'recommendation', kind: 'textbook', text: recommendation, sources: [binding()] },
      { id: 'unbound', kind: 'textbook', text: definition, sources: [] },
    ] }, evidence, ['theory']);
    expect(result?.claims.map((claim) => claim.kind)).toEqual(['textbook', 'derived', 'derived']);
    expect(result?.claims[1]?.text).toBe(recommendation);
    expect(result?.diagnostics?.join('\n')).toContain('生成解释');
  });

  it('retains every textbook case and its distinct purpose without a numerical quota', () => {
    const result = normalizeKnowledgeAuthoring({ examples: [
      { id: 'cow', kind: 'textbook', title: '小鱼想象牛', purpose: '看到已有经验的影响',
        facts: [firstCase, secondCase], explanation: '小鱼用熟悉形象组织新信息。',
        sources: [binding(`${firstCase}\n${secondCase}`, ['first', 'second'])] },
      { id: 'cow', kind: 'textbook', title: '再次观察后修正认识', purpose: '理解经验变化',
        facts: [secondCase], explanation: '比较想象与观察。', sources: [binding(secondCase, ['second'])] },
    ], exampleCoverage: [{ textbookId: 'forged', revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'] }] }, evidence, ['theory']);
    expect(result?.examples).toHaveLength(2);
    expect(result?.examples.map((example) => example.id)).toEqual(['cow', 'cow-2']);
    expect(result?.examples[0]?.facts).toEqual([firstCase, secondCase]);
    expect(result?.exampleCoverage).toEqual([{ textbookId: 'book', revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'] }]);
  });

  it('keeps books separate and cannot declare a partially available source free of cases', () => {
    const partial: CourseEvidenceSnapshot = { ...evidence, items: [
      evidence.items[0]!, { ...evidence.items[0]!, id: 'aux',
        source: { ...evidence.items[0]!.source, textbookId: 'aux-book', revisionId: 'aux-revision' },
        sourceContext: { policyVersion: 1, status: 'partial', sourceBlockIds: [] },
      },
    ] };
    const result = normalizeKnowledgeAuthoring({ examples: [], exampleCoverage: [
      { revisionId: 'revision', status: 'complete', evidenceItemIds: ['theory'] },
      { revisionId: 'aux-revision', status: 'complete', evidenceItemIds: ['aux'] },
    ] }, partial, ['theory', 'aux']);
    expect(result?.exampleCoverage.map((coverage) => [coverage.textbookId, coverage.status]))
      .toEqual([['book', 'complete'], ['aux-book', 'partial']]);
    expect(result?.diagnostics?.join('\n')).toContain('不能认定已穷尽教材案例');
  });

  it('does not let a nearby definition make a fabricated story a textbook case', () => {
    const fabricated = '某人工智能课堂的学生按老师的代码模板完成了识别模型。';
    const result = normalizeKnowledgeAuthoring({ examples: [
      { id: 'new-story', kind: 'textbook', title: '模型课堂', facts: [fabricated],
        explanation: '用它类比已有经验。', sources: [binding()] },
      { id: 'partial-story', kind: 'textbook', title: '小鱼与无人机', facts: [firstCase, fabricated],
        explanation: '两个事件串讲。', sources: [binding(firstCase, ['first'])] },
    ] }, evidence, ['theory']);
    expect(result?.examples.map((example) => example.kind)).toEqual(['constructed', 'constructed']);
    expect(result?.examples[0]?.facts).toEqual([fabricated]);
    expect(result?.diagnostics?.join('\n')).toContain('事件事实未逐项绑定');
  });

  it('preserves constructed life, domain and analogy choices and supports no-example decisions', () => {
    const examples = ['everyday', 'domain', 'analogy'].map((form) => ({
      id: form, kind: 'constructed', title: form, purpose: '帮助理解', facts: ['具体条件', '行动', '结果'],
      explanation: '说明知识对应关系', form, sources: [],
    }));
    expect(normalizeKnowledgeAuthoring({ examples }, evidence)?.examples.map((example) => example.form))
      .toEqual(['everyday', 'domain', 'analogy']);
    expect(normalizeKnowledgeAuthoring({ examples: [] }, evidence)?.examples).toEqual([]);
    expect(normalizeKnowledgeAuthoring(undefined, evidence)).toBeUndefined();
  });

  it('retains repeated actions in a case instead of collapsing the narrative into a set', () => {
    const facts = ['拉动绳子', '观察物体移动', '拉动绳子', '观察物体移动'];
    const result = normalizeKnowledgeAuthoring({ examples: [{ id: 'repeat', kind: 'constructed',
      title: '连续两次观察', purpose: '观察重复操作', facts, explanation: '比较两次操作的结果。' }] });
    expect(result?.examples[0]?.facts).toEqual(facts);
  });

  it('resolves equivalent quotes and whitespace to the real source without accepting changed facts or numbers', () => {
    const original = '"建构主义"的情境中，\n青蛙告诉小鱼牛有４条腿。测量值为3.5，不能省略条件。';
    const quotedEvidence = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'story', content: original },
    ] }] };
    const supplied = '“建构主义”的情境中， 青蛙告诉小鱼牛有4条腿。测量值为3.5，不能省略条件。';
    const sources = [binding(supplied, ['story'])];
    expect(normalizeAuthoringSourceBindings(sources, quotedEvidence)[0]?.quote).toBe(original);
    const result = normalizeKnowledgeAuthoring({ examples: [{ id: 'story', kind: 'textbook', title: '故事',
      facts: [supplied], sources }] }, quotedEvidence, ['theory']);
    expect(result?.examples[0]?.kind).toBe('textbook');
    for (const changed of [supplied.replace('4条', '5条'), supplied.replace('3.5', '35'), supplied.replace('不能', '能')]) {
      expect(normalizeAuthoringSourceBindings([binding(changed, ['story'])], quotedEvidence)).toEqual([]);
    }
  });

  it('does not classify a substring that drops the source negation as a textbook assertion or event', () => {
    const original = '这不是唯一的方法。图中的牛没有两只角。';
    const negativeEvidence = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'negative', content: original },
    ] }] };
    const sources = [binding(original, ['negative'])];
    const result = normalizeKnowledgeAuthoring({
      claims: [{ id: 'negation-lost', kind: 'textbook', text: '是唯一的方法。', sources }],
      examples: [{ id: 'negation-lost', kind: 'textbook', title: '图中动物', facts: ['有两只角。'], sources }],
    }, negativeEvidence, ['theory']);
    expect(result?.claims[0]?.kind).toBe('derived');
    expect(result?.examples[0]?.kind).toBe('constructed');
  });

  it('preserves actual assertion conditions separately from lesson scope and validates local derivation identity', () => {
    const logicalConditions = ['当事人调用已有分类理解陌生对象'];
    const teachingScope = '本课仅比较初次观察与后续认识变化';
    const result = normalizeKnowledgeAuthoring({ claims: [
      { id: 'interpretation', kind: 'derived', text: '对陌生对象的理解可能受到原有经验影响。',
        logicalConditions, teachingScope, basisClaimIds: ['meaning', 'interpretation', 'outside-claim'],
        sources: [binding()] },
      { id: 'meaning', kind: 'textbook', text: definition, sources: [binding()] },
    ] }, evidence, ['theory']);
    expect(result?.claims[0]).toMatchObject({ kind: 'derived', logicalConditions, teachingScope,
      basisClaimIds: ['meaning'] });
    expect(result?.claims[0]?.sources[0]).toMatchObject({ textbookId: 'book', revisionId: 'revision' });
    expect(result?.claims[1]?.logicalConditions).toBeUndefined();
    expect(result?.diagnostics?.join('\n')).toContain('outside-claim');
    expect(result?.diagnostics?.join('\n')).toContain('不能自证');
  });

  it('uses concrete object, configured task and observations as a constructed case while retaining repeated actions', () => {
    const task = '一台按照已配置类别规则工作的分拣装置，需要把两种指定尺寸的物体分到不同位置。';
    const actions = ['输入第一件物体', '观察分拣位置', '输入第二件物体', '观察分拣位置'];
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'classification', kind: 'derived',
      text: '当前分拣结果依据事先配置的分类规则。', logicalConditions: ['装置执行所配置的尺寸判据'], sources: [] }],
      examples: [{ id: 'sorter', kind: 'constructed', objectAndTask: task,
        assumptions: ['装置已配置两种尺寸判据', '输入物体满足这两个判据之一'], actions,
        outcome: '两件物体分别进入对应位置。',
        conceptMapping: '这次结果说明事先设置的判据怎样决定分类，不说明所有装置都不能修改判据。',
        claimIds: ['classification', 'other-point:classification'], facts: [],
      }],
    });
    expect(result?.examples[0]).toMatchObject({ kind: 'constructed', objectAndTask: task,
      actions, outcome: '两件物体分别进入对应位置。', claimIds: ['classification'], facts: [] });
    expect(result?.examples[0]?.assumptions).toHaveLength(2);
    expect(result?.examples[0]?.conceptMapping).toContain('不说明所有装置');
    expect(result?.diagnostics?.join('\n')).toContain('other-point:classification');
  });

  it('retains textbook fact identity alongside its case-to-claim explanation without making the explanation original text', () => {
    const result = normalizeKnowledgeAuthoring({
      claims: [{ id: 'meaning', kind: 'textbook', text: definition, logicalConditions: [], sources: [binding()] }],
      examples: [{ id: 'fish', kind: 'textbook', title: '小鱼想象牛',
        objectAndTask: '小鱼依据青蛙提供的描述理解陌生动物。', assumptions: ['小鱼已有鱼类形象经验'],
        actions: ['听取描述', '用熟悉形象组织新信息'], outcome: '形成仍带有鱼身体的形象。',
        conceptMapping: '已有形象为理解描述提供了框架。', claimIds: ['meaning'],
        facts: [firstCase, secondCase], sources: [binding(`${firstCase}\n${secondCase}`, ['first', 'second'])],
      }],
    }, evidence, ['theory']);
    expect(result?.examples[0]).toMatchObject({ kind: 'textbook', facts: [firstCase, secondCase], claimIds: ['meaning'] });
    expect(result?.examples[0]?.sources[0]?.quote).toBe(`${firstCase}\n${secondCase}`);
    expect(result?.claims).toHaveLength(1);
    expect(result?.claims[0]?.text).toBe(definition);
    expect(result?.diagnostics).toBeUndefined();
  });

  it('does not reinterpret legacy prose conditions or facts as newly declared logical requirements', () => {
    const legacy = normalizeKnowledgeAuthoring({ claims: [{ id: 'legacy', kind: 'derived',
      text: '一个教学解释', conditions: '本课只讨论这个范围', sources: [] }],
      examples: [{ id: 'legacy-case', kind: 'constructed', title: '已有案例',
        facts: ['已保存的情境', '已保存的行动与结果'], explanation: '已保存的分析', sources: [] }],
    });
    expect(legacy?.claims[0]?.conditions).toBe('本课只讨论这个范围');
    expect(legacy?.claims[0]?.logicalConditions).toBeUndefined();
    expect(legacy?.claims[0]?.teachingScope).toBeUndefined();
    expect(legacy?.claims[0]?.basisClaimIds).toBeUndefined();
    expect(legacy?.examples[0]?.facts).toEqual(['已保存的情境', '已保存的行动与结果']);
    expect(legacy?.examples[0]?.objectAndTask).toBeUndefined();
  });
});

describe('immutable first-generation excerpt selection', () => {
  it('shares position-ordered original blocks and catalog choices while excluding generated index prose and foreign revisions', () => {
    const source = evidence.items[0]!;
    const snapshot = { ...evidence, items: [{ ...source, completeSourceBlocks: [
      ...source.completeSourceBlocks!.toReversed(),
      { sourceBlockId: 'foreign', content: '另一个版本的内容', source: { ...source.source, revisionId: 'foreign' } },
    ] }, { ...source, id: 'alias' }] };
    expect(authoringEvidenceBlocks(snapshot.items[0]!).map((block) => block.id)).toEqual(['definition', 'first', 'second']);
    const catalog = buildAuthoringExcerptCatalog(snapshot);
    expect(catalog.evidenceItems.map((item) => item.evidenceItemId)).toEqual(['theory', 'alias']);
    expect(catalog.sourceBlocks.map((block) => block.sourceBlockId)).toEqual(['definition', 'first', 'second']);
    expect(JSON.stringify(catalog)).not.toContain('索引摘要');
    expect(JSON.stringify(catalog)).not.toContain('另一个版本的内容');
    expect(catalog.sourceBlocks.filter((block) => block.sourceBlockId === 'first')).toHaveLength(1);
    expect(normalizeKnowledgeAuthoring({ claims: [{ id: 'alias-claim', kind: 'textbook',
      excerptRefs: [wholeRef(snapshot, 'definition', 'alias')] }] }, snapshot, ['alias'])?.claims[0]?.sources[0])
      .toMatchObject({ evidenceItemId: 'alias', textbookId: 'book', revisionId: 'revision' });
  });

  it('expands a chosen source claim exactly without accepting a rewritten definition or forged source label', () => {
    const ref = wholeRef(evidence, 'definition');
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'meaning', kind: 'textbook',
      excerptRefs: [ref], text: '教师单向传递知识。', sources: [binding('伪造引用')],
      logicalConditions: [], teachingScope: '本课建立学习观' }] }, evidence, ['theory']);
    expect(result?.claims[0]).toMatchObject({ id: 'meaning', kind: 'textbook', text: definition,
      excerptRefs: [ref], logicalConditions: [], teachingScope: '本课建立学习观' });
    expect(result?.claims[0]?.sources).toEqual([{ evidenceItemId: 'theory', sourceBlockIds: ['definition'],
      quote: definition, textbookId: 'book', revisionId: 'revision' }]);
    expect(result?.diagnostics?.join('\n')).toContain('以所选不可变原文片段为准');
  });

  it('keeps a story spanning noncontiguous blocks as separate exact facts, never a fabricated concatenated quotation', () => {
    const source = evidence.items[0]!;
    const snapshot = { ...evidence, items: [{ ...source, completeSourceBlocks: [
      source.completeSourceBlocks![1]!, { sourceBlockId: 'between', content: '这里解释同化的定义。',
        source: { ...source.source, sourceBlockPosition: 11.5 } }, source.completeSourceBlocks![0]!,
    ] }] };
    const refs = [wholeRef(snapshot, 'first'), wholeRef(snapshot, 'second')];
    const result = normalizeKnowledgeAuthoring({ examples: [{ id: 'cow', kind: 'textbook',
      title: '小鱼理解牛', purpose: '认识原有经验的作用', factRefs: refs,
      explanation: '这说明原有形象会影响新信息的组织。' }] }, snapshot, ['theory']);
    expect(result?.examples[0]).toMatchObject({ kind: 'textbook', facts: [firstCase, secondCase], factRefs: refs });
    expect(result?.examples[0]?.sources.map((source) => source.quote)).toEqual([firstCase, secondCase]);
    expect(result?.examples[0]?.sources.map((source) => source.sourceBlockIds)).toEqual([['first'], ['second']]);
    expect(result?.diagnostics).toBeUndefined();
  });

  it('does not fall back to copied model facts when selected IDs are absent or outside the adopted knowledge scope', () => {
    const ref = wholeRef(evidence, 'first');
    for (const invalid of [{ ...ref, excerptId: 'not-an-option' }, { ...ref, sourceBlockId: 'invented' }, ref]) {
      const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'false', kind: 'textbook',
        text: '小鱼已经亲眼看到真正的牛。', excerptRefs: [invalid], sources: [binding(firstCase, ['first'])] }],
      examples: [{ id: 'false-story', kind: 'textbook', title: '未发生的故事',
        facts: ['小鱼已经亲眼看到真正的牛。'], factRefs: [invalid] }] }, evidence,
      invalid === ref ? [] : ['theory']);
      expect(result?.claims).toEqual([]);
      expect(result?.examples[0]).toMatchObject({ kind: 'constructed', facts: [], factRefs: [], sources: [] });
      expect(result?.diagnostics?.join('\n')).toContain('原文片段引用不存在');
    }
  });

  it('does not create a fabricated event from a nearby definition chosen as a fact reference', () => {
    const fake = '小鱼在陆地上追赶真正的牛。';
    const result = normalizeKnowledgeAuthoring({ examples: [{ id: 'false-story', kind: 'textbook',
      title: '教材片段', facts: [fake], factRefs: [wholeRef(evidence, 'definition')] }] }, evidence, ['theory']);
    expect(result?.examples[0]?.facts).toEqual([definition]);
    expect(JSON.stringify(result?.examples[0]?.sources)).not.toContain(fake);
    expect(result?.diagnostics?.join('\n')).toContain('以逐项所选不可变原文为准');
  });

  it('binds each selected source version and does not merge two books into one textbook event', () => {
    const auxiliary = { ...evidence.items[0]!, id: 'auxiliary', completeSourceBlocks: [],
      source: { ...evidence.items[0]!.source, textbookId: 'another-book', revisionId: 'another-version',
        sourceBlockId: 'another-story', quote: '另一位学习者根据新的观察修正了原有判断。' } };
    const snapshot = { ...evidence, items: [evidence.items[0]!, auxiliary] };
    const result = normalizeKnowledgeAuthoring({ examples: [{ id: 'merged', kind: 'textbook',
      title: '不同来源的事件', factRefs: [wholeRef(snapshot, 'first'), wholeRef(snapshot, 'another-story', 'auxiliary')] }] },
    snapshot, ['theory', 'auxiliary']);
    expect(result?.examples[0]?.kind).toBe('constructed');
    expect(result?.examples[0]?.sources.map((source) => source.revisionId)).toEqual(['revision', 'another-version']);
    expect(result?.diagnostics?.join('\n')).toContain('不作为同一件教材事件');
  });

  it('preserves negation, decimal values, quotation marks, list completeness and repeated selected facts', () => {
    const original = '“精确条件”不能省略，数值是3.5。\n1. 先观察\n2. 再比较\n3. 不满足条件就返回观察。';
    const snapshot = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'sequence', content: original },
    ] }] };
    const ref = wholeRef(snapshot, 'sequence');
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'sequence', kind: 'textbook', excerptRefs: [ref] }],
      examples: [{ id: 'repeated', kind: 'textbook', title: '两次完整流程', factRefs: [ref, ref] }] }, snapshot);
    expect(result?.claims[0]?.text).toBe(original);
    expect(result?.claims[0]?.sources[0]?.quote).toBe(original);
    expect(result?.examples[0]?.facts).toEqual([original, original]);
    const changed = { ...snapshot, items: [{ ...snapshot.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'sequence', content: original.replace('3.5', '4.5') },
    ] }] };
    expect(normalizeKnowledgeAuthoring({ claims: [{ id: 'stale', kind: 'textbook', excerptRefs: [ref] }] }, changed)?.claims).toEqual([]);
  });

  it('uses available exact sentence choices without truncating a negation or requiring extra logical conditions', () => {
    const original = '这不是唯一的方法。只有满足条件时才能进入下一阶段。';
    const snapshot = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'conditional', content: original },
    ] }] };
    const catalog = buildAuthoringExcerptCatalog(snapshot);
    const option = catalog.sourceBlocks.find((block) => block.sourceBlockId === 'conditional')!.excerpts[0]!;
    expect(option.text).toBe('这不是唯一的方法。');
    const ref = { evidenceItemId: 'theory', sourceBlockId: 'conditional', excerptId: option.excerptId };
    const result = normalizeKnowledgeAuthoring({ claims: [{ id: 'not-exclusive', kind: 'textbook',
      excerptRefs: [ref], logicalConditions: [], teachingScope: '本课只介绍一种方法' }] }, snapshot);
    expect(result?.claims[0]).toMatchObject({ text: '这不是唯一的方法。', logicalConditions: [],
      teachingScope: '本课只介绍一种方法' });
    expect(result?.diagnostics).toBeUndefined();
  });
});
