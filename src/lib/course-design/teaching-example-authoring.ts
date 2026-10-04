import type { TeachingBlueprintSection, TeachingExamplePlan, TeachingExplanationNode, TeachingFactBasis } from '@/lib/session/types';
import { normalizeAuthoringSourceBindings, type AuthoringClaimRef, type AuthoringExampleRef,
  type KnowledgeAuthoring } from './knowledge-authoring';
import type { TeachingAnswerRelation, TeachingBrief, TeachingUnderstandingCriteria } from '@/lib/course-quality-review/types';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';

type KnowledgeInputs = Record<string, KnowledgeAuthoring>;
const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const list = (value: unknown) => Array.isArray(value) ? [...new Set(value.map(text).filter(Boolean))] : [];
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
const refKey = (ref: AuthoringClaimRef) => JSON.stringify([ref.knowledgePointId, ref.claimId]);
const ANSWER_RELATIONS = new Set<TeachingAnswerRelation>([
  'source-statement', 'conditional-application', 'comparative-fit', 'insufficient-evidence',
]);

export function normalizeTeachingClaimRefs(raw: unknown, pointIds: readonly string[], knowledge: KnowledgeInputs,
  onDiagnostic?: (message: string) => void): AuthoringClaimRef[] {
  const refs = (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const item = record(value);
    const knowledgePointId = text(item.knowledgePointId), claimId = text(item.claimId);
    if (!pointIds.includes(knowledgePointId) || !knowledge[knowledgePointId]?.claims.some((claim) => claim.id === claimId)) {
      onDiagnostic?.(`陈述引用 ${knowledgePointId}/${claimId} 不存在或不属于当前解释范围`);
      return [];
    }
    return [{ knowledgePointId, claimId }];
  });
  return [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
}

/** A quotation duty identifies a real unchanged passage, not every cited explanation. */
export function normalizeTeachingQuoteDuties(raw: unknown, pointIds: readonly string[], knowledge: KnowledgeInputs,
  evidence: CourseEvidenceSnapshot | undefined, allowedEvidenceIds: readonly string[],
  onDiagnostic?: (message: string) => void): NonNullable<TeachingExplanationNode['quoteDuties']> {
  const duties = (Array.isArray(raw) ? raw : []).flatMap((value) => {
    const item = record(value);
    const source = normalizeAuthoringSourceBindings([item.source], evidence, allowedEvidenceIds)[0];
    if (!source?.quote) {
      onDiagnostic?.('首次引句职责未绑定当前知识点的真实原文片段');
      return [];
    }
    // Source binding already verifies the exact passage against immutable,
    // position-ordered blocks. A second raw-array join would reject a valid
    // cross-paragraph passage when retrieval returned those blocks out of order.
    const claimRef = item.claimRef === undefined ? undefined
      : normalizeTeachingClaimRefs([item.claimRef], pointIds, knowledge, onDiagnostic)[0];
    if (item.claimRef !== undefined && !claimRef) return [];
    return [{ source, ...(claimRef ? { claimRef } : {}) }];
  });
  return [...new Map(duties.map((duty) => [teachingQuoteDutyKey('', duty), duty])).values()];
}

export function teachingQuoteDutyKey(nodeId: string, duty: NonNullable<TeachingExplanationNode['quoteDuties']>[number]): string {
  return JSON.stringify([nodeId, duty.claimRef?.knowledgePointId, duty.claimRef?.claimId,
    duty.source.evidenceItemId, duty.source.sourceBlockIds, duty.source.quote]);
}

