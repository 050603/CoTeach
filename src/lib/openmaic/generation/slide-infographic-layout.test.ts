import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PPTShapeElement, PPTTextElement, SlidePresentationItem, SlidePresentationProjection } from '../../../../packages/@openmaic/dsl/src/slides';
import type { TextMeasure } from '../../../../packages/@openmaic/generation/src/text-layout-compiler';
import { nativeSlideCollisions } from '../../../../packages/@openmaic/generation/src/native-slide-collision';
import type { SceneOutline } from '../types/generation';
import { compileOriginalSlideDraft, compileSlideInfographic } from './slide-infographic-layout';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';
import { auditSlideLayout, closeSlideLayoutAuditBrowser } from './slide-layout-audit';
import { REFERENCE_LECTURE_TYPOGRAPHY } from './slide-presentation-typography';
import { compileTeachingNarrationActions, normalizeTeachingNarration } from './teaching-narration';
import { adoptedPageAuthoringContent } from './adopted-page-content';

const outline: SceneOutline = { id: 'slide-19', type: 'slide', order: 18, title: '支架式教学：逐步把学习交给学生', description: '', keyPoints: [],
  teachingBrief: { schemaVersion: 1, explanation: '', examples: [], conditions: [], evidence: [], assessmentFocus: '', teachingPlan: {
    purpose: '', priorKnowledge: '', newContent: '', learnerQuestion: '', reasoningSteps: [], takeaway: '', visibleContent: [], narrationFocus: [],
    presentationTypography: REFERENCE_LECTURE_TYPOGRAPHY,
  } } };
const projection = (items: SlidePresentationItem[], patch: Partial<SlidePresentationProjection> = {}): SlidePresentationProjection => ({
  schemaVersion: 1, layoutVersion: 'teaching-infographic-v1', verified: true, elementIdsBySource: {}, items, ...patch,
});
const point = (id: string, label: string, text: string): SlidePresentationItem => ({ id, label, text, sourceContentIds: [`source-${id}`] });
const measure: TextMeasure = ({ text, width, fontSize, padding, lineHeight }) => {
  const length = Math.max(1, Math.floor((width - padding * 2) / fontSize));
  const lines = text.match(new RegExp(`.{1,${length}}`, 'gu')) ?? [''];
  return { naturalWidth: text.length * fontSize, height: lines.length * fontSize * lineHeight + padding * 2, lines };
};
const strip = (text: string) => text.replace(/<[^>]+>/gu, '');
afterAll(async () => { await closeSpatialMeasurementBrowser(); await closeSlideLayoutAuditBrowser(); });

