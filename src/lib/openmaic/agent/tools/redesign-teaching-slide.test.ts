import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { SceneContext } from './regenerate-scene-actions';
import { teachingVisualEditFixture } from '@openmaic/lib/edit/teaching-visual-edit-fixture';
import narrationOverrun from '@openmaic/lib/generation/__fixtures__/teaching-visual-narration-overrun.json';
import { redesignTeachingSlide } from './redesign-teaching-slide';

const mocks = vi.hoisted(() => ({ content: vi.fn(), actions: vi.fn(), narration: vi.fn(), compile: vi.fn(), independent: vi.fn() }));
vi.mock('@openmaic/lib/generation/scene-generator', () => ({ generateSceneContent: mocks.content, generateSceneActions: mocks.actions }));
vi.mock('@openmaic/lib/generation/slide-spatial-measurement', () => ({ measureAuthoredSlideText: vi.fn() }));
vi.mock('@openmaic/lib/generation/teaching-narration', () => ({
  canUseIndependentTeachingNarration: mocks.independent, generateTeachingSectionNarration: mocks.narration,
  compileTeachingNarrationActions: mocks.compile,
}));

function setup() {
  const content = teachingVisualEditFixture();
  delete content.canvas.teachingVisual;
  const facts = ['支架逐个撤除，不能等到最后一次性撤销。', '评价有自评、互评和教师评价。'];
  const outline: SceneOutline = { id: 'original', type: 'slide', title: '支架与评价', order: 1,
    description: facts.join(''), keyPoints: facts, targetDurationSec: 97,
    audience: 'student', generationPurpose: 'knowledge-teaching',
    visualIntent: { observationGoal: '理解撤除与评价', representation: 'mixed' },
    teachingBrief: { schemaVersion: 1, explanation: facts.join(''), examples: [], evidence: [], conditions: [], assessmentFocus: '',
      teachingPlan: { purpose: '', newContent: facts.join(''), priorKnowledge: '', learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: facts, presentationContent: facts, narrationFocus: [] } },
  };
  const context: SceneContext = { stageId: 'stage', outline, allOutlines: [
    { ...outline, id: 'previous', order: 0 }, outline, { ...outline, id: 'next', order: 2 },
  ], content, actions: [{ id: 'original-speech', type: 'speech', text: '保留讲解风格与有效案例。', audioUrl: '/old.wav' }] };
  const meta = teachingVisualEditFixture().canvas.teachingVisual!;
  meta.sourceCatalog = facts.map((text, index) => ({ id: `source-${index + 1}`, text }));
  const first: GeneratedSlideContent = { elements: structuredClone(content.canvas.elements), teachingVisual: meta,
    sourceGroupIds: ['source-1'], teachingText: [facts[0]!], continuationPages: [{
      elements: content.canvas.elements, teachingVisual: { ...structuredClone(meta), pageId: 'second' },
      sourceGroupIds: ['source-2'], teachingText: [facts[1]!],
    }] };
  meta.scene.pages = [{ id: 'page', title: '逐个撤除', focus: '撤除', components: [] },
    { id: 'second', title: '评价', focus: '主体', components: [] }];
  first.continuationPages![0]!.teachingVisual!.scene = structuredClone(meta.scene);
  mocks.content.mockResolvedValue(first);
  mocks.independent.mockReturnValue(true);
  mocks.narration.mockImplementation(async ({ pages }) => ({ pages: pages.map((page: { outline: SceneOutline }) => ({
    pageId: page.outline.id, segments: [{ id: `${page.outline.id}:speech`, text: '直接根据原始资料展开讲解。' }],
  })) }));
  mocks.compile.mockReturnValue({ issues: [], actions: [{ id: 'new-speech', type: 'speech', text: '直接根据原始资料展开讲解。' }] });
  const aiCall = vi.fn().mockResolvedValue('{}');
  const input: Parameters<typeof redesignTeachingSlide>[0] = { deps: { aiCall, getSceneContext: () => context }, context, instruction: '围绕观察对象重设计',
    imageResources: { baseline: { elements: content.canvas.elements }, assignedImages: [], imageMapping: {} } };
  return { input, first, aiCall };
}

beforeEach(() => vi.clearAllMocks());

