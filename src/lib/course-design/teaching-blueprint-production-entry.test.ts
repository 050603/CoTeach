import { describe, expect, it, vi } from 'vitest';
import type { Course, CourseContent } from '@/lib/session/types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { buildTeachingNarrationSemantics } from '@/lib/openmaic/generation/teaching-narration';
import { scopeCourseTextbookFigures } from '@/lib/textbook/figure-use';
import { prepareTeachingBlueprintInput, restoreTeachingBlueprintRepairSource, type QuickDesignRequest } from './job-runner';
import { applyReviewedOutlinesToTeachingBlueprint, generateTeachingBlueprint,
  revalidateStoredTeachingBlueprint, teachingBlueprintToOutlines,
  teachingBlueprintContentFingerprint, teachingBlueprintInputFingerprint,
  validateTeachingBlueprintBudget, TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION,
  type TeachingBlueprintInput, type TeachingBlueprintValidation } from './teaching-blueprint';

// Only immutable source storage is isolated. Input preparation, first-writing
// prompts, validation, compilation, confirmation and saved reuse are real.
const figureRows = vi.hoisted(() => vi.fn().mockResolvedValue([]));
vi.mock('@/lib/db/client', () => ({ prisma: {
  textbookSourceBlock: { findMany: vi.fn().mockResolvedValue([]) },
  textbookRetrievalItem: { findMany: vi.fn().mockResolvedValue([]) },
  textbookFigure: { findMany: figureRows },
} }));

const definition = '缓存一致性是同一数据存在多个缓存副本时，让各副本与数据更新之间遵守既定一致性规则的机制。各副本的更新时间不一定相同，但读取必须符合所采用的一致性规则。';
const mechanism = '本例有四个缓存副本。数据更新后，旧缓存可能仍保存先前的值。系统通过使旧缓存失效或同步更新副本，避免后续读取使用不符合既定规则的旧值。';
const boundary = '缓存失效与同步更新是两种可用做法，具体选择需要符合既定一致性规则。不能把其中某一种做法当作所有系统的唯一实现方式。';
const sourceText = [definition, mechanism, boundary].join('\n');

function entryFixture() {
  const content: CourseContent = {
    pblOutline: '', lessonOutline: [], evaluationPlan: { dimensions: [], overallRubric: '' },
    knowledgePoints: [{ id: 'kp', name: '缓存一致性', description: definition,
      level: 'core', teachingRole: 'core-concept', teachingDepth: 'detailed',
      groupId: 'replicas', groupName: '缓存副本的更新与读取', evidenceItemIds: ['frozen-passage'] }],
  };
  const course: Course = { id: 'production-entry-fixture', name: '缓存一致性', subject: '信息科技',
    grade: '大学', hours: 1, summary: '解释缓存更新与读取规则', drivingQuestion: '',
    learningObjectives: ['理解缓存一致性的含义，并根据既定规则解释缓存更新与读取'],
    status: 'draft', stages: [], currentStageIndex: 0, students: [], content,
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
  const textbookEvidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1,
    fingerprint: 'immutable-original-passage', createdAt: '2026-10-01T00:00:00Z',
    retrievalMode: 'hybrid', warnings: [], selections: [],
    mappings: [{ sourceKnowledgePointId: 'kp', sourceKnowledgePointName: '缓存一致性', status: 'direct',
      evidenceItemIds: ['frozen-passage'], rationale: '原文直接解释缓存一致性与其边界。' }],
    items: [{ id: 'frozen-passage', kind: 'source-block', title: '缓存一致性', content: sourceText,
      source: { textbookId: 'book', textbookTitle: '系统原理', revisionId: 'immutable-revision',
        revisionVersion: 1, sourceBlockIds: ['original-passage'], sectionPath: [] } }],
  };
  const request: QuickDesignRequest = { courseId: course.id, generationContractVersion: 3,
    generationModelString: 'unchanged-model', teacherBrief: '准确讲解核心概念与边界，页面提炼核心认识。',
    generationMode: 'standard', assessmentMode: 'adaptive', textbookEvidence,
    options: { enableImageGeneration: false, enableVideoGeneration: false, enableTTS: true } };
  return { course, content, request };
}

