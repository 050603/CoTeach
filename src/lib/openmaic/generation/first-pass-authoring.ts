import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { AuthoringClaimRef, AuthoringExampleRef, KnowledgeAuthoring } from '@/lib/course-design/knowledge-authoring';
import type { KnowledgePoint } from '@/lib/session/types';
import { teachingFactBasis } from '@/lib/course-design/teaching-example-authoring';

type Authoring = NonNullable<NonNullable<SceneOutline['teachingBrief']>['authoring']>;
export type TeachingAuthoringKnowledgePoint = Pick<KnowledgePoint, 'id' | 'authoring'>;

/** Canonical knowledge and page projections share one authoring contract. A
 * smaller saved projection cannot downgrade a freshly supplied source catalog. */
export function hasSourceBoundTeachingAuthoring(outline: SceneOutline,
  knowledge: readonly TeachingAuthoringKnowledgePoint[] = []): boolean {
  const authoring = outline.teachingBrief?.authoring;
  if (!authoring) return false;
  if (authoring.nodes.some((node) => node.contentContributions !== undefined)
    || outline.teachingBrief?.teachingPlan?.entryPoint?.basis !== undefined
    || authoring.knowledge.some((point) => point.authoring.readingContract === 'source-blocks-v1')) return true;
  const pointIds = new Set([
    ...(outline.knowledgePointIds ?? []),
    ...authoring.knowledge.map((point) => point.knowledgePointId),
    ...authoring.nodes.flatMap((node) => node.knowledgePointIds ?? []),
  ]);
  return knowledge.some((point) => pointIds.has(point.id) && point.authoring?.readingContract === 'source-blocks-v1');
}

export function authoringCaseUsesFacts(example: KnowledgeAuthoring['examples'][number]): boolean {
  const structured = Boolean(example.objectAndTask && example.assumptions && example.actions && example.outcome);
  return example.kind === 'textbook' || !structured
    || Boolean(example.correspondences?.some((mapping) => mapping.caseElement.field === 'facts'));
}

function caseScenario(example: KnowledgeAuthoring['examples'][number]): string {
  return JSON.stringify([example.id, example.kind, example.sources, example.objectAndTask,
    example.assumptions, example.actions, example.outcome, example.form, example.limitations]);
}

/** The generated explanation has one body. Compatibility projections belong
 * in stored briefs, not alongside that body in a first authoring request. */
