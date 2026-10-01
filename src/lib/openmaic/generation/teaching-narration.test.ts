import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import { TEACHING_ENHANCEMENT_VERSION } from './teaching-enhancement';
import { deriveTeachingConstraints } from '@openmaic/lib/pedagogy/teaching-constraints';
import { findSectionSourceContentIssues, findSourceContentIssues } from '@/lib/course-generation/source-content-acceptance';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import {
  buildTeachingNarrationSemantics,
  canUseIndependentTeachingNarration,
  compileTeachingNarrationActions,
  generateTeachingSectionNarration,
  generateTeachingSourceNarrationInsertions,
  generateTeachingNarration,
  groundPreviousPageNarrationLead,
  normalizeTeachingNarration,
  normalizeTeachingSectionNarration,
  withTeachingSlideGuidance,
  restoreTeachingSemanticElementIds,
} from './teaching-narration';

/** Resolve the wire catalogue for semantic assertions without losing reference checks. */
function readNarrationPrompt(raw: string) {
  const prompt = JSON.parse(raw);
  const texts = prompt.evidenceCatalog?.texts ?? {};
  const sources = prompt.evidenceCatalog?.sources ?? {};
  const resolve = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(resolve);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (['textRef', 'labelRef', 'sourceLabelRef', 'explanationRef', 'quoteRef'].includes(key)) {
        expect(texts[entry as string]).toBeTypeOf('string');
        return [key.slice(0, -3), texts[entry as string]];
      }
      if (['sourceDescriptionRefs', 'originalQuoteRefs'].includes(key)) return [key.replace('Refs', 's'),
        (entry as string[]).map((id) => { expect(texts[id]).toBeTypeOf('string'); return texts[id]; })];
      if (key === 'originalSourceRefs') return ['originalSources', (entry as string[]).map((id) => {
        expect(sources[id]).toBeDefined(); return resolve(sources[id]);
      })];
      return [key, resolve(entry)];
    }));
  };
  return JSON.parse(JSON.stringify(resolve(prompt)));
}

function outline(): SceneOutline {
  return {
    id: 'page-a', type: 'slide', title: '核验AI回答', description: '解释核验', keyPoints: ['查相关记录'], order: 0,
    teachingBrief: {
      schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, explanation: '记录需要与具体说法相关', examples: ['建校年份'], conditions: ['记录相关'], evidence: [], assessmentFocus: '查什么',
      learningBoundary: {
        prerequisiteKnowledge: [],
        previouslyTaughtKnowledge: [],
        currentKnowledge: [{ id: 'claim-check', name: '说法核验' }],
        futureKnowledge: [{ id: 'source-independence', name: '来源独立性' }],
      },
      sharedContext: { learningPurpose: '决定AI写的小报内容能否使用', caseId: 'school-paper',
        caseFacts: ['目标：判断校史年份能否用于小报', '行为：标出AI给出的年份并查阅校志', '预期结果：能说明记录是否支持该年份'], fixedWording: ['我校创办于1958年'],
        stableTerms: ['待查说法', '可靠记录'], conceptBoundaries: ['语气肯定不等于事实正确'] },
      pageTask: { learnerAction: '判断要核对什么以及去哪里核对', newContribution: '建立核验链', reasoningFocus: '记录与说法是否直接相关',
        caseUse: 'introduce', changedConditions: [], preservedConditions: [] },
      teachingPlan: { purpose: '解释核验', priorKnowledge: '会搜索', newContent: '按相关记录核验', learnerQuestion: '肯定的语气可信吗',
        reasoningSteps: ['明确说法', '查相关记录'], takeaway: '有相关依据再采用', visibleContent: ['语气肯定 ≠ 事实正确'], narrationFocus: ['解释为什么查证'],
        taskConnection: { mode: 'none', rationale: '先用独立核验例子讲清证据关系。' },
        entryPoint: { kind: 'familiar-experience', object: '在班级小报中看到一个语气肯定的年份', bridge: '从是否敢直接采用，引出核验依据' } },
      understandingCriteria: { goals: ['能依据新说法选择核验记录'], answerEssentials: ['记录必须与说法直接相关'],
        misconceptions: ['语气肯定等于事实正确'], supportingUnitIds: ['unit-a'] },
    },
  };
}
function content(text = '语气肯定 ≠ 事实正确'): GeneratedSlideContent {
  return { elements: [{ id: 'rendered-text', type: 'text', left: 10, top: 10, width: 300, height: 80, rotate: 0,
    content: `<p>${text}</p>`, defaultFontName: 'Arial', defaultColor: '#333333' }] };
}
function raw(text = '先看看学校简介。它有没有写出这个年份？', cue = false) {
  return { segments: [{
    text,
    semanticIds: ['page-a:teaching', 'page-a:visible-1'],
    ...(cue ? { anchors: [{ semanticId: 'page-a:visible-1', quote: '学校简介', occurrence: 0,
      visualCue: { type: 'spotlight', necessity: 'helpful' } }] } : {}),
  }] };
}

function expectAuthoredTextSegments(
  generated: Awaited<ReturnType<typeof generateTeachingNarration>> | Awaited<ReturnType<typeof generateTeachingSectionNarration>>,
  authored: { pages?: Array<{ segments: Array<{ text?: string }> }>; segments?: Array<{ text?: string }> },
) {
  const resultSegments = 'pages' in generated ? generated.pages.flatMap((page) => page.segments) : generated.segments;
  const rawSegments = authored.pages?.flatMap((page) => page.segments) ?? authored.segments ?? [];
  for (const segment of rawSegments) if (typeof segment.text === 'string') {
    expect(resultSegments.map((value) => value.text)).toContain(segment.text);
  }
}

