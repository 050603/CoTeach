import { describe, expect, it } from 'vitest';
import { assertNarrationSourceDuties, resolveNarrationSourceParts, type NarrationSourceAuthoringDuty } from './source-narration-authoring';
import { normalizeTeachingNarration } from './teaching-narration';

const source1 = '先让学生熟悉生成式AI的应用场景，把它当作认知工具来使用。';
const source2 = '应根据学生的认知能力调整项目任务的复杂程度。';
const source3 = '在实践的同时引入道德伦理思考。';
const anchors = new Map([
  ['page-1', new Map([['source-list-1-item-1', source1], ['source-list-1-item-2', source2], ['source-list-1-item-3', source3]])],
  ['page-2', new Map([['other-page-definition', '只属于第二页的权威定义。']])],
]);

describe('original-source narration authoring', () => {
  it('retains usable authored speech and quotes with source-quality diagnostics', () => {
    const diagnostics: Array<{ pageId?: string; message: string }> = [];
    const authored = { pageId: 'page-1', segments: [
      { text: '保留模型真实编写的解释和例子。', textParts: [{ sourceRef: 'unknown-source' }] },
      { textParts: [{ sourceRef: 'source-list-1-item-2', quote: '任务需要依据学习者能力调整。' }] },
    ] };
    const resolved = resolveNarrationSourceParts(authored, anchors, undefined, {
      qualityReviewMode: 'diagnostic', onDiagnostic: (message, pageId) => { diagnostics.push({ message, pageId }); },
    }) as { segments: Array<{ text: string }> };
    expect(resolved.segments.map((segment) => segment.text)).toEqual([
      '保留模型真实编写的解释和例子。', '任务需要依据学习者能力调整。',
    ]);
    expect(diagnostics).toHaveLength(2);
    expect(diagnostics.every((diagnostic) => diagnostic.pageId === 'page-1')).toBe(true);
    expect(diagnostics[0].message).toContain('unknown source reference');
    expect(diagnostics[1].message).toContain('selected quote differs');
    expect(() => resolveNarrationSourceParts({ pageId: 'page-1', segments: [{
      textParts: [{ sourceRef: 'unknown-source' }],
    }] }, anchors, undefined, { qualityReviewMode: 'diagnostic' })).toThrow('unknown source reference');
  });

  it('accepts a redundant text field only when it exactly equals the authoritative textParts expansion', () => {
    const authored = { pageId: 'page-1', segments: [{ text: `${source2}原有案例推理保持完整。`,
      textParts: [{ sourceRef: 'source-list-1-item-2' }, { text: '原有案例推理保持完整。' }] }] };
    const duty = [{ text: source2, availableReferences: [{ pageId: 'page-1', sourceRef: 'source-list-1-item-2' }] }];
    expect(() => assertNarrationSourceDuties(authored, duty, undefined, anchors)).not.toThrow();
    expect(resolveNarrationSourceParts(authored, anchors)).toEqual({ pageId: 'page-1', segments: [{
      text: `${source2}原有案例推理保持完整。`,
    }] });
    expect(() => assertNarrationSourceDuties(authored, duty)).toThrow('missing adopted source references');
  });

  it('rejects conflicting speech but retains an exact authored source excerpt for teacher review', () => {
    const duty = [{ text: source2, availableReferences: [{ pageId: 'page-1', sourceRef: 'source-list-1-item-2' }] }];
    const conflicting = { pageId: 'page-1', segments: [{ text: '任务随意难一点也可以。',
      textParts: [{ sourceRef: 'source-list-1-item-2' }] }] };
    expect(() => assertNarrationSourceDuties(conflicting, duty, undefined, anchors)).toThrow('differs from its authoritative expansion');
    expect(() => resolveNarrationSourceParts(conflicting, anchors)).toThrow('differs from its authoritative expansion');
    const cropped = { pageId: 'page-1', segments: [{ text: '调整项目任务的复杂程度',
      textParts: [{ sourceRef: 'source-list-1-item-2', quote: '调整项目任务的复杂程度' }] }] };
    expect(() => assertNarrationSourceDuties(cropped, duty, undefined, anchors)).not.toThrow();
    expect(resolveNarrationSourceParts(cropped, anchors)).toEqual({ pageId: 'page-1', segments: [{ text: '调整项目任务的复杂程度' }] });
  });

  it('compiles a first-call source quote inside the authored natural explanation without rewriting its anchors or semantic IDs', () => {
    const segment = { id: 's1', semanticIds: ['page-1:visible-1'], anchors: [{ quote: source1, occurrence: 0 }],
      textParts: [{ text: '我们先从课堂中能用到的工具谈起。教材强调：' }, { sourceRef: 'source-list-1-item-1' },
        { text: '例如，让学生先用工具比较两种方案，再讨论他们为什么选择其中一种。' }] };
    const authored = { sectionId: 'section-1', pages: [{ pageId: 'page-1', segments: [segment] }] };
    const before = structuredClone(authored);
    const resolved = resolveNarrationSourceParts(authored, anchors) as { pages: Array<{ segments: Array<Record<string, unknown>> }> };
    expect(resolved.pages[0].segments[0]).toEqual({ id: segment.id, semanticIds: segment.semanticIds, anchors: segment.anchors,
      text: `我们先从课堂中能用到的工具谈起。教材强调：${source1}例如，让学生先用工具比较两种方案，再讨论他们为什么选择其中一种。` });
    expect(authored).toEqual(before);
    expect(JSON.stringify(resolved)).not.toContain(source2);
    expect(JSON.stringify(resolved)).not.toContain(source3);
  });

  it('retains authored quote and narration order across segments and pages rather than filling or sorting the source list', () => {
    const authored = { pages: [{ pageId: 'page-1', segments: [
      { id: 's1', textParts: [{ text: '先看任务难度：' }, { sourceRef: 'source-list-1-item-2' }],
        anchors: [{ quote: source2, occurrence: 0 }], semanticIds: ['page-1:visible-2'] },
      { id: 's2', textParts: [{ sourceRef: 'source-list-1-item-1' }, { text: '工具的使用仍需要学生作出判断。' }] },
    ] }, { pageId: 'page-2', segments: [{ id: 's3', textParts: [{ sourceRef: 'other-page-definition' }] }] }] };
    const resolved = resolveNarrationSourceParts(authored, anchors) as { pages: Array<{ pageId: string; segments: Array<{ text: string }> }> };
    expect(resolved.pages.map((page) => page.pageId)).toEqual(['page-1', 'page-2']);
    expect(resolved.pages[0].segments.map((segment) => segment.text)).toEqual([
      `先看任务难度：${source2}`, `${source1}工具的使用仍需要学生作出判断。`,
    ]);
    expect(resolved.pages[1].segments[0].text).toBe('只属于第二页的权威定义。');
    expect(JSON.stringify(resolved)).not.toContain(source3);
  });

  it('returns legacy text-only narration unchanged, without inspecting or replacing its authored wording', () => {
    const legacy = { pageId: 'page-1', segments: [{ id: 's1', text: '保持已经验收的自然讲稿。', semanticIds: [], anchors: [] }] };
    expect(resolveNarrationSourceParts(legacy, anchors)).toBe(legacy);
    const section = { pages: [legacy] };
    expect(resolveNarrationSourceParts(section, anchors)).toBe(section);
    expect(resolveNarrationSourceParts(null, anchors)).toBeNull();
  });

  it('joins a source sentence and authored punctuation without repeating the sentence ending', () => {
    const authored = { pageId: 'page-1', segments: [{ textParts: [
      { sourceRef: 'source-list-1-item-2' }, { text: '。现在用具体任务说明难度如何调整。' },
    ] }] };
    expect(resolveNarrationSourceParts(authored, anchors)).toEqual({ pageId: 'page-1', segments: [{
      text: `${source2}现在用具体任务说明难度如何调整。`,
    }] });
    const legacy = { pageId: 'page-1', segments: [{ text: '已保存的讲稿。。保持原样。' }] };
    expect(resolveNarrationSourceParts(legacy, anchors)).toBe(legacy);
  });

  it('authors an exact defining excerpt within a worked example instead of reading a whole source paragraph', () => {
    const quote = '学生通过解决问题获得知识和技能，并迁移到新的情境中';
    const source = `教师提供自主探索资源。${quote}，促进深层理解。`;
    const scoped = new Map([['page-1', new Map([['source-list-1-item-1-meaning', source]])]]);
    const authored = { pageId: 'page-1', segments: [{ textParts: [{ text: '要理解这一点，关键在于' },
      { sourceRef: 'source-list-1-item-1-meaning', quote },
      { text: '。例如，将小车避障时的判断用于新的校门口提醒装置。' }] }] };
    expect(resolveNarrationSourceParts(authored, scoped)).toEqual({ pageId: 'page-1', segments: [{
      text: `要理解这一点，关键在于${quote}。例如，将小车避障时的判断用于新的校门口提醒装置。`,
    }] });
    for (const invalid of ['学生迁移学习空间', '', '另一本书中的定义']) {
      expect(() => resolveNarrationSourceParts({ pageId: 'page-1', segments: [{ textParts: [{
        sourceRef: 'source-list-1-item-1-meaning', quote: invalid,
      }] }] }, scoped)).toThrow('occur unchanged');
    }
  });

  it('preserves an unchanged source excerpt without a content-completeness interruption', () => {
    expect(resolveNarrationSourceParts({ pageId: 'page-1', segments: [{ textParts: [{
      sourceRef: 'source-list-1-item-2', quote: '调整项目任务的复杂程度',
    }] }] }, anchors)).toEqual({ pageId: 'page-1', segments: [{ text: '调整项目任务的复杂程度' }] });
  });

  it('compiles an authored definition or unchanged defining excerpt without rewriting the surrounding example', () => {
    const definition = '任务驱动式教学法是一种能唤起学生学习热情与探究欲望，并让学生在完成任务时习得知识与技能的教学模式。';
    const scoped = new Map([['page-1', new Map([['source-definition-1', definition]])]]);
    const parts = [{ text: '先说明这种教学法为什么有效。' }, { sourceRef: 'source-definition-1', quote: definition },
      { text: '例如，让学生比较任务方案后解释自己的选择。' }];
    const authored = { pageId: 'page-1', segments: [{ textParts: parts }] };
    expect(resolveNarrationSourceParts(authored, scoped)).toEqual({ pageId: 'page-1', segments: [{
      text: `先说明这种教学法为什么有效。${definition}例如，让学生比较任务方案后解释自己的选择。`,
    }] });
    expect(resolveNarrationSourceParts({ pageId: 'page-1', segments: [{ textParts: [{
      sourceRef: 'source-definition-1', quote: '让学生在完成任务时习得知识与技能',
    }] }] }, scoped)).toEqual({ pageId: 'page-1', segments: [{ text: '让学生在完成任务时习得知识与技能' }] });
    const legacy = { pageId: 'page-1', segments: [{ text: '保持已经验收的自然讲稿。' }] };
    expect(resolveNarrationSourceParts(legacy, scoped)).toBe(legacy);
  });

  it('supports the single-page fallback while preserving author-supplied whitespace and punctuation', () => {
    const legacy = { segments: [{ text: '  ', textParts: [{ text: '教材给出的边界是：\n' },
      { sourceRef: 'source-list-1-item-2' }, { text: '\n现在用一个具体任务解释这个条件。' }] }] };
    expect(resolveNarrationSourceParts(legacy, anchors, 'page-1')).toEqual({ segments: [{
      text: `教材给出的边界是：\n${source2}\n现在用一个具体任务解释这个条件。`,
    }] });
  });

  it.each([
    ['empty parts', []], ['non-array parts', 'source-list-1-item-1'], ['null part', [null]],
    ['both forms', [{ text: '改写的定义', sourceRef: 'source-list-1-item-1' }]],
    ['neither form', [{}]], ['non-string text', [{ text: 7 }]],
    ['extra instructions', [{ text: '讲解', sourceRefFallback: 'source-list-1-item-1' }]],
    ['empty source id', [{ sourceRef: ' ' }]], ['non-string source id', [{ sourceRef: 1 }]],
    ['unknown source', [{ sourceRef: 'invented-source' }]],
    ['foreign source', [{ sourceRef: 'other-page-definition' }]],
  ])('rejects invalid parts: %s', (_case, textParts) => {
    expect(() => resolveNarrationSourceParts({ pageId: 'page-1', segments: [{ textParts }] }, anchors)).toThrow('Source narration:');
  });

  it('rejects a nonempty text that changes the source-backed speech', () => {
    expect(() => resolveNarrationSourceParts({ pageId: 'page-1', segments: [{ text: source1.replace('先让', '随便让'),
      textParts: [{ sourceRef: 'source-list-1-item-1' }] }] }, anchors)).toThrow('cannot be combined');
  });

  it('does not use the single-page fallback to authorize a missing or foreign section page', () => {
    for (const pageId of [undefined, 'foreign-page']) {
      expect(() => resolveNarrationSourceParts({ pages: [{ pageId, segments: [{
        textParts: [{ sourceRef: 'source-list-1-item-1' }],
      }] }] }, anchors, 'page-1')).toThrow('unknown source reference');
    }
  });

  it('does not search another page when that page contains a matching source id', () => {
    const scoped = new Map([['page-1', new Map([['shared-id', source1]])], ['page-2', new Map([['shared-id', source2]])]]);
    expect(resolveNarrationSourceParts({ pageId: 'page-2', segments: [{ textParts: [{ sourceRef: 'shared-id' }] }] }, scoped))
      .toEqual({ pageId: 'page-2', segments: [{ text: source2 }] });
  });

  it('compiles the existing response wrapper using the outer page identity and preserves narration metadata', () => {
    const segment = { id: 'speech-1', textParts: [{ text: '先解释这个边界。' }, { sourceRef: 'source-list-1-item-2' }],
      semanticIds: ['page-1:teaching'], anchors: [{ quote: source2, occurrence: 0 }] };
    const authored = { pageId: 'page-1', metadata: 'unchanged', response: { pageId: 'page-2', segments: [segment], version: 1 } };
    const before = structuredClone(authored);
    expect(resolveNarrationSourceParts(authored, anchors, 'page-2')).toEqual({ ...authored,
      response: { ...authored.response, segments: [{ id: segment.id, text: `先解释这个边界。${source2}`,
        semanticIds: segment.semanticIds, anchors: segment.anchors }] } });
    expect(authored).toEqual(before);
  });

  it('compiles a legacy response wrapper with the same single-page fallback as root segments', () => {
    const segment = { textParts: [{ sourceRef: 'source-list-1-item-1' }], semanticIds: ['page-1:teaching'] };
    expect(resolveNarrationSourceParts({ response: { segments: [segment] } }, anchors, 'page-1'))
      .toEqual({ response: { segments: [{ text: source1, semanticIds: segment.semanticIds }] } });
    expect(resolveNarrationSourceParts({ segments: null, response: { segments: [segment] } }, anchors, 'page-1'))
      .toEqual({ segments: null, response: { segments: [{ text: source1, semanticIds: segment.semanticIds }] } });
  });

  it('passes compiled wrapped source speech and exact quote anchors through the existing narration normalizer', () => {
    const resolved = resolveNarrationSourceParts({ response: { segments: [{
      textParts: [{ text: '接下来解释任务的设计依据。' }, { sourceRef: 'source-list-1-item-2' },
        { text: '同样的任务可以按学生的已有经验调整。' }],
      semanticIds: ['page-1:teaching'], anchors: [{ semanticId: 'page-1:teaching', quote: source2, occurrence: 0 }],
    }] } }, anchors, 'page-1');
    const normalized = normalizeTeachingNarration(resolved, { id: 'page-1', type: 'slide', title: '任务难度',
      description: '解释任务难度与认知能力的关系', keyPoints: ['按认知能力调整任务'], order: 0 });
    expect(normalized.segments[0].text).toBe(`接下来解释任务的设计依据。${source2}同样的任务可以按学生的已有经验调整。`);
    expect(normalized.segments[0].anchors?.[0]).toMatchObject({ semanticId: 'page-1:teaching', quote: source2, occurrence: 0 });
  });

  it('keeps a text-only response wrapper as the exact same object', () => {
    const authored = { response: { segments: [{ text: '已经验收的讲稿。', semanticIds: ['page-1:teaching'] }] } };
    expect(resolveNarrationSourceParts(authored, anchors, 'page-1')).toBe(authored);
  });

  it('uses the normalizer root-segment precedence without silently falling back from an invalid root to a wrapper', () => {
    const nested = { segments: [{ textParts: [{ sourceRef: 'unknown-source' }] }] };
    const root = { pageId: 'page-1', segments: [{ text: '原根对象的正文。' }], response: nested };
    expect(resolveNarrationSourceParts(root, anchors)).toBe(root);
    const invalid = { pageId: 'page-1', segments: 'invalid', response: nested };
    expect(resolveNarrationSourceParts(invalid, anchors)).toBe(invalid);
  });

  it('compiles page wrappers within section responses without borrowing the single-page fallback', () => {
    const authored = { pages: [{ pageId: 'page-2', response: { segments: [{ textParts: [{ sourceRef: 'other-page-definition' }] }] } }] };
    expect(resolveNarrationSourceParts(authored, anchors, 'page-1')).toEqual({ pages: [{ pageId: 'page-2',
      response: { segments: [{ text: '只属于第二页的权威定义。' }] } }] });
    expect(() => resolveNarrationSourceParts({ pages: [{ response: { segments: [{
      textParts: [{ sourceRef: 'source-list-1-item-1' }],
    }] } }] }, anchors, 'page-1')).toThrow('unknown source reference');
  });

  it.each([
    { pageId: 'page-2', response: { segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' }] }] } },
    { pageId: 'foreign-page', response: { segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' }] }] } },
    { pageId: 'page-1', response: { segments: [{ text: '不一致的正文', textParts: [{ sourceRef: 'source-list-1-item-1' }] }] } },
    { pageId: 'page-1', response: { segments: [{ textParts: [{ text: '同时写两种', sourceRef: 'source-list-1-item-1' }] }] } },
  ])('retains the same strict rejection for wrapped narration %j', (authored) => {
    expect(() => resolveNarrationSourceParts(authored, anchors, 'page-1')).toThrow('Source narration:');
  });
});

describe('finite source duties in newly authored narration', () => {
  const duties: NarrationSourceAuthoringDuty[] = [source1, source2, source3].map((text, index) => ({
    text, availableReferences: [{ pageId: 'page-1', sourceRef: `source-list-1-item-${index + 1}` }],
  }));

  it('accepts complete first-call composition and leaves its natural order, visual anchors and source expansion unchanged', () => {
    const authored = { sectionId: 'section-1', pages: [{ pageId: 'page-1', segments: [
      { semanticIds: ['page-1:teaching'], anchors: [{ semanticId: 'page-1:teaching', quote: source2, occurrence: 0 }], textParts: [
        { text: '先说明为什么任务需要适应学生。' }, { sourceRef: 'source-list-1-item-2' },
        { text: '同一主题可以按照学生的经验调整难度。' },
      ] },
      { semanticIds: ['page-1:teaching'], textParts: [{ sourceRef: 'source-list-1-item-1' },
        { text: '学生比较工具给出的两种方案，再解释自己的判断。' }, { sourceRef: 'source-list-1-item-3' }] },
    ] }] };
    const before = structuredClone(authored);
    expect(assertNarrationSourceDuties(authored, duties)).toBeUndefined();
    expect(authored).toEqual(before);
    const resolved = resolveNarrationSourceParts(authored, anchors) as { pages: Array<{ segments: Array<{ text: string }> }> };
    const normalized = normalizeTeachingNarration(resolved.pages[0], { id: 'page-1', type: 'slide', title: '任务难度',
      description: '解释来源建议的依据', keyPoints: ['按认知能力调整任务'], order: 0 });
    expect(normalized.segments.map((segment) => segment.text)).toEqual([
      `先说明为什么任务需要适应学生。${source2}同一主题可以按照学生的经验调整难度。`,
      `${source1}学生比较工具给出的两种方案，再解释自己的判断。${source3}`,
    ]);
    expect(normalized.segments[0].anchors?.[0]).toMatchObject({ quote: source2, occurrence: 0 });
  });

  it('rejects ordinary text even when it repeats the complete canonical wording and keeps the legacy resolver unchanged', () => {
    const authored = { pageId: 'page-1', segments: [{ text: `${source1}${source2}${source3}` }] };
    const before = structuredClone(authored);
    expect(() => assertNarrationSourceDuties(authored, duties)).toThrow('missing adopted source references');
    expect(() => assertNarrationSourceDuties(authored, duties)).toThrow('"sourceRef":"source-list-1-item-3"');
    expect(authored).toEqual(before);
    expect(resolveNarrationSourceParts(authored, anchors)).toBe(authored);
  });

  it('keeps same-named requirements from different source lists independent', () => {
    const independent = [1, 2].map((list) => ({ text: source1,
      availableReferences: [{ pageId: 'page-1', sourceRef: `source-list-${list}-item-1` }],
    }));
    const authored = { pageId: 'page-1', segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' }] }] };
    expect(() => assertNarrationSourceDuties(authored, independent)).toThrow('"dutyIndex":2');
    expect(() => assertNarrationSourceDuties(authored, independent)).toThrow('source-list-2-item-1');
    authored.segments[0].textParts.push({ sourceRef: 'source-list-2-item-1' });
    expect(assertNarrationSourceDuties(authored, independent)).toBeUndefined();
  });

  it('requires the authored reference on an allowed page, even when another page has the same source id and wording', () => {
    const authored = { pages: [{ pageId: 'page-2', segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' }] }] }] };
    const scoped = new Map([['page-1', new Map([['source-list-1-item-1', source1]])],
      ['page-2', new Map([['source-list-1-item-1', source1]])]]);
    expect(resolveNarrationSourceParts(authored, scoped)).toEqual({ pages: [{ pageId: 'page-2', segments: [{ text: source1 }] }] });
    expect(() => assertNarrationSourceDuties(authored, duties.slice(0, 1))).toThrow('"pageId":"page-1"');
    authored.pages[0].pageId = 'page-1';
    expect(assertNarrationSourceDuties(authored, duties.slice(0, 1))).toBeUndefined();
  });

  it('accepts any one explicit allowed alternative and does not add a repetition gate', () => {
    const alternatives = [{ text: source1, availableReferences: [{ pageId: 'page-1', sourceRef: 'first-source' },
      { pageId: 'page-2', sourceRef: 'second-source' }] }];
    const authored = { pages: [{ pageId: 'page-2', segments: [{ textParts: [{ sourceRef: 'second-source' },
      { text: '后续应用仍引用同一事实。' }, { sourceRef: 'second-source' }] }] }] };
    expect(assertNarrationSourceDuties(authored, alternatives)).toBeUndefined();
  });

  it('uses wrapped segments with the outer page identity and the same single-page fallback as the resolver', () => {
    const segment = { textParts: [{ sourceRef: 'source-list-1-item-1' }] };
    expect(assertNarrationSourceDuties({ pageId: 'page-1', response: { pageId: 'page-2', segments: [segment] } }, duties.slice(0, 1), 'page-2'))
      .toBeUndefined();
    expect(assertNarrationSourceDuties({ response: { pageId: 'page-2', segments: [segment] } }, duties.slice(0, 1), 'page-1'))
      .toBeUndefined();
    expect(() => assertNarrationSourceDuties({ pageId: 'page-2', response: { pageId: 'page-1', segments: [segment] } }, duties.slice(0, 1), 'page-1'))
      .toThrow('missing adopted source references');
  });

  it.each([
    [{ text: '已采用的根正文。' }],
    'invalid-root-segments',
  ])('does not inspect refs in a response wrapper shadowed by root segments %j', (segments) => {
    const authored = { pageId: 'page-1', segments, response: { segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' }] }] } };
    expect(() => assertNarrationSourceDuties(authored, duties.slice(0, 1))).toThrow('missing adopted source references');
    expect(assertNarrationSourceDuties({ ...authored, segments: null }, duties.slice(0, 1))).toBeUndefined();
  });

  it('requires each section page to own its outer identity without borrowing a single-page fallback or nested identity', () => {
    const segment = { textParts: [{ sourceRef: 'source-list-1-item-1' }] };
    expect(() => assertNarrationSourceDuties({ pages: [{ response: { pageId: 'page-1', segments: [segment] } }] }, duties.slice(0, 1), 'page-1'))
      .toThrow('missing adopted source references');
    expect(assertNarrationSourceDuties({ pages: [{ pageId: 'page-1', response: { pageId: 'page-2', segments: [segment] } }] }, duties.slice(0, 1), 'page-2'))
      .toBeUndefined();
  });

  it.each([
    { text: source1, sourceRef: 'source-list-1-item-1' },
    { text: source1, textParts: [{ sourceRef: 'source-list-1-item-1' }] },
    { textParts: [{ text: source1, sourceRef: 'source-list-1-item-1' }] },
    { textParts: [{ sourceRef: 'source-list-1-item-1', hidden: true }] },
    { textParts: [{ sourceRef: 'source-list-1-item-1', quote: '' }] },
    { textParts: 'source-list-1-item-1' },
    { textParts: [{ text: 'source-list-1-item-1' }], anchors: [{ sourceRef: 'source-list-1-item-1' }] },
  ])('does not accept a pseudo reference outside valid source parts %j', (segment) => {
    expect(() => assertNarrationSourceDuties({ pageId: 'page-1', segments: [segment] }, duties.slice(0, 1)))
      .toThrow('missing adopted source references');
  });

  it('reports every missing finite duty and its usable references without appending content', () => {
    const authored = { pageId: 'page-1', segments: [{ textParts: [{ sourceRef: 'source-list-1-item-2' }] }] };
    const before = structuredClone(authored);
    try {
      assertNarrationSourceDuties(authored, duties);
      expect.fail('missing duties must reject the first draft');
    } catch (error) {
      const detail = String(error);
      expect(detail).toContain('"dutyIndex":1');
      expect(detail).toContain('"dutyIndex":3');
      expect(detail).toContain(source1);
      expect(detail).toContain('"pageId":"page-1","sourceRef":"source-list-1-item-3"');
      expect(detail).not.toContain('"dutyIndex":2');
    }
    expect(authored).toEqual(before);
    expect(resolveNarrationSourceParts(authored, anchors)).toEqual({ pageId: 'page-1', segments: [{ text: source2 }] });
  });

  it('does not invent a page when a required duty has no authorized reference', () => {
    expect(() => assertNarrationSourceDuties({ pageId: 'page-1', segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' }] }] },
      [{ text: source1, availableReferences: [] }])).toThrow('"availableReferences":[]');
  });

  it('leaves ordinary narration and the resolver untouched when no finite duties were adopted', () => {
    const ordinary = { response: { segments: [{ text: '保留自然讲解及已有视觉动作。', semanticIds: ['page-1:teaching'] }] } };
    const before = structuredClone(ordinary);
    expect(assertNarrationSourceDuties(ordinary, [], 'page-1')).toBeUndefined();
    expect(assertNarrationSourceDuties(null, [])).toBeUndefined();
    expect(ordinary).toEqual(before);
    expect(resolveNarrationSourceParts(ordinary, anchors, 'page-1')).toBe(ordinary);
  });
});
