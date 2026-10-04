import { describe, expect, it } from 'vitest';
import type { PPTElement, SlideContentBinding } from '@openmaic/dsl';
import { buildSlideSemanticGroups, nativeSemanticBindingIssues, nativeSemanticVisualIssues, type SlideSemanticItem } from './slide-semantic-hierarchy';

const sources = [
  { id: 'declared', text: '学习环境四要素：情境、协作、会话、意义建构。' },
  { id: 'teacher', text: '教师角色：组织者、指导者、帮助者和促进者。' },
  { id: 'principle', text: '以学生为中心：发挥主动性并通过反馈形成认识。' },
  { id: 'situation', text: '情境：真实情境帮助理解。' },
  { id: 'collaboration', text: '协作：通过讨论交流共享理解。' },
  { id: 'resources', text: '资源支持：资料和程序支持学习。' },
  { id: 'meaning', text: '意义建构：围绕主题设计活动。' },
];
const groups = buildSlideSemanticGroups(sources);
const group = groups[0]!;
const overview: SlideSemanticItem = { id: 'overview', text: sources[0]!.text, sourceContentIds: ['declared'],
  semanticBindings: [{ groupId: group.id, role: 'overview' }] };
function member(index: number): SlideSemanticItem {
  const selected = group.members[index]!;
  return { id: `member-${index}`, text: selected.label, sourceContentIds: [selected.sourceContentIds.at(-1)!],
    semanticBindings: [{ groupId: group.id, role: 'member', memberId: selected.id }] };
}
function context(id: string): SlideSemanticItem {
  return { id, text: sources.find((source) => source.id === id)!.text, sourceContentIds: [id],
    semanticBindings: [{ groupId: group.id, role: 'context' }] };
}
function text(id: string, value: string, left: number, top: number, width: number, height: number): PPTElement {
  return { id, type: 'text', left, top, width, height, rotate: 0, content: `<p>${value}</p>`, defaultFontName: 'Noto Sans SC', defaultColor: '#334155' };
}
function panel(id: string, left: number, top: number, width: number, height: number): PPTElement {
  return { id, type: 'shape', left, top, width, height, rotate: 0, viewBox: [100, 100], path: 'M0 0H100V100H0Z', fill: '#EFF6FF', fixedRatio: false };
}
function native(items: SlideSemanticItem[], entries: Array<{ item: SlideSemanticItem; left: number; top: number; width: number; height: number; panel?: boolean }>) {
  const elements: PPTElement[] = [], contentBindings: SlideContentBinding[] = [];
  for (const [index, entry] of entries.entries()) {
    if (entry.panel) elements.push(panel(`panel-${index}`, entry.left, entry.top, entry.width, entry.height));
    elements.push(text(`text-${index}`, entry.item.text, entry.left + 10, entry.top, entry.width - 20, entry.height));
    contentBindings.push({ sourceContentId: entry.item.id, elementId: `text-${index}` });
  }
  return { displayItems: items, elements, contentBindings };
}

function plainInterleaving(metadata = true) {
  const support = metadata ? context('resources') : { ...context('resources'), semanticBindings: undefined };
  const items = [member(0), member(1), member(3), support];
  const briefMember = member(2);
  const content = native([overview, briefMember, ...items], [
    { item: overview, left: 60, top: 166, width: 880, height: 48 },
    { item: briefMember, left: 60, top: 420, width: 230, height: 40 },
    { item: items[0]!, left: 376, top: 220, width: 300, height: 79 },
    { item: items[1]!, left: 376, top: 302, width: 300, height: 74 },
    { item: items[2]!, left: 672, top: 328, width: 288, height: 100 },
    { item: support, left: 672, top: 220, width: 288, height: 100 },
  ]);
  for (const [index, item] of items.entries()) {
    const element = content.elements[index + 2]!;
    if (element.type !== 'text') throw new Error('text fixture expected');
    const label = item.text.split(/[:：]/u)[0]!;
    element.content = `<p style="font-size:16px;color:#334155"><span style="color:#1E3A8A;font-weight:700">${label}</span>：说明文字支持完整认识。</p>`;
  }
  return content;
}

