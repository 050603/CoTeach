import { describe, expect, it, vi } from 'vitest';
import fixture from './__fixtures__/blueprint-definition-ownership-first-draft.json';
import { buildSourceConceptStatements, buildTeachingBlueprintPrompt, buildTeachingBlueprintRepairPrompt, generateTeachingBlueprint, revalidateStoredTeachingBlueprint,
  teachingBlueprintToOutlines, validateTeachingBlueprintDraft, type TeachingBlueprintInput } from './teaching-blueprint';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import type { AICallFn } from '@/lib/openmaic/generation/pipeline-types';

async function expectDiagnosedDraft(input: TeachingBlueprintInput, response: unknown,
  ai: AICallFn, issue: string) {
  const before = structuredClone(response);
  const strict = validateTeachingBlueprintDraft(response, input);
  expect(strict.blueprint).toBeUndefined();
  expect(strict.issues.join('；')).toContain(issue);
  const generated = await generateTeachingBlueprint(input, ai);
  expect(generated.qualityDiagnostics?.join('；')).toContain(issue);
  // Structural normalization may rename IDs; it must not rewrite the actual
  // faulty first draft or manufacture the missing evidence to clear a warning.
  type RawNode = { content?: string; contentParts?: Array<{ text: string }> };
  const raw = response as { sections: Array<{ units: Array<{ explanationNodes?: RawNode[] }>;
    pages: Array<{ title: string; explanationNodes?: RawNode[] }> }> };
  const bodies = raw.sections.flatMap((section) => [
    ...section.units.flatMap((unit) => unit.explanationNodes ?? []),
    ...section.pages.flatMap((page) => page.explanationNodes ?? []),
  ]).map((node) => node.contentParts?.map((part) => part.text).join(' ') ?? node.content);
  expect(generated.sections.flatMap((section) => section.units.flatMap((unit) => unit.explanationNodes ?? []))
    .map((node) => node.content)).toEqual(bodies);
  expect(generated.sections.flatMap((section) => section.pages.map((page) => page.title)))
    .toEqual(raw.sections.flatMap((section) => section.pages.map((page) => page.title)));
  expect(response).toEqual(before);
  // The unchanged authored response continues to fail strict acceptance.
  expect(validateTeachingBlueprintDraft(response, input).issues.join('；')).toContain(issue);
  return generated;
}

function sample(kind: 'concept' | 'orphan') {
  const { point, unit, page } = structuredClone(fixture[kind]);
  // Isolate the exact authored unit and page. Earlier units and the image
  // registry are outside this local contract test, not removed from the course.
  unit.requirementIds = [];
  unit.difficultyStrategies = [];
  const ids = new Set(unit.explanationNodes.map((node) => node.id));
  unit.explanationNodes.forEach((node) => {
    node.prerequisiteNodeIds = node.prerequisiteNodeIds.filter((id) => ids.has(id));
  });
  page.referencesNodeIds = page.referencesNodeIds.filter((id) => ids.has(id));
  page.caseObservation = { kind: 'none', subjects: [], observableDifference: '',
    reason: '本测试仅隔离定义与节点归属，原课图片由完整重放核对。', composition: '', resourceIds: [] };
  const input: TeachingBlueprintInput = {
    courseTitle: '教学理论', subject: '教育学', grade: '大学', learningObjectives: [unit.learningOutcome],
    totalDurationSec: 1_200, projectContext: '', assessmentMode: 'adaptive', generationMode: 'standard',
    knowledgePoints: [{ ...point, teachingRole: kind === 'concept' ? 'core-concept' : 'detail-concept',
      level: 'core', teachingDepth: 'detailed' }],
    sourceContext: unit.evidenceQuotes.join('\n'),
  };
  const candidate = { authoringContract: 'blueprint-v1', sections: [{
    title: unit.title, learningObjective: unit.learningOutcome,
    sharedContext: { learningPurpose: unit.learningOutcome, caseId: '', caseFacts: [], fixedWording: [],
      stableTerms: [point.name], conceptBoundaries: ['既要说清概念含义，也要说明其适用条件。'] },
    units: [unit], pages: [page], assessmentFocus: [unit.learningOutcome],
    understandingCriteria: { goals: [unit.learningOutcome], answerEssentials: [point.description],
      misconceptions: ['不能只记名称而忽略必要条件。'], supportingUnitIds: [unit.id] },
  }] };
  return { input, candidate };
}

function combinedConceptSample() {
  const { input, candidate } = sample('concept');
  const point = input.knowledgePoints[0]!;
  point.name = '顺序、选择与循环结构的含义与用途';
  point.sourceKnowledgePointNames = ['程序控制结构', '顺序结构', '选择结构（Branch）', '循环结构的使用'];
  const definitions = '顺序结构是按照语句的排列顺序依次执行各条语句的控制结构。选择结构引导程序根据给定条件的真假选择需要执行的分支。循环结构通过重复执行一组语句完成具有相同操作规则的任务。';
  point.description = definitions;
  input.courseTitle = '程序控制结构';
  input.subject = '信息科技';
  input.learningObjectives = ['解释并比较三种控制结构'];
  input.sourceContext = definitions;
  const section = candidate.sections[0]!;
  const unit = section.units[0]!;
  unit.title = point.name;
  unit.learningOutcome = '能说明三种控制结构的执行方式，并根据任务选择适用结构。';
  unit.evidenceQuotes = [definitions];
  unit.explanationNodes[0]!.content = definitions;
  unit.explanationNodes[1]!.content = '依次输出三条消息使用顺序结构；根据温度选择提示分支使用选择结构；对名单中每个人发送相同通知使用循环结构。任务是否需要判断条件或重复操作决定选择哪种结构。';
  section.title = '程序控制结构';
  section.learningObjective = unit.learningOutcome;
  section.sharedContext.learningPurpose = unit.learningOutcome;
  section.sharedContext.stableTerms = ['顺序结构', '选择结构', '循环结构'];
  section.sharedContext.conceptBoundaries = ['选择结构只执行条件决定的分支，循环结构按循环条件重复执行。'];
  section.assessmentFocus = [unit.learningOutcome];
  section.understandingCriteria.goals = [unit.learningOutcome];
  section.understandingCriteria.answerEssentials = [definitions];
  const page = section.pages[0]!;
  page.title = '程序控制结构';
  page.description = '比较三种控制结构的执行方式及适用任务。';
  page.keyPoints = definitions.split('。').filter(Boolean);
  page.teachingObjective = unit.learningOutcome;
  page.entryPoint = { kind: 'direct-explanation', object: '消息依次显示、根据温度提示、遍历名单发送通知。',
    bridge: '三类任务分别需要顺序、选择和循环结构。' };
  return { input, candidate, definitions };
}

function teachingAspectSample(name = '缓存一致性的定义、要素与机制',
  sourceNames = ['缓存一致性', '缓存一致性的核心机制', '缓存失效'],
  content = '缓存一致性是同一数据存在多个缓存副本时，让各副本与数据更新之间遵守既定一致性规则的机制。系统在数据更新后使旧缓存失效或同步更新副本，防止后续读取使用不符合该规则的旧值。') {
  const { input, candidate } = sample('concept');
  const point = input.knowledgePoints[0]!;
  point.name = name;
  point.description = content;
  point.sourceKnowledgePointNames = sourceNames;
  input.courseTitle = name;
  input.sourceContext = content;
  const section = candidate.sections[0]!;
  const unit = section.units[0]!;
  unit.title = name;
  unit.learningOutcome = '能说明概念的基本含义，并用其核心机制解释一个具体情境。';
  unit.evidenceQuotes = [content];
  unit.explanationNodes[0]!.content = content;
  unit.explanationNodes[1]!.kind = 'condition';
  unit.explanationNodes[1]!.content = '具体应用须遵守概念的条件与边界，不能把某个案例中的做法扩大为所有情境下的唯一要求。';
  section.title = name;
  section.learningObjective = unit.learningOutcome;
  section.sharedContext.learningPurpose = unit.learningOutcome;
  section.sharedContext.stableTerms = [name.split('的')[0]!];
  section.sharedContext.conceptBoundaries = ['先理解概念的基本含义，再根据必要条件应用；步骤名称不能代替概念定义。'];
  section.sharedContext.fixedWording = [];
  section.assessmentFocus = [unit.learningOutcome];
  section.understandingCriteria.goals = [unit.learningOutcome];
  section.understandingCriteria.answerEssentials = [content];
  const page = section.pages[0]!;
  page.title = name.split('的')[0]!;
  page.description = '建立概念的基本含义，并据此说明核心机制及其应用边界。';
  page.keyPoints = content.split('。').filter(Boolean);
  page.teachingObjective = unit.learningOutcome;
  page.entryPoint = { kind: 'direct-explanation', object: page.keyPoints[0]!,
    bridge: '先解释概念的基本含义，再用它理解具体机制与适用条件。' };
  page.visualRelationship = { kind: 'statement', description: '概念的核心含义与应用边界',
    readingOrder: ['先理解基本含义', '再分析机制与条件'], preferredForm: 'text',
    rationale: '核心含义与条件可通过分组文字清楚解释。' };
  return { input, candidate, content };
}

function adoptedConceptEvidence(input: TeachingBlueprintInput, items: CourseEvidenceSnapshot['items']): CourseEvidenceSnapshot {
  input.knowledgePoints[0]!.evidenceItemIds = items.map((item) => item.id);
  return { schemaVersion: 2, version: 1, fingerprint: 'frozen', createdAt: '2026-10-01',
    selections: [{ revisionId: 'revision-1', primary: true, sectionIds: [] }],
    retrievalMode: 'hybrid', mappings: [], warnings: [], items };
}