/** Bind capability goals to actually taught statements and cases, never to answer labels. */
export function normalizeUnderstandingBasis(raw: unknown, options: {
  /** Legacy drafts bind a separately authored goal list; new drafts author goals here once. */
  goals?: readonly string[];
  pointIds: readonly string[];
  knowledge: KnowledgeInputs;
  nodes: readonly TeachingExplanationNode[];
  resolveNodeId?: (id: string) => string | undefined;
  onDiagnostic?: (message: string) => void;
}): NonNullable<TeachingUnderstandingCriteria['basis']> {
  const available = new Map(options.nodes.map((node) => [node.id, node]));
  const ids = new Set<string>();
  const basis = (Array.isArray(raw) ? raw : []).flatMap((value, index) => {
    const item = record(value), goal = text(item.goal);
    if (!goal) {
      options.onDiagnostic?.(`理解依据 ${text(item.id) || index + 1} 缺少可观察的能力目标`);
      return [];
    }
    if (options.goals && !options.goals.includes(goal)) {
      options.onDiagnostic?.(`理解依据 ${text(item.id) || index + 1} 未绑定本节的能力目标`);
      return [];
    }
    const requestedNodes = list(item.nodeIds);
    const nodeIds = [...new Set(requestedNodes.flatMap((id) => {
      const actualId = options.resolveNodeId?.(id) ?? id;
      return available.has(actualId) ? [actualId] : [];
    }))];
    if (nodeIds.length !== requestedNodes.length) options.onDiagnostic?.(`理解目标“${goal}”引用了尚未实际讲授的解释节点`);
    const nodes = nodeIds.map((id) => available.get(id)!);
    const taughtRefs = new Set(nodes.flatMap((node) => node.claimRefs ?? []).map(refKey));
    const claimRefs = normalizeTeachingClaimRefs(item.claimRefs, options.pointIds, options.knowledge, options.onDiagnostic)
      .filter((ref) => {
        if (taughtRefs.has(refKey(ref))) return true;
        options.onDiagnostic?.(`理解目标“${goal}”的陈述 ${ref.knowledgePointId}/${ref.claimId} 未落实到实际解释节点`);
        return false;
      });
    const exampleRefs: AuthoringExampleRef[] = (Array.isArray(item.exampleRefs) ? item.exampleRefs : []).flatMap((value) => {
      const ref = record(value), knowledgePointId = text(ref.knowledgePointId), exampleId = text(ref.exampleId);
      const candidate = options.knowledge[knowledgePointId]?.examples.find((example) => example.id === exampleId);
      if (!options.pointIds.includes(knowledgePointId) || !candidate
        || !nodes.some((node) => node.exampleIds?.includes(exampleId) && node.knowledgePointIds?.includes(knowledgePointId))) {
        options.onDiagnostic?.(`理解目标“${goal}”的案例 ${knowledgePointId}/${exampleId} 未落实到实际解释节点`);
        return [];
      }
      return [{ knowledgePointId, exampleId }];
    });
    const conditions = new Set([
      ...claimRefs.flatMap((ref) => options.knowledge[ref.knowledgePointId]!.claims
        .find((claim) => claim.id === ref.claimId)?.logicalConditions ?? []),
      ...exampleRefs.flatMap((ref) => options.knowledge[ref.knowledgePointId]!.examples
        .find((example) => example.id === ref.exampleId)?.assumptions ?? []),
    ]);
    const requiredConditions = list(item.requiredConditions).filter((condition) => {
      if (conditions.has(condition)) return true;
      options.onDiagnostic?.(`理解目标“${goal}”的必要条件未绑定已教陈述或已采用案例：${condition}`);
      return false;
    });
    let id = text(item.id) || `understanding-basis-${index + 1}`;
    if (ids.has(id)) id = `${id}-${index + 1}`;
    ids.add(id);
    const answerRelation = typeof item.answerRelation === 'string'
      && ANSWER_RELATIONS.has(item.answerRelation as TeachingAnswerRelation)
      ? item.answerRelation as TeachingAnswerRelation : undefined;
    if (item.answerRelation !== undefined && !answerRelation) {
      options.onDiagnostic?.(`理解目标“${goal}”的判断性质无效；保留事实依据，不补造判定关系`);
    }
    return [{ id, goal, claimRefs, nodeIds,
      ...(answerRelation ? { answerRelation } : {}),
      ...(item.exampleRefs !== undefined ? { exampleRefs: [...new Map(exampleRefs.map((ref) =>
        [JSON.stringify([ref.knowledgePointId, ref.exampleId]), ref])).values()] } : {}),
      ...(item.requiredConditions !== undefined ? { requiredConditions } : {}),
    }];
  });
  if (raw !== undefined) for (const goal of options.goals ?? []) {
    if (!basis.some((item) => item.goal === goal)) options.onDiagnostic?.(`理解目标“${goal}”未记录首次讲授的事实与条件依据`);
  }
  return basis;
}

