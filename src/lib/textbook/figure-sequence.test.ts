import { describe, expect, it } from 'vitest';
import { extractFigureSequence, extractOrderedSourceSequences } from './figure-sequence';

describe('ordered steps anchored to a textbook figure', () => {
  it('recovers the sixth project-teaching stage beyond a retrieved chunk boundary', () => {
    const blocks = [
      ['248', 248, '1. 选择项目'], ['249', 249, '确定项目主题。'],
      ['250', 250, '2. 制定计划'], ['251', 251, '明确分工与进度。'],
      ['252', 252, '3. 活动探究'], ['253', 253, '围绕问题探究。'],
      ['254', 254, '4. 制作作品'], ['255', 255, '形成项目作品。'],
      ['256', 256, '5. 成果交流'], ['257', 257, '展示项目成果。'],
      ['258', 258, '6. 活动评价'], ['259', 259, '评价项目成果和过程。'],
    ] as const;
    const steps = extractFigureSequence(blocks.map(([id, position, content]) => ({
      id, position, content, blockType: 'PARAGRAPH',
    })));
    expect(steps.map((step) => step.label)).toEqual([
      '选择项目', '制定计划', '活动探究', '制作作品', '成果交流', '活动评价',
    ]);
    expect(steps[5]).toMatchObject({ sourceBlockId: '258', excerptBlockId: '259' });
  });

  it('stops at the next figure or section rather than importing unrelated steps', () => {
    expect(extractFigureSequence([
      { id: '1', position: 1, blockType: 'PARAGRAPH', content: '1. 选择项目' },
      { id: '2', position: 2, blockType: 'PARAGRAPH', content: '2. 制定计划' },
      { id: '3', position: 3, blockType: 'CAPTION', content: '图 33 教学支架' },
      { id: '4', position: 4, blockType: 'PARAGRAPH', content: '3. 无关内容' },
    ]).map((step) => step.label)).toEqual(['选择项目', '制定计划']);
  });

  it('also recovers a numbered source list when no illustration exists', () => {
    const blocks = ['1. 确定问题', '观察问题', '2. 收集证据', '核对证据',
      '3. 形成结论', '解释结论'].map((content, index) => ({
      id: `b-${index}`, position: index, blockType: 'PARAGRAPH', content,
    }));
    expect(extractOrderedSourceSequences(blocks)).toEqual([{
      anchorSourceBlockId: 'b-0', steps: [
        { label: '确定问题', sourceBlockId: 'b-0', excerpt: '观察问题', excerptBlockId: 'b-1' },
        { label: '收集证据', sourceBlockId: 'b-2', excerpt: '核对证据', excerptBlockId: 'b-3' },
        { label: '形成结论', sourceBlockId: 'b-4', excerpt: '解释结论', excerptBlockId: 'b-5' },
      ],
    }]);
  });

  it('keeps an entire inline step explanation instead of cutting it at an arbitrary character count', () => {
    const explanation = '说明'.repeat(200);
    const steps = extractOrderedSourceSequences([
      { id: '1', position: 1, blockType: 'LIST_ITEM', content: `1. 确定问题：${explanation}` },
      { id: '2', position: 2, blockType: 'LIST_ITEM', content: '2. 形成结论：依据证据解释' },
    ]);
    expect(steps[0]?.steps[0]?.excerpt).toBe(explanation);
    expect(steps[0]?.steps[1]?.label).toBe('形成结论');
  });

  it('keeps parent phases and each nested advice list separate', () => {
    const contents = [
      '1. 设计阶段',
      '(1)认真选择教学内容。说明设计内容。',
      '(2)注意知识与实践的平衡。说明平衡。',
      '(3)注意活动整体性。说明活动。',
      '(4)将信息技术作为认知工具。说明工具。',
      '2. 实施阶段',
      '(1)监督和调整项目过程。说明监督。',
      '(2)合理安排小组分工。说明分工。',
      '3. 评价阶段',
      '(1)明确项目评价标准。说明标准。',
      '(2)评价学习过程。说明过程。',
      '(3)关注作品背后的知识与思考。说明思考。',
    ];
    const sequences = extractOrderedSourceSequences(contents.map((content, position) => ({
      id: `b-${position}`, position, blockType: 'PARAGRAPH', content,
    })));
    expect(sequences.map((sequence) => sequence.steps.map((step) => step.label))).toEqual([
      ['设计阶段', '实施阶段', '评价阶段'],
      ['认真选择教学内容', '注意知识与实践的平衡', '注意活动整体性', '将信息技术作为认知工具'],
      ['监督和调整项目过程', '合理安排小组分工'],
      ['明确项目评价标准', '评价学习过程', '关注作品背后的知识与思考'],
    ]);
    expect(sequences[0]?.steps.every((step) => !step.excerpt)).toBe(true);
  });

  it('recognizes full-width numbered markers while preserving the source wording', () => {
    expect(extractFigureSequence([
      { id: '1', position: 1, blockType: 'PARAGRAPH', content: '（１）确定问题：观察、提问。' },
      { id: '2', position: 2, blockType: 'PARAGRAPH', content: '（２）形成结论：整理、解释。' },
    ])).toEqual([
      { label: '确定问题', sourceBlockId: '1', excerpt: '观察、提问。', excerptBlockId: '1' },
      { label: '形成结论', sourceBlockId: '2', excerpt: '整理、解释。', excerptBlockId: '2' },
    ]);
  });
});
