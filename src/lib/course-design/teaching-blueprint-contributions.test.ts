import { describe, expect, it, vi } from 'vitest';
import { buildAuthoringExcerptCatalog } from './knowledge-authoring';
import { applyReviewedOutlinesToTeachingBlueprint, buildTeachingBlueprintPrompt, generateTeachingBlueprint,
  revalidateStoredTeachingBlueprint, teachingBlueprintToOutlines, validateTeachingBlueprintDraft,
  TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION, type TeachingBlueprintInput } from './teaching-blueprint';
import { fingerprintGenerationValue, fingerprintSceneOutline } from '@/lib/course-generation/page-checkpoints';
import type { TeachingContentContribution, TeachingFactBasis } from '@/lib/session/types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';

const statement = '符号可以在既定约定中表示对象。';
const relationship = '箭头的方向表示这套标识中的通行方向。';
const facts = ['红卡标识入口。', '箭头从入口指向出口。'];
const claimRef = { knowledgePointId: 'kp', claimId: 'statement' };
const exampleRef = { knowledgePointId: 'kp', exampleId: 'case' };

function fixtureInput(modern = true): TeachingBlueprintInput {
  const content = [statement, relationship, ...facts].join('\n');
  const evidence: CourseEvidenceSnapshot = { schemaVersion: 2, version: 1, fingerprint: 'source',
    createdAt: '2026-10-02T00:00:00Z', retrievalMode: 'hybrid', warnings: [], selections: [], mappings: [],
    items: [{ id: 'e', kind: 'source-block', title: '标识', content,
      source: { textbookId: 'book', textbookTitle: '教材', revisionId: 'rev', revisionVersion: 1,
        sectionPath: ['标识'], sourceBlockId: 'b', quote: content },
      completeSourceBlocks: [{ sourceBlockId: 'b', content }] }] };
  const catalog = buildAuthoringExcerptCatalog(evidence);
  const block = catalog.sourceBlocks[0]!;
  const excerptRef = { evidenceItemId: 'e', sourceBlockId: 'b', excerptId: block.excerpts.find((part) => part.text === statement)!.excerptId };
  const source = (quote: string) => [{ evidenceItemId: 'e', sourceBlockIds: ['b'], quote, textbookId: 'book', revisionId: 'rev' }];
  return { courseTitle: '表示与理解', subject: '信息科学', grade: '大学', learningObjectives: ['解释具体标识中的关系'],
    projectContext: '', totalDurationSec: 300, assessmentMode: 'adaptive', generationMode: 'standard',
    contentReviewMode: 'teacher-final', firstAuthoringContract: 'blueprint-v5', sourceContext: content, sourceEvidence: evidence,
    knowledgePoints: [{ id: 'kp', name: '标识关系', description: 'UNSUPPORTED_DESCRIPTION', keyInfo: 'UNSUPPORTED_KEYINFO',
      masteryBoundary: 'UNSUPPORTED_MASTERY', teachingDepth: 'detailed', evidenceItemIds: ['e'], authoring: {
        ...(modern ? { readingContract: 'source-blocks-v1' as const } : {}),
        claims: [{ id: 'statement', kind: 'textbook', text: statement, sources: source(statement),
          excerptRefs: [excerptRef], authoritativeExcerpts: [{ excerptRef, role: 'definition' }],
          teachingScope: 'UNSUPPORTED_TEACHING_SCOPE', conditions: 'UNSUPPORTED_LEGACY_SCOPE' },
        { id: 'relationship', kind: 'textbook', text: relationship, sources: source(relationship) },
        { id: 'application', kind: 'derived', text: '这次观察涉及给定箭头。', sources: source(relationship), basisClaimIds: ['relationship'] }],
        examples: [{ id: 'case', kind: 'textbook', title: 'UNSUPPORTED_CASE_TITLE', purpose: 'UNSUPPORTED_CASE_PURPOSE',
          explanation: 'UNSUPPORTED_CASE_EXPLANATION', conceptMapping: 'UNSUPPORTED_CASE_MAPPING',
          facts, objectAndTask: '观察一套给定的入口与出口标识。', assumptions: ['只讨论这套约定'],
          actions: ['依箭头观察入口与出口'], outcome: '辨认这套标识的通行方向', claimIds: ['relationship'],
          sources: source(facts.join('')) }],
        learningTasks: [{ claimIds: ['statement'], operation: 'identify' }, { claimIds: ['relationship'], operation: 'explain' }],
        exampleCoverage: [{ textbookId: 'book', revisionId: 'rev', status: 'complete', evidenceItemIds: ['e'] }],
      } }] };
}

