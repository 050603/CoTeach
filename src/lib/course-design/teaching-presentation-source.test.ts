import { describe, expect, it } from 'vitest';
import type { TeachingBlueprintPage } from '@/lib/session/types';
import { compileTeachingContentParts, compileTeachingPresentationItems, resolveAdoptedContinuationPresentationNodeIds,
  resolveTeachingPageKeyPointRefs, resolveTeachingPagePartRefs } from './teaching-presentation-source';

function resolve(quote: string, content = '物质受热后体积通常会增大，但具体变化取决于材料和温度范围。若升温达到材料的相变条件，就可能发生相变。') {
  return resolveTeachingPageKeyPointRefs([{ nodeId: 'n', quote }], {
    nodes: [{ id: 'n', content, knowledgePointIds: ['kp'] }],
    allowedNodeIds: new Set(['n']), confirmedLabelsByKnowledgePointId: new Map(),
  });
}

describe('saved visual continuation presentation references', () => {
  const nodes = [
    { id: 'taught', content: '样本长度为1.25米。' },
    { id: 'unexecuted', content: '这条内容只存在于单元内部。' },
    { id: 'future', content: '后页才建立的判断。' },
  ];
  function adoptedPage(overrides: Partial<TeachingBlueprintPage> = {}): TeachingBlueprintPage {
    return { id: 'prior', title: '观察样本', type: 'slide', unitIds: ['unit'], knowledgePointIds: ['kp'],
      description: '先理解样本条件', keyPoints: ['样本长度为1.25米'], teachingObjective: '识别样本特征',
      sectionPlanVersion: 'accepted-plan', sourcePageIds: ['original-source-page'],
      introducesNodeIds: ['taught'], deepensNodeIds: [], referencesNodeIds: [],
      plannedTiming: { role: 'teaching', narrationSec: 20, transitionSec: 0, learnerActivitySec: 0 },
      teachingBrief: { schemaVersion: 1, explanation: nodes[0]!.content, examples: [], conditions: [], evidence: [], assessmentFocus: '理解样本条件',
        teachingPlan: { purpose: '理解样本', priorKnowledge: '', newContent: nodes[0]!.content,
          learnerQuestion: '', reasoningSteps: [], takeaway: '样本条件', visibleContent: [nodes[0]!.content], narrationFocus: [nodes[0]!.content] } },
      ...overrides };
  }
  function continuation(): TeachingBlueprintPage {
    return adoptedPage({ id: 'visual-continuation', introducesNodeIds: [], deepensNodeIds: [], referencesNodeIds: [] });
  }

  it('allows accurate display based on the earlier adopted source sibling without changing teaching ownership', () => {
    const prior = adoptedPage();
    const page = continuation();
    const before = structuredClone([prior, page]);
    const allowed = resolveAdoptedContinuationPresentationNodeIds(page, [prior], nodes);
    expect(allowed).toEqual(['taught']);
    expect(compileTeachingPresentationItems([{ text: '样本长度：1.25米', nodeIds: ['taught'], role: 'case-observation' }], {
      nodes, allowedNodeIds: new Set(allowed),
    }).issues).toEqual([]);
    expect([prior, page]).toEqual(before);
  });

  it.each(['plan', 'source-page', 'unit', 'brief', 'timing'] as const)
    ('rejects a prior page with a different or incomplete %s', (mismatch) => {
      const prior = adoptedPage();
      if (mismatch === 'plan') prior.sectionPlanVersion = 'different-plan';
      if (mismatch === 'source-page') prior.sourcePageIds = ['unrelated-origin'];
      if (mismatch === 'unit') prior.unitIds = ['another-unit'];
      if (mismatch === 'brief') prior.teachingBrief = undefined;
      if (mismatch === 'timing') prior.plannedTiming = undefined;
      expect(resolveAdoptedContinuationPresentationNodeIds(continuation(), [prior], nodes)).toEqual([]);
    });

  it('never borrows an unexecuted unit node, a reference-only node or a future deepening', () => {
    const prior = adoptedPage({ referencesNodeIds: ['unexecuted'], deepensNodeIds: ['future'] });
    const allowed = resolveAdoptedContinuationPresentationNodeIds(continuation(), [prior], nodes);
    expect(allowed).toEqual(['taught']);
    for (const nodeId of ['unexecuted', 'future']) {
      expect(compileTeachingPresentationItems([{ text: '未建立的判断', nodeIds: [nodeId], role: 'key-point' }], {
        nodes, allowedNodeIds: new Set(allowed),
      }).issues).toHaveLength(1);
    }
  });

  it('does not supply continuation citations to a new page or an already assigned teaching page', () => {
    expect(resolveAdoptedContinuationPresentationNodeIds(continuation(), [], nodes)).toEqual([]);
    expect(resolveAdoptedContinuationPresentationNodeIds(adoptedPage(), [adoptedPage({ id: 'earlier' })], nodes)).toEqual([]);
    expect(resolveAdoptedContinuationPresentationNodeIds({ ...continuation(), sectionPlanVersion: undefined }, [adoptedPage()], nodes)).toEqual([]);
  });
});

