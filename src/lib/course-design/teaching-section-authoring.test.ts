import { describe, expect, it, vi } from 'vitest';
import { buildSpokenSectionRequest, compileSpokenSection, generateSpokenTeachingBlueprint, spokenBlueprintIssues,
  LEGACY_SPOKEN_SECTION_POLICY, PREVIOUS_NATIVE_SPOKEN_SECTION_POLICY, SPOKEN_SECTION_POLICY, savedSpokenSectionPolicy } from './teaching-section-authoring';
import { adaptTeachingBlueprintResourceCapabilities, applyReviewedOutlinesToTeachingBlueprint, generateTeachingBlueprint, revalidateStoredTeachingBlueprint, teachingBlueprintToOutlines,
  validateTeachingBlueprintBudget, type TeachingBlueprintInput } from './teaching-blueprint';
import { PPT_PAGE_PLANNING_CONTRACT, PPT_PAGE_PLANNING_VERSION } from './ppt-page-planning-contract';
import { mergeSourceSequenceUses, scopeSourceSequenceContracts } from '@/lib/textbook/source-sequence-use';

function input(): TeachingBlueprintInput {
  return { courseTitle: '分类', subject: '信息科技', grade: '高中', learningObjectives: ['理解训练与检验'],
    projectContext: '', assessmentMode: 'adaptive', generationMode: 'standard', totalDurationSec: 600,
    knowledgePoints: [{ id: 'k1', name: '训练', description: '这份上游生成解释不应成为口播依据', level: 'core', evidenceItemIds: ['e1'] },
      { id: 'k2', name: '检验', description: '', level: 'core' }],
    sectionPlans: [{ title: '训练', knowledgePointIds: ['k1'], teachingBudgetSec: 264 },
      { title: '检验', knowledgePointIds: ['k2'], teachingBudgetSec: 264 }],
    sourceEvidence: { schemaVersion: 2, version: 1, fingerprint: 'source-v1', createdAt: '', retrievalMode: 'hybrid', selections: [], mappings: [], warnings: [],
      items: [{ id: 'e1', kind: 'source-block', title: '训练', content: '摘要不能覆盖完整原文',
        source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'r1', revisionVersion: 1, sectionPath: ['训练'], sourceBlockId: 'b1' },
        completeSourceBlocks: [{ sourceBlockId: 'b1', content: '训练集用于学习模型参数。' }, { sourceBlockId: 'b2', content: '教材中完整的对应案例。' }] }] } };
}

function response(index: number) {
  return JSON.stringify({ learningObjective: index === 0 ? '解释训练用途' : '解释检验用途',
    segments: [{ id: 's1', kind: 'concept', text: `这是小节${index + 1}的真实完整口播。`, knowledgePointIds: [`k${index + 1}`], sourceRefs: index === 0 ? ['e1:b1'] : [] },
      { id: 's2', kind: 'example', text: '接着用完整案例继续解释。', knowledgePointIds: [`k${index + 1}`], sourceRefs: [] }],
    pages: [{ title: '用途与例子', type: 'slide', segmentIds: ['s1', 's2'],
      description: '通过用途与完整案例建立本节认识，再进入对应检验。', keyPoints: ['显示要点'],
      teachingObjective: '理解用途与案例之间的关系', estimatedTeachingWeight: 2,
      entryPoint: { kind: 'direct-explanation', object: '本节的实际用途', bridge: '通过案例建立用途' },
      resourceNeeds: [] }] });
}

function legacyResponse(index: number) {
  const raw = JSON.parse(response(index));
  raw.pages = [{ title: '用途与例子', type: 'slide', segmentIds: ['s1', 's2'],
    presentationItems: [{ text: '旧显示要点', nodeIds: ['s1'], role: 'key-point' }], resourceNeeds: [] }];
  return JSON.stringify(raw);
}

// Adopted passage from the real course where the image-enabled first draft
// retained the fish/cow story but omitted every generated-media request.
const fishCaseSource = '青蛙向池塘中的小鱼描绘它所见的“牛”这种生物，描述道：“它头上有两只角”，“有四条腿”，“在草地上吃草”，并且“身上有花斑”。然而，根据青蛙的描述，小鱼在脑海中构建的形象是一个奇特的生物，它虽然满足了这些特征，但仍然基于鱼的形态进行想象。';
function fishCaseInput(): TeachingBlueprintInput {
  const source = input();
  source.knowledgePoints = [source.knowledgePoints[0]!];
  source.sectionPlans = [{ title: '已有经验参与新信息的理解', knowledgePointIds: ['k1'], teachingBudgetSec: 528 }];
  source.sourceEvidence!.items[0]!.completeSourceBlocks = [{ sourceBlockId: 'b1', content: fishCaseSource }];
  return source;
}