async function preparedEntry() {
  const { course, content, request } = entryFixture();
  const before = structuredClone({ course, request });
  const prepared = await prepareTeachingBlueprintInput(course, content, request, 8, 'same-model-and-budget');
  expect({ course, request }).toEqual(before);
  return prepared.input;
}

function firstResponse(input: TeachingBlueprintInput) {
  return { authoringContract: 'blueprint-v5', sections: [{
    id: 'section', title: input.sectionPlans![0]!.title,
    learningObjective: '理解一致性规则如何约束缓存更新与读取',
    sharedContext: { learningPurpose: '理解多个副本的更新与读取关系', caseId: '', caseFacts: [],
      fixedWording: [], stableTerms: ['缓存一致性', '更新', '读取'], conceptBoundaries: [boundary] },
    units: [{ id: 'unit', title: '缓存一致性', knowledgePointIds: ['kp'],
      learningOutcome: '能解释一致性规则如何约束多个副本的更新与读取',
      sourceKind: 'course-source', evidenceQuotes: [definition, mechanism, boundary] }],
    pages: [{ id: 'page', type: 'slide', title: '缓存一致性',
      description: '建立一致性规则与副本更新、读取的关系',
      teachingObjective: '解释多个缓存副本如何遵守一致性规则', estimatedTeachingWeight: 1,
      taskConnection: { mode: 'none', rationale: '直接解释副本规则最清楚，无需项目任务情境。' },
      entryPoint: { kind: 'direct-explanation', object: '同一数据存在多个缓存副本，更新后可能仍有旧值。',
        bridge: '通过更新与读取规则理解缓存一致性。' },
      caseObservation: { kind: 'none', subjects: [] as string[], observableDifference: '',
        reason: '分组文字能清楚说明一致性规则，无需观察图片。', composition: '', resourceIds: [] as string[] },
      visualRelationship: { kind: 'comparison', description: '共同规则约束副本更新与读取',
        readingOrder: ['更新', '读取', '共同规则'], preferredForm: 'text',
        rationale: '共同规则与两项操作可用分组文字说明。' },
      explanationNodes: [
        { id: 'meaning', unitId: 'unit', kind: 'concept', knowledgePointIds: ['kp'],
          prerequisiteNodeIds: [], provenance: 'course-source', contentParts: [{ id: 'definition', text: definition }] },
        { id: 'reasoning', unitId: 'unit', kind: 'mechanism', knowledgePointIds: ['kp'],
          prerequisiteNodeIds: ['meaning'], provenance: 'course-source', contentParts: [{ id: 'reasoning', text: mechanism }] },
        { id: 'oral-boundary', unitId: 'unit', kind: 'condition', knowledgePointIds: ['kp'],
          prerequisiteNodeIds: ['meaning', 'reasoning'], provenance: 'course-source', contentParts: [{ id: 'boundary', text: boundary }] },
      ],
      presentationItems: [
        { text: '缓存一致性', nodeIds: ['meaning'], role: 'heading' },
        { text: '共同规则：多个副本按既定规则更新和读取', nodeIds: ['meaning'], role: 'key-point' },
        { text: '4个缓存副本：读取须符合既定规则', nodeIds: ['meaning', 'reasoning'], role: 'comparison' },
      ],
    }],
    assessmentFocus: ['理解副本更新与读取如何遵守一致性规则'],
    understandingCriteria: { goals: ['能解释缓存一致性的基本含义'],
      answerEssentials: [definition, boundary], misconceptions: ['把立即更新当成唯一实现方式'],
      basis: [{ id: 'explain-consistency', operation: 'explain', answerRelation: 'source-statement',
        claimRefs: [], nodeIds: ['meaning', 'reasoning', 'oral-boundary'] }],
      supportingUnitIds: ['unit'] },
  }] };
}

