import { describe, expect, it } from 'vitest';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import { buildFirstPassAssessmentInput, buildFirstPassTeachingInput, firstPassPagePlan, firstPassUnderstandingGoals } from './first-pass-authoring';

function fixture(): SceneOutline {
  return { id: 'first', title: '对象与输入', type: 'slide', order: 0, keyPoints: ['当前程序读取表格'], description: '解释对象与输入方式的关系',
    teachingBrief: { schemaVersion: 1, explanation: '旧解释副本', examples: ['旧故事副本'], conditions: ['本课范围'],
      assessmentFocus: '所有工具都必须变换输入', evidence: [],
      teachingPlan: { purpose: '理解接口对输入的约束', priorKnowledge: '知道文件和表格',
        newContent: '旧正文副本', learnerQuestion: '不同工具的输入要求为何不同',
        reasoningSteps: ['旧推理副本'], narrationFocus: ['旧朗读副本'], takeaway: '所有工具不能读文字',
        visibleContent: ['当前程序读取表格'], introduces: ['relation'], references: ['previous-definition'] },
      understandingCriteria: { goals: ['依据接口判断输入是否可用'], answerEssentials: ['所有工具不能读取自然语言'],
        misconceptions: ['可以直接读取原句'], supportingUnitIds: ['unit'],
        basis: [{ id: 'basis', goal: '依据接口判断输入是否可用', nodeIds: ['relation'],
          claimRefs: [{ knowledgePointId: 'input', claimId: 'application' }],
          exampleRefs: [{ knowledgePointId: 'input', exampleId: 'table' }], requiredConditions: ['该程序的接口只接收表格'] }] },
      authoring: { nodes: [{ id: 'relation', kind: 'mechanism', content: '这一个具体程序只读取表格，所以把同一观测记录按接口组织后才可交给它处理。',
        knowledgePointIds: ['input'], prerequisiteNodeIds: [], provenance: 'derived',
        claimRefs: [{ knowledgePointId: 'input', claimId: 'application' }], quoteDuties: [], exampleIds: ['table'] }],
        examplePlans: [{ knowledgePointId: 'input', mode: 'constructed', selectedExampleIds: ['table'], rationale: '显示具体输入接口约束' }],
        knowledge: [{ knowledgePointId: 'input', authoring: {
          claims: [{ id: 'source', kind: 'textbook', text: '表示形式取决于处理对象。', sources: [] },
            { id: 'application', kind: 'derived', text: '该程序需接收表格输入。', sources: [],
              logicalConditions: ['该程序的接口只接收表格'], teachingScope: '本课讨论输入形式', basisClaimIds: ['source'] },
            { id: 'unused', kind: 'derived', text: '不应成为当前课后结论的未采用概括', sources: [] }],
          examples: [{ id: 'table', kind: 'constructed', title: '记录输入', purpose: '说明输入与接口的关系', facts: ['旧版无限定能力断言'],
            explanation: '旧版案例分析副本', objectAndTask: '把一条观测记录交给只读取表格的统计程序',
            assumptions: ['该程序的接口只接收表格'], actions: ['按列名录入观测记录'], outcome: '程序收到合乎接口的数据',
            conceptMapping: '组织同一条知识的形式以适合此程序', claimIds: ['application'], sources: [] }], exampleCoverage: [],
        } }] } },
  };
}

