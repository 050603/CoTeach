import { describe, expect, it } from 'vitest';
import type { NarrationModuleOutput } from './action-binding-types';
import type { NarrationSourceAuthoringDuty } from './source-narration-authoring';
import { buildNarrationInsertionSlots, compileNarrationInsertions, type NarrationInsertionSlot } from './source-narration-patch';

const condition = '应根据学生的认知能力调整项目任务的复杂程度。';
const definition = '支架帮助学生完成他们暂时不能独立完成的学习任务。';
const anchorsByPage = new Map([
  ['page-1', new Map([['source-list-1-item-1', condition], ['source-definition-1', definition]])],
  ['page-2', new Map([['foreign-definition', '只属于另一页的权威定义。']])],
]);
const duties: NarrationSourceAuthoringDuty[] = [{ text: condition,
  availableReferences: [{ pageId: 'page-1', sourceRef: 'source-list-1-item-1' }] }];

function savedDrafts(): NarrationModuleOutput[] {
  return [{ pageId: 'page-1', segments: [
    { id: 'reasoning', pageId: 'page-1', semanticIds: ['page-1:mechanism'],
      text: '为什么需要支架？因为学生还不能独立完成任务，支架能把复杂工作拆成可执行步骤。\n例如，用操作手册帮助他们找到入口。  ',
      anchors: [{ id: 'cue-1', semanticId: 'page-1:mechanism', quote: '支架能把复杂工作拆成可执行步骤', occurrence: 0,
        visualCue: { type: 'spotlight', necessity: 'helpful', target: { elementId: 'mechanism-card' } } }],
    },
    { id: 'transfer', pageId: 'page-1', semanticIds: ['page-1:application'], text: '同样的方案要根据年级调整。已有尝试值得保留。', anchors: [] },
  ] }, { pageId: 'page-2', segments: [
    { id: 'other-example', pageId: 'page-2', semanticIds: ['page-2:example'], text: '保留另一页的有效案例：学生先比较，再说明自己的选择。' },
  ] }];
}

function compile(authored: unknown, options: {
  drafts?: NarrationModuleOutput[];
  slots?: NarrationInsertionSlot[];
  targetPageIds?: string[];
  duties?: NarrationSourceAuthoringDuty[];
  anchorsByPage?: ReadonlyMap<string, ReadonlyMap<string, string>>;
} = {}) {
  const drafts = options.drafts ?? savedDrafts();
  const targetPageIds = options.targetPageIds ?? ['page-1'];
  return compileNarrationInsertions({ authored, drafts, targetPageIds,
    slots: options.slots ?? buildNarrationInsertionSlots(drafts, targetPageIds),
    anchorsByPage: options.anchorsByPage ?? anchorsByPage, duties: options.duties ?? duties,
  });
}

function patch(at: string, textParts: unknown = [{ sourceRef: 'source-list-1-item-1' }]) {
  return { pages: [{ pageId: 'page-1', insertions: [{ at, textParts }] }] };
}

