import { describe, expect, it, vi } from 'vitest';
import type {
  TeachingBlueprint, TeachingBlueprintPage, TeachingBlueprintSection, TeachingBlueprintUnit,
} from '@/lib/session/types';
import type { TeachingBlueprintInput } from './teaching-blueprint';
import {
  buildTeachingPresentationRefreshPrompt, refreshTeachingPresentation, TeachingPresentationRefreshError,
} from './teaching-presentation-refresh';

function fixture(): { blueprint: TeachingBlueprint; input: TeachingBlueprintInput } {
  const unit: TeachingBlueprintUnit = {
    id: 'u1', title: '完整教学', knowledgePointIds: ['kp'], learningOutcome: '解释副本规则与完整处理流程',
    explanation: '缓存一致性使多个副本遵守既定更新和读取规则。', mechanism: '先校验，再处理。',
    workedExample: '读取一个未及时更新的副本时，依据系统规则决定是否回源。',
    conditions: ['各副本不要求立即更新。'], misconceptions: ['测试集不能参与模型参数学习。'],
    sourceKind: 'course-source', evidenceQuotes: ['完整原始教材描述。'],
    explanationNodes: [
      { id: 'meaning', kind: 'concept', content: '缓存一致性使多个副本遵守既定更新和读取规则。',
        knowledgePointIds: ['kp'], prerequisiteNodeIds: [], provenance: 'course-source' },
      { id: 'boundary', kind: 'condition', content: '各副本不要求立即更新。测试集不能参与模型参数学习。',
        knowledgePointIds: ['kp'], prerequisiteNodeIds: ['meaning'], provenance: 'course-source' },
      { id: 'flow', kind: 'mechanism', content: '处理流程包含4步：接收、校验、处理、记录，校验不能跳过。',
        knowledgePointIds: ['kp'], prerequisiteNodeIds: ['meaning'], provenance: 'course-source' },
    ],
  };
  const page: TeachingBlueprintPage = {
    id: 'p1', title: '副本规则', type: 'slide', unitIds: ['u1'], knowledgePointIds: ['kp'],
    description: '解释规则与限制', keyPoints: [unit.explanation], teachingObjective: '理解核心关系',
    introducesNodeIds: ['meaning', 'boundary'], deepensNodeIds: [], referencesNodeIds: [],
    sectionPlanVersion: 'adopted-capacity', sourcePageIds: ['original-p1'], targetDurationSec: 100,
    plannedTiming: { narrationSec: 95, learnerActivitySec: 0, transitionSec: 5, role: 'teaching' },
    teachingBrief: { schemaVersion: 1, designVersion: 'saved-version', explanation: unit.explanation,
      examples: [unit.workedExample], conditions: unit.conditions, evidence: [{ sourceId: 'textbook', quote: '完整原始教材描述。' }],
      assessmentFocus: '解释规则与条件',
      teachingPlan: { purpose: '理解规则', priorKnowledge: '', newContent: unit.explanation,
        learnerQuestion: '', reasoningSteps: [unit.mechanism], takeaway: '旧结论',
        visibleContent: [unit.explanation], presentationContent: [unit.explanation], narrationFocus: [unit.workedExample] } },
    caseObservation: { kind: 'source-image', resourceIds: ['figure'], imageWouldHelp: true,
      observableDifference: '副本更新时间不同', reason: '直接观察状态差异' },
    resourceNeeds: [{ assetId: 'figure', kind: 'image', purpose: '观察不同状态', required: true }],
  };
  const process: TeachingBlueprintPage = {
    ...page, id: 'p2', title: '完整处理流程', keyPoints: [unit.explanationNodes![2]!.content],
    introducesNodeIds: ['flow'], referencesNodeIds: ['meaning'], teachingBrief: undefined,
    visualRelationship: { kind: 'process', description: '四步按真实顺序推进', readingOrder: ['接收', '校验', '处理', '记录'],
      preferredForm: 'diagram', diagram: { topology: 'sequence', nodes: [
        { id: 'f1', label: '接收' }, { id: 'f2', label: '校验' }, { id: 'f3', label: '处理' }, { id: 'f4', label: '记录' },
      ], edges: [{ from: 'f1', to: 'f2' }, { from: 'f2', to: 'f3' }, { from: 'f3', to: 'f4' }], annotation: '校验不能跳过' } },
  };
  const interactive: TeachingBlueprintPage = { ...page, id: 'interactive', type: 'interactive',
    introducesNodeIds: [], referencesNodeIds: ['meaning'], widgetType: 'simulation' };
  const quiz = { ...page, id: 'quiz', type: 'quiz', introducesNodeIds: [] } as unknown as TeachingBlueprintPage;
  const section: TeachingBlueprintSection = {
    id: 's1', title: '第一节', order: 0, learningObjective: '理解机制', knowledgePointIds: ['kp'],
    sharedContext: { learningPurpose: '理解副本规则', caseId: '副本读取', caseFacts: ['采用同一系统条件'],
      fixedWording: [], conceptBoundaries: [], stableTerms: [] },
    units: [unit], pages: [page, process, interactive, quiz], assessmentFocus: ['理解条件'],
    understandingCriteria: { goals: ['解释条件'], answerEssentials: ['保留否定'], misconceptions: [], supportingUnitIds: ['u1'] },
    teachingDurationSec: 400, learnerActivityDurationSec: 0, assessmentDurationSec: 50,
  };
  const second: TeachingBlueprintSection = { ...structuredClone(section), id: 's2', title: '第二节', order: 1,
    knowledgePointIds: ['kp2'], units: [{ ...structuredClone(unit), id: 'u2', knowledgePointIds: ['kp2'],
      explanationNodes: [{ id: 'later', kind: 'concept', content: '这是后续新的知识。', knowledgePointIds: ['kp2'],
        prerequisiteNodeIds: ['meaning'], provenance: 'course-source' }] }],
    pages: [{ ...structuredClone(page), id: 'later-page', unitIds: ['u2'], knowledgePointIds: ['kp2'],
      introducesNodeIds: ['later'], referencesNodeIds: ['meaning'] }] };
  return {
    blueprint: { schemaVersion: 3, inputFingerprint: 'saved-input', createdAt: '2026-10-01T00:00:00Z',
      assessmentMode: 'adaptive', budget: { totalDurationSec: 900, teachingDurationSec: 800,
        learnerActivityDurationSec: 0, assessmentDurationSec: 100, teachingRatio: 8 / 9, assessmentRatio: 1 / 9 },
      sections: [section, second] },
    input: { courseTitle: '副本机制', subject: '信息科技', grade: '高中', learningObjectives: ['解释机制'],
      projectContext: '', knowledgePoints: [], totalDurationSec: 900, assessmentMode: 'adaptive', generationMode: 'standard',
      sourceContext: '实际采用的完整教材原文：缓存一致性、必要条件与接收—校验—处理—记录。',
      sourceConceptStatements: [{ knowledgePointId: 'kp', name: '缓存一致性', statements: [] }] },
  };
}