describe('independent presentation authoring', () => {
  const nodes = [
    { id: 'meaning', content: '缓存一致性是同一数据存在多个副本时，使各副本遵守既定更新和读取规则的机制。', knowledgePointIds: ['kp'] },
    { id: 'boundary', content: '各副本不要求立即更新，但必须符合系统采用的一致性规则。', knowledgePointIds: ['kp'] },
  ];
  const sources = { nodes, allowedNodeIds: new Set(nodes.map((node) => node.id)) };

  it('allows grouped slide wording without copying the full definition or weakening its boundary', () => {
    const items = [
      { text: '缓存一致性', nodeIds: ['meaning'], role: 'heading' },
      { text: '共同规则：多个副本按既定规则更新与读取', nodeIds: ['meaning'], role: 'key-point' },
      { text: '更新时间可不同；遵守一致性规则', nodeIds: ['meaning', 'boundary'], role: 'comparison' },
    ];
    const before = structuredClone(nodes);
    expect(compileTeachingPresentationItems(items, sources)).toEqual({
      keyPoints: items.map((item) => item.text), presentationItems: items, issues: [],
    });
    expect(nodes).toEqual(before);
    expect(items[1]!.text).not.toBe(nodes[0]!.content);
  });

  it.each([
    { text: '新事实', nodeIds: ['future'], role: 'key-point' },
    { text: '没有关联', nodeIds: [], role: 'key-point' },
    { text: '', nodeIds: ['meaning'], role: 'heading' },
    { text: '未知排版', nodeIds: ['meaning'], role: 'template' },
    { text: '缺少关联', role: 'key-point' },
  ])('rejects invalid ownership or structure without replacing the text: %j', (item) => {
    expect(compileTeachingPresentationItems([item], sources).issues).toHaveLength(1);
  });

  it('rejects a node that exists but has not actually been taught or owned on the page', () => {
    expect(compileTeachingPresentationItems([{ text: '规则边界', nodeIds: ['boundary'], role: 'key-point' }], {
      ...sources, allowedNodeIds: new Set(['meaning']),
    }).issues).toHaveLength(1);
  });

  it('does not borrow an unrelated negation when displaying the next independently true clause', () => {
    expect(compileTeachingPresentationItems([{ text: '读取必须遵守既定规则', nodeIds: ['node'], role: 'key-point' }], {
      nodes: [{ id: 'node', content: '副本并不要求立即更新，但读取必须遵守既定规则。' }], allowedNodeIds: new Set(['node']),
    }).issues).toEqual([]);
  });

  it.each([
    ['身体参与认知。', '身体不参与认知'],
    ['身体不参与认知。', '身体参与认知'],
    ['材料发生相变。', '材料不发生相变'],
    ['材料不发生相变。', '材料发生相变'],
    ['核心命题：身体参与认知。身体运动不等于认知已经改变。', '身体的作用：身体不参与认知'],
    ['身体参与认知。', '核心认识｜身体不参与认知'],
    ['材料不发生相变。', '观察结论 | 材料发生相变'],
  ])('rejects an inverted short core proposition without requiring a long slide sentence: %s / %s', (original, changed) => {
    expect(compileTeachingPresentationItems([{ text: changed, nodeIds: ['node'], role: 'key-point' }], {
      nodes: [{ id: 'node', content: original }], allowedNodeIds: new Set(['node']),
    }).issues.join(';')).toContain('否定关系');
  });

  it.each([
    ['身体参与认知，不只是课堂外的运动。', '身体参与认知'],
    ['材料不发生相变，体积发生变化。', '体积发生变化'],
    ['身体不参与这个无关的故事叙述。', '身体参与认知'],
    ['当前材料不发生相变；另一材料发生相变。', '材料发生相变'],
  ])('does not borrow polarity from an unrelated clause or a differently scoped short claim: %s / %s', (original, display) => {
    expect(compileTeachingPresentationItems([{ text: display, nodeIds: ['node'], role: 'key-point' }], {
      nodes: [{ id: 'node', content: original }], allowedNodeIds: new Set(['node']),
    }).issues).toEqual([]);
  });

  it('keeps source quantity identity across Chinese and Arabic slide notation', () => {
    const source = { nodes: [{ id: 'case', content: '牛有两只角、四条腿，样本长度为1.25米。' }], allowedNodeIds: new Set(['case']) };
    expect(compileTeachingPresentationItems([{ text: '观察牛的特征：2只角、4条腿', nodeIds: ['case'], role: 'case-observation' }], source).issues).toEqual([]);
    for (const changed of ['观察牛的特征：2只角、6条腿', '样本长度：1.5米']) {
      expect(compileTeachingPresentationItems([{ text: changed, nodeIds: ['case'], role: 'case-observation' }], source).issues.join(';'))
        .toContain('数量或单位');
    }
  });

  it('does not compare the number of design stages with the number of starting points', () => {
    const source = '教学设计步骤依次是教学目标分析、情境创设、信息资源设计、自主学习设计、协作学习环境设计、学习效果评价设计和强化练习设计。这套步骤从一个起点出发，后面的环节围绕核心主题展开。';
    const nodes = [{ id: 'design', content: source }];
    for (const display of ['七个环节与它们的顺序', '七个设计环节的完整名称与先后顺序']) {
      expect(compileTeachingPresentationItems([{ text: display, nodeIds: ['design'], role: 'heading' }], {
        nodes, allowedNodeIds: new Set(['design']),
      }).issues).toEqual([]);
    }
  });

  it('aligns counts with their own object even when two source counts share a classifier', () => {
    const source = { nodes: [{ id: 'components', content: '系统包含四个要素和两个用途。四个核心要素与两个辅助要素各有职责。' }],
      allowedNodeIds: new Set(['components']) };
    const display = '4个要素、2个用途；4个核心要素、2个辅助要素';
    expect(compileTeachingPresentationItems([{ text: display, nodeIds: ['components'], role: 'comparison' }], source).issues).toEqual([]);
    for (const changed of ['2个要素、4个用途', '2个核心要素、4个辅助要素']) {
      expect(compileTeachingPresentationItems([{ text: changed, nodeIds: ['components'], role: 'comparison' }], source).issues.join(';'))
        .toContain('数量或单位');
    }
  });

  it('keeps an ordinal step label separate from the complete process count', () => {
    const source = { nodes: [{ id: 'process', content: '处理流程共有4步：接收、校验、处理和记录。第一步是接收输入。' }],
      allowedNodeIds: new Set(['process']) };
    expect(compileTeachingPresentationItems([{ text: '4步流程：接收 → 校验 → 处理 → 记录', nodeIds: ['process'], role: 'process-label' }], source).issues).toEqual([]);
    expect(compileTeachingPresentationItems([{ text: '1步流程', nodeIds: ['process'], role: 'process-label' }], source).issues.join(';')).toContain('数量或单位');
  });

  it.each([
    ['样品受热后体积通常会增大。', '样品受热后体积会增大', '通常'],
    ['测试集不能参与模型参数学习。', '测试集参与模型参数学习', '否定关系'],
    ['同化不根本改变已有认知结构。', '同化不改变已有认知结构', '根本'],
  ])('rejects an explicit qualifier or negation change in a close restatement', (original, changed, reason) => {
    expect(compileTeachingPresentationItems([{ text: changed, nodeIds: ['node'], role: 'key-point' }], {
      nodes: [{ id: 'node', content: original }], allowedNodeIds: new Set(['node']),
    }).issues.join(';')).toContain(reason);
  });
});

