import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SlidePresentationProjection, PPTTextElement } from '@openmaic/dsl';
import type { GeneratedSlideContent, SceneOutline } from '../types/generation';
import { generateSlideVisualProjection, slideVisualSourceContent, SLIDE_VISUAL_LAYOUT_VERSION } from './slide-visual-projection';
import { compileSlideInfographic, compileOriginalSlideDraft } from './slide-infographic-layout';
import { measureAuthoredSlideText, closeSpatialMeasurementBrowser } from './slide-spatial-measurement';
import { auditSlideLayout, auditSlideDensity, closeSlideLayoutAuditBrowser } from './slide-layout-audit';
import { REFERENCE_LECTURE_TYPOGRAPHY } from './slide-presentation-typography';
import { expandCompiledSlidePages } from './compiled-slide-pages';
import { bindTeachingManuscript } from '@/lib/course-design/teaching-manuscript';

const outline: SceneOutline = { id: 'visual-design', type: 'slide', order: 0, title: '把已有经验用于新任务', description: '', keyPoints: [],
  audience: 'student', generationPurpose: 'knowledge-teaching',
  teachingBrief: { schemaVersion: 1, explanation: '完整解释由讲稿承担，不逐句上屏。', examples: [], conditions: [], evidence: [], assessmentFocus: '',
    teachingPlan: { purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '', narrationFocus: [], visibleContent: [],
      presentationContent: ['把已有知识用于新的任务', '少量任务数据用于微调', '保留预训练得到的基础'], presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY } } };
const projection = (patch: Partial<SlidePresentationProjection> = {}): SlidePresentationProjection => ({
  schemaVersion: 1, layoutVersion: SLIDE_VISUAL_LAYOUT_VERSION, verified: true, elementIdsBySource: {},
  items: [
    { id: 'core', label: '迁移学习', text: '把已有知识用于新的任务', sourceContentIds: ['adopted-content-1'] },
    { id: 'data', label: '任务数据', text: '少量任务数据用于微调', sourceContentIds: ['adopted-content-2'] },
    { id: 'model', label: '基础模型', text: '保留预训练得到的基础', sourceContentIds: ['adopted-content-3'] },
  ], ...patch,
});
function expectCenteredBody(content: GeneratedSlideContent): void {
  const title = content.elements.find((element) => element.id === 'infographic-title') as PPTTextElement;
  const body = content.elements.filter((element) => element.type !== 'line')
    .filter((element) => element.id !== title.id && !('opacity' in element && element.opacity === 0));
  expect(body.length).toBeGreaterThan(0);
  const top = Math.min(...body.map((element) => element.top));
  const bottom = Math.max(...body.map((element) => element.top + element.height));
  const left = Math.min(...body.map((element) => element.left));
  const right = Math.max(...body.map((element) => element.left + element.width));
  const bodyStart = Math.max(126, title.top + title.height + 18);
  expect((top + bottom) / 2).toBeCloseTo((bodyStart + 512.5) / 2, 3);
  expect((left + right) / 2).toBeCloseTo(500, 3);
  expect(top).toBeGreaterThanOrEqual(bodyStart);
  expect(bottom).toBeLessThanOrEqual(512.5);
}
afterAll(async () => { await closeSpatialMeasurementBrowser(); await closeSlideLayoutAuditBrowser(); });

