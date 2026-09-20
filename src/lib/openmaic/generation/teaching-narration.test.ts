import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import { TEACHING_ENHANCEMENT_VERSION } from './teaching-enhancement';
import { deriveTeachingConstraints } from '@openmaic/lib/pedagogy/teaching-constraints';
import {
  buildTeachingNarrationSemantics,
  canUseIndependentTeachingNarration,
  compileTeachingNarrationActions,
  generateTeachingSectionNarration,
  generateTeachingNarration,
  normalizeTeachingNarration,
  normalizeTeachingSectionNarration,
  withTeachingSlideGuidance,
  restoreTeachingSemanticElementIds,
} from './teaching-narration';

function outline(): SceneOutline {
  return {
    id: 'page-a', type: 'slide', title: '核验AI回答', description: '解释核验', keyPoints: ['查相关记录'], order: 0,
    teachingBrief: {
      schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, explanation: '记录需要与具体说法相关', examples: ['建校年份'], conditions: ['记录相关'], evidence: [], assessmentFocus: '查什么',
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

describe('independent first-pass teaching narration', () => {
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
    const prompt = JSON.parse(aiCall.mock.calls[0][1]);
    expect(prompt.pages).toHaveLength(2);
    expect(prompt.pages[0].actualSlide.elements[0].content).toContain('语气肯定');
    expect(aiCall.mock.calls[0][0]).toContain('actual slide is the authority only for what is visible');
    expect(aiCall.mock.calls[0][0]).toContain('Advance one line of understanding across pages');
    expect(aiCall.mock.calls[0][0]).toContain('intermediate causal or inferential links explicit');
    expect(aiCall.mock.calls[0][0]).toContain('introduces, deepens, and references as page ownership');
    expect(aiCall.mock.calls[0][0]).toContain('actual relationship on the slide');
    expect(aiCall.mock.calls[0][0]).toContain('local explanatory value, learner familiarity');
    expect(aiCall.mock.calls[0][0]).toContain('teachingPlan.taskConnection as a hard page boundary');
    expect(aiCall.mock.calls[0][0]).toContain('standalone AI resource must feel complete');
    expect(aiCall.mock.calls[0][0]).toContain('synthesize what the learner can now explain or do');
    expect(aiCall.mock.calls[0][0]).toContain('温暖、清楚地逐步解释');
    expect(aiCall.mock.calls[0][0]).toContain('copied as one contiguous substring from that exact finalized segment text');
    expect(aiCall.mock.calls[0][0]).toContain('a spotlight that starts inside a segment remains until that segment ends');
    expect(aiCall.mock.calls[0][0]).toContain('Choose laser for an ordered scan');
    expect(aiCall.mock.calls[0][0]).toContain('remaining ordered objects as waypoints');
    expect(prompt.visualCueExamples.orderedPath.waypoints[0].elementId).toContain('actualSlide');
    expect(prompt.pages[0].explanation).toContain('记录需要与具体说法相关');
    expect(prompt.pages[0].teachingPlan.visibleContent).toEqual(['语气肯定 ≠ 事实正确']);
    expect(prompt.pages[0].deliveryContext).toMatchObject({ sectionPosition: 'course-first', pageIndex: 1, courseTitle: 'AI信息核验' });
    expect(prompt.pages[0].teachingPlan.entryPoint.object).toContain('班级小报');
    expect(prompt.pages[0].visualActionIntent[0]).toMatchObject({ tool: 'laser-pointer', purpose: '依次指示步骤' });
    expect(prompt.teacherVoice).toEqual({ name: '林老师', role: 'teacher' });
    expect(generated.pages[0]?.segments[0]?.text).toMatch(/^同学们好，欢迎来到《AI信息核验》课程。/);
    expect(generated.pages[1]?.segments.at(-1)?.text).toMatch(/感谢大家的认真参与，同学们再见。$/);
    expect(() => normalizeTeachingSectionNarration({ pages: [response.pages[0], response.pages[0]] }, 'section-a', [first, second])).toThrow('重复返回页面');
    expect(() => normalizeTeachingSectionNarration({ pages: [response.pages[0]] }, 'section-a', [first, second])).toThrow('缺少页面');
  });

  it('removes a repeated welcome from an embedded resource while keeping course-first pages welcoming', async () => {
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

    expect(generated.pages[0]?.segments[0]?.text).toBe('先观察这条记录。');
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
    expect(generated.pages[0]?.segments[0]?.text).toMatch(/^同学们好，欢迎来到今天的课堂。先明确具体说法，再查找能够直接回答它的记录。/);
    expect(generated.pages[0]?.segments[0]?.text).toMatch(/感谢大家的认真参与，同学们再见。$/);
    expect(generated.pages[0]?.segments[0]?.anchors).toBeUndefined();
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
    expect(aiCall.mock.calls[0][0]).toContain('Answer in Chinese');
    expect(aiCall.mock.calls[0][0]).toContain('do not execute their quizzes, reveal their answers');
    expect(aiCall.mock.calls[0][0]).toContain('introduced and deepened nodes');
    expect(aiCall.mock.calls[0][0]).toContain('intermediate steps');
    expect(aiCall.mock.calls[0][0]).toContain('correct accidental missing or repeated words');
    const input = JSON.parse(aiCall.mock.calls[0][1]);
    expect(input.learners).toContain('会搜索但容易轻信AI');
    expect(input.page.teachingPlan.reasoningSteps).toEqual(['明确说法', '查相关记录']);
    expect(input.page.sharedContext.fixedWording).toEqual(['我校创办于1958年']);
    expect(input.page.learningTask.newContribution).toBe('建立核验链');
    expect(input.progression[0]).toMatchObject({ type: 'slide', currentPage: true });
    expect(input.progression[0].newContent).toBe('按相关记录核验');
    expect(input.progression[0]).not.toHaveProperty('evidence');
    expect(input.semanticUnits.visible[0].id).toBe('page-a:visible-1');
    expect(result.segments[0].text).toMatch(new RegExp(`^同学们好，欢迎来到今天的课堂。${raw().segments[0].text}`));
    expect(result.segments[0].text).toMatch(/感谢大家的认真参与，同学们再见。$/);
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

  it('rejects invalid references and fails after one bounded technical correction', async () => {
    for (const value of [null, { ...raw(), pageId: 'other-page' }, { segments: [] }, { segments: [{ text: '', semanticIds: ['page-a:teaching'] }] },
      { segments: [{ text: '有效文本', semanticIds: ['invented-semantic-id'] }] }]) {
      expect(() => normalizeTeachingNarration(value, outline())).toThrow();
    }
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ segments: [] }));
    await expect(generateTeachingNarration({ outline: outline(), requirements: { requirement: '讲课' }, aiCall })).rejects.toThrow();
    expect(aiCall).toHaveBeenCalledTimes(2);
  });

  it('corrects malformed structure once but leaves valid narration and transport faults alone', async () => {
    const aiCall = vi.fn().mockResolvedValueOnce('{"segments":[]}').mockResolvedValueOnce(JSON.stringify(raw()));
    const result = await generateTeachingNarration({ outline: outline(), requirements: { requirement: '讲课' }, aiCall });
    expect(result.segments[0].text).toMatch(new RegExp(`^同学们好，欢迎来到今天的课堂。${raw().segments[0].text}`));
    expect(result.segments[0].text).toMatch(/感谢大家的认真参与，同学们再见。$/);
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(aiCall.mock.calls[1][1]).toContain('Technical JSON/schema correction only');
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
    expect(call.mock.calls[0][0]).toContain('distinct targetable element');
    expect(call.mock.calls[0][0]).toContain('rather than assigning it arbitrarily to the first label');
    expect(call.mock.calls[0][0]).toContain('remove decorative copy before shrinking');
    expect(call.mock.calls[0][0]).toContain('opening page of a standalone AI course resource');
    expect(call.mock.calls[0][0]).toContain('abstract definition alone is not an adequate knowledge entry');
  });
});
