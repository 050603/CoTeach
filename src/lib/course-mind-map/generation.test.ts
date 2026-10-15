import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Course } from '@/lib/session/types';
import type { Scene } from '@/lib/openmaic/types/stage';
import type { SpeechAction } from '@/lib/openmaic/types/action';
import type { CourseGenerationAiCallContext } from '@/lib/openmaic/server/course-generation-ai-call';
import { generateCourseMindMap, validateCourseMindMap, type CourseMindMapCheckpoint } from './generation';
import { resolveCourseMindMapBindings } from './bindings';
import { computeCourseMindMapBindingFingerprint, computeCourseMindMapSourceFingerprint } from './source';
import type { CourseMindMap } from './types';

const course = { id: 'course', name: '抛锚式教学法', learningObjectives: ['解释特征与流程'], content: {
  knowledgePoints: [{ id: 'kp', name: '抛锚式教学法的特征与实施流程', description: '讲清特征及流程', evidenceItemIds: ['ev'] }],
  courseEvidence: { items: [{ id: 'ev', title: '抛锚式教学', content: '先创设情境，再确定问题。',
    source: { textbookId: 'book', revisionId: 'r1' }, sourceSequences: [{ kind: 'ordered-steps', anchorSourceBlockId: 'b',
      steps: [{ label: '创设情境', sourceBlockId: 'b' }, { label: '确定问题', sourceBlockId: 'b' }] }] }], mappings: [] },
} } as unknown as Course;
const speechText = '先创设情境，再确定问题。';
const speech = (): SpeechAction => ({ id: 'speech', type: 'speech', text: speechText, audioUrl: '/audio/one.mp3',
  speechAlignment: { status: 'aligned', version: 'v1', textHash: createHash('sha256').update(speechText).digest('hex'),
    audioHash: 'a'.repeat(64), spans: Array.from(speechText, (text, index) => ({ text, startChar: index, endChar: index + 1,
      startMs: index * 100, endMs: (index + 1) * 100 })) } });
const scenes = (): Scene[] => [{ id: 'page', type: 'slide', title: '实施流程', order: 0, knowledgePointIds: ['kp'],
  content: { type: 'slide', canvas: { elements: [{ id: 'text', type: 'text', content: '<p>创设情境 → 确定问题</p>', left: 10 }] } },
  actions: [speech()] }] as unknown as Scene[];
const candidate = (): CourseMindMap => ({ schemaVersion: 1, rootId: 'root', sourceFingerprint: '', bindingFingerprint: '',
  nodes: [
    { id: 'root', label: '抛锚式教学法', knowledgePointIds: [] },
    { id: 'flow', label: '实施流程', parentId: 'root', knowledgePointIds: ['kp'] },
    { id: 'first', label: '创设情境', parentId: 'flow', knowledgePointIds: ['kp'], evidenceItemIds: ['ev'], order: 0 },
    { id: 'second', label: '确定问题', parentId: 'flow', knowledgePointIds: ['kp'], evidenceItemIds: ['ev'], order: 1 },
  ], relations: [], bindings: [{ sceneId: 'page', defaultNodeId: 'flow', cues: [
    { speechId: 'speech', nodeId: 'first', anchor: { quote: '创设情境' } },
    { speechId: 'speech', nodeId: 'second', anchor: { quote: '确定问题' } },
  ] }], diagnostics: [] });

describe('course mind map source identity', () => {
  it('excludes audio, layout and visual actions but includes actual speech and adopted evidence', () => {
    const original = scenes();
    const edited = scenes();
    const action = edited[0]!.actions![0] as SpeechAction;
    action.audioUrl = '/audio/two.mp3';
    action.speechAlignment!.spans[0]!.startMs = 5;
    edited[0]!.actions!.push({ id: 'spot', type: 'spotlight', elementId: 'text' });
    if (edited[0]!.content.type === 'slide') edited[0]!.content.canvas.elements[0]!.left = 500;
    expect(computeCourseMindMapSourceFingerprint(course, edited)).toBe(computeCourseMindMapSourceFingerprint(course, original));
    expect(computeCourseMindMapBindingFingerprint(edited)).not.toBe(computeCourseMindMapBindingFingerprint(original));
    action.text += '补充说明。';
    expect(computeCourseMindMapSourceFingerprint(course, edited)).not.toBe(computeCourseMindMapSourceFingerprint(course, original));
    const changed = structuredClone(course);
    changed.content.courseEvidence!.items[0]!.content += '独立学习是特征。';
    expect(computeCourseMindMapSourceFingerprint(changed, original)).not.toBe(computeCourseMindMapSourceFingerprint(course, original));
  });
});