function legacyResponse(input: TeachingBlueprintInput, variant: 'v3-parts' | 'unmarked-keyPoints') {
  const response = firstResponse(input);
  const section = response.sections[0]!;
  const { explanationNodes, presentationItems: _display, ...page } = section.pages[0]!;
  void _display;
  const nodes = explanationNodes.map(({ unitId: _owner, contentParts, ...node }) => {
    void _owner;
    return { ...node, ...(variant === 'v3-parts' ? { contentParts } : { content: contentParts.map((part) => part.text).join(' ') }) };
  });
  return { ...(variant === 'v3-parts' ? { authoringContract: 'blueprint-v3' } : {}), sections: [{ ...section,
    units: [{ ...section.units[0]!, explanation: definition, mechanism, workedExample: '', conditions: [boundary],
      misconceptions: [], explanationNodes: nodes }],
    pages: [{ ...page, unitIds: ['unit'], introducesNodeIds: nodes.map((node) => node.id),
      deepensNodeIds: [], referencesNodeIds: [], keyPoints: [definition, mechanism],
      ...(variant === 'v3-parts' ? { keyPointRefs: [{ nodeId: 'meaning', partIds: ['definition'] },
        { nodeId: 'reasoning', partIds: ['reasoning'] }] } : {}),
    }],
  }] };
}

