import { describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import { TEACHING_ENHANCEMENT_VERSION } from './teaching-enhancement';
import { deriveTeachingConstraints } from '@openmaic/lib/pedagogy/teaching-constraints';
import {
  buildTeachingNarrationSemantics,
  canUseIndependentTeachingNarration,
  compileTeachingNarrationActions,
  generateTeachingNarration,
  normalizeTeachingNarration,
  withTeachingSlideGuidance,
  restoreTeachingSemanticElementIds,
} from './teaching-narration';

function outline(): SceneOutline {
  return {
    id: 'page-a', type: 'slide', title: '核验AI回答', description: '解释核验', keyPoints: ['查相关记录'], order: 0,
    teachingBrief: {
      schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, explanation: '记录需要与具体说法相关', examples: ['建校年份'], conditions: ['记录相关'], evidence: [], assessmentFocus: '查什么',
      sharedContext: { learningPurpose: '决定AI写的小报内容能否使用', caseId: 'school-paper',
        caseFacts: ['AI写出一个具体建校年份'], fixedWording: ['我校创办于1958年'],
        stableTerms: ['待查说法', '可靠记录'], conceptBoundaries: ['语气肯定不等于事实正确'] },
      pageTask: { learnerAction: '判断要核对什么以及去哪里核对', newContribution: '建立核验链', reasoningFocus: '记录与说法是否直接相关',
        caseUse: 'introduce', changedConditions: [], preservedConditions: [] },
      teachingPlan: { purpose: '解释核验', priorKnowledge: '会搜索', newContent: '按相关记录核验', learnerQuestion: '肯定的语气可信吗',
        reasoningSteps: ['明确说法', '查相关记录'], takeaway: '有相关依据再采用', visibleContent: ['语气肯定 ≠ 事实正确'], narrationFocus: ['解释为什么查证'] },
    },
  };
}
function content(text = '语气肯定 ≠ 事实正确'): GeneratedSlideContent {
  return { elements: [{ id: 'rendered-text', type: 'text', left: 10, top: 10, width: 300, height: 80, rotate: 0,
    content: `<p>${text}</p>`, defaultFontName: 'Arial', defaultColor: '#333333' }] };
}
function raw(text = '先看看学校简介。它有没有写出这个年份？') {
  return { segments: [{ text, semanticIds: ['page-a:teaching', 'page-a:visible-1'] }] };
}

describe('independent first-pass teaching narration', () => {
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
    expect(aiCall.mock.calls[0][0]).toContain('read aloud verbatim by TTS');
    expect(aiCall.mock.calls[0][0]).toContain('Answer in Chinese');
    expect(aiCall.mock.calls[0][0]).toContain('do not execute their quizzes, reveal their answers');
    expect(aiCall.mock.calls[0][0]).toContain('Never open by listing all new category names');
    expect(aiCall.mock.calls[0][0]).toContain('make the first segment state the changed and preserved conditions');
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
    expect(result.segments[0].text).toBe(raw().segments[0].text);
  });

  it('keeps generated words intact and binds a supported visual without a model action call', () => {
    const text = '  语气很肯定，就一定正确吗？我们先查记录。  ';
    const narration = normalizeTeachingNarration(raw(text), outline());
    const compiled = compileTeachingNarrationActions({ outline: outline(), content: content(), narration });
    expect(compiled.issues).toEqual([]);
    expect(compiled.actions).toEqual([
      expect.objectContaining({ type: 'spotlight', elementId: 'rendered-text', necessity: 'helpful', speechId: 'page-a:speech-1' }),
      { id: 'page-a:speech-1', type: 'speech', text },
    ]);
  });

  it('omits unbound or ambiguous optional cues with warnings, never guesses or rewrites speech', () => {
    const narration = normalizeTeachingNarration(raw(), outline());
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
    const narration = normalizeTeachingNarration({ segments: [...raw().segments, { text: '所以我们要先核对。', semanticIds: ['page-a:teaching'] }] }, outline());
    const result = compileTeachingNarrationActions({ outline: outline(), content: slide, narration });
    expect(result.actions.filter((action) => action.type === 'spotlight')).toHaveLength(1);
    expect(result.actions.filter((action) => action.type === 'speech')).toHaveLength(2);
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
    expect(result.segments[0].text).toBe(raw().segments[0].text);
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
  });
});