function response() {
  return { sections: [{ id: 's1', pages: [
    { id: 'p1', presentationItems: [
      { text: '共同规则：多个副本按既定规则更新与读取', nodeIds: ['meaning'], role: 'key-point' },
      { text: '更新时间可不同', nodeIds: ['boundary'], role: 'comparison' },
    ] },
    { id: 'p2', presentationItems: [
      { text: '4步流程：接收 → 校验 → 处理 → 记录', nodeIds: ['flow'], role: 'process-label' },
      { text: '校验不能跳过', nodeIds: ['flow'], role: 'key-point' },
    ] },
  ] }] };
}

describe('bounded saved-blueprint presentation refresh', () => {
  it('refreshes display only, preserves teaching, media, page order, unselected sections and adopted timing', async () => {
    const { blueprint, input } = fixture();
    const before = structuredClone(blueprint);
    const raw = JSON.stringify(response());
    const events: string[] = [];
    const aiCall = vi.fn(async () => { events.push('model'); return raw; });
    const refreshed = await refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'], aiCall,
      onPrompt: () => { events.push('prompt'); }, onResponse: (value) => { expect(value).toBe(raw); events.push('saved-response'); } });
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['prompt', 'model', 'saved-response']);
    expect(refreshed.refreshedPageIds).toEqual(['p1', 'p2']);
    expect(refreshed.validationScope).toBe('presentation-items-only');
    expect(refreshed.modelCalls).toBe(1);
    expect(blueprint).toEqual(before);
    const [section, second] = refreshed.candidate.sections;
    expect(section!.units).toEqual(before.sections[0]!.units);
    expect(second).toEqual(before.sections[1]);
    expect(section!.pages.slice(2)).toEqual(before.sections[0]!.pages.slice(2));
    const expected = structuredClone(before);
    for (const page of expected.sections[0]!.pages.slice(0, 2)) {
      const items = response().sections[0]!.pages.find((candidate) => candidate.id === page.id)!.presentationItems;
      page.presentationItems = items as NonNullable<TeachingBlueprintPage['presentationItems']>;
      page.keyPoints = items.map((item) => item.text);
      if (page.teachingBrief?.teachingPlan) {
        page.teachingBrief = { ...page.teachingBrief, teachingPlan: { ...page.teachingBrief.teachingPlan,
          presentationItems: structuredClone(page.presentationItems),
          presentationContent: [...page.keyPoints], visibleContent: [...page.keyPoints],
        } };
      }
    }
    expect(refreshed.candidate).toEqual(expected);
    expect(refreshed.candidate.sections[0]!.pages[1]!.visualRelationship!.diagram!.nodes).toHaveLength(4);
    expect(refreshed.candidate.sections[0]!.pages[0]!.teachingBrief!.designVersion).toBe('saved-version');
  });

  it('includes actual original sources, saved node ownership and structural references in the prompt', () => {
    const { blueprint, input } = fixture();
    const prompt = buildTeachingPresentationRefreshPrompt({ blueprint, input, sectionIds: ['s1'] });
    expect(prompt.user).toContain(input.sourceContext);
    expect(prompt.user).toContain(blueprint.sections[0]!.units[0]!.explanationNodes![2]!.content);
    expect(prompt.user).toContain('"allowedNodeIds":["flow","meaning"]');
    expect(prompt.user).not.toContain('这是后续新的知识');
    expect(prompt.user).not.toContain('"id":"interactive"');
    expect(prompt.system).toContain('已认可讲授课件的表达参考');
    expect(prompt.system).toContain('分别保留全部实际条目名称与真实顺序');
    expect(prompt.system).toContain('完整蓝图、来源和容量验收');
  });

  it('authors display by teaching role without turning full nodes into narrated slide paragraphs', () => {
    const { blueprint, input } = fixture();
    const prompt = buildTeachingPresentationRefreshPrompt({ blueprint, input, sectionIds: ['s1'] });
    expect(prompt.system).toContain('完整节点正文和原始资料是事实依据，不是待逐句上屏的清单');
    expect(prompt.system).toContain('nodeIds 是来源引用，不是逐句展示义务');
    expect(prompt.system).toContain('无需让每个 allowedNodeIds 节点各出现一段');
    expect(prompt.system).toContain('可让多个节点共同支撑一个结论或对比');
    expect(prompt.system).toContain('所有已有节点仍须完整讲授');
    expect(prompt.system).toContain('heading 是分组小标题；key-point 是本页核心结论');
    expect(prompt.system).toContain('comparison 是共同维度下的对应事实');
    expect(prompt.system).toContain('process-label 是实际步骤的标签');
    expect(prompt.system).toContain('case-observation 是需要学生观察的事实或问题提示');
    expect(prompt.system).toContain('也不把这些解释拆成连续多个 key-point 照读');
    expect(prompt.system).toContain('对所选展示命题保留准确的事实、数量、单位、否定、程度、必要条件和真实关系');
    expect(prompt.system).toContain('完整资料事实由已保存的完整教学正文与实际讲稿落实，不要求全文上屏');
    expect(prompt.system).toContain('分别保留全部实际条目名称与真实顺序');
    expect(prompt.system).toContain('图像与已有 visualRelationship 不允许改写');
    expect(prompt.system).toContain('不能成为硬上限、最低填充量');
    expect(prompt.system).not.toContain('保持所有已采用事实');
    expect(prompt.system).not.toContain('本页已采用的展示目录');
    expect(prompt.user).toContain('节点是事实与讲授依据，不是上屏清单');
    expect(prompt.user).toContain('支撑准确讲稿与所选展示命题，不要求整段上屏');
  });

  it('turns original sources into scannable concepts and observations without automatic complete-definition display', () => {
    const { blueprint, input } = fixture();
    const prompt = buildTeachingPresentationRefreshPrompt({ blueprint, input, sectionIds: ['s1'] });
    expect(prompt.system).toContain('PPT 不是完整阅读文本');
    expect(prompt.system).toContain('概念核心含义完整不等于定义段落完整');
    expect(prompt.system).toContain('不按每个节点摘段');
    expect(prompt.system).toContain('不用多个串联解释句组成要点');
    expect(prompt.system).toContain('不要用“定义＋为什么＋举例＋结论”的段落');
    expect(prompt.system).toContain('只有明确的完整原文阅读或定义措辞辨析任务才展示完整定义');
    expect(prompt.system).toContain('一般概念介绍与概念比较均不自动触发');
    expect(prompt.system).toContain('差异采用共同比较维度');
    expect(prompt.system).toContain('案例采用必要观察事实');
    expect(prompt.system).toContain('流程采用完整实际名称与真实连接');
    expect(prompt.system).toContain('资料 ⇒ 展示的抽象角色示例');
    expect(prompt.system).toContain('不能用减少字号、统一字数配额或删除必看流程、比较对象、案例条件来掩盖表达问题');
    expect(prompt.user).toContain(input.sourceContext);
  });

  it.each([
    ['6步流程：接收 → 校验 → 处理 → 记录', 'flow', '数量或单位'],
    ['测试集参与模型参数学习', 'boundary', '否定关系'],
    ['后页知识', 'later', '引用了本页未拥有'],
  ])('keeps a rejected response and original draft when %s violates the presentation contract', async (text, nodeId, reason) => {
    const { blueprint, input } = fixture();
    const before = structuredClone(blueprint);
    const changed = response();
    const target = nodeId === 'flow' ? changed.sections[0]!.pages[1]! : changed.sections[0]!.pages[0]!;
    target.presentationItems = [{ text, nodeIds: [nodeId], role: 'key-point' }];
    const raw = JSON.stringify(changed);
    const save = vi.fn();
    const aiCall = vi.fn(async () => raw);
    let caught: unknown;
    try { await refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'], aiCall, onResponse: save }); }
    catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(TeachingPresentationRefreshError);
    expect((caught as TeachingPresentationRefreshError).issues.join(';')).toContain(reason);
    expect((caught as TeachingPresentationRefreshError).rawResponse).toBe(raw);
    expect(save).toHaveBeenCalledWith(raw);
    expect(aiCall).toHaveBeenCalledTimes(1);
    expect(blueprint).toEqual(before);
  });

  it.each(['reorder', 'omit', 'new-page', 'rewrite-teaching'] as const)
    ('rejects %s rather than applying a partial or expanded page plan', async (change) => {
      const { blueprint, input } = fixture();
      const changed = response();
      if (change === 'reorder') changed.sections[0]!.pages.reverse();
      if (change === 'omit') changed.sections[0]!.pages.pop();
      if (change === 'new-page') changed.sections[0]!.pages[1]!.id = 'another';
      if (change === 'rewrite-teaching') Object.assign(changed.sections[0]!.pages[0]!, { explanationNodes: [{ content: '被改写正文' }] });
      const aiCall = vi.fn(async () => JSON.stringify(changed));
      await expect(refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'], aiCall }))
        .rejects.toBeInstanceOf(TeachingPresentationRefreshError);
      expect(aiCall).toHaveBeenCalledTimes(1);
    });

  it('saves unparseable output before validation, without another model attempt', async () => {
    const { blueprint, input } = fixture();
    const raw = '响应缺少可解析 JSON';
    const saved: string[] = [];
    const aiCall = vi.fn(async () => raw);
    const result = refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'], aiCall,
      onResponse: (response) => { saved.push(response); } });
    await expect(result).rejects.toMatchObject({ rawResponse: raw });
    expect(saved).toEqual([raw]);
    expect(aiCall).toHaveBeenCalledTimes(1);
  });

  it.each([{ sectionIds: [] }, { sectionIds: ['missing'] }, { sectionIds: ['s1', 's1'] }])
    ('rejects invalid scope %j before requesting a model', async ({ sectionIds }) => {
    const { blueprint, input } = fixture();
    const aiCall = vi.fn(async () => JSON.stringify(response()));
    await expect(refreshTeachingPresentation({ blueprint, input, sectionIds, aiCall }))
      .rejects.toBeInstanceOf(TeachingPresentationRefreshError);
    expect(aiCall).not.toHaveBeenCalled();
    });

  it('does not spend a model call or change a section containing only interactive and quiz pages', async () => {
    const { blueprint, input } = fixture();
    blueprint.sections[0]!.pages = blueprint.sections[0]!.pages.slice(2);
    const aiCall = vi.fn(async () => 'unused');
    const result = await refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'], aiCall });
    expect(result.candidate).toEqual(blueprint);
    expect(result.refreshedPageIds).toEqual([]);
    expect(result.modelCalls).toBe(0);
    expect(aiCall).not.toHaveBeenCalled();
  });

  it('refreshes a saved visual continuation using its previously taught source sibling without inventing ownership', async () => {
    const { blueprint, input } = fixture();
    const original = blueprint.sections[0]!.pages[0]!;
    const continuation: TeachingBlueprintPage = { ...structuredClone(original), id: 'p1-visual-continuation',
      title: '副本状态观察', introducesNodeIds: [], deepensNodeIds: [], referencesNodeIds: [] };
    blueprint.sections[0]!.pages.splice(2, 0, continuation);
    const before = structuredClone(blueprint);
    const authored = response();
    authored.sections[0]!.pages.push({ id: continuation.id, presentationItems: [
      { text: '观察不同副本按共同规则读取', nodeIds: ['meaning'], role: 'case-observation' },
    ] });
    const result = await refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'],
      aiCall: vi.fn(async () => JSON.stringify(authored)) });
    expect(result.refreshedPageIds).toEqual(['p1', 'p2', 'p1-visual-continuation']);
    const refreshed = result.candidate.sections[0]!.pages[2]!;
    expect(refreshed.presentationItems?.[0]?.nodeIds).toEqual(['meaning']);
    expect(refreshed.introducesNodeIds).toEqual([]);
    expect(refreshed.deepensNodeIds).toEqual([]);
    expect(refreshed.referencesNodeIds).toEqual([]);
    expect(result.candidate.sections[0]!.units).toEqual(before.sections[0]!.units);
    expect(blueprint).toEqual(before);
  });

  it.each(['plan-version', 'source-page', 'unit-owner'] as const)
    ('does not borrow arbitrary unit prose for a visual continuation with a different %s', async (difference) => {
      const { blueprint, input } = fixture();
      const continuation: TeachingBlueprintPage = { ...structuredClone(blueprint.sections[0]!.pages[0]!),
        id: 'visual', introducesNodeIds: [], deepensNodeIds: [], referencesNodeIds: [] };
      if (difference === 'plan-version') continuation.sectionPlanVersion = 'another-plan';
      if (difference === 'source-page') continuation.sourcePageIds = ['unrelated'];
      if (difference === 'unit-owner') continuation.unitIds = ['u2'];
      blueprint.sections[0]!.pages.splice(2, 0, continuation);
      const aiCall = vi.fn(async () => 'unused');
      await expect(refreshTeachingPresentation({ blueprint, input, sectionIds: ['s1'], aiCall }))
        .rejects.toBeInstanceOf(TeachingPresentationRefreshError);
      expect(aiCall).not.toHaveBeenCalled();
    });
});