describe('first authoring body and bindings', () => {
  it('keeps only bound assertion conditions in the new reading contract while preserving an old catalog', () => {
    const page = fixture();
    const authoring = page.teachingBrief!.authoring!.knowledge[0].authoring;
    const legacy = buildFirstPassTeachingInput([page]).catalog;
    authoring.readingContract = 'source-blocks-v1';
    const lecture = buildFirstPassTeachingInput([page]).catalog;
    const oldCanonical = structuredClone(authoring);
    delete oldCanonical.readingContract;
    expect(buildFirstPassTeachingInput([page], [{ id: 'input', authoring: oldCanonical }]).catalog).toEqual(lecture);
    const assessment = buildFirstPassAssessmentInput([page]);
    for (const catalog of [lecture, assessment]) {
      expect(JSON.stringify(catalog)).not.toContain('本课讨论输入形式');
      expect(catalog.statements.find((item) => item.claimId === 'application')).toMatchObject({
        logicalConditions: ['该程序的接口只接收表格'], basisClaimIds: ['source'],
      });
      expect(catalog.statements.find((item) => item.claimId === 'application')).not.toHaveProperty('teachingScope');
    }
    expect(lecture.texts).toEqual(legacy.texts);
    delete authoring.readingContract;
    expect(buildFirstPassTeachingInput([page]).catalog).toEqual(legacy);
  });

  it('carries addressed contributions without a second body or an assessment answer projection', () => {
    const page = fixture();
    const node = page.teachingBrief!.authoring!.nodes[0];
    node.contentContributions = [{ partId: 'application-step', start: 0, end: node.content.length,
      contribution: { kind: 'reasoning', claimRefs: node.claimRefs!, prerequisiteNodeIds: [] } }];
    const lecture = buildFirstPassTeachingInput([page]).catalog;
    const included = lecture.explanationNodes[0];
    expect(included.contentContributions).toEqual(node.contentContributions);
    expect(lecture.texts[included.bodyRef]).toBe(node.content);
    expect(JSON.stringify(lecture).split(node.content)).toHaveLength(2);
    const assessment = buildFirstPassAssessmentInput([page]);
    expect(JSON.stringify(assessment)).not.toContain(node.content);
    expect(assessment.taughtNodes[0]).not.toHaveProperty('contentContributions');
  });

  it('does not pass a compatibility conclusion as the modern assessment target', () => {
    const page = fixture();
    const criteria = page.teachingBrief!.understandingCriteria!;
    criteria.goalSource = 'references';
    criteria.goals = ['所有工具都必须把文字改成表格'];
    criteria.basis![0].goal = criteria.goals[0];
    criteria.basis![0].operation = 'apply';
    const target = firstPassUnderstandingGoals(page);
    expect(target).toMatchObject({ goalSource: 'references', supportingUnitIds: ['unit'],
      basis: [{ operation: 'apply', claimRefs: [{ knowledgePointId: 'input', claimId: 'application' }],
        nodeIds: ['relation'], exampleRefs: [{ knowledgePointId: 'input', exampleId: 'table' }],
        requiredConditions: ['该程序的接口只接收表格'] }] });
    expect(JSON.stringify(target)).not.toContain(criteria.goals[0]);
    expect(target).not.toHaveProperty('goals');
    expect(target!.basis![0]).not.toHaveProperty('goal');
    // Earlier completed courses retain the original ability projection.
    criteria.goalSource = 'basis';
    expect(firstPassUnderstandingGoals(page)).toMatchObject({ goals: criteria.goals, basis: criteria.basis });
  });

  it('uses source assertions and explicit scenarios for answers without another generated lecture body', () => {
    const page = fixture();
    page.teachingBrief!.authoring!.nodes[0].content = '生成的总结：一切输入只能采用表格，只有转换才可能执行。';
    const assessment = buildFirstPassAssessmentInput([page]);
    expect(JSON.stringify(assessment)).not.toContain(page.teachingBrief!.authoring!.nodes[0].content);
    expect(assessment).not.toHaveProperty('explanationNodes');
    expect(assessment).not.toHaveProperty('basisNodes');
    expect(assessment.taughtNodes).toMatchObject([{ id: 'relation', kind: 'mechanism',
      claimRefs: [{ knowledgePointId: 'input', claimId: 'application' }], exampleIds: ['table'] }]);
    const statement = assessment.statements.find((item) => item.claimId === 'application')!;
    expect(assessment.texts[statement.statementRef]).toBe('该程序需接收表格输入。');
    expect(statement).toMatchObject({ kind: 'derived', basisClaimIds: ['source'], logicalConditions: ['该程序的接口只接收表格'] });
    expect(assessment.cases[0].assumptionsRefs!.map((ref) => assessment.texts[ref])).toEqual(['该程序的接口只接收表格']);
    expect(assessment.cases[0].actionsRefs!.map((ref) => assessment.texts[ref])).toEqual(['按列名录入观测记录']);
    expect(assessment.statements.map((item) => item.claimId)).toEqual(['application', 'source']);
  });

  it('interns a node once across introduce/deepen pages and omits all compatibility prose', () => {
    const first = fixture();
    const next = structuredClone(first);
    next.id = 'second';
    next.teachingBrief!.teachingPlan!.introduces = [];
    next.teachingBrief!.teachingPlan!.deepens = ['relation'];
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.explanationNodes).toHaveLength(1);
    const duty = input.pages.get(first.id)!.nodeDuties[0];
    expect(input.pages.get(next.id)!.nodeDuties[0]).toEqual({ ...duty, role: 'deepen' });
    expect(input.pages.get(first.id)!.nodeDuties[1]).toEqual({ nodeId: 'previous-definition', role: 'reference' });
    const wire = JSON.stringify({ teachingAuthoring: input.catalog,
      pages: [first, next].map((page) => ({ authoring: input.pages.get(page.id), teachingPlan: firstPassPagePlan(page) })) });
    expect(wire.split(first.teachingBrief!.authoring!.nodes[0].content)).toHaveLength(2);
    for (const duplicate of ['旧正文副本', '旧推理副本', '旧朗读副本', '旧解释副本', '旧版案例分析副本']) expect(wire).not.toContain(duplicate);
  });

  it('carries actual premises and their dependencies without upgrading teaching scope or unused summaries', () => {
    const page = fixture();
    const input = buildFirstPassTeachingInput([page]);
    const application = input.catalog.statements.find((claim) => claim.claimId === 'application');
    expect(application).toMatchObject({ kind: 'derived', logicalConditions: ['该程序的接口只接收表格'],
      teachingScope: '本课讨论输入形式', basisClaimIds: ['source'] });
    expect(input.catalog.statements.map((claim) => claim.claimId)).toEqual(['application', 'source']);
    expect(firstPassUnderstandingGoals(page)).not.toHaveProperty('answerEssentials');
    expect(firstPassUnderstandingGoals(page)).not.toHaveProperty('misconceptions');
    expect(input.catalog.cases[0]).not.toHaveProperty('factsRefs');
    expect(input.catalog.texts[input.catalog.cases[0].assumptionsRefs![0]]).toBe('该程序的接口只接收表格');
    expect(input.catalog.cases[0].claimRefs).toEqual([{ knowledgePointId: 'input', claimId: 'application' }]);
    expect(JSON.stringify(input.catalog)).not.toContain('旧版无限定能力断言');
  });

  it('does not grant a case label or intended effect the identity of its textbook facts', () => {
    const page = fixture();
    const example = page.teachingBrief!.authoring!.knowledge[0].authoring.examples[0];
    example.kind = 'textbook';
    example.title = '生成的绝对能力标签';
    example.purpose = '只有这项指导才可能得到结果的生成概括';
    example.facts = ['在给定输入规则下，这条记录可以被读取。'];
    example.limitations = '本例仅说明这一个接口的输入规则。';
    const current = buildFirstPassTeachingInput([page]);
    const historical = buildFirstPassTeachingInput([page], [], { legacyCasePlanningMetadata: true });
    expect(current.catalog.cases[0]).not.toHaveProperty('title');
    expect(current.catalog.cases[0]).not.toHaveProperty('purpose');
    expect(JSON.stringify(current.catalog)).not.toContain(example.purpose);
    expect(JSON.stringify(current.catalog)).not.toContain(example.title);
    expect(current.catalog.cases[0].factsRefs!.map((ref) => current.catalog.texts[ref])).toEqual(example.facts);
    expect(current.catalog.cases[0].limitations).toBe(example.limitations);
    // Historical identity is available only to the completed checkpoint path;
    // its body, facts, conditions and source references are unchanged.
    expect(historical.catalog.cases[0]).toMatchObject({ title: example.title, purpose: example.purpose });
    const { title: _title, purpose: _purpose, ...historicalCase } = historical.catalog.cases[0];
    expect(historicalCase).toEqual(current.catalog.cases[0]);
    expect(historical.catalog.texts).toEqual(current.catalog.texts);
    expect(historical.pages).toEqual(current.pages);
  });

  it('keeps an explicit reference as a reference after the node was introduced', () => {
    const first = fixture();
    const next = structuredClone(first);
    next.id = 'reference-page';
    next.teachingBrief!.teachingPlan!.introduces = [];
    next.teachingBrief!.teachingPlan!.references = ['relation'];
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.explanationNodes).toHaveLength(1);
    expect(input.pages.get(next.id)!.nodeDuties).toEqual([
      { ...input.pages.get(first.id)!.nodeDuties[0], role: 'reference' },
    ]);
  });

  it('resolves a case correspondence through the whole claim and existing action without a second free conclusion', () => {
    const page = fixture();
    const example = page.teachingBrief!.authoring!.knowledge[0].authoring.examples[0];
    example.claimIds = [];
    example.correspondences = [{ claimId: 'source', claimPhrase: '表示形式',
      caseElement: { field: 'actions', index: 0 } }];
    example.conceptMapping = '旧的自由推断：所有程序只读表格';
    const claim = page.teachingBrief!.authoring!.knowledge[0].authoring.claims[0];
    claim.conditions = '旧的混合范围说明';
    const input = buildFirstPassTeachingInput([page]);
    const candidate = input.catalog.cases[0];
    expect(candidate.correspondences).toEqual([{ claimRef: { knowledgePointId: 'input', claimId: 'source' },
      claimPhrase: '表示形式', caseElement: { field: 'actions', index: 0 } }]);
    expect(input.catalog.texts[candidate.actionsRefs![0]]).toBe(example.actions![0]);
    const statement = input.catalog.statements.find((item) => item.claimId === 'source')!;
    expect(input.catalog.texts[statement.statementRef]).toBe(claim.text);
    expect(statement).not.toHaveProperty('conditions');
    expect(candidate).not.toHaveProperty('conceptMappingRef');
    expect(JSON.stringify(input.catalog)).not.toContain('旧的自由推断');
    expect(JSON.stringify(input.catalog)).not.toContain('旧的混合范围说明');
  });

  it('keeps one scenario and its bound correspondences when later compatibility prose changes', () => {
    const first = fixture();
    first.teachingBrief!.authoring!.knowledge[0].authoring.examples[0].correspondences = [{
      claimId: 'source', claimPhrase: '表示形式', caseElement: { field: 'actions', index: 0 },
    }];
    const next = structuredClone(first);
    next.id = 'deeper';
    const example = next.teachingBrief!.authoring!.knowledge[0].authoring.examples[0];
    example.conceptMapping = '后续旧版概括不同';
    example.facts = ['后续旧版事实投影不同'];
    delete example.correspondences;
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.cases).toHaveLength(1);
    expect(input.catalog.cases[0].correspondences).toHaveLength(1);
    expect(input.pages.get(first.id)!.caseRefs).toEqual(input.pages.get(next.id)!.caseRefs);
  });

  it('retains indexed facts actually used by a structured constructed case', () => {
    const first = fixture();
    const example = first.teachingBrief!.authoring!.knowledge[0].authoring.examples[0];
    example.facts = ['同一次观测得到数值18', '姓名和值属于同一条记录'];
    example.correspondences = [{ claimId: 'source', claimPhrase: '表示形式',
      caseElement: { field: 'facts', index: 1 } }];
    const next = structuredClone(first);
    next.id = 'reference-facts';
    delete next.teachingBrief!.authoring!.knowledge[0].authoring.examples[0].correspondences;
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.cases).toHaveLength(1);
    const candidate = input.catalog.cases[0];
    expect(candidate.correspondences![0].caseElement).toEqual({ field: 'facts', index: 1 });
    expect(candidate.factsRefs!.map((ref) => input.catalog.texts[ref])).toEqual(example.facts);
    expect(input.catalog.texts[candidate.factsRefs![1]]).toBe('姓名和值属于同一条记录');
  });

  it('keeps scenarios with different mapped facts distinct instead of overwriting their premises', () => {
    const first = fixture();
    const example = first.teachingBrief!.authoring!.knowledge[0].authoring.examples[0];
    example.facts = ['这次观测记录值为18'];
    example.correspondences = [{ claimId: 'source', claimPhrase: '表示形式',
      caseElement: { field: 'facts', index: 0 } }];
    const next = structuredClone(first);
    next.id = 'different-observation';
    next.teachingBrief!.authoring!.knowledge[0].authoring.examples[0].facts = ['这次观测记录值为21'];
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.cases).toHaveLength(2);
    expect(input.catalog.cases.map((candidate) => input.catalog.texts[candidate.factsRefs![0]]))
      .toEqual(['这次观测记录值为18', '这次观测记录值为21']);
    expect(input.pages.get(first.id)!.caseRefs).not.toEqual(input.pages.get(next.id)!.caseRefs);
  });

  it('retains a separately split part instead of substituting the first part for the entire node', () => {
    const first = fixture();
    const next = structuredClone(first);
    next.id = 'next';
    next.teachingBrief!.authoring!.nodes[0].content = '进一步比较同一知识可有不同表示形式。';
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.explanationNodes).toHaveLength(2);
    expect(input.pages.get('first')!.nodeDuties[0].nodeRef).not.toBe(input.pages.get('next')!.nodeDuties[0].nodeRef);
    expect(Object.values(input.catalog.texts)).toContain(next.teachingBrief!.authoring!.nodes[0].content);
  });

  it('carries a prior-section basis and its case premises without assigning another teaching duty', () => {
    const page = fixture();
    const prior = structuredClone(page.teachingBrief!.authoring!.knowledge[0]!.authoring);
    const priorNode = { ...structuredClone(page.teachingBrief!.authoring!.nodes[0]!), id: 'prior-relation',
      knowledgePointIds: ['prior'], claimRefs: [{ knowledgePointId: 'prior', claimId: 'application' }] };
    page.teachingBrief!.authoring!.basisNodes = [priorNode];
    page.teachingBrief!.understandingCriteria!.basis!.push({ id: 'previous-basis',
      goal: '依据接口判断输入是否可用', nodeIds: ['prior-relation'],
      claimRefs: [{ knowledgePointId: 'prior', claimId: 'application' }],
      exampleRefs: [{ knowledgePointId: 'prior', exampleId: 'table' }],
      requiredConditions: ['该程序的接口只接收表格'] });
    const input = buildFirstPassTeachingInput([page], [{ id: 'prior', authoring: prior }]);
    expect(input.catalog.statements.filter((claim) => claim.knowledgePointId === 'prior')
      .map((claim) => claim.claimId)).toEqual(['application', 'source']);
    expect(input.catalog.cases.find((item) => item.knowledgePointId === 'prior')).toMatchObject({
      assumptionsRefs: expect.any(Array), claimRefs: [{ knowledgePointId: 'prior', claimId: 'application' }],
    });
    expect(input.catalog.basisNodes).toHaveLength(1);
    expect(input.catalog.basisNodes![0]).toMatchObject({ id: 'prior-relation', quoteDuties: [] });
    expect(input.pages.get(page.id)!.nodeDuties.map((duty) => duty.nodeId)).not.toContain('prior-relation');
    expect(input.pages.get(page.id)!.caseRefs).toEqual(['input:table']);
    expect(input.catalog.explanationNodes.map((node) => node.id)).toEqual(['relation']);
  });

  it('diagnoses a missing explicit claim without substituting unused generated conclusions', () => {
    const page = fixture();
    page.teachingBrief!.authoring!.nodes[0]!.claimRefs = [{ knowledgePointId: 'input', claimId: 'missing' }];
    page.teachingBrief!.authoring!.nodes[0]!.quoteDuties = [];
    page.teachingBrief!.authoring!.nodes[0]!.exampleIds = [];
    page.teachingBrief!.understandingCriteria!.basis = [];
    const input = buildFirstPassTeachingInput([page]);
    expect(input.catalog.unavailableClaimRefs).toEqual([{ knowledgePointId: 'input', claimId: 'missing' }]);
    expect(input.catalog.statements).toEqual([]);
    expect(JSON.stringify(input.catalog)).not.toContain('不应成为当前课后结论的未采用概括');
  });

  it('keeps the full catalog when a later page carries only a trimmed basis for the same point', () => {
    const first = fixture();
    const next = structuredClone(first);
    next.id = 'later-basis';
    const knowledge = next.teachingBrief!.authoring!.knowledge[0]!.authoring;
    knowledge.claims = knowledge.claims.filter((claim) => claim.id === 'source');
    knowledge.examples = [];
    next.teachingBrief!.authoring!.nodes = [];
    next.teachingBrief!.understandingCriteria!.basis = [];
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.statements.map((claim) => claim.claimId)).toEqual(['application', 'source']);
    expect(input.catalog.cases).toHaveLength(1);
    expect(input.pages.get('first')!.caseRefs).toEqual(['input:table']);
    expect(input.catalog.unavailableClaimRefs).toBeUndefined();
  });

  it('retains different scenario assumptions even when old pages reuse the same candidate id', () => {
    const first = fixture();
    const next = structuredClone(first);
    next.id = 'other-tool';
    next.teachingBrief!.authoring!.knowledge[0]!.authoring.examples[0]!.assumptions = ['另一个程序接受结构化表格或专用JSON'];
    const input = buildFirstPassTeachingInput([first, next]);
    expect(input.catalog.cases).toHaveLength(2);
    const firstRef = input.pages.get(first.id)!.caseRefs[0];
    const nextRef = input.pages.get(next.id)!.caseRefs[0];
    expect(firstRef).not.toBe(nextRef);
    expect(input.catalog.cases.map((example) => example.assumptionsRefs!.map((ref) => input.catalog.texts[ref])))
      .toEqual([['该程序的接口只接收表格'], ['另一个程序接受结构化表格或专用JSON']]);
  });

  it('keeps old briefs and legacy claim conditions readable', () => {
    const page = fixture();
    delete page.teachingBrief!.authoring;
    expect(firstPassPagePlan(page)).toBe(page.teachingBrief!.teachingPlan);
    expect(firstPassUnderstandingGoals(page)).toBe(page.teachingBrief!.understandingCriteria);
    expect(buildFirstPassTeachingInput([page]).pages.size).toBe(0);
  });
});