describe('scoped historical teaching-page redesign', () => {
  it('expands before original-source narration and conserves the original 97-second responsibility', async () => {
    const { input, aiCall } = setup(), saved = structuredClone(input.context);
    const result = await redesignTeachingSlide(input);
    expect(result.visualRedesign?.pages).toHaveLength(2);
    expect(result.visualRedesign?.pages[0]?.outline.id).toBe('original');
    expect(result.visualRedesign?.pages.reduce((sum, page) => sum + page.outline.targetDurationSec!, 0)).toBe(97);
    expect(result.visualRedesign?.before).toEqual({ content: saved.content, actions: saved.actions });
    expect(input.context).toEqual(saved);
    const narration = mocks.narration.mock.calls[0]![0];
    expect(narration.pages.every((page: { outline: SceneOutline }) =>
      page.outline.teachingBrief?.teachingPlan?.newContent === saved.outline.teachingBrief?.teachingPlan?.newContent)).toBe(true);
    expect(narration.requirements.requirement).toContain('保留讲解风格与有效案例');
    expect(narration.courseProgression.map((page: SceneOutline) => page.id)).toEqual(['previous', 'original', 'original--continuation-2', 'next']);
    expect(mocks.content.mock.calls[0]![2]).toMatchObject({ teachingVisual: true, visualProjection: true, componentAuthoring: true });
    await mocks.content.mock.calls[0]![1]('system', 'original sources');
    expect(aiCall.mock.calls[0]).toEqual(['scene-content:slide', 'system', expect.stringContaining('围绕观察对象重设计'), undefined]);
  });

  it('retains the entire usable page and audio when measured candidates fail', async () => {
    const { input } = setup();
    mocks.content.mockImplementation(async (_outline, _call, options) => ({ ...options.visualBaseline,
      qualityDiagnostics: ['真实字体容量不足'] }));
    const result = await redesignTeachingSlide(input);
    expect(result.visualRedesign).toBeUndefined();
    expect(result.message).toContain('真实字体容量不足');
    expect(mocks.narration).not.toHaveBeenCalled();
    expect(input.context.actions?.[0]).toHaveProperty('audioUrl', '/old.wav');
  });

  it('refuses protected pages before any generation and preserves missing source context', async () => {
    const { input } = setup();
    input.context.content = teachingVisualEditFixture();
    input.context.content.canvas.teachingVisual!.components[0]!.locked = true;
    expect((await redesignTeachingSlide(input)).visualRedesign).toBeUndefined();
    expect(mocks.content).not.toHaveBeenCalled();
    delete input.context.outline.teachingBrief;
    expect((await redesignTeachingSlide(input)).message).toContain('已采用教学资料');
    expect(mocks.content).not.toHaveBeenCalled();
  });

  it('keeps the old page when an expanded fragment has no narration or a cue cannot bind', async () => {
    const { input } = setup();
    mocks.narration.mockResolvedValue({ pages: [] });
    expect((await redesignTeachingSlide(input)).message).toContain('缺少对应讲稿');
    const next = setup();
    mocks.compile.mockReturnValue({ actions: [], issues: [{ severity: 'blocking', message: '目标不存在' }] });
    const result = await redesignTeachingSlide(next.input);
    expect(result.visualRedesign).toBeUndefined();
    expect(result.message).toContain('目标不存在');
  });

  it('reuses fulfilled images without repeating the old media generation requests', async () => {
    const { input } = setup();
    input.context.outline.mediaGenerations = [{ elementId: 'old-request', type: 'image', prompt: '已经完成' }];
    input.imageResources.assignedImages = [{ id: 'actual-image', src: 'data:image/png;base64,AA', pageNumber: 0, width: 800, height: 600 }];
    await redesignTeachingSlide(input);
    const [outline, , options] = mocks.content.mock.calls[0]!;
    expect(outline.mediaGenerations).toBeUndefined();
    expect(outline.visualIntent.resourceRefs).toEqual([expect.objectContaining({ resourceId: 'actual-image', required: true })]);
    expect(options.assignedImages).toBe(input.imageResources.assignedImages);
  });

  it('forwards the same adopted sources independently to visual content and narration', async () => {
    const { input } = setup();
    input.context.teachingSources = {
      sourceKnowledgePoints: [{ id: 'adopted-point', evidenceItemIds: ['original-evidence'] }],
      sourceSequenceContracts: [{ resourceId: 'original-process', required: true,
        knowledgePointIds: ['adopted-point'], scope: 'single-page',
        orderedSteps: [{ label: '第一步' }, { label: '第二步' }] }],
    };
    await redesignTeachingSlide(input);
    expect(mocks.content.mock.calls[0]![2].sourceKnowledgePoints).toBe(input.context.teachingSources.sourceKnowledgePoints);
    expect(mocks.narration.mock.calls[0]![0].sourceKnowledgePoints).toBe(input.context.teachingSources.sourceKnowledgePoints);
    expect(mocks.content.mock.calls[0]![2].sourceSequenceContracts).toBe(input.context.teachingSources.sourceSequenceContracts);
    expect(mocks.narration.mock.calls[0]![0].sourceSequenceContracts).toBe(input.context.teachingSources.sourceSequenceContracts);
  });

  it('uses only preceding actual speech for already taught context and keeps the measured narration budget', async () => {
    const { input } = setup();
    input.context.sectionNarrations = [
      { sceneId: 'before', outlineId: 'previous', title: '前页', current: false,
        speeches: [{ id: 'before-speech', text: '前页已经讲解的严谨定义。' }] },
      { sceneId: 'current', outlineId: 'original', title: '本页', current: true,
        speeches: [{ id: 'current-speech', text: '本页既有讲稿。' }] },
      { sceneId: 'after', outlineId: 'next', title: '后页', current: false,
        speeches: [{ id: 'after-speech', text: '尚未讲授的后页内容。' }] },
    ];
    (input.context.actions![0] as { audioDurationSec?: number }).audioDurationSec = 97.84;
    await redesignTeachingSlide(input);
    const narration = mocks.narration.mock.calls[0]![0];
    expect(narration.previousSectionActualNarration).toEqual(['前页已经讲解的严谨定义。']);
    expect(narration.requirements.requirement).toContain('97秒教学预算');
    expect(narration.requirements.requirement).toContain('97.84秒');
    expect(narration.requirements.requirement).toContain('叙述范围的基准');
  });

  it('retains the page and narration without model calls when adopted source identity cannot be verified', async () => {
    const { input } = setup();
    input.context.teachingSourceDiagnostic = '原资源包版本与当前教材不一致';
    const result = await redesignTeachingSlide(input);
    expect(result.visualRedesign).toBeUndefined();
    expect(result.message).toContain('原资源包版本');
    expect(mocks.content).not.toHaveBeenCalled();
    expect(mocks.narration).not.toHaveBeenCalled();
  });

  it('retains the better original when a saved actual narration response materially extends its audio duration', async () => {
    const { input } = setup();
    input.context.actions = narrationOverrun.originalSpeeches.map((speech) => ({ ...speech, type: 'speech' as const }));
    input.context.outline.targetDurationSec = narrationOverrun.targetDurationSec;
    const original = structuredClone(input.context);
    mocks.compile.mockReturnValueOnce({ issues: [], actions: narrationOverrun.generatedSpeeches.slice(0, 2) })
      .mockReturnValueOnce({ issues: [], actions: narrationOverrun.generatedSpeeches.slice(2) });
    const result = await redesignTeachingSlide(input);
    expect(result.visualRedesign).toBeUndefined();
    expect(result.message).toContain('约需150秒');
    expect(result.message).toContain('原98秒');
    expect(result.message).toContain('音频已保留');
    expect(input.context).toEqual(original);
    expect(mocks.content).toHaveBeenCalledTimes(1);
    expect(mocks.narration).toHaveBeenCalledTimes(1);
  });

  it('reports a default-speed estimate when the original audio measurement is incomplete', async () => {
    const { input } = setup();
    input.context.actions = narrationOverrun.originalSpeeches.map((speech) => ({ ...speech,
      type: 'speech' as const, audioDurationSec: undefined }));
    mocks.compile.mockReturnValueOnce({ issues: [], actions: narrationOverrun.generatedSpeeches.slice(0, 2) })
      .mockReturnValueOnce({ issues: [], actions: narrationOverrun.generatedSpeeches.slice(2) });
    const result = await redesignTeachingSlide(input);
    expect(result.visualRedesign).toBeUndefined();
    expect(result.message).toContain('按默认语速估计约需164秒');
    expect(result.message).toContain('当前页面、讲稿和音频已保留');
  });

  it('honors cancellation before issuing a generation call', async () => {
    const { input } = setup(), controller = new AbortController();
    controller.abort();
    await expect(redesignTeachingSlide({ ...input, signal: controller.signal })).rejects.toHaveProperty('name', 'AbortError');
    expect(mocks.content).not.toHaveBeenCalled();
  });
});
