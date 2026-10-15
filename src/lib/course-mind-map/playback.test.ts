import { describe, expect, it } from 'vitest';
import type { CourseMindMap } from './types';
import { resolveCourseMindMapFocus } from './playback';

const map: CourseMindMap = {
  schemaVersion: 1, sourceFingerprint: 'source', bindingFingerprint: 'audio', rootId: 'course',
  nodes: [
    { id: 'course', label: '教学方法', knowledgePointIds: [] },
    { id: 'anchor', label: '抛锚式教学法', parentId: 'course', knowledgePointIds: ['kp-anchor'] },
    { id: 'steps', label: '实施流程', parentId: 'anchor', knowledgePointIds: ['kp-anchor'] },
    { id: 'context', label: '创设情境', parentId: 'steps', knowledgePointIds: ['kp-anchor'], order: 0 },
    { id: 'problem', label: '确定问题', parentId: 'steps', knowledgePointIds: ['kp-anchor'], order: 1 },
    { id: 'learning', label: '自主学习', parentId: 'steps', knowledgePointIds: ['kp-anchor'], order: 2 },
  ],
  relations: [], diagnostics: [],
  bindings: [
    { sceneId: 'page-one', defaultNodeId: 'anchor', cues: [
      { speechId: 'speech-one', nodeId: 'problem', anchor: { quote: '确定问题' }, startMs: 4300, speechTextHash: 'text-one', audioHash: 'audio-one' },
      { speechId: 'speech-one', nodeId: 'context', anchor: { quote: '创设情境' }, startMs: 500, speechTextHash: 'text-one', audioHash: 'audio-one' },
      { speechId: 'speech-two', nodeId: 'learning', anchor: { quote: '自主学习' }, startMs: 600, speechTextHash: 'text-two', audioHash: 'audio-two' },
    ] },
    { sceneId: 'page-two', defaultNodeId: 'anchor', cues: [
      { speechId: 'other-speech', nodeId: 'learning', anchor: { quote: '自主学习' }, startMs: 200, speechTextHash: 'other-text', audioHash: 'other-audio' },
    ] },
  ],
};
const pageOne = {
  sceneId: 'page-one', knowledgePointIds: ['kp-anchor'],
  actions: [{ id: 'visual-one', type: 'laser' },
    { id: 'speech-one', type: 'speech', text: '先创设情境，再确定问题。',
      speechAlignment: { status: 'aligned', textHash: 'text-one', audioHash: 'audio-one' } },
    { id: 'speech-two', type: 'speech', text: '然后自主学习。',
      speechAlignment: { status: 'aligned', textHash: 'text-two', audioHash: 'audio-two' } }],
  activeActionIndex: 1,
};

describe('course mind map playback focus', () => {
  it('follows authentic audio time across several concepts within one speech', () => {
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 0 })).toBe('steps');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 700 })).toBe('context');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 4299 })).toBe('context');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 4300 })).toBe('problem');
  });

  it('reprojects a backwards seek and replay instead of retaining an advanced node', () => {
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 9000 })).toBe('problem');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 1000 })).toBe('context');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 0 })).toBe('steps');
  });

  it('scopes the clock to the real speech identity and scene instead of the first knowledge point', () => {
    expect(resolveCourseMindMapFocus(map, { ...pageOne, activeActionIndex: 2, mediaTimeMs: 700 })).toBe('learning');
    expect(resolveCourseMindMapFocus(map, {
      ...pageOne, sceneId: 'page-two', actions: [{ id: 'other-speech', type: 'speech', text: '自主学习。',
        speechAlignment: { status: 'aligned', textHash: 'other-text', audioHash: 'other-audio' } }],
      activeActionIndex: 0, mediaTimeMs: 200,
    })).toBe('learning');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, activeActionIndex: 0, mediaTimeMs: 8000 })).toBe('anchor');
  });

  it('uses a speech branch when an audio clock or an authentic cue timing is absent', () => {
    expect(resolveCourseMindMapFocus(map, pageOne)).toBe('steps');
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: Number.NaN })).toBe('steps');
    const unresolved = structuredClone(map);
    delete unresolved.bindings[0].cues[0].startMs;
    expect(resolveCourseMindMapFocus(unresolved, { ...pageOne, mediaTimeMs: 10000 })).toBe('steps');
  });

  it('keeps quiz waiting on the bound topic instead of an answer detail', () => {
    expect(resolveCourseMindMapFocus(map, { ...pageOne, mediaTimeMs: 9000, quizWaiting: true })).toBe('anchor');
  });

  it('drops old precise timings when audio or speech identities are changed or invalidated', () => {
    for (const change of [
      { audioInvalidated: true },
      { text: '已修改讲稿，不再教授这些步骤。' },
      { speechAlignment: { status: 'aligned', textHash: 'new-text', audioHash: 'audio-one' } },
      { speechAlignment: { status: 'aligned', textHash: 'text-one', audioHash: 'new-audio' } },
      { speechAlignment: { status: 'failed', textHash: 'text-one', audioHash: 'audio-one' } },
    ]) {
      const actions = pageOne.actions.map(action => action.id === 'speech-one' ? { ...action, ...change } : action);
      expect(resolveCourseMindMapFocus(map, { ...pageOne, actions, mediaTimeMs: 9000 })).toBe('steps');
    }
    const older = structuredClone(map);
    delete older.bindings[0].cues[0].speechTextHash;
    expect(resolveCourseMindMapFocus(older, { ...pageOne, mediaTimeMs: 9000 })).toBe('steps');
  });

  it('continues to support a legacy course and unmapped/adaptive pages', () => {
    expect(resolveCourseMindMapFocus(undefined, pageOne)).toBeNull();
    expect(resolveCourseMindMapFocus(map, { sceneId: 'adaptive', knowledgePointIds: ['kp-anchor'] })).toBe('anchor');
    expect(resolveCourseMindMapFocus(map, { sceneId: 'unmapped' })).toBe('course');
  });
});
