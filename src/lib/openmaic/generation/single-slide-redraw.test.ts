import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PPTElement } from '@openmaic/dsl';
import type { Scene } from '../types/stage';
import type { Action } from '../types/action';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { remapActions, nonVisualActions, runReadOnlyDatabaseOperation, assertOriginalSlideSnapshot } from '../../../../scripts/redraw-course-slide';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { withTeachingSlideGuidance } from './teaching-narration';

const sourcePoints = [
  { id: 'adopted-content-1', text: '教学支架的撤除' },
  { id: 'adopted-content-2', text: '支架具有暂时性和渐消性：学生能独立解决问题时，支架的作用完成，需要撤离' },
  { id: 'adopted-content-3', text: '支架不是最后阶段一次性撤销，而是一个一个地随着学生的发展而撤销' },
];
const labels = ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = (id: string, value: string, left = 60, top = 140, width = 340, height = 50): PPTElement => ({
  id, type: 'text', left, top, width, height, rotate: 0, content: `<p>${value}</p>`,
  defaultColor: '#334155', defaultFontName: 'Noto Sans SC',
});
function fixture(): { original: Scene; outline: SceneOutline; content: GeneratedSlideContent } {
  const actions: Action[] = [
    { id: 'speech-1:anchor-1:focus', type: 'spotlight', elementId: 'adopted-removal-mechanism', speechId: 'speech-1',
      speechAnchor: { quote: '教学支架具有暂时性和渐消性', occurrence: 0 }, endSpeechId: 'speech-1',
      speechOffsetMs: 5360, endSpeechOffsetMs: 7760, necessity: 'helpful' },
    { id: 'speech-1:anchor-2:focus', type: 'spotlight', elementId: 'adopted-removal-mechanism', speechId: 'speech-1',
      speechAnchor: { quote: '而是一个一个地随着学生的不断发展而撤销的', occurrence: 0 }, endSpeechId: 'speech-1',
      speechOffsetMs: 22400, endSpeechOffsetMs: 25680, necessity: 'helpful' },
    { id: 'speech-1', type: 'speech', text: '教学支架具有暂时性和渐消性。支架不是最后一次性撤销，而是一个一个地撤销。',
      audioId: 'tts-original-1', audioUrl: '/api/openmaic/classroom-media/original/audio/1.wav', audioDurationSec: 34.72,
      speechAlignment: { version: 'test-alignment', status: 'aligned', language: 'zh-CN', textHash: 'original-text', audioHash: 'original-audio',
        spans: [{ text: '教学', startChar: 0, endChar: 2, startMs: 5200, endMs: 5520 }] } },
    { id: 'speech-2:anchor-1:focus', type: 'laser', elementId: 'old-component-0-node-c1', speechId: 'speech-2',
      speechAnchor: { quote: '搭脚手架', occurrence: 0 }, endSpeechAnchor: { quote: '围绕自主学习能力、协作贡献和知识意义建构展开', occurrence: 0 },
      speechOffsetMs: 6000, endSpeechOffsetMs: 62880, necessity: 'helpful',
      waypoints: labels.slice(1).map((label, index) => ({ elementId: `old-component-0-node-c${index + 2}`,
        speechAnchor: { quote: label, occurrence: 0 }, speechOffsetMs: [18560, 29840, 43840, 52880][index] })) },
    { id: 'speech-2', type: 'speech', text: '搭脚手架、进入情境、独立探索、协作学习、效果评价。',
      audioId: 'tts-original-2', audioUrl: '/api/openmaic/classroom-media/original/audio/2.wav', audioDurationSec: 63.12 },
  ];
  const original: Scene = { id: 'scene_I7CDmvtIcv', outlineId: 'teaching-section-6-page-2', stageId: 'txNvGrC6Sz', type: 'slide',
    title: '支架的撤除与支架式教学法的教学过程', order: 18, targetDurationSec: 97, actions,
    content: { type: 'slide', canvas: { id: 'original', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { fontName: 'Microsoft YaHei', fontColor: '#333333', backgroundColor: '#ffffff', themeColors: ['#1E3A8A'] },
      elements: [text('adopted-removal-mechanism', sourcePoints.map((point) => point.text).join('<br><br>')),
        ...labels.map((label, index) => text(`old-component-0-node-c${index + 1}`, label))] } } };
  const outline: SceneOutline = { id: original.outlineId!, type: 'slide', title: original.title, order: original.order,
    description: '逐个撤除教学支架并完整呈现五步教学过程。', keyPoints: sourcePoints.map((point) => point.text),
    visualIntent: { representation: 'native-diagram', rationale: '真实五步顺序', observationGoal: '观察五个环节的完整先后关系', diagram: {
      topology: 'sequence', nodes: labels.map((label, index) => ({ id: `c${index + 1}`, label })),
      edges: labels.slice(1).map((_, index) => ({ from: `c${index + 1}`, to: `c${index + 2}` })),
    } } };
  const content: GeneratedSlideContent = {
    elements: [text('condition', '教学支架具有暂时性和渐消性'), text('condition-detail', '独立解决问题时撤离', 60, 200),
      text('gradual-one', '逐个撤销', 60, 300), text('gradual-two', '随学生发展逐渐减少', 60, 362, 340, 50),
      text('unrelated-panel', '另一来源的观点', 0, 0, 1000, 562),
      ...labels.map((label, index) => text(`new-component-4-node-c${index + 1}`, label))],
    presentationProjection: { schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true,
      items: [
        { id: 'condition', text: '教学支架具有暂时性和渐消性', sourceContentIds: ['adopted-content-2'] },
        { id: 'condition-detail', text: '独立解决问题时撤离', sourceContentIds: ['adopted-content-2'] },
        { id: 'gradual-one', text: '逐个撤销', sourceContentIds: ['adopted-content-3'] },
        { id: 'gradual-two', text: '随学生发展逐渐减少', sourceContentIds: ['adopted-content-3'] },
      ], elementIdsBySource: { 'adopted-content-2': ['condition', 'condition-detail'], 'adopted-content-3': ['gradual-one', 'gradual-two'] } },
  };
  return { original, outline, content };
}

