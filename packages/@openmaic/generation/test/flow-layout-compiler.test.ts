import { describe, expect, it } from 'vitest';
import { compileFlowLayout, FlowLayoutFailure, type FlowLayout } from '../src/flow-layout-compiler.js';
import { compileTextComponents, type TextMeasure } from '../src/text-layout-compiler.js';
import { generateSceneContent } from '../src/scene-generator.js';

const measure: TextMeasure = ({ text, width, padding, fontSize, lineHeight }) => {
  const capacity = Math.max(1, Math.floor((width - padding * 2) / fontSize));
  const raw = text.split(/\n/);
  const lines = raw.flatMap((line) => {
    const chars = [...line];
    return Array.from({ length: Math.max(1, Math.ceil(chars.length / capacity)) }, (_, index) => chars.slice(index * capacity, (index + 1) * capacity).join(''));
  });
  return { naturalWidth: Math.max(...raw.map((line) => [...line].length * fontSize)), height: padding * 2 + lines.length * fontSize * lineHeight, lines };
};

const options = { id: 'lesson-page', title: '物体的观察与解释', textMeasure: measure };
describe('measured first-pass flow layout', () => {
  it('centers a sparse editable composition in the body without enlarging its type', async () => {
    const [page] = await compileFlowLayout({ groups: [
      { kind: 'textBox', text: '观察到的证据必须支持结论。', fontSize: 24 },
    ] }, options);
    const body = page.elements.find((element) => element.type === 'text' && element.id.includes('-group-'))!;
    expect(body.top).toBeGreaterThan(220);
    expect(body.type === 'text' && body.content).toContain('font-size:24px');
  });
  it('absorbs a slight overflow by tightening measured gaps without shrinking text or adding a page', async () => {
    const layout: FlowLayout = { groups: [
      ...[1, 2, 3].map((index) => ({ kind: 'native' as const, id: `formula-${index}`,
        element: { type: 'latex' as const, latex: `x_${index}` }, observation: `公式${index}` })),
      { kind: 'textBox', id: 'conclusion', text: '据此得出结论。', fontSize: 24 },
    ] };
    const pages = await compileFlowLayout(layout, options);
    expect(pages).toHaveLength(1);
    expect(pages[0].layoutDecision).toBe('optimized');
    expect(pages[0].layoutMeasurement).toMatchObject({ pageCount: 1, pageIndex: 1,
      strategyVersion: 'adaptive-v2', sourceGroupIds: ['formula-1', 'formula-2', 'formula-3', 'conclusion'] });
    expect(pages[0].layoutMeasurement.groups.map((group) => group.sourceGroupId))
      .toEqual(['formula-1', 'formula-2', 'formula-3', 'conclusion']);
    expect(pages[0].layoutMeasurement.occupiedHeight).toBeLessThanOrEqual(pages[0].layoutMeasurement.bodyCapacity);
    expect(pages[0].elements.find((element) => element.id === 'lesson-page-group-3')).toMatchObject({ type: 'text' });
    const conclusion = pages[0].elements.find((element) => element.type === 'text' && element.content.includes('据此'))!;
    expect(conclusion.type === 'text' && conclusion.content).toContain('font-size:24px');
  });

  it('adjusts a picture proportionally to keep a short observation on one page', async () => {
    const pages = await compileFlowLayout({ groups: [
      { kind: 'media', id: 'evidence', resourceId: 'gen_img_object', aspectRatio: '16:9' },
      { kind: 'textBox', id: 'observation', text: '观察图中的实际变化。', fontSize: 24 },
    ] }, options);
    expect(pages).toHaveLength(1);
    expect(pages[0].layoutDecision).toBe('optimized');
    const image = pages[0].elements.find((element) => element.type === 'image')!;
    expect(image.height).toBe(280);
    expect(image.width / image.height).toBeCloseTo(16 / 9);
    expect(pages[0].teachingText).toContain('观察图中的实际变化。');
  });

  it('gives a labeled sequence full width when its measured labels cannot fit beside text', async () => {
    const pages = await compileFlowLayout({ groups: [{ kind: 'column', children: [{ kind: 'row', children: [
      { kind: 'diagram', topology: 'sequence', nodes: ['教学理论', '教学模式', '教学方法'].map((label, index) => ({ id: String(index), label })),
        edges: [{ from: '0', to: '1', label: '具体化' }, { from: '1', to: '2', label: '具体化' }] },
      { kind: 'textBox', text: '三层之间是抽象程度与作用范围的区别。' },
    ] }] }] }, options);
    const all = pages.flatMap(page => page.elements);
    expect(all.filter(element => element.type === 'line')).toHaveLength(2);
    expect(all.filter(element => element.id.includes('edge-label'))).toHaveLength(2);
    expect(pages.flatMap(page => page.teachingText)).toContain('三层之间是抽象程度与作用范围的区别。');
    const explanation = all.find(element => element.type === 'text' && element.content.includes('三层之间'))!;
    expect(explanation.width).toBe(900);
    expect(explanation.top).toBeGreaterThan(Math.max(...all.filter(element => element.type === 'shape').map(element => element.top + element.height)));
  });

  it('keeps whole-table column widths and original row IDs while paginating consecutive rows', async () => {
    const rows = Array.from({ length: 10 }, (_, index) => ({ header: index === 8 ? '需要完整判断的条件' : '条件' + index,
      cells: [index % 2 ? '这是需要更多文字来解释的证据内容' : '观察', '解释与依据'] }));
    const pages = await compileFlowLayout({ groups: [{ kind: 'labelGrid', rows }] }, options);
    expect(pages.length).toBeGreaterThan(1);
    const all = pages.flatMap((page) => page.elements);
    const reference = all.find((element) => element.id === 'lesson-page-group-0-0-1-text')!;
    for (let index = 0; index < rows.length; index++) {
      const cell = all.find((element) => element.id === `lesson-page-group-0-${index}-1-text`)!;
      expect(cell.left).toBe(reference.left);
      expect(cell.width).toBe(reference.width);
    }
    expect(pages.flatMap((page) => page.sourceGroupIds)).toEqual(rows.map((_, index) => `lesson-page-group-0-part-${index + 1}`));
    expect(pages.flatMap((page) => page.teachingText)).toEqual(rows.flatMap((row) => [row.header, ...row.cells]));
  });

  it('reserves media and text together and keeps their stable identities across compilations', async () => {
    const layout: FlowLayout = { groups: [{ kind: 'row', children: [
      { kind: 'media', resourceId: 'gen_img_object', aspectRatio: '4:3' },
      { kind: 'textBox', text: '观察物体的形状，比较其中可以直接看到的结构。' },
    ] }, { kind: 'textBox', text: '根据可见证据解释差异。' }] };
    const pages = await compileFlowLayout(layout, options);
    const page = pages[0];
    const image = page.elements.find((element) => element.type === 'image')!;
    const texts = page.elements.filter((element) => element.type === 'text');
    expect(texts.every((element) => element.left >= image.left + image.width || element.top >= image.top + image.height || element.top + element.height <= image.top)).toBe(true);
    expect(await compileFlowLayout(layout, options)).toEqual(pages);
  });

  it('moves whole observation groups to continuation pages without dropping resources or text', async () => {
    const layout: FlowLayout = { groups: [
      { kind: 'row', id: 'first-observation', children: [{ kind: 'media', resourceId: 'gen_img_first' }, { kind: 'textBox', text: '第一组观察证据。' }] },
      { kind: 'row', id: 'second-observation', children: [{ kind: 'media', resourceId: 'gen_img_second' }, { kind: 'textBox', text: '第二组观察证据。' }] },
    ] };
    const pages = await compileFlowLayout(layout, options);
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.sourceGroupIds)).toEqual([['first-observation'], ['second-observation']]);
    expect(pages[0].teachingText).toContain('第一组观察证据。');
    expect(pages[1].teachingText).toContain('第二组观察证据。');
    const ids = pages.flatMap((page) => page.elements.map((element) => element.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(pages.every((page) => page.elements.every((element) => element.type === 'line' || element.top + element.height <= 512.5))).toBe(true);
  });

  it('keeps the same blue title hierarchy and editable text style on balanced continuation pages', async () => {
    const pages = await compileFlowLayout({ groups: Array.from({ length: 6 }, (_, index) => ({
      kind: 'textBox' as const, id: `idea-${index + 1}`, text: `观察和解释${index + 1}`, fontSize: 24,
    })) }, options);
    expect(pages).toHaveLength(2);
    expect(pages.map((page) => page.sourceGroupIds)).toEqual([
      ['idea-1', 'idea-2', 'idea-3'], ['idea-4', 'idea-5', 'idea-6'],
    ]);
    expect(pages.every((page) => page.elements.some((element) => element.type === 'text'
      && element.id.includes('-title-') && element.defaultColor === '#1E3A8A'))).toBe(true);
    expect(pages.every((page) => !page.elements.some((element) => element.id.includes('-surface')))).toBe(true);
    expect(pages.every((page) => page.elements.filter((element) => element.type === 'text'
      && element.id.includes('-group-')).every((element) => element.type === 'text' && element.content.includes('font-size:24px')))).toBe(true);
  });

  it('balances all authored groups instead of filling the first page and leaving one orphan', async () => {
    const groups = Array.from({ length: 4 }, (_, index) => ({ kind: 'native' as const, id: `step-${index + 1}`,
      element: { type: 'latex' as const, latex: `x_${index + 1}` }, observation: `第${index + 1}步` }));
    const pages = await compileFlowLayout({ groups }, options);
    expect(pages.map((page) => page.sourceGroupIds)).toEqual([['step-1', 'step-2'], ['step-3', 'step-4']]);
    expect(pages.map((page) => page.occupiedHeight)).toEqual([200, 200]);
    expect(pages.map((page) => page.teachingText)).toEqual([['第1步', '第2步'], ['第3步', '第4步']]);
    expect(pages.every((page) => page.paginationVersion === 'balanced-v1')).toBe(true);
    expect(pages.every((page) => page.elements.some((element) => element.type === 'text'
      && element.id.includes('-title-') && element.content.includes(options.title)))).toBe(true);
    expect(pages.every((page) => !page.elements.some((element) => element.type === 'text'
      && /（\d+\/\d+）/.test(element.content)))).toBe(true);
    expect(pages.map((page) => page.layoutMeasurement.pageIndex)).toEqual([1, 2]);
    expect(pages.every((page) => page.layoutDecision === 'paginated'
      && page.layoutMeasurement.pageCount === 2 && page.layoutMeasurement.contentLoad > 0)).toBe(true);
    expect(pages.every((page) => page.elements.some((element) => element.id.includes('title-accent') && element.type === 'shape'))).toBe(true);
  });

  it('returns section overload instead of persisting three sparse continuation pages', async () => {
    const groups = Array.from({ length: 7 }, (_, index) => ({ kind: 'native' as const, id: `step-${index + 1}`,
      element: { type: 'latex' as const, latex: `x_${index + 1}` }, observation: `第${index + 1}步` }));
    await expect(compileFlowLayout({ groups }, options)).rejects.toMatchObject({
      name: 'FlowLayoutFailure', category: 'section-overload', requestedPageCount: 3,
    } satisfies Partial<FlowLayoutFailure>);
  });

  it('returns section overload when two pages would leave only a short leftover explanation', async () => {
    const pages: FlowLayout = { groups: [
      { kind: 'media', id: 'large-evidence', resourceId: 'gen_img_large', aspectRatio: '16:9' },
      { kind: 'textBox', id: 'small-leftover', text: '观察这张图中的变化并据此给出简短解释。'.repeat(3) },
    ] };
    await expect(compileFlowLayout(pages, options)).rejects.toMatchObject({
      category: 'section-overload', requestedPageCount: 2,
    });
  });

  it('remeasures a long title with page markers before placing uneven groups', async () => {
    const groups: FlowLayout['groups'] = [
      { kind: 'native', id: 'formula-one', element: { type: 'latex', latex: 'x_1' }, observation: '第一式' },
      { kind: 'textBox', id: 'observation', text: '依据图示观察变化。' },
      { kind: 'native', id: 'formula-two', element: { type: 'latex', latex: 'x_2' }, observation: '第二式' },
      { kind: 'native', id: 'formula-three', element: { type: 'latex', latex: 'x_3' }, observation: '第三式' },
    ];
    const longTitle = '建构主义教学设计'.repeat(8);
    const pages = await compileFlowLayout({ groups }, { ...options, title: longTitle });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.teachingText)).toEqual(['第一式', '依据图示观察变化。', '第二式', '第三式']);
    expect(pages.every((page) => page.elements.every((element) => element.type === 'line' || element.top + element.height <= 512.5))).toBe(true);
    expect(await compileFlowLayout({ groups }, { ...options, title: longTitle })).toEqual(pages);
  });

  it('returns resolved continuation pages from one generation call, including required later-page media', async () => {
    let calls = 0;
    const generated = await generateSceneContent({ id: 'page', type: 'slide', title: options.title, description: '', keyPoints: [], order: 0,
      mediaGenerations: [{ type: 'image', elementId: 'gen_img_second', prompt: '观察物体', aspectRatio: '16:9' }],
      visualIntent: { representation: 'generated-image', observationGoal: '观察', resourceRefs: [{ kind: 'generated-image', resourceId: 'gen_img_second', required: true, reason: '可见证据' }] },
    }, async () => { calls++; return JSON.stringify({ layout: { groups: [
      { kind: 'media', resourceId: 'gen_img_first' },
      { kind: 'row', children: [{ kind: 'media', resourceId: 'gen_img_second' }, { kind: 'textBox', text: '观察第二个对象。' }] },
    ] } }); }, { componentAuthoring: true, slideAuthoring: 'flow', textMeasure: measure, generatedMediaMapping: { gen_img_first: '/first.png', gen_img_second: '/second.png' } });
    expect(calls).toBe(1);
    expect(generated && 'elements' in generated && generated.continuationPages?.[0].elements.some((element) => element.type === 'image' && element.src === '/second.png')).toBe(true);
    expect(generated && 'elements' in generated && generated.sourceGroupIds).toHaveLength(1);
  });

  it('records measured section overload and retains all automatic continuation pages', async () => {
    const failure: Array<{ category?: string; requestedPageCount?: number }> = [];
    const generated = await generateSceneContent({ id: 'overloaded-page', type: 'slide', title: options.title,
      description: '', keyPoints: [], order: 0 }, async () => JSON.stringify({ layout: { groups:
      Array.from({ length: 7 }, (_, index) => ({ kind: 'native', id: `step-${index + 1}`,
        element: { type: 'latex', latex: `x_${index + 1}` } })) } }),
    { componentAuthoring: true, slideAuthoring: 'flow', textMeasure: measure, onFailure: (item) => failure.push(item) });
    expect(failure).toEqual([]);
    expect(generated).toMatchObject({ qualityDiagnostics: expect.arrayContaining([expect.stringContaining('3 pages')]) });
    expect(generated && 'elements' in generated ? generated.continuationPages : []).toHaveLength(2);
    const allElements = generated && 'elements' in generated
      ? [generated, ...(generated.continuationPages ?? [])].flatMap((page) => page.elements) : [];
    expect(allElements.filter((element) => element.type === 'latex')).toHaveLength(7);
  });

  it('balances explicit and naturally wrapped orphan characters without discarding semantic paragraph breaks', async () => {
    for (const role of ['body', 'label', 'title'] as const) {
      const [element] = await compileTextComponents([{ kind: 'textBox', role, left: 50, top: 50, width: 110, fontSize: 20, text: '显性线\n索' }], measure);
      expect(element.type === 'text' && element.content).toContain('显性线索');
    }
    const [element] = await compileTextComponents([{ kind: 'textBox', left: 50, top: 50, width: 100, fontSize: 20, paragraphs: ['理解新概念', '第二段说明'] }], measure);
    expect(element.type).toBe('text');
    if (element.type !== 'text') return;
    expect(element.content.match(/<p /g)).toHaveLength(2);
    expect(element.content).toContain('理解<br>新概念');
  });

  it('retains a long ring explanation as a separate semantic group and paginates it without changing the ring', async () => {
    const annotation = '整体说明：' + '观察学习证据并据此调整后续教学活动。'.repeat(7);
    const pages = await compileFlowLayout({ groups: [{ kind: 'diagram', topology: 'cycle',
      nodes: Array.from({ length: 7 }, (_, index) => ({ id: `step-${index}`, label: `教学步骤${index + 1}` })), annotation,
    }] }, options);
    expect(pages).toHaveLength(2);
    expect(pages[0].elements.filter((element) => element.type === 'line')).toHaveLength(7);
    expect(pages[1].teachingText).toEqual([annotation]);
    expect(pages[1].elements.some((element) => element.type === 'text' && element.content.replace(/<[^>]+>/g, '') === annotation)).toBe(true);
    expect(pages.every((page) => page.elements.every((element) => element.type === 'line' || element.top + element.height <= 512.5))).toBe(true);
  });

  it('paginates an oversized container at authored child boundaries without another model call', async () => {
    const pages = await compileFlowLayout({ groups: [{ kind: 'column', children: [
      { kind: 'media', resourceId: 'gen_img_one' }, { kind: 'media', resourceId: 'gen_img_two' },
    ] }] }, options);
    expect(pages).toHaveLength(2);
    expect(pages.flatMap((page) => page.elements).filter((element) => element.type === 'image').map((element) => element.src)).toEqual(['gen_img_one', 'gen_img_two']);
    expect(pages.every((page) => page.teachingText.length > 0)).toBe(true);
    expect(new Set(pages.flatMap((page) => page.elements.map((element) => element.id))).size).toBe(pages.flatMap((page) => page.elements).length);
  });

  it('does not split a picture from its essential observation when the whole unit exceeds a page', async () => {
    const description = '必须依据这张图中的可见细节判断条件。'.repeat(18);
    await expect(compileFlowLayout({ groups: [{ kind: 'row', id: 'evidence-and-observation', children: [
      { kind: 'media', resourceId: 'gen_img_evidence', aspectRatio: '4:3' },
      { kind: 'textBox', text: description },
    ] }] }, options)).rejects.toMatchObject({ name: 'FlowLayoutFailure', category: 'page-capacity' });
  });

  it('keeps a complete cycle when an oversized diagram and explanation group flows across pages', async () => {
    const pages = await compileFlowLayout({ groups: [{ kind: 'column', children: [
      { kind: 'diagram', topology: 'cycle', nodes: ['测量', '比较', '调节', '反馈'].map((label, index) => ({ id: String(index), label })) },
      { kind: 'textBox', paragraphs: ['依次测量实际温度，与目标温度比较，然后调节加热器。'.repeat(3), '下一轮测量验证调节结果，使系统持续响应偏差。'.repeat(3)] },
    ] }] }, options);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.elements).filter((element) => element.type === 'line')).toHaveLength(4);
    expect(pages.every((page) => page.elements.every((element) => element.type === 'line' || element.top + element.height <= 512.5))).toBe(true);
  });

  it('splits paragraphs that exceed even a whole-canvas allocation without dropping their content', async () => {
    const paragraphs = ['观察对象的结构并记录可见差异。'.repeat(10), '利用这些证据解释实际发生的变化。'.repeat(10), '比较新的观察和先前的解释。'.repeat(10)];
    const pages = await compileFlowLayout({ groups: [{ kind: 'textBox', paragraphs }] }, options);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.flatMap((page) => page.teachingText)).toEqual(paragraphs);
  });

  it('preserves a model-authored heading and paragraphs in the same text group', async () => {
    const pages = await compileFlowLayout({ groups: [{ kind: 'textBox', text: '判断依据', paragraphs: ['先观察可见变化，再说明推理。'] }] }, options);
    expect(pages[0].teachingText).toEqual(['判断依据', '先观察可见变化，再说明推理。']);
    expect(pages[0].elements.some((element) => element.type === 'text' && element.content.includes('判断依据') && element.content.includes('先观察'))).toBe(true);
  });

  it('lays out explanatory labels across more than two measured lines', async () => {
    const text = '课堂三：从头到尾围绕“怎样让小车在陌生房间里不撞墙”这一个问题展开';
    const pages = await compileFlowLayout({ groups: [{ kind: 'row', children: [1, 2, 3].map(() => ({ kind: 'textBox', role: 'label', text })) }] }, options);
    const labels = pages[0].elements.filter((element) => element.type === 'text' && element.id !== 'lesson-page-title');
    expect(labels).toHaveLength(3);
    expect(labels.every((element) => element.type === 'text' && element.height > 2 * 24 * 1.5)).toBe(true);
  });
});