describe('source-first spoken sections', () => {
  it('retains the authored page meaning and weights through compilation and teacher confirmation without a display projection', async () => {
    const source = input();
    const authored = JSON.parse(response(0));
    authored.sharedContext = { learningPurpose: '解释不同数据的职责', caseId: '', caseFacts: ['同一分类任务'],
      fixedWording: [], stableTerms: ['模型参数'], conceptBoundaries: ['检验数据不参与参数学习'] };
    authored.pages[0].taskConnection = { mode: 'none', rationale: '直接理解数据职责' };
    authored.pages[0].presentationItems = [{ text: '多余旧投影不能覆盖页要点', nodeIds: ['不存在的段落'], role: 'key-point' }];
    const author = vi.fn(async (_request, index: number) => index === 0 ? JSON.stringify(authored) : response(index));
    const blueprint = await generateSpokenTeachingBlueprint(source, 'joint-pages', author);
    const page = blueprint.sections[0]!.pages[0]!;
    expect(page).toMatchObject({ description: authored.pages[0].description, keyPoints: authored.pages[0].keyPoints,
      teachingObjective: authored.pages[0].teachingObjective, estimatedTeachingWeight: 2,
      entryPoint: authored.pages[0].entryPoint, taskConnection: authored.pages[0].taskConnection });
    expect(page).not.toHaveProperty('presentationItems');
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    expect(outlines[0]).toMatchObject({ description: page.description, keyPoints: page.keyPoints,
      teachingBrief: { pptPlanningVersion: PPT_PAGE_PLANNING_VERSION, sharedContext: authored.sharedContext,
        teachingPlan: { entryPoint: page.entryPoint, taskConnection: page.taskConnection } } });
    expect(outlines[0]!.teachingBrief!.teachingPlan).not.toHaveProperty('presentationItems');
    expect(outlines[0]!.teachingBrief!.teachingPlan!.presentationContent).toEqual(page.keyPoints);
    const approved = applyReviewedOutlinesToTeachingBlueprint(blueprint, outlines);
    expect(approved.sections[0]!.pages[0]).toEqual(page);
    expect(approved.sections[0]!.units).toEqual(blueprint.sections[0]!.units);
    expect(author).toHaveBeenCalledTimes(2);
  });

  it('keeps page-count guidance diagnostic even when a complete first draft falls outside its range', () => {
    const source = input();
    const request = buildSpokenSectionRequest(source, 0);
    const context = JSON.parse(request.prompt).pagePlanningContext;
    expect(context).toMatchObject({ teachingBudgetSec: 264, suggestedPageRange: [2, 3],
      courseSections: [{ title: '训练', knowledgePointIds: ['k1'] }, { title: '检验', knowledgePointIds: ['k2'] }] });
    const raw = JSON.parse(response(0));
    raw.segments = Array.from({ length: 4 }, (_, index) => ({ ...raw.segments[0], id: `s${index + 1}`,
      text: `第${index + 1}项独立分析的完整解释。` }));
    raw.pages = raw.segments.map((segment: { id: string }, index: number) => ({ ...raw.pages[0],
      title: `独立分析${index + 1}`, segmentIds: [segment.id] }));
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(section.pages).toHaveLength(4);
    expect(section.units[0]!.explanationNodes).toHaveLength(4);
    expect(section.qualityDiagnostics).toContainEqual(expect.stringContaining('首稿 4 页'));
    expect(section.teachingDurationSec + section.learnerActivityDurationSec + section.assessmentDurationSec).toBe(300);
  });

  it.each(['source-spoken-section-v99', '', 99])('rejects an explicit unknown saved contract (%s) without falling back to the legacy planner', (authoringPolicy) => {
    const state = { authoringPolicy, attemptsStarted: 1, rawResponse: response(0) };
    const original = structuredClone(state);
    expect(() => savedSpokenSectionPolicy([{ state }])).toThrow('未知的联合创作合同');
    expect(state).toEqual(original);
  });

  it('restores each saved authoring policy with its original compiler rather than silently upgrading it', async () => {
    expect(savedSpokenSectionPolicy([])).toBe(SPOKEN_SECTION_POLICY);
    expect(savedSpokenSectionPolicy([{ state: { rawResponse: legacyResponse(0) } }])).toBe(LEGACY_SPOKEN_SECTION_POLICY);
    expect(savedSpokenSectionPolicy([{ state: { attemptsStarted: 1 } }])).toBe(LEGACY_SPOKEN_SECTION_POLICY);
    expect(savedSpokenSectionPolicy([{ state: { authoringPolicy: SPOKEN_SECTION_POLICY, rawResponse: response(0) } }])).toBe(SPOKEN_SECTION_POLICY);
    expect(() => savedSpokenSectionPolicy([{ state: { rawResponse: legacyResponse(0) } },
      { state: { authoringPolicy: SPOKEN_SECTION_POLICY } }])).toThrow('合同冲突');
    const oldRequest = buildSpokenSectionRequest(input(), 0, [], LEGACY_SPOKEN_SECTION_POLICY);
    const newRequest = buildSpokenSectionRequest(input(), 0);
    expect(oldRequest.fingerprint).not.toBe(newRequest.fingerprint);
    const legacy = await generateSpokenTeachingBlueprint(input(), 'legacy', async (_request, index) => legacyResponse(index),
      undefined, LEGACY_SPOKEN_SECTION_POLICY);
    const modern = await generateSpokenTeachingBlueprint(input(), 'modern', async (_request, index) => response(index));
    expect(legacy.sections[0]).not.toHaveProperty('pptPlanningVersion');
    expect(legacy.sections[0]!.pages[0]!.presentationItems![0]!.text).toBe('旧显示要点');
    expect(modern.sections[0]!.pptPlanningVersion).toBe(PPT_PAGE_PLANNING_VERSION);
    expect(modern.sections[0]!.pages[0]).not.toHaveProperty('presentationItems');
    for (const blueprint of [legacy, modern]) {
      const before = structuredClone(blueprint);
      const aiCall = vi.fn();
      const restored = await generateTeachingBlueprint(input(), aiCall, { repairFrom: {
        candidate: blueprint, issues: ['saved diagnostic'], preserveAcceptedPagePlans: true,
      } });
      expect(aiCall).not.toHaveBeenCalled();
      expect(restored.sections).toEqual(before.sections);
      expect(blueprint).toEqual(before);
    }
  });

  it('groups long continuous paragraphs by their adopted visual task and preserves speech and source bindings when split', () => {
    const source = input(), request = buildSpokenSectionRequest(source, 0), raw = JSON.parse(response(0));
    raw.segments[0].text = '训练集用于学习模型参数，接着观察同一个学习任务中的实际记录。'.repeat(100);
    raw.segments[1].text = '在这个任务中，用具体案例继续解释记录和参数的关系。'.repeat(100);
    raw.pages[0].keyPoints = ['训练集用于学习模型参数。'];
    const combined = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    const first = structuredClone(raw.pages[0]);
    raw.pages = [{ ...first, segmentIds: ['s1'] }, { ...first, title: '对应观察', segmentIds: ['s2'],
      keyPoints: ['观察记录与参数的关系。'] }];
    const split = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(combined.pages).toHaveLength(1);
    expect(split.pages).toHaveLength(2);
    expect(split.units.flatMap((unit) => unit.explanationNodes ?? []))
      .toEqual(combined.units.flatMap((unit) => unit.explanationNodes ?? []));
    expect(split.pages.flatMap((page) => page.introducesNodeIds ?? []))
      .toEqual(combined.pages.flatMap((page) => page.introducesNodeIds ?? []));
    expect(split.units.flatMap((unit) => unit.knowledgePointIds)).toEqual(combined.units.flatMap((unit) => unit.knowledgePointIds));
    expect(combined.units.flatMap((unit) => unit.explanationNodes!.map((node) => node.content)))
      .toEqual(raw.segments.map((segment: { text: string }) => segment.text));
    expect(JSON.parse(request.prompt).pagePlanningContract).toEqual(PPT_PAGE_PLANNING_CONTRACT);
    expect(request.authoringPolicy).toBe(SPOKEN_SECTION_POLICY);
    expect(combined.pages[0]!.keyPoints).toEqual(['训练集用于学习模型参数。']);
    expect(combined.pages[0]).not.toHaveProperty('presentationItems');
    expect(combined.qualityDiagnostics).toContainEqual(expect.stringContaining('保留实际内容与分页'));
  });

  it.each([
    ['direct knowledge', '训练集用于学习模型参数。'],
    ['precise conditions and quantities', '训练集用于学习模型参数。在本例的100个样本中，80个用于训练，20个留作检验。检验样本不参与参数学习。'],
    ['author comparison', '甲作者强调训练集用于学习模型参数。乙作者强调训练集与检验集的用途不同。'],
    ['scoped standard', '标准甲规定的训练数据划分适用于它覆盖的任务，不代表所有任务都必须按同一比例划分。'],
  ])('prompts direct teaching while preserving sourced %s speech and bindings', (_scenario, speech) => {
    const source = input();
    source.sourceEvidence!.items[0]!.completeSourceBlocks![0]!.content = speech;
    const request = buildSpokenSectionRequest(source, 0);
    expect(request.system).toContain('不加“教材指出”“教材中提到”“书中说”“根据提供的资料”等无教学作用的来源前缀');
    expect(request.system).toContain('保留权威定义、事实、数量、否定、不确定性和必要条件');
    expect(request.system).toContain('来源编号和证据关系放在 sourceRefs 等后台字段');
    expect(request.system).toContain('比较不同作者观点、分析原文措辞或说明特定标准的适用范围');
    expect(request.system).toContain('不将特定观点或有范围的规定讲成普遍结论');
    const authored = JSON.parse(response(0));
    authored.segments[0].text = speech;
    const section = compileSpokenSection(JSON.stringify(authored), source, 0, request);
    expect(section.units[0]!.explanationNodes![0]).toMatchObject({
      id: 'teaching-section-1:s1', content: speech,
      sourceBindings: [{ evidenceItemId: 'e1', sourceBlockIds: ['b1'], textbookId: 'book', revisionId: 'r1' }],
    });
    expect(section.units[0]!.explanationNodes!.map((node) => node.id)).toEqual(['teaching-section-1:s1', 'teaching-section-1:s2']);
    expect(source.sourceEvidence!.items[0]!.completeSourceBlocks![0]!.content).toBe(speech);
  });

  it('writes each confirmed section once from original blocks and conserves the full stage budget', async () => {
    const author = vi.fn(async (_request, index: number) => response(index));
    const blueprint = await generateSpokenTeachingBlueprint(input(), 'input', author);
    expect(author).toHaveBeenCalledTimes(2);
    expect(author.mock.calls[0]![0].prompt).toContain('教材中完整的对应案例');
    expect(author.mock.calls[0]![0].prompt).not.toContain('这份上游生成解释不应成为口播依据');
    expect(JSON.parse(author.mock.calls[0]![0].prompt).learningObjectives).toEqual(['理解训练与检验']);
    expect(JSON.parse(author.mock.calls[0]![0].prompt).scope.knowledgePoints[0]).not.toHaveProperty('masteryBoundary');
    expect(JSON.parse(author.mock.calls[0]![0].prompt).scope.role).toContain('不是事实依据');
    expect(JSON.parse(author.mock.calls[0]![0].prompt)).not.toHaveProperty('additionalSourceContext');
    expect(author.mock.calls[1]![0].prompt).toContain('接着用完整案例继续解释');
    expect(blueprint.budget.totalDurationSec).toBe(600);
    expect(blueprint.budget.assessmentDurationSec).toBe(72);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.sourceBindings).toEqual([
      { evidenceItemId: 'e1', sourceBlockIds: ['b1'], textbookId: 'book', revisionId: 'r1' },
    ]);
    expect(blueprint.sections.every((section) => section.units.every((unit) => unit.explanation === ''))).toBe(true);
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    expect(outlines.every((outline) => outline.teachingBrief?.explanation === '')).toBe(true);
    expect(outlines.filter((outline) => outline.type !== 'quiz').every((outline) => outline.teachingBrief?.teachingPlan?.newContent === '')).toBe(true);
    expect(validateTeachingBlueprintBudget(blueprint, outlines)).toEqual([]);
    expect(outlines[0]!.teachingBrief?.manuscript).toEqual({ sectionId: 'teaching-section-1',
      segmentIds: ['teaching-section-1:s1', 'teaching-section-1:s2'] });
    expect(outlines[1]!.teachingBrief?.manuscript).toEqual(outlines[0]!.teachingBrief?.manuscript);
    expect(outlines[0]!.teachingBrief).not.toHaveProperty('authoring');
    expect(blueprint).not.toHaveProperty('knowledgeAuthoring');
    expect(revalidateStoredTeachingBlueprint(blueprint, input()).blueprint).toBe(blueprint);
  });

  it('honors an explicitly cleared evidence selection without restoring sources through context or old mappings', () => {
    const source = input();
    source.knowledgePoints[0]!.evidenceItemIds = [];
    source.sourceContext = '旧检索上下文不应越过教师确认来源';
    source.sourceEvidence!.mappings = [{ sourceKnowledgePointId: 'k1', sourceKnowledgePointName: '训练',
      evidenceItemIds: ['e1'], status: 'direct', rationale: '已保存检索映射' }];
    const request = buildSpokenSectionRequest(source, 0);
    expect(request.sourceBlocks).toEqual([]);
    expect(request.prompt).not.toContain('旧检索上下文');
    expect(request.prompt).not.toContain('训练集用于学习模型参数');
    delete source.knowledgePoints[0]!.evidenceItemIds;
    expect(buildSpokenSectionRequest(source, 0).sourceBlocks).toHaveLength(2);
  });

  it('sends the complete adopted source unit rather than only its retrieval quote, while saved native requests keep their identity', () => {
    const source = input(), item = source.sourceEvidence!.items[0]!;
    item.completeSourceBlocks = undefined;
    item.source.sourceBlockIds = ['b1', 'b2'];
    item.source.quote = '第一项说明身体的基础作用。';
    item.content = `${item.source.quote}\n第二项说明环境也是认知系统的一部分。`;
    const previous = buildSpokenSectionRequest(source, 0, [], PREVIOUS_NATIVE_SPOKEN_SECTION_POLICY);
    expect(previous.prompt).not.toContain('环境也是认知系统的一部分');
    expect(savedSpokenSectionPolicy([{ state: { authoringPolicy: PREVIOUS_NATIVE_SPOKEN_SECTION_POLICY,
      rawResponse: response(0) } }])).toBe(PREVIOUS_NATIVE_SPOKEN_SECTION_POLICY);
    const current = buildSpokenSectionRequest(source, 0);
    expect(current.prompt).toContain('环境也是认知系统的一部分');
    const raw = JSON.parse(response(0));
    raw.segments[0].sourceRefs = ['e1:adopted-original'];
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, current).units[0]!.explanationNodes![0]!.sourceBindings)
      .toEqual([{ evidenceItemId: 'e1', sourceBlockIds: ['b1', 'b2'], textbookId: 'book', revisionId: 'r1' }]);
    raw.segments[0].sourceRefs = ['b1'];
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, current).units[0]!.explanationNodes![0]!.sourceBindings![0]!.sourceBlockIds)
      .toEqual(['b1']);
    expect(buildSpokenSectionRequest(source, 0, [], PREVIOUS_NATIVE_SPOKEN_SECTION_POLICY)).toEqual(previous);
    item.kind = 'concept';
    expect(buildSpokenSectionRequest(source, 0).prompt).not.toContain('环境也是认知系统的一部分');
  });

  it('binds original block IDs and complete IDs to the same adopted passage without rewriting speech', async () => {
    const author = vi.fn(async (_request, index: number) => {
      const raw = JSON.parse(response(index));
      if (index === 0) raw.segments[0].sourceRefs = ['b1', 'e1:b1', 'b1'];
      return JSON.stringify(raw);
    });
    const blueprint = await generateSpokenTeachingBlueprint(input(), 'input', author);
    const node = blueprint.sections[0]!.units[0]!.explanationNodes![0]!;
    expect(node.content).toBe(JSON.parse(response(0)).segments[0].text);
    expect(node.sourceBindings).toEqual([
      { evidenceItemId: 'e1', sourceBlockIds: ['b1'], textbookId: 'book', revisionId: 'r1' },
    ]);
    expect(author).toHaveBeenCalledTimes(2);
  });

  it('retains adopted evidence wrappers for the same immutable block', async () => {
    const source = input();
    source.sourceEvidence!.items.push({ ...structuredClone(source.sourceEvidence!.items[0]!), id: 'e2' });
    source.knowledgePoints[0]!.evidenceItemIds!.push('e2');
    const blueprint = await generateSpokenTeachingBlueprint(source, 'input', async (_request, index) => {
      const raw = JSON.parse(response(index));
      if (index === 0) raw.segments[0].sourceRefs = ['b1'];
      return JSON.stringify(raw);
    });
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.sourceBindings!.map((source) => source.evidenceItemId))
      .toEqual(['e1', 'e2']);
  });

  it('compiles an adopted process block under a copied concept wrapper without changing the speech or request identity', async () => {
    const source = input();
    const process = structuredClone(source.sourceEvidence!.items[0]!);
    process.id = 'process';
    process.completeSourceBlocks = [{ sourceBlockId: 'step', content: '第一步明确任务，第二步进入情境。' }];
    source.sourceEvidence!.items.push(process);
    source.knowledgePoints[0]!.evidenceItemIds!.push('process');
    const originalRequest = buildSpokenSectionRequest(source, 0);
    const raw = JSON.parse(response(0));
    raw.segments[0].sourceRefs = ['e1:step', 'step', 'process:step'];
    const originalResponse = JSON.stringify(raw);
    const author = vi.fn(async (request, index: number) => {
      if (index === 0) expect(request).toEqual(originalRequest);
      return index === 0 ? originalResponse : response(index);
    });
    const blueprint = await generateSpokenTeachingBlueprint(source, 'input', author);
    const section = blueprint.sections[0]!;
    expect(section.units[0]!.explanationNodes![0]!.content).toBe(raw.segments[0].text);
    expect(section.units[0]!.explanationNodes![0]!.sourceBindings).toEqual([
      { evidenceItemId: 'process', sourceBlockIds: ['step'], textbookId: 'book', revisionId: 'r1' },
    ]);
    expect(section.qualityDiagnostics).toContainEqual(expect.stringContaining('e1:step → process:step'));
    expect(blueprint.qualityDiagnostics).toEqual(expect.arrayContaining(section.qualityDiagnostics!));
    expect(JSON.stringify(raw)).toBe(originalResponse);
    expect(buildSpokenSectionRequest(source, 0)).toEqual(originalRequest);
    expect(author).toHaveBeenCalledTimes(2);
  });

  it.each(['book', 'revision'] as const)('rejects a complete source block from another %s before authoring', async (change) => {
    const source = input();
    const item = source.sourceEvidence!.items[0]!;
    item.completeSourceBlocks![0]!.source = { ...item.source,
      ...(change === 'book' ? { textbookId: 'other-book' } : { revisionId: 'r2' }) };
    const author = vi.fn(async (_request, index: number) => response(index));
    await expect(generateSpokenTeachingBlueprint(source, 'input', author)).rejects.toThrow('教材或版本身份');
    expect(author).not.toHaveBeenCalled();
  });

  it('rejects conflicting contents under one adopted source address instead of overwriting its passage', async () => {
    const source = input();
    source.sourceEvidence!.items[0]!.completeSourceBlocks!.push({ sourceBlockId: 'b1', content: '同一编号下另一段不一致的原文。' });
    const author = vi.fn(async (_request, index: number) => response(index));
    await expect(generateSpokenTeachingBlueprint(source, 'input', author)).rejects.toThrow('不同的原文内容');
    expect(author).not.toHaveBeenCalled();
  });

  it.each(['book', 'revision', 'text'] as const)('rejects a bare block ID with conflicting %s identity and accepts an exact ID', async (change) => {
    const source = input();
    const other = { ...structuredClone(source.sourceEvidence!.items[0]!), id: 'e2' };
    if (change === 'book') other.source.textbookId = 'another-book';
    if (change === 'revision') other.source.revisionId = 'r2';
    if (change === 'text') other.completeSourceBlocks![0]!.content = '另一个原文段落。';
    source.sourceEvidence!.items.push(other);
    source.knowledgePoints[0]!.evidenceItemIds!.push('e2');
    const raw = JSON.parse(response(0));
    raw.segments[0].sourceRefs = ['b1'];
    const author = vi.fn(async (_request, index: number) => index === 0 ? JSON.stringify(raw) : response(index));
    await expect(generateSpokenTeachingBlueprint(source, 'input', author)).rejects.toThrow('存在歧义');
    expect(author).toHaveBeenCalledTimes(1);
    raw.segments[0].sourceRefs = ['e1:b1'];
    await expect(generateSpokenTeachingBlueprint(source, 'input', author)).resolves.toBeDefined();
  });

  it('does not resolve an original block outside the confirmed adoption', async () => {
    const source = input();
    source.knowledgePoints[0]!.evidenceItemIds = [];
    const raw = JSON.parse(response(0));
    raw.segments[0].sourceRefs = ['b1'];
    await expect(generateSpokenTeachingBlueprint(source, 'input', async () => JSON.stringify(raw)))
      .rejects.toMatchObject({ generationFailureKind: 'invalid-generated-output', isRetryable: false });
  });

  it.each(['source', 'figure'] as const)('resolves adopted %s list passages already sent outside retrieval anchors while preserving the saved request and speech', (kind) => {
    const source = input();
    const steps = [{ label: '目标分析', sourceBlockId: 'step-title', excerptBlockId: 'step-body',
      excerpt: '先确定目标，再根据目标选择任务。' }];
    if (kind === 'source') {
      source.sourceEvidence!.items[0]!.sourceSequences = [{ kind: 'ordered-steps', anchorSourceBlockId: 'step-title', steps }];
      source.sourceSequences = [{ resourceId: 'source-sequence:step-title', knowledgePointIds: ['k1'],
        required: false, orderedSteps: steps, scope: 'knowledge-point', coveragePolicy: 'authored-scope' }];
    } else {
      source.sourceEvidence!.items[0]!.figureSequences = [{ kind: 'ordered-steps', figureId: 'figure', steps }];
      source.textbookFigures = [{ resourceId: 'figure-resource', figureId: 'figure', knowledgePointIds: ['k1'],
        relation: 'direct', required: false, sourceTitle: '原文图示', orderedSteps: steps }];
    }
    const request = buildSpokenSectionRequest(source, 0);
    const before = structuredClone(request);
    expect(request.sourceBlocks).toHaveLength(2);
    const raw = JSON.parse(response(0));
    raw.segments[0].sourceRefs = ['step-title', 'e1:step-body'];
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(section.units[0]!.explanationNodes![0]).toMatchObject({ content: raw.segments[0].text,
      sourceBindings: [
        { evidenceItemId: 'e1', sourceBlockIds: ['step-title'], textbookId: 'book', revisionId: 'r1' },
        { evidenceItemId: 'e1', sourceBlockIds: ['step-body'], textbookId: 'book', revisionId: 'r1' },
      ] });
    raw.segments[0].sourceRefs = ['step-title:step-body'];
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, request).units[0]!.explanationNodes![0]!.sourceBindings)
      .toEqual(section.units[0]!.explanationNodes![0]!.sourceBindings);
    raw.segments[0].sourceRefs = ['step-body:step-title'];
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('未知原文');
    raw.segments[0].sourceRefs = ['step-title', 'e1:step-body'];
    expect(request).toEqual(before);
    expect(buildSpokenSectionRequest(source, 0)).toEqual(before);
    const second = structuredClone(source.sourceEvidence!.items[0]!);
    second.id = 'e2';
    second.completeSourceBlocks!.push({ sourceBlockId: 'step-title', content: '1. 目标分析' });
    source.sourceEvidence!.items.push(second);
    source.knowledgePoints[0]!.evidenceItemIds!.push('e2');
    const sharedRequest = buildSpokenSectionRequest(source, 0);
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, sharedRequest).units[0]!.explanationNodes![0]!.sourceBindings)
      .toEqual(expect.arrayContaining([
        { evidenceItemId: 'e1', sourceBlockIds: ['step-title'], textbookId: 'book', revisionId: 'r1' },
        { evidenceItemId: 'e2', sourceBlockIds: ['step-title'], textbookId: 'book', revisionId: 'r1' },
      ]));
    const conflict = structuredClone(source);
    (kind === 'source' ? conflict.sourceEvidence!.items[0]!.sourceSequences! : conflict.sourceEvidence!.items[0]!.figureSequences!)[0]!
      .steps[0]!.excerpt = '不同的原文';
    expect(() => compileSpokenSection(JSON.stringify(raw), conflict, 0, request)).toThrow('原文身份冲突');
    source.knowledgePoints[0]!.evidenceItemIds = [];
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, buildSpokenSectionRequest(source, 0))).toThrow('未知原文');
  });

  it.each(['sequence', 'cycle', 'branch'] as const)('preserves a root-level %s graph through compilation and confirmation without changing topology', (topology) => {
    const source = input(), request = buildSpokenSectionRequest(source, 0), raw = JSON.parse(response(0));
    const nodes = [{ id: 'a', label: '目标' }, { id: 'b', label: '实施' }, { id: 'c', label: '评价' }];
    const edges = topology === 'branch' ? [{ from: 'a', to: 'b' }, { from: 'a', to: 'c' }]
      : [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, ...(topology === 'cycle' ? [{ from: 'c', to: 'a' }] : [])];
    raw.pages[0].visualRelationship = { kind: 'diagram', description: '观察实际关系', readingOrder: nodes.map((node) => node.label),
      preferredForm: 'diagram', topology, nodes, edges, annotation: '真实教学关系' };
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    const diagram = { topology, nodes, edges, annotation: '真实教学关系' };
    expect(section.pages[0]!.visualRelationship!.diagram).toEqual(diagram);
    const blueprint = { schemaVersion: 3 as const, inputFingerprint: 'source', createdAt: '', assessmentMode: source.assessmentMode,
      sections: [section], budget: { totalDurationSec: 300, teachingDurationSec: section.teachingDurationSec,
        learnerActivityDurationSec: section.learnerActivityDurationSec, assessmentDurationSec: section.assessmentDurationSec,
        teachingRatio: 0.8, assessmentRatio: 0.2 } };
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    expect(outlines[0]!.visualIntent!.diagram).toEqual(diagram);
    expect(applyReviewedOutlinesToTeachingBlueprint(blueprint, outlines).sections[0]!.pages[0]!.visualRelationship!.diagram).toEqual(diagram);
    expect(section.units[0]!.explanationNodes!.map((node) => node.content)).toEqual(raw.segments.map((node: { text: string }) => node.text));
  });

  it.each(['usage-object', 'reference'] as const)('recovers %s list scope from real taught bindings and merges page subsets without claiming empty or full coverage', (envelope) => {
    const source = input(), item = source.sourceEvidence!.items[0]!;
    const steps = [{ label: '目标分析', sourceBlockId: 'step1', excerptBlockId: 'body1', excerpt: '明确目标' },
      { label: '情境创设', sourceBlockId: 'step2', excerptBlockId: 'body2', excerpt: '设计真实情境' }];
    item.sourceSequences = [{ kind: 'ordered-steps', anchorSourceBlockId: 'step1', steps }];
    source.sourceSequences = [{ resourceId: 'source-sequence:step1', knowledgePointIds: ['k2'], required: false,
      orderedSteps: steps, scope: 'knowledge-point', coveragePolicy: 'authored-scope' }];
    // The adopted original may be a legitimate reference across knowledge
    // responsibilities. Scope must not invent a different page ownership.
    source.sectionPlans![0]!.knowledgePointIds = [...source.sectionPlans![0]!.knowledgePointIds, 'k2'];
    const request = buildSpokenSectionRequest(source, 0), raw = JSON.parse(response(0));
    raw.segments[0].sourceRefs = ['body1']; raw.segments[1].sourceRefs = ['body2'];
    raw.pages = [0, 1].map((index) => ({ ...raw.pages[0], title: `实际条目${index + 1}`, segmentIds: [`s${index + 1}`],
      sourceSequenceUses: [envelope === 'reference' ? 'source-sequence:step1'
        : { resourceId: 'source-sequence:step1', usage: '描述文字不能充作完整覆盖证明' }] }));
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(section.pages.map((page) => page.sourceSequenceUses)).toEqual([
      [{ resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['step1'] }],
      [{ resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['step2'] }],
    ]);
    expect(section.pages.every((page) => page.knowledgePointIds.join() === 'k1')).toBe(true);
    const blueprint = { schemaVersion: 3 as const, inputFingerprint: 'source', createdAt: '', assessmentMode: source.assessmentMode,
      sections: [section], budget: { totalDurationSec: 300, teachingDurationSec: section.teachingDurationSec,
        learnerActivityDurationSec: section.learnerActivityDurationSec, assessmentDurationSec: section.assessmentDurationSec,
        teachingRatio: 0.8, assessmentRatio: 0.2 } };
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    expect(outlines[0]!.teachingBrief!.sourceBindings).toHaveLength(1);
    expect(outlines.find((outline) => outline.type === 'quiz')!.teachingBrief!.teachingPlan!.sourceSequenceUses)
      .toEqual([{ resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['step1', 'step2'] }]);
    raw.pages[0].sourceSequenceUses[0] = { resourceId: 'source-sequence:step1', coverage: 'complete' };
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, request).pages[0]!.sourceSequenceUses![0]!.coverage).toBe('complete');
    raw.pages[0].sourceSequenceUses[0] = envelope === 'reference' ? 'source-sequence:step1'
      : { resourceId: 'source-sequence:step1', usage: '不代表授课' };
    raw.segments[0].sourceRefs = ['b1'];
    const unresolved = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(unresolved.pages[0]!.sourceSequenceUses).toEqual([]);
    expect(unresolved.qualityDiagnostics).toContainEqual(expect.stringContaining('采用范围无法'));
    raw.pages[0].sourceSequenceUses.push(raw.pages[0].sourceSequenceUses[0]);
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('未知或重复');
    raw.pages[0].sourceSequenceUses = ['source-sequence:invented'];
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('未知或重复');
    raw.pages[0].sourceSequenceUses[0] = { resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['invented'] };
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('真实非空唯一');
  });

  it.each(['sequence-owner', 'same-source-wrapper', 'other-book', 'other-revision', 'conflicting-original'] as const)('tracks summary list owners through %s without confusing source identity or replacing explicit scope', (bindingSource) => {
    const source = input(), item = source.sourceEvidence!.items[0]!;
    const steps = [{ label: '目标分析', sourceBlockId: 'step1', excerptBlockId: 'body1', excerpt: '明确目标' },
      { label: '情境创设', sourceBlockId: 'step2', excerptBlockId: 'body2', excerpt: '设计真实情境' }];
    item.sourceSequences = [{ kind: 'ordered-steps', anchorSourceBlockId: 'step1', steps }];
    item.completeSourceBlocks!.push(...steps.map((step) => ({ sourceBlockId: step.excerptBlockId, content: step.excerpt })));
    source.sourceSequences = [{ resourceId: 'source-sequence:step1', knowledgePointIds: ['k1'], required: false,
      orderedSteps: steps, scope: 'knowledge-point', coveragePolicy: 'authored-scope' }];
    if (bindingSource !== 'sequence-owner') {
      const wrapper = structuredClone(item);
      wrapper.id = 'e2'; delete wrapper.sourceSequences;
      wrapper.completeSourceBlocks = steps.map((step) => ({ sourceBlockId: step.excerptBlockId, content: step.excerpt }));
      if (bindingSource === 'conflicting-original') wrapper.completeSourceBlocks[0]!.content = '不同的已采用原文，不得计作列表第一项。';
      if (bindingSource === 'other-book') wrapper.source.textbookId = 'other-book';
      if (bindingSource === 'other-revision') wrapper.source.revisionId = 'other-revision';
      source.sourceEvidence!.items.push(wrapper);
      source.knowledgePoints[0]!.evidenceItemIds!.push('e2');
    }
    const request = buildSpokenSectionRequest(source, 0), raw = JSON.parse(response(0));
    const prefix = bindingSource === 'sequence-owner' ? '' : 'e2:';
    raw.segments[0].sourceRefs = [`${prefix}body1`]; raw.segments[1].sourceRefs = [`${prefix}body2`];
    raw.segments.push({ ...raw.segments[0], id: 's3', text: '继续原文中的其他认识。', sourceRefs: ['b1'] });
    raw.pages = [0, 1, 2].map((index) => ({ ...raw.pages[0], title: `实际认识${index + 1}`, segmentIds: [`s${index + 1}`],
      ...(index === 2 ? { sourceSequenceUses: ['source-sequence:step1'] } : {}) }));
    const original = structuredClone(raw);
    if (bindingSource === 'conflicting-original') {
      expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('原文身份冲突');
      expect(raw).toEqual(original);
      // Exact original citations remain usable without the cross-wrapper
      // scope inference; this fix does not rewrite the paid response.
      delete raw.pages[2].sourceSequenceUses;
      expect(compileSpokenSection(JSON.stringify(raw), source, 0, request).units[0]!.explanationNodes![0]!.sourceBindings)
        .toEqual([{ evidenceItemId: 'e2', sourceBlockIds: ['body1'], textbookId: 'book', revisionId: 'r1' }]);
      return;
    }
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    if (bindingSource === 'other-book' || bindingSource === 'other-revision') {
      expect(section.pages[0]!.sourceSequenceUses).toBeUndefined();
      expect(section.pages[1]!.sourceSequenceUses).toBeUndefined();
      expect(section.pages[2]!.sourceSequenceUses).toEqual([]);
      expect(scopeSourceSequenceContracts(source.sourceSequences, section.pages)[0]!.required).toBe(false);
      expect(raw).toEqual(original);
      return;
    }
    expect(section.pages.map((page) => page.sourceSequenceUses)).toEqual([
      [{ resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['step1'] }],
      [{ resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['step2'] }], [],
    ]);
    expect(mergeSourceSequenceUses(section.pages)).toEqual([
      { resourceId: 'source-sequence:step1', coverage: 'selected', sourceStepIds: ['step1', 'step2'] },
    ]);
    expect(scopeSourceSequenceContracts(source.sourceSequences, section.pages)[0]).toMatchObject({ required: true,
      requiredStepLabels: ['目标分析', '情境创设'] });
    expect(section.pages.map((page) => page.introducesNodeIds)).toEqual([['teaching-section-1:s1'], ['teaching-section-1:s2'], ['teaching-section-1:s3']]);
    expect(section.units[0]!.explanationNodes!.map((node) => node.content)).toEqual(original.segments.map((node: { text: string }) => node.text));
    expect(raw).toEqual(original);
    raw.pages[0].sourceSequenceUses = [];
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, request).pages[0]!.sourceSequenceUses).toEqual([]);
  });

  it.each(['root', 'diagram'] as const)('preserves nested %s sequence groups and their local loop through compilation and confirmation', (envelope) => {
    const source = input(), request = buildSpokenSectionRequest(source, 0), raw = JSON.parse(response(0));
    const groups = [
      { id: 'framework', label: '具身教学设计框架四阶段',
        nodes: ['前期分析', '核心要素设计', '教学过程实施', '教学评价'].map((label, index) => ({ id: `stage${index + 1}`, label })),
        edges: [{ from: 'stage1', to: 'stage2' }, { from: 'stage2', to: 'stage3' }, { from: 'stage3', to: 'stage4' }] },
      { id: 'implementation', label: '教学过程实施五步循环',
        nodes: ['情境/环境创设', '正向引导', '具身体验', '生成内化', '引导修正'].map((label, index) => ({ id: `imp${index + 1}`, label })),
        edges: [{ from: 'imp1', to: 'imp2' }, { from: 'imp2', to: 'imp3' }, { from: 'imp3', to: 'imp4' },
          { from: 'imp4', to: 'imp5' }, { from: 'imp5', to: 'imp1', label: '循环往复、不断深化' }] },
    ];
    const graph = { topology: 'sequence', sequenceGroups: groups };
    raw.pages[0].visualRelationship = { kind: 'process', description: '四阶段中保留实施的五步循环',
      preferredForm: 'diagram', readingOrder: groups.flatMap((group) => group.nodes.map((node) => node.label)),
      ...(envelope === 'root' ? graph : { diagram: graph }) };
    const original = structuredClone(raw), rawResponse = JSON.stringify(raw), requestBefore = structuredClone(request);
    const diagram = { topology: 'sequence', nodes: groups.flatMap((group) => group.nodes),
      edges: groups.flatMap((group) => group.edges),
      sequenceGroups: groups.map((group) => ({ id: group.id, label: group.label, nodeIds: group.nodes.map((node) => node.id) })) };
    const section = compileSpokenSection(rawResponse, source, 0, request);
    expect(section.pages[0]!.visualRelationship!.diagram).toEqual(diagram);
    const blueprint = { schemaVersion: 3 as const, inputFingerprint: 'source', createdAt: '', assessmentMode: source.assessmentMode,
      sections: [section], budget: { totalDurationSec: 300, teachingDurationSec: section.teachingDurationSec,
        learnerActivityDurationSec: section.learnerActivityDurationSec, assessmentDurationSec: section.assessmentDurationSec,
        teachingRatio: 0.8, assessmentRatio: 0.2 } };
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    expect(outlines[0]!.visualIntent!.diagram).toEqual(diagram);
    expect(applyReviewedOutlinesToTeachingBlueprint(blueprint, outlines).sections[0]!.pages[0]!.visualRelationship!.diagram).toEqual(diagram);
    expect(section.pages[0]).toMatchObject({ description: original.pages[0].description, keyPoints: original.pages[0].keyPoints,
      teachingObjective: original.pages[0].teachingObjective });
    expect(section.units[0]!.explanationNodes!.map((node) => node.content)).toEqual(original.segments.map((node: { text: string }) => node.text));
    expect(raw).toEqual(original);
    expect(request).toEqual(requestBefore);
    expect(JSON.parse(rawResponse)).toEqual(original);
    // Repeated definitions must agree; the parser cannot silently pick one.
    const target = envelope === 'root' ? raw.pages[0].visualRelationship : raw.pages[0].visualRelationship.diagram;
    target.nodes = diagram.nodes;
    target.edges = diagram.edges;
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, request).pages[0]!.visualRelationship!.diagram).toEqual(diagram);
    target.nodes = diagram.nodes.map((node, index) => index === 0 ? { ...node, label: '矛盾标签' } : node);
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('根节点定义冲突');
    target.nodes = diagram.nodes;
    target.edges = [...diagram.edges, { from: 'stage4', to: 'imp1' }];
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('根连接定义冲突');
    delete target.nodes; delete target.edges;
    target.sequenceGroups[1].nodes[0].id = 'stage1';
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('节点身份冲突');
  });

  it.each(['diagram', 'table'] as const)('preserves a %s form alias without inventing nodes or a teaching relationship', (kind) => {
    const source = input(), request = buildSpokenSectionRequest(source, 0), raw = JSON.parse(response(0));
    const relation = { kind, description: '观察已写出的知识结构', readingOrder: ['原文定义', '原文条件'] };
    raw.pages[0].visualRelationship = relation;
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(section.pages[0]!.visualRelationship).toEqual({ ...relation, kind: 'statement', preferredForm: kind });
    expect(section.pages[0]!.visualRelationship).not.toHaveProperty('diagram');
    raw.pages[0].visualRelationship.preferredForm = 'mixed';
    expect(compileSpokenSection(JSON.stringify(raw), source, 0, request).pages[0]!.visualRelationship!.preferredForm).toBe('mixed');
  });

  it('preserves canonical speech when a teacher edits display wording', async () => {
    const blueprint = await generateSpokenTeachingBlueprint(input(), 'input', async (_request, index) => response(index));
    const before = structuredClone(blueprint.sections[0]!.units[0]!.explanationNodes);
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    outlines[0]!.keyPoints = ['教师修订的显示句'];
    const edited = applyReviewedOutlinesToTeachingBlueprint(blueprint, outlines);
    expect(edited.sections[0]!.units[0]!.explanationNodes).toEqual(before);
    expect(edited.sections[0]!.pages[0]!.keyPoints).toEqual(['教师修订的显示句']);
    expect(edited.sections[0]!.pages[0]).not.toHaveProperty('presentationItems');
    expect(teachingBlueprintToOutlines(edited, '中文')[0]!.keyPoints).toEqual(['教师修订的显示句']);
  });

  it('keeps omitted paragraph ownership beside its actual neighbours without rewriting', async () => {
    const raw = JSON.parse(response(0));
    raw.pages[0].segmentIds = ['s2'];
    const blueprint = await generateSpokenTeachingBlueprint({ ...input(), sectionPlans: [input().sectionPlans![0]!] }, 'input', async () => JSON.stringify(raw));
    expect(blueprint.sections[0]!.pages[0]!.introducesNodeIds).toEqual(['teaching-section-1:s1', 'teaching-section-1:s2']);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(raw.segments[0].text);
  });

  it('retains independent earlier section responses when a later response is unusable', async () => {
    const saved = new Map<string, string>();
    const author = vi.fn(async (request: ReturnType<typeof buildSpokenSectionRequest>, index: number) => {
      if (!saved.has(request.fingerprint)) saved.set(request.fingerprint, index === 0 ? response(0) : '{"segments":[]}');
      return saved.get(request.fingerprint)!;
    });
    await expect(generateSpokenTeachingBlueprint(input(), 'input', author)).rejects.toThrow('没有可执行');
    expect(saved.size).toBe(2);
    await expect(generateSpokenTeachingBlueprint(input(), 'input', author)).rejects.toThrow('没有可执行');
    expect(saved.size).toBe(2);
    expect(author).toHaveBeenCalledTimes(4); // read the same saved responses, never a repair request
  });

  it('persists compiled earlier sections before a later section fails', async () => {
    const compiled = vi.fn(async () => {});
    await expect(generateSpokenTeachingBlueprint(input(), 'input', async (_request, index) =>
      index === 0 ? response(0) : '{"segments":[]}', compiled)).rejects.toThrow('没有可执行');
    expect(compiled).toHaveBeenCalledTimes(1);
    expect(compiled.mock.calls[0]).toMatchObject([
      { id: 'teaching-section-1', contentMode: 'spoken' }, { sectionId: 'teaching-section-1' }, 0, response(0),
    ]);
  });

  it('rejects duplicate or unknown ownership and source identity instead of fabricating speech', async () => {
    const raw = JSON.parse(response(0));
    raw.pages[0].segmentIds = ['s1', 's1', 's2'];
    const author = vi.fn(async () => JSON.stringify(raw));
    await expect(generateSpokenTeachingBlueprint(input(), 'input', author)).rejects.toThrow('重复段落');
    expect(author).toHaveBeenCalledTimes(1);
    raw.pages[0].segmentIds = ['s1', 's2'];
    raw.segments[0].sourceRefs = ['invented'];
    await expect(generateSpokenTeachingBlueprint(input(), 'input', author)).rejects.toThrow('未知原文');
  });

  it.each(['case', 'definition', 'implication', 'step', undefined])('defaults optional display role %s without changing the saved speech', async (role) => {
    const blueprint = await generateSpokenTeachingBlueprint(input(), 'input', async (_request, index) => {
      const raw = JSON.parse(legacyResponse(index));
      raw.pages[0].presentationItems[0].role = role;
      return JSON.stringify(raw);
    }, undefined, LEGACY_SPOKEN_SECTION_POLICY);
    expect(blueprint.sections[0]!.pages[0]!.presentationItems![0]!.role).toBe('key-point');
    expect(blueprint.sections[0]!.units[0]!.explanationNodes!.map((node) => node.content))
      .toEqual(JSON.parse(response(0)).segments.map((node: { text: string }) => node.text));
  });

  it('accepts the resource type alias while retaining the adopted textbook image identity', async () => {
    const source = input();
    source.textbookFigures = [{ resourceId: 'saved-image', figureId: 'figure', knowledgePointIds: ['k1'],
      relation: 'direct', required: true, sourceTitle: '教材图示' }];
    const blueprint = await generateSpokenTeachingBlueprint(source, 'input', async (_request, index) => {
      const raw = JSON.parse(response(index));
      if (index === 0) raw.pages[0].resourceNeeds = [{ type: 'source-image', assetId: 'saved-image',
        purpose: '展示教材图示', required: true }];
      return JSON.stringify(raw);
    });
    expect(blueprint.sections[0]!.pages[0]!.resourceNeeds).toEqual([{ kind: 'source-image', assetId: 'saved-image',
      purpose: '展示教材图示', required: true }]);
  });

  it('compiles the same first response into speech, display points and an executable case image request', async () => {
    const source = fishCaseInput();
    source.resourceCapabilities = { imageGenerationEnabled: true, videoGenerationEnabled: false };
    const observation = { kind: 'generated-image', aspectRatio: '4:3',
      subjects: ['小鱼想象的鱼形牛', '真实牛'], composition: '同视角并排对照',
      observableDifference: '想象中的生物保留鱼形身体，同时有两只角、四条腿和花斑；真实牛保持正常身体结构。',
      reason: '直接观察已有鱼形经验怎样影响对新对象的想象' };
    const displayed = ['青蛙描述了牛的角、四条腿、吃草和花斑。', '小鱼用熟悉的鱼形态组织这些新信息。'];
    const author = vi.fn(async (request: ReturnType<typeof buildSpokenSectionRequest>) => {
      expect(JSON.parse(request.prompt).resourceCapabilities).toEqual(source.resourceCapabilities);
      expect(request.sourceBlocks[0]!.text).toBe(fishCaseSource);
      return JSON.stringify({ learningObjective: '解释已有经验怎样参与理解新对象',
        segments: [{ id: 'story', kind: 'example', text: fishCaseSource, knowledgePointIds: ['k1'], sourceRefs: ['e1:b1'] }],
        pages: [{ title: '小鱼想象的牛与真实牛', type: 'slide', segmentIds: ['story'],
          description: '观察想象与真实形态，说明已有经验参与理解。', keyPoints: displayed,
          teachingObjective: '解释已有经验怎样参与理解新对象', caseObservation: observation }] });
    });
    const blueprint = await generateSpokenTeachingBlueprint(source, 'fish-input', author);
    const [outline] = teachingBlueprintToOutlines(blueprint, '中文');
    expect(author).toHaveBeenCalledTimes(1);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(fishCaseSource);
    expect(blueprint.sections[0]!.pages[0]!.caseObservation).toEqual({ ...observation, imageWouldHelp: true });
    expect(outline!.keyPoints).toEqual(displayed);
    expect(outline!.mediaGenerations).toEqual([{ type: 'image', elementId: expect.stringMatching(/^generated_[a-f0-9]{20}$/),
      prompt: expect.stringContaining(observation.observableDifference), aspectRatio: '4:3', observationContext: observation.observableDifference }]);
    expect(outline!.mediaGenerations![0]!.prompt).toContain(observation.composition);
    expect(outline!.mediaGenerations![0]!.prompt).toContain(observation.subjects[0]);
    expect(blueprint.sections[0]!.pages[0]!.resourceNeeds).toHaveLength(1);
    expect(outline!.visualIntent).toMatchObject({ representation: 'generated-image',
      resourceRefs: [{ kind: 'generated-image', resourceId: outline!.mediaGenerations![0]!.elementId,
        required: true, reason: observation.reason, observationGoal: observation.observableDifference }] });
    expect(teachingBlueprintToOutlines(blueprint, '中文')[0]!.mediaGenerations).toEqual(outline!.mediaGenerations);
  });

  it('keeps the textbook observation image when generated images and video are disabled', async () => {
    const source = fishCaseInput();
    source.resourceCapabilities = { imageGenerationEnabled: false, videoGenerationEnabled: false };
    source.textbookFigures = [{ resourceId: 'fish-source', figureId: 'figure', knowledgePointIds: ['k1'],
      relation: 'direct', required: true, sourceTitle: '教材原图' }];
    const author = vi.fn(async (request: ReturnType<typeof buildSpokenSectionRequest>) => {
      const prompt = JSON.parse(request.prompt);
      expect(prompt.resourceCapabilities).toEqual(source.resourceCapabilities);
      expect(prompt.textbookFigures[0].resourceId).toBe('fish-source');
      return JSON.stringify({ learningObjective: '观察已有经验的作用',
        segments: [{ id: 'story', kind: 'example', text: fishCaseSource, knowledgePointIds: ['k1'], sourceRefs: ['b1'] }],
        pages: [{ title: '小鱼对牛的想象', type: 'slide', segmentIds: ['story'],
          description: '从教材图观察鱼形身体怎样与牛的特征结合。', keyPoints: ['小鱼用熟悉的鱼形态组织牛的特征。'],
          teachingObjective: '观察已有经验的作用',
          caseObservation: { kind: 'source-image', resourceIds: ['fish-source'], subjects: ['想象的牛'],
            observableDifference: '鱼形身体与牛的特征', reason: '观察鱼形身体与牛的特征', composition: '' } }] });
    });
    const authored = await generateSpokenTeachingBlueprint(source, 'disabled-fish-input', author);
    const blueprint = adaptTeachingBlueprintResourceCapabilities(authored, source.resourceCapabilities);
    const [outline] = teachingBlueprintToOutlines(blueprint, '中文');
    expect(author).toHaveBeenCalledTimes(1);
    expect(outline!.mediaGenerations).toBeUndefined();
    expect(outline!.suggestedImageIds).toEqual(['fish-source']);
    expect(outline!.visualIntent).toMatchObject({ representation: 'source-image',
      resourceRefs: [{ resourceId: 'fish-source', kind: 'source-image', required: true }] });
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(fishCaseSource);
  });

  it.each([PREVIOUS_NATIVE_SPOKEN_SECTION_POLICY, SPOKEN_SECTION_POLICY] as const)(
    'replays a complete textbook observation without kind under its saved contract (%s)', async (policy) => {
      const source = input();
      source.resourceCapabilities = { imageGenerationEnabled: false, videoGenerationEnabled: false };
      source.textbookFigures = [{ resourceId: 'textbook_fig_7463e7e21d4c', figureId: 'figure-31',
        knowledgePointIds: ['k1'], relation: 'candidate', required: false, sourceTitle: '图31 具身认知理论的认知过程' }];
      // The actual complete response that failed on 2026-10-04 supplied an
      // offered original figure and its observation purpose, but no kind.
      const observation = { resourceIds: ['textbook_fig_7463e7e21d4c'],
        description: '使用教材原图“图31 具身认知理论的认知过程”，观察认知过程中身体、大脑与环境的关系。',
        observationFocus: '不要把认知只定位在大脑内部，而要看身体与环境如何进入认知过程。', preserveOriginal: true };
      const raw = JSON.parse(response(0));
      raw.pages[0].caseObservation = observation;
      const savedResponse = JSON.stringify(raw);
      const request = buildSpokenSectionRequest(source, 0, [], policy);
      const before = structuredClone({ source, raw, request });
      const author = vi.fn(async (_request, index) => index === 0 ? savedResponse : response(index));
      const blueprint = await generateSpokenTeachingBlueprint(source, 'saved-source-image', author, undefined, policy);
      const page = blueprint.sections[0]!.pages[0]!;
      expect(page.caseObservation).toEqual({ kind: 'source-image', imageWouldHelp: true,
        resourceIds: observation.resourceIds, reason: observation.description,
        observableDifference: observation.observationFocus, subjects: [], composition: '' });
      expect(page.resourceNeeds).toEqual([{ kind: 'source-image', assetId: observation.resourceIds[0],
        required: true, purpose: observation.description }]);
      expect(blueprint.sections[0]!.qualityDiagnostics).toContainEqual(expect.stringContaining('归一案例观察'));
      expect(blueprint.sections[0]!.units[0]!.explanationNodes!.map((node) => node.content))
        .toEqual(raw.segments.map((segment: { text: string }) => segment.text));
      expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.sourceBindings)
        .toEqual([{ evidenceItemId: 'e1', sourceBlockIds: ['b1'], textbookId: 'book', revisionId: 'r1' }]);
      const outlines = teachingBlueprintToOutlines(blueprint, '中文');
      expect(outlines[0]!.suggestedImageIds).toEqual(observation.resourceIds);
      expect(outlines[0]!.mediaGenerations).toBeUndefined();
      expect(outlines[0]!.keyPoints).toEqual(raw.pages[0].keyPoints);
      expect(outlines[0]!.visualIntent?.resourceRefs).toEqual([{ resourceId: observation.resourceIds[0],
        kind: 'source-image', required: true, reason: observation.description, observationGoal: observation.observationFocus }]);
      const approved = applyReviewedOutlinesToTeachingBlueprint(blueprint, outlines);
      expect(approved.sections[0]!.pages).toEqual(blueprint.sections[0]!.pages);
      expect(teachingBlueprintToOutlines(approved, '中文')[0]!.suggestedImageIds).toEqual(observation.resourceIds);
      expect(buildSpokenSectionRequest(source, 0, [], policy)).toEqual(request);
      expect({ source, raw, request }).toEqual(before);
      // Recompilation of this already purchased response has no provider step.
      const locallyCompiled = compileSpokenSection(savedResponse, source, 0, request);
      expect(blueprint.sections[0]).toMatchObject(locallyCompiled);
      expect(compileSpokenSection(savedResponse, source, 0, request)).toEqual(locallyCompiled);
      expect(author).toHaveBeenCalledTimes(2);
    });

  it.each([
    { observation: { kind: 'native-diagram', resourceIds: ['known-figure'] }, error: '案例观察类型不可执行' },
    { observation: { resourceIds: ['unknown-figure'], preserveOriginal: true }, error: '观察图引用未知教材图片' },
    { observation: { resourceIds: ['known-figure', 7] }, error: '案例观察类型不可执行' },
    { observation: { resourceIds: ['known-figure'], imageWouldHelp: false }, error: '案例观察类型不可执行' },
    { observation: { resourceIds: ['known-figure'], preserveOriginal: false }, error: '案例观察类型不可执行' },
    { observation: { description: '需要看清案例' }, error: '案例观察类型不可执行' },
  ])('preserves technical errors for ambiguous or unidentified observations ($error)', ({ observation, error }) => {
    const source = input();
    source.textbookFigures = [{ resourceId: 'known-figure', figureId: 'figure', knowledgePointIds: ['k1'],
      relation: 'candidate', required: false, sourceTitle: '原图' }];
    const raw = JSON.parse(response(0));raw.pages[0].caseObservation = observation;
    const saved = JSON.stringify(raw), request = buildSpokenSectionRequest(source, 0);
    expect(() => compileSpokenSection(saved, source, 0, request)).toThrow(error);
    expect(JSON.stringify(raw)).toBe(saved);
  });

  it('does not infer an observation from a course figure absent from the saved section request', () => {
    const source = input();
    source.textbookFigures = [{ resourceId: 'other-section-figure', figureId: 'figure', knowledgePointIds: ['k2'],
      relation: 'candidate', required: false, sourceTitle: '另一小节原图' }];
    const raw = JSON.parse(response(0));
    raw.pages[0].caseObservation = { resourceIds: ['other-section-figure'], preserveOriginal: true };
    const request = buildSpokenSectionRequest(source, 0);
    expect(JSON.parse(request.prompt).textbookFigures).toEqual([]);
    expect(() => compileSpokenSection(JSON.stringify(raw), source, 0, request)).toThrow('未在本次小节请求中提供');
  });

  it('keeps the saved legacy observation and its separately executable resource unchanged', () => {
    const source = input();
    source.textbookFigures = [{ resourceId: 'known-figure', figureId: 'figure', knowledgePointIds: ['k1'],
      relation: 'candidate', required: false, sourceTitle: '教材原图' }];
    const raw = JSON.parse(legacyResponse(0));
    raw.pages[0].caseObservation = { resourceIds: ['known-figure'], description: '保留旧观察描述', preserveOriginal: true };
    raw.pages[0].resourceNeeds = [{ kind: 'source-image', assetId: 'known-figure', required: true, purpose: '旧观察用途' }];
    const request = buildSpokenSectionRequest(source, 0, [], LEGACY_SPOKEN_SECTION_POLICY);
    const section = compileSpokenSection(JSON.stringify(raw), source, 0, request);
    expect(section.pages[0]!.caseObservation).toEqual(raw.pages[0].caseObservation);
    expect(section.pages[0]!.resourceNeeds).toEqual(raw.pages[0].resourceNeeds);
    expect(section.pages[0]!.presentationItems![0]!.text).toBe('旧显示要点');
  });

  it('binds each media capability independently to the original section request identity', () => {
    const source = fishCaseInput();
    const requests = [
      { imageGenerationEnabled: false, videoGenerationEnabled: false },
      { imageGenerationEnabled: true, videoGenerationEnabled: false },
      { imageGenerationEnabled: false, videoGenerationEnabled: true },
    ].map((resourceCapabilities) => {
      const request = buildSpokenSectionRequest({ ...source, resourceCapabilities }, 0);
      expect(JSON.parse(request.prompt).resourceCapabilities).toEqual(resourceCapabilities);
      return request;
    });
    expect(new Set(requests.map((request) => request.fingerprint)).size).toBe(3);
  });

  it('validates saved ownership without relying on old explanation/contribution fields', async () => {
    const blueprint = await generateSpokenTeachingBlueprint(input(), 'input', async (_request, index) => response(index));
    blueprint.sections[0]!.units[0]!.explanation = '';
    expect(spokenBlueprintIssues(blueprint)).toEqual([]);
    blueprint.sections[0]!.pages[0]!.introducesNodeIds!.pop();
    expect(revalidateStoredTeachingBlueprint(blueprint, input()).blueprint).toBeUndefined();
  });

  it('restores a saved spoken capacity candidate without applying the legacy authoring graph', async () => {
    const blueprint = await generateSpokenTeachingBlueprint(input(), 'input', async (_request, index) => response(index));
    const aiCall = vi.fn();
    const restored = await generateTeachingBlueprint(input(), aiCall, { repairFrom: {
      candidate: blueprint, issues: ['prior capacity diagnostic'], preserveAcceptedPagePlans: true,
    } });
    expect(aiCall).not.toHaveBeenCalled();
    expect(restored.sections).toEqual(blueprint.sections);
    expect(restored).not.toHaveProperty('knowledgeAuthoring');
  });

  it('binds replay identity to source revision, teacher scope and the actual model', () => {
    const initial = input();
    const baseline = buildSpokenSectionRequest(initial, 0).fingerprint;
    for (const change of [
      (value: TeachingBlueprintInput) => { value.sourceEvidence!.items[0]!.source.revisionId = 'new-revision'; },
      (value: TeachingBlueprintInput) => { value.learningObjectives = ['新的教师目标']; },
      (value: TeachingBlueprintInput) => { value.generationModelFingerprint = 'new-model-config'; },
    ]) {
      const next = structuredClone(initial);
      change(next);
      expect(buildSpokenSectionRequest(next, 0).fingerprint).not.toBe(baseline);
    }
  });
});