export function buildFirstPassTeachingInput(outlines: readonly SceneOutline[],
  sourceKnowledgePoints: readonly TeachingAuthoringKnowledgePoint[] = [],
  compatibility: { legacyCasePlanningMetadata?: boolean } = {}) {
  const texts: Record<string, string> = {};
  const textIds = new Map<string, string>();
  const intern = (text: string) => {
    const previous = textIds.get(text);
    if (previous) return previous;
    const id = `body-${textIds.size + 1}`;
    textIds.set(text, id);
    texts[id] = text;
    return id;
  };
  const knowledge = new Map<string, KnowledgeAuthoring>();
  const mergeKnowledge = (knowledgePointId: string, incoming: KnowledgeAuthoring) => {
    const existing = knowledge.get(knowledgePointId);
    if (!existing) { knowledge.set(knowledgePointId, incoming); return; }
    // Page projections may carry a smaller basis closure for the same point.
    // They cannot overwrite the canonical evidence needed by an earlier page.
    knowledge.set(knowledgePointId, { ...existing,
      ...((existing.readingContract ?? incoming.readingContract)
        ? { readingContract: existing.readingContract ?? incoming.readingContract } : {}),
      claims: [...new Map([...incoming.claims, ...existing.claims].map((claim) => [claim.id, claim])).values()],
      examples: [...new Map([...incoming.examples, ...existing.examples].map((example) => [example.id, example])).values()],
      exampleCoverage: [...new Map([...existing.exampleCoverage, ...incoming.exampleCoverage]
        .map((coverage) => [JSON.stringify(coverage), coverage])).values()],
      ...((existing.diagnostics?.length || incoming.diagnostics?.length)
        ? { diagnostics: [...new Set([...(existing.diagnostics ?? []), ...(incoming.diagnostics ?? [])])] } : {}),
    });
  };
  for (const point of sourceKnowledgePoints) if (point.authoring) mergeKnowledge(point.id, point.authoring);
  const localKnowledgeIds = new Set<string>();
  for (const outline of outlines) for (const point of outline.teachingBrief?.authoring?.knowledge ?? []) {
    mergeKnowledge(point.knowledgePointId, point.authoring);
    localKnowledgeIds.add(point.knowledgePointId);
  }
  // Earlier sections may supply a bound prerequisite. They are an accuracy
  // context, not additional teaching scope or a second narration body.
  const requiredClaims = new Map<string, AuthoringClaimRef>();
  const unavailableClaims = new Map<string, AuthoringClaimRef>();
  const addClaim = (ref: AuthoringClaimRef) => {
    const key = `${ref.knowledgePointId}:${ref.claimId}`;
    if (requiredClaims.has(key)) return;
    const claim = knowledge.get(ref.knowledgePointId)?.claims.find((item) => item.id === ref.claimId);
    if (!claim) { unavailableClaims.set(key, ref); return; }
    requiredClaims.set(key, ref);
    for (const claimId of claim.basisClaimIds ?? []) addClaim({ ...ref, claimId });
  };
  const nodes: Array<Omit<Authoring['nodes'][number], 'content'> & { bodyRef: string; nodeRef: string }> = [];
  const basisNodes: Array<Omit<Authoring['nodes'][number], 'content'> & { bodyRef: string }> = [];
  const basisNodeKeys = new Set<string>();
  let explicitClaimRefs = false;
  const nodeRefs = new Map<string, string>();
  const caseKeys = new Map<string, string>();
  const cases = new Map<string, {
    caseRef: string; knowledgePointId: string; exampleId: string; kind: 'textbook' | 'constructed';
    title?: string; purpose?: string; factsRefs?: string[]; objectAndTaskRef?: string;
    assumptionsRefs?: string[]; actionsRefs?: string[]; outcomeRef?: string;
    correspondences?: Array<{ claimRef: AuthoringClaimRef; claimPhrase: string;
      caseElement: NonNullable<KnowledgeAuthoring['examples'][number]['correspondences']>[number]['caseElement'] }>;
    claimRefs: AuthoringClaimRef[]; sources: KnowledgeAuthoring['examples'][number]['sources'];
    form?: 'everyday' | 'domain' | 'analogy'; limitations?: string;
  }>();
  const introducedNodes = new Set<string>();
  const addCase = (ref: AuthoringExampleRef, localKnowledge?: KnowledgeAuthoring): string | undefined => {
    const example = (localKnowledge ?? knowledge.get(ref.knowledgePointId))?.examples.find((item) => item.id === ref.exampleId);
    if (!example) return;
    const scenario = caseScenario(example);
    const canonical = knowledge.get(ref.knowledgePointId)?.examples.find((candidate) => candidate.id === example.id);
    const usesFacts = authoringCaseUsesFacts(example)
      || Boolean(canonical && caseScenario(canonical) === scenario && authoringCaseUsesFacts(canonical));
    const caseKey = JSON.stringify([ref.knowledgePointId, scenario, usesFacts ? example.facts : undefined]);
    let caseRef = caseKeys.get(caseKey);
    if (!caseRef) {
      const baseRef = `${ref.knowledgePointId}:${example.id}`;
      caseRef = cases.has(baseRef) ? `${baseRef}@case-${cases.size + 1}` : baseRef;
      caseKeys.set(caseKey, caseRef);
    }
    const claimRefs = [...new Set([...(example.claimIds ?? []),
      ...(example.correspondences ?? []).map((mapping) => mapping.claimId)])]
      .map((claimId) => ({ knowledgePointId: ref.knowledgePointId, claimId }));
    explicitClaimRefs ||= example.claimIds !== undefined || example.correspondences !== undefined;
    claimRefs.forEach(addClaim);
    const correspondences = example.correspondences?.map(({ claimId, ...mapping }) => ({
      ...mapping, claimRef: { knowledgePointId: ref.knowledgePointId, claimId },
    }));
    const previous = cases.get(caseRef);
    cases.set(caseRef, { caseRef, knowledgePointId: ref.knowledgePointId, exampleId: example.id,
      kind: example.kind,
      // Generated labels and intended effects are not textbook event facts.
      // Only completed checkpoint identity reconstruction uses the old shape;
      // new authoring derives the teaching use from facts and owned nodes.
      ...(compatibility.legacyCasePlanningMetadata ? { title: example.title, purpose: example.purpose } : {}),
      // Book events remain exact. New hypothetical cases use their explicit
      // scenario fields rather than an old, unqualified facts projection.
      ...(usesFacts ? { factsRefs: example.facts.map(intern) } : {}),
      ...(example.objectAndTask ? { objectAndTaskRef: intern(example.objectAndTask) } : {}),
      ...(example.assumptions ? { assumptionsRefs: example.assumptions.map(intern) } : {}),
      ...(example.actions ? { actionsRefs: example.actions.map(intern) } : {}),
      ...(example.outcome ? { outcomeRef: intern(example.outcome) } : {}),
      ...(correspondences || previous?.correspondences ? { correspondences: [...new Map([...(previous?.correspondences ?? []), ...(correspondences ?? [])]
        .map((mapping) => [JSON.stringify(mapping), mapping])).values()] } : {}),
      claimRefs: [...new Map([...(previous?.claimRefs ?? []), ...claimRefs]
        .map((claim) => [JSON.stringify(claim), claim])).values()],
      sources: example.sources, ...(example.form ? { form: example.form } : {}),
      ...(example.limitations ? { limitations: example.limitations } : {}),
    });
    return caseRef;
  };
  const pages = new Map<string, {
    nodeDuties: Array<{ nodeId: string; nodeRef?: string; role: 'introduce' | 'deepen' | 'reference' }>;
    examplePlans: Authoring['examplePlans']; caseRefs: string[];
  }>();
  for (const outline of outlines) {
    const authoring = outline.teachingBrief?.authoring;
    if (!authoring) continue;
    for (const node of authoring.nodes) for (const id of node.knowledgePointIds ?? []) {
      if (knowledge.has(id)) localKnowledgeIds.add(id);
    }
    const plan = outline.teachingBrief?.teachingPlan;
    const criteria = outline.teachingBrief?.understandingCriteria;
    explicitClaimRefs ||= criteria?.basis !== undefined;
    const boundPriorIds = new Set(criteria?.basis?.flatMap((basis) => basis.nodeIds) ?? []);
    const fresh = hasSourceBoundTeachingAuthoring(outline, sourceKnowledgePoints);
    const facts = fresh ? teachingFactBasis(authoring.nodes, plan?.entryPoint?.basis) : undefined;
    facts?.prerequisiteNodeIds?.forEach((id) => boundPriorIds.add(id));
    facts?.claimRefs?.forEach(addClaim);
    for (const { content, ...node } of authoring.basisNodes ?? []) {
      if (!boundPriorIds.has(node.id)) continue;
      const key = JSON.stringify([node, content]);
      if (!basisNodeKeys.has(key)) {
        basisNodeKeys.add(key);
        // A prior source/analysis is available to determine what follows. Its
        // earlier quote duty cannot become a new speech responsibility.
        basisNodes.push({ ...node, quoteDuties: [], bodyRef: intern(content) });
      }
      explicitClaimRefs ||= node.claimRefs !== undefined;
      (node.claimRefs ?? []).forEach(addClaim);
    }
    const nodeDuties: Array<{ nodeId: string; nodeRef?: string; role: 'introduce' | 'deepen' | 'reference' }> = authoring.nodes.map(({ content, ...node }) => {
      const key = JSON.stringify([node, content]);
      let nodeRef = nodeRefs.get(key);
      if (!nodeRef) {
        nodeRef = `node-${nodeRefs.size + 1}`;
        nodeRefs.set(key, nodeRef);
        nodes.push({ ...node, nodeRef, bodyRef: intern(content) });
      }
      explicitClaimRefs ||= node.claimRefs !== undefined;
      for (const ref of node.claimRefs ?? []) addClaim(ref);
      for (const duty of node.quoteDuties ?? []) if (duty.claimRef) addClaim(duty.claimRef);
      const role = plan?.introduces?.includes(node.id) ? 'introduce'
        : plan?.deepens?.includes(node.id) ? 'deepen'
          : plan?.references?.includes(node.id) ? 'reference'
            : introducedNodes.has(node.id) ? 'deepen' : 'introduce';
      if (role !== 'reference') introducedNodes.add(node.id);
      return { nodeId: node.id, nodeRef, role } as const;
    });
    for (const nodeId of plan?.references ?? []) if (!nodeDuties.some((duty) => duty.nodeId === nodeId)) {
      nodeDuties.push({ nodeId, nodeRef: undefined, role: 'reference' });
    }
    const caseRefs: string[] = [];
    // An opening can reuse a taught case without assigning another telling.
    facts?.exampleRefs?.forEach((ref) => addCase(ref));
    for (const knowledgePointId of new Set(authoring.examplePlans.map((plan) => plan.knowledgePointId))) {
      const localKnowledge = authoring.knowledge.find((point) => point.knowledgePointId === knowledgePointId)?.authoring;
      const pointKnowledge = localKnowledge ?? knowledge.get(knowledgePointId);
      if (!pointKnowledge) continue;
      const selectedIds = new Set(authoring.examplePlans.filter((plan) => plan.knowledgePointId === knowledgePointId)
        .flatMap((plan) => plan.selectedExampleIds));
      for (const example of pointKnowledge.examples) {
        if (!selectedIds.has(example.id) || !authoring.nodes.some((node) =>
          node.knowledgePointIds?.includes(knowledgePointId) && node.exampleIds?.includes(example.id))) continue;
        const caseRef = addCase({ knowledgePointId, exampleId: example.id }, localKnowledge);
        if (caseRef) caseRefs.push(caseRef);
      }
    }
    for (const basis of criteria?.basis ?? []) {
      basis.claimRefs.forEach(addClaim);
      // A previously taught case can supply an assessment premise without
      // acquiring another first-telling duty on the current page.
      (basis.exampleRefs ?? []).forEach((ref) => addCase(ref));
    }
    pages.set(outline.id, { nodeDuties, examplePlans: authoring.examplePlans, caseRefs });
  }
  // Historical authoring-aware courses predate explicit claim references.
  // Keep their individual source identities and conditions, without restoring
  // duplicate generated summaries as a second lecture body.
  if (!explicitClaimRefs && !requiredClaims.size) for (const knowledgePointId of localKnowledgeIds) {
    const point = knowledge.get(knowledgePointId)!;
    point.claims.forEach((claim) => addClaim({ knowledgePointId, claimId: claim.id }));
  }
  const claims = [...requiredClaims.values()].map((ref) => {
    const authoring = knowledge.get(ref.knowledgePointId)!;
    const claim = authoring.claims.find((item) => item.id === ref.claimId)!;
    const { text, conditions: _legacyConditions, teachingScope, ...metadata } = claim;
    // Reference-based learning tasks already carry the new lesson's scope.
    // A generated interpretation of that scope is not another factual input.
    // Historical completed requests retain their original catalog shape.
    return { ...metadata,
      ...(authoring.readingContract !== 'source-blocks-v1' && teachingScope !== undefined ? { teachingScope } : {}),
      ...ref, statementRef: intern(text) };
  });
  return { catalog: { texts, explanationNodes: nodes, ...(basisNodes.length ? { basisNodes } : {}),
    statements: claims, cases: [...cases.values()],
    ...(unavailableClaims.size ? { unavailableClaimRefs: [...unavailableClaims.values()] } : {}) }, pages };
}

