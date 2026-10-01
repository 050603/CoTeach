import { describe, expect, it, vi } from 'vitest';
import type { SceneOutline } from '../types/generation';
import { generateSlideVisualProjection, slideVisualSourceContent, unchangedSlideProjection,
  SLIDE_VISUAL_PROJECTION_OPERATION } from './slide-visual-projection';
import { generateOpenMaicBaselineContent } from './openmaic-baseline';
import { measureAuthoredSlideText, closeSpatialMeasurementBrowser } from './slide-spatial-measurement';

function page(points: string[]): SceneOutline {
  return { id: 'page', type: 'slide', title: '支架撤除', order: 0, description: '知识讲授', keyPoints: points,
    audience: 'student', generationPurpose: 'knowledge-teaching', teachingBrief: {
      schemaVersion: 1, explanation: points.join('。'), examples: [], conditions: [], evidence: [], assessmentFocus: '',
      teachingPlan: { purpose: '', priorKnowledge: '', newContent: points.join('。'), learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: points, presentationContent: points, narrationFocus: [] },
    } };
}
describe('single-pass source-mapped PPT visual projection', () => {
  it('condenses display prose while keeping the original teaching contract and one production request', async () => {
    const original = '支架不是最后阶段一次性撤销，而是一个一个地随着学生的发展而撤销';
    const outline = page([original]);
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify({ items: [{ id: 'withdrawal',
      sourceContentIds: ['adopted-content-1'], label: '逐步撤除', text: '随学生发展逐个撤除，非最后一次性撤销', emphasis: ['逐个撤除'] }] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.projection.verified).toBe(true);
    expect(result?.projection.items[0]?.text).toBe('随学生发展逐个撤除，非最后一次性撤销');
    expect(outline).toEqual(saved);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![0]).toContain(SLIDE_VISUAL_PROJECTION_OPERATION);
    expect(ai.mock.calls[0]![1]).toContain(original);
    expect(ai.mock.calls[0]![0]).not.toContain('PPT_VISUAL_REVIEW');
  });

  it('retains the complete original point when a numeric condition is lost without requesting a judge or repair', async () => {
    const original = '至少完成3次实验，误差不超过5%';
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bad', sourceContentIds: ['adopted-content-1'], text: '完成3次实验，误差5%' }] }));
    const result = await generateSlideVisualProjection(page([original]), ai);
    expect(result?.projection.items[0]?.text).toBe(original);
    expect(result?.diagnostics.join(' ')).toContain('quantity boundary');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('accepts equivalent numeric bounds as single-call display content', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bounds', sourceContentIds: ['adopted-content-1'], text: '实验≥3次；误差≤5%' }] }));
    const result = await generateSlideVisualProjection(page(['至少完成3次实验，误差不超过5%']), ai);
    expect(result?.diagnostics).toEqual([]);
    expect(result?.projection.items[0]?.text).toBe('实验≥3次；误差≤5%');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('rejects an omitted quantity even if a model could have claimed success', async () => {
    const original = '至少完成3次实验，误差不超过5%';
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bad', sourceContentIds: ['adopted-content-1'], text: '完成实验并检查误差' }] }));
    const result = await generateSlideVisualProjection(page([original]), ai);
    expect(result?.projection.items[0]?.text).toBe(original);
    expect(result?.diagnostics).toContain('Changed or omitted quantity in adopted-content-1');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('does not accept source ids or evidence invented by the layout model', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'bad', sourceContentIds: ['another-page'],
      sourceEvidenceIds: ['unadopted-book'], text: '独立解决问题后撤除支架' }] }));
    const result = await generateSlideVisualProjection(page(['独立解决问题后撤除支架']), ai);
    expect(result?.projection.verified).toBe(true);
    expect(result?.diagnostics).toEqual(expect.arrayContaining(['Unknown source for bad', 'Unadopted evidence for bad',
      'Missing adopted point adopted-content-1']));
  });

  it('checks the complete annotation while preserving every original process node and edge', async () => {
    const outline = page(['提供分层支架']);
    outline.visualIntent = { representation: 'native-diagram', observationGoal: '观察逐步撤除', diagram: {
      topology: 'sequence', nodes: [{ id: 'a', label: '搭脚手架' }, { id: 'b', label: '独立探索' }],
      edges: [{ from: 'a', to: 'b' }], annotation: '随着学生能力提升，逐步减少和撤出支架' } };
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValueOnce(JSON.stringify({ items: [
      { id: 'support', sourceContentIds: ['adopted-content-1'], text: '提供分层支架' },
      { id: 'annotation', sourceContentIds: ['diagram-annotation'], text: '能力提升 → 逐步撤除支架' },
    ] }));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.projection.verified).toBe(true);
    expect(slideVisualSourceContent(outline).at(-1)?.id).toBe('diagram-annotation');
    expect(outline).toEqual(saved);
  });

  it('splits page 13 comparison structure into dimensions, objects and real cell explanations', () => {
    const projection = unchangedSlideProjection([
      { id: 'inquiry', text: '问题类型｜探究式：通过实验、自主探索和讨论交流给出答案' },
      { id: 'problem', text: '问题类型｜问题式：不存在唯一正确答案和单一解决方法的劣构问题' },
    ]);
    expect(projection.items).toEqual([
      { id: 'inquiry', sourceContentIds: ['inquiry'], row: '问题类型', column: '探究式', text: '通过实验、自主探索和讨论交流给出答案' },
      { id: 'problem', sourceContentIds: ['problem'], row: '问题类型', column: '问题式', text: '不存在唯一正确答案和单一解决方法的劣构问题' },
    ]);
  });

  it('separates page 21 characteristic headings without removing qualifiers or parsing mathematical bars', () => {
    const projection = unchangedSlideProjection([
      { id: 'context', text: '特征｜教学情境的真实性：在真实或接近真实的情境中学习' },
      { id: 'formula', text: '条件概率 P(A|B) = P(A∩B)/P(B)' },
    ]);
    expect(projection.items[0]).toMatchObject({ label: '教学情境的真实性', text: '在真实或接近真实的情境中学习' });
    expect(projection.items[1]?.text).toBe('条件概率 P(A|B) = P(A∩B)/P(B)');
  });

  it.each(['', '{"items":[]}', '{"items":[{"id":"x","text":"标题"}]}'])('keeps empty or non-executable output a technical error', async (response) => {
    const ai = vi.fn().mockResolvedValue(response);
    await expect(generateSlideVisualProjection(page(['事实']), ai)).rejects.toMatchObject({ code: 'INVALID_GENERATED_OUTPUT' });
  });

  it('does not treat missing source mapping as a complete display contract', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'one', sourceContentIds: ['adopted-content-1'], text: '必要条件' }] }));
    const result = await generateSlideVisualProjection(page(['必要条件', '完整并列项目']), ai);
    expect(result?.projection.items).toHaveLength(2);
    expect(result?.projection.items[1]?.text).toBe('完整并列项目');
    expect(result?.diagnostics).toContain('Missing adopted point adopted-content-2');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('reads missing legacy image dimensions from real bytes and retains source and generated image bindings in one call', async () => {
    const original = '完整观察案例图中的事物关系';
    const outline: SceneOutline = { ...page([original]), mediaGenerations: [{ type: 'image',
      elementId: 'case-image', prompt: '既有案例插图', aspectRatio: '4:3' }] };
    const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD/wAAAAASUVORK5CYII=';
    const ai = vi.fn().mockResolvedValue(JSON.stringify({ items: [{ id: 'observation',
      text: '观察图中事物关系', sourceContentIds: ['adopted-content-1'] }] }));
    try {
      const result = await generateOpenMaicBaselineContent(outline, ai, {
        visualProjection: true, componentAuthoring: true, textMeasure: measureAuthoredSlideText,
        assignedImages: [{ id: 'textbook-figure', src, pageNumber: 7, sourceTitle: '原教材' }],
        imageMapping: { 'textbook-figure': '/original-figure.png' },
        generatedMediaMapping: { 'gen_img_case-image': '/existing-case.png' },
      });
      expect(result).not.toBeNull();
      if (!result || !('elements' in result)) throw new Error('Expected a native slide');
      const images = result.elements.filter((element) => element.type === 'image');
      expect(images.map((image) => image.src)).toEqual(['/original-figure.png', '/existing-case.png']);
      expect(images[0]!.width / images[0]!.height).toBeCloseTo(1);
      expect(images[1]!.width / images[1]!.height).toBeCloseTo(4 / 3);
      expect(result.elements.find((element) => element.id === 'textbook-figure-caption')).toMatchObject({ content: expect.stringContaining('原教材') });
      expect(result.qualityDiagnostics).toEqual([]);
      expect(ai).toHaveBeenCalledOnce();
    } finally { await closeSpatialMeasurementBrowser(); }
  });
});