describe('saved narration insertion slots', () => {
  it('offers start, complete sentence ends and end using actual UTF-16 text without splitting decimals or closing quotes', () => {
    const text = '数值是3.14。学生问：“为什么？”接着解释因果！End. Next?';
    const drafts: NarrationModuleOutput[] = [{ pageId: 'page:1', segments: [
      { id: 'segment:1', pageId: 'page:1', text, semanticIds: [] },
    ] }];
    const slots = buildNarrationInsertionSlots(drafts, ['page:1']);
    expect(slots.map((slot) => slot.offset)).toEqual([0, text.indexOf('。') + 1,
      text.indexOf('？”') + 2, text.indexOf('！') + 1, text.indexOf('End.') + 4, text.length]);
    expect(slots.every((slot) => slot.pageId === 'page:1' && slot.segmentId === 'segment:1')).toBe(true);
    expect(slots.every((slot) => slot.id.includes('page%3A1:segment%3A1:'))).toBe(true);
    for (const slot of slots) {
      expect(slot.beforeContext).toBe(text.slice(0, slot.offset));
      expect(slot.afterContext).toBe(text.slice(slot.offset));
    }
    expect(slots).toEqual(buildNarrationInsertionSlots(drafts, ['page:1']));
  });

  it('keeps slot identities stable when unrelated pages and segments are reordered or added', () => {
    const drafts = savedDrafts();
    const original = buildNarrationInsertionSlots(drafts, ['page-1']);
    const reordered = [drafts[1], { ...drafts[0], segments: [drafts[0].segments[1], drafts[0].segments[0]] }];
    const again = buildNarrationInsertionSlots(reordered, ['page-1']);
    expect(new Map(again.map((slot) => [slot.id, slot]))).toEqual(new Map(original.map((slot) => [slot.id, slot])));
    expect(again.every((slot) => slot.pageId === 'page-1')).toBe(true);
  });

  it('does not offer a sentence boundary which would split an accepted visual quote', () => {
    const drafts: NarrationModuleOutput[] = [{ pageId: 'page-1', segments: [{ id: 's1', pageId: 'page-1', semanticIds: ['meaning'],
      text: '先解释原因。再分析结果。', anchors: [{ id: 'accepted', semanticId: 'meaning', quote: '先解释原因。再分析结果。' }],
    }] }];
    expect(buildNarrationInsertionSlots(drafts, ['page-1']).map((slot) => slot.offset)).toEqual([0, drafts[0].segments[0].text.length]);
    const unsafe = buildNarrationInsertionSlots([{ ...drafts[0], segments: [{ ...drafts[0].segments[0], anchors: [] }] }], ['page-1'])[1];
    expect(() => compile(patch(unsafe.id), { drafts, slots: [unsafe], duties: [] })).toThrow('slots are stale');
  });

  it('rejects ambiguous saved page or segment identities and nonexistent target pages', () => {
    const drafts = savedDrafts();
    expect(() => buildNarrationInsertionSlots(drafts, ['foreign-page'])).toThrow('has no saved narration segments');
    expect(() => buildNarrationInsertionSlots(drafts, ['page-1', 'page-1'])).toThrow('unique nonempty');
    expect(() => buildNarrationInsertionSlots([drafts[0], drafts[0]], ['page-1'])).toThrow('unique nonempty');
    expect(() => buildNarrationInsertionSlots([{ ...drafts[0], segments: [drafts[0].segments[0], drafts[0].segments[0]] }], ['page-1'])).toThrow('unique ids');
  });
});