type Part = { id: string; text: string; contribution?: TeachingContentContribution | Record<string, unknown> };
type RawNode = { id: string; unitId: string; kind: string; knowledgePointIds: string[]; prerequisiteNodeIds: string[];
  contentParts: Part[]; provenance: string; quoteRefs: unknown[]; claimRefs?: typeof claimRef[]; exampleIds?: string[] };
type RawPage = { id: string; title: string; type: string; description: string; explanationNodes: RawNode[];
  presentationItems: Array<{ text: string; nodeIds: string[]; role: string }>;
  entryPoint: { kind: string; object: string; bridge: string; basis?: TeachingFactBasis };
  taskConnection: { mode: string; rationale: string } };
function fixtureRaw(modern = true) {
  const excerptRef = fixtureInput().knowledgePoints[0]!.authoring!.claims[0]!.excerptRefs![0]!;
  const node = (id: string, kind: string, contentParts: Part[], prerequisiteNodeIds: string[] = []): RawNode => ({
    id, unitId: 'u', kind, knowledgePointIds: ['kp'], prerequisiteNodeIds, contentParts,
    provenance: kind === 'example' ? 'constructed' : 'derived', quoteRefs: [],
  });
  const defined = node('definition', 'concept', [{ id: 'source', text: statement,
    ...(modern ? { contribution: { kind: 'source-statement' as const, claimRef } } : {}) },
  { id: 'term', text: '约定是这套标识中事先确定的对应方式。🔍',
    ...(modern ? { contribution: { kind: 'clarify-term' as const, claimRef, claimPhrase: '既定约定' } } : {}) }]);
  defined.claimRefs = [claimRef];
  defined.quoteRefs = [{ ...claimRef, excerptRef }];
  const example = node('example', 'example', [{ id: 'facts', text: facts.join(''),
    ...(modern ? { contribution: { kind: 'case-facts' as const, caseRef: exampleRef,
      elementRefs: [{ field: 'facts' as const, index: 0 }, { field: 'facts' as const, index: 1 }] } } : {}) },
  { id: 'analysis', text: '这里只根据给定箭头分析入口与出口的通行关系。',
    ...(modern ? { contribution: { kind: 'case-analysis' as const, caseRef: exampleRef,
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'relationship' }], elementRefs: [{ field: 'assumptions' as const, index: 0 }] } } : {}) }], ['definition']);
  example.exampleIds = ['case'];
  const reasoning = node('reasoning', 'relation', [{ id: 'relationship', text: '在这套标识约定中，沿箭头观察给定通行关系。',
    ...(modern ? { contribution: { kind: 'reasoning' as const, claimRefs: [{ knowledgePointId: 'kp', claimId: 'relationship' }],
      prerequisiteNodeIds: ['definition', 'example'] } } : {}) }], ['definition', 'example']);
  const page = (id: string, item: RawNode, prior: string[] = []): RawPage => ({ id, title: '标识关系', type: 'slide',
    description: `本页建立${item.id}的认识`, explanationNodes: [item],
    presentationItems: [{ text: id === 'p1' ? '给定约定中的标识' : '观察这套标识中的方向', nodeIds: [item.id], role: 'key-point' }],
    entryPoint: { kind: prior.length ? 'continuation' : 'concrete-observation', object: '这套入口与出口标识',
      bridge: '观察实际给定的对应关系', ...(modern ? { basis: { claimRefs: [claimRef],
        ...(id === 'p3' ? { exampleRefs: [exampleRef] } : {}), prerequisiteNodeIds: prior } } : {}) },
    taskConnection: { mode: 'none', rationale: '按知识点的实际案例说明' } });
  return { authoringContract: 'blueprint-v5', sections: [{ title: '标识关系', units: [{ id: 'u', title: '标识关系',
    knowledgePointIds: ['kp'], examplePlan: [{ knowledgePointId: 'kp', mode: 'textbook', selectedExampleIds: ['case'], rationale: '分析给定方向' }] }],
    pages: [page('p1', defined), page('p2', example, ['definition']), page('p3', reasoning, ['example'])],
    understandingCriteria: { basis: [{ id: 'identify', operation: 'identify', answerRelation: 'source-statement',
      claimRefs: [claimRef], nodeIds: ['definition'] },
    { id: 'explain', operation: 'explain', answerRelation: 'conditional-application',
      claimRefs: [{ knowledgePointId: 'kp', claimId: 'relationship' }], nodeIds: ['example', 'reasoning'], exampleRefs: [exampleRef] }] } }] };
}