describe('authentic mind map speech anchors', () => {
  it('resolves multiple concepts within one speech without modifying the saved map', () => {
    const map = candidate();
    const result = resolveCourseMindMapBindings(map, scenes());
    expect(result.bindings[0]!.cues.map((cue) => cue.startMs)).toEqual([100, 700]);
    expect(map.bindings[0]!.cues.every((cue) => cue.startMs === undefined)).toBe(true);
  });
  it.each(['missing', 'stale-text', 'invalidated', 'gap', 'bad-span'])(
    'withholds timings when alignment is %s', (kind) => {
      const current = scenes();
      const action = current[0]!.actions![0] as SpeechAction;
      if (kind === 'missing') delete action.speechAlignment;
      if (kind === 'stale-text') action.text += '改变';
      if (kind === 'invalidated') action.audioInvalidated = true;
      if (kind === 'gap') action.speechAlignment!.spans.splice(2, 1);
      if (kind === 'bad-span') action.speechAlignment!.spans[2]!.text = '错';
      const map = candidate();
      map.bindings[0]!.cues[0]!.startMs = 999;
      expect(resolveCourseMindMapBindings(map, current).bindings[0]!.cues[0]!.startMs).toBeUndefined();
    });
  it('never focuses answer leaves during a quiz', () => {
    const map = candidate();
    const quiz = { ...scenes()[0], type: 'quiz' } as Scene;
    map.bindings[0]!.defaultNodeId = 'second';
    const result = resolveCourseMindMapBindings(map, [quiz]);
    expect(result.bindings[0]).toEqual({ sceneId: 'page', defaultNodeId: 'flow', cues: [] });
  });
});

