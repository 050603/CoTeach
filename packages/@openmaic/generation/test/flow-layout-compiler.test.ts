import { describe, expect, it } from 'vitest';
import { compileFlowLayout, type FlowLayout } from '../src/flow-layout-compiler.js';
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
    expect(pages.every((page) => page.sourceGroupIds.length === 1)).toBe(true);
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
