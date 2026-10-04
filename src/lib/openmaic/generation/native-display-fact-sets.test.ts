import { describe, expect, it } from 'vitest';
import type { PPTTableElement, PPTTextElement } from '@openmaic/dsl';
import { buildNativeDisplayFactSets, nativeDisplayFactItemIssues, nativeDisplayFactVisualIssues } from './native-display-fact-sets';
import { buildSlideSemanticGroups, nativeSemanticBindingIssues, nativeSemanticVisualIssues } from './slide-semantic-hierarchy';

const source = (text: string, id = 'adopted-1') => ({ id, text });
const textElement = (id: string, content: string): PPTTextElement => ({ id, type: 'text', left: 60, top: 120,
  width: 600, height: 100, rotate: 0, defaultFontName: 'Noto Sans SC', defaultColor: '#334155', content });
const item = (id: string, text: string, sourceContentIds = ['adopted-1']) => ({ id, text, sourceContentIds });

describe('native page-owned necessary fact sets', () => {
  it('extracts the last explicit complete object list without treating earlier comma-separated reasoning as a list', () => {
    const sources = [source('意义建构：分析目标，提炼“主题”，围绕主题设计学习活动、资源和环境。')];
    const before = structuredClone(sources);
    expect(buildNativeDisplayFactSets(sources)).toEqual([{ sourceContentId: 'adopted-1', terms: ['学习活动', '资源', '环境'],
      acceptedForms: { 学习活动: ['学习活动', '活动'] } }]);
    expect(sources).toEqual(before);
  });

  it.each([
    ['实验方案包括量筒、烧杯和温度计。', ['量筒', '烧杯', '温度计']],
    ['能量来源：糖类、脂肪以及蛋白质。', ['糖类', '脂肪', '蛋白质']],
    ['研究需要实验材料、记录工具和测量设备。', ['实验材料', '记录工具', '测量设备']],
    ['样本由岩石、土壤和矿物组成。', ['岩石', '土壤', '矿物']],
    ['检测需要DNA、RNA和ATP。', ['DNA', 'RNA', 'ATP']],
  ])('recognizes explicit complete lists in other subjects: %s', (text, terms) => {
    expect(buildNativeDisplayFactSets([source(text)])[0]?.terms).toEqual(terms);
  });

  it.each([
    '例如设计活动、资源和环境。',
    '方案包括但不限于活动、资源和环境。',
    '材料：铜片、铝片等金属。',
    '任选量筒、烧杯和温度计。',
    '方案包括活动、资源或环境。',
    '分析目标，提炼主题，确定方案。',
    '学习环境与资源：学习单、多媒体资料、应用和程序支持自主学习。',
    '教师作为组织者、指导者、帮助者和促进者支持学习。',
  ])('does not promote open examples or ordinary prose to a complete fact set: %s', (text) => {
    expect(buildNativeDisplayFactSets([source(text)])).toEqual([]);
  });

  it('keeps separate adopted source ownership for identical vocabulary', () => {
    const sets = buildNativeDisplayFactSets([source('方案设计活动、资源和环境。')]);
    const items = [item('claim', '设计活动和环境。'), item('other', '资源。', ['adopted-2'])];
    expect(nativeDisplayFactItemIssues(items, sets)).toEqual([expect.stringContaining('adopted-1 omits required term 资源')]);
    expect(nativeDisplayFactItemIssues([item('claim', '设计活动、资源和环境。')], sets)).toEqual([]);
  });

  it('accepts only finite role-name shortening, not guessed synonyms', () => {
    const sets = buildNativeDisplayFactSets([source('方案设计学习活动、资源和环境。')]);
    expect(nativeDisplayFactItemIssues([item('claim', '活动、资源与环境。')], sets)).toEqual([]);
    expect(nativeDisplayFactItemIssues([item('claim', '实践、材料与场所。')], sets)).toHaveLength(3);
    const competing = buildNativeDisplayFactSets([source('方案设计学习活动、教学活动和实验材料。')]);
    expect(competing[0]!.acceptedForms).not.toHaveProperty('学习活动');
    expect(competing[0]!.acceptedForms).not.toHaveProperty('教学活动');
    expect(nativeDisplayFactItemIssues([item('claim', '活动、实验材料。')], competing)).toHaveLength(2);
  });

  it('can aggregate split body items only when they retain the same source responsibility', () => {
    const sets = buildNativeDisplayFactSets([source('方案包括量筒、烧杯和温度计。')]);
    expect(nativeDisplayFactItemIssues([item('one', '量筒。'), item('two', '烧杯和温度计。')], sets)).toEqual([]);
  });

  it('delegates an exact counted group to member aggregation instead of forcing its count-only overview to repeat all names', () => {
    const sources = [source('三类材料：金属、塑料和木材。'), source('金属：导电材料。', 'adopted-2'),
      source('塑料：绝缘材料。', 'adopted-3'), source('木材：天然材料。', 'adopted-4')];
    const groups = buildSlideSemanticGroups(sources), group = groups[0]!;
    const items = [{ ...item('overview', '三类材料。'), semanticBindings: [{ groupId: group.id, role: 'overview' as const }] },
      ...group.members.map((member, index) => ({ ...item(`member-${index}`, member.label, [`adopted-${index + 2}`]),
        semanticBindings: [{ groupId: group.id, role: 'member' as const, memberId: member.id }] }))];
    const content = { elements: items.map((entry, index) => ({ ...textElement(entry.id, `<p>${entry.text}</p>`), top: 60 + index * 100, height: 60 })),
      displayItems: items, contentBindings: items.map((entry) => ({ sourceContentId: entry.id, elementId: entry.id })) };
    const sets = buildNativeDisplayFactSets(sources);
    expect(sets).toEqual([]);
    expect(nativeDisplayFactItemIssues(items, sets)).toEqual([]);
    expect(nativeDisplayFactVisualIssues(content, sets)).toEqual([]);
    expect(nativeSemanticBindingIssues(items, groups)).toEqual([]);
    expect(nativeSemanticVisualIssues(content, groups)).toEqual([]);
  });

  it('preserves separate Latin words without accepting a term embedded in another identifier', () => {
    const sets = buildNativeDisplayFactSets([source('检测需要DNA、RNA和ATP。')]);
    expect(nativeDisplayFactItemIssues([item('claim', 'DNA RNA ATP')], sets)).toEqual([]);
    expect(nativeDisplayFactItemIssues([item('claim', 'DNA mRNA ATP')], sets)).toEqual([expect.stringContaining('required term RNA')]);
  });

  it('checks compiled body copy rather than the complete display-item metadata or another visible source', () => {
    const sets = buildNativeDisplayFactSets([source('方案设计活动、资源和环境。')]);
    const content = { elements: [textElement('body', '<p>活动与环境。</p>'), textElement('other', '<p>资源。</p>')],
      displayItems: [item('claim', '活动、资源和环境。'), item('other-item', '资源。', ['adopted-2'])],
      contentBindings: [{ sourceContentId: 'claim', elementId: 'body' }, { sourceContentId: 'other-item', elementId: 'other' }] };
    const before = structuredClone(content);
    expect(nativeDisplayFactItemIssues(content.displayItems, sets)).toEqual([]);
    expect(nativeDisplayFactVisualIssues(content, sets)).toEqual([expect.stringContaining('资源 in its actual bound body slots')]);
    expect(content).toEqual(before);
  });

  it('does not borrow a label helper or hidden off-canvas text as body coverage', () => {
    const sets = buildNativeDisplayFactSets([source('方案设计活动、资源和环境。')]);
    const content = { elements: [textElement('body', '<p>活动与环境。</p>'), textElement('label', '<p>资源。</p>'),
      { ...textElement('off-canvas', '<p>资源。</p>'), left: 1100 }, textElement('hidden', '<p style="display:none">资源。</p>')],
      displayItems: [item('claim', '活动、资源和环境。')], contentBindings: [
        { sourceContentId: 'claim', elementId: 'body' }, { sourceContentId: 'claim:label', elementId: 'label' },
        { sourceContentId: 'claim', elementId: 'off-canvas' }, { sourceContentId: 'claim', elementId: 'hidden' }] };
    expect(nativeDisplayFactVisualIssues(content, sets)).toHaveLength(1);
  });

  it('reads rich native text, shape text and resolved paragraph bodies through real bindings', () => {
    const sets = buildNativeDisplayFactSets([source('方案设计学习活动、资源和环境。')]);
    const content = { elements: [textElement('body', '<p><strong>活动</strong>、资<strong>源</strong>和环境。</p>')],
      displayItems: [item('claim', '活动、资源和环境。')], contentBindings: [{ sourceContentId: 'claim', elementId: 'body' }] };
    expect(nativeDisplayFactVisualIssues(content, sets)).toEqual([]);
    const shape = { id: 'shape', type: 'shape' as const, left: 60, top: 120, width: 600, height: 100, rotate: 0,
      path: 'M0 0H600V100H0Z', viewBox: [600, 100] as [number, number], fill: '#EFF6FF', fixedRatio: false,
      text: { content: '<p>活动、资源和环境。</p>', defaultFontName: 'Noto Sans SC', defaultColor: '#334155', align: 'top' as const } };
    expect(nativeDisplayFactVisualIssues({ ...content, elements: [shape], contentBindings: [{ sourceContentId: 'claim', elementId: 'shape' }] }, sets)).toEqual([]);
  });

  it('respects real table-cell and quote selectors rather than neighboring words', () => {
    const sets = buildNativeDisplayFactSets([source('方案设计活动、资源和环境。')]);
    const table: PPTTableElement = { id: 'table', type: 'table', left: 60, top: 120, width: 600, height: 100, rotate: 0,
      colWidths: [0.5, 0.5], rowHeights: [100], cellMinHeight: 50, outline: { width: 1, style: 'solid', color: '#334155' },
      data: [[{ id: 'claim-cell', text: '活动与环境', colspan: 1, rowspan: 1 }, { id: 'other-cell', text: '资源', colspan: 1, rowspan: 1 }]] };
    const content = { elements: [table], displayItems: [item('claim', '活动、资源和环境。')],
      contentBindings: [{ sourceContentId: 'claim', elementId: 'table', selector: { cellId: 'claim-cell' } }] };
    expect(nativeDisplayFactVisualIssues(content, sets)).toHaveLength(1);
    expect(nativeDisplayFactVisualIssues({ ...content, contentBindings: [{ sourceContentId: 'claim', elementId: 'table', selector: { cellId: 'missing' } }] }, sets)).toHaveLength(3);
    expect(nativeDisplayFactVisualIssues({ ...content, contentBindings: [{ sourceContentId: 'claim', elementId: 'table', selector: { rowIndex: 0 } }] }, sets)).toEqual([]);
    const quote = { elements: [textElement('body', '<p>活动与环境。资源只是另一个说明。</p>')], displayItems: content.displayItems,
      contentBindings: [{ sourceContentId: 'claim', elementId: 'body', selector: { quote: '活动与环境。' } }] };
    expect(nativeDisplayFactVisualIssues(quote, sets)).toHaveLength(1);
  });
});