/** Compile decisions, never invent a case or claim that its prose was taught. */
export function normalizeTeachingExamplePlans(raw: unknown, pointIds: readonly string[], knowledge: KnowledgeInputs): TeachingExamplePlan[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object') return [];
    const item = value as Record<string, unknown>;
    const knowledgePointId = text(item.knowledgePointId);
    const mode = item.mode;
    if (!pointIds.includes(knowledgePointId) || seen.has(knowledgePointId)
      || !['textbook', 'constructed', 'none', 'source-gap'].includes(String(mode))) return [];
    seen.add(knowledgePointId);
    const allowed = new Set(knowledge[knowledgePointId]?.examples.map((example) => example.id));
    const selectedExampleIds = Array.isArray(item.selectedExampleIds)
      ? [...new Set(item.selectedExampleIds.map(text).filter((id) => allowed.has(id)))] : [];
    const form = item.form;
    return [{ knowledgePointId, mode: mode as TeachingExamplePlan['mode'], selectedExampleIds,
      rationale: text(item.rationale),
      ...(form === 'everyday' || form === 'domain' || form === 'analogy' ? { form } : {}) }];
  });
}

/** Coverage checks are advisory; actual explanation quality is not string matching. */
export function teachingExampleDiagnostics(sections: readonly TeachingBlueprintSection[], knowledge: KnowledgeInputs): string[] {
  const issues: string[] = [];
  const decisions = new Map<string, { plans: TeachingExamplePlan[]; nodes: TeachingExplanationNode[] }>();
  for (const section of sections) for (const unit of section.units) {
    const executed = new Set(section.pages.flatMap((page) => [
      ...(page.introducesNodeIds ?? []), ...(page.deepensNodeIds ?? []),
    ]));
    const nodes = unit.explanationNodes?.filter((node) => executed.has(node.id)) ?? [];
    for (const pointId of unit.knowledgePointIds) {
      const input = knowledge[pointId];
      if (!input) continue; // Saved historical courses have no new decision contract.
      const plan = unit.examplePlan?.find((item) => item.knowledgePointId === pointId);
      const pointNodes = nodes.filter((node) => node.knowledgePointIds?.includes(pointId));
      const decision = decisions.get(pointId) ?? { plans: [], nodes: [] };
      decision.nodes.push(...pointNodes);
      decisions.set(pointId, decision);
      if (!plan) { issues.push(`知识点 ${pointId} 未记录首次生成的案例选择`); continue; }
      decision.plans.push(plan);
      if (!plan.rationale) issues.push(`知识点 ${pointId} 未说明案例选择的教学作用`);
      if (plan.mode === 'constructed' && !pointNodes.some((node) => node.kind === 'example')) {
        issues.push(`知识点 ${pointId} 决定自编案例，但未写入实际案例分析`);
      }
    }
  }
  for (const [pointId, { plans, nodes }] of decisions) {
    const input = knowledge[pointId]!;
    const sourceExamples = input.examples.filter((example) => example.kind === 'textbook');
    const books = new Set(sourceExamples.flatMap((example) => example.sources.map((source) => source.textbookId)).filter(Boolean));
    const used = new Set(nodes.filter((node) => node.kind === 'example').flatMap((node) => node.exampleIds ?? []));
    const selected = new Set(plans.flatMap((plan) => plan.selectedExampleIds));
    const required = books.size === 1 ? sourceExamples.map((example) => example.id) : [...selected];
    if (sourceExamples.length && !plans.some((plan) => plan.mode === 'textbook' || plan.mode === 'source-gap')) {
      issues.push(`知识点 ${pointId} 已有教材案例，不能声明无需案例或以自编案例替代`);
    }
    if (sourceExamples.length && !sourceExamples.some((example) => selected.has(example.id))) {
      issues.push(`知识点 ${pointId} 未采用可用教材案例`);
    }
    for (const id of new Set([...required, ...selected])) {
      if (!selected.has(id)) issues.push(`知识点 ${pointId} 未保留单本教材案例 ${id}`);
      if (!used.has(id)) issues.push(`知识点 ${pointId} 的案例 ${id} 未进入实际讲授节点`);
    }
    if (plans.length && plans.every((plan) => plan.mode === 'none')
      && input.exampleCoverage.some((coverage) => coverage.status === 'partial')) {
      issues.push(`知识点 ${pointId} 教材案例来源尚不完整，不能认定教材没有案例`);
    }
  }
  return [...new Set(issues)];
}

