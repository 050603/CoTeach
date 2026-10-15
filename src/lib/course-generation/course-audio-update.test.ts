import { describe, expect, it } from 'vitest';
import type { Scene } from '@/lib/openmaic/types/stage';
import type { PblTemplateSnapshot } from '@/lib/platform/pbl-template';
import { buildCourseAudioSectionRequest, parseCourseAudioSectionResponse, replaceCoursePageSpeech, updateCourseAudioManuscript } from './course-audio-update';
import { splitLongSpeechActions } from '@/lib/openmaic/audio/tts-utils';

const scene = {
  id: 'page', outlineId: 'outline', stageId: 'old', order: 0, title: '概念辨析', type: 'quiz',
  content: { type: 'quiz', questions: [{ id: 'question', question: '哪项正确？', options: ['甲', '乙'], answer: '甲', explanation: '完整解析。' }] },
  actions: [
    { id: 'intro', type: 'speech', text: '原文举例：讲解。', quizNarrationPhase: 'intro', audioId: 'old', audioUrl: '/old.mp3', audioDurationSec: 3, speechAlignment: { status: 'aligned' } },
    { id: 'wait', type: 'speech', text: '', timelinePauseSec: 20, timelinePausePurpose: 'quiz-submit' },
    { id: 'feedback', type: 'speech', text: '最后收束：总结。', quizNarrationPhase: 'review' },
  ],
} as unknown as Scene;
const snapshot = {
  schemaVersion: 2, kind: 'pbl-course', design: { name: '课程', content: {
    knowledgePoints: [], _openmaicSceneOutlines: [{ id: 'outline', knowledgePointIds: [] }],
    teachingBlueprint: { sections: [{ id: 'section', title: '小节', units: [{ explanationNodes: [{ id: 'intro', content: '旧讲稿', sourceBindings: [{ evidenceItemId: 'source' }] }] }], pages: [{ id: 'outline', introducesNodeIds: ['intro'] }] }] },
  } },
} as unknown as PblTemplateSnapshot;
const page = { sceneId: scene.id, segments: [{ id: 'intro', text: '我们来看这个例子。' }, { id: 'feedback', text: '现在把这几个概念联系起来。' }] };

describe('explicit course audio update', () => {
  it('uses adopted sources and exact existing ownership; parses one authored response without rewriting it', () => {
    const request = buildCourseAudioSectionRequest(snapshot, [scene]);
    const prompt = JSON.parse(request.prompt);
    expect(prompt.pages[0].segments.map((entry: { id: string }) => entry.id)).toEqual(['intro', 'feedback']);
    expect(prompt.pages[0].fixedPage).toEqual(scene.content);
    expect(request.system).toContain('同一次生成');
    const authored = { ...page, segments: [{ id: 'intro', text: '我们先看一看这个例子。' }, page.segments[1]!] };
    expect(parseCourseAudioSectionResponse(JSON.stringify({ pages: [authored] }), [scene])).toEqual([authored]);
  });

  it('rejects reassigned, omitted, duplicated or empty paragraphs rather than moving knowledge or falling back', () => {
    for (const altered of [
      { ...page, sceneId: 'another-page' },
      { ...page, segments: page.segments.slice(1) },
      { ...page, segments: [page.segments[1], page.segments[0]] },
      { ...page, segments: [page.segments[0], page.segments[0]] },
      { ...page, segments: [{ ...page.segments[0], text: '' }, page.segments[1]] },
    ]) expect(() => parseCourseAudioSectionResponse(JSON.stringify({ pages: [altered] }), [scene])).toThrow();
  });

  it('invalidates old clips while preserving quiz data, phases and exact timed pauses', () => {
    const updated = replaceCoursePageSpeech(scene, page);
    expect(updated.content).toEqual(scene.content);
    expect(updated.actions?.[1]).toEqual(scene.actions?.[1]);
    expect(updated.actions?.[0]).toEqual({ id: 'intro', type: 'speech', text: page.segments[0]!.text, quizNarrationPhase: 'intro', audioInvalidated: true });
    expect(scene.actions?.[0]).toHaveProperty('audioUrl', '/old.mp3');
  });

  it('updates only canonical manuscript text and keeps source bindings and page plans', () => {
    const updated = updateCourseAudioManuscript(snapshot, [page]);
    const originalSection = snapshot.design.content.teachingBlueprint!.sections[0]!;
    const section = updated.design.content.teachingBlueprint!.sections[0]!;
    expect(section.pages).toEqual(originalSection.pages);
    expect(section.units[0]!.explanationNodes?.[0]).toEqual({ ...originalSection.units[0]!.explanationNodes?.[0], content: page.segments[0]!.text });
    expect(originalSection.units[0]!.explanationNodes?.[0]?.content).toBe('旧讲稿');
    const split = updateCourseAudioManuscript(snapshot, [{ sceneId: scene.id, segments: [{ id: 'intro_tts_1', text: '前半段。' }, { id: 'intro_tts_2', text: '后半段。' }] }]);
    expect(split.design.content.teachingBlueprint!.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe('前半段。后半段。');
  });

  it('keeps newly authored cue anchors on the correct text when TTS needs long-paragraph splitting', () => {
    const text = '我们先说明这个概念的完整条件。'.repeat(100) + '随后观察结果。';
    const actions = splitLongSpeechActions([
      { id: 'cue', type: 'spotlight', elementId: 'target', speechId: 'long', speechAnchor: { quote: '随后观察结果。' } },
      { id: 'long', type: 'speech', text, audioInvalidated: true },
    ], 'glm-tts');
    const speeches = actions.filter((action) => action.type === 'speech');
    expect(speeches.length).toBeGreaterThan(1);
    expect(speeches.map((action) => action.text).join('')).toBe(text);
    const cue = actions.find((action) => action.type === 'spotlight')!;
    expect(cue.type === 'spotlight' && speeches.find((speech) => speech.id === cue.speechId)?.text).toContain('随后观察结果。');
  });
});