describe('independent first-pass teaching narration', () => {
  it('authors only a missing source insertion and locks existing causal reasoning and the other page', async () => {
    const first = { ...outline(), knowledgePointIds: ['collaboration'] };
    const second = { ...outline(), id: 'page-b', order: 1, knowledgePointIds: ['other'] };
    const original = '小组需要合理分工。如果任务分配不均，有的学生可能觉得自己被忽视，学习动力和信心都会受影响。';
    const firstDraft = normalizeTeachingNarration(raw(original), first);
    const secondDraft = normalizeTeachingNarration({ segments: [{ text: '另一页已经正确的案例与推理。', semanticIds: ['page-b:teaching'] }] }, second);
    const claim = '在协作学习中注意小组分工的合理安排';
    const aiCall = vi.fn().mockImplementation(async (_system, user) => {
      const prompt = JSON.parse(user);
      const slot = prompt.pages[0].insertionSlots.find((item: { offset: number }) => item.offset === '小组需要合理分工。'.length);
      return JSON.stringify({ pages: [{ pageId: first.id, insertions: [{ at: slot.id,
        textParts: [{ sourceRef: 'source-list-1-item-1' }] }] }] });
    });
    const generated = await generateTeachingSourceNarrationInsertions({ sectionId: 'collaboration',
      pages: [{ outline: first, content: content() }, { outline: second, content: content() }],
      drafts: [firstDraft, secondDraft], targetPageIds: [first.id],
      missingClaims: [{ resourceId: 'collaboration-source', label: claim }],
      sourceSequenceContracts: [{ resourceId: 'collaboration-source', required: true, knowledgePointIds: ['collaboration'],
        orderedSteps: [{ label: claim }, { label: '教师需要根据学生能力提供支持' }] }],
      requirements: { requirement: '补全分工条件，保留完整因果解释' }, aiCall,
    });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(generated.pages[0]?.segments[0]?.text).toBe(`小组需要合理分工。${claim}。如果任务分配不均，有的学生可能觉得自己被忽视，学习动力和信心都会受影响。`);
    expect(generated.pages[0]?.segments[0]?.id).toBe(firstDraft.segments[0]?.id);
    expect(generated.pages[1]).toBe(secondDraft);
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.sourceAuthoringDuties).toEqual([{ text: `${claim}。`, availableReferences: [{ pageId: first.id,
      sourceRef: 'source-list-1-item-1' }] }]);
    expect(prompt.pages[0].lockedNarration).toEqual(firstDraft);
    expect(aiCall.mock.calls[0][0]).toContain('do not return, rewrite, replace, summarize or delete');
  });

  it('rejects an invalid insertion schema without requesting or adopting a whole-page rewrite', async () => {
    const page = { ...outline(), knowledgePointIds: ['support'] };
    const old = normalizeTeachingNarration(raw('让学生在做项目过程中体会模型不断优化。'), page);
    const claim = '教学支架是可调节的';
    const aiCall = vi.fn().mockResolvedValueOnce(JSON.stringify({ pages: [{ pageId: page.id,
      segments: [{ text: '缩短后的解释' }] }] })).mockImplementationOnce(async (_system, user) => {
      const prompt = JSON.parse(user.slice(0, user.indexOf('\n\nTechnical insertion-schema correction only.')));
      return JSON.stringify({ pages: [{ pageId: page.id, insertions: [{ at: prompt.pages[0].insertionSlots[0].id,
        textParts: [{ sourceRef: 'source-list-1-item-1' }] }] }] });
    });
    await expect(generateTeachingSourceNarrationInsertions({ sectionId: 'support',
      pages: [{ outline: page, content: content() }], drafts: [old], targetPageIds: [page.id],
      missingClaims: [{ resourceId: 'support-source', label: claim }],
      sourceSequenceContracts: [{ resourceId: 'support-source', required: true, knowledgePointIds: ['support'], orderedSteps: [{ label: claim }] }],
      requirements: { requirement: '补全支架条件' }, aiCall,
    })).rejects.toThrow('unsupported field');
    expect(aiCall).toHaveBeenCalledOnce();
    expect(old.segments[0]?.text).toContain('让学生在做项目过程中体会模型不断优化');
  });

  it('rejects a foreign source-list claim before authoring an insertion', async () => {
    const page = { ...outline(), knowledgePointIds: ['support'] };
    const aiCall = vi.fn();
    await expect(generateTeachingSourceNarrationInsertions({ sectionId: 'support', pages: [{ outline: page, content: content() }],
      drafts: [normalizeTeachingNarration(raw(), page)], targetPageIds: [page.id],
      missingClaims: [{ resourceId: 'foreign-source', label: '教学支架是可调节的' }],
      sourceSequenceContracts: [{ resourceId: 'support-source', required: true, knowledgePointIds: ['support'], orderedSteps: [{ label: '教学支架是可调节的' }] }],
      requirements: { requirement: '来源身份不能借用' }, aiCall,
    })).rejects.toThrow('无法绑定到实际采用的来源');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('writes the detailed definition from the original book while the slide contains only a concise point', async () => {
    const definition = '只有各个个体具有明确的被抽取机会，随机抽样才能减少人为选择产生的偏差。';
    const page = { ...outline(), knowledgePointIds: ['sampling'],
      teachingBrief: { ...outline().teachingBrief!, evidence: [{ sourceId: 'book', quote: definition }],
        explanation: '设计阶段已压缩的解释', teachingPlan: { ...outline().teachingBrief!.teachingPlan!,
          newContent: '理解抽样机会', visibleContent: ['按随机规则抽取'], presentationContent: ['按随机规则抽取'] } } };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: 'page-a',
      segments: [{ textParts: [{ text: '先比较由老师挑选和按随机规则抽取的区别。' },
        { sourceRef: 'source-quote-1' }, { text: '比如只选择坐在前排的同学，就不能说明全班的情况。' }],
      semanticIds: ['page-a:teaching'] }] }] }));
    const generated = await generateTeachingSectionNarration({ sectionId: 'sampling',
      pages: [{ outline: page, content: content('按随机规则抽取') }],
      requirements: { requirement: '解释随机抽样' }, sourceKnowledgePoints: [{ id: 'sampling', evidenceItemIds: ['original'] }],
      sourceEvidence: { schemaVersion: 2, version: 1, fingerprint: 'book-v1', createdAt: '2026-09-30',
        retrievalMode: 'hybrid', selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }],
        mappings: [], warnings: [], items: [{ id: 'original', kind: 'concept', title: '随机抽样',
          content: '再次提炼过的摘要，不能作原文',
          source: { textbookId: 'book', textbookTitle: '统计教材', revisionId: 'book-v1', revisionVersion: 1,
            sectionPath: ['抽样方法'], sourceBlockId: 'source-paragraph', quote: definition },
          completeSourceBlocks: [{ sourceBlockId: 'source-paragraph', content: definition }] }] }, aiCall,
    });
    expect(aiCall).toHaveBeenCalledOnce();
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.pages[0].actualSlide.elements[0].content).toContain('按随机规则抽取');
    expect(prompt.pages[0].actualSlide.elements[0].content).not.toContain(definition);
    expect(prompt.pages[0].originalTeachingSources.originalSources[0].passages[0].text).toBe(definition);
    expect(prompt.pages[0].originalTeachingSources.originalQuotes).toEqual([definition]);
    const wire = JSON.parse(aiCall.mock.calls[0][1]);
    expect(Object.values(wire.evidenceCatalog.texts).filter((text) => text === definition)).toHaveLength(1);
    expect(wire.pages[0].originalTeachingSources).not.toHaveProperty('originalSources');
    expect(prompt.pages[0].originalTeachingSources.authoritativeAnchors).toEqual([{ id: 'source-quote-1', text: definition }]);
    expect(aiCall.mock.calls[0][0]).toContain('Do not expand condensed slide labels into an invented definition');
    expect(aiCall.mock.calls[0][0]).toContain('retain the source defining or qualifying wording once');
    expect(aiCall.mock.calls[0][0]).toContain('Do not read whole source paragraphs');
    expect(generated.pages[0]?.segments[0]?.text).toContain(definition);
    expect(generated.pages[0]?.segments[0]?.text).toContain('先比较由老师挑选和按随机规则抽取的区别。');
    expect(generated.pages[0]?.segments[0]?.text).toContain('比如只选择坐在前排的同学');
    expect(JSON.stringify(generated)).not.toContain('source-quote-1');
    expect(JSON.stringify(generated)).not.toContain('textParts');
    expect(aiCall.mock.calls[0][1]).not.toContain('再次提炼过的摘要');
  });

  it('authors canonical conditions as source references in natural speech in the first section call', async () => {
    const page = { ...outline(), knowledgePointIds: ['sampling'] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: 'page-a', segments: [{
      textParts: [{ text: '要让这个选择有意义，我们先检查覆盖范围。' },
        { sourceRef: 'source-list-1-item-1' }, { text: '。这意味着名单不能漏掉某一类同学。然后再检查选择机会，' },
        { sourceRef: 'source-list-2-item-1' }, { text: '。这样才能解释为什么它能减少人为偏差。' }],
      semanticIds: ['page-a:teaching'],
    }] }] }));
    const generated = await generateTeachingSectionNarration({ sectionId: 'sampling',
      pages: [{ outline: page, content: content('覆盖总体；明确抽取机会') }],
      requirements: { requirement: '解释抽样的两类条件' }, sourceSequenceContracts: [
        { resourceId: 'coverage', required: true, knowledgePointIds: ['sampling'],
          orderedSteps: [{ label: '抽样框需要覆盖目标总体' }] },
        { resourceId: 'probability', required: true, knowledgePointIds: ['sampling'],
          orderedSteps: [{ label: '各个个体必须具有明确的被抽取机会' }] },
      ], aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(generated.pages[0]?.segments[0]?.text).toContain('抽样框需要覆盖目标总体。这意味着名单不能漏掉某一类同学。');
    expect(generated.pages[0]?.segments[0]?.text).toContain('各个个体必须具有明确的被抽取机会。这样才能解释');
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.sourceAuthoringDuties).toEqual([
      { text: '抽样框需要覆盖目标总体。', availableReferences: [{ pageId: 'page-a', sourceRef: 'source-list-1-item-1' }] },
      { text: '各个个体必须具有明确的被抽取机会。', availableReferences: [{ pageId: 'page-a', sourceRef: 'source-list-2-item-1' }] },
    ]);
  });

  it('authors only each section’s owned source clauses while retaining the complete adopted textbook list', async () => {
    const labels = ['抽样框需要覆盖目标总体', '各个个体必须具有明确的被抽取机会'];
    const first: SceneOutline = { ...outline(), generationPurpose: 'knowledge-teaching', lectureSectionId: 'coverage',
      knowledgePointIds: ['coverage'], keyPoints: ['抽样框与总体'], teachingBrief: { ...outline().teachingBrief!,
        teachingPlan: { ...outline().teachingBrief!.teachingPlan!, visibleContent: [labels[0]!], presentationContent: ['抽样框与总体'] } } };
    const second: SceneOutline = { ...first, id: 'page-b', order: 1, lectureSectionId: 'probability',
      knowledgePointIds: ['probability'], keyPoints: ['随机抽取机会'], teachingBrief: { ...first.teachingBrief!,
        teachingPlan: { ...first.teachingBrief!.teachingPlan!, visibleContent: [labels[1]!], presentationContent: ['随机抽取机会'] } } };
    const contract: FigureSequenceContract = { resourceId: 'source-sequence:sampling', required: true,
      scope: 'knowledge-point', knowledgePointIds: ['coverage', 'probability'], sequenceSemantics: 'enumerated-items',
      orderedSteps: labels.map((label) => ({ label })) };
    const originalPassage = `${labels[0]}。名单不能漏掉目标总体中的某一类人。${labels[1]}。选择机会需要由抽取规则明确规定。`;
    const shared: Omit<Parameters<typeof generateTeachingSectionNarration>[0], 'sectionId' | 'pages' | 'aiCall'> = {
      requirements: { requirement: '按已确认归属分别解释覆盖范围和抽取机会' }, courseProgression: [first, second],
      sourceSequenceContracts: [contract], sourceKnowledgePoints: ['coverage', 'probability'].map((id) => ({ id,
        evidenceItemIds: ['sampling-original'] })), sourceEvidence: { schemaVersion: 2, version: 1,
        fingerprint: 'sampling-book', createdAt: '2026-09-30', retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [],
        items: [{ id: 'sampling-original', kind: 'source-block', title: '抽样的条件', content: originalPassage,
          source: { textbookId: 'book', textbookTitle: '统计教材', revisionId: 'book-v1', revisionVersion: 1,
            sectionPath: ['抽样条件'] }, sourceSequences: [{ anchorSourceBlockId: 'sampling', kind: 'ordered-steps',
              steps: labels.map((label, index) => ({ label, sourceBlockId: `condition-${index + 1}` })) }] }] },
    };
    const calls = [first, second].map((page, index) => vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: page.id,
      segments: [{ textParts: [{ text: '先看本页的必要条件。' }, { sourceRef: `source-list-1-item-${index + 1}` },
        { text: '通过这条条件判断这个选择能否代表目标总体。' }], semanticIds: [`${page.id}:teaching`] }] }] })));
    const generated = [];
    for (const [index, page] of [first, second].entries()) {
      const result = await generateTeachingSectionNarration({ ...shared, sectionId: page.lectureSectionId!,
        pages: [{ outline: page, content: content(page.keyPoints[0]) }], aiCall: calls[index]! });
      expect(calls[index]).toHaveBeenCalledOnce();
      const prompt = readNarrationPrompt(calls[index]!.mock.calls[0][1]);
      expect(prompt.sourceAuthoringDuties).toEqual([{ text: `${labels[index]}。`, availableReferences: [{
        pageId: page.id, sourceRef: `source-list-1-item-${index + 1}` }] }]);
      expect(prompt.pages[0].originalTeachingSources.requiredSourceLists[0].steps.map((step: { label: string }) => step.label))
        .toEqual(labels);
      expect(prompt.pages[0].originalTeachingSources.originalSources[0].passages[0].text).toBe(originalPassage);
      expect(prompt.pages[0].originalTeachingSources.authoritativeAnchors.map((anchor: { text: string }) => anchor.text))
        .toEqual(labels.map((label) => `${label}。`));
      expect(prompt.requiredOutputShape.pages[0].segments[0].textParts[1].sourceRef).toBe(`source-list-1-item-${index + 1}`);
      const speech = result.pages[0]!.segments.map((segment) => segment.text);
      expect(speech.join('\n')).toContain(labels[index]);
      expect(speech.join('\n')).not.toContain(labels[1 - index]);
      const spokenPage = { outline: page, content: content(page.keyPoints[0]), speech };
      expect(findSectionSourceContentIssues([first, second], [spokenPage], [contract])).toEqual([]);
      generated.push(spokenPage);
    }
    expect(findSourceContentIssues(generated, [contract])).toEqual([]);
    expect(findSourceContentIssues([{ ...generated[0]! }, { ...generated[1]!, speech: [] }], [contract])[0]?.missingCanonicalLabels)
      .toEqual([labels[1]]);
  });

  it('guides canonical references to their explanation pages without rejecting the first draft', async () => {
    const labels = ['抽样框需要覆盖目标总体', '各个个体必须具有明确的被抽取机会'];
    const first: SceneOutline = { ...outline(), generationPurpose: 'knowledge-teaching', lectureSectionId: 'sampling',
      knowledgePointIds: ['sampling'], keyPoints: [labels[0]!], teachingBrief: { ...outline().teachingBrief!,
        teachingPlan: { ...outline().teachingBrief!.teachingPlan!, visibleContent: [labels[0]!] } } };
    const second: SceneOutline = { ...first, id: 'page-b', order: 1, keyPoints: [labels[1]!],
      teachingBrief: { ...first.teachingBrief!, teachingPlan: { ...first.teachingBrief!.teachingPlan!, visibleContent: [labels[1]!] } } };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [
      { pageId: first.id, segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' },
        { sourceRef: 'source-list-1-item-2' }], semanticIds: [`${first.id}:teaching`] }] },
      { pageId: second.id, segments: [{ text: '这一页继续解释选择机会。', semanticIds: [`${second.id}:teaching`] }] },
    ] }));
    expectAuthoredTextSegments(await (generateTeachingSectionNarration({ sectionId: 'sampling',
      pages: [{ outline: first, content: content() }, { outline: second, content: content() }], courseProgression: [first, second],
      sourceSequenceContracts: [{ resourceId: 'source-sequence:sampling', required: true, knowledgePointIds: ['sampling'],
        orderedSteps: labels.map((label) => ({ label })) }], requirements: { requirement: '各页承担自己的解释责任' }, aiCall,
    })), JSON.parse(await aiCall.mock.results[0]!.value));
    expect(aiCall).toHaveBeenCalledOnce();
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.sourceAuthoringDuties.map((duty: { availableReferences: unknown }) => duty.availableReferences)).toEqual([
      [{ pageId: first.id, sourceRef: 'source-list-1-item-1' }],
      [{ pageId: second.id, sourceRef: 'source-list-1-item-2' }],
    ]);
  });

  it('supplies an unassigned source clause to the first author without requiring a second draft', async () => {
    const labels = ['抽样框需要覆盖目标总体', '各个个体必须具有明确的被抽取机会'];
    const first: SceneOutline = { ...outline(), generationPurpose: 'knowledge-teaching', lectureSectionId: 'coverage',
      knowledgePointIds: ['sampling'], keyPoints: [labels[0]!], teachingBrief: { ...outline().teachingBrief!,
        teachingPlan: { ...outline().teachingBrief!.teachingPlan!, visibleContent: [labels[0]!] } } };
    const later: SceneOutline = { ...first, id: 'page-b', order: 1, lectureSectionId: 'probability', keyPoints: ['随机选择'],
      teachingBrief: { ...first.teachingBrief!, teachingPlan: { ...first.teachingBrief!.teachingPlan!, visibleContent: ['随机选择'] } } };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: first.id, segments: [{
      textParts: [{ sourceRef: 'source-list-1-item-1' }], semanticIds: [`${first.id}:teaching`],
    }] }] }));
    const contract: FigureSequenceContract = { resourceId: 'source-sequence:sampling', required: true,
      knowledgePointIds: ['sampling'], sequenceSemantics: 'enumerated-items', orderedSteps: labels.map((label) => ({ label })) };
    expectAuthoredTextSegments(await (generateTeachingSectionNarration({ sectionId: 'coverage', pages: [{ outline: first, content: content() }],
      courseProgression: [first, later], sourceSequenceContracts: [contract],
      requirements: { requirement: '全局未分配的必要条件不能消失' }, aiCall })), JSON.parse(await aiCall.mock.results[0]!.value));
    expect(aiCall).toHaveBeenCalledOnce();
    expect(readNarrationPrompt(aiCall.mock.calls[0][1]).sourceAuthoringDuties).toEqual(labels.map((label, index) => ({
      text: `${label}。`, availableReferences: [{ pageId: first.id, sourceRef: `source-list-1-item-${index + 1}` }],
    })));
    expect(findSectionSourceContentIssues([first, later], [{ outline: first, content: content('名单覆盖'), speech: [labels[0]!] }],
      [contract])[0]?.missingCanonicalLabels).toEqual([labels[1]]);
  });

  it('uses the same owned source clause and output example for independent page narration', async () => {
    const labels = ['抽样框需要覆盖目标总体', '各个个体必须具有明确的被抽取机会'];
    const first: SceneOutline = { ...outline(), generationPurpose: 'knowledge-teaching', lectureSectionId: 'coverage',
      knowledgePointIds: ['sampling'], keyPoints: [labels[0]!], teachingBrief: { ...outline().teachingBrief!,
        teachingPlan: { ...outline().teachingBrief!.teachingPlan!, visibleContent: [labels[0]!] } } };
    const later: SceneOutline = { ...first, id: 'page-b', order: 1, lectureSectionId: 'probability', keyPoints: [labels[1]!],
      teachingBrief: { ...first.teachingBrief!, teachingPlan: { ...first.teachingBrief!.teachingPlan!, visibleContent: [labels[1]!] } } };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ segments: [{
      textParts: [{ sourceRef: 'source-list-1-item-2' }, { text: '由规则规定机会，才能检查选择是否公平。' }],
      semanticIds: [`${later.id}:teaching`],
    }] }));
    const generated = await generateTeachingNarration({ outline: later, courseProgression: [first, later],
      sourceSequenceContracts: [{ resourceId: 'source-sequence:sampling', required: true,
        knowledgePointIds: ['sampling'], orderedSteps: labels.map((label) => ({ label })) }],
      requirements: { requirement: '本页只解释抽取机会' }, aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.sourceAuthoringDuties).toEqual([{ text: `${labels[1]}。`, availableReferences: [{
      pageId: later.id, sourceRef: 'source-list-1-item-2' }] }]);
    expect(prompt.requiredOutputShape.segments[0].textParts[1].sourceRef).toBe('source-list-1-item-2');
    expect(generated.segments[0]?.text).toContain(labels[1]);
    expect(generated.segments[0]?.text).not.toContain(labels[0]);
  });

  it('requires the verified original defining sentence instead of a condensed slide definition', async () => {
    const definition = '任务驱动式教学法，是一种依托趣味情境唤起学习热情与探究欲望、引导学生在达成任务中获得知识与技能的教学方法。';
    const rest = '教师还应根据学生已有知识选择任务，并通过测试反馈完善方案。';
    const page: SceneOutline = { ...outline(), knowledgePointIds: ['task-method'], teachingBrief: { ...outline().teachingBrief!,
      evidence: [{ sourceId: 'original-method', quote: definition + rest }] } };
    const reasoning = '小车防撞要求学生判断障碍距离，编程后再用测试反馈检查判断。';
    const aiCall = vi.fn().mockResolvedValueOnce(JSON.stringify({ pages: [{ pageId: page.id, segments: [{
        textParts: [{ sourceRef: 'source-definition-1' }, { text: reasoning }], semanticIds: ['page-a:teaching'],
      }] }] }));
    const input: Parameters<typeof generateTeachingSectionNarration>[0] = { sectionId: 'task-method', pages: [{ outline: page, content: content('围绕任务学习') }],
      requirements: { requirement: '解释任务驱动的方法与案例' }, aiCall,
      sourceKnowledgePoints: [{ id: 'task-method', evidenceItemIds: ['method-original'] }],
      sourceEvidence: { schemaVersion: 2, version: 1, fingerprint: 'method-book', createdAt: '2026-09-30',
        retrievalMode: 'hybrid', selections: [{ revisionId: 'book-v1', primary: true, sectionIds: [] }], mappings: [], warnings: [],
        items: [{ id: 'method-original', kind: 'source-block', title: '任务驱动式教学法', content: definition + rest,
          source: { textbookId: 'book', textbookTitle: '教学原理', revisionId: 'book-v1', revisionVersion: 1,
            sectionPath: ['教学方法'], sourceBlockId: 'method-definition' } }] } };
    const generated = await generateTeachingSectionNarration(input);
    expect(aiCall).toHaveBeenCalledTimes(1);
    const system = aiCall.mock.calls[0][0];
    expect(system).toContain('Canonical source-definition-N and source-list-N-item-M references must preserve the complete supplied defining sentence or condition unchanged');
    expect(system).toContain('A quote may select an unchanged contiguous excerpt');
    expect(system).not.toContain('For a meaning or definition reference, you may');
    expect(system).toContain('Do not output both text and textParts for one segment');
    expect(readNarrationPrompt(aiCall.mock.calls[0][1]).sourceAuthoringDuties).toEqual([{ text: definition,
      availableReferences: [{ pageId: page.id, sourceRef: 'source-definition-1' }] }]);
    expect(generated.pages[0]?.segments[0]?.text).toContain(definition + reasoning);
    expect(generated.pages[0]?.segments[0]?.text).not.toContain(rest);

    const cropped = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: page.id, segments: [{
      textParts: [{ sourceRef: 'source-definition-1', quote: '引导学生在达成任务中获得知识与技能' },
        { text: reasoning }], semanticIds: ['page-a:teaching'],
    }] }] }));
    const quoted = await generateTeachingSectionNarration({ ...input, aiCall: cropped });
    expect(quoted.pages[0]?.segments[0]?.text).toBe('引导学生在达成任务中获得知识与技能' + reasoning);
    expect(cropped).toHaveBeenCalledOnce();
  });

  it('allows a selected source meaning clause in the first section narration without cropping its canonical condition', async () => {
    const label = '任务应与学生已有知识相适应';
    const meaning = '必要线索帮助学生把已有经验用于新的问题。';
    const remainingSource = '教师还可以根据课程内容准备补充资源。';
    const sourceDescription = meaning + remainingSource;
    const page = { ...outline(), knowledgePointIds: ['task-support'] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: page.id, segments: [{
      textParts: [{ text: '先看任务的起点。' }, { sourceRef: 'source-list-1-item-1' },
        { sourceRef: 'source-list-1-item-1-meaning', quote: meaning },
        { text: '例如，先从学生会观察距离这一点出发，再解释小车怎样判断障碍。' }],
      semanticIds: ['page-a:teaching'],
    }] }] }));
    const generated = await generateTeachingSectionNarration({ sectionId: 'task-support',
      pages: [{ outline: page, content: content('从已有基础提供线索') }], requirements: { requirement: '解释任务支持' },
      sourceSequenceContracts: [{ resourceId: 'source-sequence:task-support', required: true,
        knowledgePointIds: ['task-support'], orderedSteps: [{ label }] }],
      sourceKnowledgePoints: [{ id: 'task-support', evidenceItemIds: ['support-original'] }],
      sourceEvidence: { schemaVersion: 2, version: 1, fingerprint: 'support-book', createdAt: '2026-09-30',
        retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [], items: [{ id: 'support-original',
          kind: 'source-block', title: '教学任务支持', content: sourceDescription,
          source: { textbookId: 'book', textbookTitle: '教学原理', revisionId: 'book-v1', revisionVersion: 1,
            sectionPath: ['任务支持'] }, sourceSequences: [{ anchorSourceBlockId: 'task-support', kind: 'ordered-steps',
            steps: [{ label, sourceBlockId: 'support-condition', excerpt: sourceDescription }] }] }] }, aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(aiCall.mock.calls[0][0]).toContain('A quote may select an unchanged contiguous excerpt');
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.pages[0].originalTeachingSources.authoritativeAnchors)
      .toContainEqual({ id: 'source-list-1-item-1-meaning', text: sourceDescription });
    expect(generated.pages[0]?.segments[0]?.text).toContain(`${label}。${meaning}`);
    expect(generated.pages[0]?.segments[0]?.text).toContain('学生会观察距离');
    expect(generated.pages[0]?.segments[0]?.text).not.toContain(remainingSource);
  });

  it('expands only the chosen original definition in legacy page authoring and keeps the surrounding voice', async () => {
    const definition = '核验需要能直接支持具体说法的可靠记录。';
    const page = { ...outline(), teachingBrief: { ...outline().teachingBrief!,
      evidence: [{ sourceId: 'book', quote: definition }] } };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ segments: [{
      textParts: [{ text: '先看这句话究竟说了什么。' }, { sourceRef: 'source-quote-1' },
        { text: '因此校志上的创办年份可以帮助我们判断这条校史说法。' }],
      semanticIds: ['page-a:teaching'],
    }] }));
    const generated = await generateTeachingNarration({ outline: page,
      requirements: { requirement: '解释说法核验' }, aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(generated.segments[0]?.text).toContain(`先看这句话究竟说了什么。${definition}因此校志`);
    expect(JSON.stringify(generated)).not.toContain('source-quote-1');
  });

  it('provides the original concept mechanism beside the first authoring duty instead of a condensed slide expansion', async () => {
    const label = '学习空间的延展性';
    const sourceDescription = '拓展性资源使学生自主探索并解决问题，将学到的知识和技能迁移到新的情境中，促进深层次理解。';
    const page = { ...outline(), knowledgePointIds: ['authentic-learning'] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: page.id, segments: [{
      textParts: [{ text: '这种学习还具有' }, { sourceRef: 'source-list-1-item-1' },
        { text: '。' }, { sourceRef: 'source-list-1-item-1-meaning' },
        { text: '例如，学生可以把在避障小车中理解的传感器判断用于新的提醒装置。' }],
      semanticIds: ['page-a:teaching'],
    }] }] }));
    const generated = await generateTeachingSectionNarration({ sectionId: 'authentic-learning', pages: [{ outline: page,
      content: content('学习不限于固定教室') }], requirements: { requirement: '解释抛锚式教学特征' },
      sourceSequenceContracts: [{ resourceId: 'source-sequence:authentic-features', required: true,
        knowledgePointIds: ['authentic-learning'], orderedSteps: [{ label }] }],
      sourceKnowledgePoints: [{ id: 'authentic-learning', evidenceItemIds: ['authentic-original'] }],
      sourceEvidence: { schemaVersion: 2, version: 1, fingerprint: 'authentic-book', createdAt: '2026-09-30',
        retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [], items: [{ id: 'authentic-original',
          kind: 'source-block', title: '抛锚式教学特征', content: sourceDescription,
          source: { textbookId: 'book', textbookTitle: '教学原理', revisionId: 'book-v1', revisionVersion: 1,
            sectionPath: ['教学原理'] }, sourceSequences: [{ anchorSourceBlockId: 'authentic-features',
            kind: 'ordered-steps', steps: [{ label, sourceBlockId: 'feature-5', excerpt: sourceDescription }] }] }] },
      aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(generated.pages[0]?.segments[0]?.text).toContain(sourceDescription);
    expect(generated.pages[0]?.segments[0]?.text).toContain('避障小车');
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.sourceAuthoringDuties).toEqual([{ text: `${label}。${sourceDescription}`, availableReferences: [{ pageId: page.id,
      sourceRef: 'source-list-1-item-1', sourceDescriptions: [sourceDescription],
      meaningSourceRef: 'source-list-1-item-1-meaning' }] }]);
    expect(prompt.pages[0].originalTeachingSources.authoritativeAnchors)
      .toContainEqual({ id: 'source-list-1-item-1-meaning', text: sourceDescription });
    expect(aiCall.mock.calls[0][0]).toContain('Teach their essential mechanism, scope and necessary conditions');
    expect(aiCall.mock.calls[0][0]).toContain('The adopted examples in stableTeachingMaterials and examples are part');
    expect(prompt.requiredOutputShape.pages[0].segments[0].textParts[2].text).not.toMatch(/^。/u);
  });

  it('keeps identically named duties from independent source lists separate', async () => {
    const page = { ...outline(), knowledgePointIds: ['sampling'] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: page.id, segments: [{
      textParts: [{ text: '先讨论随机选择中的' }, { sourceRef: 'source-list-1-item-1' },
        { text: '，再区分证据判断中的' }, { sourceRef: 'source-list-2-item-1' }, { text: '，两者承担不同的条件。' }],
      semanticIds: ['page-a:teaching'],
    }] }] }));
    await generateTeachingSectionNarration({ sectionId: 'sampling', pages: [{ outline: page, content: content() }],
      requirements: { requirement: '区分不同来源的独立性' }, aiCall,
      sourceSequenceContracts: ['random-selection', 'evidence-records'].map((resourceId) => ({ resourceId,
        required: true, knowledgePointIds: ['sampling'], orderedSteps: [{ label: '独立性' }] })) });
    expect(readNarrationPrompt(aiCall.mock.calls[0][1]).sourceAuthoringDuties).toEqual([
      { text: '独立性。', availableReferences: [{ pageId: page.id, sourceRef: 'source-list-1-item-1' }] },
      { text: '独立性。', availableReferences: [{ pageId: page.id, sourceRef: 'source-list-2-item-1' }] },
    ]);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it.each(['section', 'page'] as const)('keeps text-only %s narration while providing precise source slots to the first author', async (mode) => {
    const page = { ...outline(), knowledgePointIds: ['sampling'] };
    const claim = '各个个体必须具有明确的被抽取机会';
    const reasoning = '只挑坐在前排的同学，不能说明全班的情况。';
    const wrap = (segments: unknown[]) => mode === 'section'
      ? { pages: [{ pageId: page.id, segments }] } : { segments };
    const invalid = JSON.stringify(wrap([{ text: `抽取机会要明确。${reasoning}`, semanticIds: ['page-a:teaching'] }]));
    const corrected = JSON.stringify(wrap([{ textParts: [{ sourceRef: 'source-list-1-item-1' },
      { text: `。${reasoning}` }], semanticIds: ['page-a:teaching'] }]));
    const aiCall = vi.fn().mockResolvedValueOnce(invalid).mockResolvedValueOnce(corrected);
    const shared = { requirements: { requirement: '解释抽样机会' }, aiCall,
      sourceSequenceContracts: [{ resourceId: 'sampling-condition', required: true, knowledgePointIds: ['sampling'],
        orderedSteps: [{ label: claim }] }] };
    expectAuthoredTextSegments(await (mode === 'section'
      ? generateTeachingSectionNarration({ ...shared, sectionId: 'sampling', pages: [{ outline: page, content: content() }] })
      : generateTeachingNarration({ ...shared, outline: page })), JSON.parse(await aiCall.mock.results[0]!.value));
    expect(aiCall).toHaveBeenCalledOnce();

  });

  it.each(['section', 'page'] as const)('keeps the first %s draft without a missing-source interruption or invented claim', async (mode) => {
    const page = { ...outline(), knowledgePointIds: ['sampling'] };
    const segments = [{ text: '抽样框的覆盖性，这个名称本身还没有解释条件。', semanticIds: ['page-a:teaching'] }];
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(mode === 'section'
      ? { pages: [{ pageId: page.id, segments }] } : { segments }));
    const shared = { requirements: { requirement: '解释抽样框' }, aiCall,
      sourceSequenceContracts: [{ resourceId: 'sampling-frame', required: true, knowledgePointIds: ['sampling'],
        orderedSteps: [{ label: '抽样框需要覆盖目标总体' }] }] };
    expectAuthoredTextSegments(await (mode === 'section'
      ? generateTeachingSectionNarration({ ...shared, sectionId: 'sampling', pages: [{ outline: page, content: content() }] })
      : generateTeachingNarration({ ...shared, outline: page })), JSON.parse(await aiCall.mock.results[0]!.value));
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('authors only verified recovery targets while retaining the other pages as text-only context', async () => {
    const first = { ...outline(), knowledgePointIds: ['first-source'] };
    const second = { ...outline(), id: 'page-b', order: 1, knowledgePointIds: ['second-source'] };
    const savedSecond = '已经确认的第二页解释和案例保持原稿。';
    const response = JSON.stringify({ pages: [
      { pageId: first.id, segments: [{ textParts: [{ sourceRef: 'source-list-1-item-1' },
        { text: '。名单不能漏掉某类同学。' }], semanticIds: ['page-a:teaching'] }] },
      { pageId: second.id, segments: [{ text: savedSecond, semanticIds: ['page-b:teaching'] }] },
    ] });
    const aiCall = vi.fn().mockResolvedValue(response);
    const input = { sectionId: 'sampling', pages: [{ outline: first, content: content() }, { outline: second, content: content() }],
      requirements: { requirement: '仅恢复第一页面来源条件' }, aiCall,
      sourceSequenceContracts: [
        { resourceId: 'frame', required: true, knowledgePointIds: ['first-source'], orderedSteps: [{ label: '覆盖目标总体' }] },
        { resourceId: 'chance', required: true, knowledgePointIds: ['second-source'], orderedSteps: [{ label: '明确抽取机会' }] },
      ] };
    const generated = await generateTeachingSectionNarration({ ...input, sourceAuthoringPageIds: [first.id] });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(generated.pages[0]?.segments[0]?.text).toContain('覆盖目标总体。名单不能漏掉某类同学。');
    expect(generated.pages[1]?.segments[0]?.text).toContain(savedSecond);
    expect(readNarrationPrompt(aiCall.mock.calls[0][1]).sourceAuthoringDuties).toEqual([{ text: '覆盖目标总体。',
      availableReferences: [{ pageId: first.id, sourceRef: 'source-list-1-item-1' }] }]);
    aiCall.mockClear();
    expectAuthoredTextSegments(await (generateTeachingSectionNarration(input)), JSON.parse(await aiCall.mock.results[0]!.value));
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it.each([[], ['foreign-page'], ['page-a', 'foreign-page']].map((sourceAuthoringPageIds) => ({ sourceAuthoringPageIds })))('rejects an invalid source authoring recovery scope $sourceAuthoringPageIds before a model call', async ({ sourceAuthoringPageIds }) => {
    const aiCall = vi.fn();
    await expect(generateTeachingSectionNarration({ sectionId: 'sampling', pages: [{ outline: outline(), content: content() }],
      requirements: { requirement: '范围不能跳过来源合同' }, sourceAuthoringPageIds, aiCall })).rejects.toThrow('编写范围');
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('projects an adopted worked case from review metadata into the first spoken output responsibility', async () => {
    const page = { ...outline(), teachingBrief: { ...outline().teachingBrief!, examples: [], reviewItems: [
      { id: 'adopted-case', kind: 'constructed-example' as const, provenance: 'constructed' as const,
        content: '小车遇到障碍前停车，学生已会读取传感器数值。', teachingPurpose: '解释任务如何要求目标知识', source: '' },
      { id: 'pending-claim', kind: 'unverified-claim' as const, provenance: 'unverified' as const,
        content: '未确认的试验效果', teachingPurpose: '待复核', source: '' },
    ] } };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{ pageId: page.id, segments: [{
      text: '先看小车遇到障碍前停车的任务。读到传感器数值后，还要根据障碍距离作出判断，才能决定是否停车。',
      semanticIds: ['page-a:teaching'],
    }] }] }));
    const generated = await generateTeachingSectionNarration({ sectionId: 'case-a',
      pages: [{ outline: page, content: content() }], requirements: { requirement: '解释任务与知识的对应' }, aiCall });
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.pages[0].requiredCaseApplications).toEqual([{ id: 'page-a:adopted-case-1',
      facts: '小车遇到障碍前停车，学生已会读取传感器数值。', explanationPurpose: '解释任务如何要求目标知识' }]);
    expect(prompt.requiredOutputShape.pages[0].segments[1].text).toContain('小车遇到障碍前停车');
    expect(prompt.pages[0].requiredCaseApplications).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ facts: '未确认的试验效果' }),
    ]));
    expect(generated.pages[0]?.segments[0]?.text).toContain('作出判断');
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('makes rendered table rows addressable for repeated case and correction cues in the first call', async () => {
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({
      pages: [{ pageId: 'page-a', segments: [{
        text: '如果学生做出作品，就需要交付。只看资料还不足以形成结论。',
        semanticIds: ['page-a:teaching'],
      }] }],
    }));
    const table = {
      elements: [{
        id: 'real-table', type: 'table', left: 20, top: 100, width: 600, height: 240, rotate: 0,
        outline: {}, colWidths: [0.4, 0.6], cellMinHeight: 40,
        data: [
          [{ id: 'head', text: '模式', colspan: 1, rowspan: 1 }],
          [{ id: 'case-a', text: '<b>交付作品</b>', colspan: 1, rowspan: 1 }],
          [{ id: 'case-b', text: '收集证据', colspan: 1, rowspan: 1 }],
        ],
      }],
    } as unknown as GeneratedSlideContent;
    await generateTeachingSectionNarration({
      sectionId: 'section-a', pages: [{ outline: outline(), content: table }],
      requirements: { requirement: '讲清比较' }, aiCall,
    });
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.pages[0].actualSlide.elements[0].table.rows).toEqual([
      { rowIndex: 0, cells: [{ columnIndex: 0, text: '模式' }] },
      { rowIndex: 1, cells: [{ columnIndex: 0, text: '交付作品' }] },
      { rowIndex: 2, cells: [{ columnIndex: 0, text: '收集证据' }] },
    ]);
    expect(prompt.visualCueExamples.tableRowReturn.anchors.map((anchor: { target: { selector: { rowIndex: number } } }) => anchor.target.selector.rowIndex))
      .toEqual([1, 2, 1, 2]);
    expect(aiCall.mock.calls[0][0]).toContain('Multiple anchors may share one semanticId within one segment');
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('authors a complete section after seeing every actual slide and returns each page once', async () => {
    const first = {
      ...outline(), lectureSectionId: 'section-a', teachingUnitIds: ['unit-a'],
      teachingToolPlan: [{
        tool: 'laser-pointer' as const,
        trigger: '沿核验步骤讲解时',
        purpose: '依次指示步骤',
        content: ['明确说法', '查相关记录'],
      }],
    };
    const second: SceneOutline = {
      ...outline(), id: 'page-b', title: '相关记录怎样支持说法', order: 1, lectureSectionId: 'section-a',
      teachingUnitIds: ['unit-a'],
      teachingBrief: { ...outline().teachingBrief!, teachingPlan: {
        ...outline().teachingBrief!.teachingPlan!, priorKnowledge: '已经明确待查说法',
        newContent: '只有直接记录该事实的材料才能支持结论', visibleContent: ['记录与说法必须直接相关'],
      } },
    };
    const response = { pages: [
      { pageId: 'page-a', segments: [{ text: '先明确我们要核验的具体说法。', semanticIds: ['page-a:teaching'] }] },
      { pageId: 'page-b', segments: [{ text: '接着判断记录是否直接回答这个说法。', semanticIds: ['page-b:teaching', 'page-b:visible-1'] }] },
    ] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));
    const generated = await generateTeachingSectionNarration({
      sectionId: 'section-a', pages: [{ outline: first, content: content() }, { outline: second, content: content('记录与说法必须直接相关') }],
      requirements: { requirement: '讲清核验方法' }, courseTitle: 'AI信息核验', courseProgression: [first, second],
      agents: [{ id: 'teacher', name: '林老师', role: 'teacher', persona: '温暖、清楚地逐步解释。' }], aiCall,
    });
    expect(generated.pages.map((page) => page.pageId)).toEqual(['page-a', 'page-b']);
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(prompt.pages).toHaveLength(2);
    expect(prompt.pages[0].actualSlide.elements[0].content).toContain('语气肯定');
    expect(aiCall.mock.calls[0][0]).toContain('actual slide is the authority only for what is visible');
    expect(aiCall.mock.calls[0][0]).toContain('Advance one line of understanding across pages');
    expect(aiCall.mock.calls[0][0]).toContain('intermediate causal or inferential links explicit');
    expect(aiCall.mock.calls[0][0]).toContain('introduces, deepens, and references as page ownership');
    expect(aiCall.mock.calls[0][0]).toContain('actual relationship on the slide');
    expect(aiCall.mock.calls[0][0]).toContain('local explanatory value, learner familiarity');
    expect(aiCall.mock.calls[0][0]).toContain('Do not end its speech by asking learners to judge true or false');
    expect(aiCall.mock.calls[0][0]).toContain('Provenance classifications and review notes are teacher-only');
    expect(aiCall.mock.calls[0][0]).toContain('Present the knowledge, example, image, or activity directly');
    expect(aiCall.mock.calls[0][0]).toContain('teachingPlan.taskConnection as a hard page boundary');
    expect(aiCall.mock.calls[0][0]).toContain('standalone AI resource must feel complete');
    expect(aiCall.mock.calls[0][0]).toContain('synthesize what the learner can now explain or do');
    expect(aiCall.mock.calls[0][0]).toContain('温暖、清楚地逐步解释');
    expect(aiCall.mock.calls[0][0]).toContain('copy each anchor quote as one contiguous substring from that exact finalized segment text');
    expect(aiCall.mock.calls[0][0]).toContain('One natural segment may contain several visual focus changes');
    expect(aiCall.mock.calls[0][0]).toContain('Do not split fluent speech merely to end a visual cue');
    expect(aiCall.mock.calls[0][0]).toContain('read verbatim by TTS to learners');
    expect(aiCall.mock.calls[0][0]).toContain('常见混淆：把探究式当自由看资料');
    expect(aiCall.mock.calls[0][0]).toContain('even after a complete lead-in');
    expect(aiCall.mock.calls[0][0]).toContain('放到同一个主题上');
    expect(aiCall.mock.calls[0][0]).toContain('The speech quote and visual target are independent');
    expect(aiCall.mock.calls[0][0]).toContain('not at the first incidental mention');
    expect(aiCall.mock.calls[0][0]).toContain('exact zero-based occurrence');
    expect(aiCall.mock.calls[0][0]).toContain('spotlight that continues across sentences');
    expect(aiCall.mock.calls[0][0]).toContain('Choose spotlight for sustained explanation of text');
    expect(aiCall.mock.calls[0][0]).toContain('repeat the row-specific cues at each correction sentence');
    expect(aiCall.mock.calls[0][0]).toContain('the teacher must still say the actual process steps');
    expect(aiCall.mock.calls[0][0]).toContain('finish the example comparison before returning to each misconception');
    expect(aiCall.mock.calls[0][0]).toContain('Never join successive case comparisons or misconception corrections with semicolons');
    expect(aiCall.mock.calls[0][0]).toContain('multi-target laser only to trace an explicit order');
    expect(aiCall.mock.calls[0][0]).toContain('A comparison of prose blocks or table rows is not a laser path');
    expect(prompt.visualCueExamples.orderedPath.waypoints[0].elementId).toContain('actualSlide');
    expect(prompt.pages[0].explanation).toContain('记录需要与具体说法相关');
    expect(prompt.pages[0].teachingPlan.visibleContent).toEqual(['语气肯定 ≠ 事实正确']);
    expect(prompt.pages[0].learningBoundary.futureKnowledge).toEqual([
      { id: 'source-independence', name: '来源独立性' },
    ]);
    expect(aiCall.mock.calls[0][0]).toContain('futureKnowledge may be named only in an agenda or goal');
    expect(prompt.pages[0].deliveryContext).toMatchObject({ sectionPosition: 'course-first', pageIndex: 1, courseTitle: 'AI信息核验' });
    expect(prompt.pages[1].continuityContract).toMatchObject({
      position: 'continuation',
      previousPageId: 'page-a',
      establishedTakeaway: '有相关依据再采用',
    });
    expect(aiCall.mock.calls[0][0]).toContain('continuityContract as a closed-world handoff');
    expect(prompt.pages[0].teachingPlan.entryPoint.object).toContain('班级小报');
    expect(prompt.pages[0].visualActionIntent[0]).toMatchObject({ tool: 'laser-pointer', purpose: '依次指示步骤' });
    expect(prompt.teacherVoice).toEqual({ name: '林老师', role: 'teacher' });
    expectAuthoredTextSegments(generated, response);
    expect(aiCall).toHaveBeenCalledOnce();
    expect(() => normalizeTeachingSectionNarration({ pages: [response.pages[0], response.pages[0]] }, 'section-a', [first, second])).toThrow('重复返回页面');
    expect(() => normalizeTeachingSectionNarration({ pages: [response.pages[0]] }, 'section-a', [first, second])).toThrow('缺少页面');
  });

  it('replaces an invented previous-page lead while retaining the first verified current-page anchor', () => {
    const previous = outline();
    const current: SceneOutline = {
      ...outline(),
      id: 'page-b',
      title: '两条判断依据',
      teachingBrief: {
        ...outline().teachingBrief!,
        teachingPlan: {
          ...outline().teachingBrief!.teachingPlan!,
          purpose: '用判断依据区分三类表述',
          newContent: '判断一段表述是否规定稳定结构',
          visibleContent: ['这段表述有没有规定一套相对固定、可以重复的结构或流程？'],
          entryPoint: {
            kind: 'continuation',
            object: '有相关依据再采用',
            bridge: '从已经建立的核验要求进入第一条判断依据',
          },
        },
      },
    };
    const quote = '这段表述有没有规定一套相对固定、可以重复的结构或流程';
    const text = `上一页留下两个疑问：项目式学习算模式还是方法？建构主义怎么用？判据一：${quote}？有，就在模式层。`;
    const grounded = groundPreviousPageNarrationLead({
      id: 'page-b:speech-1',
      pageId: 'page-b',
      text,
      semanticIds: ['page-b:teaching', 'page-b:visible-1'],
      anchors: [{ id: 'a1', semanticId: 'page-b:visible-1', quote, occurrence: 0 }],
    }, previous, current);

    expect(grounded).toContain('从已经建立的核验要求进入第一条判断依据');
    expect(grounded).not.toContain('有相关依据再采用');
    expect(grounded).toContain(quote);
    expect(grounded).not.toContain('项目式学习');
    expect(grounded).not.toContain('建构主义');

    const withoutAnchor = groundPreviousPageNarrationLead({
      id: 'page-b:speech-1',
      pageId: 'page-b',
      text: '上一页留下了一个并未讲过的项目问题，下面继续。',
      semanticIds: ['page-b:teaching'],
    }, previous, current);
    expect(withoutAnchor).toContain('判断一段表述是否规定稳定结构');
    expect(withoutAnchor).not.toContain('并未讲过的项目问题');
  });

  it('does not prepend another transition to an adopted bridge that already starts with one', () => {
    const previous = outline();
    const current: SceneOutline = {
      ...outline(), id: 'page-b',
      teachingBrief: {
        ...outline().teachingBrief!,
        teachingPlan: {
          ...outline().teachingBrief!.teachingPlan!,
          entryPoint: {
            kind: 'continuation', object: '项目式的成果要求',
            bridge: '那么这里的作品为什么重要',
          },
        },
      },
    };
    const quote = '项目式必须交付最终作品';
    const grounded = groundPreviousPageNarrationLead({
      id: 'page-b:speech-1', pageId: 'page-b',
      text: `上一页已经说过作品。${quote}。`,
      semanticIds: ['page-b:teaching'],
      anchors: [{ id: 'a1', semanticId: 'page-b:teaching', quote, occurrence: 0 }],
    }, previous, current);
    expect(grounded).toBe(`那么这里的作品为什么重要。${quote}。`);
  });

  it('retains a full authoritative definition and example when a retrospective lead has no visual anchor', () => {
    const previous = outline();
    const current = { ...outline(), id: 'page-b' };
    const explanation = '只有各个个体具有明确的被抽取机会，随机抽样才能减少人为选择产生的偏差。比如只选择坐在前排的同学，就无法代表全班。';
    const grounded = groundPreviousPageNarrationLead({ id: 'page-b:speech-1', pageId: 'page-b',
      text: `上一页留下了一个并未讲过的项目问题。${explanation}`, semanticIds: ['page-b:teaching'] }, previous, current);
    expect(grounded).toContain(explanation);
    expect(grounded).not.toContain('并未讲过的项目问题');
  });

  it('preserves the current concept name and natural introduction before a visual anchor inside its definition', () => {
    const current: SceneOutline = { ...outline(), id: 'page-b', title: '任务驱动式教学法',
      teachingBrief: { ...outline().teachingBrief!, teachingPlan: { ...outline().teachingBrief!.teachingPlan!,
        entryPoint: { kind: 'continuation', object: '方法的作用', bridge: '先看最常用于操作性强内容的一种方法' } } } };
    const explanation = '接下来，在具体的课堂上，需要方法让学生调用知识。任务驱动式教学法很适合操作性强的内容。它的定义是：依托于趣味盎然的教学情景，引导学生在完成任务中获得知识和技能。比如小车防撞要求学生用条件判断。';
    const grounded = groundPreviousPageNarrationLead({ id: 'page-b:speech-1', pageId: 'page-b',
      text: `上一页已经讨论过一个未经证实的课堂结论。${explanation}`, semanticIds: ['page-b:teaching'],
      anchors: [{ id: 'definition', semanticId: 'page-b:teaching', quote: '依托于趣味盎然的教学情景', occurrence: 0 }],
    }, outline(), current);
    expect(grounded).toBe(explanation);
    expect(grounded).not.toContain('最常用于');
    expect(grounded).not.toContain('未经证实');
  });

  it('uses the full progression when a section preview is followed by a quiz', async () => {
    const page = { ...outline(), order: 4, lectureSectionId: 'section-a' };
    const quiz: SceneOutline = {
      id: 'quiz-a', type: 'quiz', title: '小节检测', description: '检查本节理解', keyPoints: [], order: 5,
      stageKey: 'ai-learning', lectureSectionId: 'section-a',
    };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{
      pageId: page.id,
      segments: [{
        text: '现在已经掌握了本节方法。今天的课程就到这里，谢谢大家，同学们再见。',
        semanticIds: ['page-a:teaching'],
      }],
    }] }));

    const generated = await generateTeachingSectionNarration({
      sectionId: 'section-a',
      pages: [{ outline: page, content: content() }],
      requirements: { requirement: '讲清核验方法' },
      courseProgression: [page, quiz],
      aiCall,
    });

    const text = generated.pages[0]?.segments[0]?.text ?? '';
    expect(text).toBe('现在已经掌握了本节方法。今天的课程就到这里，谢谢大家，同学们再见。');
    const [, prompt] = aiCall.mock.calls[0] ?? [];
    expect(prompt).not.toContain('"title":"小节检测"');
  });

  it('authors a post-quiz section opening from prior spoken knowledge and its actual first slide', async () => {
    const prior: SceneOutline = {
      ...outline(), id: 'prior', lectureSectionId: 'section-a', order: 0, generationPurpose: 'knowledge-teaching',
    };
    const quiz: SceneOutline = {
      id: 'quiz-a', type: 'quiz', title: '第 1 节 · 节末小测', description: '检验核验依据',
      keyPoints: [], order: 1, lectureSectionId: 'section-a', stageKey: 'ai-learning',
      assessmentTargets: [{ unitId: 'unit-a', knowledgePointId: 'kp-a', unitTitle: '核验', learningOutcome: '说明记录为什么支持说法' }],
    };
    const first: SceneOutline = {
      ...outline(), id: 'page-a', order: 2, lectureSectionId: 'section-b', generationPurpose: 'knowledge-teaching',
      teachingBrief: {
        ...outline().teachingBrief!,
        teachingPlan: {
          ...outline().teachingBrief!.teachingPlan!,
          newContent: '比较记录之间是否相互独立',
          visibleContent: ['两条独立记录与一条重复转载'],
        },
      },
    };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{
      pageId: first.id,
      segments: [{ text: '刚才已经知道记录要与说法相关。接下来比较两条记录是否相互独立。', semanticIds: ['page-a:teaching'] }],
    }] }));
    await generateTeachingSectionNarration({
      sectionId: 'section-b', pages: [{ outline: first, content: content('两条独立记录与一条重复转载') }],
      requirements: { requirement: '讲清核验方法' },
      courseProgression: [prior, quiz, first],
      previousSectionActualNarration: ['先明确说法，再查与说法直接相关的记录。'],
      aiCall,
    });

    const system = aiCall.mock.calls[0][0] as string;
    const prompt = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(system).toContain('previousSectionQuizFocus only as the skill checked');
    expect(system).toContain('let the current page end with the concrete reason the next idea is needed');
    expect(prompt.pages[0].deliveryContext).toMatchObject({ sectionPosition: 'section-first' });
    expect(prompt.pages[0].continuityContract).toMatchObject({
      position: 'section-opening',
      previousSectionTakeaways: ['有相关依据再采用'],
      previousSectionQuizFocus: ['说明记录为什么支持说法'],
      previousSectionActualNarration: ['先明确说法，再查与说法直接相关的记录。'],
      currentNewContent: '比较记录之间是否相互独立',
      firstActualVisibleEvidence: ['两条独立记录与一条重复转载'],
    });
    expect(prompt).not.toContain('第 1 节 · 节末小测');
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('keeps only one farewell when the draft closes in consecutive segments', async () => {
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{
      pageId: 'page-a',
      segments: [
        { text: '谢谢大家，同学们再见。', semanticIds: ['page-a:teaching'] },
        { text: '最后记住：先找到与说法直接相关的记录。', semanticIds: ['page-a:teaching'] },
      ],
    }] }));

    const generated = await generateTeachingSectionNarration({
      sectionId: 'standalone',
      pages: [{ outline: outline(), content: content() }],
      requirements: { requirement: '讲清核验方法' },
      aiCall,
    });

    const text = generated.pages[0]?.segments.map((segment) => segment.text).join(' ') ?? '';
    expect(text).toContain('最后记住');
    expect(text.match(/同学们再见/g)).toHaveLength(1);
  });

  it('preserves an embedded first-draft welcome for final teacher review', async () => {
    const embedded = { ...outline(), narrationMode: 'embedded-segment' as const };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [{
      pageId: embedded.id,
      segments: [{ text: '同学们好，欢迎来到今天的课堂。先观察这条记录。', semanticIds: ['page-a:teaching'] }],
    }] }));

    const generated = await generateTeachingSectionNarration({
      sectionId: 'embedded-section',
      pages: [{ outline: embedded, content: content() }],
      requirements: { requirement: '作为课程中的补充资源' },
      courseProgression: [embedded],
      aiCall,
    });

    expect(generated.pages[0]?.segments[0]?.text).toBe('同学们好，欢迎来到今天的课堂。先观察这条记录。');
  });

  it('keeps valid narration and drops only optional visual anchors that cannot be compiled', async () => {
    const page = { ...outline(), lectureSectionId: 'section-a', teachingUnitIds: ['unit-a'] };
    const response = { pages: [{
      pageId: page.id,
      segments: [{
        text: '先明确具体说法，再查找能够直接回答它的记录。',
        semanticIds: ['page-a:teaching', 'page-a:visible-1'],
        anchors: [
          { semanticId: 'page-a:visible-1', quote: '原句中不存在的文字', visualCue: { type: 'spotlight' } },
          { semanticId: 'unknown', quote: '具体说法', visualCue: { type: 'laser' } },
          null,
        ],
      }],
    }] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));

    const generated = await generateTeachingSectionNarration({
      sectionId: 'section-a',
      pages: [{ outline: page, content: content() }],
      requirements: { requirement: '讲清核验方法' },
      aiCall,
    });

    expect(aiCall).toHaveBeenCalledOnce();
    expect(generated.pages[0]?.segments[0]?.text).toBe(response.pages[0].segments[0].text);
    expect(generated.pages[0]?.segments[0]?.anchors).toBeUndefined();
  });

  it('keeps speech but disables a cue whose explicit end anchor is invalid', () => {
    const narration = normalizeTeachingNarration({ segments: [{
      text: '先看小鱼和青蛙怎样理解牛，接着看顺应的定义。',
      semanticIds: ['page-a:teaching', 'page-a:visible-1'],
      anchors: [{
        semanticId: 'page-a:visible-1',
        quote: '小鱼和青蛙',
        visualCue: {
          type: 'spotlight',
          endSpeechAnchor: { quote: '不存在的结束语' },
        },
      }],
    }] }, outline());

    expect(narration.segments[0]?.text).toContain('顺应的定义');
    expect(narration.segments[0]?.anchors?.[0]?.visualCue).toBeUndefined();
    const result = compileTeachingNarrationActions({ outline: outline(), content: content(), narration });
    expect(result.actions).toEqual([
      expect.objectContaining({ type: 'speech', text: narration.segments[0]?.text }),
    ]);
  });

  it('repairs only typographic anchor differences to the exact TTS substring', () => {
    const narration = normalizeTeachingNarration({ segments: [{
      text: '先看“理论”：它说明为什么，再看模式说明怎么组织。',
      semanticIds: ['page-a:teaching', 'page-a:visible-1'],
      anchors: [{
        semanticId: 'page-a:visible-1',
        quote: '理论: 它说明为什么',
        occurrence: 3,
        visualCue: { type: 'spotlight' },
      }],
    }] }, outline());

    expect(narration.segments[0]?.anchors).toEqual([expect.objectContaining({
      quote: '理论”：它说明为什么',
      occurrence: 0,
    })]);
    const compiled = compileTeachingNarrationActions({ outline: outline(), content: content(), narration });
    expect(compiled.issues).toEqual([]);
    expect(compiled.actions[0]).toMatchObject({
      type: 'spotlight',
      speechAnchor: { quote: '理论”：它说明为什么', occurrence: 0 },
    });
  });

  it('recovers a known segment semantic id only from a verified speech anchor', () => {
    const narration = normalizeTeachingNarration({ segments: [{
      text: '先比较语气很肯定这一表现，再判断事实是否正确。',
      semanticIds: ['page-a:teaching'],
      anchors: [
        { semanticId: 'page-a:visible-1', quote: '语气很肯定', visualCue: { type: 'spotlight' } },
        { semanticId: 'unknown', quote: '事实是否正确', visualCue: { type: 'laser' } },
      ],
    }] }, outline());

    expect(narration.segments[0]?.semanticIds).toEqual(['page-a:teaching', 'page-a:visible-1']);
    expect(narration.segments[0]?.anchors).toEqual([expect.objectContaining({
      semanticId: 'page-a:visible-1',
      quote: '语气很肯定',
    })]);
  });

  it('preserves required whiteboard/widget and video action contracts on the native path', () => {
    const page: SceneOutline = { ...outline(), generationPurpose: 'knowledge-teaching', audience: 'student' };
    expect(canUseIndependentTeachingNarration(page)).toBe(true);
    for (const tool of ['whiteboard', 'interactive-widget'] as const) {
      const plan = { tool, trigger: '讲解推理时', purpose: '演示推导', content: ['推理过程'] };
      expect(canUseIndependentTeachingNarration({ ...page, teachingToolPlan: [plan] })).toBe(false);
      expect(canUseIndependentTeachingNarration({ ...page, teachingToolPlan: [{ ...plan, required: false }] })).toBe(true);
    }
    expect(canUseIndependentTeachingNarration({ ...page, teachingToolPlan: [{ tool: 'spotlight', trigger: '解释时', purpose: '指向内容', content: ['概念'] }] })).toBe(true);
    expect(canUseIndependentTeachingNarration({ ...page, mediaGenerations: [{ type: 'video', prompt: '观察实验', elementId: 'video-a' }] })).toBe(false);
    expect(canUseIndependentTeachingNarration({ ...page, type: 'quiz' })).toBe(false);
    expect(canUseIndependentTeachingNarration({ ...page, audience: 'teacher' })).toBe(false);
    expect(canUseIndependentTeachingNarration({ ...page, teachingBrief: { ...page.teachingBrief!, designVersion: 'outdated' } })).toBe(false);
  });

  it('generates once from shared plan, evidence and learner context without slide dependency', async () => {
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(raw()));
    const result = await generateTeachingNarration({
      outline: outline(), requirements: { requirement: '核验AI回答', teachingConstraints: deriveTeachingConstraints({
        grade: '八年级', learnerProfile: { priorKnowledge: '会搜索但容易轻信AI', familiarContexts: '班级小报' },
      }) }, aiCall, languageDirective: 'Answer in Chinese', courseProgression: [outline()],
    });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(aiCall.mock.calls[0][0]).toContain('read verbatim by TTS');
    expect(aiCall.mock.calls[0][0]).toContain('Teaching-plan fields and slide text supply knowledge');
    expect(aiCall.mock.calls[0][0]).toContain('常见混淆：把探究式当自由看资料');
    expect(aiCall.mock.calls[0][0]).toContain('Do not use a Chinese or ASCII colon in spoken text');
    expect(aiCall.mock.calls[0][0]).toContain('Answer in Chinese');
    expect(aiCall.mock.calls[0][0]).toContain('do not execute their quizzes, reveal their answers');
    expect(aiCall.mock.calls[0][0]).toContain('introduced and deepened nodes');
    expect(aiCall.mock.calls[0][0]).toContain('intermediate steps');
    expect(aiCall.mock.calls[0][0]).toContain('correct accidental missing or repeated words');
    expect(aiCall.mock.calls[0][0]).toContain('This static teaching page has no answer input');
    const input = readNarrationPrompt(aiCall.mock.calls[0][1]);
    expect(input.learners).toContain('会搜索但容易轻信AI');
    expect(input.page.teachingPlan.reasoningSteps).toEqual(['明确说法', '查相关记录']);
    expect(input.page.sharedContext.fixedWording).toEqual(['我校创办于1958年']);
    expect(input.page.learningTask.newContribution).toBe('建立核验链');
    expect(input.progression[0]).toMatchObject({ type: 'slide', currentPage: true });
    expect(input.progression[0].newContent).toBe('按相关记录核验');
    expect(input.progression[0]).not.toHaveProperty('evidence');
    expect(input.semanticUnits.visible[0].id).toBe('page-a:visible-1');
    expect(result.segments[0].text).toBe(raw().segments[0].text);
  });

  it('keeps generated words intact and binds a supported visual without a model action call', () => {
    const text = '  语气很肯定，就一定正确吗？我们先查记录。  ';
    const narration = normalizeTeachingNarration({ segments: [{
      text,
      semanticIds: ['page-a:teaching', 'page-a:visible-1'],
      anchors: [{ semanticId: 'page-a:visible-1', quote: '语气很肯定', visualCue: { type: 'spotlight' } }],
    }] }, outline());
    const compiled = compileTeachingNarrationActions({ outline: outline(), content: content(), narration });
    expect(compiled.issues).toEqual([]);
    expect(compiled.actions).toEqual([
      expect.objectContaining({ type: 'spotlight', elementId: 'rendered-text', necessity: 'helpful', speechId: 'page-a:speech-1' }),
      { id: 'page-a:speech-1', type: 'speech', text },
    ]);
  });

  it('binds narration directly to actual slide elements and compiles an ordered laser sweep', () => {
    const slide = content('理论');
    slide.elements[0].id = 'theory-node';
    slide.elements.push(
      { ...content('模式').elements[0], id: 'mode-node', left: 360 },
      { ...content('方法').elements[0], id: 'method-node', left: 710 },
    );
    const narration = normalizeTeachingNarration({ segments: [{
      text: '沿着这条关系看：理论先具体化为模式，模式再转化为方法。',
      semanticIds: ['page-a:teaching', 'page-a:visible-1'],
      anchors: [{
        semanticId: 'page-a:visible-1',
        quote: '理论先具体化为模式',
        visualCue: {
          type: 'laser',
          necessity: 'helpful',
          target: { elementId: 'theory-node', selector: { quote: '理论' } },
          waypoints: [{ elementId: 'mode-node' }, { elementId: 'method-node', selector: { quote: '方法' } }],
          durationMs: 6000,
        },
      }],
    }] }, outline());

    const result = compileTeachingNarrationActions({ outline: outline(), content: slide, narration });

    expect(result.issues).toEqual([]);
    expect(result.actions[0]).toMatchObject({
      type: 'laser',
      elementId: 'theory-node',
      selector: { quote: '理论' },
      waypoints: [{ elementId: 'mode-node' }, { elementId: 'method-node', selector: { quote: '方法' } }],
      duration: 6000,
      speechAnchor: { quote: '理论先具体化为模式', occurrence: 0 },
    });
  });

  it('compiles multiple semantic focus changes in one natural narration segment', () => {
    const slide = content('小鱼、青蛙和牛的例子');
    slide.elements[0].id = 'animal-example';
    slide.elements.push({
      ...content('顺应：调整原有认知结构，形成新的认识').elements[0],
      id: 'accommodation-definition',
      left: 520,
    });
    const narration = normalizeTeachingNarration({ segments: [{
      text: '先看小鱼、青蛙和牛的例子，接着看顺应的定义：顺应是调整原有认知结构，形成新的认识。',
      semanticIds: ['page-a:teaching', 'page-a:visible-1'],
      anchors: [{
        semanticId: 'page-a:visible-1',
        quote: '小鱼、青蛙和牛的例子',
        visualCue: {
          type: 'spotlight',
          target: { elementId: 'animal-example' },
        },
      }, {
        semanticId: 'page-a:visible-1',
        quote: '顺应的定义',
        visualCue: {
          type: 'spotlight',
          target: { elementId: 'accommodation-definition' },
        },
      }],
    }] }, outline());

    const result = compileTeachingNarrationActions({ outline: outline(), content: slide, narration });

    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'spotlight')).toEqual([
      expect.objectContaining({
        elementId: 'animal-example',
        speechAnchor: { quote: '小鱼、青蛙和牛的例子', occurrence: 0 },
      }),
      expect.objectContaining({
        elementId: 'accommodation-definition',
        speechAnchor: { quote: '顺应的定义', occurrence: 0 },
      }),
    ]);
    expect(result.actions.filter((action) => action.type === 'speech')).toHaveLength(1);
  });

  it('omits an invalid direct visual target without rejecting valid narration', () => {
    const narration = normalizeTeachingNarration({ segments: [{
      text: '现在看这一条关系。',
      semanticIds: ['page-a:teaching', 'page-a:visible-1'],
      anchors: [{
        semanticId: 'page-a:visible-1', quote: '这一条关系',
        visualCue: { type: 'spotlight', necessity: 'helpful', target: { elementId: 'missing-node' } },
      }],
    }] }, outline());

    const result = compileTeachingNarrationActions({ outline: outline(), content: content(), narration });

    expect(result.actions).toEqual([{ id: 'page-a:speech-1', type: 'speech', text: '现在看这一条关系。' }]);
    expect(result.issues.some((issue) => issue.code === 'unknown-element')).toBe(true);
    expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
  });

  it('omits unbound or ambiguous optional cues with warnings, never guesses or rewrites speech', () => {
    const narration = normalizeTeachingNarration(raw(undefined, true), outline());
    for (const slide of [content('无关文字'), { elements: [...content().elements, { ...content().elements[0], id: 'duplicate-text' }] }]) {
      const result = compileTeachingNarrationActions({ outline: outline(), content: slide, narration });
      expect(result.actions).toEqual([{ id: 'page-a:speech-1', type: 'speech', text: raw().segments[0].text }]);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.issues.every((issue) => issue.severity === 'warning')).toBe(true);
    }
  });

  it('uses stable semantic IDs when text is paraphrased and does not require cues per segment', () => {
    const slide = content('说得自信，也可能出错');
    slide.elements[0].id = 'page-a:visible-1';
    const narration = normalizeTeachingNarration({ segments: [...raw(undefined, true).segments, { text: '所以我们要先核对。', semanticIds: ['page-a:teaching'] }] }, outline());
    const result = compileTeachingNarrationActions({ outline: outline(), content: slide, narration });
    expect(result.actions.filter((action) => action.type === 'spotlight')).toHaveLength(1);
    expect(result.actions.filter((action) => action.type === 'speech')).toHaveLength(2);
  });

  it('binds repeated attention to the same object at each authored phrase instead of only its first mention', () => {
    const slide = content();
    slide.elements[0].id = 'page-a:visible-1';
    const narration = normalizeTeachingNarration({ segments: [
      { text: '先比较这条判断。', semanticIds: ['page-a:visible-1'], anchors: [{ semanticId: 'page-a:visible-1', quote: '这条判断', visualCue: { type: 'spotlight' } }] },
      { text: '推理结束后再回到这条判断。', semanticIds: ['page-a:visible-1'], anchors: [{ semanticId: 'page-a:visible-1', quote: '这条判断', visualCue: { type: 'laser' } }] },
    ] }, outline());
    const result = compileTeachingNarrationActions({ outline: outline(), content: slide, narration });
    expect(result.issues).toEqual([]);
    expect(result.actions.filter((action) => action.type === 'spotlight' || action.type === 'laser')).toHaveLength(2);
    expect(result.actions.flatMap((action) => action.type === 'spotlight' || action.type === 'laser'
      ? [action.speechAnchor?.quote] : []))
      .toEqual(['这条判断', '这条判断']);
  });

  it('keeps usable narration with a real semantic diagnostic and still rejects unplayable structure', async () => {
    for (const value of [null, { ...raw(), pageId: 'other-page' }, { segments: [] }, { segments: [{ text: '', semanticIds: ['page-a:teaching'] }] },
    ]) {
      expect(() => normalizeTeachingNarration(value, outline())).toThrow();
    }
    const narration = normalizeTeachingNarration({ segments: [{ text: '有效文本', semanticIds: ['invented-semantic-id'] }] }, outline());
    expect(narration.segments[0]).toMatchObject({ text: '有效文本', semanticIds: [] });
    expect(narration.diagnostics?.[0]).toContain('未知教学语义编号');
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ segments: [] }));
    await expect(generateTeachingNarration({ outline: outline(), requirements: { requirement: '讲课' }, aiCall })).rejects.toThrow();
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it('keeps the actual first speech draft with source diagnostics in both narration entry points', async () => {
    const page = outline();
    page.teachingBrief = { ...page.teachingBrief!, evidence: [{ sourceId: 'original-book',
      quote: '应根据学生的认知能力调整项目任务的复杂程度。' }] };
    const authored = { pageId: page.id, segments: [{ semanticIds: ['unknown-semantic'], textParts: [{
      sourceRef: 'source-quote-1', quote: '任务不需要根据学生的能力调整。',
    }] }] };
    const singleCall = vi.fn().mockResolvedValue(JSON.stringify(authored));
    const single = await generateTeachingNarration({ outline: page, requirements: { requirement: '讲课' }, aiCall: singleCall });
    const sectionCall = vi.fn().mockResolvedValue(JSON.stringify({ pages: [authored] }));
    const section = await generateTeachingSectionNarration({ sectionId: 'section-a',
      pages: [{ outline: page, content: content() }], requirements: { requirement: '讲课' }, aiCall: sectionCall });
    for (const narration of [single, section.pages[0]]) {
      expect(narration.segments[0]).toMatchObject({ text: '任务不需要根据学生的能力调整。', semanticIds: [] });
      expect(narration.diagnostics).toEqual(expect.arrayContaining([
        expect.stringContaining('retained the authored quote'), expect.stringContaining('未知教学语义编号'),
      ]));
    }
    expect(singleCall).toHaveBeenCalledOnce();
    expect(sectionCall).toHaveBeenCalledOnce();
  });

  it('stops on malformed structure and never retries transport faults in the authoring layer', async () => {
    const aiCall = vi.fn().mockResolvedValueOnce('{"segments":[]}').mockResolvedValueOnce(JSON.stringify(raw()));
    await expect(generateTeachingNarration({ outline: outline(), requirements: { requirement: '讲课' }, aiCall })).rejects.toThrow('没有返回有效段落');
    expect(aiCall).toHaveBeenCalledOnce();
    const transport = vi.fn().mockRejectedValue(new Error('connection reset'));
    await expect(generateTeachingNarration({ outline: outline(), requirements: { requirement: '讲课' }, aiCall: transport })).rejects.toThrow('connection reset');
    expect(transport).toHaveBeenCalledOnce();
  });

  it('restores semantic identity across the real baseline ID replacement boundary', async () => {
    const { generateSceneContent } = await import('./scene-generator');
    const raw = content('画面实际采用的改写句子');
    raw.elements[0].id = 'page-a:visible-1';
    let captured = '';
    const aiCall = withTeachingSlideGuidance(vi.fn().mockResolvedValue(JSON.stringify(raw)), outline(), (response) => { captured = response; });
    const generated = await generateSceneContent(outline(), aiCall) as GeneratedSlideContent;
    expect(generated.elements[0].id).not.toBe('page-a:visible-1');
    const restored = restoreTeachingSemanticElementIds(generated, captured, outline());
    expect(restored.elements[0].id).toBe('page-a:visible-1');
    expect({ ...restored.elements[0], id: generated.elements[0].id }).toEqual(generated.elements[0]);
  });

  it('does not restore missing, changed or ambiguous semantic identities', () => {
    const original = content();
    const raw = { elements: [{ ...original.elements[0], id: 'page-a:visible-1' }] };
    expect(restoreTeachingSemanticElementIds(original, '{}', outline())).toBe(original);
    expect(restoreTeachingSemanticElementIds(original, JSON.stringify({ elements: [raw.elements[0], raw.elements[0]] }), outline())).toBe(original);
    const changed = content('different words');
    expect(restoreTeachingSemanticElementIds(changed, JSON.stringify(raw), outline())).toBe(changed);
    const ambiguous = { elements: [...original.elements, { ...original.elements[0], id: 'other' }] };
    expect(restoreTeachingSemanticElementIds(ambiguous, JSON.stringify(raw), outline())).toBe(ambiguous);
  });

  it('gives slide and narration the same visible semantics while preserving baseline instructions', async () => {
    const call = vi.fn().mockResolvedValue('slide');
    await withTeachingSlideGuidance(call, outline())('original slide schema', 'original user prompt');
    expect(call.mock.calls[0][0]).toContain('original slide schema');
    expect(call.mock.calls[0][1]).toContain('original user prompt');
    expect(call.mock.calls[0][1]).toContain(JSON.stringify(buildTeachingNarrationSemantics(outline()).visible));
    expect(call.mock.calls[0][1]).toContain('Shared page contract');
    expect(call.mock.calls[0][0]).toContain('Choose the visual form from the stated relationship');
    expect(call.mock.calls[0][0]).toContain('Do not default to cards');
    expect(call.mock.calls[0][0]).toContain('If the supplied page task or key points resemble an exercise');
    expect(call.mock.calls[0][0]).toContain('distinct targetable element');
    expect(call.mock.calls[0][0]).toContain('rather than assigning it arbitrarily to the first label');
    expect(call.mock.calls[0][0]).toContain('remove decorative copy before shrinking');
    expect(call.mock.calls[0][0]).toContain('textbook original example, teaching adaptation, and AI supplement');
    expect(call.mock.calls[0][0]).toContain('opening page of a standalone AI course resource');
    expect(call.mock.calls[0][0]).toContain('abstract definition alone is not an adequate knowledge entry');
  });

  it('preserves the single visual operation without reinserting native long-prose instructions', async () => {
    const page = outline();
    const before = structuredClone(page);
    const system = "## PPT_VISUAL_PROJECTION_V1\nOnly this operation's JSON protocol";
    const prompt = JSON.stringify({ original: '学生能独立解决问题时，逐个撤除支架，而非最后一次性撤销' });
    const images = [{ id: 'source', src: 'https://example.com/textbook.png' }];
    const call = vi.fn().mockResolvedValue('independent-response');
    const captured = vi.fn();
    await withTeachingSlideGuidance(call, page, captured)(system, prompt, images);
    expect(call).toHaveBeenCalledExactlyOnceWith(system, prompt, images);
    expect(captured).toHaveBeenCalledExactlyOnceWith('independent-response');
    expect(page).toEqual(before);
  });

  it('uses only the adopted display statements when a full definition is owned by narration', async () => {
    const fullDefinition = '教学支架是在学习者尚不能独立完成任务时提供的支持，随学习进展逐步调整并撤除。';
    const display = ['暂时支持：随能力提升调整并撤除'];
    const page: SceneOutline = { ...outline(), teachingBrief: { ...outline().teachingBrief!,
      explanation: fullDefinition, teachingPlan: { ...outline().teachingBrief!.teachingPlan!,
        newContent: fullDefinition, visibleContent: [fullDefinition], presentationContent: display } } };
    const call = vi.fn().mockResolvedValue('slide');
    await withTeachingSlideGuidance(call, page)('original schema', 'page input');
    expect(buildTeachingNarrationSemantics(page).visible.map((item) => item.text)).toEqual(display);
    const contract = JSON.parse(call.mock.calls[0][1].split('Shared page contract:\n')[1]!);
    expect(contract.visibleStatements.map((item: { text: string }) => item.text)).toEqual(display);
    expect(call.mock.calls[0][0]).toContain('complete authoritative definition belongs to the independently sourced narration');
    expect(page.teachingBrief!.explanation).toBe(fullDefinition);
  });
});