/** Carry only requested prior facts and their local dependencies, not prior teaching duties. */
function basisKnowledgeClosure(knowledge: KnowledgeInputs | undefined, pointIds: ReadonlySet<string>,
  basis: TeachingUnderstandingCriteria['basis'], basisNodes: readonly TeachingExplanationNode[], facts?: TeachingFactBasis) {
  const requested = new Map<string, { claims: Set<string>; examples: Set<string> }>();
  const selection = (knowledgePointId: string) => {
    const selected = requested.get(knowledgePointId) ?? { claims: new Set<string>(), examples: new Set<string>() };
    requested.set(knowledgePointId, selected);
    return selected;
  };
  const addClaim = (ref: AuthoringClaimRef) => {
    if (pointIds.has(ref.knowledgePointId)) return;
    const claim = knowledge?.[ref.knowledgePointId]?.claims.find((item) => item.id === ref.claimId);
    const selected = selection(ref.knowledgePointId);
    if (!claim || selected.claims.has(claim.id)) return;
    selected.claims.add(claim.id);
    for (const claimId of claim.basisClaimIds ?? []) addClaim({ ...ref, claimId });
  };
  const addExample = (ref: AuthoringExampleRef) => {
    if (pointIds.has(ref.knowledgePointId)) return;
    const example = knowledge?.[ref.knowledgePointId]?.examples.find((item) => item.id === ref.exampleId);
    const selected = selection(ref.knowledgePointId);
    if (!example || selected.examples.has(example.id)) return;
    selected.examples.add(example.id);
    for (const claimId of new Set([...(example.claimIds ?? []),
      ...(example.correspondences ?? []).map((mapping) => mapping.claimId)])) {
      addClaim({ knowledgePointId: ref.knowledgePointId, claimId });
    }
  };
  for (const item of basis ?? []) {
    item.claimRefs.forEach(addClaim);
    item.exampleRefs?.forEach(addExample);
  }
  facts?.claimRefs?.forEach(addClaim);
  facts?.exampleRefs?.forEach(addExample);
  for (const node of basisNodes) {
    node.claimRefs?.forEach(addClaim);
    for (const knowledgePointId of node.knowledgePointIds ?? []) for (const exampleId of node.exampleIds ?? []) {
      addExample({ knowledgePointId, exampleId });
    }
  }
  const current = [...pointIds].flatMap((knowledgePointId) => knowledge?.[knowledgePointId]
    ? [{ knowledgePointId, authoring: knowledge[knowledgePointId]! }] : []);
  const previous = [...requested].flatMap(([knowledgePointId, selected]) => {
    const authoring = knowledge?.[knowledgePointId];
    if (!authoring || (!selected.claims.size && !selected.examples.size)) return [];
    return [{ knowledgePointId, authoring: { ...authoring,
      claims: authoring.claims.filter((claim) => selected.claims.has(claim.id)),
      examples: authoring.examples.filter((example) => selected.examples.has(example.id)),
    } }];
  });
  return [...current, ...previous];
}

/** Addresses already authored at the teaching location; no new claim body or
 * second explanation is derived from these planning references. */