describe('first-pass reference-bound content contributions', () => {
  it('chooses addresses at the body-writing position and excludes generated scope and answer prose from V8 input', () => {
    const prompt = buildTeachingBlueprintPrompt(fixtureInput());
    expect(prompt.user).not.toMatch(/UNSUPPORTED_/u);
    expect(prompt.user).toContain('"learningTasks":[{"claimIds":["statement"],"operation":"identify"}');
    expect(prompt.user).toContain('"teachingDepth":"detailed"');
    expect(prompt.user).toContain(statement);
    expect(prompt.system).toContain('先选择本段承担的贡献及实际依据地址，再写一份对应正文');
    expect(prompt.system).toContain('不要求每节点具备所有类别');
    expect(prompt.system).not.toContain('再分别解释其中概念');
    expect(prompt.system).not.toContain('term/concept 节点展开初学者可能不懂的用语');
    expect(prompt.system).not.toContain('basis.goal');
    const output = JSON.parse(prompt.user.split('返回结构：\n')[1]!.split('\n\n按需字段示例')[0]!);
    expect(output.sections[0].pages[0].explanationNodes[0].contentParts[0].contribution.kind).toBe('source-statement');
    expect(output.sections[0].pages[0].entryPoint.basis).toHaveProperty('claimRefs');
    expect(output.sections[0].understandingCriteria.basis[0]).not.toHaveProperty('goal');
    const old = buildTeachingBlueprintPrompt(fixtureInput(false));
    expect(old.user).toContain('UNSUPPORTED_TEACHING_SCOPE');
    const oldOutput = JSON.parse(old.user.split('返回结构：\n')[1]!.split('\n\n按需字段示例')[0]!);
    expect(oldOutput.sections[0].pages[0].explanationNodes[0].contentParts[0]).not.toHaveProperty('contribution');
    expect(oldOutput.sections[0].pages[0].entryPoint).not.toHaveProperty('basis');
  });

  it('stores UTF16 contribution ranges on the one body and passes them and entry addresses to real page briefs', async () => {
    const raw = fixtureRaw();
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(fixtureInput(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const nodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(nodes[0]!.content).toBe(raw.sections[0]!.pages[0]!.explanationNodes[0]!.contentParts.map((part) => part.text).join(' '));
    const term = nodes[0]!.contentContributions![1]!;
    expect(term).toMatchObject({ partId: 'term', start: statement.length + 1, end: nodes[0]!.content.length,
      contribution: { kind: 'clarify-term', claimRef, claimPhrase: '既定约定' } });
    expect(nodes[0]!.content.slice(term.start, term.end)).toContain('🔍');
    expect(term).not.toHaveProperty('text');
    expect(nodes[0]!.quoteDuties).toHaveLength(1);
    expect(nodes[1]!.claimRefs).toEqual([{ knowledgePointId: 'kp', claimId: 'relationship' }]);
    expect(nodes[2]!.quoteDuties).toEqual([]);
    expect(nodes[2]!.contentContributions![0]!.contribution).toMatchObject({ kind: 'reasoning',
      prerequisiteNodeIds: [nodes[0]!.id, nodes[1]!.id] });
    const slides = teachingBlueprintToOutlines(blueprint, '中文').filter((outline) => outline.type === 'slide');
    expect(slides[1]!.teachingBrief!.authoring!.nodes[0]!.contentContributions).toEqual(nodes[1]!.contentContributions);
    expect(slides[1]!.teachingBrief!.teachingPlan!.entryPoint!.basis).toEqual({ claimRefs: [claimRef], prerequisiteNodeIds: [nodes[0]!.id] });
    expect(slides[2]!.teachingBrief!.teachingPlan!.entryPoint!.basis!.exampleRefs).toEqual([exampleRef]);
    expect(revalidateStoredTeachingBlueprint(blueprint, fixtureInput(), { qualityMode: 'diagnostic' }).blueprint!.sections).toEqual(blueprint.sections);
  });

  it('diagnoses invalid source identity, phrase and case positions while preserving the first body with no extra call', async () => {
    const raw = fixtureRaw();
    const nodes = raw.sections[0]!.pages.map((page) => page.explanationNodes[0]!);
    nodes[0]!.contentParts[0]!.contribution = { kind: 'source-statement', claimRef: { knowledgePointId: 'kp', claimId: 'application' } };
    nodes[0]!.contentParts[1]!.contribution = { kind: 'clarify-term', claimRef, claimPhrase: statement };
    nodes[1]!.contentParts[0]!.contribution = { kind: 'case-facts', caseRef: exampleRef,
      elementRefs: [{ field: 'facts', index: 1 }, { field: 'facts', index: 99 }, { field: 'outcome', index: 0 }] };
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(fixtureInput(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const actual = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(actual[0]!.content).toContain(statement);
    expect(actual[0]!.contentContributions).toEqual([]);
    expect(actual[1]!.content).toContain(facts[1]);
    expect(actual[1]!.contentContributions![0]!.contribution).toMatchObject({ elementRefs: [{ field: 'facts', index: 1 }] });
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('不提升生成解释的事实身份');
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('不能把整句改写');
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('不存在的事实、前提、动作或结果位置');
  });

  it('retains directly constructed self cases, excludes future/nonexample addresses and keeps entry premises prior to the page', async () => {
    const current = fixtureInput();
    current.knowledgePoints[0]!.authoring!.examples = [];
    const raw = fixtureRaw();
    raw.sections[0]!.units[0]!.examplePlan[0] = { knowledgePointId: 'kp', mode: 'constructed', selectedExampleIds: [], rationale: '建立一个简单情境' };
    const pages = raw.sections[0]!.pages;
    const self = pages[1]!.explanationNodes[0]!;
    self.exampleIds = [];
    self.contentParts = [{ id: 'self', text: '在一个只按给定箭头移动的示意工具中，观察入口与出口。',
      contribution: { kind: 'case-facts', caseRef: { nodeId: self.id } } },
    { id: 'self-analysis', text: '这里只分析给定工具中这一条箭头的作用。',
      contribution: { kind: 'case-analysis', caseRef: { nodeId: self.id }, claimRefs: [{ knowledgePointId: 'kp', claimId: 'relationship' }] } }];
    pages[0]!.explanationNodes[0]!.contentParts.push({ id: 'future', text: '保存这一段原稿供审阅。',
      contribution: { kind: 'case-analysis', caseRef: { nodeId: self.id }, claimRefs: [claimRef] } });
    pages[2]!.explanationNodes[0]!.contentParts.push({ id: 'nonexample', text: '保存另一个实际说明。',
      contribution: { kind: 'case-facts', caseRef: { nodeId: 'definition' } } });
    pages[0]!.entryPoint.basis = { claimRefs: [claimRef], prerequisiteNodeIds: ['definition', 'reasoning'] };
    pages[2]!.entryPoint.basis = { prerequisiteNodeIds: ['example'] };
    raw.sections[0]!.understandingCriteria.basis[1]!.exampleRefs = [];
    const blueprint = await generateTeachingBlueprint(current, vi.fn().mockResolvedValue(JSON.stringify(raw)));
    const nodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(nodes[1]!.contentContributions).toHaveLength(2);
    expect(nodes[1]!.contentContributions![0]!.contribution).toEqual({ kind: 'case-facts', caseRef: { nodeId: nodes[1]!.id } });
    expect(nodes[0]!.content).toContain('保存这一段原稿供审阅');
    expect(nodes[0]!.contentContributions!.map((part) => part.partId)).not.toContain('future');
    expect(nodes[2]!.contentContributions!.map((part) => part.partId)).not.toContain('nonexample');
    expect(blueprint.sections[0]!.pages[0]!.entryPoint!.basis!.prerequisiteNodeIds).toEqual([]);
    expect(blueprint.sections[0]!.pages[2]!.entryPoint!.basis!.prerequisiteNodeIds).toEqual([nodes[1]!.id]);
    expect(blueprint.qualityDiagnostics!.join('\n')).not.toContain(`解释节点 ${self.id}：案例依据`);
    expect(teachingBlueprintToOutlines(blueprint, '中文')[1]!.teachingBrief!.authoring!.nodes[0]!.contentContributions).toHaveLength(2);
  });

  it('uses actual page and within-page teaching order for inference addresses', async () => {
    const raw = fixtureRaw();
    const pages = raw.sections[0]!.pages;
    const reasoning = pages[2]!.explanationNodes[0]!;
    reasoning.contentParts[0]!.contribution = { kind: 'reasoning', claimRefs: [], prerequisiteNodeIds: ['definition', 'example'] };
    pages[0]!.explanationNodes.push(reasoning);
    pages.splice(2, 1);
    const blueprint = await generateTeachingBlueprint(fixtureInput(), vi.fn().mockResolvedValue(JSON.stringify(raw)));
    const nodes = blueprint.sections[0]!.units[0]!.explanationNodes!;
    expect(nodes[1]!.contentContributions![0]!.contribution).toEqual({ kind: 'reasoning', claimRefs: [], prerequisiteNodeIds: [nodes[0]!.id] });
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('推理贡献引用了尚未实际讲授的节点');
    expect(nodes[1]!.content).toBe(reasoning.contentParts[0]!.text);
  });

  it('retains previously taught case and entry addresses across sections without assigning that knowledge to the new page', async () => {
    const current = fixtureInput();
    const firstPoint = current.knowledgePoints[0]!;
    current.knowledgePoints = [firstPoint, { ...structuredClone(firstPoint), id: 'kp2', name: '关系比较',
      authoring: { ...structuredClone(firstPoint.authoring!), examples: [],
        learningTasks: [{ claimIds: ['relationship'], operation: 'compare' }] } }];
    current.sectionPlans = [{ title: '建立标识关系', knowledgePointIds: ['kp'] }, { title: '比较关系', knowledgePointIds: ['kp2'] }];
    const raw = fixtureRaw();
    const section = structuredClone(raw.sections[0]!);
    section.title = '比较关系';
    section.units = [{ ...section.units[0]!, id: 'u2', title: '关系比较', knowledgePointIds: ['kp2'], examplePlan: [] }];
    const node: RawNode = { id: 'compare', unitId: 'u2', kind: 'relation', knowledgePointIds: ['kp2'],
      prerequisiteNodeIds: ['example'], provenance: 'derived', quoteRefs: [], contentParts: [{ id: 'comparison',
        text: '只调用此前给定箭头这一事实，比较当前约定中的方向对应。', contribution: { kind: 'case-analysis',
          caseRef: { nodeId: 'example' }, claimRefs: [{ knowledgePointId: 'kp2', claimId: 'relationship' }] } }] };
    section.pages = [{ ...section.pages[0]!, id: 'later-page', explanationNodes: [node],
      presentationItems: [{ text: '在已给条件中比较方向对应', nodeIds: ['compare'], role: 'comparison' }],
      entryPoint: { kind: 'continuation', object: '此前已建立的标识事实', bridge: '比较给定关系',
        basis: { claimRefs: [claimRef], exampleRefs: [exampleRef], prerequisiteNodeIds: ['example'] } } }];
    section.understandingCriteria.basis = [{ id: 'compare', operation: 'compare', answerRelation: 'conditional-application',
      claimRefs: [{ knowledgePointId: 'kp2', claimId: 'relationship' }], nodeIds: ['compare'] }];
    raw.sections.push(section);
    const blueprint = await generateTeachingBlueprint(current, vi.fn().mockResolvedValue(JSON.stringify(raw)));
    const oldCase = blueprint.sections[0]!.units[0]!.explanationNodes![1]!;
    const later = blueprint.sections[1]!.pages[0]!;
    expect(later.knowledgePointIds).toEqual(['kp2']);
    expect(later.entryPoint!.basis).toEqual({ claimRefs: [claimRef], exampleRefs: [exampleRef], prerequisiteNodeIds: [oldCase.id] });
    expect(blueprint.sections[1]!.units[0]!.explanationNodes![0]!.contentContributions![0]!.contribution).toMatchObject({
      kind: 'case-analysis', caseRef: { nodeId: oldCase.id } });
    const outline = teachingBlueprintToOutlines(blueprint, '中文').find((item) => item.id === later.id)!;
    expect(outline.knowledgePointIds).toEqual(['kp2']);
    expect(outline.teachingBrief!.authoring!.nodes).toHaveLength(1);
    expect(outline.teachingBrief!.authoring!.examplePlans).toEqual([]);
  });

  it('records absent addresses on a new first draft without filling, retrying, blocking or imposing a time limit', async () => {
    const raw = fixtureRaw(false);
    const ai = vi.fn().mockResolvedValue(JSON.stringify(raw));
    const blueprint = await generateTeachingBlueprint(fixtureInput(), ai);
    expect(ai).toHaveBeenCalledTimes(1);
    const node = blueprint.sections[0]!.units[0]!.explanationNodes![0]!;
    expect(node.content).toBe(raw.sections[0]!.pages[0]!.explanationNodes[0]!.contentParts.map((part) => part.text).join(' '));
    expect(node.contentContributions).toEqual([]);
    expect(blueprint.sections[0]!.pages[0]!.entryPoint!.basis).toEqual({});
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('正文片段未选择有效贡献类型');
    expect(blueprint.qualityDiagnostics!.join('\n')).toContain('页面入口未记录实际事实依据');
    expect(blueprint.budget.totalDurationSec).toBe(300);
    expect(teachingBlueprintToOutlines(blueprint, '中文').filter((item) => item.type === 'slide')).toHaveLength(3);
  });

  it('keeps old saved raw and completed contracts unchanged instead of adding empty contribution or entry defaults', async () => {
    const oldInput = fixtureInput(false);
    const raw = fixtureRaw(false);
    raw.sections[0]!.pages[1]!.explanationNodes[0]!.claimRefs = [{ knowledgePointId: 'kp', claimId: 'relationship' }];
    raw.sections[0]!.pages[2]!.explanationNodes[0]!.claimRefs = [{ knowledgePointId: 'kp', claimId: 'relationship' }];
    const old = await generateTeachingBlueprint(oldInput, vi.fn().mockResolvedValue(JSON.stringify(raw)));
    const sectionsHash = fingerprintGenerationValue(old.sections);
    const ai = vi.fn();
    const restored = await generateTeachingBlueprint(fixtureInput(), ai, { repairFrom: { candidate: raw, issues: [] } });
    expect(ai).not.toHaveBeenCalled();
    expect(restored.sections).toEqual(old.sections);
    expect(restored.sections[0]!.units[0]!.explanationNodes![0]!).not.toHaveProperty('contentContributions');
    expect(restored.sections[0]!.pages[0]!.entryPoint).not.toHaveProperty('basis');
    const completed = revalidateStoredTeachingBlueprint(old, fixtureInput(), { qualityMode: 'diagnostic' }).blueprint!;
    expect(fingerprintGenerationValue(completed.sections)).toBe(sectionsHash);
  });

  it('replays stored contribution ranges with diagnostics for invalid spans and never alters the saved body', async () => {
    const current = fixtureInput();
    const blueprint = await generateTeachingBlueprint(current, vi.fn().mockResolvedValue(JSON.stringify(fixtureRaw())));
    const node = blueprint.sections[0]!.units[0]!.explanationNodes![0]!;
    const original = node.content;
    node.contentContributions!.push({ partId: 'bad-range', start: node.content.length + 1, end: node.content.length + 5,
      contribution: { kind: 'source-statement', claimRef } });
    const replayed = validateTeachingBlueprintDraft(blueprint, current, { qualityMode: 'diagnostic' });
    expect(replayed.blueprint!.sections[0]!.units[0]!.explanationNodes![0]!.content).toBe(original);
    expect(replayed.blueprint!.sections[0]!.units[0]!.explanationNodes![0]!.contentContributions).toHaveLength(2);
    expect(replayed.issues.join('\n')).toContain('已保存贡献位置未指向实际正文');
  });

  it('keeps a measured V30 page and its fingerprint through revalidation, saved-stage restoration and teacher confirmation', async () => {
    const oldInput = fixtureInput(false);
    const raw = fixtureRaw(false);
    raw.sections[0]!.pages[1]!.explanationNodes[0]!.claimRefs = [{ knowledgePointId: 'kp', claimId: 'relationship' }];
    raw.sections[0]!.pages[2]!.explanationNodes[0]!.claimRefs = [{ knowledgePointId: 'kp', claimId: 'relationship' }];
    const blueprint = await generateTeachingBlueprint(oldInput, vi.fn().mockResolvedValue(JSON.stringify(raw)));
    const originalOutlines = teachingBlueprintToOutlines(blueprint, '中文');
    const previousVersion = 'teaching-blueprint-v5-compiled-v30-reference-capabilities-and-eligible-quotes';
    for (const page of blueprint.sections[0]!.pages) {
      const outline = originalOutlines.find((item) => item.id === page.id)!;
      page.sectionPlanVersion = 'measured-section-v2';
      page.sourcePageIds = [page.id];
      page.plannedTiming = structuredClone(outline.plannedTiming!);
      page.targetDurationSec = outline.targetDurationSec;
      page.teachingBrief = { ...structuredClone(outline.teachingBrief!), designVersion: previousVersion };
    }
    const acceptedOutlines = teachingBlueprintToOutlines(blueprint, '中文');
    const original = structuredClone(blueprint.sections);
    const before = acceptedOutlines.filter((item) => item.type === 'slide').map(fingerprintSceneOutline);
    expect(acceptedOutlines[0]!.teachingBrief!.designVersion).toBe(previousVersion);
    const completed = revalidateStoredTeachingBlueprint(blueprint, fixtureInput(), { qualityMode: 'diagnostic' }).blueprint!;
    expect(completed.sections).toEqual(original);
    const ai = vi.fn();
    const resumed = await generateTeachingBlueprint(fixtureInput(), ai, { repairFrom: {
      candidate: blueprint, issues: [], preserveAcceptedPagePlans: true,
    } });
    expect(ai).not.toHaveBeenCalled();
    expect(resumed.sections[0]!.pages.map((page) => page.teachingBrief)).toEqual(original[0]!.pages.map((page) => page.teachingBrief));
    expect(teachingBlueprintToOutlines(resumed, '中文').filter((item) => item.type === 'slide').map(fingerprintSceneOutline)).toEqual(before);
    const confirmed = applyReviewedOutlinesToTeachingBlueprint(completed, acceptedOutlines);
    expect(teachingBlueprintToOutlines(confirmed, '中文').filter((item) => item.type === 'slide').map(fingerprintSceneOutline)).toEqual(before);
    confirmed.sections[0]!.pages[0]!.presentationItems![0]!.text = '教师独立调整的可见展示命题';
    const changed = teachingBlueprintToOutlines(confirmed, '中文')[0]!.teachingBrief!;
    expect(changed.designVersion).toBe(TEACHING_BLUEPRINT_COMPILED_BRIEF_VERSION);
    expect(changed.explanation).toBe(original[0]!.pages[0]!.teachingBrief!.explanation);
    expect(changed.teachingPlan!.presentationContent).toEqual(['教师独立调整的可见展示命题']);
  });
});
