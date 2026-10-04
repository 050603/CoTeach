import { TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION } from './teaching-contract-version';
import { describe, expect, it, vi } from 'vitest';
import type { AICallFn } from './pipeline-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import {
  enhanceTeachingBriefs,
  buildTeachingEnhancementPrompt,
  hasCurrentTeachingBrief,
  hasCompleteTeachingBrief,
  normalizeTeachingEnhancement,
  TEACHING_ENHANCEMENT_VERSION,
  formatTeachingEnhancementBlock,
  withTeachingEnhancement,
} from './teaching-enhancement';

function page(id: string, order: number): SceneOutline {
  return {
    id,
    type: 'slide',
    title: `页面${order + 1}`,
    description: '解释人工智能输出与证据之间的关系。',
    keyPoints: ['流畅表达不能代替事实核验'],
    teachingObjective: '能够说明核验步骤和理由',
    order,
    generationPurpose: 'knowledge-teaching',
    parentActivityId: 'section-1',
  };
}

const teachingPlan = {
  purpose: '解释事实核验依据', priorKnowledge: '会区分主张和证据', newContent: '判断来源是否独立',
  learnerQuestion: '多个网页为什么不一定是多份证据', reasoningSteps: ['检查是否转载同一来源'],
  takeaway: '判断来源独立性，而不是只数网页', visibleContent: ['转载来源之间的关系'],
  narrationFocus: ['为什么同源转载不能相互证实'], introduces: ['node-1'], deepens: [], references: [],
  taskConnection: { mode: 'none' as const, rationale: '独立的校史核验例子比绑定最终项目更直接。' },
  entryPoint: { kind: 'familiar-experience' as const, object: '搜索同一校史年份却看到多个相同网页', bridge: '从网页很多是否等于证据很多，引出来源独立性' },
  visualRelationship: {
    kind: 'system' as const,
    description: '显示多个网页回溯到同一原始来源，而不是彼此独立支持。',
    readingOrder: ['多个网页', '转载关系', '同一原始来源'],
    preferredForm: 'diagram' as const,
    rationale: '连线能直接暴露来源并不独立。',
  },
};
const sharedContext = {
  learningPurpose: '判断信息能否作为可靠依据', caseId: 'school-history-check',
  caseFacts: ['多个网页可能转载同一份校史材料'], fixedWording: ['先确认来源关系'],
  stableTerms: ['独立来源', '同源转载'], conceptBoundaries: ['网页数量不等于独立证据数量'],
};

const originalDefinition = '来源独立性是不同材料各自形成其证据的属性。';
const originalCaseFact = '三个网页转载同一份校史材料。';
function modernPage(): SceneOutline {
  const result = page('modern', 0);
  const source = { evidenceItemId: 'source', sourceBlockIds: ['block'], textbookId: 'book', revisionId: 'revision' };
  result.teachingBrief = {
    schemaVersion: 1, explanation: originalDefinition, examples: [originalCaseFact], conditions: [originalDefinition],
    evidence: [{ sourceId: 'source', quote: originalDefinition }], assessmentFocus: '区分材料来源',
    sharedContext: { ...sharedContext, caseFacts: [originalCaseFact], fixedWording: [originalDefinition] },
    teachingPlan: { ...teachingPlan, newContent: originalDefinition, reasoningSteps: [originalCaseFact],
      takeaway: originalDefinition, narrationFocus: [originalDefinition], visibleContent: [originalDefinition, originalCaseFact],
      presentationContent: ['网页与其原始来源'],
      presentationItems: [{ text: '网页与其原始来源', nodeIds: ['definition'], role: 'key-point' }],
      presentationTypography: { profile: 'reference-lecture-v1', bodyFontSize: 18, minimumBodyFontSize: 16 },
      introduces: ['definition', 'example'], deepens: [], references: [],
      visualRelationship: { kind: 'system', preferredForm: 'diagram', description: '多个网页连接同一原始来源',
        readingOrder: ['网页', '来源'], diagram: { topology: 'branch', nodes: [
          { id: 'origin', label: '原始材料' }, { id: 'copy', label: '转载网页' },
        ], edges: [{ from: 'origin', to: 'copy', label: '转载' }] } },
    },
    learningBoundary: { prerequisiteKnowledge: [], previouslyTaughtKnowledge: [],
      currentKnowledge: [{ id: 'kp', name: '独立来源' }], futureKnowledge: [{ id: 'next', name: '证据冲突' }] },
    understandingCriteria: { goalSource: 'basis', goals: ['识别多个网页之间的来源关系'],
      answerEssentials: [originalDefinition], misconceptions: ['LEGACY_ANSWER_LIST'], supportingUnitIds: ['unit'],
      basis: [{ id: 'identify', goal: '识别多个网页之间的来源关系',
        claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], nodeIds: ['definition', 'example'],
        exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'book-case' }] }] },
    requirementIds: ['difficulty'], difficultyStrategies: [{ requirementId: 'difficulty',
      learnerObstacle: '把网页数量视为来源数量', teachingApproach: '沿转载关系回到原始材料', understandingEvidence: '指出各网页的原始来源' }],
    resourceNeeds: [{ kind: 'source-image', purpose: '比较来源记录', required: true, assetId: 'image' }],
    authoring: {
      nodes: [{ id: 'definition', kind: 'concept', content: originalDefinition, knowledgePointIds: ['kp'],
        prerequisiteNodeIds: [], provenance: 'course-source', claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }],
        sourceBindings: [{ ...source, quote: originalDefinition }], quoteDuties: [{ source: { ...source, quote: originalDefinition } }] },
      { id: 'example', kind: 'example', content: originalCaseFact, knowledgePointIds: ['kp'], prerequisiteNodeIds: ['definition'],
        provenance: 'derived', claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], exampleIds: ['book-case'], quoteDuties: [] }],
      examplePlans: [{ knowledgePointId: 'kp', mode: 'textbook', selectedExampleIds: ['book-case'], rationale: '分析具体转载关系' }],
      knowledge: [{ knowledgePointId: 'kp', authoring: { claims: [{ id: 'definition', kind: 'textbook', text: originalDefinition,
        sources: [{ ...source, quote: originalDefinition }] }], examples: [{ id: 'book-case', kind: 'textbook',
        title: 'FREE_CASE_TITLE', purpose: 'FREE_CASE_PURPOSE', explanation: 'FREE_CASE_EXPLANATION',
        conceptMapping: 'FREE_CASE_MAPPING', facts: [originalCaseFact], claimIds: ['definition'],
        sources: [{ ...source, quote: originalCaseFact }] }], exampleCoverage: [] } }],
    },
  };
  return result;
}

