import { describe, expect, it, vi } from 'vitest';
import { buildAuthoringExcerptCatalog, type AuthoringLearningTask, type KnowledgeAuthoring } from './knowledge-authoring';
import { normalizeTeachingClaimRefs, normalizeTeachingExamplePlans, normalizeTeachingQuoteDuties,
  normalizeUnderstandingBasis, redistributePageAuthoring, teachingExampleDiagnostics,
  teachingQuoteDutyKey, pageAuthoringContext } from './teaching-example-authoring';
import { buildTeachingBlueprintPrompt, generateTeachingBlueprint, revalidateStoredTeachingBlueprint, teachingBlueprintToOutlines,
  teachingBlueprintContentFingerprint, teachingBlueprintInputFingerprint, previousTeachingBlueprintInputFingerprints,
  validateTeachingBlueprintDraft, type TeachingBlueprintInput } from './teaching-blueprint';
import type { TeachingBrief } from '@/lib/course-quality-review/types';
import type { TeachingExplanationNode } from '@/lib/session/types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import { fingerprintGenerationValue, fingerprintSceneOutline, restoreSceneStageCheckpoint, SCENE_STAGE_CHECKPOINT_VERSION } from '@/lib/course-generation/page-checkpoints';

const definition = '同化是将新信息纳入已有认知结构的过程。';
const facts = ['小鱼按照鱼的形态想象牛。', '孩子用熟悉的游戏规则解释新游戏。'];
function authoring(secondBook = false): KnowledgeAuthoring {
  return { claims: [{ id: 'definition', kind: 'textbook', text: definition,
    sources: [{ evidenceItemId: 'e', sourceBlockIds: ['b'], quote: definition, textbookId: 'book', revisionId: 'rev' }] }],
  examples: facts.map((fact, index) => ({ id: `case-${index}`, kind: 'textbook', title: `例子${index}`,
    facts: [fact], purpose: index ? '说明规则理解' : '说明形象理解', explanation: '旧经验决定对新信息的解释。',
    sources: [{ evidenceItemId: 'e', sourceBlockIds: ['b'], quote: fact,
      textbookId: secondBook && index ? 'other-book' : 'book', revisionId: 'rev' }] })),
  exampleCoverage: [{ textbookId: 'book', revisionId: 'rev', status: 'complete', evidenceItemIds: ['e'] }] };
}
function input(): TeachingBlueprintInput {
  const content = [definition, ...facts].join('\n');
  const evidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'source',
    createdAt: '2026-10-02T00:00:00Z', retrievalMode: 'hybrid', warnings: [], selections: [], mappings: [],
    items: [{ id: 'e', kind: 'source-block', title: '同化', content,
      source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'rev', revisionVersion: 1,
        sectionPath: ['同化'], sourceBlockId: 'b', quote: content },
      completeSourceBlocks: [{ sourceBlockId: 'b', content }] }] };
  return { courseTitle: '认识如何形成', subject: '心理学', grade: '大学', learningObjectives: ['用已有经验解释学习现象'],
    projectContext: '', totalDurationSec: 300, assessmentMode: 'adaptive', generationMode: 'standard',
    contentReviewMode: 'teacher-final', firstAuthoringContract: 'blueprint-v5', sourceContext: content, sourceEvidence: evidence,
    knowledgePoints: [{ id: 'kp', name: '同化', description: definition, evidenceItemIds: ['e'], authoring: authoring() }] };
}
function response(selected = ['case-0', 'case-1']) {
  return { authoringContract: 'blueprint-v5', sections: [{ title: '同化', knowledgePointIds: ['kp'],
    learningObjective: '解释已有经验如何参与认识',
    units: [{ id: 'u', title: '同化', knowledgePointIds: ['kp'], learningOutcome: '分析两个现象',
      evidenceQuotes: [definition], sourceKind: 'course-source',
      examplePlan: [{ knowledgePointId: 'kp', mode: 'textbook', selectedExampleIds: selected, rationale: '两个案例分别说明形象和规则。' }] }],
    pages: [{ id: 'p', title: '同化', type: 'slide', description: '解释已有经验如何影响新认识',
      teachingObjective: '用旧经验解释两个情境', presentationItems: [{ text: '已有经验参与新认识', nodeIds: ['n'], role: 'key-point' }],
      explanationNodes: [{ id: 'n', unitId: 'u', kind: 'concept', knowledgePointIds: ['kp'], prerequisiteNodeIds: [],
        contentParts: [{ id: 'definition', text: definition }], provenance: 'course-source',
        sourceBindings: [{ evidenceItemId: 'e', sourceBlockIds: ['b'], quote: definition }] },
      { id: 'derived', unitId: 'u', kind: 'relation', knowledgePointIds: ['kp'], prerequisiteNodeIds: ['n'],
        contentParts: [{ id: 'reason', text: '同化意味着任何时候都不会改变已有经验。' }], provenance: 'course-source' },
      ...selected.map((id, i) => ({ id, unitId: 'u', kind: 'example', knowledgePointIds: ['kp'], prerequisiteNodeIds: ['n'],
        exampleIds: [id], provenance: 'derived', contentParts: [{ id: 'analysis', text: `${facts[i]}因为用旧经验解释新信息，所以这是同化。` }] }))],
      taskConnection: { mode: 'none', rationale: '无需项目情境' }, caseObservation: { kind: 'none', reason: '口述案例即可' },
      visualRelationship: { kind: 'statement', preferredForm: 'text', description: '经验与新信息的关系', readingOrder: ['已有经验', '新信息'] } }],
    assessmentFocus: ['依据已教条件判断现象'], understandingCriteria: { goals: ['解释同化'], answerEssentials: [definition], misconceptions: [] } }] };
}

const logicalCondition = '已有认知结构参与对新信息的解释';
const caseAssumption = '这里只分析小鱼对牛的想象';
const teachingScope = '本节只分析典型的认识现象';

describe('first-draft fact addresses across page compilation', () => {
  it('retains opening and inference premises without assigning prior cases or quotes another teaching duty', () => {
    const current = { ...authoring(), readingContract: 'source-blocks-v1' as const };
    const earlier = authoring();
    const claimRef = { knowledgePointId: 'earlier', claimId: 'definition' };
    const priorNode: TeachingExplanationNode = { id: 'prior-node', kind: 'example', provenance: 'course-source',
      content: '此前已经分析过的两个教材案例。', prerequisiteNodeIds: [], knowledgePointIds: ['earlier'],
      claimRefs: [claimRef], exampleIds: ['case-0', 'case-1'],
      quoteDuties: [{ source: earlier.claims[0].sources[0], claimRef }] };
    const node: TeachingExplanationNode = { id: 'current-node', kind: 'relation', provenance: 'derived', content: '当前解释的新关系。',
      prerequisiteNodeIds: ['prior-node'], knowledgePointIds: ['current'],
      contentContributions: [{ partId: 'relation', start: 0, end: 9,
        contribution: { kind: 'reasoning', claimRefs: [{ knowledgePointId: 'current', claimId: 'definition' }],
          prerequisiteNodeIds: ['prior-node'] } }] };
    const entry = { claimRefs: [claimRef], exampleRefs: [{ knowledgePointId: 'earlier', exampleId: 'case-1' }],
      prerequisiteNodeIds: ['prior-node'] };
    const projected = pageAuthoringContext([], [node], { current, earlier }, ['current'], undefined, [priorNode], entry)!;
    expect(projected.nodes).toEqual([node]);
    expect(projected.examplePlans).toEqual([]);
    expect(projected.basisNodes).toEqual([{ ...priorNode, quoteDuties: [] }]);
    expect(projected.knowledge.find((item) => item.knowledgePointId === 'earlier')!.authoring.examples
      .map((item) => item.id)).toEqual(['case-0', 'case-1']);
    const brief: TeachingBrief = { schemaVersion: 1, explanation: node.content, examples: [], conditions: [],
      evidence: [], assessmentFocus: '应用已教关系', authoring: projected,
      teachingPlan: { purpose: '理解新关系', priorKnowledge: '', newContent: node.content, learnerQuestion: '',
        reasoningSteps: [], takeaway: '', visibleContent: [], narrationFocus: [],
        entryPoint: { kind: 'continuation', object: '已教情境', bridge: '建立当前关系', basis: entry } } };
    const redistributed = redistributePageAuthoring([brief], new Set([node.id]), ['current'], () => node.content)!;
    expect(redistributed.knowledge).toEqual(projected.knowledge);
    expect(redistributed.basisNodes).toEqual(projected.basisNodes);
    // Saved contracts without the new references keep their previous closure.
    const oldNode = { ...node };
    delete oldNode.contentContributions;
    expect(pageAuthoringContext([], [oldNode], { current: authoring(), earlier }, ['current'], undefined, [priorNode]))
      .not.toHaveProperty('basisNodes');
  });

  it('relocates the addressed text after a split and diagnoses unavailable parts without changing the local body', () => {
    const node: TeachingExplanationNode = { id: 'n', kind: 'relation', provenance: 'derived', content: '第一句。第二句。', prerequisiteNodeIds: [],
      knowledgePointIds: ['kp'], contentContributions: [
        { partId: 'first', start: 0, end: 4, contribution: { kind: 'source-statement', claimRef: { knowledgePointId: 'kp', claimId: 'definition' } } },
        { partId: 'second', start: 4, end: 8, contribution: { kind: 'reasoning', claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }] } },
      ] };
    const brief: TeachingBrief = { schemaVersion: 1, explanation: node.content, examples: [], conditions: [],
      evidence: [], assessmentFocus: '解释关系', authoring: { nodes: [node], examplePlans: [],
        knowledge: [{ knowledgePointId: 'kp', authoring: { ...authoring(), readingContract: 'source-blocks-v1' } }] } };
    const added = redistributePageAuthoring([brief], new Set(['n']), ['kp'], () => `承接。${node.content}`)!;
    expect(added.nodes[0].contentContributions!.map(({ start, end }) => [start, end])).toEqual([[3, 7], [7, 11]]);
    const split = redistributePageAuthoring([brief], new Set(['n']), ['kp'], () => '第二句。')!;
    expect(split.nodes[0].content).toBe('第二句。');
    expect(split.nodes[0].contentContributions).toEqual([{ ...node.contentContributions![1], start: 0, end: 4 }]);
    expect(split.diagnostics).toEqual([expect.stringContaining('片段 first 未完整进入当前拆页正文')]);
    expect(split.knowledge[0].authoring.claims).toEqual(brief.authoring!.knowledge[0].authoring.claims);
  });
});