describe('mind map validation and local recovery', () => {
  it('diagnoses a generic root label without treating it as a technical failure', () => {
    const map = candidate();
    map.nodes[0]!.label = '课程概念图';
    expect(validateCourseMindMap(map, course, scenes()).issues).toContain('根节点缺少实际课程主题，不能使用通用导图名称');
    map.nodes[0]!.label = course.name;
    expect(validateCourseMindMap(map, course, scenes()).issues).toEqual([]);
  });
  it('keeps concept detail separate from stable teaching target IDs and rejects invalid references', () => {
    expect(validateCourseMindMap(candidate(), course, scenes()).issues).toEqual([]);
    const invalid = candidate();
    invalid.nodes[2]!.parentId = 'unknown';
    expect(() => validateCourseMindMap(invalid, course, scenes())).toThrow('未连接');
    const badEvidence = candidate();
    badEvidence.nodes[2]!.evidenceItemIds = ['fabricated'];
    expect(() => validateCourseMindMap(badEvidence, course, scenes())).toThrow('教材证据');
  });
  it('diagnoses flat structures, compound sentences, missing coverage and reversed real steps', () => {
    const map = candidate();
    map.nodes[2]!.order = 2;
    map.nodes[3]!.order = 1;
    expect(validateCourseMindMap(map, course, scenes()).issues.join()).toContain('顺序');
    map.nodes[2]!.parentId = 'root';
    map.nodes[3]!.parentId = 'root';
    map.nodes[1]!.label = '教师完整解释抛锚式教学法的全部特征以及实施流程。';
    map.bindings = [];
    expect(validateCourseMindMap(map, course, scenes()).issues.join()).toContain('一层并列');
    expect(validateCourseMindMap(map, course, scenes()).issues.join()).toContain('名称过长');
    expect(validateCourseMindMap(map, course, scenes()).issues.join()).toContain('缺少概念分支绑定');
  });
  it('repairs locally, saves complete raw responses before validation, then reuses the structure after audio changes', async () => {
    const flawed = candidate();
    flawed.nodes[1]!.label = '这里是一个过长的完整教学目标句子需要解释所有流程。';
    const aiCall = vi.fn().mockResolvedValueOnce(JSON.stringify(flawed)).mockResolvedValueOnce(JSON.stringify(candidate()));
    const saved: CourseMindMapCheckpoint[] = [];
    const result = await generateCourseMindMap({ course, scenes: scenes(), aiCall, saveCheckpoint: (value) => { saved.push(structuredClone(value)); } });
    expect(aiCall).toHaveBeenCalledTimes(2);
    expect(result.diagnostics).toEqual([]);
    expect(saved.some((item) => item.phase === 'response-complete' && item.rawResponse && !item.bestCandidate)).toBe(true);
    const changedAudio = scenes();
    (changedAudio[0]!.actions![0] as SpeechAction).speechAlignment!.spans.forEach((span) => { span.startMs += 50; span.endMs += 50; });
    const reuse = vi.fn();
    const restored = await generateCourseMindMap({ course, scenes: changedAudio, aiCall: reuse, checkpoint: saved.at(-1) });
    expect(reuse).not.toHaveBeenCalled();
    expect(restored.nodes).toEqual(result.nodes);
    expect(restored.bindings[0]!.cues[0]!.startMs).toBe(150);
  });
  it('restores a saved response without another model call', async () => {
    const current = scenes();
    const aiCall = vi.fn();
    const result = await generateCourseMindMap({ course, scenes: current, aiCall, checkpoint: {
      schemaVersion: 1, sourceFingerprint: computeCourseMindMapSourceFingerprint(course, current), attempts: 1,
      rawResponse: JSON.stringify(candidate()), phase: 'response-complete',
    } });
    expect(aiCall).not.toHaveBeenCalled();
    expect(result.nodes).toEqual(candidate().nodes);
  });
  it('persists a parseable partial stream but never adopts it or pays again during recovery', async () => {
    const saved: CourseMindMapCheckpoint[] = [];
    const provider = vi.fn();
    const aiCall = Object.assign(provider, { withExecutionContext: (context: CourseGenerationAiCallContext) =>
      async (system: string, prompt: string) => {
        provider();
        await context.onResponse?.({ source: 'test', system, prompt, text: JSON.stringify(candidate()), complete: false });
        throw new Error('stream interrupted');
      } });
    await expect(generateCourseMindMap({ course, scenes: scenes(), aiCall,
      saveCheckpoint: (value) => { saved.push(structuredClone(value)); } })).rejects.toThrow('stream interrupted');
    expect(saved.at(-1)).toMatchObject({ attempts: 1, responseComplete: false, phase: 'response-partial' });
    const resume = vi.fn();
    await expect(generateCourseMindMap({ course, scenes: scenes(), aiCall: resume, checkpoint: saved.at(-1) }))
      .rejects.toMatchObject({ code: 'LLM_STREAM_INCOMPLETE' });
    expect(resume).not.toHaveBeenCalled();
    expect(provider).toHaveBeenCalledOnce();
  });
  it('does not repay an interrupted request without any saved response', async () => {
    const current = scenes();
    const aiCall = vi.fn();
    await expect(generateCourseMindMap({ course, scenes: current, aiCall, checkpoint: {
      schemaVersion: 1, sourceFingerprint: computeCourseMindMapSourceFingerprint(course, current), attempts: 1, phase: 'requesting',
    } })).rejects.toMatchObject({ code: 'LLM_STREAM_INCOMPLETE' });
    expect(aiCall).not.toHaveBeenCalled();
  });
  it('preserves the better first draft when a repair adds new issues or changes stable IDs', async () => {
    const first = candidate();
    first.nodes[1]!.label = '完整讲授抛锚式教学法的全部特征与实施流程及其应用。';
    const worse = candidate();
    worse.bindings = [];
    const changedIds = candidate();
    changedIds.nodes[2]!.id = 'replacement';
    changedIds.bindings[0]!.cues[0]!.nodeId = 'replacement';
    const aiCall = vi.fn().mockResolvedValueOnce(JSON.stringify(first)).mockResolvedValueOnce(JSON.stringify(worse))
      .mockResolvedValueOnce(JSON.stringify(changedIds));
    const result = await generateCourseMindMap({ course, scenes: scenes(), aiCall });
    expect(aiCall).toHaveBeenCalledTimes(3);
    expect(result.nodes).toEqual(first.nodes);
    expect(result.diagnostics.join()).toContain('名称过长');
  });
  it('retains executable content if a quality repair fails, but rejects wholly unparseable output', async () => {
    const first = candidate();
    first.bindings = [];
    let checkpoint: CourseMindMapCheckpoint | undefined;
    const result = await generateCourseMindMap({ course, scenes: scenes(),
      saveCheckpoint: (value) => { checkpoint = value; },
      aiCall: vi.fn().mockResolvedValueOnce(JSON.stringify(first)).mockRejectedValueOnce(new Error('provider unavailable')) });
    expect(result.nodes).toEqual(first.nodes);
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics.join()).toContain('provider unavailable');
    const restored = await generateCourseMindMap({ course, scenes: scenes(), checkpoint, aiCall: vi.fn() });
    expect(restored.diagnostics).toEqual(result.diagnostics);
    await expect(generateCourseMindMap({ course, scenes: scenes(), aiCall: vi.fn().mockResolvedValue('broken JSON') }))
      .rejects.toThrow('不可执行');
  });
  it('includes every page and final speech in the model source without sending quiz answers', async () => {
    const full = Array.from({ length: 32 }, (_, index) => ({ ...scenes()[0]!, id: `page-${index}` }));
    full.push({ ...scenes()[0]!, id: 'quiz', type: 'quiz', content: { type: 'quiz', questions: [{ answer: 'SECRET_ANSWER' }] } } as unknown as Scene);
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ ...candidate(), bindings: [] }));
    await generateCourseMindMap({ course, scenes: full, aiCall });
    const prompt = aiCall.mock.calls[0]![1] as string;
    expect(prompt).toContain('page-31');
    const input = JSON.parse(prompt) as { source: { scenes: Array<{ speech?: unknown[] }> } };
    expect(input.source.scenes.filter((scene) => scene.speech?.length)).toHaveLength(32);
    expect(prompt).not.toContain('SECRET_ANSWER');
  });
});