function sharedDesign(block: string) {
  return JSON.parse(block.split('\n').find((line) => line.startsWith('{'))!);
}

describe('single-body native teaching adapter', () => {
  it.each(['content', 'actions'] as const)('passes one complete body and factual case into the %s call without legacy prose copies', async (phase) => {
    const outline = modernPage();
    const before = structuredClone(outline);
    const ai = vi.fn<AICallFn>().mockResolvedValue('{}');
    await withTeachingEnhancement(ai, outline, phase)('system', 'user');
    expect(ai).toHaveBeenCalledOnce();
    const block = ai.mock.calls[0]![1];
    const design = sharedDesign(block);
    expect(block.split(originalDefinition)).toHaveLength(2);
    expect(block.split(originalCaseFact)).toHaveLength(2);
    for (const field of ['FREE_CASE_TITLE', 'FREE_CASE_PURPOSE', 'FREE_CASE_EXPLANATION', 'FREE_CASE_MAPPING', 'LEGACY_ANSWER_LIST']) {
      expect(block).not.toContain(field);
    }
    for (const field of ['explanation', 'examples', 'conditions', 'evidence', 'authoring', 'sharedContext']) expect(design).not.toHaveProperty(field);
    for (const field of ['newContent', 'reasoningSteps', 'narrationFocus', 'takeaway', 'visibleContent']) expect(design.teachingPlan).not.toHaveProperty(field);
    expect(design.teachingAuthoring.explanationNodes.map((node: { bodyRef: string }) => design.teachingAuthoring.texts[node.bodyRef]))
      .toEqual([originalDefinition, originalCaseFact]);
    expect(design.pageAuthoring.nodeDuties.map((duty: { nodeId: string }) => duty.nodeId)).toEqual(['definition', 'example']);
    expect(design.teachingPlan.visualRelationship).toEqual(outline.teachingBrief!.teachingPlan!.visualRelationship);
    expect(design.teachingPlan.presentationContent).toEqual(['网页与其原始来源']);
    expect(design.teachingPlan.presentationItems).toEqual(outline.teachingBrief!.teachingPlan!.presentationItems);
    expect(design.teachingPlan.presentationTypography).toEqual(outline.teachingBrief!.teachingPlan!.presentationTypography);
    expect(design.learningBoundary).toEqual(outline.teachingBrief!.learningBoundary);
    expect(design.resourceNeeds).toEqual(outline.teachingBrief!.resourceNeeds);
    expect(design.difficultyStrategies).toEqual(outline.teachingBrief!.difficultyStrategies);
    expect(block).toContain('through teachingAuthoring.texts');
    expect(block).not.toContain('teachingPlan.visibleContent retains');
    expect(outline).toEqual(before);
  });

  it('keeps an interactive operation task and supplies the actual bound prior claim from the canonical directory', () => {
    const outline = modernPage();
    outline.type = 'interactive';
    outline.teachingBrief!.pageTask = { learnerAction: '把网页连接到原始来源', newContribution: '按实际来源划分材料',
      reasoningFocus: '核对每条转载关系', caseUse: 'reuse', changedConditions: [], preservedConditions: ['原始来源相同'] };
    const basis = outline.teachingBrief!.understandingCriteria!.basis![0]!;
    basis.claimRefs.push({ knowledgePointId: 'prior', claimId: 'prior-claim' });
    const priorText = '每份材料应保留可核对的来源记录。';
    const design = sharedDesign(formatTeachingEnhancementBlock(outline, 'content', undefined, [
      { id: 'prior', authoring: { claims: [{ id: 'prior-claim', kind: 'textbook', text: priorText, sources: [] }], examples: [], exampleCoverage: [] } },
      { id: 'unrelated', authoring: { claims: [{ id: 'unused', kind: 'textbook', text: 'UNRELATED_FUTURE_TEXT', sources: [] }], examples: [], exampleCoverage: [] } },
    ]));
    const prior = design.teachingAuthoring.statements.find((claim: { knowledgePointId: string }) => claim.knowledgePointId === 'prior');
    expect(design.teachingAuthoring.texts[prior.statementRef]).toBe(priorText);
    expect(design.teachingAuthoring).not.toHaveProperty('unavailableClaimRefs');
    expect(JSON.stringify(design)).not.toContain('UNRELATED_FUTURE_TEXT');
    expect(design.pageTask).toEqual(outline.teachingBrief!.pageTask);
    expect(design.pageAuthoring.nodeDuties).toHaveLength(2);
    expect(design.pageAuthoring.examplePlans.map((plan: { knowledgePointId: string }) => plan.knowledgePointId)).toEqual(['kp']);
  });

  it('retains the full no-authoring legacy prompt and its evidence reference adapter unchanged', () => {
    const outline = modernPage();
    delete outline.teachingBrief!.authoring;
    expect(sharedDesign(formatTeachingEnhancementBlock(outline, 'content'))).toEqual(outline.teachingBrief);
    expect(formatTeachingEnhancementBlock(outline, 'content')).toContain('teachingPlan.visibleContent retains');
    const reference = vi.fn().mockReturnValue('legacy-original-text');
    const design = sharedDesign(formatTeachingEnhancementBlock(outline, 'actions', reference));
    expect(design).toEqual({ ...outline.teachingBrief,
      evidence: [{ sourceId: 'source', quoteRef: 'legacy-original-text' }] });
    expect(reference).toHaveBeenCalledWith(originalDefinition);
    expect(design).not.toHaveProperty('teachingAuthoring');
  });
});