export function firstPassPagePlan(outline: SceneOutline) {
  const plan = outline.teachingBrief?.teachingPlan;
  if (!outline.teachingBrief?.authoring || !plan) return plan;
  return { purpose: plan.purpose, priorKnowledge: plan.priorKnowledge, learnerQuestion: plan.learnerQuestion,
    entryPoint: plan.entryPoint, taskConnection: plan.taskConnection,
    introduces: plan.introduces, deepens: plan.deepens, references: plan.references };
}

export function firstPassUnderstandingGoals(outline: SceneOutline) {
  const criteria = outline.teachingBrief?.understandingCriteria;
  if (!outline.teachingBrief?.authoring || !criteria) return criteria;
  if (criteria.goalSource === 'references') return {
    goalSource: criteria.goalSource,
    supportingUnitIds: criteria.supportingUnitIds,
    // Stored goal sentences are compatibility projections for existing views.
    // The new writing request receives the action and evidence addresses once;
    // a generated conclusion cannot become an independent answer authority.
    basis: criteria.basis?.map(({ goal: _compatibilityGoal, ...binding }) => binding),
  };
  return { goals: criteria.goals, supportingUnitIds: criteria.supportingUnitIds, basis: criteria.basis };
}

/** A quiz needs the taught scope, source statements and scenario premises. It
 * does not need another copy of the lecturer's generated answer prose. Keep
 * those explanations in the lecture input rather than promoting them into a
 * factual answer catalog. Original source passages are supplied independently. */