describe('source-grounded saved narration insertion compiler', () => {
  it('inserts the selected missing condition and preserves every original causal sentence, case and paragraph identity', () => {
    const drafts = savedDrafts();
    const before = structuredClone(drafts);
    const slots = buildNarrationInsertionSlots(drafts, ['page-1']);
    const segment = drafts[0].segments[0];
    const offset = segment.text.indexOf('。') + 1;
    const at = slots.find((slot) => slot.segmentId === segment.id && slot.offset === offset)!.id;
    const authored = patch(at, [{ text: '这里还要满足一个条件：' }, { sourceRef: 'source-list-1-item-1' },
      { text: '这不是替学生完成任务，而是让学生知道如何开始。' }]);
    const authoredBefore = structuredClone(authored);
    const result = compile(authored, { drafts, slots });
    const inserted = `这里还要满足一个条件：${condition}这不是替学生完成任务，而是让学生知道如何开始。`;
    expect(result[0].segments[0].text).toBe(segment.text.slice(0, offset) + inserted + segment.text.slice(offset));
    expect(result[0].segments[0].text.replace(inserted, '')).toBe(segment.text);
    expect(result[0].segments[0].id).toBe(segment.id);
    expect(result[0].segments[0].semanticIds).toBe(segment.semanticIds);
    expect(result[0].segments[0].anchors).toBe(segment.anchors);
    expect(result[0].segments[1]).toBe(drafts[0].segments[1]);
    expect(result[1]).toBe(drafts[1]);
    expect(drafts).toEqual(before);
    expect(authored).toEqual(authoredBefore);
    expect(result[0].segments[0].text).not.toContain(definition);
  });

  it('honors multiple chosen positions and page ownership without sorting source content or replacing old paragraphs', () => {
    const drafts = savedDrafts();
    const targets = ['page-1', 'page-2'];
    const slots = buildNarrationInsertionSlots(drafts, targets);
    const first = drafts[0].segments[0];
    const find = (pageId: string, segmentId: string, offset: number) => slots.find((slot) => slot.pageId === pageId && slot.segmentId === segmentId && slot.offset === offset)!.id;
    const middle = first.text.indexOf('。') + 1;
    const authored = { pages: [
      { pageId: 'page-2', insertions: [{ at: find('page-2', 'other-example', 0), textParts: [{ text: '补充这次迁移的适用范围。' }] }] },
      { pageId: 'page-1', insertions: [
        { at: find('page-1', 'reasoning', first.text.length), textParts: [{ text: '最后解释如何检查任务难度。' }] },
        { at: find('page-1', 'reasoning', middle), textParts: [{ sourceRef: 'source-list-1-item-1' }] },
        { at: find('page-1', 'reasoning', 0), textParts: [{ text: '先说明支架的适用边界。\n' }] },
      ] },
    ] };
    const result = compile(authored, { drafts, slots, targetPageIds: targets });
    expect(result.map((page) => page.pageId)).toEqual(drafts.map((page) => page.pageId));
    expect(result[0].segments[0].text).toBe(`先说明支架的适用边界。\n${first.text.slice(0, middle)}${condition}${first.text.slice(middle)}最后解释如何检查任务难度。`);
    expect(result[0].segments[1]).toBe(drafts[0].segments[1]);
    expect(result[1].segments[0].text).toBe(`补充这次迁移的适用范围。${drafts[1].segments[0].text}`);
  });

  it('leaves explicit empty insertions unchanged and rejects them when a source duty is still missing', () => {
    const drafts = savedDrafts();
    const authored = { pages: [{ pageId: 'page-1', insertions: [] }] };
    const result = compile(authored, { drafts, duties: [] });
    expect(result[0]).toBe(drafts[0]);
    expect(result[1]).toBe(drafts[1]);
    expect(() => compile(authored, { drafts })).toThrow('missing adopted source references');
    expect(drafts[0].segments[0].text).not.toContain(condition);
  });

  it('requires an authored source reference even when an ordinary inserted text part repeats its full wording', () => {
    const at = buildNarrationInsertionSlots(savedDrafts(), ['page-1'])[0].id;
    expect(() => compile(patch(at, [{ text: condition }]))).toThrow('missing adopted source references');
  });

  it('resolves the same source id only within its explicitly authored page scope', () => {
    const drafts = savedDrafts();
    const targetPageIds = ['page-1', 'page-2'];
    const slots = buildNarrationInsertionSlots(drafts, targetPageIds);
    const scoped = new Map([['page-1', new Map([['shared-id', condition]])], ['page-2', new Map([['shared-id', definition]])]]);
    const authored = { pages: targetPageIds.map((pageId) => ({ pageId, insertions: [{
      at: slots.find((slot) => slot.pageId === pageId && slot.offset === 0)!.id, textParts: [{ sourceRef: 'shared-id' }],
    }] })) };
    const result = compile(authored, { drafts, slots, targetPageIds, duties: [], anchorsByPage: scoped });
    expect(result[0].segments[0].text).toBe(condition + drafts[0].segments[0].text);
    expect(result[1].segments[0].text).toBe(definition + drafts[1].segments[0].text);
  });

  it('remaps original repeated-quote anchors and laser paths to their actual saved occurrence while keeping targets unchanged', () => {
    const phrase = '说明核心关系';
    const text = '先说明核心关系，再给案例。然后说明核心关系，检查迁移。';
    const cue = { type: 'laser' as const, necessity: 'essential' as const,
      target: { elementId: 'original-card', selector: { quote: phrase, occurrence: 0 } },
      waypoints: [
        { elementId: 'first-card', speechAnchor: { quote: phrase } },
        { elementId: 'second-card', speechAnchor: { quote: phrase, occurrence: 1 } },
      ], endSpeechAnchor: { quote: '检查迁移' }, durationMs: 2500,
    };
    const drafts: NarrationModuleOutput[] = [{ pageId: 'page-1', segments: [{ id: 's1', pageId: 'page-1', text,
      semanticIds: ['relationship'], anchors: [
        { id: 'first', semanticId: 'relationship', quote: phrase },
        { id: 'last', semanticId: 'relationship', quote: phrase, occurrence: 1, visualCue: cue },
      ],
    }] }];
    const before = structuredClone(drafts);
    const source = `${phrase}。检查迁移。`;
    const scoped = new Map([['page-1', new Map([['source-list-1-item-1', source]])]]);
    const at = buildNarrationInsertionSlots(drafts, ['page-1'])[0].id;
    const result = compile(patch(at), { drafts, anchorsByPage: scoped, duties: [] });
    const anchors = result[0].segments[0].anchors!;
    expect(result[0].segments[0].text).toBe(source + text);
    expect(anchors.map((anchor) => [anchor.id, anchor.quote, anchor.occurrence])).toEqual([
      ['first', phrase, 1], ['last', phrase, 2],
    ]);
    expect(anchors[1].visualCue?.target).toBe(cue.target);
    expect(anchors[1].visualCue?.target?.selector).toEqual(cue.target.selector);
    expect(anchors[1].visualCue?.waypoints?.map((waypoint) => waypoint.speechAnchor)).toEqual([
      { quote: phrase, occurrence: 1 }, { quote: phrase, occurrence: 2 },
    ]);
    expect(anchors[1].visualCue?.endSpeechAnchor).toEqual({ quote: '检查迁移', occurrence: 1 });
    expect(anchors[1].visualCue?.durationMs).toBe(cue.durationMs);
    expect(drafts).toEqual(before);
  });

  it('retains occurrence metadata when a repeated phrase is inserted after its original visual anchors', () => {
    const drafts = savedDrafts();
    const segment = drafts[0].segments[0];
    const at = buildNarrationInsertionSlots(drafts, ['page-1']).find((slot) => slot.segmentId === segment.id && slot.offset === segment.text.length)!.id;
    const result = compile(patch(at, [{ text: segment.anchors![0].quote }]), { drafts, duties: [] });
    expect(result[0].segments[0].anchors).toBe(segment.anchors);
  });

  it('refuses an insertion whose overlapping phrase would make the real old anchor unrepresentable', () => {
    const drafts: NarrationModuleOutput[] = [{ pageId: 'page-1', segments: [{ id: 's1', pageId: 'page-1', text: '学习学习。',
      semanticIds: ['meaning'], anchors: [{ id: 'anchor', semanticId: 'meaning', quote: '学习学习' }],
    }] }];
    const at = buildNarrationInsertionSlots(drafts, ['page-1'])[0].id;
    expect(() => compile(patch(at, [{ text: '学习' }]), { drafts, duties: [] })).toThrow('original speech quote occurrence unrepresentable');
  });

  it.each(['unknown-source', 'foreign-definition'])('rejects unknown or foreign source refs: %s', (sourceRef) => {
    const at = buildNarrationInsertionSlots(savedDrafts(), ['page-1'])[0].id;
    expect(() => compile(patch(at, [{ sourceRef }]), { duties: [] })).toThrow('unknown source reference');
  });

  it('rejects missing, foreign or duplicated target pages rather than substituting a whole-page response', () => {
    const at = buildNarrationInsertionSlots(savedDrafts(), ['page-1'])[0].id;
    expect(() => compile({ pages: [] })).toThrow('each requested target page exactly once');
    expect(() => compile({ pages: [{ pageId: 'page-2', insertions: [] }] })).toThrow('each requested target page exactly once');
    expect(() => compile({ pages: [patch(at).pages[0], patch(at).pages[0]] }, { targetPageIds: ['page-1', 'page-2'] })).toThrow('each requested target page exactly once');
    expect(() => compile({ pageId: 'page-1', segments: [{ text: '重写整页。' }] })).toThrow('unsupported field');
    expect(() => compile({ pages: [{ pageId: 'page-1', segments: [{ text: '重写整页。' }], insertions: [] }] })).toThrow('unsupported field');
  });

  it('rejects unknown, cross-page and repeated slots', () => {
    const drafts = savedDrafts();
    const slots = buildNarrationInsertionSlots(drafts, ['page-1', 'page-2']);
    const own = slots.find((slot) => slot.pageId === 'page-1')!;
    const foreign = slots.find((slot) => slot.pageId === 'page-2')!;
    const authored = (at: string) => ({ pages: [patch(at).pages[0], { pageId: 'page-2', insertions: [] }] });
    expect(() => compile(authored('unknown-slot'), { drafts, slots, targetPageIds: ['page-1', 'page-2'], duties: [] })).toThrow('unknown, cross-page or duplicate slot');
    expect(() => compile(authored(foreign.id), { drafts, slots, targetPageIds: ['page-1', 'page-2'], duties: [] })).toThrow('unknown, cross-page or duplicate slot');
    expect(() => compile({ pages: [{ pageId: 'page-1', insertions: [...patch(own.id).pages[0].insertions, ...patch(own.id).pages[0].insertions] }] })).toThrow('unknown, cross-page or duplicate slot');
  });

  it('rejects stale contexts and forged non-boundary offsets before using the authored patch', () => {
    const drafts = savedDrafts();
    const slots = buildNarrationInsertionSlots(drafts, ['page-1']);
    const altered = [{ ...drafts[0], segments: [{ ...drafts[0].segments[0], text: drafts[0].segments[0].text.replace('为什么', '为何要') }, drafts[0].segments[1]] }, drafts[1]];
    expect(() => compile(patch(slots[0].id), { drafts: altered, slots })).toThrow('slots are stale');
    expect(() => compile(patch(slots[0].id), { drafts, slots: [{ ...slots[0], offset: 1 }] })).toThrow('slots are stale');
    expect(() => compile(patch(slots[0].id), { drafts, slots: [slots[0], slots[0]] })).toThrow('slots are stale');
  });

  it.each([
    null, [], { text: '讲解', sourceRef: 'source-list-1-item-1' }, {}, { text: 1 }, { sourceRef: '' },
    { sourceRef: 'source-list-1-item-1', quote: '调整项目任务' }, { text: '讲解', replace: 'old sentence' },
  ])('rejects malformed or unsupported text parts: %j', (part) => {
    const at = buildNarrationInsertionSlots(savedDrafts(), ['page-1'])[0].id;
    expect(() => compile(patch(at, [part]), { duties: [] })).toThrow('Source narration patch:');
  });

  it.each([undefined, [], 'not-an-array'])('rejects missing or invalid textParts: %j', (textParts) => {
    const at = buildNarrationInsertionSlots(savedDrafts(), ['page-1'])[0].id;
    expect(() => compile({ pages: [{ pageId: 'page-1', insertions: [{ at, textParts }] }] }, { duties: [] })).toThrow('nonempty array');
  });

  it('rejects an empty compiled insertion or an unsupported replacement field without changing the draft', () => {
    const drafts = savedDrafts();
    const before = structuredClone(drafts);
    const at = buildNarrationInsertionSlots(drafts, ['page-1'])[0].id;
    expect(() => compile(patch(at, [{ text: '  ' }]), { drafts, duties: [] })).toThrow('nonempty authored text');
    expect(() => compile({ pages: [{ pageId: 'page-1', insertions: [{ at, textParts: [{ text: '只允许插入。' }], replace: '原句' }] }] }, { drafts, duties: [] })).toThrow('unsupported field');
    expect(drafts).toEqual(before);
  });
});