function basisInput() {
  const result = input();
  const pointAuthoring = result.knowledgePoints[0]!.authoring!;
  const excerptRef = definitionExcerptRef();
  pointAuthoring.claims[0]!.excerptRefs = [excerptRef];
  pointAuthoring.claims[0]!.authoritativeExcerpts = [{ excerptRef, role: 'definition' }];
  pointAuthoring.claims[0]!.logicalConditions = [logicalCondition];
  pointAuthoring.claims[0]!.teachingScope = teachingScope;
  pointAuthoring.claims[0]!.conditions = '旧字段中的教学范围';
  pointAuthoring.claims.push({ id: 'interpretation', kind: 'derived', text: '已有经验影响这次对新信息的解释。',
    sources: pointAuthoring.claims[0]!.sources, basisClaimIds: ['definition'], teachingScope });
  Object.assign(pointAuthoring.examples[0]!, { objectAndTask: '小鱼根据自己的身体形态想象牛。',
    assumptions: [caseAssumption], actions: ['把牛的身体想象成鱼的形态'], outcome: facts[0],
    conceptMapping: '旧的鱼形态经验参与对新对象的理解。', claimIds: ['definition'] });
  return result;
}
function basisResponse() {
  const result = response();
  return { ...result, sections: result.sections.map((section) => ({ ...section,
    pages: section.pages.map((page) => ({ ...page,
      explanationNodes: page.explanationNodes.map((node) => ({ ...node,
        claimRefs: [{ knowledgePointId: 'kp', claimId: node.id === 'derived' ? 'interpretation' : 'definition' }],
        quoteDuties: node.id === 'n' ? [{
          source: { evidenceItemId: 'e', sourceBlockIds: ['b'], quote: definition },
          claimRef: { knowledgePointId: 'kp', claimId: 'definition' },
        }] : [],
      })),
    })),
    understandingCriteria: { ...section.understandingCriteria, basis: [{ id: 'explain', goal: '解释同化',
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], nodeIds: ['n', 'case-0'],
      exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-0' }], requiredConditions: [logicalCondition, caseAssumption] }] },
  })) };
}

function capabilityResponse(raw = basisResponse()) {
  for (const section of raw.sections) {
    const compatibility: Partial<typeof section> = section;
    delete compatibility.learningObjective;
    delete compatibility.assessmentFocus;
    for (const unit of section.units) delete (unit as Partial<typeof unit>).learningOutcome;
    for (const page of section.pages) delete (page as Partial<typeof page>).teachingObjective;
    const criteria: Partial<typeof section.understandingCriteria> = section.understandingCriteria;
    delete criteria.goals;
    delete criteria.answerEssentials;
    delete criteria.misconceptions;
  }
  return raw;
}

function definitionExcerptRef() {
  const catalog = buildAuthoringExcerptCatalog(input().sourceEvidence);
  const block = catalog.sourceBlocks.find((item) => item.sourceBlockId === 'b')!;
  return { evidenceItemId: 'e', sourceBlockId: 'b', excerptId: block.excerpts.find((item) => item.text === definition)!.excerptId };
}

function referenceResponse(raw = basisResponse()) {
  const legacy = capabilityResponse(structuredClone(raw));
  return { ...legacy, sections: legacy.sections.map((section) => ({ ...section,
    pages: section.pages.map((page) => ({ ...page, explanationNodes: page.explanationNodes.map((node) => {
      const body = { ...node, quoteDuties: undefined };
      return { ...body, quoteRefs: node.id === 'n' ? [{ knowledgePointId: 'kp', claimId: 'definition',
        excerptRef: definitionExcerptRef() }] : [] };
    }) })),
    understandingCriteria: { basis: section.understandingCriteria.basis.map((item) => {
      return { id: item.id, claimRefs: item.claimRefs, nodeIds: item.nodeIds,
        exampleRefs: item.exampleRefs, requiredConditions: item.requiredConditions,
        ...('answerRelation' in item ? { answerRelation: item.answerRelation } : {}),
        operation: (item as typeof item & { operation?: AuthoringLearningTask['operation'] }).operation ?? 'explain' as const };
    }) },
  })) };
}

describe('first-pass explanation and example ownership', () => {
  it('keeps both cases from one textbook through the actual page and quiz compilation in one model call', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response()));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    const slide = outlines.find((outline) => outline.type === 'slide')!;
    expect(slide.teachingBrief?.authoring?.examplePlans[0]?.selectedExampleIds).toEqual(['case-0', 'case-1']);
    expect(slide.teachingBrief?.authoring?.nodes.flatMap((node) => node.exampleIds ?? [])).toEqual(['case-0', 'case-1']);
    expect(slide.teachingBrief?.explanation).toContain(facts[0]);
    expect(slide.teachingBrief?.explanation).toContain(facts[1]);
    expect(outlines.find((outline) => outline.type === 'quiz')!.teachingBrief?.authoring?.knowledge).toHaveLength(1);
    const nodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(nodes[0]!.provenance).toBe('course-source');
    expect(nodes[1]!.provenance).toBe('derived');
    expect(nodes[1]!.sourceBindings).toBeUndefined();
  });

  it('diagnoses an omitted single-book case without requesting a semantic repair or claiming it was taught', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response(['case-0'])));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(blueprint.qualityDiagnostics?.join('\n')).toContain('未保留单本教材案例 case-1');
    expect(teachingBlueprintToOutlines(blueprint, '中文')[0]!.teachingBrief!.explanation).not.toContain(facts[1]);
    expect(blueprint.budget.totalDurationSec).toBe(300);
  });

  it('allows selection between books and distinguishes everyday, domain, analogy and no-case decisions', async () => {
    const blueprint = await generateTeachingBlueprint(input(), vi.fn().mockResolvedValue(JSON.stringify(response(['case-0']))));
    expect(teachingExampleDiagnostics(blueprint.sections, { kp: authoring(true) })).toEqual([]);
    for (const form of ['everyday', 'domain', 'analogy'] as const) {
      expect(normalizeTeachingExamplePlans([{ knowledgePointId: 'kp', mode: 'constructed', form,
        selectedExampleIds: [], rationale: '降低理解背景负担' }], ['kp'], { kp: authoring() })[0]?.form).toBe(form);
    }
    const empty = { ...authoring(), examples: [] };
    expect(normalizeTeachingExamplePlans([{ knowledgePointId: 'kp', mode: 'none', rationale: '术语已经熟悉',
      selectedExampleIds: [] }], ['kp'], { kp: empty })[0]?.mode).toBe('none');
    empty.exampleCoverage[0]!.status = 'partial';
    blueprint.sections[0]!.units[0]!.examplePlan![0]!.mode = 'none';
    expect(teachingExampleDiagnostics(blueprint.sections, { kp: empty }).join('\n')).toContain('不能认定教材没有案例');
  });

  it('moves case identities with measured page nodes and preserves legacy absence', async () => {
    const blueprint = await generateTeachingBlueprint(input(), vi.fn().mockResolvedValue(JSON.stringify(response())));
    const brief = teachingBlueprintToOutlines(blueprint, '中文')[0]!.teachingBrief as TeachingBrief;
    const moved = redistributePageAuthoring([brief], new Set([brief.authoring!.nodes.at(-1)!.id]), ['kp'], () => '本页继续分析规则案例。');
    expect(moved?.nodes).toHaveLength(1);
    expect(moved?.nodes[0]?.exampleIds).toEqual(['case-1']);
    expect(moved?.nodes[0]?.content).toBe('本页继续分析规则案例。');
    expect(moved?.knowledge[0]?.authoring.examples).toHaveLength(2);
    expect(redistributePageAuthoring([{ ...brief, authoring: undefined }], new Set(), [], () => '')).toBeUndefined();
  });

  it('does not count a same-named case owned by another knowledge point as taught', async () => {
    const blueprint = await generateTeachingBlueprint(input(), vi.fn().mockResolvedValue(JSON.stringify(response(['case-0']))));
    const unit = blueprint.sections[0]!.units[0]!;
    unit.knowledgePointIds.push('other');
    unit.examplePlan!.push({ knowledgePointId: 'other', mode: 'textbook', selectedExampleIds: ['case-0'], rationale: '讲解另一概念' });
    unit.explanationNodes!.find((node) => node.kind === 'example')!.knowledgePointIds = ['other'];
    const singleCase = { ...authoring(), examples: authoring().examples.slice(0, 1) };
    const diagnostics = teachingExampleDiagnostics(blueprint.sections, { kp: singleCase, other: singleCase });
    expect(diagnostics).toContain('知识点 kp 的案例 case-0 未进入实际讲授节点');
    expect(diagnostics).not.toContain('知识点 other 的案例 case-0 未进入实际讲授节点');
  });

  it('keeps adopted case sources on resume and invalidates a checkpoint when its adopted facts change', async () => {
    const blueprint = await generateTeachingBlueprint(input(), vi.fn().mockResolvedValue(JSON.stringify(response())));
    const outline = teachingBlueprintToOutlines(blueprint, '中文')[0]!;
    const checkpoint = JSON.parse(JSON.stringify({ schemaVersion: SCENE_STAGE_CHECKPOINT_VERSION,
      pageKey: outline.id, stage: 'narration', modelFingerprint: 'model', outlineFingerprint: fingerprintSceneOutline(outline),
      payload: { authoring: outline.teachingBrief!.authoring } }));
    const restore = (current = outline) => restoreSceneStageCheckpoint({ outline: current, checkpoint,
      stage: 'narration', modelFingerprint: 'model' });
    expect(restore()).toEqual({ authoring: outline.teachingBrief!.authoring });
    const changed = structuredClone(outline);
    changed.teachingBrief!.authoring!.knowledge[0]!.authoring.examples[0]!.facts = ['已变更的案例事实'];
    expect(restore(changed)).toBeNull();
  });

  it('binds capability goals to actually taught claims, conditions and cases during the same first model call', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify(referenceResponse()));
    const blueprint = await generateTeachingBlueprint(basisInput(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const nodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(nodes[0]!.claimRefs).toEqual([{ knowledgePointId: 'kp', claimId: 'definition' }]);
    expect(nodes[0]!.quoteDuties).toEqual([{ source: { evidenceItemId: 'e', sourceBlockIds: ['b'], quote: definition,
      textbookId: 'book', revisionId: 'rev' }, claimRef: { knowledgePointId: 'kp', claimId: 'definition' } }]);
    expect(nodes[1]!.quoteDuties).toEqual([]);
    expect(nodes[1]!.provenance).toBe('derived');
    const basis = blueprint.sections[0]!.understandingCriteria!.basis![0]!;
    expect(basis).toEqual({ id: 'explain', goal: '解释同化', operation: 'explain',
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], nodeIds: [nodes[0]!.id, nodes[2]!.id],
      exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-0' }], requiredConditions: [logicalCondition, caseAssumption] });
    const outlines = teachingBlueprintToOutlines(blueprint, '中文');
    expect(outlines.find((outline) => outline.type === 'quiz')!.teachingBrief!.understandingCriteria!.basis).toEqual([basis]);
    expect(outlines[0]!.teachingBrief!.authoring!.knowledge[0]!.authoring.examples[0]!.assumptions).toEqual([caseAssumption]);
  });

  it('binds an operation once and projects each later section only through its actual teaching nodes', async () => {
    const current = basisInput();
    current.knowledgePoints = [...current.knowledgePoints, { id: 'later', name: '新关系', description: '旧UI概括',
      authoring: { claims: [], examples: [], exampleCoverage: [] } }];
    const raw = basisResponse();
    const initial = raw.sections[0]!;
    const later = structuredClone(initial);
    later.title = '在新情境中应用';
    later.units[0]!.id = 'later-u';
    later.units[0]!.knowledgePointIds = ['later'];
    later.units[0]!.examplePlan = [{ knowledgePointId: 'later', mode: 'none', selectedExampleIds: [], rationale: '调用先前已分析事实' }];
    later.pages[0]!.id = 'later-p';
    later.pages[0]!.explanationNodes = [{ ...initial.pages[0]!.explanationNodes[0]!, id: 'later-node',
      unitId: 'later-u', kind: 'relation', knowledgePointIds: ['later'], prerequisiteNodeIds: [],
      contentParts: [{ id: 'new-relation', text: '改变任务对象后，重新核对已有经验在这次解释中的作用。' }],
      provenance: 'derived', claimRefs: [], quoteDuties: [] }];
    later.pages[0]!.presentationItems = [{ text: '在新任务条件下核对已有经验的作用', nodeIds: ['later-node'], role: 'key-point' }];
    const goal = '依据给定新任务说明已有经验怎样参与解释';
    later.understandingCriteria.basis = [{ id: 'apply', goal,
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], nodeIds: ['case-0', 'later-node'],
      exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-0' }], requiredConditions: [logicalCondition, caseAssumption] }];
    raw.sections.push(later);
    Object.assign(later.understandingCriteria.basis[0]!, { operation: 'apply' });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(referenceResponse(raw)));
    const blueprint = await generateTeachingBlueprint(current, ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const first = blueprint.sections[0]!, second = blueprint.sections[1]!;
    expect(first.understandingCriteria.goals).toEqual(['解释同化']);
    expect(second.understandingCriteria.goals).toEqual(['应用同化']);
    expect(second.understandingCriteria.goalSource).toBe('references');
    expect(second.learningObjective).toBe('应用同化');
    expect(second.sharedContext.learningPurpose).toBe('应用同化');
    expect(second.assessmentFocus).toEqual(['应用同化']);
    expect(second.units[0]!.learningOutcome).toBe('应用同化');
    expect(second.pages[0]!.teachingObjective).toBe('应用同化');
    expect(second.understandingCriteria.supportingUnitIds).toEqual([second.units[0]!.id]);
    expect(second.understandingCriteria.answerEssentials).toEqual([]);
    expect(second.understandingCriteria.misconceptions).toEqual([]);
    expect(second.knowledgePointIds).toEqual(['later']);
    expect(second.pages[0]!.knowledgePointIds).toEqual(['later']);
    expect(second.units[0]!.explanationNodes).toHaveLength(1);
    const outlines = teachingBlueprintToOutlines(blueprint, '中文').filter((outline) => outline.lectureSectionId === second.id);
    expect(outlines.every((outline) => outline.knowledgePointIds?.join() === 'later')).toBe(true);
    expect(outlines[0]!.teachingBrief!.authoring!.nodes.map((node) => node.content)).toEqual([
      '改变任务对象后，重新核对已有经验在这次解释中的作用。',
    ]);
    expect(outlines[0]!.teachingBrief!.authoring!.basisNodes![0]!.id).toBe(first.units[0]!.explanationNodes![2]!.id);
    expect(blueprint.qualityDiagnostics?.join('\n') ?? '').not.toContain('未绑定本节的能力目标');
  });

  it('uses the bound goal on a fresh call without matching a parallel summary, while old saved raw keeps its own contract', async () => {
    const raw = basisResponse();
    raw.sections[0]!.understandingCriteria.goals = ['用另一句话概括同化'];
    const first = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse(raw))));
    expect(first.sections[0]!.understandingCriteria.goals).toEqual(['解释同化']);
    expect(first.sections[0]!.understandingCriteria.basis).toHaveLength(1);
    const ai = vi.fn();
    const resumed = await generateTeachingBlueprint(basisInput(), ai, {
      repairFrom: { response: JSON.stringify(raw), firstAuthoringContract: 'blueprint-v5', issues: [] },
    });
    expect(ai).not.toHaveBeenCalled();
    expect(resumed.sections[0]!.understandingCriteria.goals).toEqual(['用另一句话概括同化']);
    expect(resumed.sections[0]!.understandingCriteria.basis).toEqual([]);
    expect(resumed.sections[0]!.understandingCriteria).not.toHaveProperty('goalSource');
    expect(resumed.sections[0]!.units[0]!.learningOutcome).toBe(raw.sections[0]!.units[0]!.learningOutcome);
    expect(resumed.qualityDiagnostics!.join('\n')).toContain('未绑定本节的能力目标');
    const modern = capabilityResponse();
    const restored = await generateTeachingBlueprint(basisInput(), ai, { repairFrom: { candidate: modern, issues: [] } });
    expect(restored.sections[0]!.understandingCriteria.goals).toEqual(['解释同化']);
    expect(restored.sections[0]!.understandingCriteria.basis).toHaveLength(1);
    expect(restored.sections[0]!.understandingCriteria.goalSource).toBe('basis');
    expect(ai).not.toHaveBeenCalled();
  });

  it('keeps a single definition part without forcing an extra paraphrase or semantic repair', async () => {
    const current = basisInput();
    current.contentReviewMode = undefined;
    current.knowledgePoints[0]!.authoring!.examples = [];
    const raw = capabilityResponse();
    const section = raw.sections[0]!;
    section.units[0]!.examplePlan = [{ knowledgePointId: 'kp', mode: 'none', selectedExampleIds: [], rationale: '本节只建立概念' }];
    section.pages[0]!.explanationNodes = [section.pages[0]!.explanationNodes[0]!];
    section.understandingCriteria.basis = [{ id: 'identify', goal: '识别已有认知结构在新信息解释中的作用',
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], nodeIds: ['n'], exampleRefs: [], requiredConditions: [logicalCondition] }];
    Object.assign(section.understandingCriteria.basis[0]!, { operation: 'identify' });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(referenceResponse(raw)));
    const blueprint = await generateTeachingBlueprint(current, ai);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(definition);
    expect(blueprint.sections[0]!.units[0]!.explanationNodes).toHaveLength(1);
    expect(blueprint.sections[0]!.units[0]!.explanation).toBe(definition);
    expect(blueprint.qualityDiagnostics?.join('\n') ?? '').not.toContain('只有结论，缺少推理连接');
    expect(blueprint.qualityDiagnostics?.join('\n') ?? '').not.toContain('理解目标、回答要点');
    const completed = revalidateStoredTeachingBlueprint(blueprint, current, { qualityMode: 'diagnostic' });
    expect(completed.blueprint!.sections).toEqual(blueprint.sections);
    expect(completed.blueprint!.sections[0]!.understandingCriteria.goalSource).toBe('references');
    expect(completed.issues.join('\n')).not.toContain('只有结论，缺少推理连接');
    expect(completed.issues.join('\n')).not.toContain('理解目标、回答要点');
    expect(completed.issues.join('\n')).not.toContain('未绑定实际讲授节点的能力目标');
  });

  it('keeps actual body with diagnostics when the modern fresh response omits basis instead of adopting old answer summaries', async () => {
    const ai = vi.fn().mockResolvedValue(JSON.stringify(response()));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    const section = blueprint.sections[0]!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(section.understandingCriteria.goalSource).toBe('references');
    expect(section.understandingCriteria.goals).toEqual([]);
    expect(section.understandingCriteria.answerEssentials).toEqual([]);
    expect(section.understandingCriteria.misconceptions).toEqual([]);
    expect(section.assessmentFocus).toEqual([]);
    expect(section.units[0]!.explanationNodes![0]!.content).toBe(definition);
    expect(section.units[0]!.explanationNodes!.flatMap((node) => node.exampleIds ?? [])).toEqual(['case-0', 'case-1']);
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('首次能力目标缺少 basis 依据记录');
    expect(teachingBlueprintToOutlines(blueprint, '中文').some((outline) => outline.type === 'quiz')).toBe(true);
  });

  it('derives only operation and topic labels and never promotes model-written goal answers or topic suffixes', async () => {
    const current = basisInput();
    current.knowledgePoints[0]!.name = '同化：额外的无来源答案';
    const raw = referenceResponse();
    Object.assign(raw.sections[0]!.understandingCriteria.basis[0]!, {
      goal: '只有采用某种额外安排才可能形成认识。', operation: 'compare',
    });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(current, ai);
    const section = blueprint.sections[0]!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(section.understandingCriteria).toMatchObject({ goalSource: 'references', goals: ['比较同化'],
      basis: [{ id: 'explain', operation: 'compare', goal: '比较同化' }] });
    expect(section.learningObjective).toBe('比较同化');
    expect(section.units[0]!.learningOutcome).toBe('比较同化');
    expect(section.pages[0]!.teachingObjective).toBe('比较同化');
    expect(section.sharedContext.learningPurpose).toBe('比较同化');
    expect(JSON.stringify(section.understandingCriteria)).not.toContain('只有采用某种额外安排');
    expect(JSON.stringify(section.understandingCriteria)).not.toContain('额外的无来源答案');
    expect(section.units[0]!.explanationNodes![0]!.content).toBe(definition);
  });

  it.each([undefined, 'prove'])('keeps the first body and diagnoses an invalid operation %s without recovering an answer goal', async (operation) => {
    const raw = referenceResponse();
    Object.assign(raw.sections[0]!.understandingCriteria.basis[0]!, { operation, goal: '解释同化' });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(basisInput(), ai);
    const section = blueprint.sections[0]!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(section.understandingCriteria.goalSource).toBe('references');
    expect(section.understandingCriteria.basis).toEqual([]);
    expect(section.understandingCriteria.goals).toEqual([]);
    expect(section.units[0]!.explanationNodes![0]!.content).toBe(definition);
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('缺少有效学习动作');
    expect(teachingBlueprintToOutlines(blueprint, '中文').some((outline) => outline.type === 'quiz')).toBe(true);
  });

  it.each([2, 3])('preserves %s distinct capability responsibilities and the existing quiz allocation when topic labels coincide', async (responsibilities) => {
    const current = basisInput();
    current.totalDurationSec = 600;
    const raw = referenceResponse();
    const basis = raw.sections[0]!.understandingCriteria.basis[0]!;
    raw.sections[0]!.understandingCriteria.basis = ['definition', 'first-case', 'second-case'].slice(0, responsibilities).map((id, index) => ({
      ...structuredClone(basis), id,
      nodeIds: [index === 0 ? 'n' : `case-${index - 1}`],
      exampleRefs: index === 0 ? [] : [{ knowledgePointId: 'kp', exampleId: `case-${index - 1}` }],
      requiredConditions: [],
    }));
    const blueprint = await generateTeachingBlueprint(current, vi.fn().mockResolvedValue(JSON.stringify(raw)));
    expect(blueprint.sections[0]!.understandingCriteria.goals).toEqual(['解释同化']);
    expect(blueprint.sections[0]!.understandingCriteria.basis).toHaveLength(responsibilities);
    const quiz = teachingBlueprintToOutlines(blueprint, '中文').find((outline) => outline.type === 'quiz')!;
    expect(quiz.quizConfig!.questionCount).toBe(responsibilities);
    expect(quiz.quizConfig!.questionCountRange).toEqual({ min: 2, max: 4 });
    expect(blueprint.budget.totalDurationSec).toBe(600);
    expect(blueprint.sections[0]!.assessmentDurationSec).toBe(120);
    expect(revalidateStoredTeachingBlueprint(blueprint, current, { qualityMode: 'diagnostic' }).blueprint!.sections).toEqual(blueprint.sections);
  });

  it('allocates the unchanged assessment reserve by two bound responsibilities rather than one coinciding topic label', async () => {
    const current = basisInput();
    current.totalDurationSec = 600;
    const casePoint = { id: 'fish', name: '小鱼的认识', description: '', evidenceItemIds: ['e'],
      authoring: { claims: [{ id: 'fish-fact', kind: 'textbook' as const, text: facts[0]!,
        sources: current.knowledgePoints[0]!.authoring!.examples[0]!.sources }], examples: [], exampleCoverage: [] } };
    current.knowledgePoints = [...current.knowledgePoints, casePoint];
    const raw = referenceResponse();
    const first = raw.sections[0]!;
    const basis = first.understandingCriteria.basis[0]!;
    first.understandingCriteria.basis = [basis, { ...structuredClone(basis), id: 'second-responsibility',
      nodeIds: ['case-1'], exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-1' }], requiredConditions: [] }];
    const second = structuredClone(first);
    second.title = '小鱼的认识';
    second.units[0]!.id = 'fish-unit';
    second.units[0]!.knowledgePointIds = ['fish'];
    second.units[0]!.examplePlan = [{ knowledgePointId: 'fish', mode: 'none', selectedExampleIds: [], rationale: '解释当前已给事实' }];
    second.pages[0]!.id = 'fish-page';
    second.pages[0]!.explanationNodes = [{ ...second.pages[0]!.explanationNodes[0]!, id: 'fish-node', unitId: 'fish-unit',
      knowledgePointIds: ['fish'], claimRefs: [{ knowledgePointId: 'fish', claimId: 'fish-fact' }],
      contentParts: [{ id: 'fact', text: facts[0]! }], quoteRefs: [] }];
    second.pages[0]!.presentationItems = [{ text: '按照鱼的形态想象牛', nodeIds: ['fish-node'], role: 'key-point' }];
    second.understandingCriteria.basis = [{ ...structuredClone(basis), id: 'fish-understanding',
      claimRefs: [{ knowledgePointId: 'fish', claimId: 'fish-fact' }], nodeIds: ['fish-node'], exampleRefs: [], requiredConditions: [] }];
    raw.sections.push(second);
    const blueprint = await generateTeachingBlueprint(current, vi.fn().mockResolvedValue(JSON.stringify(raw)));
    expect(blueprint.sections.map((section) => section.understandingCriteria.basis!.length)).toEqual([2, 1]);
    expect(blueprint.sections.map((section) => section.understandingCriteria.goals.length)).toEqual([1, 1]);
    expect(blueprint.budget.assessmentDurationSec).toBe(120);
    expect(blueprint.sections.map((section) => section.assessmentDurationSec)).toEqual([80, 40]);
    expect(blueprint.budget.totalDurationSec).toBe(600);
  });

  it('chooses only an eligible fragment from a multi-excerpt claim and leaves ordinary support without a reading duty', async () => {
    const current = basisInput();
    const point = current.knowledgePoints[0]!;
    const claim = point.authoring!.claims[0]!;
    const block = buildAuthoringExcerptCatalog(current.sourceEvidence).sourceBlocks[0]!;
    const supportRef = { evidenceItemId: 'e', sourceBlockId: 'b',
      excerptId: block.excerpts.find((item) => item.text === facts[0])!.excerptId };
    claim.text = `${definition}${facts[0]}`;
    claim.excerptRefs!.push(supportRef);
    claim.sources.push({ evidenceItemId: 'e', sourceBlockIds: ['b'], quote: facts[0], textbookId: 'book', revisionId: 'rev' });
    const raw = referenceResponse();
    const node = raw.sections[0]!.pages[0]!.explanationNodes[0]!;
    node.contentParts = [{ id: 'original', text: claim.text }];
    node.quoteRefs.push({ knowledgePointId: 'kp', claimId: 'definition', excerptRef: supportRef });
    raw.sections[0]!.pages[0]!.explanationNodes[1]!.quoteRefs = [{ knowledgePointId: 'kp', claimId: 'definition', excerptRef: definitionExcerptRef() }];
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(current, ai);
    const nodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(nodes[0]!.quoteDuties).toEqual([{ claimRef: { knowledgePointId: 'kp', claimId: 'definition' },
      source: { evidenceItemId: 'e', sourceBlockIds: ['b'], quote: definition, textbookId: 'book', revisionId: 'rev' } }]);
    expect(nodes[0]!.content).toBe(claim.text);
    expect(nodes[1]!.quoteDuties).toEqual([]);
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('未获引用资格或未绑定真实原文');
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('未绑定当前节点实际解释的陈述');
    const restored = revalidateStoredTeachingBlueprint(blueprint, current, { qualityMode: 'diagnostic' });
    expect(restored.blueprint!.sections).toEqual(blueprint.sections);
  });

  it('resumes reference-only raw and completed drafts without new calls while retaining V6 prose-basis contracts', async () => {
    const ai = vi.fn();
    const raw = referenceResponse();
    const modern = await generateTeachingBlueprint(basisInput(), ai, { repairFrom: {
      response: JSON.stringify(raw), firstAuthoringContract: 'blueprint-v5', issues: [],
    } });
    expect(modern.sections[0]!.understandingCriteria).toMatchObject({ goalSource: 'references',
      basis: [{ operation: 'explain', goal: '解释同化' }] });
    expect(modern.sections[0]!.units[0]!.explanationNodes![0]!.quoteDuties).toHaveLength(1);
    expect(revalidateStoredTeachingBlueprint(modern, basisInput(), { qualityMode: 'diagnostic' }).blueprint!.sections).toEqual(modern.sections);
    const old = capabilityResponse();
    old.sections[0]!.understandingCriteria.basis[0]!.goal = '旧首稿中已保存的能力文字';
    const historical = await generateTeachingBlueprint(basisInput(), ai, { repairFrom: { candidate: old, issues: [] } });
    expect(historical.sections[0]!.understandingCriteria.goalSource).toBe('basis');
    expect(historical.sections[0]!.understandingCriteria.goals).toEqual(['旧首稿中已保存的能力文字']);
    expect(historical.sections[0]!.understandingCriteria.basis![0]!).not.toHaveProperty('operation');
    expect(historical.sections[0]!.units[0]!.explanationNodes![0]!.quoteDuties).toHaveLength(1);
    expect(ai).not.toHaveBeenCalled();
  });

  it('retains a usable first draft and diagnostics for a forged quote without inventing a repair', async () => {
    const raw = basisResponse();
    raw.sections[0]!.pages[0]!.explanationNodes[0]!.quoteDuties[0]!.source.quote = '同化意味着任何时候都不会改变已有经验。';
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(basisInput(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const node = blueprint.sections[0]!.units[0]!.explanationNodes![0]!;
    expect(node.content).toBe(definition);
    expect(node.quoteDuties).toEqual([]);
    expect(blueprint.qualityDiagnostics?.join('\n')).toContain('不采用模型自由编写的 quoteDuties');
  });

  it('preserves claim and case conditions when deepening a taught node while ending its original quotation duty', async () => {
    const blueprint = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse())));
    const section = blueprint.sections[0]!;
    const first = section.pages[0]!;
    const node = section.units[0]!.explanationNodes![0]!;
    section.pages.push({ ...structuredClone(first), id: 'continued', title: '同化的判断',
      introducesNodeIds: [], deepensNodeIds: [node.id], referencesNodeIds: [],
      presentationItems: [{ text: '在已有经验中解释新信息', nodeIds: [node.id], role: 'key-point' }] });
    const slides = teachingBlueprintToOutlines(blueprint, '中文').filter((outline) => outline.type === 'slide');
    const initial = slides[0]!.teachingBrief!.authoring!.nodes[0]!;
    const continued = slides[1]!.teachingBrief!.authoring!.nodes[0]!;
    expect(initial.quoteDuties).toHaveLength(1);
    expect(continued.quoteDuties).toEqual([]);
    expect(continued.claimRefs).toEqual(initial.claimRefs);
    expect(continued.content).toBe(initial.content);
    expect(slides[1]!.teachingBrief!.authoring!.knowledge[0]!.authoring.examples[0]!.assumptions).toEqual([caseAssumption]);
  });

  it('assigns each source quotation only to its actual split while carrying the same claim and case catalog', async () => {
    const blueprint = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse())));
    const brief = teachingBlueprintToOutlines(blueprint, '中文')[0]!.teachingBrief!;
    const node = brief.authoring!.nodes[0]!;
    const key = teachingQuoteDutyKey(node.id, node.quoteDuties![0]!);
    const first = redistributePageAuthoring([brief], new Set([node.id]), ['kp'], () => definition,
      { quoteDutyKeys: new Set([key]) });
    const second = redistributePageAuthoring([brief], new Set([node.id]), ['kp'], () => '这里继续判断旧经验的作用。',
      { quoteDutyKeys: new Set() });
    expect(first!.nodes[0]!.quoteDuties).toEqual(node.quoteDuties);
    expect(second!.nodes[0]!.quoteDuties).toEqual([]);
    expect(second!.nodes[0]!.claimRefs).toEqual(node.claimRefs);
    expect(second!.knowledge).toEqual(first!.knowledge);
    expect(second!.knowledge[0]!.authoring.claims[0]!.logicalConditions).toEqual([logicalCondition]);
    expect(second!.knowledge[0]!.authoring.examples[0]!.assumptions).toEqual([caseAssumption]);
  });

});

