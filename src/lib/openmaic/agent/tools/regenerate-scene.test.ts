import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@openmaic/lib/types/action';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import type { SceneContext } from './regenerate-scene-actions';
import { makeRegenerateSceneTool, buildImageResources } from './regenerate-scene';
import { planRegenerateApply } from '../client/apply-regenerate';

const mocks = vi.hoisted(() => ({ contentOptions: vi.fn(), legacyContent: vi.fn(), legacyActions: vi.fn(), narration: vi.fn(), measure: vi.fn() }));
vi.mock('@openmaic/lib/generation/openmaic-baseline', async (original) => {
  const actual = await original<typeof import('@openmaic/lib/generation/openmaic-baseline')>();
  return { ...actual, generateOpenMaicBaselineContent: (...args: Parameters<typeof actual.generateOpenMaicBaselineContent>) => {
    mocks.contentOptions(args[2]);
    return actual.generateOpenMaicBaselineContent(...args);
  } };
});
vi.mock('@openmaic/lib/generation/scene-generator', () => ({ generateSceneContent: mocks.legacyContent, generateSceneActions: mocks.legacyActions }));
vi.mock('@openmaic/lib/generation/slide-spatial-measurement', () => ({ measureAuthoredSlideText: mocks.measure }));
vi.mock('@openmaic/lib/generation/teaching-narration', async (original) => ({
  ...await original<typeof import('@openmaic/lib/generation/teaching-narration')>(), generateTeachingSectionNarration: mocks.narration,
}));

const originalText = '学生能独立完成时撤除支架';
const textbook = '教材完整事实：根据学生独立完成能力决定撤除支架，继续任务时保留必要条件。';
const nativeText = (id: string, value: string) => ({ id, type: 'text' as const, left: 80, top: 130,
  width: 840, height: 100, rotate: 0, content: `<p style="font-size:22px">${value}</p>`,
  defaultFontName: 'Noto Sans SC', defaultColor: '#334155' });
const originalActions: Action[] = [
  { id: 'speech', type: 'speech', text: '同学们，接着前面的例子观察。学生能独立完成时撤除支架，继续任务时保留必要条件。',
    audioUrl: '/audio/original.wav', audioId: 'original-audio', audioDurationSec: 24,
    speechAlignment: { version: 'saved-alignment', status: 'aligned', audioHash: 'audio', textHash: 'text', spans: [] } },
  { id: 'cue', type: 'spotlight', elementId: 'old-body', speechId: 'speech', speechAnchor: { quote: originalText },
    speechOffsetMs: 1400, endSpeechOffsetMs: 20000, necessity: 'helpful' },
  { id: 'board', type: 'wb_open' }, { id: 'board-speech', type: 'speech', text: '保留原白板讲稿。', audioUrl: '/audio/board.wav' },
  { id: 'board-image', type: 'wb_draw_image', elementId: 'board-picture', src: '/source/whiteboard.png', x: 40, y: 80, width: 300, height: 200 },
  { id: 'close-board', type: 'wb_close' }, { id: 'discussion', type: 'discussion', topic: '保留原检测问题' },
];
const sourceEvidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'adopted-source', createdAt: '2026-10-03',
  retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [], items: [{ id: 'original', kind: 'source-block',
    title: '原教材', content: textbook, source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'book-v1', revisionVersion: 1,
      sectionPath: ['支架'], quote: textbook } }] };