describe('source-faithful definition and unique unit ownership from saved first draft', () => {
  it('authors PPT wording independently in one call while retaining complete explanations and persisted node references', async () => {
    const { input, candidate } = teachingAspectSample();
    const section = candidate.sections[0]!;
    const unit = section.units[0]!;
    const { explanationNodes: body, ...unitMetadata } = unit;
    const { unitIds: _unitIds, introducesNodeIds: _introduces, referencesNodeIds: _refs, ...page } = section.pages[0]!;
    void _unitIds; void _introduces; void _refs;
    const presentationItems = [
      { text: '缓存一致性', nodeIds: [body[0]!.id], role: 'heading' },
      { text: '多个副本：按既定一致性规则更新和读取', nodeIds: [body[0]!.id], role: 'key-point' },
      { text: '应用边界：具体做法按情境选择', nodeIds: [body[1]!.id], role: 'key-point' },
    ];
    const response = { ...candidate, authoringContract: 'blueprint-v5', sections: [{ ...section,
      units: [unitMetadata], pages: [{ ...page, explanationNodes: body.map((node) => {
        const { content, ...metadata } = node;
        return { ...metadata, unitId: unit.id, contentParts: [{ id: 'meaning', text: content }] };
      }), presentationItems }],
    }] };
    const before = structuredClone(response);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(response).toEqual(before);
    const compiledPage = blueprint.sections[0]!.pages[0]!;
    const compiledNodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(compiledNodes.map((node) => node.content)).toEqual(body.map((node) => node.content));
    expect(compiledPage.keyPoints).toEqual(presentationItems.map((item) => item.text));
    expect(compiledPage.presentationItems).toEqual(presentationItems.map((item, index) => ({ ...item,
      nodeIds: [compiledNodes[index === 2 ? 1 : 0]!.id],
    })));
    const outline = teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!;
    expect(outline.teachingBrief?.teachingPlan?.presentationContent).toEqual(compiledPage.keyPoints);
    expect(outline.teachingBrief?.teachingPlan?.presentationItems).toEqual(compiledPage.presentationItems);
    expect(outline.teachingBrief?.explanation).toContain(body[0]!.content);
    const reused = revalidateStoredTeachingBlueprint(blueprint, input);
    expect(reused.issues).toEqual([]);
    expect(reused.blueprint?.sections[0]!.pages[0]!.presentationItems).toEqual(compiledPage.presentationItems);
    expect(reused.blueprint?.budget).toEqual(blueprint.budget);
    const repair = buildTeachingBlueprintRepairPrompt(input, blueprint, ['第 1 节第 1 页第 1 项 presentationItems 数量与对应解释节点不一致'], 2);
    const repairPayload = JSON.parse(repair.user);
    expect(repairPayload.allowedPaths).toContain('sections.0.pages.0.presentationItems');
    expect(repairPayload.allowedPaths).not.toContain('sections.0.pages.0.keyPoints');
    expect(repairPayload.allowedPaths).not.toContain('sections.0.units.0.explanationNodes');
    const incompleteFresh = { ...response, sections: [{ ...response.sections[0]!, pages: [response.sections[0]!.pages[0]!, {
      ...response.sections[0]!.pages[0]!, id: 'missing-new-display', explanationNodes: [],
      deepensNodeIds: [body[0]!.id], presentationItems: undefined,
    }] }] };
    expect(validateTeachingBlueprintDraft(incompleteFresh, input).issues.join(';')).toContain('缺少 presentationItems');
  });

  it('compiles actual first-authored page prose into the full unit, display and unchanged stored ownership in one call', async () => {
    const { input, candidate } = teachingAspectSample();
    const section = candidate.sections[0]!;
    const unit = section.units[0]!;
    const { explanationNodes: body, ...unitMetadata } = unit;
    const { unitIds: _unitIds, introducesNodeIds: _introduces, referencesNodeIds: _refs, ...page } = section.pages[0]!;
    void _unitIds; void _introduces; void _refs;
    const response = { ...candidate, authoringContract: 'blueprint-v4', sections: [{ ...section,
      units: [unitMetadata], pages: [{ ...page, explanationNodes: body.map((node) => {
        const { content, ...metadata } = node;
        return { ...metadata, unitId: unit.id, contentParts: [{ id: 'core', text: content }] };
      }), keyPointRefs: [{ nodeId: body[0]!.id, partIds: ['core'] }] }],
    }] };
    const before = structuredClone(response);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(response).toEqual(before);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes!.map((node) => node.content)).toEqual(body.map((node) => node.content));
    const assigned = blueprint.sections[0]!.pages[0]!.introducesNodeIds;
    expect(assigned).toEqual(blueprint.sections[0]!.units[0]!.explanationNodes!.map((node) => node.id));
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.teachingPlan?.presentationContent).toEqual([body[0]!.content]);
    const reused = revalidateStoredTeachingBlueprint(blueprint, input);
    expect(reused.issues).toEqual([]);
    expect(reused.blueprint?.sections[0]!.pages[0]!.introducesNodeIds).toEqual(assigned);
    expect(reused.blueprint?.budget).toEqual(blueprint.budget);
  });

  it('diagnoses a first page relying on a later actual explanation without borrowing, moving or rewriting that body', async () => {
    const { input, candidate } = teachingAspectSample();
    const section = candidate.sections[0]!;
    const { explanationNodes: body, ...unit } = section.units[0]!;
    const { unitIds: _unitIds, introducesNodeIds: _introduces, referencesNodeIds: _refs, ...page } = section.pages[0]!;
    void _unitIds; void _introduces; void _refs;
    const nodes = body.map((node) => { const { content, ...metadata } = node;
      return { ...metadata, unitId: unit.id, contentParts: [{ id: 'core', text: content }] }; });
    const response = { ...candidate, authoringContract: 'blueprint-v4', sections: [{ ...section, units: [unit], pages: [
      { ...page, id: 'overview', explanationNodes: [nodes[0], { ...nodes[1], id: 'premature-misconception',
        kind: 'misconception', prerequisiteNodeIds: [nodes[1]!.id] }],
      keyPointRefs: [{ nodeId: nodes[0]!.id, partIds: ['core'] }] },
      { ...page, id: 'application', explanationNodes: [nodes[1]], keyPointRefs: [{ nodeId: nodes[1]!.id, partIds: ['core'] }] },
    ] }] };
    const before = structuredClone(response);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    await expectDiagnosedDraft(input, response, ai, '本页更早正文');
    expect(ai).toHaveBeenCalledOnce();
    expect(response).toEqual(before);
  });

  it('puts the adopted original support relationship in the first authoring contract without manufacturing necessity', () => {
    const { input } = teachingAspectSample();
    const originalText = '失效通知有助于更好地协调副本更新；本段并未把通知规定为一致性机制的唯一实现方式。';
    input.sourceSequences = [{ resourceId: 'adopted-source-list', required: true, scope: 'knowledge-point',
      knowledgePointIds: [input.knowledgePoints[0]!.id], sequenceSemantics: 'enumerated-items',
      orderedSteps: [{ label: '协调副本更新', sourceBlockId: 'original-block', excerpt: originalText }],
    }];
    const prompt = buildTeachingBlueprintPrompt(input);
    const contract = JSON.parse(prompt.user.split(/机器结构验收合同[^\n]*\n/u)[1]!
      .split('\n\n教学资料')[0]!);
    expect(contract.conditionalReasoning.sourceRelationshipEvidence).toEqual([{ resourceId: 'adopted-source-list',
      knowledgePointIds: [input.knowledgePoints[0]!.id], label: '协调副本更新', originalText }]);
    expect(contract.conditionalReasoning.supportRule).toContain('不证明所支持的基本过程或联系原本不存在');
  });

  it('authors factual parts once and compiles their display while preserving full teaching prose and checkpoint reuse', async () => {
    const core = '缓存一致性是同一数据存在多个副本时，使各副本遵守既定更新和读取规则的机制。';
    const detail = '副本不要求立即更新，但必须符合系统采用的一致性规则。';
    const { input, candidate } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], core + detail);
    const section = candidate.sections[0]!;
    const node = section.units[0]!.explanationNodes[0]!;
    const response = { ...candidate, authoringContract: 'blueprint-v3', sections: [{ ...section,
      units: section.units.map((unit) => ({ ...unit, explanationNodes: unit.explanationNodes.map((partNode) => ({
        ...partNode, content: '这份重复正文不应参与事实编译。',
        contentParts: partNode.id === node.id
          ? [{ id: 'core', text: core }, { id: 'detail', text: detail }]
          : [{ id: 'core', text: partNode.content }],
      })) })),
      pages: [{ ...section.pages[0], keyPoints: ['这份重复展示不应参与事实编译。'],
        keyPointRefs: [{ nodeId: node.id, partIds: ['core'] }] }],
    }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.pages[0]!.keyPoints).toEqual([core]);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(`${core} ${detail}`);
    const outline = teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!;
    expect(outline.teachingBrief?.teachingPlan?.presentationContent).toEqual([core]);
    expect(outline.teachingBrief?.explanation).toContain(detail);
    const reused = revalidateStoredTeachingBlueprint(blueprint, input);
    expect(reused.issues).toEqual([]);
    expect(reused.blueprint?.sections[0]!.pages[0]!.keyPoints).toEqual([core]);
    expect(reused.blueprint?.budget.totalDurationSec).toBe(blueprint.budget.totalDurationSec);
  });

  it('diagnoses a nonexistent factual part without another authoring call or borrowing free text', async () => {
    const { input, candidate } = teachingAspectSample();
    const section = candidate.sections[0]!;
    const response = { ...candidate, authoringContract: 'blueprint-v3', sections: [{ ...section,
      units: section.units.map((unit) => ({ ...unit, explanationNodes: unit.explanationNodes.map((node) => ({
        ...node, contentParts: [{ id: 'core', text: node.content }],
      })) })),
      pages: [{ ...section.pages[0], keyPointRefs: [{
        nodeId: section.units[0]!.explanationNodes[0]!.id, partIds: ['nonexistent'],
      }] }],
    }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    await expectDiagnosedDraft(input, response, ai, 'contentParts.id');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('compiles a concise first-authored literal point while retaining complete source prose in the same request', async () => {
    const content = '缓存一致性是同一数据存在多个副本时，使各副本遵守既定更新和读取规则的机制。副本不要求立即更新，但必须符合系统采用的一致性规则。';
    const { input, candidate } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], content);
    const node = candidate.sections[0]!.units[0]!.explanationNodes[0]!;
    const quote = '副本不要求立即更新，但必须符合系统采用的一致性规则。';
    const response = { ...candidate, authoringContract: 'blueprint-v2', sections: [{ ...candidate.sections[0],
      pages: [{ ...candidate.sections[0]!.pages[0], keyPoints: ['不得使用这项重复改写的事实。'],
        keyPointRefs: [{ nodeId: node.id, quote }] }],
    }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.pages[0]!.keyPoints).toEqual([quote]);
    const outline = teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!;
    expect(outline.teachingBrief?.teachingPlan?.presentationContent).toEqual([quote]);
    expect(outline.teachingBrief?.explanation).toContain(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
  });

  it('diagnoses a separately paraphrased first display point without another model repair call or falling back to keyPoints', async () => {
    const content = '缓存一致性是同一数据存在多个副本时，使各副本遵守既定更新和读取规则的机制。副本不要求立即更新，但必须符合系统采用的一致性规则。';
    const { input, candidate } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], content);
    const response = { ...candidate, authoringContract: 'blueprint-v2', sections: [{ ...candidate.sections[0],
      pages: [{ ...candidate.sections[0]!.pages[0],
        keyPointRefs: [{ nodeId: candidate.sections[0]!.units[0]!.explanationNodes[0]!.id,
          quote: '副本不要求更新。' }] }],
    }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    await expectDiagnosedDraft(input, response, ai, 'keyPointRefs');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('preserves the final condition of a long referenced sentence through stored checkpoint validation', async () => {
    const quote = `各副本分别保持${Array.from({ length: 40 }, (_, index) => `第${index + 1}项记录的既定版本和更新规则`).join('、')}，但不能依据测试反馈重新选择已锁定的配置。`;
    expect(quote.length).toBeGreaterThan(500);
    const { input, candidate } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'],
      `缓存一致性是使同一数据的多个副本遵守既定更新和读取规则的机制。${quote}`);
    const node = candidate.sections[0]!.units[0]!.explanationNodes[0]!;
    const response = { ...candidate, authoringContract: 'blueprint-v2', sections: [{ ...candidate.sections[0],
      pages: [{ ...candidate.sections[0]!.pages[0], keyPointRefs: [{ nodeId: node.id, quote }] }],
    }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    const revalidated = revalidateStoredTeachingBlueprint(blueprint, input);
    expect(ai).toHaveBeenCalledOnce();
    expect(revalidated.issues).toEqual([]);
    expect(revalidated.blueprint?.sections[0]!.pages[0]!.keyPoints).toEqual([quote]);
  });

  it('does not treat a future page node as an already taught display premise', async () => {
    const { input, candidate } = teachingAspectSample();
    const section = candidate.sections[0]!;
    const [concept, condition] = section.units[0]!.explanationNodes;
    const page = section.pages[0]!;
    const response = { ...candidate, authoringContract: 'blueprint-v2', sections: [{ ...section, pages: [
      { ...page, id: 'earlier', introducesNodeIds: [concept!.id], deepensNodeIds: [],
        referencesNodeIds: [condition!.id], keyPointRefs: [{ nodeId: condition!.id, quote: condition!.content }] },
      { ...page, id: 'later', introducesNodeIds: [condition!.id], deepensNodeIds: [], referencesNodeIds: [],
        keyPointRefs: [{ nodeId: condition!.id, quote: condition!.content }] },
    ] }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    await expectDiagnosedDraft(input, response, ai, '尚未实际讲授');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('preserves an actual taught cross-section reference through first compilation and stored revalidation', async () => {
    const first = teachingAspectSample();
    const second = teachingAspectSample('失效通知的定义与机制', ['失效通知'],
      '失效通知是让接收方获知原有缓存记录已经失效的机制。收到通知后，接收方按既定一致性规则更新或重新获取数据。');
    const firstSection = first.candidate.sections[0]!;
    const secondSection = second.candidate.sections[0]!;
    const point = second.input.knowledgePoints[0]!;
    point.id = 'invalidation-point';
    const secondUnit = secondSection.units[0]!;
    secondUnit.id = 'invalidation-unit';
    secondUnit.knowledgePointIds = [point.id];
    secondUnit.explanationNodes.forEach((node, index) => {
      node.id = `invalidation-node-${index}`;
      node.knowledgePointIds = [point.id];
      node.prerequisiteNodeIds = [];
    });
    secondSection.understandingCriteria.supportingUnitIds = [secondUnit.id];
    const prior = firstSection.units[0]!.explanationNodes[0]!;
    const page = secondSection.pages[0]!;
    const response = { authoringContract: 'blueprint-v2', sections: [
      { ...firstSection, pages: [{ ...firstSection.pages[0],
        keyPointRefs: [{ nodeId: prior.id, quote: prior.content }] }] },
      { ...secondSection, pages: [{ ...page, unitIds: [secondUnit.id],
        introducesNodeIds: secondUnit.explanationNodes.map((node) => node.id), referencesNodeIds: [prior.id],
        keyPointRefs: [{ nodeId: secondUnit.explanationNodes[0]!.id, quote: secondUnit.explanationNodes[0]!.content },
          { nodeId: prior.id, quote: prior.content.split('。')[0]! }] }] },
    ] };
    const input = { ...first.input, knowledgePoints: [...first.input.knowledgePoints, point],
      sourceContext: `${first.input.sourceContext}\n${second.input.sourceContext}` };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    const referencedId = blueprint.sections[0]!.units[0]!.explanationNodes![0]!.id;
    expect(blueprint.sections[1]!.pages[0]!.referencesNodeIds).toEqual([referencedId]);
    const revalidated = revalidateStoredTeachingBlueprint(blueprint, input);
    expect(revalidated.issues).toEqual([]);
    expect(revalidated.blueprint?.sections[1]!.pages[0]!.referencesNodeIds).toEqual([referencedId]);
  });

  it('accepts canonical labels from the directly adopted original figure as first display references', async () => {
    const { input, candidate } = teachingAspectSample();
    const point = input.knowledgePoints[0]!;
    const node = candidate.sections[0]!.units[0]!.explanationNodes[0]!;
    const labels = ['检查输入', '保存输出'];
    node.content += '第一步检查输入，核对调用条件和版本。第二步保存输出，记录本次处理结果。';
    input.textbookFigures = [{ resourceId: 'original-figure', figureId: 'figure',
      knowledgePointIds: [point.id], relation: 'direct', required: false, sourceTitle: '原始步骤图',
      orderedSteps: labels.map((label) => ({ label })) }];
    const response = { ...candidate, authoringContract: 'blueprint-v2', sections: [{ ...candidate.sections[0],
      pages: [{ ...candidate.sections[0]!.pages[0], keyPointRefs: labels.map((quote) => ({ nodeId: node.id, quote })) }],
    }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.pages[0]!.keyPoints).toEqual(labels);
  });

  it('keeps the full source-confirmed category subject containing 的', async () => {
    const { input, candidate, definitions } = combinedConceptSample();
    const point = input.knowledgePoints[0]!;
    point.name = '程序的控制结构：顺序、选择与循环';
    point.sourceKnowledgePointNames![0] = '程序的控制结构';
    const statement = `程序的控制结构包括顺序、选择与循环三类。三者分别组织依次执行、按条件选择和重复执行，其应用取决于任务。${definitions}`;
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = statement;
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(statement);
  });

  it('does not infer a different classification subject by truncating a source name at 的', async () => {
    const { input, candidate, definitions } = combinedConceptSample();
    const point = input.knowledgePoints[0]!;
    point.name = '程序：顺序、选择与循环';
    point.sourceKnowledgePointNames![0] = '程序的控制结构';
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = `程序包括顺序、选择与循环三类。${definitions}`;
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    await expectDiagnosedDraft(input, candidate, ai, '核心概念');
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each(['包括', '包含', '分为', '有'])('accepts the source-confirmed category statement using %s without rewriting the first response', async (link) => {
    const { input, candidate, definitions } = combinedConceptSample();
    const point = input.knowledgePoints[0]!;
    point.name = '程序控制结构：顺序、选择与循环';
    const statement = `程序控制结构${link}顺序、选择与循环三类。三者分别组织依次执行、按条件选择和重复执行，其应用取决于任务是否需要判断或重复。${definitions}`;
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = statement;
    input.sourceContext = statement;
    const original = structuredClone(candidate);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]!).toContain('"requiredClassification":{"subject":"程序控制结构","labels":["顺序","选择","循环"],"confirmedMembers":["顺序结构","选择结构","循环结构"]}');
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(statement);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文').some((outline) => outline.teachingBrief?.explanation?.includes(statement))).toBe(true);
  });

  it.each(['顺序、选择和循环', '顺序结构、选择结构及循环结构', '顺序，选择与循环'])
    ('recognizes the finite source members using natural category wording %s', async (members) => {
      const { input, candidate, definitions } = combinedConceptSample();
      input.knowledgePoints[0]!.name = '程序控制结构：顺序、选择与循环';
      const content = `程序控制结构包括${members}三类。${definitions}`;
      candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = content;
      const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
      const blueprint = await generateTeachingBlueprint(input, ai);
      expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(content);
      expect(ai).toHaveBeenCalledOnce();
    });

  it.each(['顺序、选择与循环四类', '顺序、选择与循环、异常处理四类', '顺序、顺序与循环三类'])
    ('diagnoses a changed count or unconfirmed/repeated category in %s', async (members) => {
      const { input, candidate, definitions } = combinedConceptSample();
      input.knowledgePoints[0]!.name = '程序控制结构：顺序、选择与循环';
      candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = `程序控制结构包括${members}。${definitions}`;
      const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
      await expectDiagnosedDraft(input, candidate, ai, '核心概念');
      expect(ai).toHaveBeenCalledOnce();
    });

  it.each(['missing-member', 'unconfirmed-member', 'unconfirmed-subject', 'no-category-relation'] as const)
    ('keeps the full source classification duty when %s is invalid', async (invalid) => {
      const { input, candidate, definitions } = combinedConceptSample();
      const point = input.knowledgePoints[0]!;
      point.name = '程序控制结构：顺序、选择与循环';
      const statement = invalid === 'missing-member'
        ? `程序控制结构包括顺序、选择两类。${definitions}`
        : invalid === 'no-category-relation' ? `程序控制结构用于组织程序执行。${definitions}`
          : `程序控制结构包括顺序、选择与循环三类。三者分别组织依次执行、按条件选择和重复执行。${definitions}`;
      if (invalid === 'unconfirmed-member') point.sourceKnowledgePointNames = ['程序控制结构', '顺序结构', '选择结构'];
      if (invalid === 'unconfirmed-subject') point.sourceKnowledgePointNames = ['顺序结构', '选择结构', '循环结构'];
      candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = statement;
      input.sourceContext = statement;
      const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
      await expectDiagnosedDraft(input, candidate, ai, '核心概念');
      expect(ai).toHaveBeenCalledOnce();
    });

  it.each(['则', '通常', '一般', '主要', '往往', '具体', '本质上'])
    ('retains an original concept claim with the legitimate predicate modifier %s', async (modifier) => {
      const original = `缓存一致性${modifier}是同一数据存在多个缓存副本时，让各副本与数据更新之间遵守既定一致性规则的机制。`;
      const { input, candidate } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], original);
      const source = { textbookId: 'book', textbookTitle: '系统原理', revisionId: 'revision-1', revisionVersion: 1,
        sectionId: 'consistency', sectionPath: ['缓存一致性'], sourceBlockId: 'definition',
        sourceBlockPosition: 12, quote: original };
      const evidence = adoptedConceptEvidence(input, [{ id: 'adopted', kind: 'concept', title: '缓存一致性',
        content: '模型摘要不能代替原文。', source }]);
      const before = structuredClone(evidence);
      input.sourceConceptStatements = buildSourceConceptStatements(input.knowledgePoints, evidence);
      expect(input.sourceConceptStatements).toEqual([{ knowledgePointId: input.knowledgePoints[0]!.id,
        name: '缓存一致性', statements: [{ evidenceItemId: 'adopted', text: original, source }] }]);
      expect(buildSourceConceptStatements(input.knowledgePoints, evidence, { legacyV59Projection: true })).toEqual([]);
      expect(evidence).toEqual(before);
      const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
      await generateTeachingBlueprint(input, ai);
      expect(ai).toHaveBeenCalledOnce();
      expect(ai.mock.calls[0]![1]).toContain(JSON.stringify(original));
    });

  it('binds a sentence in a multi-block chunk to its own complete original block before the first request', async () => {
    const original = '缓存一致性是使同一数据的多个缓存副本遵守既定更新和读取规则的机制。';
    const component = '在缓存一致性中，缓存副本指的是保存同一数据的独立缓存记录。';
    const { input, candidate } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], original);
    const source = { textbookId: 'book', textbookTitle: '系统原理', revisionId: 'revision-1', revisionVersion: 1,
      sectionId: 'consistency', sectionPath: ['缓存一致性'], sourceBlockId: 'component',
      sourceBlockIds: ['component', 'definition'], sourceBlockPosition: 12, quoteStart: 4, quote: component };
    const definitionSource = { ...source, sourceBlockId: 'definition', sourceBlockIds: ['definition'],
      sourceBlockPosition: 14, quoteStart: undefined, quote: original };
    const evidence = adoptedConceptEvidence(input, [{ id: 'chunk', kind: 'source-block', title: '缓存一致性',
      content: component + original, source,
      completeSourceBlocks: [{ sourceBlockId: 'definition', content: original, source: definitionSource }] }]);
    const before = structuredClone(evidence);
    input.sourceConceptStatements = buildSourceConceptStatements(input.knowledgePoints, evidence);
    expect(input.sourceConceptStatements).toEqual([{ knowledgePointId: input.knowledgePoints[0]!.id,
      name: '缓存一致性', statements: [{ evidenceItemId: 'chunk', text: original, source: definitionSource }] }]);
    // The deployed v59 projection remains exact for checkpoint identity: its
    // later chunk entry inherits position 12 and then the sorted map keeps 14.
    expect(buildSourceConceptStatements(input.knowledgePoints, evidence, { legacyV59Projection: true }))
      .toEqual(input.sourceConceptStatements);
    expect(evidence).toEqual(before);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]).toContain(JSON.stringify({ evidenceItemId: 'chunk', text: original, source: definitionSource }));
  });

  it('keeps an unlocated original chunk claim without fabricating its first block location', () => {
    const original = '缓存一致性是使同一数据的多个缓存副本遵守既定更新和读取规则的机制。';
    const component = '在缓存一致性中，缓存副本指的是保存同一数据的独立缓存记录。';
    const { input } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], original);
    const content = component + original;
    const source = { textbookId: 'book', textbookTitle: '系统原理', revisionId: 'revision-1', revisionVersion: 1,
      sectionId: 'consistency', sectionPath: ['缓存一致性'], sourceBlockId: 'component',
      sourceBlockIds: ['component', 'definition'], sourceBlockPosition: 12, quoteStart: 4, quote: component };
    const evidence = adoptedConceptEvidence(input, [{ id: 'chunk', kind: 'source-block', title: '缓存一致性', content, source }]);
    const statement = buildSourceConceptStatements(input.knowledgePoints, evidence)[0]!.statements[0]!;
    expect(statement.text).toBe(original);
    expect(statement.source).toEqual({ textbookId: source.textbookId, textbookTitle: source.textbookTitle,
      revisionId: source.revisionId, revisionVersion: source.revisionVersion, sectionId: source.sectionId,
      sectionPath: source.sectionPath, sourceBlockIds: ['component', 'definition'], quote: content });
    expect(buildSourceConceptStatements(input.knowledgePoints, evidence, { legacyV59Projection: true })[0]!.statements[0]!.source)
      .toEqual(source);
  });

  it.each(['precise first', 'precise last'])('does not replace a complete original block with a duplicate coarse chunk: %s', (order) => {
    const original = '缓存一致性是使同一数据的多个缓存副本遵守既定更新和读取规则的机制。';
    const { input } = teachingAspectSample('缓存一致性的定义与机制', ['缓存一致性'], original);
    const source = { textbookId: 'book', textbookTitle: '系统原理', revisionId: 'revision-1', revisionVersion: 1,
      sectionId: 'consistency', sectionPath: ['缓存一致性'], sourceBlockId: 'first', sourceBlockIds: ['first', 'definition'],
      sourceBlockPosition: 18, quote: '以下解释缓存的更新规则。' };
    const preciseSource = { ...source, sourceBlockId: 'definition', sourceBlockIds: ['definition'],
      sourceBlockPosition: 12, quote: original };
    const precise: CourseEvidenceSnapshot['items'][number] = { id: 'precise', kind: 'concept', title: '缓存一致性',
      content: '摘要', source, completeSourceBlocks: [{ sourceBlockId: 'definition', content: original, source: preciseSource }] };
    const coarse: CourseEvidenceSnapshot['items'][number] = { id: 'coarse', kind: 'source-block', title: '缓存一致性',
      content: original, source };
    const evidence = adoptedConceptEvidence(input, order === 'precise first' ? [precise, coarse] : [coarse, precise]);
    expect(buildSourceConceptStatements(input.knowledgePoints, evidence)[0]!.statements)
      .toEqual([{ evidenceItemId: 'precise', text: original, source: preciseSource }]);
    expect(buildSourceConceptStatements(input.knowledgePoints, evidence, { legacyV59Projection: true })[0]!.statements)
      .toEqual([{ evidenceItemId: 'coarse', text: original, source }]);
  });

  it('accepts an original alias followed by the same concept\'s actual claim on the first request', async () => {
    const definition = '分层缓存策略，又称多级缓存策略，它强调按不同层级的缓存之间既定的一致性和回退规则组织访问请求并取回数据。';
    const { input, candidate } = teachingAspectSample('分层缓存策略的定义与机制',
      ['分层缓存策略', '分层缓存策略的机制'], definition);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
  });

  it.each([
    '分层缓存策略，又称多级缓存策略。随后讲解访问规则、案例和注意事项。',
    '分层缓存策略，又称多级缓存策略，它强调说明该概念的基本含义、核心主张和适用条件。',
    '分层缓存策略，又称多级缓存策略，缓存一致性是使副本之间遵守规定的更新规则的机制。',
  ])('keeps a whole-concept duty when an alias has no real defining claim: %s', async (definition) => {
    const { input, candidate } = teachingAspectSample('分层缓存策略的定义与机制',
      ['分层缓存策略', '分层缓存策略的机制'], definition);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    await expectDiagnosedDraft(input, candidate, ai, '核心概念');
    expect(ai).toHaveBeenCalledOnce();
  });

  it('binds a whole-concept original introduction separately from its component definition before the first request', async () => {
    const original = '分层缓存策略，又称多级缓存策略，它强调把访问请求交给不同层级的缓存，并按规定的一致性和回退规则取回数据。';
    const component = '在分层缓存策略中，缓存层指的是承担特定访问范围和更新职责的一组缓存副本。';
    const { input, candidate } = teachingAspectSample('分层缓存策略的定义与机制',
      ['分层缓存策略', '分层缓存策略的机制'],
      '分层缓存策略是让不同层级的缓存按既定的一致性和回退规则共同响应访问请求的策略。各缓存层承担自身的访问和更新职责，局部副本并不等于整个策略。');
    const point = input.knowledgePoints[0]!;
    point.evidenceItemIds = ['adopted-child'];
    const childSource = { textbookId: 'book', textbookTitle: '系统原理', revisionId: 'revision-1',
      revisionVersion: 1, sectionId: 'child', sectionPath: ['缓存', '分层缓存策略', '缓存层'], sourceBlockPosition: 12 };
    const parentSource = { ...childSource, sectionId: 'parent', sectionPath: ['缓存', '分层缓存策略'], sourceBlockPosition: 10 };
    const evidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'frozen',
      createdAt: '2026-10-01', selections: [{ revisionId: 'revision-1', primary: true, sectionIds: [] }],
      retrievalMode: 'hybrid', mappings: [], warnings: [], items: [{ id: 'adopted-child', kind: 'concept',
        title: '缓存层', content: '生成过的摘要不作为原文定义。', source: { ...childSource, quote: component },
        completeSourceBlocks: [{ sourceBlockId: 'parent-intro', content: original, source: parentSource }] }] };
    const before = structuredClone(evidence);
    input.sourceConceptStatements = buildSourceConceptStatements(input.knowledgePoints, evidence);
    expect(input.sourceConceptStatements).toEqual([{ knowledgePointId: point.id, name: '分层缓存策略',
      statements: [{ evidenceItemId: 'adopted-child', text: original, source: parentSource }] }]);
    expect(evidence).toEqual(before);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    const request = ai.mock.calls[0]![1];
    expect(request).toContain(JSON.stringify(original));
    expect(request).toContain('"sectionId":"parent"');
    expect(ai.mock.calls[0]![0]).toContain('定义主体是要素');
    expect(buildSourceConceptStatements([{ ...point, evidenceItemIds: [] }], evidence)).toEqual([]);
    const onlyComponent = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [] }] };
    expect(buildSourceConceptStatements(input.knowledgePoints, onlyComponent)).toEqual([]);
    const foreignVersion = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'foreign', content: original, source: { ...parentSource, revisionId: 'revision-2' } },
    ] }] };
    expect(buildSourceConceptStatements(input.knowledgePoints, foreignVersion)).toEqual([]);
    const originalBlock = { ...evidence, items: [{ ...evidence.items[0]!, completeSourceBlocks: [
      { sourceBlockId: 'whole-concept-paragraph', content: original },
    ] }] };
    expect(buildSourceConceptStatements(input.knowledgePoints, originalBlock)[0]!.statements[0]!.source)
      .toMatchObject({ sourceBlockId: 'whole-concept-paragraph', sourceBlockIds: ['whole-concept-paragraph'],
        sourceBlockPosition: undefined, quote: original });
  });

  it.each([
    { name: '建构主义学习理论', claim: '知识不是被直接传递的，而是学习者通过与环境的互动主动建构的', predicate: '认为' },
    { name: '社会学习理论', claim: '观察他人行为及其结果是学习的重要途径，学习并不限于亲身试错', predicate: '主张' },
    { name: '经验学习理论', claim: '学习者通过具体经验、反思、概念化与实践应用之间的联系形成新的理解', predicate: '的核心主张是' },
  ])('uses the source-confirmed $name with teaching design as an aspect in the first authoring contract', async ({ name, claim, predicate }) => {
    const content = `${name}${predicate}，${claim}。教学设计应据此组织活动，并根据学习者的表现检验其理解，不将活动形式本身等同于学习成果。`;
    const { input, candidate } = teachingAspectSample(`${name}的核心观点与教学设计`,
      [name, `${name}的教学设计原则`], content);
    const original = structuredClone(candidate);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]).toContain(`"requiredDefinitionNames":["${name}"]`);
    expect(ai.mock.calls[0]![0]).toContain('教学设计也是教学侧面');
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.explanation).toContain(content);
  });

  it.each(['unconfirmed subject', 'only design procedure', 'authoring task', 'different theory', 'only reference'])
    ('keeps the actual core theory contract when a teaching-design heading has %s', (mutation) => {
      const name = '社会学习理论';
      const { input, candidate } = teachingAspectSample(`${name}的核心观点与教学设计`, [name],
        `${name}主张观察他人行为及其结果是学习的重要途径，学习并不限于亲身试错。`);
      const node = candidate.sections[0]!.units[0]!.explanationNodes[0]!;
      if (mutation === 'unconfirmed subject') input.knowledgePoints[0]!.sourceKnowledgePointNames = ['社会学习模型'];
      if (mutation === 'only design procedure') node.content = `${name}的教学设计步骤依次为准备资源、分组讨论、实施活动和总结评价，教师按顺序组织活动。`;
      if (mutation === 'authoring task') node.content = `${name}认为，请说明这一理论的主要观点，并结合学习者特点设计活动。`;
      if (mutation === 'different theory') {
        input.knowledgePoints[0]!.sourceKnowledgePointNames!.push('经验学习理论');
        node.content = `${name}：经验学习理论认为学习者通过经验与反思形成理解，教学应组织实践并引导学生反思。`;
      }
      if (mutation === 'only reference') {
        candidate.sections[0]!.pages[0]!.introducesNodeIds = ['n4-example'];
        candidate.sections[0]!.pages[0]!.referencesNodeIds = [node.id];
      }
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toMatch(/核心概念.*(?:缺少|未由任何页面)/u);
    });

  it.each(['direct concept', 'source child heading'])('resolves teaching aspects from a confirmed %s in the actual first call', async (sourceKind) => {
    const { input, candidate, content } = teachingAspectSample();
    if (sourceKind === 'source child heading') input.knowledgePoints[0]!.sourceKnowledgePointNames = ['缓存一致性的核心机制'];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]).toContain('"requiredDefinitionNames":["缓存一致性"]');
    expect(ai.mock.calls[0]![1]).toContain('不要求复制完整目录标题，也不能只写标题或流程');
    expect(ai.mock.calls[0]![0]).toContain('规范概念与定义、要素、流程、核心观点等教学侧面');
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.explanation).toContain(content);
  });

  it.each(['missing source', 'only self heading', 'prefix source', 'ambiguous source prefixes', 'necessary source condition',
    'unknown teaching aspect', 'unconfirmed extra topic', 'proposition heading'])
    ('retains the full heading contract for %s', (mutation) => {
      const { input, candidate } = teachingAspectSample();
      const point = input.knowledgePoints[0]!;
      if (mutation === 'missing source') point.sourceKnowledgePointNames = [];
      if (mutation === 'only self heading') point.sourceKnowledgePointNames = [point.name];
      if (mutation === 'prefix source') point.sourceKnowledgePointNames = ['缓存一致性模型'];
      if (mutation === 'ambiguous source prefixes') point.sourceKnowledgePointNames = ['缓存一致性模型', '缓存一致性协议'];
      if (mutation === 'necessary source condition') point.sourceKnowledgePointNames = ['缓存一致性（仅限同步更新）'];
      if (mutation === 'unknown teaching aspect') point.name = '缓存一致性的所有副本始终最新';
      if (mutation === 'unconfirmed extra topic') point.name = '缓存一致性的核心观点与不可丢弃的消息';
      if (mutation === 'proposition heading') point.name = '缓存一致性的核心观点：所有副本遵守同一更新规则';
      expect(buildTeachingBlueprintPrompt(input).user).toContain(`"requiredDefinitionNames":["${point.name}"]`);
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toContain('缺少写出概念名称');
    });

  it.each(['bare concept', 'bare teaching heading', 'authoring task', 'another concept definition', 'only process',
    'wrong role', 'missing knowledge ownership', 'not owned'])
    ('keeps the actual concept definition and ownership gate for %s', (mutation) => {
      const { input, candidate } = teachingAspectSample();
      const section = candidate.sections[0]!;
      const node = section.units[0]!.explanationNodes[0]!;
      if (mutation === 'bare concept') node.content = '缓存一致性';
      if (mutation === 'bare teaching heading') node.content = input.knowledgePoints[0]!.name;
      if (mutation === 'authoring task') node.content = '缓存一致性：请介绍这个概念的含义并列出实施机制。';
      if (mutation === 'another concept definition') node.content = '缓存一致性：缓存失效是数据更新后让旧缓存停止被读取的操作，它促使下一次读取重新获取有效的数据。';
      if (mutation === 'only process') node.content = '缓存一致性的流程包括读取更新通知、查找旧缓存、使旧缓存失效、重新获取数据；这四个步骤依次执行。';
      if (mutation === 'wrong role') node.kind = 'mechanism';
      if (mutation === 'missing knowledge ownership') node.knowledgePointIds = [];
      if (mutation === 'not owned') {
        section.pages[0]!.introducesNodeIds = ['n4-example'];
        section.pages[0]!.referencesNodeIds = ['n4-core'];
      }
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；'))
        .toMatch(/核心概念.*(?:缺少|未由任何页面)/u);
    });

  it.each([
    { name: '缓存一致性的定义、要素与机制', sourceNames: ['缓存一致性', '缓存失效'],
      content: '缓存一致性是更新协议。它规定各个缓存副本在数据更新时如何协调读取结果，避免后续读取使用违反约定的旧值。' },
    { name: '有限状态机的定义、要素与机制', sourceNames: ['有限状态机', '状态转移'],
      content: '有限状态机是状态模型。它通过读取输入在有限状态之间转移，并根据状态或转移产生输出。' },
    { name: '互斥锁的定义、要素与机制', sourceNames: ['互斥锁', '信号量'],
      content: '互斥锁是同步工具。该机制保证同一时刻只有一个执行者进入受保护的临界区，其他执行者等待锁释放。' },
    { name: '缓存一致性的定义、要素与机制', sourceNames: ['缓存一致性', '缓存一致性理论'],
      content: '缓存一致性理论是研究多个缓存副本如何遵守更新约定的理论。它规定数据发生更新后，各个副本如何协调读取结果，避免使用违反约定的旧值。' },
  ])('keeps a short definition with its adjacent own explanation: $name', async ({ name, sourceNames, content }) => {
    const { input, candidate } = teachingAspectSample(name, sourceNames, content);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.explanation).toContain(content);
  });

  it.each([
    '缓存一致性。它规定数据更新后各个副本如何协调读取结果，避免使用违反约定的旧值。',
    '缓存一致性是。它规定数据更新后各个副本如何协调读取结果，避免使用违反约定的旧值。',
    '缓存一致性是指。它规定数据更新后各个副本如何协调读取结果，避免使用违反约定的旧值。',
    '缓存一致性是一种。它规定数据更新后各个副本如何协调读取结果，避免使用违反约定的旧值。',
    '缓存一致性是协议。它是协议。它是协议。它是协议。',
    '缓存一致性是协议。请说明它在数据更新后如何协调各个副本，并完整介绍实施流程。',
    '缓存一致性是协议。缓存失效是数据更新后让旧缓存停止被读取的操作，下一次读取重新获取有效数据。',
    '缓存一致性是协议。它是，缓存失效是数据更新后让旧缓存停止被读取的操作，下一次读取重新获取有效数据。',
    '缓存一致性理论是研究多个缓存副本如何遵守更新约定的理论，能够避免读取违反更新约定的旧值。',
    '缓存一致性模型是描述多个副本之间读取规则的计算模型，能够避免读取违反更新约定的旧值。',
  ])('does not pad a missing or incomplete definition with other prose: %s', (content) => {
    const { input, candidate } = teachingAspectSample(undefined,
      ['缓存一致性', '缓存一致性模型', '缓存失效'], content);
    expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；'))
      .toContain('核心概念“缓存一致性”缺少写出概念名称');
  });

  it('accepts the saved short model definition followed by its own full explanation', async () => {
    const { input, candidate } = combinedConceptSample();
    const content = '教学理论是对教学过程中的基本原则、规律和概念的系统阐述。它基于教育学、生物学、心理学等学科的研究成果，为教师提供关于如何教学和学习的理论支持，回答的是教学应当依据什么原则和规律。教学模式是教学理论的具体化。它形成了一套相对固定的教学结构或流程，用来指导教师如何组织和实施教学，具有稳定性和可操作性，回答的是一节或一个单元的教学按什么结构推进。教学方法是教师在课堂上实际应用的具体技巧和手段。相较于教学模式，它更加灵活，可以根据学生的需要和教学情境进行调整，直接作用于师生互动，回答的是此刻在课堂上具体怎么做。';
    input.knowledgePoints[0]!.name = '教学理论、教学模式与教学方法的概念层级';
    input.knowledgePoints[0]!.sourceKnowledgePointNames = ['教学理论', '教学模式', '教学方法'];
    input.knowledgePoints[0]!.description = content;
    input.sourceContext = content;
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = content;
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
  });

  it('accepts the saved full source-declared theory name without requiring the shorter title to repeat', async () => {
    const content = '具身认知理论是一种新兴的认知科学理论。它认为认知并非只发生在大脑中，而是根植于身体及其与环境的交互之中。身体的物理特性、基本结构、感知运动系统及其活动方式，对认知的形成有决定性影响；人与环境的动态互动则是认知生成的基石。这里的人指由身体和大脑组成的整体，认知是身体、大脑与环境相互作用的结果，环境不只是认知的对象，也是认知过程的一部分。';
    const { input, candidate } = teachingAspectSample('具身认知的核心观点与身体参与',
      ['具身认知理论', '具身认知的核心观点', '身体参与与环境交互'], content);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]).toContain('"requiredDefinitionNames":["具身认知"]');
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.explanation).toContain(content);
  });

  it.each([
    { id: 'kp-4', nodeId: 'n4-core', kind: 'concept', name: '具身认知的核心观点与身体参与', canonicalName: '具身认知',
      sourceNames: ['具身认知理论', '具身认知的核心观点', '身体参与与环境交互'],
      content: '具身认知的核心观点是认知并非只发生在大脑中，而是根植于身体及其与环境的动态交互之中，身体参与是这一观点的直接体现。身体的物理特性、基本结构、感知运动系统及其活动方式对认知形成有决定性影响：我们通过触摸、品尝、嗅闻、视觉和听觉获得的经验不仅帮助我们获取知识，也塑造了认知模式。人对环境的动态互动是认知生成的基石，认知是身体、大脑与环境相互作用的结果；环境不只是认知的对象，也是认知过程的一部分。在环境中的具体身体操作，例如户外探索、书写数学公式、编程学习时的操作，同样是认知形成的重要环节。' },
    { id: 'kp-7', nodeId: 'n7-definition', kind: 'term', name: '任务驱动式教学法的定义、要素与流程', canonicalName: '任务驱动式教学法',
      sourceNames: ['任务驱动式教学法', '任务驱动法的定义', '趣味情景的创设', '任务与知识的融合'],
      content: '任务驱动式教学法的定义是：一种依托于趣味盎然、能唤起学生学习热情与探究欲望的教学情景，以紧贴课程内容的任务为核心，引导学习者在达成既定任务的过程中自然习得知识与技能的教学模式。在实施过程中，任务构成显性线索，学生知识与技能的培育与提高构成隐性脉络。所谓任务，就是把课程的知识与技能融入其中，通常源自课程设计的真实情境或实际项目；教师把学生需要学习的知识与技能组织成既符合教学内容与目标、又处在学生努力一下就能完成的难度范围内、并且充满趣味性的学习任务。它尤其适用于实验性、实践性和操作性较强的教学内容，因此在信息科技及人工智能等学科中应用频繁。' },
    { id: 'kp-8', nodeId: 'n8-core', kind: 'term', name: '支架式教学法的核心与实施过程', canonicalName: '支架式教学法',
      sourceNames: ['支架式与抛锚式教学法', '支架式教学法的核心'],
      content: '支架式教学法是一种以学生为中心的教学模式，它的核心在于教师为学生提供适当的、小步调的线索或提示，这些支架随着学生能力的提高而逐渐减少，直至学生能够独立完成任务。它依据维果斯基的最近发展区理论：教学应领先于学生的现有发展水平，引领他们从能够独立解决问题的实际水平，向在教师指导下可能达到的潜在水平提升，为此需要为学生构建支持学习的概念框架。支架类型繁多，包括引导知识建构的认知支架、激发学习动力的情感支架、提供学习策略能力支持的能力支架等，它们在不同环节扮演不同角色。在人工智能课上，它常用于难度较高的编程或建模任务。' },
  ])('preserves the complete saved $nodeId definition without copying its teaching heading', async ({ id, nodeId, kind,
    name, canonicalName, sourceNames, content }) => {
    const { input, candidate } = teachingAspectSample(name, sourceNames, content);
    input.knowledgePoints = [{ ...input.knowledgePoints[0]!, id }];
    const unit = candidate.sections[0]!.units[0]!;
    unit.knowledgePointIds = [id];
    unit.explanationNodes.forEach((node) => { node.knowledgePointIds = [id]; });
    unit.explanationNodes[0]!.id = nodeId;
    unit.explanationNodes[0]!.kind = kind;
    unit.explanationNodes[1]!.prerequisiteNodeIds = [nodeId];
    candidate.sections[0]!.pages[0]!.introducesNodeIds = [nodeId, 'n4-example'];
    const original = structuredClone(candidate);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]).toContain(`"requiredDefinitionNames":["${canonicalName}"]`);
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.explanation).toContain(content);
  });

  it('derives confirmed independent concepts from a shared suffix and teaching scope in the actual first prompt', async () => {
    const { input, candidate, definitions } = combinedConceptSample();
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![1]).toContain('"requiredDefinitionNames":["顺序结构","选择结构","循环结构"]');
    expect(ai.mock.calls[0]![1]).toContain('"requiredCoreNodeKinds":["term","concept","relation"]');
    expect(ai.mock.calls[0]![0]).toContain('每个单元至少有一个 term、concept 或 relation 节点建立自身新增认识');
    expect(ai.mock.calls[0]![0]).toContain('explanationNode.knowledgePointIds 只能包含当前 unit.knowledgePointIds');
    expect(ai.mock.calls[0]![0]).toContain('已讲概念由 prerequisiteNodeIds 引用');
    expect(ai.mock.calls[0]![1]).toContain('"fieldVariants":[{"preferredForms":["text","table","chart","illustration"]');
    expect(ai.mock.calls[0]![0]).toContain('text/table/chart/illustration 必须省略 diagram');
    expect(ai.mock.calls[0]![0]).toContain('观察对象、并排对比和阅读次序不是 sequence 节点');
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(definitions);
    const outlines = teachingBlueprintToOutlines(blueprint, '使用简体中文');
    expect(outlines[0]!.teachingBrief?.explanation).toContain(definitions);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
  });

  it('applies the same confirmed-heading contract to computing methods and a functional source definition', () => {
    const { input, candidate } = combinedConceptSample();
    input.knowledgePoints[0]!.name = '串行、并行与分布式计算的原理与适用';
    input.knowledgePoints[0]!.sourceKnowledgePointNames = ['计算组织方式', '串行计算', '并行计算（Parallel）', '分布式计算'];
    const definitions = '串行计算通过一个执行单元依次完成各项计算任务。并行计算是利用多个执行单元同时处理计算任务的方式。分布式计算用于让相互通信的不同计算机共同完成计算任务。';
    candidate.sections[0]!.units[0]!.explanationNodes[0]!.content = definitions;
    candidate.sections[0]!.units[0]!.evidenceQuotes = [definitions];
    input.knowledgePoints[0]!.description = definitions;
    input.sourceContext = definitions;
    expect(buildTeachingBlueprintPrompt(input).user).toContain('"requiredDefinitionNames":["串行计算","并行计算","分布式计算"]');
    expect(validateTeachingBlueprintDraft(candidate, input).issues).toEqual([]);
  });

  it('gives a later application unit its own core relation without repeating the already taught definitions', async () => {
    const { input, candidate, definitions } = combinedConceptSample();
    input.knowledgePoints = [...input.knowledgePoints, { ...input.knowledgePoints[0]!, id: 'kp-choice', name: '控制结构的任务选择',
      teachingRole: 'detail-concept', parentKnowledgePointIds: ['kp-4'], sourceKnowledgePointNames: ['控制结构的任务选择'] }];
    const section = candidate.sections[0]!;
    const unit = structuredClone(section.units[0]!);
    unit.id = 'u-choice';
    unit.title = '控制结构的任务选择';
    unit.knowledgePointIds = ['kp-choice'];
    const relation = '控制结构的任务选择取决于任务中的执行关系：依次操作使用顺序结构，条件决定执行分支时使用选择结构，需要重复相同操作时使用循环结构。';
    unit.explanationNodes = [{ ...unit.explanationNodes[0]!, id: 'choice-relation', kind: 'relation', content: relation,
      knowledgePointIds: ['kp-choice'], prerequisiteNodeIds: ['n4-core'] },
    { ...unit.explanationNodes[1]!, id: 'choice-reasoning', kind: 'mechanism',
      content: '名单中每个人都需要收到同样的通知，所以任务含有重复相同操作的关系，应采用循环结构；只有温度超过阈值才提示，则需要条件判断和选择分支。',
      knowledgePointIds: ['kp-choice'], prerequisiteNodeIds: ['choice-relation'] }];
    section.units.push(unit);
    section.understandingCriteria.supportingUnitIds.push(unit.id);
    const page = structuredClone(section.pages[0]!);
    page.id = 'p-choice';
    page.unitIds = [unit.id];
    page.introducesNodeIds = ['choice-relation', 'choice-reasoning'];
    page.referencesNodeIds = ['n4-core'];
    page.deepensNodeIds = [];
    page.keyPoints = [relation];
    page.title = unit.title;
    section.pages.push(page);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.units[1]!.explanation).toBe(relation);
    expect(blueprint.sections[0]!.units[1]!.explanationNodes?.every((node) => node.knowledgePointIds?.join() === 'kp-choice'))
      .toBe(true);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[1]!.teachingBrief?.explanation).not.toContain(definitions);
    for (const mutation of ['mechanism only', 'authoring task']) {
      const invalid = structuredClone(candidate);
      const later = invalid.sections[0]!.units[1]!;
      if (mutation === 'mechanism only') {
        later.explanationNodes.shift();
        later.explanationNodes[0]!.prerequisiteNodeIds = ['n4-core'];
        invalid.sections[0]!.pages[1]!.introducesNodeIds = ['choice-reasoning'];
      } else later.explanationNodes[0]!.content = '请解释如何根据任务选择合适的控制结构，并举例说明选择理由。';
      expect(validateTeachingBlueprintDraft(invalid, input).issues.join('；')).toMatch(/缺少必要字段|核心解释仍是待办任务/u);
    }
  });

  it.each([
    { topic: 'the saved three-level teaching definition', name: '教学理论、教学模式与教学方法的概念层级',
      sourceNames: ['教学理论', '教学模式', '教学方法'],
      definitions: '教学理论、教学模式与教学方法的概念层级。教学理论是对教学过程中的基本原则、规律和概念的系统阐述，它基于教育学、生物学、心理学等学科的研究成果，为教师提供关于如何教学和学习的理论支持，回答的是教学应当遵循什么这一层面的问题。教学模式是教学理论的具体化，它形成了一套相对固定的教学结构或流程，用来指导教师如何组织和实施教学，回答的是一节课按什么结构展开的问题，具有稳定性和可操作性。教学方法则是教师在课堂上实际应用的具体技巧和手段，相较于教学模式它更加灵活，可以根据学生的需要和教学情境进行调整，回答的是此刻用什么做法的问题。三层构成从原则到结构再到具体手段的层级，理论最抽象也最稳定，模式居中，方法最贴近现场也最灵活。' },
    { topic: 'control structures used within one another', name: '顺序、选择与循环结构的含义与用途',
      sourceNames: ['顺序结构', '选择结构', '循环结构'],
      definitions: '顺序结构是选择结构和循环结构内部也会使用的基本执行方式，语句按照排列顺序依次执行。选择结构则是根据条件决定执行分支的结构，相较于顺序结构它允许程序沿不同路径运行。循环结构是对顺序结构中的一组操作进行重复执行的控制结构，直到循环条件不再满足。' },
    { topic: 'entities, attributes and relations', name: '实体、属性与关系的含义与用途',
      sourceNames: ['实体', '属性', '关系'],
      definitions: '实体是具有属性并与其他实体通过关系相连的现实对象或抽象对象。属性则是用于刻画实体特征的数据项，关系表示不同实体之间具有的联系。关系是实体之间的联系，它可以通过实体的属性记录表达，也可以单独建模。' },
  ])('preserves legal references to other concepts within $topic', async ({ name, sourceNames, definitions }) => {
    const { input, candidate } = combinedConceptSample();
    const point = input.knowledgePoints[0]!;
    point.name = name;
    point.sourceKnowledgePointNames = sourceNames;
    point.description = definitions;
    input.sourceContext = definitions;
    const unit = candidate.sections[0]!.units[0]!;
    unit.title = name;
    unit.evidenceQuotes = [definitions];
    unit.explanationNodes[0]!.content = definitions;
    candidate.sections[0]!.pages[0]!.keyPoints = definitions.split('。').filter(Boolean);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(definitions);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
  });

  it.each(['incomplete sources', 'ambiguous sources', 'necessary parenthetical condition', 'missing independent definition',
    'heading and authoring task', 'heading and another concept definition', 'heading colon and another concept definition',
    'short predicate and another concept definition', 'not taught'])
    ('keeps the independent-definition gate for %s', (mutation) => {
      const { input, candidate } = combinedConceptSample();
      const section = candidate.sections[0]!;
      const node = section.units[0]!.explanationNodes[0]!;
      if (mutation === 'incomplete sources') input.knowledgePoints[0]!.sourceKnowledgePointNames = ['顺序结构', '选择结构'];
      if (mutation === 'ambiguous sources') input.knowledgePoints[0]!.sourceKnowledgePointNames!.push('选择表达式');
      if (mutation === 'necessary parenthetical condition') input.knowledgePoints[0]!.sourceKnowledgePointNames![2] = '选择结构（只有一个分支执行）';
      if (mutation === 'missing independent definition') node.content = node.content.replace(/选择结构[^。]+。/u, '');
      if (mutation === 'heading and authoring task') node.content = node.content.replace(/选择结构[^。]+。/u, '选择结构：请介绍这种结构的含义并说明它在程序中的实际用途。');
      if (mutation === 'heading and another concept definition') node.content = node.content.replace(/选择结构[^。]+。/u,
        '选择结构 顺序结构是按照语句的排列顺序依次执行各条语句的控制结构。');
      if (mutation === 'heading colon and another concept definition') node.content = node.content.replace(/选择结构[^。]+。/u,
        '选择结构：顺序结构是按照语句的排列顺序依次执行各条语句的控制结构。');
      if (mutation === 'short predicate and another concept definition') node.content = node.content.replace(/选择结构[^。]+。/u,
        '选择结构是，顺序结构是按照语句的排列顺序依次执行各条语句的控制结构。');
      if (mutation === 'not taught') {
        section.pages[0]!.introducesNodeIds = section.pages[0]!.introducesNodeIds.filter((id) => id !== node.id);
        section.pages[0]!.referencesNodeIds.push(node.id);
      }
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toMatch(/核心概念.*(?:缺少|未由任何页面)/u);
    });

  it('accepts the entire confirmed proposition with a grammatical copula and no model call', async () => {
    const { input, candidate } = sample('concept');
    const original = structuredClone(candidate);
    const ai = vi.fn();
    const blueprint = await generateTeachingBlueprint(input, ai, { repairFrom: { candidate, issues: [] } });
    expect(ai).not.toHaveBeenCalled();
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content)
      .toBe(fixture.concept.unit.explanationNodes[0]!.content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(buildTeachingBlueprintPrompt(input).system).toContain('定义要同时讲清主题和完整主张');
  });

  it.each(['only subject', 'only claim', 'changed claim', 'negated claim', 'authoring task', 'only heading', 'wrong kind'])
    ('keeps the definition gate for %s', (mutation) => {
      const { input, candidate } = sample('concept');
      const node = candidate.sections[0]!.units[0]!.explanationNodes[0]!;
      if (mutation === 'only subject') node.content = '具身认知的核心观点是本节要讨论的主题，下面将说明它在课堂活动中的应用方式。';
      if (mutation === 'only claim') node.content = '认知根植于身体与环境的交互。身体经验参与概念的形成，环境也是认知过程的一部分。';
      if (mutation === 'changed claim') node.content = node.content.replace('认知根植于身体与环境的交互', '认知只存在于大脑内部');
      if (mutation === 'negated claim') node.content = node.content.replace('核心观点是：', '核心观点不是：');
      if (mutation === 'authoring task') node.content = `请介绍${input.knowledgePoints[0]!.name}，并结合学习者特点设计讲解。`;
      if (mutation === 'only heading') node.content = input.knowledgePoints[0]!.name;
      if (mutation === 'wrong kind') node.kind = 'example';
      expect(validateTeachingBlueprintDraft(candidate, input).issues.join('；')).toContain('缺少写出概念名称');
    });

  it.each(['：', '是：', '是:', '是'])('applies the same complete-proposition rule to feedback with the link %s', async (link) => {
    const { input, candidate } = sample('concept');
    const name = '反馈的核心观点：输出影响后续输入';
    const content = `反馈的核心观点${link}输出影响后续输入。系统读取输出所反映的状态，再以此调整下一次输入，作用可以增强也可以抑制原有变化。`;
    const point = input.knowledgePoints[0]!;
    point.name = name;
    point.description = content;
    point.sourceKnowledgePointNames = ['反馈', '反馈的核心观点'];
    input.courseTitle = '控制系统';
    input.subject = '信息科技';
    input.sourceContext = content;
    const section = candidate.sections[0]!;
    section.units[0]!.title = name;
    section.units[0]!.evidenceQuotes = [content];
    section.units[0]!.explanationNodes[0]!.content = content;
    section.units[0]!.explanationNodes[1]!.content = '控制器读取实际温度与目标温度的差异，随后调整加热功率。输入调整依据实际输出，形成反馈作用。';
    section.sharedContext.stableTerms = ['反馈'];
    section.sharedContext.conceptBoundaries = ['反馈作用可以增强或抑制变化，不等于单向传递信息。'];
    section.pages[0]!.title = '反馈';
    section.pages[0]!.keyPoints = ['反馈的核心观点是输出影响后续输入。', '反馈作用可以增强或抑制变化。'];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(ai.mock.calls[0]![0]).toContain('无需在口语陈述中重复标题冒号');
    expect(ai.mock.calls[0]![1]).toContain('可自然连接为‘主题是主张’');
    expect(ai.mock.calls[0]![1]).toContain('"requiredPropositions":[{"subject":"反馈的核心观点","assertion":"输出影响后续输入"');
    expect(ai.mock.calls[0]![0]).toContain('组成概念都被定义了，也不等于已说明它们与 subject 的关系');
    expect(ai.mock.calls[0]![0]).toContain('明确区分资料中已发生的事实、假设条件、教学建议和预计结果');
    expect(ai.mock.calls[0]![0]).toContain('‘如果A则B’不等于‘只有A才B’');
    for (const mutation of ['only subject', 'only claim', 'partial claim', 'negated claim', 'only statement', 'dispersed claim',
      'authoring task', 'wrong kind', 'not owned', 'missing knowledge ownership']) {
      const invalid = structuredClone(candidate);
      const node = invalid.sections[0]!.units[0]!.explanationNodes[0]!;
      if (mutation === 'only subject') node.content = '反馈的核心观点是这一节讨论的对象，随后用控制器实例说明系统的作用。';
      if (mutation === 'only claim') node.content = '输出影响后续输入。系统读取输出反映的状态，并据此调整下一次输入。';
      if (mutation === 'partial claim') node.content = content.replace('输出影响后续输入', '输出影响');
      if (mutation === 'negated claim') node.content = '反馈的核心观点不是输出影响后续输入。系统读取输出所反映的状态，随后改变控制器的执行方式。';
      if (mutation === 'only statement') node.content = `反馈的核心观点${link}输出影响后续输入。`;
      if (mutation === 'dispersed claim') node.content = '反馈的核心观点是系统具有多个输入和输出。一个过程中的输出影响后续输入，可以据此调整系统下一轮的操作。';
      if (mutation === 'authoring task') node.content = '请解释反馈的核心观点是输出影响后续输入，并说明反馈作用的具体含义。';
      if (mutation === 'wrong kind') node.kind = 'example';
      if (mutation === 'missing knowledge ownership') node.knowledgePointIds = [];
      if (mutation === 'not owned') {
        invalid.sections[0]!.pages[0]!.introducesNodeIds = ['n4-example'];
        invalid.sections[0]!.pages[0]!.referencesNodeIds = ['n4-core'];
      }
      expect(validateTeachingBlueprintDraft(invalid, input).issues.join('；'))
        .toMatch(/核心概念.*(?:缺少|未由任何页面)/u);
    }
  });

  it('accepts the saved complete natural statement of assimilation and accommodation in its owned concept node', async () => {
    const { input, candidate } = sample('concept');
    const name = '建构主义的核心机制：同化与顺应';
    const content = '建构主义的核心机制是同化与顺应。建构主义认为知识不是被动接收的，而是学习者通过与环境互动主动建构的。皮亚杰用同化和顺应解释这一过程：同化是把新信息纳入原有认知结构，顺应是在新信息与原有结构冲突时调整认知结构。二者共同推动认知发展，所以教学中真正关键的不是把结论再讲一遍，而是让学生的原有结构与新信息发生接触，并在冲突出现时引导他们调整结构。';
    const source = '在小鱼尝试理解“牛”这一概念的过程中,它实际上经历了“同化”与“顺应”这两个认知发展的基本阶段。“同化”是指将新的信息或经验与个体现有的认知结构相融合的过程。在这个阶段,孩子们会依赖他们已有的知识框架来解释和理解新的刺激,将新知识吸收进他们的认知体系。这一过程相对简单,因为它不要求对现存的认知结构进行根本性的改变。相反,“顺应”则是一个更为复杂和挑战性的过程,它要求儿童调整或重塑他们的认知结构以适应新的信息。当新的数据与既有的知识体系不兼容或发生冲突时,孩子们必须对他们的认知结构进行重组或扩展,以便容纳这些新的知识。';
    input.knowledgePoints = [{ ...input.knowledgePoints[0]!, id: 'kp-2', name,
      description: '同化是把新信息纳入原有认知结构，顺应是在新信息与原有结构冲突时调整认知结构。',
      sourceKnowledgePointNames: ['建构主义学习理论', '同化与顺应的认知机制'] }];
    input.sourceContext = source;
    const section = candidate.sections[0]!;
    const unit = section.units[0]!;
    unit.id = 'unit-s2-kp2';
    unit.title = name;
    unit.knowledgePointIds = ['kp-2'];
    unit.evidenceQuotes = ['“同化”是指将新的信息或经验与个体现有的认知结构相融合的过程。'];
    unit.explanationNodes[0] = { ...unit.explanationNodes[0]!, id: 's2-con-core', content,
      knowledgePointIds: ['kp-2'], prerequisiteNodeIds: [] };
    unit.explanationNodes[1] = { ...unit.explanationNodes[1]!, id: 's2-condition', kind: 'condition',
      content: '新信息与既有知识体系不兼容或发生冲突时，学习者需要重组或扩展原有认知结构，不能只把新信息纳入未改变的旧结构。',
      knowledgePointIds: ['kp-2'], prerequisiteNodeIds: ['s2-con-core'] };
    section.sharedContext.stableTerms = ['同化', '顺应'];
    section.sharedContext.conceptBoundaries = ['同化不要求根本改变原有结构；顺应在新信息冲突时要求调整结构。'];
    section.understandingCriteria.supportingUnitIds = [unit.id];
    section.pages[0]!.id = 's2-p1';
    section.pages[0]!.unitIds = [unit.id];
    section.pages[0]!.introducesNodeIds = ['s2-con-core', 's2-condition'];
    section.pages[0]!.keyPoints = ['建构主义的核心机制是同化与顺应。',
      '同化把新信息纳入原有结构；顺应在新信息与原有结构冲突时调整结构。'];
    const original = structuredClone(candidate);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input, ai);
    expect(ai).toHaveBeenCalledOnce();
    expect(candidate).toEqual(original);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes?.[0]?.content).toBe(content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
    expect(teachingBlueprintToOutlines(blueprint, '使用简体中文')[0]!.teachingBrief?.explanation).toContain(content);
  });

  it('projects the existing orphan verbatim into its unique unit page and compiled lecture', async () => {
    const { input, candidate } = sample('orphan');
    const original = structuredClone(candidate);
    const ai = vi.fn();
    const blueprint = await generateTeachingBlueprint(input, ai, { repairFrom: { candidate, issues: [] } });
    expect(ai).not.toHaveBeenCalled();
    expect(candidate).toEqual(original);
    const section = blueprint.sections[0]!;
    expect(section.pages[0]!.introducesNodeIds).toEqual(section.units[0]!.explanationNodes?.map((node) => node.id));
    expect(section.units[0]!.explanationNodes?.map((node) => node.content))
      .toEqual(original.sections[0]!.units[0]!.explanationNodes.map((node) => node.content));
    const outlines = teachingBlueprintToOutlines(blueprint, '使用简体中文');
    expect(JSON.stringify(outlines[0]!.teachingBrief)).toContain(fixture.orphan.unit.explanationNodes[3]!.content);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues).toEqual([]);
  });

  it('inserts an omitted middle node without changing authored node order', () => {
    const { input, candidate } = sample('orphan');
    const section = candidate.sections[0]!;
    section.pages[0]!.introducesNodeIds = ['n9-core', 'n9-process', 'n9-example'];
    const result = validateTeachingBlueprintDraft(candidate, input);
    expect(result.issues).toEqual([]);
    expect(result.blueprint!.sections[0]!.pages[0]!.introducesNodeIds)
      .toEqual(result.blueprint!.sections[0]!.units[0]!.explanationNodes?.map((node) => node.id));
  });

  it.each(['two owners', 'references only', 'missing knowledge ownership', 'later prerequisite',
    'same-unit reversed prerequisite', 'measured page'])('does not guess an orphan with %s', (mutation) => {
    const { input, candidate } = sample('orphan');
    const section = candidate.sections[0]!;
    const page = section.pages[0]!;
    const orphan = section.units[0]!.explanationNodes[3]!;
    if (mutation === 'two owners') section.pages.push({ ...structuredClone(page), id: 'second', introducesNodeIds: [] });
    if (mutation === 'references only') page.referencesNodeIds.push(orphan.id);
    if (mutation === 'missing knowledge ownership') orphan.knowledgePointIds = [];
    if (mutation === 'measured page') Object.assign(page, { sectionPlanVersion: 1 });
    if (mutation === 'later prerequisite') {
      const laterUnit = structuredClone(section.units[0]!);
      laterUnit.id = 'later-unit';
      laterUnit.explanationNodes = [{ ...structuredClone(orphan), id: 'later-node', prerequisiteNodeIds: [] }];
      section.units.push(laterUnit);
      section.pages.push({ ...structuredClone(page), id: 'later-page', unitIds: [laterUnit.id], introducesNodeIds: ['later-node'] });
      orphan.prerequisiteNodeIds = ['later-node'];
    }
    if (mutation === 'same-unit reversed prerequisite') {
      page.introducesNodeIds = ['n9-core', 'n9-example'];
      section.units[0]!.explanationNodes[1]!.prerequisiteNodeIds = ['n9-process'];
    }
    const result = validateTeachingBlueprintDraft(candidate, input);
    expect(result.issues.join('；')).toContain('未分配给任何页面');
    expect(result.blueprint).toBeUndefined();
  });

  it('does not change accepted page ownership on stored-plan validation', async () => {
    const { input, candidate } = sample('orphan');
    const blueprint = await generateTeachingBlueprint(input, vi.fn(), { repairFrom: { candidate, issues: [] } });
    blueprint.sections[0]!.pages[0]!.introducesNodeIds = blueprint.sections[0]!.pages[0]!.introducesNodeIds!.slice(0, 3);
    expect(revalidateStoredTeachingBlueprint(blueprint, input).issues.join('；')).toContain('未分配给任何页面');
    expect(validateTeachingBlueprintDraft(blueprint, input).issues.join('；')).toContain('未分配给任何页面');
  });
});