describe('statement and capability reference normalization', () => {
  it('retains a real cross-paragraph quotation when retrieval returned its complete blocks out of order', () => {
    const evidence = structuredClone(input().sourceEvidence!);
    const first = '新信息可以纳入已有经验。';
    const second = '这里并不要求经验始终完全不变。';
    const item = evidence.items[0]!;
    const source = { ...item.source, sourceBlockId: 'second', sourceBlockPosition: 2, quote: second };
    item.source = source;
    item.completeSourceBlocks = [{ sourceBlockId: 'second', content: second, source },
    { sourceBlockId: 'first', content: first,
      source: { ...source, sourceBlockId: 'first', sourceBlockPosition: 1, quote: first } }];
    const diagnostics: string[] = [];
    const quote = `${first}\n${second}`;
    const duties = normalizeTeachingQuoteDuties([{ source: { evidenceItemId: 'e', sourceBlockIds: ['second', 'first'], quote } }],
      ['kp'], { kp: authoring() }, evidence, ['e'], (message) => diagnostics.push(message));
    expect(duties).toEqual([{ source: { evidenceItemId: 'e', sourceBlockIds: ['first', 'second'], quote,
      textbookId: 'book', revisionId: 'rev' } }]);
    expect(diagnostics).toEqual([]);
    expect(normalizeTeachingQuoteDuties([{ source: { evidenceItemId: 'e', sourceBlockIds: ['first', 'second'],
      quote: `${first}\n这里要求经验始终完全不变。` } }], ['kp'], { kp: authoring() }, evidence, ['e'],
    (message) => diagnostics.push(message))).toEqual([]);
    expect(diagnostics).toEqual(['首次引句职责未绑定当前知识点的真实原文片段']);
  });

  it('carries prior basis claim/example dependencies without adopting them as current teaching', async () => {
    const blueprint = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse())));
    const prior = basisInput().knowledgePoints[0]!.authoring!;
    prior.claims.push({ id: 'unrelated', kind: 'derived', text: '未采用的额外解释', sources: [] });
    prior.examples[0]!.claimIds = ['interpretation'];
    prior.examples[0]!.correspondences = [{ claimId: 'definition', claimPhrase: '已有认知结构',
      caseElement: { field: 'facts', index: 4 } }];
    const currentNodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    const priorNode: TeachingExplanationNode = { ...structuredClone(currentNodes[2]!), id: 'prior-case-node',
      knowledgePointIds: ['prior'], claimRefs: [{ knowledgePointId: 'prior', claimId: 'interpretation' }],
      quoteDuties: [{ source: prior.claims[0]!.sources[0]! }], exampleIds: ['case-0'] };
    const basis = [{ id: 'apply', goal: '解释同化', claimRefs: [{ knowledgePointId: 'prior', claimId: 'interpretation' }],
      exampleRefs: [{ knowledgePointId: 'prior', exampleId: 'case-0' }], nodeIds: [priorNode.id], requiredConditions: [caseAssumption] }];
    const context = pageAuthoringContext(blueprint.sections[0]!.units, currentNodes,
      { kp: blueprint.knowledgeAuthoring!.kp!, prior }, ['kp'], basis, [priorNode])!;
    expect(context.nodes.map((node) => node.id)).toEqual(currentNodes.map((node) => node.id));
    expect(context.examplePlans.every((plan) => plan.knowledgePointId === 'kp')).toBe(true);
    const previous = context.knowledge.find((point) => point.knowledgePointId === 'prior')!.authoring;
    expect(previous.claims.map((claim) => claim.id)).toEqual(['definition', 'interpretation']);
    expect(previous.examples.map((example) => example.id)).toEqual(['case-0']);
    expect(previous.claims[0]!.logicalConditions).toEqual([logicalCondition]);
    expect(previous.examples[0]!.assumptions).toEqual([caseAssumption]);
    expect(previous.examples[0]!.correspondences).toEqual(prior.examples[0]!.correspondences);
    expect(context.basisNodes).toEqual([{ ...priorNode, quoteDuties: [] }]);
    const brief = teachingBlueprintToOutlines(blueprint, '中文')[0]!.teachingBrief!;
    const moved = redistributePageAuthoring([{ ...brief, authoring: context,
      understandingCriteria: { ...brief.understandingCriteria!, basis } }], new Set([currentNodes[0]!.id]), ['kp'], () => definition);
    expect(moved!.nodes).toHaveLength(1);
    expect(moved!.knowledge.find((point) => point.knowledgePointId === 'prior')!.authoring).toEqual(previous);
    expect(moved!.basisNodes).toEqual(context.basisNodes);
    expect(moved!.examplePlans.every((plan) => plan.knowledgePointId === 'kp')).toBe(true);
  });

  it('retains a prior actual analysis as reference evidence even when it has no original claim', () => {
    const priorNode: TeachingExplanationNode = { id: 'prior-analysis', kind: 'relation', content: '这次依据具体任务判断。',
      knowledgePointIds: ['prior'], prerequisiteNodeIds: [], provenance: 'derived', claimRefs: [], quoteDuties: [] };
    const basis = [{ id: 'apply', goal: '判断新任务', claimRefs: [], nodeIds: [priorNode.id] }];
    const context = pageAuthoringContext([], [], undefined, ['current'], basis, [priorNode])!;
    expect(context.nodes).toEqual([]);
    expect(context.examplePlans).toEqual([]);
    expect(context.knowledge).toEqual([]);
    expect(context.basisNodes).toEqual([priorNode]);
    const normalized = normalizeUnderstandingBasis(basis, { goals: ['判断新任务'], pointIds: ['prior', 'current'],
      knowledge: {}, nodes: [priorNode] });
    expect(normalized[0]!.nodeIds).toEqual([priorNode.id]);
    expect(normalized[0]!.claimRefs).toEqual([]);
  });

  it('keeps a complete current point catalog when another page carries only a prior subset of that same point', async () => {
    const blueprint = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse())));
    const brief = teachingBlueprintToOutlines(blueprint, '中文')[0]!.teachingBrief!;
    const full = brief.authoring!.knowledge[0]!;
    const subset = { ...full, authoring: { ...full.authoring,
      claims: full.authoring.claims.slice(0, 1), examples: full.authoring.examples.slice(0, 1) } };
    const later: TeachingBrief = { ...brief, authoring: { nodes: [], examplePlans: [], knowledge: [subset] } };
    const relation = brief.authoring!.nodes[1]!;
    const moved = redistributePageAuthoring([brief, later], new Set([relation.id]), ['kp'], () => relation.content)!;
    expect(moved.nodes.map((node) => node.id)).toEqual([relation.id]);
    expect(moved.knowledge[0]!.authoring.claims.map((claim) => claim.id)).toEqual(['definition', 'interpretation']);
    expect(moved.knowledge[0]!.authoring.examples.map((example) => example.id)).toEqual(['case-0', 'case-1']);
  });

  it('compiles a later section with its actual prior analysis and source closure while keeping its own page duties', async () => {
    const blueprint = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse())));
    const first = blueprint.sections[0]!;
    const later = structuredClone(first);
    later.id = 'later-section';
    later.title = '新情境分析';
    later.knowledgePointIds = ['later'];
    later.units[0]!.id = 'later-unit';
    later.units[0]!.knowledgePointIds = ['later'];
    later.units[0]!.examplePlan = [{ knowledgePointId: 'later', mode: 'none', selectedExampleIds: [], rationale: '这里只解释新关系' }];
    const priorNode = first.units[0]!.explanationNodes![2]!;
    const node: TeachingExplanationNode = { id: 'later-node', kind: 'relation', content: '根据具体任务条件解释新的关系。',
      knowledgePointIds: ['later'], prerequisiteNodeIds: [priorNode.id], provenance: 'derived', claimRefs: [], quoteDuties: [] };
    later.units[0]!.explanationNodes = [node];
    later.pages = [{ ...structuredClone(first.pages[0]!), id: 'later-page', unitIds: ['later-unit'], knowledgePointIds: ['later'],
      introducesNodeIds: [node.id], deepensNodeIds: [], referencesNodeIds: [priorNode.id],
      presentationItems: [{ text: '具体任务中的关系', nodeIds: [node.id], role: 'key-point' }] }];
    later.understandingCriteria!.basis = [{ id: 'apply', goal: '解释同化',
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], nodeIds: [priorNode.id, node.id],
      exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-0' }], requiredConditions: [logicalCondition, caseAssumption] }];
    blueprint.sections.push(later);
    blueprint.knowledgeAuthoring!.later = { claims: [], examples: [], exampleCoverage: [] };
    const laterOutlines = teachingBlueprintToOutlines(blueprint, '中文').filter((outline) => outline.lectureSectionId === later.id);
    for (const outline of laterOutlines) {
      expect(outline.knowledgePointIds).toEqual(['later']);
      expect(outline.teachingBrief!.authoring!.nodes.map((item) => item.id)).toEqual([node.id]);
      expect(outline.teachingBrief!.authoring!.basisNodes).toEqual([{ ...priorNode, quoteDuties: [] }]);
      const evidence = outline.teachingBrief!.authoring!.knowledge.find((point) => point.knowledgePointId === 'kp')!.authoring;
      expect(evidence.claims.map((claim) => claim.id)).toEqual(['definition']);
      expect(evidence.examples.map((example) => example.id)).toEqual(['case-0']);
      expect(outline.teachingBrief!.authoring!.examplePlans.map((plan) => plan.knowledgePointId)).toEqual(['later']);
    }
  });

  it('supplies canonical textbook facts separately from capability scope and omits modern generated prose summaries', () => {
    const current = basisInput();
    current.knowledgePoints[0]!.description = 'UNRELIABLE_DESCRIPTION_CANNOT_BECOME_A_DEFINITION';
    current.knowledgePoints[0]!.keyInfo = 'UNRELIABLE_KEYINFO_CANNOT_BECOME_A_CONDITION';
    current.knowledgePoints[0]!.masteryBoundary = '能够判断已有经验怎样参与认识';
    current.knowledgePoints[0]!.authoring!.learningTasks = [{ claimIds: ['definition'], operation: 'explain' }];
    const originalAuthoring = structuredClone(current.knowledgePoints[0]!.authoring!);
    const prompt = buildTeachingBlueprintPrompt(current);
    expect(prompt.user).not.toContain(current.knowledgePoints[0]!.description);
    expect(prompt.user).not.toContain(current.knowledgePoints[0]!.keyInfo);
    expect(prompt.user).toContain('"teachingResponsibilities"');
    expect(prompt.user).not.toContain('能够判断已有经验怎样参与认识');
    const responsibilities = JSON.parse(prompt.user.split('必须覆盖的知识点：\n')[1]!.split('\n')[0]!);
    expect(responsibilities[0].teachingResponsibilities).not.toHaveProperty('masteryBoundary');
    const factsLine = prompt.user.split('教材原文事实目录（sourceFacts；canonical 原句与事件事实，authoring 的稳定 claim/example ID 不变）：\n')[1]!.split('\n')[0]!;
    const sourceFacts = JSON.parse(factsLine);
    expect(sourceFacts[0].authoring.claims.map((claim: { id: string }) => claim.id)).toEqual(['definition']);
    expect(sourceFacts[0].authoring.claims[0].text).toBe(definition);
    expect(sourceFacts[0].authoring.claims[0].logicalConditions).toEqual([logicalCondition]);
    expect(sourceFacts[0].authoring.claims[0].sources).toEqual(originalAuthoring.claims[0]!.sources);
    expect(sourceFacts[0].authoring.claims[0]).not.toHaveProperty('teachingScope');
    expect(sourceFacts[0].authoring.claims[0]).not.toHaveProperty('conditions');
    expect(sourceFacts[0].authoring.examples[0].facts).toEqual([facts[0]]);
    expect(sourceFacts[0].authoring.examples[0]).not.toHaveProperty('explanation');
    const applicationsLine = prompt.user.split('有条件的解释与案例候选（conditionalApplications；不是教材定义或普遍能力结论，案例选择与事实目录共同使用）：\n')[1]!.split('\n')[0]!;
    const applications = JSON.parse(applicationsLine);
    expect(applications[0].authoring.claims.map((claim: { id: string }) => claim.id)).toEqual(['interpretation']);
    expect(applications[0].authoring.examples[0]).not.toHaveProperty('facts');
    expect(applications[0].authoring.examples[0]).not.toHaveProperty('explanation');
    expect(applications[0].authoring.examples[0]).not.toHaveProperty('conceptMapping');
    expect(applications[0].authoring.claims[0]).not.toHaveProperty('teachingScope');
    expect(applications[0].authoring.examples[0]).not.toHaveProperty('teachingUse');
    const scopeLine = prompt.user.split('内部编写范围与来源覆盖（internalAuthoringScope；只约束取材与组织，不进入学生正文、误区、展示或测验答案）：\n')[1]!.split('\n')[0]!;
    const scope = JSON.parse(scopeLine)[0];
    expect(scope).not.toHaveProperty('masteryBoundary');
    expect(scope.learningTasks).toEqual([{ claimIds: ['definition'], operation: 'explain' }]);
    expect(scope.cases[0]).not.toHaveProperty('teachingUse');
    expect(scope.claims).toContainEqual({ claimId: 'definition', teachingScope,
      legacyScope: '旧字段中的教学范围' });
    expect(current.knowledgePoints[0]!.authoring).toEqual(originalAuthoring);
    expect(prompt.system).toContain('来源没有独立建立‘必须’或‘不能’时，不创造全局能力限制');
    expect(prompt.system).toContain('具体任务、接口、工具和案例假设');
    expect(prompt.system).toContain('首次案例正文具体写出 objectAndTask 与影响结果的 assumptions');
    expect(prompt.system).toContain('条件必须在学生听到的情境中建立，不能只留在 metadata');
    expect(prompt.system).toContain('example 节点的 claimRefs 关联该案例 example.claimIds');
    expect(prompt.system).toContain('quoteRefs 只能从当前已引用 textbook claim.authoritativeExcerpts 选择');
    expect(prompt.system).toContain('普通事实依据没有逐字职责');
    expect(prompt.system).toContain('不把双方的完整定义重新写成本节正文');
    expect(prompt.system).toContain('只调用本次判断所需细节与新增机制，保持原事实、结局和条件');
    expect(prompt.system).toContain('跨节 basisNodes 是准确性依据，不自动成为本页讲授或朗读职责');
    const historical = input();
    historical.knowledgePoints[0]!.authoring = undefined;
    historical.knowledgePoints[0]!.description = '旧课程已有知识描述';
    expect(buildTeachingBlueprintPrompt(historical).user).toContain('旧课程已有知识描述');
  });

  it('preserves bound learning actions and actual case elements while removing legacy answer prose from modern input', () => {
    const current = basisInput();
    const point = current.knowledgePoints[0]!;
    const originalClaim = '在给定约定下，某种表示难以直接解释内部关系。';
    point.authoring!.claims[0]!.text = originalClaim;
    point.authoring!.claims[0]!.sources[0]!.quote = originalClaim;
    const evidence = current.sourceEvidence!.items[0]!;
    evidence.content = originalClaim;
    evidence.source.quote = originalClaim;
    evidence.completeSourceBlocks![0]!.content = originalClaim;
    point.masteryBoundary = 'PLANNED_CAPABILITY_WHY_IMPOSSIBLE';
    point.authoring!.learningTasks = [{ claimIds: ['definition'], operation: 'explain' }];
    point.authoring!.examples = [{ id: 'illustration', kind: 'constructed', title: 'PLANNED_CASE_TITLE_WITH_A_CONCLUSION',
      purpose: 'PLANNED_PURPOSE_GUARANTEES_A_LATER_DECISION', facts: [], explanation: '',
      objectAndTask: '在给定约定下观察一条记录的排列', assumptions: ['本例只比较记录排列'],
      actions: ['改变同一记录的排列'], outcome: '记录以另一种排列呈现',
      correspondences: [{ claimId: 'definition', claimPhrase: '给定约定',
        caseElement: { field: 'assumptions', index: 0 } }], sources: [] }];
    const before = JSON.stringify(current);
    const prompt = buildTeachingBlueprintPrompt(current);
    const factsInput = JSON.parse(prompt.user.split('教材原文事实目录（sourceFacts；canonical 原句与事件事实，authoring 的稳定 claim/example ID 不变）：\n')[1]!.split('\n')[0]!);
    const casesInput = JSON.parse(prompt.user.split('有条件的解释与案例候选（conditionalApplications；不是教材定义或普遍能力结论，案例选择与事实目录共同使用）：\n')[1]!.split('\n')[0]!);
    const scope = JSON.parse(prompt.user.split('内部编写范围与来源覆盖（internalAuthoringScope；只约束取材与组织，不进入学生正文、误区、展示或测验答案）：\n')[1]!.split('\n')[0]!)[0];
    expect(factsInput[0].authoring.claims[0].text).toBe(originalClaim);
    expect(casesInput[0].authoring.examples[0]).toMatchObject({ id: 'illustration',
      assumptions: ['本例只比较记录排列'], actions: ['改变同一记录的排列'], outcome: '记录以另一种排列呈现' });
    for (const marker of [point.masteryBoundary, point.authoring!.examples[0]!.title, point.authoring!.examples[0]!.purpose]) {
      expect(JSON.stringify([factsInput, casesInput])).not.toContain(marker);
      expect(JSON.stringify(scope)).not.toContain(marker);
      expect(prompt.user).not.toContain(marker);
    }
    expect(scope.learningTasks).toEqual([{ claimIds: ['definition'], operation: 'explain' }]);
    expect(prompt.system).toContain('先完成本节实际落页的事实、解释、推理和案例正文');
    expect(prompt.system).toContain('operation 仅选择 identify（识别）、explain（解释）、compare（比较）、apply（应用）');
    expect(prompt.system).toContain('以及教师已确认的目标、深度和教学要求，共同限定能力范围');
    expect(prompt.system).toContain('不把‘难以’或‘不容易’改成‘不能’');
    expect(prompt.system).toContain('不自动成为整个方法类别的普遍能力结论');
    expect(prompt.system).toContain('不据此保证未设定的实际运行效果、预测结果或决策');
    expect(prompt.system).toContain('没有连接判断与后续动作的规则，只解释已建立的部分');
    expect(JSON.stringify(current)).toBe(before);
  });

  it('supplies concrete case elements and phrase correspondences without parallel constructed conclusions or graph reasons', () => {
    const current = basisInput();
    const point = current.knowledgePoints[0]!;
    const example = { ...point.authoring!.examples[0]!, id: 'constructed', kind: 'constructed' as const, facts: [],
      objectAndTask: '学生尝试依据已知规则解释一个新对象', assumptions: ['已经知道旧规则'],
      actions: ['将旧规则应用于新对象'], outcome: '按旧规则作出解释', claimIds: ['definition'],
      correspondences: [{ claimId: 'definition', claimPhrase: '已有认知结构',
        caseElement: { field: 'actions' as const, index: 0 } }],
      explanation: 'PARALLEL_UNSUPPORTED_CONCLUSION', conceptMapping: 'PARALLEL_UNSUPPORTED_MAPPING',
      limitations: '内部范围：不扩展到所有情形' };
    point.authoring!.examples.push(example);
    current.knowledgeGraph = { nodes: [{ id: 'kp', label: 'PARALLEL_GRAPH_LABEL', description: 'PARALLEL_GRAPH_DESCRIPTION',
      position: { x: 0, y: 0 },
      instructionalRole: 'lesson' }], edges: [{ id: 'edge', source: 'prior', target: 'kp', label: 'PARALLEL_EDGE_LABEL',
      type: 'supports', strength: 'helpful', rationale: 'PARALLEL_GRAPH_CAUSAL_CONCLUSION' }] };
    const prompt = buildTeachingBlueprintPrompt(current);
    for (const excluded of [example.explanation, example.conceptMapping, 'PARALLEL_GRAPH_LABEL',
      'PARALLEL_GRAPH_DESCRIPTION', 'PARALLEL_EDGE_LABEL', 'PARALLEL_GRAPH_CAUSAL_CONCLUSION']) expect(prompt.user).not.toContain(excluded);
    const rows = JSON.parse(prompt.user.split('有条件的解释与案例候选（conditionalApplications；不是教材定义或普遍能力结论，案例选择与事实目录共同使用）：\n')[1]!.split('\n')[0]!);
    const adoptedCandidate = rows[0].authoring.examples.find((item: { id: string }) => item.id === example.id);
    expect(adoptedCandidate).toMatchObject({ id: example.id, kind: 'constructed', facts: [],
      objectAndTask: example.objectAndTask, assumptions: example.assumptions, actions: example.actions,
      outcome: example.outcome, claimIds: example.claimIds, correspondences: example.correspondences });
    expect(adoptedCandidate).not.toHaveProperty('limitations');
    const graph = JSON.parse(prompt.user.split('已确认教学先备与编排（只决定分组、顺序和前提安排，不证明概念因果或必要条件）：\n')[1]!.split('\n')[0]!);
    expect(graph.edges).toEqual([{ source: 'prior', target: 'kp', type: 'supports', strength: 'helpful' }]);
    expect(graph.nodes[0].instructionalRole).toBe('lesson');
    expect(current.knowledgeGraph.edges[0]!.rationale).toBe('PARALLEL_GRAPH_CAUSAL_CONCLUSION');
    expect(point.authoring!.examples.at(-1)).toEqual(example);
  });

  it('binds prior cases through correspondences even when legacy claimIds is absent', () => {
    const previous = authoring();
    previous.examples[0]!.claimIds = undefined;
    previous.examples[0]!.correspondences = [{ claimId: 'definition', claimPhrase: '已有认知结构',
      caseElement: { field: 'facts', index: 0 } }];
    const context = pageAuthoringContext([], [], { prior: previous }, [], [{ id: 'case-basis', goal: '解释现象',
      claimRefs: [], nodeIds: [], exampleRefs: [{ knowledgePointId: 'prior', exampleId: 'case-0' }] }])!;
    expect(context.knowledge[0]!.authoring.claims.map((claim) => claim.id)).toEqual(['definition']);
    expect(context.knowledge[0]!.authoring.examples[0]!.correspondences).toEqual(previous.examples[0]!.correspondences);
    expect(context.nodes).toEqual([]);
    expect(context.examplePlans).toEqual([]);
  });

  it('keeps internal scope out of executed explanations and does not count it as teaching support', async () => {
    const candidate = response([]);
    candidate.sections[0]!.pages[0]!.explanationNodes.splice(1);
    const internalScope = '内部范围：资料未建立另一种方法不能应用';
    Object.assign(candidate.sections[0]!, { sharedContext: { conceptBoundaries: [internalScope] } });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(candidate));
    const blueprint = await generateTeachingBlueprint(input(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const review = validateTeachingBlueprintDraft(candidate, { ...input(), contentReviewMode: undefined },
      { qualityMode: 'diagnostic' });
    expect(review.issues.join('\n')).toContain('只有结论，缺少推理连接、例子分析或概念边界');
    const brief = teachingBlueprintToOutlines(blueprint, '中文')[0]!.teachingBrief!;
    expect(brief.authoring!.nodes.map((node) => node.content)).toEqual([definition]);
    expect(brief.explanation).not.toContain(internalScope);
    expect(brief.authoring!.nodes.some((node) => node.kind === 'misconception')).toBe(false);
    expect(blueprint.sections[0]!.sharedContext.conceptBoundaries).toEqual([internalScope]);
  });

  it('keeps same-named claims scoped to their actual knowledge point and does not authorize a neighbor source', () => {
    const pointAuthoring = basisInput().knowledgePoints[0]!.authoring!;
    const diagnostics: string[] = [];
    const knowledge = { kp: pointAuthoring, other: pointAuthoring };
    expect(normalizeTeachingClaimRefs([{ knowledgePointId: 'other', claimId: 'definition' },
      { knowledgePointId: 'kp', claimId: 'definition' }, { knowledgePointId: 'kp', claimId: 'definition' }],
    ['kp'], knowledge, (message) => diagnostics.push(message))).toEqual([{ knowledgePointId: 'kp', claimId: 'definition' }]);
    expect(normalizeTeachingQuoteDuties([{ source: pointAuthoring.claims[0]!.sources[0] }],
      ['kp'], knowledge, input().sourceEvidence, [], (message) => diagnostics.push(message))).toEqual([]);
    expect(diagnostics.join('\n')).toContain('不属于当前解释范围');
    expect(diagnostics.join('\n')).toContain('未绑定当前知识点的真实原文');
  });

  it('rejects undeveloped claims, foreign cases and teaching-scope conditions while leaving answer summaries inert', () => {
    const knowledge = { kp: basisInput().knowledgePoints[0]!.authoring!, other: authoring() };
    const node: TeachingExplanationNode = { id: 'executed', kind: 'example', content: facts[0]!, provenance: 'derived',
      knowledgePointIds: ['kp'], prerequisiteNodeIds: [], claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }],
      exampleIds: ['case-0'] };
    const diagnostics: string[] = [];
    const basis = normalizeUnderstandingBasis([{ id: 'goal', goal: '解释同化', nodeIds: ['executed', 'future'],
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }, { knowledgePointId: 'kp', claimId: 'interpretation' }],
      exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-0' }, { knowledgePointId: 'other', exampleId: 'case-0' }],
      requiredConditions: [logicalCondition, caseAssumption, teachingScope, '旧字段中的教学范围', '无依据的简短总结'],
    }, { id: 'answer', goal: '同化一定不会改变原有经验', claimRefs: [], nodeIds: ['executed'] }],
    { goals: ['解释同化'], pointIds: ['kp', 'other'], knowledge, nodes: [node], onDiagnostic: (message) => diagnostics.push(message) });
    expect(basis).toEqual([{ id: 'goal', goal: '解释同化', nodeIds: ['executed'],
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'definition' }], exampleRefs: [{ knowledgePointId: 'kp', exampleId: 'case-0' }],
      requiredConditions: [logicalCondition, caseAssumption] }]);
    expect(diagnostics.join('\n')).toContain('尚未实际讲授');
    expect(diagnostics.join('\n')).toContain('未落实到实际解释节点');
    expect(diagnostics.join('\n')).toContain('必要条件未绑定');
    expect(diagnostics.join('\n')).toContain('未绑定本节的能力目标');
  });

  it('records a missing capability basis without fabricating a fact or adding the field to a historical course', () => {
    const diagnostics: string[] = [];
    const options = { goals: ['判断现象'], pointIds: ['kp'], knowledge: { kp: authoring() }, nodes: [],
      onDiagnostic: (message: string) => diagnostics.push(message) };
    expect(normalizeUnderstandingBasis([], options)).toEqual([]);
    expect(diagnostics).toEqual(['理解目标“判断现象”未记录首次讲授的事实与条件依据']);
    diagnostics.length = 0;
    expect(normalizeUnderstandingBasis(undefined, options)).toEqual([]);
    expect(diagnostics).toEqual([]);
  });

  it.each(['source-statement', 'conditional-application', 'comparative-fit', 'insufficient-evidence'] as const)(
    'carries the authored %s relation through page and quiz compilation without another generation call', async (answerRelation) => {
      const candidate = basisResponse();
      Object.assign(candidate.sections[0]!.understandingCriteria.basis[0]!, { answerRelation });
      const ai = vi.fn().mockResolvedValue(JSON.stringify(referenceResponse(candidate)));
      const blueprint = await generateTeachingBlueprint(basisInput(), ai);
      expect(ai).toHaveBeenCalledTimes(1);
      const normalized = blueprint.sections[0]!.understandingCriteria.basis![0]!;
      expect(normalized.answerRelation).toBe(answerRelation);
      expect(normalized.claimRefs).toEqual([{ knowledgePointId: 'kp', claimId: 'definition' }]);
      expect(normalized.requiredConditions).toEqual([logicalCondition, caseAssumption]);
      for (const outline of teachingBlueprintToOutlines(blueprint, '中文')) {
        expect(outline.teachingBrief!.understandingCriteria!.basis![0]!.answerRelation).toBe(answerRelation);
      }
      expect(blueprint.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(definition);
    },
  );

  it('diagnoses an invalid answer relation while preserving an executable first draft and never infers one for old data', async () => {
    const candidate = basisResponse();
    Object.assign(candidate.sections[0]!.understandingCriteria.basis[0]!, { answerRelation: 'exclusive-method' });
    const ai = vi.fn().mockResolvedValue(JSON.stringify(referenceResponse(candidate)));
    const blueprint = await generateTeachingBlueprint(basisInput(), ai);
    const normalized = blueprint.sections[0]!.understandingCriteria.basis![0]!;
    expect(ai).toHaveBeenCalledTimes(1);
    expect(normalized).not.toHaveProperty('answerRelation');
    expect(normalized.claimRefs).toEqual([{ knowledgePointId: 'kp', claimId: 'definition' }]);
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('判断性质无效');
    expect(teachingBlueprintToOutlines(blueprint, '中文').some((outline) => outline.type === 'quiz')).toBe(true);
    const historical = await generateTeachingBlueprint(basisInput(), vi.fn().mockResolvedValue(JSON.stringify(referenceResponse())));
    expect(historical.sections[0]!.understandingCriteria.basis![0]!).not.toHaveProperty('answerRelation');
    expect((historical.qualityDiagnostics ?? []).join('\n')).not.toContain('判断性质无效');
  });

  it('keeps nominal time and assessment reserves while prioritizing clear explanation over reference timing', () => {
    const current = basisInput();
    current.sectionPlans = [{ title: '同化', knowledgePointIds: ['kp'], teachingBudgetSec: 264 }];
    current.speechTiming = { providerId: 'provider', modelId: 'model', voiceId: 'voice', language: 'zh-CN' };
    const prompt = buildTeachingBlueprintPrompt(current);
    const budgetLine = prompt.user.split('\n').find((line) => line.startsWith('首次正文预算'))!;
    const budget = JSON.parse(budgetLine.slice(budgetLine.indexOf('{')));
    expect(budget).toMatchObject({ targetDurationSec: 240, narrationDurationSec: 240, naturalSpeed: 1,
      enforcement: 'reference-only', priority: 'clear-and-complete-explanation', referenceTolerance: 0.1,
      quoteExpansionIncluded: true, pageHints: [] });
    expect(budget).not.toHaveProperty('planningTolerance');
    expect(current.totalDurationSec).toBe(300);
    expect(prompt.user).toContain('节末短测预留约 60 秒');
    expect(current.sectionPlans[0]!.teachingBudgetSec).toBe(264);
    const planned = JSON.parse(prompt.user.split('不要把翻页当作新小节：\n')[1]!.split('\n')[0]!);
    expect(planned[0].speechBudget.targetDurationSec).toBe(240);
    expect(prompt.system).toContain('每个节点显式写 quoteRefs');
    expect(prompt.system).toContain('不能再改写同一定义');
    expect(prompt.system).toContain('requiredConditions 只选择实际判断需要保留的相应 logicalConditions');
    expect(prompt.system).toContain('全节 speechBudget 用于同次首稿安排节奏，不是必须命中的时长或文字量');
    expect(prompt.system).toContain('必要超时不构成 capacityConflict');
    expect(prompt.user).toContain('不以逐页下限填充');
    expect(prompt.user).toContain('不把时间偏差作为质量通过或失败的条件');
    expect(prompt.user).toContain('保留全部必教内容、严谨条件、名义时间分配和测验预留');
    expect(prompt.user).toContain('不得靠加速、删教案或新增审查修复调用匹配预算');
    expect(prompt.user).not.toContain('不得静默漏讲或自行增加时长');
    expect(prompt.user.match(/"basisClaimIds":\["definition"\]/gu)).toHaveLength(1);
  });

  it.each([
    { policy: 'shared-teaching-contract-v76-reference-capabilities-and-eligible-quotes', speechBudgetPolicy: 'natural-speed-reference-v2', index: 0 },
    { policy: 'shared-teaching-contract-v75-body-grounded-capability-basis', speechBudgetPolicy: 'natural-speed-reference-v2', index: 1 },
    { policy: 'shared-teaching-contract-v74-source-bound-goals-and-scoped-cases', speechBudgetPolicy: 'natural-speed-reference-v2', index: 2 },
    { policy: 'shared-teaching-contract-v73-clause-bound-first-authoring', speechBudgetPolicy: 'natural-speed-reference-v2', index: 3 },
    { policy: 'shared-teaching-contract-v72-canonical-facts-and-prior-basis', speechBudgetPolicy: 'natural-speed-reference-v2', index: 4 },
    { policy: 'shared-teaching-contract-v71-claim-grounded-budgeted-explanation', speechBudgetPolicy: 'natural-speed-section-v1', index: 5 },
  ])('recognizes the stored $policy fingerprint with its original timing policy', ({ policy, speechBudgetPolicy, index }) => {
    const historical: TeachingBlueprintInput = {
      courseTitle: '已完成的首稿', subject: '信息科技', grade: '高中', learningObjectives: ['解释概念'],
      projectContext: '', knowledgePoints: [], totalDurationSec: 300, assessmentMode: 'adaptive', generationMode: 'standard',
      speechTiming: { providerId: 'test', modelId: 'test', voiceId: 'teacher', language: 'zh-CN' },
    };
    const storedFingerprint = fingerprintGenerationValue({
      schemaVersion: 3,
      authoringPolicy: policy,
      budgetPolicy: { assessmentMaxRatio: 0.2, assessmentCoveragePolicy: 3,
        capacityPolicy: 'explanation-first-dynamic-seconds-v1' },
      ...historical,
      speechBudgetPolicy,
    });
    expect(previousTeachingBlueprintInputFingerprints(historical)[index]).toBe(storedFingerprint);
    expect(teachingBlueprintInputFingerprint(historical)).not.toBe(storedFingerprint);
  });

  it('invalidates new voice-dependent budgets while still recognizing completed drafts from previous policies', () => {
    const current = basisInput();
    const voiced = { ...current, speechTiming: { providerId: 'test', modelId: 'test', voiceId: 'teacher', language: 'zh-CN' } };
    expect(teachingBlueprintInputFingerprint(voiced)).not.toBe(teachingBlueprintInputFingerprint(current));
    expect(teachingBlueprintContentFingerprint(voiced)).not.toBe(teachingBlueprintContentFingerprint(current));
    const previousVoiced = previousTeachingBlueprintInputFingerprints(voiced);
    const previousCurrent = previousTeachingBlueprintInputFingerprints(current);
    // v76 through v71 already used actual voice budgets; older policies did not.
    expect(previousVoiced[0]).not.toBe(previousCurrent[0]);
    expect(previousVoiced[1]).not.toBe(previousCurrent[1]);
    expect(previousVoiced[2]).not.toBe(previousCurrent[2]);
    expect(previousVoiced[3]).not.toBe(previousCurrent[3]);
    expect(previousVoiced[4]).not.toBe(previousCurrent[4]);
    expect(previousVoiced[5]).not.toBe(previousCurrent[5]);
    expect(previousVoiced.slice(6)).toEqual(previousCurrent.slice(6));
    expect(teachingBlueprintInputFingerprint({ ...voiced, speechTiming: { ...voiced.speechTiming, voiceId: 'other-teacher' } }))
      .not.toBe(teachingBlueprintInputFingerprint(voiced));
  });
});