function setup(elements: GeneratedSlideContent['elements'] = [nativeText('new-body', originalText)]) {
  const outline: SceneOutline = { id: 'outline', type: 'slide', title: '独立完成与支架', description: '判断何时撤除支架',
    keyPoints: [originalText], order: 1, audience: 'student', generationPurpose: 'knowledge-teaching', knowledgePointIds: ['point'],
    lectureSectionId: 'section', teachingBrief: { schemaVersion: 1, explanation: '原设计保留', examples: [], conditions: [], evidence: [], assessmentFocus: '',
      manuscript: { sectionId: 'section', segmentIds: ['node'] } } };
  const ctx: SceneContext = { stageId: 'stage', outline, allOutlines: [outline], actions: structuredClone(originalActions),
    content: { type: 'slide', canvas: { id: 'canvas', viewportSize: 1000, viewportRatio: 0.5625,
      theme: { backgroundColor: '#ffffff', themeColors: [], fontColor: '#334155', fontName: 'Noto Sans SC',
        outline: { color: '#334155', width: 1, style: 'solid' }, shadow: { h: 0, v: 0, blur: 0, color: '#000' } },
      elements: [nativeText('old-body', originalText)] } },
    sourceEvidence, sourceKnowledgePoints: [{ id: 'point', evidenceItemIds: ['original'] }],
    teachingManuscripts: [{ sectionId: 'section', segments: [{ id: 'node', text: '已保存连续讲稿，只用作职责上下文。' }] }],
  };
  const aiCall = vi.fn().mockResolvedValue(JSON.stringify({ elements }));
  return { ctx, aiCall, tool: makeRegenerateSceneTool({ aiCall, getSceneContext: () => ctx }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.measure.mockImplementation(async ({ text, fontSize = 22 }: { text: string; fontSize?: number }) => ({
    height: fontSize * 1.5, naturalWidth: text.length * fontSize, lines: [text], inkBottom: fontSize * 1.4, inkRight: text.length * fontSize,
  }));
});

describe('active native PPT-only regeneration', () => {
  it('uses one restored-native request with original sources and saved manuscript; preserves all speech/audio/quiz/board fields', async () => {
    const { ctx, aiCall, tool } = setup();
    const before = structuredClone(ctx);
    const result = await tool.execute('redraw', { sceneId: 'scene', instruction: '恢复更精美紧凑的页面，保留讲稿。' });
    expect(aiCall).toHaveBeenCalledTimes(1);
    const [stage, system, prompt] = aiCall.mock.calls[0];
    expect(stage).toBe('scene-content:slide');
    expect(system).toContain('PPT_RESTORED_NATIVE_4615');
    expect(prompt).toContain(textbook);
    expect(prompt).toContain('已保存连续讲稿，只用作职责上下文');
    expect(prompt).toContain(originalActions[0].type === 'speech' ? originalActions[0].text : '');
    expect(mocks.contentOptions).toHaveBeenCalledWith(expect.objectContaining({ componentAuthoring: true, textMeasure: mocks.measure,
      sourceEvidence, visualBaseline: expect.objectContaining({ elements: before.content.type === 'slide' ? before.content.canvas.elements : [] }) }));
    expect(mocks.narration).not.toHaveBeenCalled();
    expect(mocks.legacyActions).not.toHaveBeenCalled();
    expect(result.details.content?.elements[0]?.id).toBe('new-body');
    expect(result.details.actions.filter((action) => action.type !== 'spotlight')).toEqual(originalActions.filter((action) => action.type !== 'spotlight'));
    expect(result.details.actions[1]).toEqual({ ...originalActions[1], elementId: 'new-body', selector: undefined });
    expect(result.details).not.toHaveProperty('sourceEvidence');
    expect(ctx).toEqual(before);
    const plan = planRegenerateApply(result.details, { content: ctx.content, actions: ctx.actions }, 'regenerate_scene');
    expect(plan.patch?.actions).toEqual(result.details.actions);
    expect(plan.patch).not.toHaveProperty('outline');
  });

  it('omits an ambiguous optional cue with true diagnostics and preserves the new PPT', async () => {
    const { ctx, tool } = setup([nativeText('a', originalText), { ...nativeText('b', originalText), top: 290 }]);
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result).not.toHaveProperty('isError', true);
    expect(result.details.content?.elements.map((element) => element.id)).toEqual(['a', 'b']);
    expect(result.details.actions).toEqual(ctx.actions?.filter((action) => action.type !== 'spotlight'));
    expect(result.details.content?.qualityDiagnostics).toContainEqual(expect.stringContaining('omitted this optional cue'));
  });

  it('retains the usable original page/actions when its essential cue cannot bind', async () => {
    const { ctx, tool, aiCall } = setup([nativeText('new-body', '新的概述文本')]);
    ctx.actions![1] = { ...ctx.actions![1], type: 'spotlight', elementId: 'old-body', necessity: 'essential' };
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result).not.toHaveProperty('isError', true);
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(result.details.content?.elements).toEqual(ctx.content.type === 'slide' ? ctx.content.canvas.elements : []);
    expect(result.details.actions).toEqual(ctx.actions);
    expect(result.details.content?.qualityDiagnostics).toContainEqual(expect.stringContaining('retained the saved slide and its essential cue'));
  });

  it('reports real factual loss and keeps an existing saved draft, without rewriting narration', async () => {
    const { ctx, tool } = setup([nativeText('new-body', '独立完成练习')]);
    ctx.outline.keyPoints = ['完成3次练习'];
    ctx.outline.teachingBrief = { ...ctx.outline.teachingBrief!, teachingPlan: { presentationContent: ['完成3次练习'] } } as SceneOutline['teachingBrief'];
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result).not.toHaveProperty('isError', true);
    expect(result.details.content?.qualityDiagnostics).toContainEqual(expect.stringContaining('Restored native display quantity:'));
    expect(result.details.content?.elements).toEqual(ctx.content.type === 'slide' ? ctx.content.canvas.elements : []);
    expect(result.details.actions).toEqual(ctx.actions);
  });

  it('reuses local source images instead of generating new media', async () => {
    const { ctx, tool } = setup();
    if (ctx.content.type !== 'slide') throw new Error('fixture');
    ctx.content.canvas.elements.push({ type: 'image', id: 'figure', src: '/api/textbooks/figures/identity.png',
      left: 50, top: 300, width: 250, height: 150, rotate: 0, fixedRatio: true });
    ctx.content.canvas.contentBindings = [{ sourceContentId: 'image:textbook-original-figure', elementId: 'figure' }];
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result.details.content?.elements).toEqual(ctx.content.canvas.elements);
    expect(result.details.actions).toEqual(ctx.actions);
    expect(mocks.contentOptions.mock.calls[0][0]).toMatchObject({ imageMapping: {
      'textbook-original-figure': '/api/textbooks/figures/identity.png',
    }, assignedImages: [expect.objectContaining({ id: 'textbook-original-figure', required: true })] });
  });

  it('preserves the saved background and synchronous video action address after a visual redraw', async () => {
    const video = { id: 'saved-video', type: 'video' as const, src: '/videos/original.mp4', autoplay: false,
      left: 600, top: 300, width: 320, height: 180, rotate: 0 };
    const { ctx, tool } = setup([nativeText('new-body', originalText), { ...video, id: 'new-video', left: 560 }]);
    if (ctx.content.type !== 'slide') throw new Error('fixture');
    ctx.content.canvas.elements.push(video);
    ctx.content.canvas.background = { type: 'image', image: { src: '/background/saved.png', size: 'cover' } };
    ctx.actions!.push({ id: 'play', type: 'play_video', elementId: video.id });
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result).not.toHaveProperty('isError', true);
    expect(result.details.content?.elements.find((element) => element.type === 'video')).toMatchObject({ id: 'saved-video', left: 560, src: video.src });
    expect(result.details.content?.background).toEqual(ctx.content.canvas.background);
    expect(result.details.actions.at(-1)).toEqual(ctx.actions!.at(-1));
    expect(result.details.actions[0]).toEqual(ctx.actions![0]);
  });

  it('keeps technical parse failures unapplied and retains the original narration', async () => {
    const { ctx, aiCall, tool } = setup(); aiCall.mockResolvedValue('not JSON');
    const before = structuredClone(ctx);
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result).toHaveProperty('isError', true);
    expect(result.details.content).toBeNull();
    expect(ctx).toEqual(before);
  });

  it('rejects a completed request when confirmed source facts change in flight', async () => {
    const { ctx, aiCall } = setup();
    const assertCurrentSources = vi.fn().mockResolvedValue(false);
    const tool = makeRegenerateSceneTool({ aiCall, getSceneContext: () => ctx, assertCurrentSources });
    const before = structuredClone(ctx);
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(assertCurrentSources).toHaveBeenCalledOnce();
    expect(result).toHaveProperty('isError', true);
    expect(result.details.content).toBeNull();
    expect(result.details.actions).toEqual([]);
    expect(ctx).toEqual(before);
  });

  it('keeps the existing teacher-slide content/action regeneration path', async () => {
    const { ctx, tool } = setup(); ctx.outline.audience = 'teacher';
    mocks.legacyContent.mockResolvedValue({ elements: [nativeText('new', originalText)] });
    mocks.legacyActions.mockResolvedValue([{ id: 'new-speech', type: 'speech', text: '原行为的讲解' }]);
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(mocks.legacyContent).toHaveBeenCalledOnce();
    expect(mocks.legacyActions).toHaveBeenCalledOnce();
    expect(result.details.actions).toEqual([{ id: 'new-speech', type: 'speech', text: '原行为的讲解' }]);
    expect(result.details).not.toHaveProperty('visualPatch');
  });

  it('keeps non-slide quiz/widget/PBL main content out of the slide tool', async () => {
    const { ctx, tool, aiCall } = setup(); ctx.outline.type = 'quiz';
    const result = await tool.execute('redraw', { sceneId: 'scene' });
    expect(result).toHaveProperty('isError', true);
    expect(aiCall).not.toHaveBeenCalled();
  });
});

describe('saved image resources', () => {
  it('preserves evidence identity and avoids img_N collisions without altering the stored slide', () => {
    const image = (id: string, src: string) => ({ id, type: 'image' as const, src, left: 50, top: 100, width: 250, height: 150,
      rotate: 0, fixedRatio: true });
    const baseline: GeneratedSlideContent = { elements: [image('first', '/api/figure-one'), image('second', '/api/figure-two')],
      contentBindings: [{ sourceContentId: 'image:img_1', elementId: 'first' }, { sourceContentId: 'image:img_1', elementId: 'first' }] };
    const before = structuredClone(baseline);
    const result = buildImageResources(baseline);
    expect(result.imageMapping).toEqual({ img_1: '/api/figure-one', img_2: '/api/figure-two' });
    expect(baseline).toEqual(before);
  });
});