const cleanup: string[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true }))); });

describe('single-slide PPT redraw safety and visual target recovery', () => {
  it('uses the narration anchor to distinguish source points in an old combined paragraph and preserves all oral fields', () => {
    const { original, outline, content } = fixture();
    const originalHash = hash(original);
    const result = remapActions(original, outline, content, sourcePoints);
    expect(result.actions[0]).toMatchObject({ type: 'spotlight', elementId: 'condition' });
    expect(nonVisualActions(result.actions)).toEqual(nonVisualActions(original.actions));
    expect(result.actions.filter((action) => action.type === 'speech')).toEqual(original.actions?.filter((action) => action.type === 'speech'));
    expect(hash(original)).toBe(originalHash);
    expect(result.mappings.every((mapping) => !mapping.diagnostic)).toBe(true);
  });

  it('focuses only the mapped source elements when a source is split, without drawing a new panel', () => {
    const { original, outline, content } = fixture();
    const result = remapActions(original, outline, content, sourcePoints);
    const id = result.actions[1].type === 'spotlight' ? result.actions[1].elementId : undefined;
    const group = result.content.elements.find((element) => element.id === id);
    expect(group).toMatchObject({ type: 'shape', left: 60, top: 300, width: 340, height: 112, fill: 'transparent' });
    expect(group && 'outline' in group ? group.outline : undefined).toBeUndefined();
    expect(group?.id).not.toBe('unrelated-panel');
  });

  it('remaps all five sequence nodes and laser waypoints even when the compiled component prefix changes', () => {
    const { original, outline, content } = fixture();
    const result = remapActions(original, outline, content, sourcePoints);
    const laser = result.actions.find((action) => action.type === 'laser');
    expect(laser?.elementId).toBe('new-component-4-node-c1');
    expect(laser?.waypoints?.map((point) => point.elementId)).toEqual(labels.slice(1).map((_, index) => `new-component-4-node-c${index + 2}`));
    expect(nonVisualActions(result.actions)).toEqual(nonVisualActions(original.actions));
  });

  it('reports ambiguous source matches and keeps the original cue instead of guessing', () => {
    const { original, outline, content } = fixture();
    const duplicate = [...sourcePoints, { ...sourcePoints[1], id: 'ambiguous-other-source' }];
    const result = remapActions(original, outline, content, duplicate);
    expect(result.actions[0]).toMatchObject({ elementId: 'adopted-removal-mechanism' });
    expect(result.mappings.find((mapping) => mapping.actionId === 'speech-1:anchor-1:focus')).toMatchObject({ diagnostic: expect.any(String) });
    expect(nonVisualActions(result.actions)).toEqual(nonVisualActions(original.actions));
  });

  it('rejects any altered source action, speech, or adopted outline before authoring', () => {
    const { original, outline } = fixture();
    const snapshot = { sceneId: original.id, outlineId: outline.id, originalSceneSha256: hash(original), originalOutlineSha256: hash(outline) };
    expect(() => assertOriginalSlideSnapshot(original, outline, snapshot)).not.toThrow();
    const altered = structuredClone(original);
    if (altered.actions?.[0].type === 'spotlight') altered.actions[0].speechOffsetMs = 0;
    expect(() => assertOriginalSlideSnapshot(altered, outline, snapshot)).toThrow('快照在调用前发生变化');
    const changedSpeech = structuredClone(original);
    const speech = changedSpeech.actions?.find((action) => action.type === 'speech');
    if (speech) speech.text = '重写讲稿';
    expect(() => assertOriginalSlideSnapshot(changedSpeech, outline, snapshot)).toThrow('快照在调用前发生变化');
    expect(() => assertOriginalSlideSnapshot(original, { ...outline, keyPoints: [] }, snapshot)).toThrow('快照在调用前发生变化');
  });

  it('uses exactly one projection request and retains the existing canvas when the infographic cannot fit', async () => {
    const { original, outline } = fixture();
    if (original.content.type !== 'slide') throw new Error('invalid fixture');
    const adopted = sourcePoints.map((point) => point.text);
    const page: SceneOutline = { ...outline, audience: 'student', generationPurpose: 'knowledge-teaching', teachingBrief: {
      schemaVersion: 1, explanation: adopted.join('。'), examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '理解逐步撤除', priorKnowledge: '', newContent: adopted.join('。'), learnerQuestion: '', reasoningSteps: [],
        takeaway: adopted.join('；'), visibleContent: adopted, presentationContent: adopted, narrationFocus: [] },
    } };
    const originalHash = hash(original);
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify({ items: [
      { id: 'withdrawal-condition', sourceContentIds: ['adopted-content-1', 'adopted-content-2'], label: '教学支架的撤除',
        text: '具有暂时性和渐消性：能独立解决问题时撤离' },
      { id: 'withdrawal-boundary', sourceContentIds: ['adopted-content-3'], text: '随学生发展逐个撤除，非最后一次性撤销' },
    ], links: [] }));
    const generated = await generateOpenMaicBaselineContent(page, withTeachingSlideGuidance(ai, page), {
      componentAuthoring: true, slideAuthoring: 'native', visualProjection: true, visualBaseline: original.content.canvas,
      textMeasure: () => ({ naturalWidth: 1000, height: 10000, lines: ['actual measurement reports overflow'] }),
      websiteReferenceContext: { courseTitle: '中小学人工智能教育的教学理论与方法', slideTitles: [original.title] },
    });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(generated && 'elements' in generated ? generated.elements : null).toEqual(original.content.canvas.elements);
    expect(generated && 'qualityDiagnostics' in generated ? generated.qualityDiagnostics?.join(' ') : '').toContain('retained the existing usable draft');
    expect(hash(original)).toBe(originalHash);
  });

  it.each(['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany', '$executeRaw', '$queryRaw'])('blocks database %s before a query runs', (operation) => {
    const query = vi.fn(async () => 'unexpected write');
    expect(() => runReadOnlyDatabaseOperation('GenerationJob', operation, query)).toThrow('禁止数据库写入');
    expect(query).not.toHaveBeenCalled();
  });

  it('permits a source read through the same database guard', async () => {
    const query = vi.fn(async () => [{ id: 'original-job' }]);
    expect(await runReadOnlyDatabaseOperation('GenerationJob', 'findMany', query)).toEqual([{ id: 'original-job' }]);
    expect(query).toHaveBeenCalledOnce();
  });

  it('defaults to snapshot-only execution without reading deployment secrets, reaching a model, or changing the source', async () => {
    const repository = process.cwd();
    await fs.mkdir(path.join(repository, '.openpbl-runtime'), { recursive: true });
    const directory = await fs.mkdtemp(path.join(repository, '.openpbl-runtime/single-slide-redraw-test-'));
    cleanup.push(directory);
    const input = path.join(directory, 'input');
    const output = path.join(directory, 'output');
    await fs.mkdir(input);
    const { original, outline } = fixture();
    const source = path.join(directory, 'source-classroom.json');
    const bytes = JSON.stringify({ scenes: [original] });
    await fs.writeFile(source, bytes);
    await fs.writeFile(path.join(input, 'snapshot.json'), JSON.stringify({ schemaVersion: 1, requestId: 'original', classroomFile: source,
      classroomSha256: createHash('sha256').update(bytes).digest('hex'), sceneId: original.id, outlineId: outline.id, slide: 19 }));
    const result = await promisify(execFile)(process.execPath, [path.join(repository, 'node_modules/tsx/dist/cli.mjs'),
      path.join(repository, 'scripts/redraw-course-slide.ts'), '--snapshot-dir', input, '--output', output, '--no-render', '--deployment-secrets'], {
      cwd: repository, timeout: 15_000,
      env: { ...process.env, NODE_OPTIONS: '--conditions=import', OPENPBL_SECRET_DIR: path.join(directory, 'secrets-do-not-exist'),
        DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/forbidden', PROVIDER_CONFIG_DATABASE_URL: '', PROVIDER_ENCRYPTION_KEY: '' },
    });
    expect(result.stdout).toContain('"generated":false');
    expect(await fs.readFile(source, 'utf8')).toBe(bytes);
    expect(await fs.readdir(output)).toEqual(expect.arrayContaining(['snapshot', 'source-preservation.json']));
    expect((await fs.readdir(output)).some((filename) => /generation|model|after-scene/u.test(filename))).toBe(false);
  }, 20_000);
});