export function buildFirstPassAssessmentInput(outlines: readonly SceneOutline[],
  sourceKnowledgePoints: readonly TeachingAuthoringKnowledgePoint[] = []) {
  const { catalog } = buildFirstPassTeachingInput(outlines, sourceKnowledgePoints);
  const { texts, explanationNodes, basisNodes, ...evidence } = catalog;
  const usedTextRefs = new Set(evidence.statements.map((statement) => statement.statementRef));
  for (const scenario of evidence.cases) {
    for (const ref of [...(scenario.factsRefs ?? []), ...(scenario.assumptionsRefs ?? []),
      ...(scenario.actionsRefs ?? []), ...(scenario.objectAndTaskRef ? [scenario.objectAndTaskRef] : []),
      ...(scenario.outcomeRef ? [scenario.outcomeRef] : [])]) usedTextRefs.add(ref);
  }
  const taughtNodes = [...explanationNodes, ...(basisNodes ?? [])].map((node) => ({
    id: node.id, kind: node.kind, knowledgePointIds: node.knowledgePointIds,
    claimRefs: node.claimRefs, exampleIds: node.exampleIds, prerequisiteNodeIds: node.prerequisiteNodeIds,
  }));
  return { ...evidence, texts: Object.fromEntries(Object.entries(texts).filter(([ref]) => usedTextRefs.has(ref))),
    taughtNodes };
}