describe('first-authored presentation source references', () => {
  it('authors conditional facts once and selects stable part IDs without reproducing text', () => {
    const parts = [{ id: 'core', text: '升温达到材料的相变条件时，材料可能发生相变。' },
      { id: 'detail', text: '相变还取决于具体材料、压力和温度范围。' }];
    const compiled = compileTeachingContentParts(parts);
    expect(compiled).toEqual({ content: parts.map((part) => part.text).join(' '), parts, issues: [] });
    const result = resolveTeachingPagePartRefs([{ nodeId: 'n', partIds: ['core'] }], {
      nodes: [{ id: 'n', content: compiled.content, knowledgePointIds: ['kp'] }],
      allowedNodeIds: new Set(['n']), contentPartsByNodeId: new Map([['n', compiled.parts]]),
    });
    expect(result).toEqual({ keyPoints: [parts[0]!.text], issues: [] });
    expect(parts[0]!.text).toContain('达到材料的相变条件');
  });

  it('retains original part order for multiple conditions and independent list entries', () => {
    const parts = [{ id: 'premise', text: '测试集未参与模型参数学习。' },
      { id: 'conclusion', text: '测试结果用于独立评价，不能回流调参。' },
      { id: 'independent', text: '另一套资源分发流程另行核对文件版本。' }];
    const result = resolveTeachingPagePartRefs([{ nodeId: 'n', partIds: ['conclusion', 'premise'] },
      { nodeId: 'n', partIds: ['independent'] }], {
      nodes: [{ id: 'n', content: parts.map((part) => part.text).join(' '), knowledgePointIds: ['kp'] }],
      allowedNodeIds: new Set(['n']), contentPartsByNodeId: new Map([['n', parts]]),
    });
    expect(result).toEqual({ keyPoints: [`${parts[0]!.text} ${parts[1]!.text}`, parts[2]!.text], issues: [] });
  });

  it('allows the same stable part name in different owning nodes', () => {
    const nodes = [{ id: 'n1', content: '输入版本必须匹配。', knowledgePointIds: ['kp1'] },
      { id: 'n2', content: '输出依据独立目标评价。', knowledgePointIds: ['kp2'] }];
    expect(resolveTeachingPagePartRefs(nodes.map((node) => ({ nodeId: node.id, partIds: ['core'] })), {
      nodes, allowedNodeIds: new Set(nodes.map((node) => node.id)),
      contentPartsByNodeId: new Map(nodes.map((node) => [node.id, [{ id: 'core', text: node.content }]])),
    })).toEqual({ keyPoints: nodes.map((node) => node.content), issues: [] });
  });

  it.each([undefined, [], [{ id: 'core' }], [{ id: 'core', text: '事实。' }, { id: 'core', text: '另一个事实。' }]])
    ('rejects incomplete or duplicate source parts instead of borrowing a second body: %j', (parts) => {
      expect(compileTeachingContentParts(parts).issues).toHaveLength(1);
    });

  it.each([{ nodeId: 'n', partIds: ['missing'] }, { nodeId: 'missing', partIds: ['core'] },
    { nodeId: 'n', quote: '第二份文字。' }, { nodeId: 'n', partIds: [] }])
    ('rejects invalid part references without silently copying free display text: %j', (ref) => {
      expect(resolveTeachingPagePartRefs([ref], { nodes: [{ id: 'n', content: '事实。', knowledgePointIds: ['kp'] }],
        allowedNodeIds: new Set(['n']), contentPartsByNodeId: new Map([['n', [{ id: 'core', text: '事实。' }]]]),
      }).issues).toHaveLength(1);
    });

  it('does not borrow an unowned part merely because it exists in the source table', () => {
    expect(resolveTeachingPagePartRefs([{ nodeId: 'n', partIds: ['core'] }], {
      nodes: [{ id: 'n', content: '事实。', knowledgePointIds: ['kp'] }], allowedNodeIds: new Set<string>(),
      contentPartsByNodeId: new Map([['n', [{ id: 'core', text: '事实。' }]]]),
    }).issues).toHaveLength(1);
  });

  it('selects concise complete sentences and preserves the unselected full explanation', () => {
    const content = '缓存更新不要求立即改变所有副本，但各副本必须遵守既定一致性规则。系统也可能使用失效通知或回源读取等机制。';
    expect(resolve(content.split('。')[0]!, content)).toEqual({ keyPoints: [content.split('。')[0]!], issues: [] });
    expect(resolve(content, content)).toEqual({ keyPoints: [content], issues: [] });
  });

  it.each([
    '物质受热后体积会增大',
    '若升温达到材料的相变条件，才可能发生相变。',
    '就可能发生相变。',
    '物质受热后体积通常会增大',
  ])('does not create a new fact or drop a qualifier by selecting %s', (quote) => {
    expect(resolve(quote).keyPoints).toEqual([]);
    expect(resolve(quote).issues).toHaveLength(1);
  });

  it('selects the later complete conditional sentence without strengthening it', () => {
    const quote = '若升温达到材料的相变条件，就可能发生相变。';
    expect(resolve(quote)).toEqual({ keyPoints: [quote], issues: [] });
  });

  it('does not split quantities at decimal points', () => {
    const content = '样品长度为1.25米，允许误差为0.01米。';
    expect(resolve('样品长度为1.', content).issues).toHaveLength(1);
    expect(resolve(content, content).issues).toEqual([]);
  });

  it('retains source facts beyond old display substring limits', () => {
    const quote = `机制要同时保持${'每个独立分支的原始条件、数量和真实执行关系，'.repeat(35)}才能成立。`;
    expect(resolve(quote, quote)).toEqual({ keyPoints: [quote], issues: [] });
  });

  it('uses a source-confirmed list label only in its actually explained knowledge topic', () => {
    const sources = {
      nodes: [{ id: 'n', content: '第一项是隔离测试集，它保证评估数据不参与模型参数学习。第二项是锁定配置，它避免根据测试结果调整方案。', knowledgePointIds: ['kp'] }],
      allowedNodeIds: new Set(['n']),
      confirmedLabelsByKnowledgePointId: new Map([['kp', ['隔离测试集', '锁定配置']]]),
    };
    const refs = [{ nodeId: 'n', quote: '隔离测试集' }, { nodeId: 'n', quote: '锁定配置' }];
    expect(resolveTeachingPageKeyPointRefs(refs, sources)).toEqual({ keyPoints: ['隔离测试集', '锁定配置'], issues: [] });
    expect(resolveTeachingPageKeyPointRefs(refs, { ...sources,
      confirmedLabelsByKnowledgePointId: new Map([['other', ['隔离测试集', '锁定配置']]]),
    }).issues).toHaveLength(2);
    expect(resolveTeachingPageKeyPointRefs([{ nodeId: 'n', quote: '限制反馈' }], sources).issues).toHaveLength(1);
  });

  it('requires executable page ownership or an explicitly referenced taught node', () => {
    const sources = { nodes: [{ id: 'n', content: '测试集承担独立评估。', knowledgePointIds: ['kp'] }],
      allowedNodeIds: new Set<string>(), confirmedLabelsByKnowledgePointId: new Map<string, string[]>() };
    expect(resolveTeachingPageKeyPointRefs([{ nodeId: 'n', quote: sources.nodes[0]!.content }], sources).issues).toHaveLength(1);
  });

  it.each([undefined, [], [null], ['unowned text'], [{ nodeId: 'missing', quote: '完整句。' }]])
    ('keeps malformed references visible to the existing compiler: %j', (refs) => {
      const result = resolveTeachingPageKeyPointRefs(refs, { nodes: [], allowedNodeIds: new Set(),
        confirmedLabelsByKnowledgePointId: new Map() });
      expect(result.keyPoints).toEqual([]);
      expect(result.issues).toHaveLength(1);
    });
});