describe('source-scoped native semantic hierarchy', () => {
  it('extracts exact declared membership and only exact member-label explanations, leaving principles, roles and resources outside', () => {
    expect(groups).toHaveLength(1);
    expect(group.label).toBe('学习环境四要素');
    expect(group.members.map((entry) => entry.label)).toEqual(['情境', '协作', '会话', '意义建构']);
    expect(group.members.map((entry) => entry.sourceContentIds)).toEqual([
      ['declared', 'situation'], ['declared', 'collaboration'], ['declared'], ['declared', 'meaning'],
    ]);
    expect(buildSlideSemanticGroups(sources)).toEqual(groups);
  });

  it('works across subjects, Chinese and Arabic counts, final conjunctions and multiple independent groups', () => {
    const result = buildSlideSemanticGroups([
      { id: 'materials', text: '三类材料：金属、塑料、木材。' },
      { id: 'mechanisms', text: '两种机制：扩散和传导。' },
      { id: 'conditions', text: '5个条件：甲、乙、丙、丁、戊。' },
      { id: 'metal', text: '金属：导热性较强。' },
      { id: 'irrelevant', text: '选择原则：依据材料用途。' },
    ]);
    expect(result.map((entry) => entry.members.map((part) => part.label))).toEqual([
      ['金属', '塑料', '木材'], ['扩散', '传导'], ['甲', '乙', '丙', '丁', '戊'],
    ]);
    expect(new Set(result.flatMap((entry) => [entry.id, ...entry.members.map((part) => part.id)])).size).toBe(13);
    expect(result[0]!.members[0]!.sourceContentIds).toEqual(['materials', 'metal']);
  });

  it.each([
    '若干类型：甲、乙、丙。', '三种类型：甲、乙。', '三种类型：甲、乙、丙、丁。',
    '三类材料：金属、塑料等。', '三种类型：甲、甲、乙。', '至少三种类型：甲、乙、丙。',
    '其中三种类型：甲、乙、丙。', '三个温度达到30度。', '三种类型：甲、乙、丙，其中甲有两类。',
    '三种类型：甲、乙、丙（还包括其他）。', '试验包括甲、乙、丙。', '质量约3千克：甲、乙、丙。',
  ])('does not invent a full group from ambiguous, incomplete or mismatched declaration %s', (value) => {
    expect(buildSlideSemanticGroups([{ id: 'source', text: value }])).toEqual([]);
  });

  it('allows one complete readable overview and supporting context without requiring four separate cards', () => {
    const support = context('teacher');
    const content = native([overview, support], [
      { item: overview, left: 60, top: 110, width: 880, height: 64, panel: true },
      { item: support, left: 60, top: 210, width: 880, height: 72 },
    ]);
    expect(nativeSemanticBindingIssues(content.displayItems, groups)).toEqual([]);
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
  });

  it('diagnoses missing or forged membership without throwing away the original native items', () => {
    const wrong: SlideSemanticItem = { ...context('teacher'), semanticBindings: [{ groupId: group.id, role: 'member', memberId: group.members[0]!.id }] };
    const items: SlideSemanticItem[] = [wrong, { ...overview, semanticBindings: [{ groupId: 'unknown', role: 'overview' }] },
      { ...member(1), semanticBindings: [{ groupId: group.id, role: 'member', memberId: 'fake' }] },
      { ...context('resources'), semanticBindings: [{ groupId: group.id, role: 'context', memberId: group.members[3]!.id }] },
      { ...member(2), semanticBindings: [{ groupId: group.id, role: 'made-up' }] }];
    const original = structuredClone(items);
    const issues = nativeSemanticBindingIssues(items, groups);
    expect(issues).toEqual(expect.arrayContaining([
      expect.stringContaining('Unsupported semantic member 情境'), expect.stringContaining('Unknown semantic group unknown'),
      expect.stringContaining('Unknown semantic member fake'), expect.stringContaining('context cannot claim a member'),
      expect.stringContaining('Invalid semantic role'), expect.stringContaining('Missing semantic overview'), expect.stringContaining('Missing readable semantic member'),
    ]));
    expect(items).toEqual(original);
  });

  it('accepts a true member explanation through its exact source when its concise body does not repeat the member title', () => {
    const explanation = { ...member(0), text: '真实背景帮助理解。' };
    expect(nativeSemanticBindingIssues([overview, explanation], groups)).toEqual([]);
    expect(nativeSemanticBindingIssues([{ ...member(0), text: '教师负责组织教学。', label: '教师角色', sourceContentIds: ['declared'] }], groups))
      .toContainEqual(expect.stringContaining('Unsupported semantic member 情境'));
    expect(nativeSemanticBindingIssues([{ ...member(0), text: '情境', sourceContentIds: ['principle'] }], groups))
      .toContainEqual(expect.stringContaining('Unsupported semantic member 情境'));
  });

  it('diagnoses the real P3 six equal peer panels while retaining all elements and full enumerated text', () => {
    const items = [context('principle'), context('teacher'), member(0), member(1), context('resources'), member(3)];
    const content = native([overview, ...items], [{ item: overview, left: 60, top: 108, width: 880, height: 50, panel: true },
      ...items.map((item, index) => ({ item, left: index % 2 ? 510 : 60, top: 166 + Math.floor(index / 2) * 116, width: 430, height: 108, panel: true }))]);
    const original = structuredClone(content);
    expect(nativeSemanticBindingIssues(content.displayItems, groups)).toEqual([]);
    expect(nativeSemanticVisualIssues(content, groups)).toContainEqual(expect.stringContaining('Flattened semantic hierarchy'));
    expect(content).toEqual(original);
  });

  it('does not silently accept overview-only metadata when member and context cards remain unclassified', () => {
    const items = [overview, { ...member(0), semanticBindings: undefined }, { ...context('teacher'), semanticBindings: undefined }];
    const issues = nativeSemanticBindingIssues(items, groups);
    expect(issues).toContain('Unclassified semantic hierarchy for item member-0');
    expect(issues).toContain('Unclassified semantic hierarchy for item teacher');
    expect(issues).toContain('Member explanation member-0 lacks its actual member classification');
    expect(nativeSemanticBindingIssues([overview, { ...member(0), semanticBindings: [{ groupId: group.id, role: 'context' }] }], groups))
      .toContain('Member explanation member-0 lacks its actual member classification');
  });

  it('classifies independent groups separately without requiring each item to participate in every group', () => {
    const independent = buildSlideSemanticGroups([{ id: 'materials', text: '三类材料：金属、塑料、木材。' }, { id: 'mechanisms', text: '两种机制：扩散、传导。' }]);
    const items = independent.map((entry, index) => ({ id: `overview-${index}`, text: entry.members.map((part) => part.label).join('、'),
      sourceContentIds: entry.sourceContentIds, semanticBindings: [{ groupId: entry.id, role: 'overview' }] }));
    expect(nativeSemanticBindingIssues(items, independent)).toEqual([]);
    expect(nativeSemanticVisualIssues(native(items, items.map((item, index) => ({ item, left: 60, top: 120 + index * 140, width: 880, height: 80 }))), independent))
      .toEqual([]);
  });

  it('checks a conflicting explicit count for the same declared group without treating unrelated quantities as membership', () => {
    const independent = buildSlideSemanticGroups([{ id: 'materials', text: '三类材料：金属、塑料、木材。' }]);
    const item: SlideSemanticItem = { id: 'materials-overview', text: '四类材料：金属、塑料、木材。', sourceContentIds: ['materials'],
      semanticBindings: [{ groupId: independent[0]!.id, role: 'overview' }] };
    expect(nativeSemanticBindingIssues([item], independent)).toContainEqual(expect.stringContaining('Changed declared member count'));
    expect(nativeSemanticBindingIssues([{ ...item, text: '金属、塑料、木材。', label: '四类材料' }], independent))
      .toContainEqual(expect.stringContaining('Changed declared member count'));
    expect(nativeSemanticBindingIssues([{ ...item, text: '金属、塑料、木材。比较2种加工方法，成本为4元。' }], independent)).toEqual([]);
    expect(nativeSemanticBindingIssues([{ ...overview, text: '五要素：情境、协作、会话、意义建构。' }], groups))
      .toContainEqual(expect.stringContaining('Changed declared member count'));
  });

  it('accepts equal member panels under an exclusive common heading and separately placed supporting context', () => {
    const items = [member(0), member(1), member(2), member(3)], support = context('teacher');
    const content = native([overview, ...items, support], [{ item: overview, left: 60, top: 110, width: 880, height: 50 },
      ...items.map((item, index) => ({ item, left: index % 2 ? 510 : 60, top: 170 + Math.floor(index / 2) * 100, width: 430, height: 84, panel: true })),
      { item: support, left: 60, top: 410, width: 430, height: 84, panel: true }]);
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
  });

  it('accepts a real group container even when supporting context uses the same local panel appearance elsewhere', () => {
    const items = [member(0), member(1), member(2), member(3)], support = context('teacher');
    const content = native([overview, ...items, support], [{ item: overview, left: 60, top: 105, width: 550, height: 60 },
      ...items.map((item, index) => ({ item, left: index % 2 ? 330 : 60, top: 180 + Math.floor(index / 2) * 100, width: 250, height: 80, panel: true })),
      { item: support, left: 660, top: 180, width: 250, height: 80, panel: true }]);
    content.elements.unshift(panel('group-container', 50, 100, 560, 280));
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
  });

  it('diagnoses an incomplete expanded member region even when the overview still names the complete set', () => {
    const items = [member(0), member(1), member(3)];
    const content = native([overview, ...items], [{ item: overview, left: 60, top: 110, width: 880, height: 60 },
      ...items.map((item, index) => ({ item, left: 60 + index * 300, top: 210, width: 280, height: 100, panel: true }))]);
    expect(nativeSemanticBindingIssues(content.displayItems, groups)).toEqual([]);
    expect(nativeSemanticVisualIssues(content, groups)).toContainEqual(expect.stringContaining('Expanded member region omits 会话'));
  });

  it('allows four legally identified members combined into three actual explanatory regions', () => {
    const first = member(0), last = member(3);
    const combined: SlideSemanticItem = { id: 'combined', text: '协作与会话共同支持讨论交流。', sourceContentIds: ['declared', 'collaboration'],
      semanticBindings: [1, 2].map((index) => ({ groupId: group.id, role: 'member', memberId: group.members[index]!.id })) };
    const content = native([overview, first, combined, last], [{ item: overview, left: 60, top: 110, width: 880, height: 60 },
      ...[first, combined, last].map((item, index) => ({ item, left: 60 + index * 300, top: 210, width: 280, height: 100 }))]);
    expect(nativeSemanticBindingIssues(content.displayItems, groups)).toEqual([]);
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
  });

  it('allows a true count-only group overview with all member names supplied by legally bound expanded items', () => {
    const counted: SlideSemanticItem = { ...overview, text: group.label };
    const items = group.members.map((_, index) => member(index));
    const content = native([counted, ...items], [{ item: counted, left: 60, top: 110, width: 880, height: 60 },
      ...items.map((item, index) => ({ item, left: 60 + index * 225, top: 210, width: 210, height: 100 }))]);
    expect(nativeSemanticBindingIssues(content.displayItems, groups)).toEqual([]);
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
    // A raw name somewhere else cannot take the place of its canonical member binding.
    content.displayItems[3]!.semanticBindings = [{ groupId: group.id, role: 'context' }];
    expect(nativeSemanticVisualIssues(content, groups)).toContainEqual(expect.stringContaining('Expanded member region omits 会话'));
  });

  it('distinguishes expanded table cells from an overview cell in the same native table', () => {
    const items = [member(0), member(1), member(3)];
    const content = native([overview, ...items], []);
    const values = [overview.text, ...items.map((item) => item.text)];
    content.elements.push({ id: 'member-table', type: 'table', left: 60, top: 110, width: 880, height: 300, rotate: 0,
      data: values.map((value, index) => [{ id: `cell-${index}`, text: value, colspan: 1, rowspan: 1 }]),
      colWidths: [1], rowHeights: [1, 1, 1, 1], cellMinHeight: 40 } as unknown as PPTElement);
    content.contentBindings.push(...[overview, ...items].map((item, index) => ({ sourceContentId: item.id, elementId: 'member-table', selector: { cellId: `cell-${index}` } })));
    expect(nativeSemanticVisualIssues(content, groups)).toContainEqual(expect.stringContaining('Expanded member region omits 会话'));
  });

  it.each([true, false])('diagnoses equal plain text sections interleaving supporting context with members (context metadata %s)', (metadata) => {
    const content = plainInterleaving(metadata);
    const original = structuredClone(content);
    expect(nativeSemanticVisualIssues(content, groups)).toContainEqual(expect.stringContaining('equally styled member text sections'));
    expect(content).toEqual(original);
  });

  it('allows independent sidebars and bottom supporting sections with the same typography', () => {
    for (const placement of [{ left: 60, top: 220 }, { left: 682, top: 450 }]) {
      const content = plainInterleaving();
      Object.assign(content.elements.at(-1)!, placement);
      expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
    }
  });

  it('preserves foreground hierarchy when supporting text uses a different font size or lead-label treatment', () => {
    for (const replace of [['font-size:16px', 'font-size:18px'], ['font-size:16px', 'font-size:16px;font-family:Noto Serif SC'],
      ['color:#1E3A8A;font-weight:700', 'color:#334155;font-weight:400']]) {
      const content = plainInterleaving();
      const support = content.elements.at(-1)!;
      if (support.type !== 'text') throw new Error('text fixture expected');
      support.content = support.content.replace(replace[0]!, replace[1]!);
      expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
    }
  });

  it('does not treat member and support bindings inside one genuinely combined paragraph as separate peer text sections', () => {
    const content = plainInterleaving();
    const memberText = content.elements[1]!;
    if (memberText.type !== 'text') throw new Error('text fixture expected');
    memberText.content = memberText.content.replace('</p>', '相关资源为此提供学习支持。</p>');
    content.contentBindings.at(-1)!.elementId = memberText.id;
    content.elements.pop();
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
  });

  it('does not borrow another independent group overview to justify interleaved foreground sections', () => {
    const content = plainInterleaving();
    const other = buildSlideSemanticGroups([{ id: 'mechanisms', text: '两种机制：扩散、传导。' }])[0]!;
    const otherOverview: SlideSemanticItem = { id: 'mechanism-overview', text: '两种机制：扩散、传导。', sourceContentIds: ['mechanisms'],
      semanticBindings: [{ groupId: other.id, role: 'overview' }] };
    content.displayItems.push(otherOverview);
    content.elements.push(text('other-heading', otherOverview.text, 376, 166, 560, 48));
    content.contentBindings.push({ sourceContentId: otherOverview.id, elementId: 'other-heading' });
    expect(nativeSemanticVisualIssues(content, [...groups, other])).toContainEqual(expect.stringContaining('equally styled member text sections'));
  });

  it('checks compiled text and actual binding targets instead of trusting complete overview metadata', () => {
    const content = native([overview], [{ item: overview, left: 60, top: 110, width: 880, height: 64 }]);
    const element = content.elements[0]!;
    if (element.type !== 'text') throw new Error('text fixture expected');
    element.content = '<p>情境、协作、意义建构</p>';
    expect(nativeSemanticVisualIssues(content, groups)).toContainEqual(expect.stringContaining('会话 is not visible'));
    content.contentBindings[0]!.elementId = 'missing';
    expect(nativeSemanticVisualIssues(content, groups)).toHaveLength(4);
  });

  it('preserves inline emphasis readability and has no effect on pages without an explicit group', () => {
    const content = native([overview], [{ item: overview, left: 60, top: 110, width: 880, height: 64 }]);
    const element = content.elements[0]!;
    if (element.type !== 'text') throw new Error('text fixture expected');
    element.content = '<p>情境、协作、<strong>会</strong>话、意义建构</p>';
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
    expect(nativeSemanticBindingIssues([{ ...overview, semanticBindings: 'broken' }], []))
      .toContainEqual(expect.stringContaining('Invalid semantic bindings'));
    expect(nativeSemanticBindingIssues([overview], [])).toContainEqual(expect.stringContaining('Unknown semantic group'));
    expect(nativeSemanticBindingIssues([{ ...overview, semanticBindings: undefined }], [])).toEqual([]);
    expect(nativeSemanticVisualIssues(content, [])).toEqual([]);
  });

  it.each(['display:none', 'visibility:hidden', 'font-size:0px', 'opacity:0', 'color:transparent'])
  ('does not accept hidden member names styled %s as actual visible group evidence', (style) => {
    const content = native([overview], [{ item: overview, left: 60, top: 110, width: 880, height: 64 }]);
    const element = content.elements[0]!;
    if (element.type !== 'text') throw new Error('text fixture expected');
    element.content = `<p style="${style};">情境、协作、会话、意义建构</p>`;
    expect(nativeSemanticVisualIssues(content, groups)).toHaveLength(4);
  });
});