describe('production prepared input through independent PPT authoring and confirmation', () => {
  it('keeps the replay input stable when generated pages select a textbook figure, while retaining its page obligation', async () => {
    const { course, content, request } = entryFixture();
    const evidence = request.textbookEvidence!.items[0]!;
    evidence.figureRefs = [{ figureId: 'figure-1', direct: true, relation: 'source-block-direct' }];
    evidence.figureSequencesResolved = true;
    figureRows.mockResolvedValue([{ id: 'figure-1', status: 'AVAILABLE', position: 0,
      caption: '图 1 缓存副本的更新与读取', fileAssetId: 'image-1',
      fileAsset: { deletedAt: null, mimeType: 'image/png' },
      revision: { textbook: { title: '系统原理' } }, section: { title: '缓存一致性' }, width: 1000, height: 560 }]);
    const original = structuredClone({ course, request });
    const before = await prepareTeachingBlueprintInput(course, content, request, 8, 'same-model-and-budget', content);
    const figure = before.textbookFigureResources[0]!;
    expect(before.input.textbookFigures).toEqual([expect.objectContaining({ resourceId: figure.id, required: false })]);
    const response = firstResponse(before.input);
    response.sections[0]!.pages[0]!.caseObservation = {
      kind: 'source-image', subjects: ['缓存副本'], observableDifference: '更新与读取受共同规则约束',
      reason: '教材原图帮助观察副本关系', composition: '图文观察', resourceIds: [figure.id] };
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));
    const blueprint = await generateTeachingBlueprint(before.input, aiCall);
    const confirmed = { ...course, content: { ...content, teachingBlueprint: blueprint,
      _openmaicSceneOutlines: teachingBlueprintToOutlines(blueprint, '使用简体中文') } };
    const after = await prepareTeachingBlueprintInput(confirmed, confirmed.content, request, 8,
      'same-model-and-budget', confirmed.content);
    const replayHash = (input: TeachingBlueprintInput) => teachingBlueprintContentFingerprint({ ...input, priorSourceExamples: undefined });
    expect(replayHash(after.input)).toBe(replayHash(before.input));
    expect(scopeCourseTextbookFigures(after.textbookFigureResources, blueprint.sections.flatMap(section => section.pages)))
      .toEqual([expect.objectContaining({ id: figure.id, required: true })]);
    const changed = structuredClone(confirmed);
    changed.content.knowledgePoints[0]!.description += '教师新增掌握条件';
    const edited = await prepareTeachingBlueprintInput(changed, changed.content, request, 8, 'same-model-and-budget', changed.content);
    expect(replayHash(edited.input)).not.toBe(replayHash(before.input));
    expect({ course, request }).toEqual(original);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('keeps useful core presentation independent from all original-source teaching throughout first write, confirmation and saved reuse', async () => {
    const input = await preparedEntry();
    expect(input.generationModelFingerprint).toBe('same-model-and-budget');
    expect(input.firstAuthoringContract).toBe('blueprint-v5');
    expect(input.totalDurationSec).toBe(480);
    [definition, mechanism, boundary].forEach((text) => expect(input.sourceContext).toContain(text));
    expect(input.sourceConceptStatements?.some((concept) => concept.statements
      .some((statement) => statement.text.includes('缓存一致性是')))).toBe(true);
    const response = firstResponse(input);
    const rawBefore = structuredClone(response);
    const aiCall = vi.fn(async (system: string, prompt: string) => {
      expect(system).toContain('authoringContract 固定为 blueprint-v5');
      expect(system).toContain('role 不能只是给完整解释段落换一个名字');
      expect(system).toContain('完整讲授职责由实际落页的节点承担');
      expect(system).toContain('不要求所有节点逐项可见');
      expect(system).not.toContain('keyPoints 应包含');
      expect(system).not.toContain('进入 keyPoints');
      expect(prompt).toContain(JSON.stringify(sourceText));
      return JSON.stringify(response);
    });
    const generated = await generateTeachingBlueprint(input, aiCall);
    expect(aiCall).toHaveBeenCalledOnce();
    expect(response).toEqual(rawBefore);
    const display = response.sections[0]!.pages[0]!.presentationItems.map((item) => item.text);
    const originalNodes = generated.sections[0]!.units[0]!.explanationNodes!;
    expect(originalNodes.map((node) => node.content)).toEqual([definition, mechanism, boundary]);
    const ownership = generated.sections[0]!.pages[0]!.introducesNodeIds;
    expect(ownership).toEqual(originalNodes.map((node) => node.id));

    let current = generated;
    for (let confirmation = 0; confirmation < 2; confirmation += 1) {
      const outlines = teachingBlueprintToOutlines(current, '使用简体中文');
      const slide = outlines.find((outline) => outline.type === 'slide')!;
      expect(slide.keyPoints).toEqual(display);
      expect(slide.teachingBrief?.teachingPlan?.presentationContent).toEqual(display);
      expect(slide.teachingBrief?.teachingPlan?.visibleContent).toEqual(display);
      expect(slide.teachingBrief?.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
      expect(slide.teachingBrief?.authoring?.nodes).toEqual(originalNodes);
      [definition, mechanism, boundary].forEach((text) => expect(slide.teachingBrief?.explanation).toContain(text));
      expect(slide.teachingBrief?.evidence.map((entry) => entry.quote)).toEqual([definition, mechanism, boundary]);
      expect(slide.teachingBrief?.conditions).toEqual([boundary]);
      expect(buildTeachingNarrationSemantics(slide).visible.map((item) => item.text)).toEqual(display);
      expect(slide.teachingBrief?.teachingPlan?.narrationFocus.join('\n')).toContain(boundary);
      expect(slide.teachingBrief?.teachingPlan?.presentationItems?.flatMap((item) => item.nodeIds))
        .not.toContain(originalNodes[2]!.id);
      expect(validateTeachingBlueprintBudget(current, outlines)).toEqual([]);
      const reviewed = applyReviewedOutlinesToTeachingBlueprint(current, outlines);
      const resumed = revalidateStoredTeachingBlueprint(reviewed, input);
      expect(resumed.issues).toEqual([]);
      current = resumed.blueprint!;
      expect(current.sections[0]!.units[0]!.explanationNodes).toEqual(originalNodes);
      expect(current.sections[0]!.pages[0]!.introducesNodeIds).toEqual(ownership);
      expect(current.budget).toEqual(generated.budget);
    }
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('records a changed core quantity without interrupting an executable first draft', async () => {
    const input = await preparedEntry();
    const response = firstResponse(input);
    response.sections[0]!.pages[0]!.presentationItems[2]!.text = '6个缓存副本：读取须符合既定规则';
    const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input, aiCall), '数量或单位');
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it.each(['v3-parts', 'unmarked-keyPoints', 'v5-missing-items'] as const)
    ('diagnoses a fresh %s response under the requested contract without spending another call', async (variant) => {
      const input = await preparedEntry();
      const response = variant === 'v5-missing-items'
        ? { ...firstResponse(input), sections: firstResponse(input).sections.map((section) => ({ ...section,
          pages: section.pages.map((page) => ({ ...page, presentationItems: undefined })) })) }
        : legacyResponse(input, variant);
      const before = structuredClone(response);
      const aiCall = vi.fn().mockResolvedValue(JSON.stringify(response));
      await expectBlueprintQualityIssue(generateTeachingBlueprint(input, aiCall), '缺少 presentationItems');
      expect(aiCall).toHaveBeenCalledOnce();
      expect(response).toEqual(before);
    });

  it.each(['v3-parts', 'unmarked-keyPoints'] as const)
    ('retains compatibility for an existing %s response without applying the current first-writing policy', async (variant) => {
      const input = await preparedEntry();
      const response = legacyResponse(input, variant);
      const aiCall = vi.fn();
      const existing = await generateTeachingBlueprint(input, aiCall, { repairFrom: { response: JSON.stringify(response), issues: [] } });
      expect(aiCall).not.toHaveBeenCalled();
      expect(existing.sections[0]!.pages[0]!.presentationItems).toBeUndefined();
      expect(existing.sections[0]!.pages[0]!.keyPoints).toEqual([definition, mechanism]);
      expect(revalidateStoredTeachingBlueprint(existing, input).issues).toEqual([]);
      expect(existing.sections[0]!.units[0]!.explanationNodes?.map((node) => node.content)).toEqual([definition, mechanism, boundary]);
    });

  it('keeps nonblocking contract diagnostics across repeated checkpoint restoration', async () => {
    const input = await preparedEntry();
    const candidate = legacyResponse(input, 'v3-parts');
    const rawResponse = JSON.stringify(candidate);
    let validation: TeachingBlueprintValidation | undefined;
    const firstCall = vi.fn().mockResolvedValue(rawResponse);
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input, firstCall, { onValidation: (value) => { validation = value; } }), '缺少 presentationItems');
    expect(firstCall).toHaveBeenCalledOnce();
    const checkpoint = JSON.parse(JSON.stringify({ schemaVersion: 1, status: 'invalid-output',
      inputFingerprint: teachingBlueprintInputFingerprint(input), contentFingerprint: teachingBlueprintContentFingerprint(input),
      modelFingerprint: input.generationModelFingerprint, firstAuthoringContract: input.firstAuthoringContract,
      rawResponse, bestCandidate: validation?.candidate, validationIssues: validation?.issues }));
    const before = structuredClone(checkpoint);
    const aiCall = vi.fn();
    for (let restart = 0; restart < 2; restart += 1) {
      const restored = restoreTeachingBlueprintRepairSource(checkpoint, teachingBlueprintInputFingerprint(input),
        teachingBlueprintContentFingerprint(input), 'legacy', input.generationModelFingerprint!, [], input);
      expect(restored?.firstAuthoringContract).toBe('blueprint-v5');
      await expectBlueprintQualityIssue(generateTeachingBlueprint(input, aiCall, { repairFrom: restored }), '缺少 presentationItems');
    }
    await expectBlueprintQualityIssue(generateTeachingBlueprint(input, aiCall, {
      repairFrom: { response: rawResponse, issues: [] }, firstAuthoringContract: checkpoint.firstAuthoringContract,
    }), '缺少 presentationItems');
    expect(aiCall).not.toHaveBeenCalled();
    expect(checkpoint).toEqual(before);
  });

  it('keeps the first-writing contract out of the original-source content fingerprint', async () => {
    const input = await preparedEntry();
    expect(teachingBlueprintContentFingerprint({ ...input, firstAuthoringContract: undefined }))
      .toBe(teachingBlueprintContentFingerprint(input));
  });
});

async function expectBlueprintQualityIssue(result: ReturnType<typeof generateTeachingBlueprint>, issue?: string | RegExp) {
  const blueprint = await result;
  expect(blueprint.qualityDiagnostics?.length).toBeGreaterThan(0);
  if (issue && issue !== '教学蓝图缺少可用结构') expect(blueprint.qualityDiagnostics!.join('；')).toMatch(issue);
  return blueprint;
}