export function teachingFactBasis(nodes: readonly TeachingExplanationNode[], entry?: TeachingFactBasis): TeachingFactBasis {
  const claimRefs = [...(entry?.claimRefs ?? [])];
  const exampleRefs = [...(entry?.exampleRefs ?? [])];
  const prerequisiteNodeIds = [...(entry?.prerequisiteNodeIds ?? [])];
  for (const node of nodes) {
    prerequisiteNodeIds.push(...node.prerequisiteNodeIds);
    for (const { contribution } of node.contentContributions ?? []) {
      if (contribution.kind === 'source-statement' || contribution.kind === 'clarify-term') claimRefs.push(contribution.claimRef);
      if (contribution.kind === 'reasoning' || contribution.kind === 'case-analysis') claimRefs.push(...contribution.claimRefs);
      if (contribution.kind === 'reasoning') prerequisiteNodeIds.push(...(contribution.prerequisiteNodeIds ?? []));
      if (contribution.kind === 'case-facts' || contribution.kind === 'case-analysis') {
        if ('knowledgePointId' in contribution.caseRef) exampleRefs.push(contribution.caseRef);
        else prerequisiteNodeIds.push(contribution.caseRef.nodeId);
      }
    }
  }
  return {
    claimRefs: [...new Map(claimRefs.map((ref) => [JSON.stringify(ref), ref])).values()],
    exampleRefs: [...new Map(exampleRefs.map((ref) => [JSON.stringify(ref), ref])).values()],
    prerequisiteNodeIds: [...new Set(prerequisiteNodeIds)],
  };
}

/** A prior projection may be a subset of the same point's complete current catalog. */
function mergeAuthoringKnowledge(items: Array<{ knowledgePointId: string; authoring: KnowledgeAuthoring }>): KnowledgeInputs {
  const merged: KnowledgeInputs = {};
  for (const { knowledgePointId, authoring } of items) {
    const previous = merged[knowledgePointId];
    merged[knowledgePointId] = previous ? { ...previous, ...authoring,
      claims: [...new Map([...previous.claims, ...authoring.claims].map((claim) => [claim.id, claim])).values()],
      examples: [...new Map([...previous.examples, ...authoring.examples].map((example) => [example.id, example])).values()],
      exampleCoverage: [...new Map([...previous.exampleCoverage, ...authoring.exampleCoverage]
        .map((coverage) => [JSON.stringify([coverage.textbookId, coverage.revisionId]), coverage])).values()],
      ...(previous.diagnostics || authoring.diagnostics
        ? { diagnostics: [...new Set([...(previous.diagnostics ?? []), ...(authoring.diagnostics ?? [])])] } : {}),
    } : authoring;
  }
  return merged;
}

export function pageAuthoringContext(units: TeachingBlueprintSection['units'], nodes: TeachingExplanationNode[],
  knowledge: KnowledgeInputs | undefined, pointIds: readonly string[],
  basis?: TeachingUnderstandingCriteria['basis'], priorNodes: readonly TeachingExplanationNode[] = [], entryBasis?: TeachingFactBasis) {
  const fresh = Boolean(entryBasis || nodes.some((node) => node.contentContributions !== undefined)
    || pointIds.some((id) => knowledge?.[id]?.readingContract === 'source-blocks-v1'));
  const facts = fresh ? teachingFactBasis(nodes, entryBasis) : undefined;
  const basisNodeIds = new Set(basis?.flatMap((item) => item.nodeIds) ?? []);
  facts?.prerequisiteNodeIds?.forEach((id) => basisNodeIds.add(id));
  const ownedIds = new Set(nodes.map((node) => node.id));
  const basisNodes = priorNodes.filter((node) => basisNodeIds.has(node.id) && !ownedIds.has(node.id))
    .map((node) => ({ ...node, quoteDuties: [] }));
  if (!knowledge && !units.some((unit) => unit.examplePlan !== undefined) && !basisNodes.length
    && !nodes.some((node) => node.sourceBindings !== undefined || node.exampleIds !== undefined
      || node.claimRefs !== undefined || node.quoteDuties !== undefined)) return undefined;
  const ids = new Set(pointIds);
  return { nodes, examplePlans: units.flatMap((unit) => unit.examplePlan ?? []).filter((plan) => ids.has(plan.knowledgePointId)),
    knowledge: basisKnowledgeClosure(knowledge, ids, basis, basisNodes, facts),
    ...(basisNodes.length ? { basisNodes } : {}) };
}