describe('formal course teaching enhancement', () => {
  it('treats malformed stored briefs as incomplete instead of crashing a resumed job', () => {
    const malformed = page('p1', 0);
    malformed.teachingBrief = {
      schemaVersion: 1,
      explanation: '已有解释',
      examples: undefined,
      conditions: ['已有条件'],
      evidence: [],
      assessmentFocus: '已有考查重点',
    } as unknown as NonNullable<SceneOutline['teachingBrief']>;
    expect(hasCompleteTeachingBrief(malformed)).toBe(false);
  });

  it('accepts complete page designs and keeps only exact source evidence', () => {
    const source = '指导文件要求：学生需要核验生成内容的事实与来源。';
    const inputPage = page('p1', 0);
    inputPage.teachingBrief = {
      schemaVersion: 1,
      explanation: '已有蓝图解释',
      examples: [],
      conditions: [],
      evidence: [],
      assessmentFocus: '已有重点',
      learningBoundary: {
        prerequisiteKnowledge: [],
        previouslyTaughtKnowledge: [],
        currentKnowledge: [{ id: 'source-check', name: '来源核验' }],
        futureKnowledge: [{ id: 'independent-source', name: '独立来源' }],
      },
    };
    const briefs = normalizeTeachingEnhancement({ sharedContext, pages: [{
      outlineId: 'p1',
      explanation: '表达流畅来自语言模式，不能证明事实成立。',
      examples: ['核对校史年份：先标出主张，再查官方校志并记录差异。'],
      conditions: ['官网转载同一错误时，不能算作独立来源。'],
      assessmentFocus: '说明核验步骤以及每一步的理由。',
      teachingPlan, evidenceQuotes: ['学生需要核验生成内容的事实与来源', '并不存在的原句'],
    }] }, [inputPage], source);
    const brief = briefs.get('p1');
    expect(brief?.examples).toHaveLength(1);
    expect(brief?.conditions).toHaveLength(1);
    expect(brief?.teachingPlan?.entryPoint).toEqual(teachingPlan.entryPoint);
    expect(brief?.teachingPlan?.visualRelationship).toEqual(teachingPlan.visualRelationship);
    expect(brief?.evidence).toEqual([
      { sourceId: 'course-source', quote: '学生需要核验生成内容的事实与来源' },
    ]);
    expect(brief?.learningBoundary).toEqual(inputPage.teachingBrief!.learningBoundary);
  });

  it('exposes the compiled learning boundary to slide, interaction, and action prompts', async () => {
    const inputPage = page('p1', 0);
    inputPage.teachingBrief = {
      schemaVersion: 1,
      explanation: '先建立教学模式的一般含义。',
      examples: [],
      conditions: [],
      evidence: [],
      assessmentFocus: '区分结构与技巧',
      learningBoundary: {
        prerequisiteKnowledge: [],
        previouslyTaughtKnowledge: [],
        currentKnowledge: [{ id: 'teaching-mode', name: '教学模式' }],
        futureKnowledge: [{ id: 'pbl', name: '项目式学习' }],
      },
    };
    const calls: Array<{ system: string; user: string }> = [];
    const wrapped = withTeachingEnhancement(async (system, user) => {
      calls.push({ system, user });
      return '{}';
    }, inputPage, 'content');
    await wrapped('base system', 'base user');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.user).toContain('"futureKnowledge":[{"id":"pbl","name":"项目式学习"}]');
    expect(calls[0]?.user).toContain('futureKnowledge may be named only in an agenda or goal');
  });

  it('recovers a single-page section when the model returns a placeholder outline id', () => {
    const briefs = normalizeTeachingEnhancement({ sharedContext, pages: [{
      outlineId: 'x',
      explanation: '教学模式需要按学习目标、内容性质和课堂条件选择。',
      examples: [],
      conditions: ['模式适配是倾向，不是绝对限制。'],
      assessmentFocus: '能根据目标说明模式选择理由。',
      teachingPlan,
      evidenceQuotes: [],
    }] }, [page('actual-outline-id', 0)]);

    expect(briefs.get('actual-outline-id')).toMatchObject({
      explanation: '教学模式需要按学习目标、内容性质和课堂条件选择。',
      designVersion: TEACHING_ENHANCEMENT_VERSION,
    });
  });

  it('does not guess placeholder outline ids for multi-page sections', () => {
    const responsePage = {
      outlineId: 'x',
      explanation: '无法安全确定属于哪一页。',
      examples: [],
      conditions: [],
      assessmentFocus: '说明理由。',
      teachingPlan,
      evidenceQuotes: [],
    };

    expect(() => normalizeTeachingEnhancement(
      { sharedContext, pages: [responsePage, { ...responsePage, outlineId: 'y' }] },
      [page('p1', 0), page('p2', 1)],
    )).toThrow('教学增强缺少页面');
  });

  it('creates one shared design call and propagates page briefs into the section quiz', async () => {
    const pages = [page('p1', 0), page('p2', 1)];
    const quiz = {
      ...page('quiz', 2),
      type: 'quiz' as const,
      quizConfig: { questionCount: 2, difficulty: 'medium' as const, questionTypes: ['short_answer' as const] },
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ sharedContext, pages: pages.map((item) => ({
      outlineId: item.id,
      explanation: `${item.id} 的机制解释`,
      examples: [`${item.id} 的完整示例`],
      conditions: [`${item.id} 的适用条件`],
      assessmentFocus: `${item.id} 的解释与应用`,
      teachingPlan, evidenceQuotes: [],
    })) }));
    const outlines = await enhanceTeachingBriefs({
      outlines: [...pages, quiz],
      courseTitle: '生成式人工智能通识',
      requirement: '面向中学生讲解人工智能核验',
      aiCall: ai,
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(outlines.slice(0, 2).every(hasCompleteTeachingBrief)).toBe(true);
    expect(outlines[0]?.keyPoints).toEqual(outlines[0]?.teachingBrief?.teachingPlan?.visibleContent);
    expect(outlines[2]?.teachingBrief?.examples).toEqual(['p1 的完整示例', 'p2 的完整示例']);
    expect(outlines[2]?.teachingBrief?.assessmentFocus).toContain('p1 的解释与应用');
  });

  it('keeps an accepted quiz brief stable when its teaching page gains continuation slides', async () => {
    const first = page('p1', 0);
    first.teachingBrief = {
      schemaVersion: 1,
      designVersion: TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION,
      sharedContext,
      teachingPlan,
      explanation: '先核验原始来源，再判断网页是否独立。',
      examples: ['同一份校志被多个网页转载。'],
      conditions: ['同源转载不能作为多份独立证据。'],
      evidence: [],
      assessmentFocus: '说明判断来源独立性的依据。',
      resourceNeeds: [
        { kind: 'image', prompt: '两张转载网页的可见对照', purpose: '观察来源差异', required: true },
        { kind: 'diagram', prompt: '网页回溯原始来源', purpose: '说明来源关系', required: true },
      ],
    };
    const quiz = { ...page('quiz', 2), type: 'quiz' as const };
    const aiCall = vi.fn<AICallFn>();
    const testOutlines = await enhanceTeachingBriefs({ outlines: [first, quiz], requirement: '判断来源', aiCall });
    const continued = { ...first, id: 'p1--continuation-2', order: 1 };
    const fullOutlines = await enhanceTeachingBriefs({ outlines: [first, continued, quiz], requirement: '判断来源', aiCall });

    expect(aiCall).not.toHaveBeenCalled();
    expect(fullOutlines[2]?.teachingBrief).toEqual(testOutlines[1]?.teachingBrief);
    expect(fullOutlines[2]?.teachingBrief?.resourceNeeds).toHaveLength(2);
  });

  it('splits teaching design by section and reports bounded progress', async () => {
    const first = page('p1', 0);
    const second = { ...page('p2', 1), parentActivityId: 'section-2' };
    const progress: string[] = [];
    const ai = vi.fn<AICallFn>().mockImplementation(async (_system, user) => {
      const outlineId = user.includes('[p1]') ? 'p1' : 'p2';
      return JSON.stringify({ sharedContext, pages: [{
        outlineId,
        explanation: `${outlineId} 的机制解释`,
        examples: [`${outlineId} 的完整示例`],
        conditions: [`${outlineId} 的适用条件`],
        assessmentFocus: `${outlineId} 的解释与应用`,
        teachingPlan, evidenceQuotes: [],
      }] });
    });
    const outlines = await enhanceTeachingBriefs({
      outlines: [first, second],
      requirement: '分小节完成教学设计',
      aiCall: ai,
      concurrency: 2,
      onProgress: ({ completedSections, totalSections }) => {
        progress.push(`${completedSections}/${totalSections}`);
      },
    });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(ai.mock.calls.every(([, user]) => !(user.includes('[p1]') && user.includes('[p2]')))).toBe(true);
    expect(outlines.every(hasCompleteTeachingBrief)).toBe(true);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('restores a completed section design without repeating its model call', async () => {
    const first = page('p1', 0);
    let saved: {
      sectionKey: string;
      inputFingerprint: string;
      modelFingerprint: string;
      briefs: Array<[string, unknown]>;
    } | null = null;
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ sharedContext, pages: [{
      outlineId: first.id,
      explanation: '语言流畅来自模式匹配，不能单独证明事实正确。',
      examples: ['标出年份主张，再到独立原始资料中逐项核对。'],
      conditions: ['同源转载不能当作多个独立来源。'],
      assessmentFocus: '说明核验步骤以及每一步的理由。',
      teachingPlan, evidenceQuotes: [],
    }] }));
    const common = {
      outlines: [first],
      requirement: '恢复小节教学设计',
      modelFingerprint: 'model-a',
    };
    await enhanceTeachingBriefs({
      ...common,
      aiCall: ai,
      onSectionCompleted: (sectionKey, inputFingerprint, modelFingerprint, briefs) => {
        saved = { sectionKey, inputFingerprint, modelFingerprint, briefs };
      },
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(saved).not.toBeNull();

    const resumedAi = vi.fn<AICallFn>().mockRejectedValue(new Error('must not be called'));
    const resumed = await enhanceTeachingBriefs({
      ...common,
      aiCall: resumedAi,
      loadSectionCheckpoint: (sectionKey, inputFingerprint, modelFingerprint) => (
        saved
        && saved.sectionKey === sectionKey
        && saved.inputFingerprint === inputFingerprint
        && saved.modelFingerprint === modelFingerprint
          ? saved.briefs
          : null
      ),
    });
    expect(resumedAi).not.toHaveBeenCalled();
    expect(resumed.every(hasCompleteTeachingBrief)).toBe(true);
  });

  it('rejects an incomplete course design instead of silently mixing enhanced and baseline pages', async () => {
    const first = page('p1', 0);
    const second = { ...page('p2', 1), parentActivityId: 'section-2' };
    const warnings: string[] = [];
    const progress: string[] = [];
    const ai = vi.fn<AICallFn>().mockImplementation(async (_system, user) => (
      user.includes('[p1]')
        ? JSON.stringify({ sharedContext, pages: [{
            outlineId: 'p1',
            explanation: 'p1 的机制解释',
            examples: ['p1 的完整示例'],
            conditions: ['p1 的适用条件'],
            assessmentFocus: 'p1 的解释与应用',
            teachingPlan, evidenceQuotes: [],
          }] })
        : '{"pages":['
    ));
    await expect(enhanceTeachingBriefs({
      outlines: [first, second],
      requirement: '一个小节失败时保留其他增强结果',
      aiCall: ai,
      retrySleep: async () => undefined,
      concurrency: 4,
      onWarning: (warning) => { warnings.push(warning); },
      onProgress: ({ completedSections, totalSections }) => {
        progress.push(`${completedSections}/${totalSections}`);
      },
    })).rejects.toThrow('教学增强缺少页面');
    expect(warnings).toEqual([expect.stringContaining('页面2')]);
    expect(ai).toHaveBeenCalledTimes(2);
    expect(progress[0]).toBe('0/2');
    expect(progress.at(-1)).toBe('2/2');
  });

  it('keeps the system prefix stable while putting page design only in the user message', async () => {
    const first = page('p1', 0);
    first.teachingBrief = {
      schemaVersion: 1,
      explanation: '解释一', examples: ['例子一'], conditions: ['条件一'], evidence: [], assessmentFocus: '考查一',
    };
    const second = page('p2', 1);
    second.teachingBrief = {
      schemaVersion: 1,
      explanation: '解释二', examples: ['例子二'], conditions: ['条件二'], evidence: [], assessmentFocus: '考查二',
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue('ok');
    await withTeachingEnhancement(ai, first, 'content')('base-system', 'base-user');
    await withTeachingEnhancement(ai, second, 'content')('base-system', 'base-user');
    expect(ai.mock.calls[0]?.[0]).toBe(ai.mock.calls[1]?.[0]);
    expect(ai.mock.calls[0]?.[0]).not.toContain('解释一');
    expect(ai.mock.calls[0]?.[1]).toContain('解释一');
    expect(ai.mock.calls[0]?.[1]).toContain('Use teachingPlan.visualRelationship');
    expect(ai.mock.calls[0]?.[1]).toContain('preferredForm and rationale are pedagogical preferences');
    expect(ai.mock.calls[0]?.[1]).toContain('There is no format-variety quota');
    expect(ai.mock.calls[0]?.[1]).toContain('Keep introduces/deepens/references as page ownership boundaries');
    expect(ai.mock.calls[0]?.[1]).toContain('Respect teachingPlan.taskConnection as a hard gate');
    expect(ai.mock.calls[0]?.[1]).toContain('Never print internal IDs, provenance, source status, review items');
    expect(ai.mock.calls[1]?.[1]).toContain('解释二');
  });
});

describe('adopted historical teaching contracts', () => {
  const brief = () => normalizeTeachingEnhancement({ sharedContext, pages: [{ outlineId: 'p1',
    explanation: '检查页面的来源关系', examples: [], conditions: [], assessmentFocus: '识别同源转载',
    evidenceQuotes: [], teachingPlan }] }, [page('p1', 0)]).get('p1')!;

  it('preserves complete historical compiled and enhanced plans without model calls or version rewriting', async () => {
    const outlines = ['teaching-blueprint-v3-compiled-v12-learning-boundary', 'shared-page-contract-v18-learning-boundary']
      .map((designVersion, index) => ({ ...page(`p${index + 1}`, index), teachingBrief: { ...brief(), designVersion } }));
    const original = structuredClone(outlines);
    const ai = vi.fn<AICallFn>();
    const restored = await enhanceTeachingBriefs({ outlines, requirement: '保留已确认教学设计', aiCall: ai });
    expect(ai).not.toHaveBeenCalled();
    expect(restored).toEqual(original);
    expect(outlines).toEqual(original);
    expect(restored.every(hasCurrentTeachingBrief)).toBe(true);
  });

  it.each(['old', 'unrelated-v12-learning-boundary', 'teaching-blueprint-v3-compiled-v999-learning-boundary',
    'shared-page-contract-v999-learning-boundary', 'shared-page-contract-v0-learning-boundary'])
  ('does not assume unknown or future contract semantics are supported: %s', (designVersion) => {
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: { ...brief(), designVersion } })).toBe(false);
  });

  it('requires the full supported structure even when the version family is recognized', () => {
    const valid = { ...brief(), designVersion: 'teaching-blueprint-v3-compiled-v12-learning-boundary' };
    for (const invalid of [
      { ...valid, schemaVersion: 2 }, { ...valid, explanation: '' }, { ...valid, examples: undefined },
      { ...valid, sharedContext: { ...sharedContext, learningPurpose: '' } },
      { ...valid, teachingPlan: { ...teachingPlan, taskConnection: undefined } },
      { ...valid, teachingPlan: { ...teachingPlan, taskConnection: { mode: 'none', rationale: '' } } },
      { ...valid, teachingPlan: { ...teachingPlan, narrationFocus: undefined } },
    ]) expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: invalid as typeof valid })).toBe(false);
  });
});

 describe('adaptive teaching contracts', () => {
  it('allows a focused page with no extra example or boundary and preserves its explanation responsibilities', () => {
    const brief = normalizeTeachingEnhancement({ sharedContext, pages: [{ outlineId: 'p1', explanation: '检查多个页面是否转载同一来源',
      examples: [], conditions: [], assessmentFocus: '识别同源转载', evidenceQuotes: [], teachingPlan }] }, [page('p1', 0)]).get('p1')!;
    expect(brief.examples).toEqual([]);
    expect(brief.conditions).toEqual([]);
    expect(brief.teachingPlan).toEqual(teachingPlan);
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: brief })).toBe(true);
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: { ...brief, designVersion: 'old' } })).toBe(false);
    const compiled = { ...brief, designVersion: TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION };
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: compiled })).toBe(true);
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: { ...compiled, explanation: '' } })).toBe(false);
    expect(hasCurrentTeachingBrief({ ...page('p1', 0), teachingBrief: { ...compiled, teachingPlan: { ...teachingPlan, taskConnection: undefined } } })).toBe(false);
    expect(hasCurrentTeachingBrief({
      ...page('p1', 0),
      teachingBrief: { ...brief, teachingPlan: { ...teachingPlan, taskConnection: undefined } },
    })).toBe(false);
  });

  it('does not let enhancement promote a blueprint page into project work', () => {
    const adoptedPage = page('p1', 0);
    adoptedPage.teachingBrief = {
      schemaVersion: 1,
      sharedContext,
      teachingPlan,
      explanation: '蓝图已经选择独立案例。',
      examples: [],
      conditions: [],
      evidence: [],
      assessmentFocus: '说明判断理由。',
    };
    const attemptedPlan = {
      ...teachingPlan,
      visibleContent: ['模型只保留了概念名称'],
      entryPoint: { kind: 'continuation' as const, object: '后面页面才出现的项目式学习', bridge: '假装上一页已经讨论过' },
      taskConnection: {
        mode: 'direct-application' as const,
        rationale: '模型试图把这一页改成最终任务。',
      },
    };
    const brief = normalizeTeachingEnhancement({
      sharedContext,
      pages: [{
        outlineId: 'p1',
        explanation: '来源关系决定证据是否独立。',
        examples: [],
        conditions: [],
        assessmentFocus: '说明来源关系和判断理由。',
        teachingPlan: attemptedPlan,
        evidenceQuotes: [],
      }],
    }, [adoptedPage]).get('p1')!;

    expect(brief.teachingPlan?.taskConnection).toEqual(teachingPlan.taskConnection);
    expect(brief.teachingPlan?.entryPoint).toEqual(teachingPlan.entryPoint);
    expect(brief.teachingPlan?.visibleContent).toEqual([
      ...teachingPlan.visibleContent,
      '模型只保留了概念名称',
    ]);
  });
  it('includes learner readiness and adjacent-page responsibilities in the authoring prompt', async () => {
    const { deriveTeachingConstraints } = await import('@openmaic/lib/pedagogy/teaching-constraints');
    const prompt = buildTeachingEnhancementPrompt({ requirement: '完成来源核验', pages: [page('p1', 0)],
      courseProgression: [page('p1', 0), page('p2', 1)],
      teachingConstraints: deriveTeachingConstraints({ grade: '八年级', learnerProfile: {
        priorKnowledge: '会比较网页来源', learningNeeds: '需要区分转载和独立证据', familiarContexts: '校史调查',
      } }),
    });
    expect(prompt.user).toContain('会比较网页来源');
    expect(prompt.user).toContain('需要区分转载和独立证据');
    expect(prompt.user).toContain('校史调查');
    expect(prompt.user).toContain('p2');
    expect(prompt.user).toContain('"resourcePosition":"course-opening"');
    expect(prompt.user).toContain('不同知识适合不同例子时可以自然更换');
    expect(prompt.user).toContain('entryPoint、introduces、deepens、references 和 visualRelationship');
    expect(prompt.user).toContain('整节没有展示形式配额');
    expect(prompt.user).toContain('"preferredForm":"text|table|chart|diagram|illustration|mixed"');
    expect(prompt.user).toContain('不要求连接项目任务或后续活动');
    expect(prompt.user).toContain('teachingPlan.taskConnection 是硬边界');
    expect(prompt.system).toContain('严格继承 teachingPlan.taskConnection');
    expect(prompt.system).toContain('不得因为资料的 taskAssociation 提到成果制作');
    expect(prompt.system).toContain('实际学习者由学段、专业和 learner profile 决定');
    expect(prompt.system).toContain('不表示重新执行整堂课的教师导入');
    expect(prompt.system).toContain('不重做前一阶段的图片观察、课堂对比或提问');
    expect(prompt.system).toContain('后页才出现的术语、案例或问题必须在其所属页面作为新内容引入');
    expect(prompt.system).toContain('测验后的反馈完成收束');
    expect(prompt.system).toContain('普通 slide 页用于讲解与示范，无法接收学生答案');
    expect(prompt.user).toContain('slide 页不生成 pageTask');
    expect(prompt.user).toContain('需要按共同维度逐项查读的差异可优先 table');
    expect(prompt.system).toContain('同一案例明确分成两个输出通道');
    expect(prompt.user).toContain('examples、explanation、visibleContent 和 narrationFocus 直接写实际课堂内容');
    expect(prompt.user).toContain('不得出现“教材原例”“教学改编”“AI 补充”');
    expect(prompt.user).toContain('每页新增认识是否有充分解释支撑');
    expect(prompt.user).toContain('presentationContent');
    expect(prompt.user).toContain('讲稿直接依据原始资料展开');
    expect(prompt.user).toContain('不照读整段教材');
    expect(prompt.system).toContain('概念与区别可从熟悉对象');
    expect(prompt.system).not.toContain('相对稳定');
    expect(prompt.system).not.toContain('具体化');
    expect(prompt.system).toContain('Write for hearing once');
  });

  it('fills only a missing page while preserving the section case and completed sibling design', async () => {
    const completed = page('p1', 0);
    completed.teachingBrief = {
      schemaVersion: 1, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
      explanation: '第一页已经完整解释为什么网页数量不能代表独立证据数量。', examples: ['完整案例'],
      conditions: ['同源转载不独立'], evidence: [], assessmentFocus: '说明来源关系',
    };
    const missing = page('p2', 1);
    const existingTask = { learnerAction: '只改变提问方式后判断主要变化', newContribution: '辨析条件变化',
      reasoningFocus: '判断表述主要承担的功能', caseUse: 'variant' as const,
      changedConditions: ['把对比表换成口头提问'], preservedConditions: ['课堂流程和学习目标不变'] };
    missing.teachingBrief = {
      schemaVersion: 1, designVersion: 'outdated', sharedContext, pageTask: existingTask,
      explanation: '蓝图中的第二页解释', examples: ['蓝图中的完整变式'], conditions: [], evidence: [], assessmentFocus: '说明理由',
    };
    const ai = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({
      sharedContext: { ...sharedContext, fixedWording: ['模型擅自改写'] },
      pages: [{ outlineId: 'p2', pageTask: { ...existingTask, changedConditions: ['模型擅自改变另一条件'] },
        explanation: '展开第二页的新判断', examples: ['保留原安排，只改变提问方式'], conditions: [],
        assessmentFocus: '说明变化主要发生在哪一层', teachingPlan, evidenceQuotes: [] }],
    }));
    const result = await enhanceTeachingBriefs({
      outlines: [completed, missing], requirement: '完成同一案例的条件辨析',
      courseProgression: [completed, missing], aiCall: ai,
    });
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]?.[1]).toContain('第一页已经完整解释为什么网页数量不能代表独立证据数量');
    expect(ai.mock.calls[0]?.[1]).toContain('蓝图中的完整变式');
    expect(result[0]?.teachingBrief).toEqual(completed.teachingBrief);
    expect(result[1]?.teachingBrief?.sharedContext).toEqual(sharedContext);
    expect(result[1]?.teachingBrief?.pageTask).toBeUndefined();
  });

  it('prepares only the requested legacy display projection without replacing confirmed teaching facts', async () => {
    const sourceDefinition = '只有来源彼此独立且直接涉及待查说法，多份记录才可构成交叉核验的依据。';
    const brief = { schemaVersion: 1 as const, designVersion: TEACHING_ENHANCEMENT_VERSION,
      sharedContext, teachingPlan: { ...teachingPlan, visibleContent: [sourceDefinition] },
      explanation: sourceDefinition, examples: ['原先采用的完整案例'], conditions: ['直接涉及同一说法'],
      evidence: [{ sourceId: 'book', quote: sourceDefinition }], assessmentFocus: '判断来源独立性与相关性' };
    const completed = { ...page('p1', 0), keyPoints: [sourceDefinition], teachingBrief: brief };
    const unstarted = { ...page('p2', 1), keyPoints: [sourceDefinition], teachingBrief: brief };
    const presentationContent = ['独立且相关的记录支持交叉核验'];
    const aiCall = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ sharedContext,
      pages: [{ outlineId: 'p2', explanation: '新草稿试图改写已确认解释', examples: ['另一个例子'],
        conditions: [], assessmentFocus: '降低后的标准', evidenceQuotes: [],
        teachingPlan: { ...teachingPlan, presentationContent } }] }));
    const checkpoints: Array<Array<[string, unknown]>> = [];
    const result = await enhanceTeachingBriefs({ outlines: [completed, unstarted],
      presentationOutlineIds: ['p2'], requirement: '准确讲清核验', sourceContext: sourceDefinition, aiCall,
      onSectionCompleted: (_section, _input, _model, entries) => { checkpoints.push(entries); } });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(aiCall.mock.calls[0]?.[0]).toContain('本次只提炼实际展示的核心要点');
    expect(aiCall.mock.calls[0]?.[0]).toContain('不要再把这些详细内容复制到 PPT');
    expect(JSON.parse(aiCall.mock.calls[0]![1]).requiredOutputShape.pages[0])
      .toEqual({ outlineId: 'p2', presentationContent: ['准确且可独立理解的核心短句'] });
    expect(result[0]).toEqual(completed);
    expect(result[1]?.keyPoints).toEqual(presentationContent);
    expect(result[1]?.teachingBrief).toEqual({ ...brief,
      teachingPlan: { ...brief.teachingPlan, presentationContent } });
    expect(checkpoints[0]?.[0]?.[1]).toEqual(result[1]?.teachingBrief);
    const restoredCall = vi.fn<AICallFn>();
    const restored = await enhanceTeachingBriefs({ outlines: [completed, unstarted],
      presentationOutlineIds: ['p2'], requirement: '准确讲清核验', sourceContext: sourceDefinition,
      aiCall: restoredCall, loadSectionCheckpoint: () => checkpoints[0]! });
    expect(restoredCall).not.toHaveBeenCalled();
    expect(restored).toEqual(result);
  });

  it('accepts a display-only response while keeping the complete original teaching design', async () => {
    const adopted = { ...page('p1', 0), teachingBrief: {
      schemaVersion: 1 as const, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
      explanation: '必须说明同源转载无法独立证实主张。', examples: ['两个网站转载同一条校史记录'],
      conditions: ['记录需直接涉及同一说法'], evidence: [], assessmentFocus: '解释来源关系',
    } };
    const presentationContent = ['同源转载不能相互证实'];
    const aiCall = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({
      pages: [{ outlineId: 'p1', presentationContent }],
    }));
    const result = await enhanceTeachingBriefs({ outlines: [adopted], presentationOutlineIds: ['p1'],
      requirement: '来源核验', aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(result[0]?.teachingBrief).toEqual({ ...adopted.teachingBrief,
      teachingPlan: { ...teachingPlan, presentationContent } });
  });

  it('uses the first wrapped display projection without asking for a replacement draft', async () => {
    const adopted = { ...page('p1', 0), teachingBrief: {
      schemaVersion: 1 as const, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
      explanation: '多份独立且相关的记录支持交叉核验。', examples: ['已确认的校史对照案例'],
      conditions: ['记录必须直接涉及主张'], evidence: [], assessmentFocus: '判断记录关系',
    } };
    const presentationContent = ['独立且相关的记录支持交叉核验', '同源转载无法构成独立证据'];
    const aiCall = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({ output: {
      pages: [{ outlineId: 'p1', presentationContent }],
    } }));
    const result = await enhanceTeachingBriefs({ outlines: [adopted], presentationOutlineIds: ['p1'],
      requirement: '保持核验含义', aiCall });
    expect(aiCall).toHaveBeenCalledOnce();
    expect(result[0]?.teachingBrief).toEqual({ ...adopted.teachingBrief,
      teachingPlan: { ...teachingPlan, presentationContent } });
  });

  it('records an unusable foreign display projection and preserves the confirmed page', async () => {
    const adopted = { ...page('p1', 0), teachingBrief: {
      schemaVersion: 1 as const, designVersion: TEACHING_ENHANCEMENT_VERSION, sharedContext, teachingPlan,
      explanation: '已有说明', examples: [], conditions: [], evidence: [], assessmentFocus: '判断记录关系',
    } };
    const aiCall = vi.fn<AICallFn>().mockResolvedValue(JSON.stringify({
      pages: [{ outlineId: 'another-real-page', presentationContent: ['别页的概念'] }],
    }));
    const warnings: string[] = [];
    const result = await enhanceTeachingBriefs({ outlines: [adopted], presentationOutlineIds: ['p1'],
      requirement: '保持页面归属', aiCall, retrySleep: async () => undefined,
      onWarning: (warning) => { warnings.push(warning); } });
    expect(result[0]?.teachingBrief).toEqual(adopted.teachingBrief);
    expect(warnings).toEqual([expect.stringContaining('presentationContent')]);
    expect(aiCall).toHaveBeenCalledOnce();
  });

  it('retains authored teaching text without requiring complete enhancement metadata', () => {
    const diagnostics: string[] = [];
    const normalized = normalizeTeachingEnhancement({ pages: [{ outlineId: 'p1',
      explanation: '身体参与学习活动，能够提供认知所需的经验。' }] }, [page('p1', 0)], '',
    { onDiagnostic: (message) => { diagnostics.push(message); } });
    expect(normalized.get('p1')?.explanation).toBe('身体参与学习活动，能够提供认知所需的经验。');
    expect(normalized.get('p1')?.teachingPlan).toBeUndefined();
    expect(normalized.get('p1')?.sharedContext).toBeUndefined();
    expect(diagnostics).toHaveLength(2);
  });

  it('adds supported missing case facts while preserving adopted wording and terms', () => {
    const adopted = {
      ...sharedContext,
      caseId: '',
      caseFacts: [],
    };
    const generated = {
      ...sharedContext,
      caseId: 'school-history-check',
      caseFacts: ['目标：判断校史年份是否有独立来源支持', '行为：先标出年份主张，再核对校志', '预期结果：能识别同源转载'],
      fixedWording: ['模型不应替换这句话'],
      stableTerms: ['模型新造术语'],
    };
    const brief = normalizeTeachingEnhancement({
      sharedContext: generated,
      pages: [{
        outlineId: 'p1', explanation: '来源关系决定证据是否独立。', examples: [], conditions: [],
        assessmentFocus: '说明来源关系和判断理由。', teachingPlan, evidenceQuotes: [],
      }],
    }, [page('p1', 0)], '', { sharedContext: adopted }).get('p1')!;

    expect(brief.sharedContext).toMatchObject({
      caseId: 'school-history-check',
      caseFacts: generated.caseFacts,
      fixedWording: sharedContext.fixedWording,
      stableTerms: sharedContext.stableTerms,
    });
  });
});