describe('teaching presentation design', () => {
  it.each(['concept', 'comparison'] as const)('centers the measured %s body between the title and safe bottom', async (kind) => {
    const items = kind === 'concept' ? [projection().items[0]!] : ['适用条件', '调整依据'].flatMap((row, rowIndex) =>
      ['方式甲', '方式乙'].map((column, columnIndex) => ({ id: `cell-${rowIndex}-${columnIndex}`, row, column,
        text: rowIndex ? columnIndex ? '根据完成表现调整' : '依据独立能力调整' : columnIndex ? '已有相关经验' : '已掌握必要基础',
        sourceContentIds: [`adopted-content-${rowIndex * 2 + columnIndex + 1}`] })));
    const result = await compileSlideInfographic(outline, projection({ items, composition: kind === 'concept' ? 'focus' : 'comparison' }),
      { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    expectCenteredBody(result!);
    if (kind === 'comparison') {
      const table = result!.elements.find((element) => element.type === 'table');
      expect(table?.data).toHaveLength(3);
      expect(table?.data.every((row) => row.length === 3)).toBe(true);
    }
  }, 30_000);

  it('renders a real directed relation with two independent support points and complete editable source mappings', async () => {
    const input = projection({ composition: 'relationship', items: [
      { id: 'experience', label: '已有经验', text: '用已有认识解释新信息', sourceContentIds: ['adopted-content-1'] },
      { id: 'interpretation', label: '理解结果', text: '可能保留已有认识的局限', sourceContentIds: ['adopted-content-2'] },
      { id: 'observation', label: '观察', text: '检查新信息与已有认识的差异', sourceContentIds: ['adopted-content-3'] },
      { id: 'support', label: '教学支持', text: '引导学生检验并修正认识', sourceContentIds: ['adopted-content-4'] },
    ], links: [{ from: 'experience', to: 'interpretation', label: '影响' }] });
    const result = await compileSlideInfographic(outline, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    const edges = result!.elements.filter((element) => element.type === 'line');
    expect(edges).toHaveLength(1);
    expect(edges[0]!.points).toEqual(['', 'arrow']);
    expect(result!.elements.some((element) => element.type === 'image')).toBe(false);
    for (const item of input.items) {
      const targets = result!.presentationProjection!.elementIdsBySource[item.sourceContentIds[0]!] ?? [];
      const visible = result!.elements.filter((element) => targets.includes(element.id)).map((element) =>
        element.type === 'text' ? element.content : element.type === 'shape' ? element.text?.content ?? '' : '').join('').replace(/<[^>]+>/gu, '');
      expect(visible).toContain(item.label);
      expect(visible).toContain(item.text);
    }
    for (const item of input.items.slice(0, 2)) {
      const targets = result!.presentationProjection!.elementIdsBySource[item.sourceContentIds[0]!] ?? [];
      expect(result!.elements.some((element) => targets.includes(element.id) && element.type === 'shape'
        && element.fill && element.fill !== 'none')).toBe(true);
    }
    for (const id of ['adopted-content-3', 'adopted-content-4']) {
      expect(result!.presentationProjection!.elementIdsBySource[id]).not.toContain(edges[0]!.id);
    }
    const mappedRectangles = (sourceIds: string[]) => {
      const ids = new Set(sourceIds.flatMap((id) => result!.presentationProjection!.elementIdsBySource[id] ?? []));
      return result!.elements.filter((element) => element.type !== 'line').filter((element) => ids.has(element.id));
    };
    const relation = mappedRectangles(['adopted-content-1', 'adopted-content-2']);
    const support = mappedRectangles(['adopted-content-3', 'adopted-content-4']);
    expect(Math.max(...relation.map((element) => element.top + element.height)))
      .toBeLessThanOrEqual(Math.min(...support.map((element) => element.top)));
    expectCenteredBody(result!);
    expect(new Set(result!.elements.map((element) => element.id)).size).toBe(result!.elements.length);
  }, 30_000);

  it('lets the author choose the visual focus without touching the teaching script or inventing source IDs', async () => {
    const saved = structuredClone(outline);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(projection({ composition: 'focus', focusItemId: 'core' })));
    const result = await generateSlideVisualProjection(outline, ai);
    expect(result?.projection).toMatchObject({ composition: 'focus', focusItemId: 'core', layoutVersion: SLIDE_VISUAL_LAYOUT_VERSION });
    expect(result?.diagnostics).toEqual([]);
    expect(outline).toEqual(saved);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0][0]).toContain('PPT 展示课堂重点，不是逐句讲稿');
    expect(ai.mock.calls[0][0]).toContain('教材图片');
  });

  it('measures a focal concept with secondary explanations as a complete editable page', async () => {
    const input = projection({ composition: 'focus', focusItemId: 'core' });
    const result = await compileSlideInfographic(outline, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    const core = result!.elements.find((element) => element.id === 'core') as PPTTextElement;
    const support = result!.elements.find((element) => element.id === 'data') as PPTTextElement;
    expect(core.top + core.height).toBeLessThan(support.top);
    expect(core.width).toBeGreaterThan(800);
    expect(core.content).toContain('font-size:18px');
    for (const item of input.items) expect(result!.presentationProjection!.elementIdsBySource[item.sourceContentIds[0]!]).toContain(item.id);
    const audit = await auditSlideLayout(result!, 'concept-focus');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('accepts authored groups and proportions instead of selecting a fixed composition', async () => {
    const design: NonNullable<SlidePresentationProjection['design']> = { flow: 'rows', align: 'start', gap: 28,
      groups: [{ id: 'claim', itemIds: ['core'], span: 5, treatment: 'accent' },
        { id: 'evidence', itemIds: ['data', 'model'], span: 7, treatment: 'plain' }] };
    const result = await generateSlideVisualProjection(outline, vi.fn().mockResolvedValue(JSON.stringify(projection({ design }))));
    expect(result?.projection.design).toEqual(design);
    expect(result?.diagnostics).toEqual([]);
    const content = await compileSlideInfographic(outline, result!.projection, { measure: measureAuthoredSlideText });
    expect(content).not.toBeNull();
    const core = content!.elements.find((element) => element.type === 'text' && element.content.includes('把已有知识用于新的任务')) as PPTTextElement;
    const support = content!.elements.find((element) => element.type === 'text' && element.content.includes('少量任务数据用于微调')) as PPTTextElement;
    expect(core.left + core.width).toBeLessThan(support.left);
    for (const item of result!.projection.items) {
      const mapped = content!.presentationProjection!.elementIdsBySource[item.sourceContentIds[0]!]!;
      expect(content!.elements.some((element) => mapped.includes(element.id) && element.type === 'text' && element.content.includes(item.text))).toBe(true);
    }
    const audit = await auditSlideLayout(content!, 'authored-groups');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('retains content and diagnostics when optional design repeats or omits an item', async () => {
    const input = projection({ design: { flow: 'rows', align: 'start', gap: 24,
      groups: [{ id: 'bad', itemIds: ['core', 'core', 'data'], span: 1, treatment: 'plain' }] } });
    const result = await generateSlideVisualProjection(outline, vi.fn().mockResolvedValue(JSON.stringify(input)));
    expect(result?.projection.design).toBeUndefined();
    expect(result?.projection.items).toEqual(input.items);
    expect(result?.diagnostics).toContain('Invalid optional spatial design; retained all teaching content for measured automatic layout');
  });

  it('reuses only spatial proportions with original wording when an authored quantity is omitted', async () => {
    const source = structuredClone(outline);
    const originals = ['至少完成3次实验', '检验实验条件', '记录完整实验结果'];
    source.teachingBrief!.teachingPlan!.presentationContent = originals;
    const design: NonNullable<SlidePresentationProjection['design']> = { flow: 'rows', align: 'center', gap: 28,
      media: { placement: 'right', fraction: 0.55 },
      groups: [{ id: 'claim', itemIds: ['core'], span: 5, treatment: 'accent' },
        { id: 'support', itemIds: ['data', 'model'], span: 7, treatment: 'plain', columns: 2 }] };
    const input = projection({ design, composition: 'focus', focusItemId: 'core', takeawayItemId: 'model',
      items: [{ id: 'core', text: '完成实验', sourceContentIds: ['adopted-content-1'] },
        { id: 'data', text: '检查条件', sourceContentIds: ['adopted-content-2'] },
        { id: 'model', text: '记录结果', sourceContentIds: ['adopted-content-3'] }],
      links: [{ from: 'core', to: 'data', label: '随后' }] });
    const before = structuredClone(source);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(input));
    const result = await generateSlideVisualProjection(source, ai);
    expect(result?.diagnostics).toContain('Changed or omitted quantity in adopted-content-1');
    expect(result?.projection.items.map((item) => item.text)).toEqual(originals);
    expect(result?.projection.design).toEqual({ ...design, groups: [
      { ...design.groups[0]!, itemIds: ['adopted-content-1'] },
      { ...design.groups[1]!, itemIds: ['adopted-content-2', 'adopted-content-3'] },
    ] });
    expect(result?.projection).not.toHaveProperty('links');
    expect(result?.projection).not.toHaveProperty('focusItemId');
    expect(result?.projection).not.toHaveProperty('takeawayItemId');
    expect(result?.projection.verified).toBe(true);
    expect(source).toEqual(before);
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each(['cross-group', 'missing', 'unknown'] as const)('does not reuse spatial design with %s original source ownership', async (ownership) => {
    const source = structuredClone(outline);
    const originals = ['至少完成3次实验', '检验实验条件', '记录完整实验结果'];
    source.teachingBrief!.teachingPlan!.presentationContent = originals;
    const sourceIds = ownership === 'cross-group' ? ['adopted-content-1', 'adopted-content-2']
      : ownership === 'missing' ? ['adopted-content-1'] : ['unknown-source'];
    const input = projection({ design: { flow: 'rows', align: 'start', gap: 24,
      groups: [{ id: 'claim', itemIds: ['core'], span: 5, treatment: 'accent' },
        { id: 'support', itemIds: ['data', 'model'], span: 7, treatment: 'plain' }] },
      items: [{ id: 'core', text: '完成实验', sourceContentIds: ['adopted-content-1'] },
        { id: 'data', text: '检查条件', sourceContentIds: sourceIds },
        { id: 'model', text: '记录结果', sourceContentIds: ['adopted-content-3'] }] });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(input));
    const result = await generateSlideVisualProjection(source, ai);
    expect(result?.diagnostics).toContain('Changed or omitted quantity in adopted-content-1');
    expect(result?.projection.items.map((item) => item.text)).toEqual(originals);
    expect(result?.projection.design).toBeUndefined();
    expect(result?.projection.verified).toBe(true);
    expect(ai).toHaveBeenCalledOnce();
  });

  it('legacy projection replay paginates accepted concise points without restoring verbose prose, losing the source image or rewriting speech', async () => {
    const concise = '能力提升时逐步撤除帮助，不能最后一次性撤销；依据学生能否独立完成任务判断，不能仅看教学进度。';
    const items = Array.from({ length: 12 }, (_, index) => ({ id: `point-${index}`, label: `观察点${index + 1}`,
      text: concise, sourceContentIds: [`adopted-content-${index + 1}`] }));
    const source = structuredClone(outline);
    const originals = items.map((item) => `${item.label}：${concise.repeat(3)}`);
    source.teachingBrief!.teachingPlan!.presentationContent = originals;
    source.teachingBrief!.teachingPlan!.presentationItems = originals.map((text, index) => ({ text, role: 'key-point', nodeIds: [`speech-${index}`] }));
    source.teachingBrief!.manuscript = { sectionId: 'section', segmentIds: items.map((_, index) => `speech-${index}`) };
    const manuscripts = [{ sectionId: 'section', segments: items.map((_, index) => ({ id: `speech-${index}`,
      text: `完整讲稿${index + 1}：${concise}继续依据实际表现展开解释，保留授课时的推理与案例。` })) }];
    const before = structuredClone(source);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(projection({ items })));
    const projected = await generateSlideVisualProjection(source, ai);
    expect(projected).not.toBeNull();
    const generated = await compileOriginalSlideDraft(source, slideVisualSourceContent(source), {
      measure: measureAuthoredSlideText,
      images: [{ id: 'source-figure', src: '/textbook-original.png', width: 640, height: 480, caption: '来源：教材，第12页' }],
    }, projected!.projection);
    if (!generated || !('elements' in generated)) throw new Error('Expected slide content');
    expect(generated.continuationPages?.length).toBeGreaterThan(0);
    const drafts = [generated, ...(generated.continuationPages ?? [])];
    expect(drafts.flatMap((page) => page.presentationProjection?.items.map((item) => item.text) ?? [])).toEqual(items.map((item) => item.text));
    const visible = drafts.flatMap((page) => page.elements.filter((element) => element.type === 'text').map((element) => element.content)).join('\n');
    for (const original of originals) expect(visible).not.toContain(original);
    const images = drafts.flatMap((page) => page.elements.filter((element) => element.type === 'image'));
    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({ id: 'source-figure', src: '/textbook-original.png' });
    expect(images[0]!.width / images[0]!.height).toBeCloseTo(4 / 3);
    expect(images[0]).not.toHaveProperty('clip');
    expect(visible).toContain('来源：教材，第12页');
    const expanded = expandCompiledSlidePages(source, generated, manuscripts);
    expect(expanded.flatMap(({ outline: local }) => bindTeachingManuscript(local, manuscripts).segments.map((segment) => segment.text)))
      .toEqual(manuscripts[0]!.segments.map((segment) => segment.text));
    for (const page of expanded.filter(({ content }) => content.presentationProjection?.items.length)) {
      expect(auditSlideDensity(page.outline, page.content).underrepresentedKeyPoints).toEqual([]);
    }
    expect(source).toEqual(before);
    expect(ai).toHaveBeenCalledOnce();
  }, 30_000);

  it('gives a planned image a readable observation area while preserving its aspect ratio and source caption', async () => {
    const image = { id: 'source-figure', src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#eff6ff"/></svg>'),
      width: 640, height: 480, caption: '来源：教材，第 12 页' };
    const result = await compileSlideInfographic(outline, projection({ composition: 'image-focus' }), { measure: measureAuthoredSlideText, images: [image] });
    expect(result).not.toBeNull();
    const visual = result!.elements.find((element) => element.type === 'image')!;
    expect(visual.width).toBeGreaterThan(400);
    expect(visual.width / visual.height).toBeCloseTo(4 / 3);
    expect(visual.src).toBe(image.src);
    expect(visual).not.toHaveProperty('clip');
    expect(result!.elements.find((element) => element.id === `${image.id}-caption`)).toMatchObject({ content: expect.stringContaining(image.caption) });
    const audit = await auditSlideLayout(result!, 'image-focus');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('reflows narrow authored image-side groups without compressing prose, cropping the image or dropping its caption', async () => {
    // A loadable geometry fixture; the real textbook image is checked separately
    // by the saved-input replay, not recreated by this unit test.
    const image = { id: 'source-figure', src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#f8fafc"/><rect x="40" y="40" width="560" height="400" fill="#dbeafe"/><rect x="120" y="120" width="400" height="240" fill="#bfdbfe"/><rect x="200" y="200" width="240" height="80" fill="#93c5fd"/></svg>'),
      width: 640, height: 480, caption: '来源：教学资料，第12页' };
    const input = projection({ composition: 'image-focus', items: [
      { id: 'definition', label: '最近发展区', text: '学生独立解决问题的现有水平，与在成人指导或同伴合作下能够达到的水平之间存在差距。', sourceContentIds: ['adopted-content-1'] },
      { id: 'instruction', label: '教学安排', text: '根据学生当前能力提供适当支持，帮助学生完成暂时不能独立完成的任务。', sourceContentIds: ['adopted-content-2'] },
      { id: 'boundary', label: '观察重点', text: '区分独立完成与获得帮助后完成，不能把潜在水平当作已经掌握。', sourceContentIds: ['adopted-content-3'] },
    ], design: { flow: 'rows', align: 'start', gap: 24, media: { placement: 'right', fraction: 0.5 },
      groups: [{ id: 'explanation', itemIds: ['definition', 'instruction'], span: 7, treatment: 'plain' },
        { id: 'notice', itemIds: ['boundary'], span: 5, treatment: 'accent' }] } });
    const before = structuredClone(input);
    const result = await compileSlideInfographic({ ...outline, title: '最近发展区：从独立完成到借助支持' }, input,
      { measure: measureAuthoredSlideText, images: [image] });
    expect(result).not.toBeNull();
    const rendered = result!.elements.find((element) => element.type === 'image')!;
    expect(rendered.src).toBe(image.src);
    expect(rendered.width / rendered.height).toBeCloseTo(4 / 3);
    expect(rendered.left).toBeGreaterThanOrEqual(512);
    expect(rendered).not.toHaveProperty('clip');
    const minimumWidth = 12 * 18 + 20;
    for (const item of input.items) {
      const ids = result!.presentationProjection!.elementIdsBySource[item.sourceContentIds[0]!] ?? [];
      const texts = result!.elements.filter((element): element is PPTTextElement => element.type === 'text' && ids.includes(element.id));
      const paragraph = texts.find((element) => element.content.replace(/<[^>]+>/gu, '').includes(item.text));
      expect(paragraph).toBeDefined();
      expect(paragraph!.width).toBeGreaterThanOrEqual(minimumWidth);
      expect(paragraph!.left + paragraph!.width).toBeLessThan(rendered.left);
      const sizes = [...paragraph!.content.matchAll(/font-size:\s*([\d.]+)px/gu)].map((match) => Number(match[1]));
      expect(sizes).toContain(18);
      expect(sizes.every((size) => size >= 18)).toBe(true);
      expect(texts.map((element) => element.content.replace(/<[^>]+>/gu, '')).join('')).toContain(item.label);
    }
    const notice = result!.elements.find((element) => element.id === 'infographic-authored-group-notice');
    expect(notice).toBeDefined();
    expect(notice!.width).toBeGreaterThanOrEqual(minimumWidth);
    expect(result!.elements.find((element) => element.id === `${image.id}-caption`)).toMatchObject({ content: expect.stringContaining(image.caption) });
    const audit = await auditSlideLayout(result!, 'image-side-readable-prose');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
    expect(input).toEqual(before);
  }, 30_000);

  it('joins a six-step fallback with each explanation without duplicating a separate text grid', async () => {
    const labels = ['创设情境', '进行抛锚', '自主探索', '拓展延伸', '讨论交流', '效果评价'];
    const notes = ['接近现实的学习情境', '真实且有挑战性的中心问题', '学生探究；教师给线索，不直接给答案', '设计相关拓展问题', '共享观点、相互启发', '记录过程表现并调整教学'];
    const page: SceneOutline = { ...outline, title: '抛锚式教学的六个步骤', visualIntent: { representation: 'native-diagram', observationGoal: '观察完整六步及对应说明',
      diagram: { topology: 'sequence', nodes: labels.map((label, index) => ({ id: `n${index}`, label })) } } };
    const sources = labels.map((label, index) => ({ id: `source-${index}`, text: `${label}：${notes[index]}` }));
    const saved = structuredClone(sources);
    const result = await compileOriginalSlideDraft(page, sources, { measure: measureAuthoredSlideText });
    expect(sources).toEqual(saved);
    expect(result.continuationPages).toBeUndefined();
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(5);
    const text = result.elements.filter((element) => element.type === 'text').map((element) => element.content).join('');
    for (const label of labels) expect(text.split(label)).toHaveLength(2);
    for (const source of sources) expect(result.presentationProjection?.elementIdsBySource[source.id]).toContain(source.id);
    const audit = await auditSlideLayout(result, 'six-steps');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);
});