/** Move metadata with the same measured node ownership; do not change layout or timing. */
export function redistributePageAuthoring(briefs: readonly (TeachingBrief | undefined)[], nodeIds: ReadonlySet<string>,
  pointIds: readonly string[], localContent: (id: string) => string,
  options?: { quoteDutyKeys?: ReadonlySet<string> }): TeachingBrief['authoring'] {
  const contexts = briefs.flatMap((brief) => brief?.authoring ? [brief.authoring] : []);
  if (!contexts.length) return undefined;
  const diagnostics = [...new Set(contexts.flatMap((context) => context.diagnostics ?? []))];
  const nodes = [...new Map(contexts.flatMap((context) => context.nodes)
    .filter((node) => nodeIds.has(node.id)).map((node) => {
      const content = localContent(node.id) || node.content;
      let contentContributions = node.contentContributions;
      if (content !== node.content && contentContributions) {
        let after = 0;
        contentContributions = contentContributions.flatMap((part) => {
          const text = node.content.slice(part.start, part.end);
          const start = text ? content.indexOf(text, after) : -1;
          if (start < 0) {
            diagnostics.push(`解释节点 ${node.id} 的片段 ${part.partId} 未完整进入当前拆页正文，保留正文与依据但不声明原片段地址覆盖`);
            return [];
          }
          after = start + text.length;
          return [{ ...part, start, end: after }];
        });
      }
      return [node.id,
      { ...node, content,
        ...(contentContributions !== undefined ? { contentContributions } : {}),
        ...(node.quoteDuties !== undefined && options?.quoteDutyKeys ? {
          quoteDuties: node.quoteDuties.filter((duty) => options.quoteDutyKeys!.has(teachingQuoteDutyKey(node.id, duty))),
        } : {}) }] as const;
    })).values()];
  const ids = new Set(pointIds);
  const basis = briefs.flatMap((brief) => brief?.understandingCriteria?.basis ?? []);
  const knowledge = mergeAuthoringKnowledge(contexts.flatMap((context) => context.knowledge));
  const fresh = nodes.some((node) => node.contentContributions !== undefined)
    || pointIds.some((id) => knowledge[id]?.readingContract === 'source-blocks-v1');
  const entries = fresh ? briefs.flatMap((brief) => brief?.teachingPlan?.entryPoint?.basis ?? []) : [];
  const entry = entries.length ? {
    claimRefs: entries.flatMap((item) => item.claimRefs ?? []),
    exampleRefs: entries.flatMap((item) => item.exampleRefs ?? []),
    prerequisiteNodeIds: entries.flatMap((item) => item.prerequisiteNodeIds ?? []),
  } : undefined;
  const facts = fresh ? teachingFactBasis(nodes, entry) : undefined;
  const basisNodeIds = new Set(basis.flatMap((item) => item.nodeIds));
  facts?.prerequisiteNodeIds?.forEach((id) => basisNodeIds.add(id));
  const basisNodes = [...new Map(contexts.flatMap((context) => context.basisNodes ?? [])
    .filter((node) => basisNodeIds.has(node.id)).map((node) => [node.id, { ...node, quoteDuties: [] }])).values()];
  return { nodes,
    examplePlans: [...new Map(contexts.flatMap((context) => context.examplePlans)
      .filter((plan) => ids.has(plan.knowledgePointId)).map((plan) => [plan.knowledgePointId, plan])).values()],
    knowledge: basisKnowledgeClosure(knowledge, ids, basis, basisNodes, facts),
    ...(basisNodes.length ? { basisNodes } : {}),
    ...(diagnostics.length ? { diagnostics: [...new Set(diagnostics)] } : {}) };
}