describe('verified teaching infographic layout', () => {
  it('keeps source inputs immutable and maps each real heading and text to its sources', async () => {
    const input = projection([point('a', '判断标准', '学生能否独立完成任务。'), point('b', '修正方向', '随能力提升逐步撤去帮助。')]);
    const original = structuredClone(input);
    const result = await compileSlideInfographic(outline, input, { measure });
    expect(input).toEqual(original);
    expect(result?.elements.filter((element) => element.type === 'text').map((element) => element.id)).toEqual(['infographic-title', 'a-heading', 'a', 'b-heading', 'b']);
    expect(result?.presentationProjection?.elementIdsBySource['source-a']).toEqual(['a-rule', 'a-heading', 'a']);
    expect(result?.elements.filter((element) => element.type === 'line')).toHaveLength(0);
    expect(nativeSlideCollisions(result!.elements)).toEqual([]);
  });

  it('measures actual bold HTML and propagates measurement infrastructure errors', async () => {
    const spy = vi.fn(measure);
    const input = projection([{ ...point('a', '核心条件', '只有能力提升后才撤去帮助。'), emphasis: ['能力提升'] }]);
    const result = await compileSlideInfographic(outline, input, { measure: spy });
    expect(result).not.toBeNull();
    expect(spy.mock.calls.some(([request]) => request.html.includes('<strong') && request.preserveRichText === true)).toBe(true);
    const failure = new Error('Chromium font service unavailable');
    await expect(compileSlideInfographic(outline, input, { measure: () => { throw failure; } })).rejects.toBe(failure);
    await expect(compileSlideInfographic(outline, input, { measure: () => ({ naturalWidth: 10, height: NaN, lines: [] }) })).rejects.toThrow('invalid geometry');
  });

  it('renders a complete comparison as native table cells with truthful dimension headers', async () => {
    const input = projection(['问题类型', '教师角色'].flatMap((row, r) => ['探究式', '任务驱动式'].map((column, c) => ({
      id: `cell-${r}-${c}`, row, column, sourceContentIds: [`row-${r}`], text: r === 0 ? (c === 0 ? '解释现象' : '完成任务') : (c === 0 ? '引导论证' : '提供支持'),
    }))));
    const result = await compileSlideInfographic(outline, input, { measure });
    const table = result?.elements.find((element) => element.type === 'table');
    expect(table?.data.map((row) => row.map((cell) => strip(cell.text)))).toEqual([
      ['比较维度', '探究式', '任务驱动式'], ['问题类型', '解释现象', '完成任务'], ['教师角色', '引导论证', '提供支持'],
    ]);
    expect(result?.presentationProjection?.elementIdsBySource['row-0']).toEqual(['infographic-comparison']);
    expect(table?.data[1]?.[1]?.id).toBe('cell-0-0');
    expect(table?.height).toBeGreaterThan(100);
    expect(await compileSlideInfographic(outline, { ...input, items: input.items.slice(1) }, { measure })).toBeNull();
  });

  it('measures and renders native table rows without clipping or cell overflow', async () => {
    const input = projection(['问题类型', '教师角色'].flatMap((row, r) => ['探究式', '任务驱动式'].map((column, c) => ({
      id: `matrix-${r}-${c}`, row, column, sourceContentIds: [`row-${r}`],
      text: r === 0 ? (c === 0 ? '从现象提出问题，收集证据形成解释。' : '围绕任务要求，完成可观察的学习成果。')
        : (c === 0 ? '用追问帮助学生分析证据。' : '在学生需要时提供支持。'),
    }))));
    const result = await compileSlideInfographic(outline, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    const audit = await auditSlideLayout(result!, 'comparison-infographic');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('keeps the page 13 definition and three elements above the complete comparison matrix', async () => {
    const input = projection([
      point('definition', '探究式教学', '以问题为起点，通过证据形成解释。'),
      point('question', '问题', '提出可探究的问题。'),
      point('evidence', '证据', '收集并分析证据。'),
      point('explanation', '解释', '依据证据形成结论。'),
      ...['问题类型', '教师角色'].flatMap((row, r) => ['探究式', '任务驱动式'].map((column, c) => ({
        id: `comparison-${r}-${c}`, row, column, sourceContentIds: [`matrix-row-${r}`],
        text: r === 0 ? (c === 0 ? '解释现象' : '完成任务') : (c === 0 ? '引导学生论证' : '提供必要支持'),
      }))),
    ]);
    const result = await compileSlideInfographic({ ...outline, title: '探究式教学：问题、证据与解释' }, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    const table = result!.elements.find((element) => element.type === 'table')!;
    expect(table.data).toHaveLength(3);
    expect(table.colWidths).toHaveLength(3);
    for (const item of input.items.slice(0, 4)) {
      const text = result!.elements.find((element) => element.id === item.id) as PPTTextElement;
      expect(strip(text.content)).toContain(item.text);
      expect(text.top + text.height).toBeLessThan(table.top);
      expect(result?.presentationProjection?.elementIdsBySource[item.sourceContentIds[0]!]).toContain(item.id);
    }
    const audit = await auditSlideLayout(result!, 'mixed-comparison-infographic');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('keeps all page 7 case facts next to the source image and its visible caption', async () => {
    const input = projection([
      point('case-observation', '观察', '小鱼把有角、四条腿、吃草的牛画成了有鱼鳍和鱼鳞的形象。'),
      point('case-explanation', '原因', '学习者利用已有经验理解新信息，经验也可能限制理解。'),
      point('case-teaching', '教学启示', '引导学生检验已有认识，发现差异并修正原有理解。'),
    ]);
    const image = { id: 'textbook-figure', src: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#eff6ff"/></svg>')}`,
      width: 640, height: 480, caption: '教材案例：小鱼眼中的牛' };
    const result = await compileSlideInfographic({ ...outline, title: '已有经验如何影响理解' }, input, { measure: measureAuthoredSlideText, images: [image] });
    expect(result).not.toBeNull();
    const rendered = result!.elements.find((element) => element.type === 'image')!;
    expect(rendered.left).toBeGreaterThanOrEqual(602);
    expect(rendered.width / rendered.height).toBeCloseTo(4 / 3);
    expect(rendered).not.toHaveProperty('clip');
    for (const item of input.items) {
      const text = result!.elements.find((element) => element.id === item.id) as PPTTextElement;
      expect(strip(text.content)).toContain(item.text);
      expect(text.left + text.width).toBeLessThan(rendered.left);
    }
    expect(result!.elements.find((element) => element.id === 'textbook-figure-caption')).toMatchObject({ content: expect.stringContaining(image.caption) });
    const audit = await auditSlideLayout(result!, 'source-image-case-infographic');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('preserves the established 24px default body font for pages without the reference profile', async () => {
    const input = projection([point('legacy', '必要条件', '学习者已掌握基础知识。')]);
    const spy = vi.fn(measure);
    const result = await compileSlideInfographic({ ...outline, teachingBrief: undefined }, input, { measure: spy });
    expect(result).not.toBeNull();
    expect(spy.mock.calls.find(([request]) => request.text === input.items[0]!.text)?.[0].fontSize).toBe(24);
    expect((result!.elements.find((element) => element.id === 'legacy') as PPTTextElement).content).toContain('font-size:24px');
  });

  it('keeps every image uncropped with the original aspect ratio and rejects unreadable capacity', async () => {
    const input = projection([point('a', '观察重点', '比较两幅教材图的关键差异。')]);
    const images = [{ id: 'textbook-a', src: '/a.png', width: 600, height: 400 }, { id: 'generated-b', src: '/b.png', width: 800, height: 400 }];
    const result = await compileSlideInfographic(outline, input, { measure, images });
    const rendered = result?.elements.filter((element) => element.type === 'image') ?? [];
    expect(rendered.map((image) => image.id)).toEqual(images.map((image) => image.id));
    for (const [index, image] of rendered.entries()) {
      expect(image.width / image.height).toBeCloseTo(images[index]!.width / images[index]!.height);
      expect(image).not.toHaveProperty('clip');
      expect(image.top + image.height).toBeLessThanOrEqual(512.5);
    }
    expect(await compileSlideInfographic(outline, input, { measure, images: Array.from({ length: 6 }, (_, index) => ({ ...images[0]!, id: `image-${index}` })) })).toBeNull();
  });

  it('draws only verified link directions without adding sequential arrows to independent points', async () => {
    const input = projection([point('a', '前提', '学习者已掌握基础。'), point('b', '行动', '逐步撤去支持。')], { links: [{ from: 'a', to: 'b', label: '据此调整' }] });
    const result = await compileSlideInfographic(outline, input, { measure: measureAuthoredSlideText });
    const lines = result?.elements.filter((element) => element.type === 'line') ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]?.end[1]).toBeGreaterThan(lines[0]!.start[1]);
    expect(result!.elements.find((element) => element.id === 'infographic-link-0-label')).toMatchObject({ content: expect.stringContaining('据此调整') });
    expect(lines[0]?.points).toEqual(['', 'arrow']);
    expect(result?.presentationProjection?.elementIdsBySource['source-a']).toContain(lines[0]?.id);
    const audit = await auditSlideLayout(result!, 'labeled-link-infographic');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
    expect(await compileSlideInfographic(outline, { ...input, links: [{ from: 'a', to: 'missing' }] }, { measure })).toBeNull();
  });

  it('limits layout retries without reducing font size or dropping statements', async () => {
    const input = projection([point('a', '完整内容', '重要事实。'.repeat(600))]);
    const spy = vi.fn(measure);
    expect(await compileSlideInfographic(outline, input, { measure: spy })).toBeNull();
    expect(spy.mock.calls.filter(([request]) => request.text === input.items[0]!.text).length).toBeLessThanOrEqual(3);
    expect(spy.mock.calls.filter(([request]) => request.text === input.items[0]!.text).every(([request]) => request.fontSize === 18)).toBe(true);
    expect(await compileSlideInfographic(outline, { ...input, verified: false }, { measure })).toBeNull();
  });

  it('fits the real five-stage teaching flow with verified short annotation and matching explanations using browser fonts', async () => {
    const labels = ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'];
    const nodes = labels.map((label, index) => ({ id: `c${index + 1}`, label }));
    const page = { ...outline, visualIntent: { representation: 'native-diagram', observationGoal: '观察完整顺序', resourceRefs: [],
      diagram: { topology: 'sequence', nodes, annotation: '原始完整说明应独立保留给讲稿。' } } } as SceneOutline;
    const input = projection([
      ...labels.map((label, index) => point(`step-${index}`, label, ['提供必要支架', '进入真实问题', '学生独立尝试', '分享并互相帮助', '检查学习表现'][index]!)),
      { id: 'flow-note', text: '随着学习能力提高，教师逐步撤去支持。', sourceContentIds: ['diagram-annotation'], emphasis: ['逐步撤去支持'] },
    ]);
    const before = structuredClone(page);
    const result = await compileSlideInfographic(page, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    expect(page).toEqual(before);
    const shapes = result!.elements.filter((element): element is PPTShapeElement => element.type === 'shape' && element.id.startsWith('infographic-diagram-node-'));
    expect(shapes.map((shape) => strip(shape.text?.content ?? ''))).toEqual(labels);
    expect(result?.elements.filter((element) => element.type === 'line')).toHaveLength(4);
    const texts = result!.elements.filter((element): element is PPTTextElement => element.type === 'text');
    expect(texts.find((text) => text.id === 'flow-note')?.content).toContain('逐步撤去支持');
    for (const text of texts) {
      const size = text.id === 'infographic-title' ? 32 : 18;
      const measured = await measureAuthoredSlideText({ html: text.content, text: strip(text.content), width: text.width, fontSize: size,
        fontWeight: text.id === 'infographic-title' || text.id === 'flow-note' ? 700 : 400,
        fontFamily: 'Noto Sans SC', padding: 10, lineHeight: text.lineHeight ?? 1.5, paragraphSpace: text.paragraphSpace ?? 5,
        align: 'left', preserveRichText: true });
      expect(measured.height).toBeLessThanOrEqual(text.height + 1);
      expect(text.left).toBeGreaterThanOrEqual(50);
      expect(text.left + text.width).toBeLessThanOrEqual(950);
      expect(text.top + text.height).toBeLessThanOrEqual(512.5);
    }
    expect(nativeSlideCollisions(result!.elements)).toEqual([]);
    const audit = await auditSlideLayout(result!, 'five-step-infographic');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('lays out a synthetic verified page 19 correction as an upper relation and complete lower process with shared-source notes', async () => {
    // Geometry fixture derived from the failed v2 wording, with its missing
    // gradual/individual withdrawal boundary restored. This is not model review.
    const labels = ['搭脚手架', '进入情境', '独立探索', '协作学习', '效果评价'];
    const originalAnnotation = '支架在独立探索环节随学生能力提升而逐渐减少、撤出，这些支架是一个一个地随着学生发展而撤销的，而不是在最后阶段一次性撤销；教学中需要把握支架的进入和退出时刻。';
    const page = { ...outline, title: '支架的撤除与支架式教学法的教学过程', visualIntent: {
      representation: 'native-diagram', observationGoal: '保持五步完整教学过程', resourceRefs: [], diagram: {
        topology: 'sequence', nodes: labels.map((label, index) => ({ id: `c${index + 1}`, label })),
        edges: labels.slice(1).map((_, index) => ({ from: `c${index + 1}`, to: `c${index + 2}` })), annotation: originalAnnotation,
      },
    } } as SceneOutline;
    const input = projection([
      { id: 'ability', label: '能力提升', text: '能够独立解决问题时，支架作用完成。', sourceContentIds: ['adopted-content-1', 'adopted-content-2'] },
      { id: 'withdrawal', label: '逐步撤除', text: '支架具有暂时性、渐消性，随发展逐个撤除；不等到最后一次性撤销。',
        sourceContentIds: ['adopted-content-2', 'adopted-content-3', 'diagram-annotation'], emphasis: ['逐个撤除'] },
      { id: 'timing', label: '进入与退出', text: '把握支架进入、退出时刻。', sourceContentIds: ['adopted-content-2', 'diagram-annotation'] },
      { id: 'scaffold', label: '搭脚手架', text: '依据最近发展区设计概念框架和分层支架。', sourceContentIds: ['adopted-content-4'], emphasis: ['最近发展区'] },
      { id: 'independence', label: '独立探索', text: '启发式引导后给予自主空间；随能力提升减少、撤出支架。', sourceContentIds: ['adopted-content-5', 'diagram-annotation'] },
      { id: 'evaluation-people', label: '效果评价', text: '自评、小组互评、教师评价。', sourceContentIds: ['adopted-content-6'] },
      { id: 'evaluation-criteria', label: '效果评价', text: '评价自主学习能力、协作贡献、意义建构。', sourceContentIds: ['adopted-content-6'] },
    ], { links: [{ from: 'ability', to: 'withdrawal' }] });
    const original = structuredClone({ page, input });
    const result = await compileSlideInfographic(page, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    expect({ page, input }).toEqual(original);
    const elements = result!.elements;
    const nodes = elements.filter((element): element is PPTShapeElement => element.type === 'shape' && Boolean(element.text));
    expect(nodes.map((node) => strip(node.text!.content))).toEqual(labels);
    expect(elements.filter((element) => element.type === 'line')).toHaveLength(5);
    expect(elements.some((element) => element.id === 'infographic-diagram-annotation')).toBe(false);
    for (const id of ['ability', 'withdrawal', 'timing']) {
      const element = elements.find((element) => element.id === id) as PPTTextElement;
      expect(element.top + element.height).toBeLessThan(nodes[0]!.top);
    }
    const nodeBottom = Math.max(...nodes.map((node) => node.top + node.height));
    for (const id of ['scaffold', 'independence', 'evaluation-people', 'evaluation-criteria']) {
      const element = elements.find((element) => element.id === id) as PPTTextElement;
      expect(element.top).toBeGreaterThanOrEqual(nodeBottom);
      expect(element.top + element.height).toBeLessThanOrEqual(512.5);
    }
    expect((elements.find((element) => element.id === 'evaluation-criteria') as PPTTextElement).top)
      .toBeGreaterThan((elements.find((element) => element.id === 'evaluation-people') as PPTTextElement).top);
    expect(result?.presentationProjection?.elementIdsBySource['diagram-annotation']).toEqual(expect.arrayContaining(['withdrawal', 'timing', 'independence']));
    expect(result?.presentationProjection?.elementIdsBySource['adopted-content-6']).toEqual(expect.arrayContaining(['evaluation-people', 'evaluation-criteria', 'infographic-diagram-node-c5']));
    expect(elements.filter((element): element is PPTTextElement => element.type === 'text').map((element) => strip(element.content)).join(' ')).toContain('不等到最后一次性撤销');
    const audit = await auditSlideLayout(result!, 'synthetic-page-19-hybrid');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('groups exact node-prefixed explanations while keeping linked node facts in the upper concept region', async () => {
    const page = { ...outline, visualIntent: { representation: 'native-diagram', observationGoal: '', resourceRefs: [], diagram: {
      topology: 'sequence', nodes: [{ id: 'a', label: '独立探索' }, { id: 'b', label: '效果评价' }],
    } } } as SceneOutline;
    const input = projection([
      point('explore', '独立探索', '自主学习能力提升。'),
      point('withdraw', '撤出支持', '逐步撤去支架。'),
      point('people', '效果评价·评价主体', '自评、小组互评、教师评价。'),
      point('criteria', '效果评价·评价内容', '自主学习能力、协作贡献和意义建构。'),
    ], { links: [{ from: 'explore', to: 'withdraw' }] });
    const result = await compileSlideInfographic(page, input, { measure: measureAuthoredSlideText });
    expect(result).not.toBeNull();
    expect(result?.presentationProjection?.elementIdsBySource['source-explore']).not.toContain('infographic-diagram-node-a');
    expect(result?.presentationProjection?.elementIdsBySource['source-people']).toContain('infographic-diagram-node-b');
    expect(result?.presentationProjection?.elementIdsBySource['source-criteria']).toContain('infographic-diagram-node-b');
    for (const id of ['people', 'criteria']) expect(result!.elements.find((element) => element.id === id)).toMatchObject({ content: expect.stringContaining('评价') });
  }, 30_000);

  it('preserves a complete branch and returns null for a seven-stage sequence that cannot remain straight', async () => {
    const input = projection([point('a', '应用', '根据真实需要选择。')]);
    const page = { ...outline, visualIntent: { representation: 'native-diagram', observationGoal: '', resourceRefs: [], diagram: {
      topology: 'branch', nodes: [{ id: 'root', label: '选择方法' }, { id: 'a', label: '探究' }, { id: 'b', label: '实践' }],
      edges: [{ from: 'root', to: 'a' }, { from: 'root', to: 'b' }],
    } } } as SceneOutline;
    const result = await compileSlideInfographic(page, input, { measure });
    expect(result?.elements.filter((element) => element.type === 'shape' && element.text)).toHaveLength(3);
    expect(result?.elements.filter((element) => element.type === 'line')).toHaveLength(2);
    const crowded = { ...page, visualIntent: { ...page.visualIntent!, diagram: { topology: 'sequence' as const,
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `s${index}`, label: '完整步骤' })) } } };
    expect(await compileSlideInfographic(crowded, input, { measure })).toBeNull();
  });
});


describe('complete original-content draft fallback', () => {
  it('keeps exact source text and fixed fonts within three candidates, reporting real overflow rather than a fake pass', async () => {
    const sources = [{ id: 'original-a', text: '完整事实和必要条件。'.repeat(180) }, { id: 'original-b', text: '否定和数量必须保留。'.repeat(180) }];
    const before = structuredClone(sources), spy = vi.fn(measure);
    const result = await compileOriginalSlideDraft(outline, sources, { measure: spy });
    expect(sources).toEqual(before);
    for (const source of sources) {
      const element = result.elements.find((element) => element.id === source.id) as PPTTextElement;
      expect(strip(element.content)).toBe(source.text);
      expect(element.content).toContain('font-size:18px');
      expect(spy.mock.calls.filter(([request]) => request.text === source.text)).toHaveLength(3);
      expect(result.presentationProjection?.elementIdsBySource[source.id]).toContain(source.id);
    }
    expect(result.qualityDiagnostics?.some((detail) => detail.includes('measured content reaches y=') && detail.includes('beyond the safe bottom'))).toBe(true);
    expect(result).not.toHaveProperty('continuationPages');
    expect(result.elements.filter((element): element is PPTTextElement => element.type === 'text').some((element) => element.top + element.height > 512.5)).toBe(true);
    expect(result.presentationProjection?.verified).toBe(true); // Exact original-source identity, not a geometry approval.
  });

  it('retains every original node, implicit sequence edge, annotation, image and caption when space is insufficient', async () => {
    const annotation = '学生逐步提升能力时，一个一个地撤销支架，不在最后一次性撤销。';
    const page = { ...outline, visualIntent: { representation: 'native-diagram', observationGoal: '', resourceRefs: [], diagram: {
      topology: 'sequence', nodes: Array.from({ length: 7 }, (_, index) => ({ id: `step-${index}`, label: `步骤${index + 1}` })),
      edges: [{ from: 'step-0', to: 'step-1', label: '依据' }], annotation,
    } } } as SceneOutline;
    const sources = [{ id: 'definition', text: '每一个环节均需完整保留。' }, { id: 'diagram-annotation', text: annotation }];
    const images = Array.from({ length: 5 }, (_, index) => ({ id: `source-image-${index}`, src: `/source-${index}.png`, width: 640, height: 480, caption: `完整教材图注${index}` }));
    const result = await compileOriginalSlideDraft(page, sources, { measure, images });
    const nodes = result.elements.filter((element): element is PPTShapeElement => element.type === 'shape' && Boolean(element.text));
    expect(nodes.map((node) => strip(node.text!.content))).toEqual(page.visualIntent!.diagram!.nodes.map((node) => node.label));
    expect(result.elements.filter((element) => element.type === 'line')).toHaveLength(6);
    expect(result.elements.find((element) => element.id === 'original-diagram-annotation')).toMatchObject({ content: expect.stringContaining(annotation) });
    for (const image of images) {
      const rendered = result.elements.find((element) => element.id === image.id)!;
      expect(rendered.type).toBe('image');
      if (rendered.type !== 'image') throw new Error('Expected preserved image');
      expect(rendered.src).toBe(image.src);
      expect(rendered.width / rendered.height).toBeCloseTo(4 / 3);
      expect(rendered).not.toHaveProperty('clip');
      expect(result.elements.find((element) => element.id === `${image.id}-caption`)).toMatchObject({ content: expect.stringContaining(image.caption) });
    }
    expect(result.qualityDiagnostics?.some((detail) => detail.includes('no feasible measured allocation'))).toBe(true);
    expect(result.qualityDiagnostics?.some((detail) => detail.includes('beyond the safe bottom'))).toBe(true);
  });

  it('preserves default lecture fonts and propagates actual measurement failures', async () => {
    const sources = [{ id: 'original-a', text: '学生能独立解决问题时才撤去支持。' }];
    const result = await compileOriginalSlideDraft({ ...outline, teachingBrief: undefined }, sources, { measure });
    expect((result.elements.find((element) => element.id === 'original-a') as PPTTextElement).content).toContain('font-size:24px');
    expect(result.qualityDiagnostics).toEqual([]);
    const failure = new Error('Actual browser measurement unavailable');
    await expect(compileOriginalSlideDraft(outline, sources, { measure: () => { throw failure; } })).rejects.toBe(failure);
  });
});


function semanticPage(visible: string[]): SceneOutline {
  return { ...outline, generationPurpose: 'knowledge-teaching', keyPoints: visible, targetDurationSec: 45,
    teachingBrief: { ...outline.teachingBrief!, teachingPlan: { ...outline.teachingBrief!.teachingPlan!, presentationContent: visible } } };
}

function aliasBounds(element: { left: number; top: number; width: number; height: number }) {
  return { left: element.left, top: element.top, width: element.width, height: element.height };
}

describe('stable narration targets for visually projected content', () => {
  it('unions only the source-owned readable regions and restores the original semantic anchors without touching speech or audio', async () => {
    const originals = ['学生能够独立解决问题时，支架作用完成，需要撤离。', '支架不是最后阶段一次性撤销，而是随着学生发展逐个撤销。'];
    const page = semanticPage(originals), catalog = adoptedPageAuthoringContent(page);
    const input = projection([
      { id: 'ability', text: '能够独立解决问题', sourceContentIds: [catalog[0]!.id] },
      { id: 'withdraw', text: '支架作用完成，需要撤离', sourceContentIds: [catalog[0]!.id] },
      { id: 'boundary', text: '随着发展逐个撤离，而非最后一次撤销', sourceContentIds: [catalog[1]!.id] },
    ], { links: [{ from: 'ability', to: 'withdraw' }] });
    const narration = normalizeTeachingNarration({ segments: [{ text: '能够独立解决问题时，支架需要撤离。撤离要随着学生发展逐个进行，不是最后一次撤销。',
      semanticIds: [`${page.id}:teaching`, `${page.id}:visible-1`, `${page.id}:visible-2`], anchors: [
        { semanticId: `${page.id}:visible-1`, quote: '能够独立解决问题', visualCue: { type: 'spotlight', necessity: 'essential' } },
        { semanticId: `${page.id}:visible-2`, quote: '随着学生发展逐个进行', visualCue: { type: 'laser', necessity: 'helpful' } },
      ] }] }, page);
    const savedStage = { outline: page, narration, actions: [{ id: narration.segments[0]!.id, type: 'speech' as const,
      text: narration.segments[0]!.text, audioId: 'saved-audio-19', audioUrl: '/api/audio/saved-19.mp3', audioDurationSec: 12.8, voice: 'teacher', speed: 1 }], targetDurationSec: 45 };
    const before = structuredClone(savedStage), originalProjection = structuredClone(input);
    const result = (await compileSlideInfographic(page, input, { measure }))!;
    expect(input).toEqual(originalProjection);
    const ability = result.elements.find((element) => element.id === 'ability') as PPTTextElement;
    const withdraw = result.elements.find((element) => element.id === 'withdraw') as PPTTextElement;
    const boundary = result.elements.find((element) => element.id === 'boundary') as PPTTextElement;
    const first = result.elements.find((element) => element.id === `${page.id}:visible-1`)!;
    const second = result.elements.find((element) => element.id === `${page.id}:visible-2`)!;
    expect(first).toMatchObject({ type: 'shape', fill: 'none', opacity: 0, left: ability.left, top: Math.min(ability.top, withdraw.top),
      width: withdraw.left + withdraw.width - ability.left, height: Math.max(ability.top + ability.height, withdraw.top + withdraw.height) - Math.min(ability.top, withdraw.top) });
    expect(first).not.toHaveProperty('outline');
    expect(first).not.toHaveProperty('text');
    expect(second).toMatchObject(aliasBounds(boundary));
    expect(first.left + first.width).toBeLessThan(boundary.left);
    expect(Object.values(result.presentationProjection!.elementIdsBySource).flat().some((id) => id.includes(':visible-'))).toBe(false);
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      const compiled = compileTeachingNarrationActions({ outline: savedStage.outline, content: result, narration: savedStage.narration });
      expect(compiled.issues).toEqual([]);
      expect(compiled.actions).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'spotlight', elementId: `${page.id}:visible-1`, speechAnchor: expect.objectContaining({ quote: '能够独立解决问题', occurrence: 0 }) }),
        expect.objectContaining({ type: 'laser', elementId: `${page.id}:visible-2`, speechAnchor: expect.objectContaining({ quote: '随着学生发展逐个进行', occurrence: 0 }) }),
        { id: narration.segments[0]!.id, type: 'speech', text: savedStage.actions[0]!.text },
      ]));
      expect(fetch).not.toHaveBeenCalled();
      expect(savedStage).toEqual(before);
    } finally { fetch.mockRestore(); }
  });

  it('resolves original node and annotation semantics by exact source text in their original visible order', async () => {
    const original = '学生能力提升时逐个撤去支架。', annotation = '把握支架进入与退出时刻。';
    const page = { ...semanticPage([original, '独立探索', annotation]), visualIntent: { representation: 'native-diagram', observationGoal: '', resourceRefs: [],
      diagram: { topology: 'sequence', nodes: [{ id: 'a', label: '独立探索' }, { id: 'b', label: '效果评价' }], annotation } } } as SceneOutline;
    const catalog = adoptedPageAuthoringContent(page);
    expect(catalog.map((item) => item.text)).toEqual([original]);
    const result = (await compileSlideInfographic(page, projection([{ id: 'timing', text: '随能力提升逐个撤去支架，并把握进入与退出时刻。',
      sourceContentIds: [catalog[0]!.id, 'diagram-annotation'] }]), { measure: measureAuthoredSlideText }))!;
    expect(result).not.toBeNull();
    const native = result.elements.find((element) => element.id === 'timing') as PPTTextElement;
    const node = result.elements.find((element) => element.id === 'infographic-diagram-node-a') as PPTShapeElement;
    expect(result.elements.find((element) => element.id === `${page.id}:visible-1`)).toMatchObject(aliasBounds(native));
    expect(result.elements.find((element) => element.id === `${page.id}:visible-2`)).toMatchObject(aliasBounds(node));
    expect(result.elements.find((element) => element.id === `${page.id}:visible-3`)).toMatchObject(aliasBounds(native));
    const audit = await auditSlideLayout(result, 'transparent-semantic-targets');
    expect(audit.status).toBe('checked');
    expect(audit.issues).toEqual([]);
    expect(audit.findings).toEqual([]);
  }, 30_000);

  it('uses native table geometry and adds the same stable aliases to original-content drafts without altering coverage', async () => {
    const page = semanticPage(['探究式与任务驱动式的问题类型不同。']);
    const source = adoptedPageAuthoringContent(page)[0]!;
    const result = (await compileSlideInfographic(page, projection([
      { id: 'inquiry', row: '问题类型', column: '探究式', text: '解释现象', sourceContentIds: [source.id] },
      { id: 'task', row: '问题类型', column: '任务驱动式', text: '完成任务', sourceContentIds: [source.id] },
    ]), { measure }))!;
    const table = result.elements.find((element) => element.type === 'table')!;
    expect(result.elements.find((element) => element.id === `${page.id}:visible-1`)).toMatchObject(aliasBounds(table));
    const fallback = await compileOriginalSlideDraft(page, [source], { measure });
    const native = fallback.elements.find((element) => element.id === source.id) as PPTTextElement;
    expect(fallback.elements.find((element) => element.id === `${page.id}:visible-1`)).toMatchObject(aliasBounds(native));
    expect(fallback.presentationProjection?.elementIdsBySource[source.id]).not.toContain(`${page.id}:visible-1`);
    expect(strip(native.content)).toBe(source.text);
  });
});
