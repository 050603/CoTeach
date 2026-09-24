import { afterAll, describe, expect, it } from 'vitest';
import { compileTextComponents, compileNativeTextLayout } from '../../../../packages/@openmaic/generation/src/text-layout-compiler';
import { compileMeasuredDiagramComponent, measureDiagramAllocations } from '../../../../packages/@openmaic/generation/src/diagram-compiler';
import { compileFlowLayout } from '../../../../packages/@openmaic/generation/src/flow-layout-compiler';
import { closeSpatialMeasurementBrowser, measureAuthoredSlideText } from './slide-spatial-measurement';

afterAll(async () => { await closeSpatialMeasurementBrowser(); });

describe('first draft with the actual slide font', () => {
  it('measures native rich typography without flattening mixed-size spans into separate lines', async () => {
    const base = { text: '重要证据', width: 180, fontSize: 16, fontWeight: 400 as const,
      fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left' as const };
    const html = '<p><strong style="font-size:32px;color:#1E3A8A">重要</strong><span style="font-size:16px">证据</span></p>';
    const native = await measureAuthoredSlideText({ ...base, html, preserveRichText: true });
    const flattened = await measureAuthoredSlideText({ ...base, html });
    expect(native.naturalWidth).toBeGreaterThan(flattened.naturalWidth + 20);
    expect(native.height).toBeGreaterThan(flattened.height);
    expect(native.lines).toEqual(['重要证据']);
    const unsafe = await measureAuthoredSlideText({ ...base, preserveRichText: true,
      html: html.replace('color:#1E3A8A', 'color:#1E3A8A;position:fixed;left:0;width:10000px;background-image:url(https://invalid.test/image)') });
    expect(unsafe).toEqual(native);
  });

  it('uses the native table cell box model and resets it before measuring ordinary prose', async () => {
    const base = { html: '<p style="font-size:18px">判断依据</p>', text: '判断依据', width: 120,
      fontSize: 18, fontWeight: 400 as const, fontFamily: 'Noto Sans SC', padding: 0,
      lineHeight: 1, paragraphSpace: 0, align: 'left' as const, preserveRichText: true, tableCell: true };
    const plainCell = await measureAuthoredSlideText(base);
    const paddedCell = await measureAuthoredSlideText({ ...base, paddingCss: '6px 12px' });
    expect(paddedCell.height).toBe(plainCell.height + 12);
    expect(paddedCell.naturalWidth).toBeCloseTo(plainCell.naturalWidth, 1);
    const prose = await measureAuthoredSlideText({ ...base, tableCell: false, padding: 10, lineHeight: 1.5 });
    expect(prose.height).toBeGreaterThan(paddedCell.height);
  });

  it('preserves meaningful authored verse line breaks during rich-text measurement', async () => {
    const measured = await measureAuthoredSlideText({ html: '<p style="font-size:18px;white-space:pre-wrap">山\n水</p>',
      text: '山\n水', width: 200, fontSize: 18, fontWeight: 400, fontFamily: 'Noto Sans SC',
      padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left', preserveRichText: true });
    expect(measured.lines).toEqual(['山', '水']);
    expect(measured.height).toBeGreaterThanOrEqual(74);
  });

  it.each(['转化', '具体化', '依据实践逐步具体化'])('measures sequence edge label %s before allocating gaps', async (label) => {
    const diagram = { type: 'diagram' as const, id: 'three-levels', topology: 'sequence' as const,
      left: 50, top: 140, width: 900, height: 120,
      nodes: [{ id: 'theory', label: '教学理论' }, { id: 'model', label: '教学模式' }, { id: 'method', label: '教学方法' }],
      edges: [{ from: 'theory', to: 'model', label }, { from: 'model', to: 'method', label }] };
    const elements = await compileMeasuredDiagramComponent(diagram, measureAuthoredSlideText);
    const nodes = elements.filter((element) => element.type === 'shape');
    const labels = elements.filter((element) => element.type === 'text');
    expect(labels).toHaveLength(2);
    for (const [index, text] of labels.entries()) {
      expect(text.left).toBeGreaterThan(nodes[index]!.left + nodes[index]!.width);
      expect(text.left + text.width).toBeLessThan(nodes[index + 1]!.left);
      const actual = await measureAuthoredSlideText({ html: text.content, text: label, width: text.width,
        fontSize: 16, fontWeight: 400, fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.2,
        paragraphSpace: 0, align: 'center' });
      expect(actual.lines).toHaveLength(1);
    }
    await expect(compileMeasuredDiagramComponent({ ...diagram, width: 440 }, measureAuthoredSlideText)).rejects.toThrow(/sequence.*do not fit/);
  });

  it('finds a larger first-pass rectangle for a real four-step annotation that exceeds 120px', async () => {
    const plan = {
      topology: 'sequence' as const,
      nodes: ['提出任务', '规划设计', '完成任务', '总结评价'].map((label, index) => ({ id: `t${index + 1}`, label })),
      edges: [{ from: 't1', to: 't2' }, { from: 't2', to: 't3' }, { from: 't3', to: 't4' }],
      annotation: '四步的顺序不是为了走形式：先交代背景和目标，学生才知道要解决什么；先规划再动手，才能避免乱试；最后展示与评价既看作品质量，也看学习态度、合作与创新。',
    };
    const choices = await measureDiagramAllocations(plan, measureAuthoredSlideText);
    expect(choices.some((choice) => choice.width === 900 && choice.height > 120)).toBe(true);
    for (const choice of choices) {
      const elements = await compileMeasuredDiagramComponent({ ...plan, ...choice,
        type: 'diagram', id: 'four-steps', left: 50, top: 140 }, measureAuthoredSlideText);
      expect(elements.filter((element) => element.type === 'line')).toHaveLength(3);
    }
  });

  it.each([
    ['小鱼把“有角、四条腿、吃草”塞进自己鱼的形象，画出有鱼鳍、鱼鳞又有角和腿的牛。', 440, 22],
    ['任务构成显性线索，学生看得见自己在做什么。', 440, 22],
    ['直接观察：记录可核验的时间、地点、人物、数量、动作、原话等信息。', 459.17, 20],
    ['作者推测：对原因、趋势、意义或价值作出的判断。', 341.92, 20],
  ] as const)('balances real CJK text without punctuation-only or one-glyph lines: %s', async (text, width, fontSize) => {
    const [element] = await compileTextComponents([{ kind: 'textBox', role: 'body', text, left: 50, top: 50, width, fontSize }], measureAuthoredSlideText);
    if (element.type !== 'text') throw new Error('Expected editable text');
    const actual = await measureAuthoredSlideText({ html: element.content, text, width, fontSize, fontWeight: 400,
      fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left' });
    expect(actual.lines.length).toBeGreaterThan(1);
    expect(actual.lines.every((line) => !/^[\u3400-\u9fff]$/.test(line.replace(/[\s\p{P}\p{S}]/gu, '')))).toBe(true);
    expect(actual.lines.every((line) => !/^[、，。；：）】》」』”’]/.test(line.trim()))).toBe(true);
    expect(element.content.replace(/<[^>]+>/g, '')).toBe(text);
    if (text.startsWith('任务构成')) expect(element.content).toContain('任务构成显性线索，<br>学生');
  });

  it('repairs a persisted explicit break before an enumeration comma within the original allocation', async () => {
    const [element] = await compileTextComponents([{ kind: 'textBox', role: 'label', text: '发现问题、提出假设\n、收集证据、得出结论', left: 50, top: 50, width: 236.94117647058823, maxHeight: 80, fontSize: 20 }], measureAuthoredSlideText);
    if (element.type !== 'text') throw new Error('Expected text');
    expect(element.content).not.toContain('<br>、');
    expect(element.height).toBeLessThanOrEqual(80);
    expect(element.content.replace(/<[^>]+>/g, '')).toBe('发现问题、提出假设、收集证据、得出结论');
  });

  it('never creates a leading Chinese enumeration comma in balanced table labels', async () => {
    const text = '直接观察：记录可核验的时间、地点、人物、数量、动作、原话等信息。';
    const [element] = await compileTextComponents([{ kind: 'textBox', role: 'label', text, left: 50, top: 50, width: 459.17, fontSize: 20 }], measureAuthoredSlideText);
    if (element.type !== 'text') throw new Error('Expected text');
    const actual = await measureAuthoredSlideText({ html: element.content, text, width: element.width, fontSize: 20, fontWeight: 400,
      fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left' });
    expect(actual.lines.every((line) => !/^[、，。；：）】》」』”’]/.test(line.trim()))).toBe(true);
  });

  it('fits explanatory labels with Chinese brackets using actual browser wrapping', async () => {
    for (const fontSize of [18, 20, 22, 24]) {
      const [element] = await compileTextComponents([{ kind: 'textBox', role: 'label', text: '所选理论（学习如何发生的判断）', left: 50, top: 50, width: 170.4, fontSize }], measureAuthoredSlideText);
      if (element.type !== 'text') throw new Error('Expected text');
      expect(element.height).toBeGreaterThan(0);
    }
  });
  it('turns the test-course four-step labels into readable editable boxes', async () => {
    const elements = await compileTextComponents([{
      kind: 'labelGrid', left: 60, top: 280, width: 880, height: 164,
      fontSize: 18, gapX: 12, gapY: 16,
      rows: [
        { header: '显性线索：任务链', cells: ['创设情境提出任务', '分析讨论规划设计', '自主探索完成任务', '展示交流总结评价'] },
        { header: '隐性脉络：知识技能', cells: ['明确任务与目标', '理解人工智能原理', '提取并使用特征', '评价作品与反思'] },
      ],
    }], measureAuthoredSlideText);
    const labels = elements.filter((item) => item.type === 'text');
    expect(labels).toHaveLength(10);
    for (const label of labels) {
      if (label.type !== 'text') continue;
      const text = label.content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
      const measured = await measureAuthoredSlideText({
        html: label.content, text, width: label.width, fontSize: 18, fontWeight: 400,
        fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left',
      });
      expect(measured.height).toBeLessThanOrEqual(label.height + 0.5);
      expect(measured.lines.every((line) => [...line].length > 1)).toBe(true);
      expect(label.defaultFontName).toBe('Noto Sans SC');
    }
    expect(labels.slice(1, 5).every((item) => item.type === 'text' && item.height === labels[1]?.height)).toBe(true);
  });

  it('measures mixed script, bold, semantic breaks and separate paragraphs', async () => {
    const input = { kind: 'textBox' as const, left: 60, top: 160, width: 410, height: 180,
      fontSize: 24, bold: true, paragraphs: ['AI 图像对照：牛与鱼', '同化：保留原有结构\n顺应：调整原有结构'] };
    const [element] = await compileTextComponents([input], measureAuthoredSlideText);
    expect(element.type).toBe('text');
    if (element.type !== 'text') return;
    expect(element.content).toContain('<br>');
    const actual = await measureAuthoredSlideText({
      html: element.content, text: input.paragraphs.join('\n\n'), width: element.width, fontSize: 24,
      fontWeight: 700, fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left',
    });
    expect(actual.height).toBeLessThanOrEqual(element.height);
    expect(actual.lines.length).toBeGreaterThanOrEqual(3);
  });
});


describe('flow layout in the actual playback font', () => {
  it('reflows a nested narrow diagram row using measured edge-label gaps', async () => {
    const pages = await compileFlowLayout({ groups: [{ kind: 'column', children: [{ kind: 'row', children: [
      { kind: 'diagram', topology: 'sequence', nodes: ['教学理论', '教学模式', '教学方法'].map((label, index) => ({ id: String(index), label })),
        edges: [{ from: '0', to: '1', label: '具体化' }, { from: '1', to: '2', label: '具体化' }] },
      { kind: 'textBox', text: '三层之间是抽象程度与作用范围的区别。' },
    ] }] }] }, { title: '三层关系', id: 'browser-three-levels', textMeasure: measureAuthoredSlideText });
    const all = pages.flatMap((page) => page.elements);
    const nodes = all.filter((element) => element.type === 'shape');
    const labels = all.filter((element) => element.id.includes('edge-label'));
    expect(all.filter((element) => element.type === 'line')).toHaveLength(2);
    expect(labels).toHaveLength(2);
    for (const [index, label] of labels.entries()) {
      expect(label.left).toBeGreaterThan(nodes[index]!.left + nodes[index]!.width);
      expect(label.left + label.width).toBeLessThan(nodes[index + 1]!.left);
    }
    const explanation = all.find((element) => element.type === 'text' && element.content.includes('三层之间'))!;
    expect(explanation.width).toBe(900);
    expect(explanation.top).toBeGreaterThan(Math.max(...nodes.map((node) => node.top + node.height)));
  });

  it('keeps an image separate from text and balances explicit orphan characters', async () => {
    const pages = await compileFlowLayout({ groups: [{ kind: 'row', children: [
      { kind: 'media', resourceId: 'gen_img_observation', aspectRatio: '4:3' },
      { kind: 'column', children: [
        { kind: 'textBox', role: 'label', text: '显性线\n索', fontSize: 20 },
        { kind: 'textBox', text: '观察对象的外形与结构，再依据可见证据进行解释。', fontSize: 24 },
      ] },
    ] }] }, { title: '可见证据与解释', id: 'browser-flow', textMeasure: measureAuthoredSlideText });
    expect(pages).toHaveLength(1);
    const image = pages[0].elements.find((element) => element.type === 'image')!;
    const labels = pages[0].elements.filter((element) => element.type === 'text');
    expect(labels.some((element) => element.type === 'text' && element.content.includes('显性线索'))).toBe(true);
    expect(labels.every((element) => element.left >= image.left + image.width || element.top + element.height <= image.top)).toBe(true);
  });

  it('measures a seven-step closed ring with an independent, readable annotation', async () => {
    const [page] = await compileFlowLayout({ groups: [{ kind: 'diagram', topology: 'cycle',
      nodes: ['确定目标', '激活经验', '新知讲解', '示范应用', '强化练习', '即时反馈', '调整教学'].map((label, index) => ({ id: `step-${index}`, label })),
      annotation: '依据反馈调整教学',
    }] }, { title: '教学设计循环', id: 'browser-ring', textMeasure: measureAuthoredSlideText });
    expect(page.elements.filter((element) => element.type === 'line')).toHaveLength(7);
    const annotation = page.elements.find((element) => element.type === 'text' && element.content.includes('依据反馈调整教学'))!;
    if (annotation.type !== 'text') throw new Error('Missing editable annotation');
    const actual = await measureAuthoredSlideText({ html: annotation.content,
      text: '依据反馈调整教学', width: annotation.width, fontSize: 22, fontWeight: 400,
      fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5, paragraphSpace: 5, align: 'left',
    });
    expect(actual.height).toBeLessThanOrEqual(annotation.height);
    expect(page.elements.filter((element) => element.type === 'shape').every((element) => element.top + element.height < annotation.top)).toBe(true);
  });
});


describe('native slide authoring with actual renderer typography', () => {
  it('preserves rich emphasis and balances only an orphan label inside its original rectangle', async () => {
    const element = { id: 'native-label', type: 'text' as const, left: 60, top: 120, width: 100, height: 82,
      rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', lineHeight: 1.5,
      content: '<p style="font-size:16px;color:#223388"><strong>显性线索栏。</strong></p>' };
    const [compiled] = await compileNativeTextLayout([element], measureAuthoredSlideText);
    if (compiled.type !== 'text') throw new Error('Missing native label');
    expect(compiled.content.replace(/<br>/g, '')).toBe(element.content);
    expect(compiled).toMatchObject({ id: element.id, left: 60, top: 120, width: 100, height: 82 });
    const measured = await measureAuthoredSlideText({ html: compiled.content, text: '显性线索栏。', width: 100,
      fontSize: 16, fontWeight: 400, fontFamily: 'Noto Sans SC', padding: 10, lineHeight: 1.5,
      paragraphSpace: 5, align: 'left', preserveRichText: true });
    expect(measured.lines.every((line) => !/^[\u3400-\u9fff]$/.test(line.replace(/[\s\p{P}\p{S}]/gu, '')))).toBe(true);
    expect(measured.height).toBeLessThanOrEqual(82);
  });

  it('retains native table header emphasis, proportional columns and compact cell typography', async () => {
    const table = { id: 'native-table', type: 'table' as const, left: 60, top: 120, width: 880, height: 100,
      rotate: 0, outline: { width: 1, color: '#CCD4E0' }, colWidths: [0.25, 0.75], cellMinHeight: 48,
      data: [[{ id: 'a', text: '<strong>教学理论</strong>', colspan: 1, rowspan: 1, style: { fontsize: '16', color: '#FFFFFF', backcolor: '#1E3A8A' } },
        { id: 'b', text: '为为什么这样教提供依据', colspan: 1, rowspan: 1, style: { fontsize: '16' } }]] } as import('@openmaic/dsl').PPTTableElement;
    const [compiled] = await compileNativeTextLayout([table], measureAuthoredSlideText);
    expect(compiled).toEqual(table);
  });
});


describe('planned local diagram capacity with the actual font', () => {
  it('gives seven-node native authoring feasible full-width and side-by-side allocations', async () => {
    const plan = { topology: 'cycle' as const, nodes: ['目标分析', '情境创设', '资源设计', '自主学习', '协作环境', '效果评价', '强化练习'].map((label, i) => ({ id: String(i), label })),
      annotation: '强化练习的新问题回到目标分析，形成闭环。' };
    const choices = await measureDiagramAllocations(plan, measureAuthoredSlideText);
    expect(choices.some((choice) => choice.width === 900)).toBe(true);
    expect(choices.some((choice) => choice.width === 600)).toBe(true);
    expect(choices.some((choice) => choice.width === 440)).toBe(false);
    for (const choice of choices) {
      const elements = await compileMeasuredDiagramComponent({ ...plan, ...choice, type: 'diagram', id: 'native-seven', left: 50, top: 140 }, measureAuthoredSlideText);
      expect(elements.filter((element) => element.type === 'line')).toHaveLength(7);
    }
  });
});
