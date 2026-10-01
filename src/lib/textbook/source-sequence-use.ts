import type { FigureSequenceContract } from './course-visual-binding';

export type SourceSequenceUse = {
  resourceId: string;
  coverage: 'complete' | 'selected';
  /** Original block identities, never a substitute for teaching their content. */
  sourceStepIds?: string[];
};

type SourceUsePage = {
  sourceSequenceUses?: readonly SourceSequenceUse[];
  teachingBrief?: { teachingPlan?: { sourceSequenceUses?: readonly SourceSequenceUse[] } };
};

export function pageSourceSequenceUses(page: SourceUsePage): readonly SourceSequenceUse[] {
  return page.teachingBrief?.teachingPlan?.sourceSequenceUses ?? page.sourceSequenceUses ?? [];
}

export function usesSourceSequence(page: SourceUsePage, contract: FigureSequenceContract): boolean {
  return contract.coveragePolicy !== 'authored-scope'
    || pageSourceSequenceUses(page).some((use) => use.resourceId === contract.resourceId);
}

/** One deterministic scope projection shared by authoring, outlines and native narration.
 * Available sources remain intact. Only actual lesson choices create coverage duties. */
export function scopeSourceSequenceContracts(
  contracts: readonly FigureSequenceContract[], pages: readonly SourceUsePage[],
): FigureSequenceContract[] {
  // Accepted checkpoints predating explicit reference scope retain their
  // original full-list contract; no completed course is silently replanned.
  const explicitScope = pages.some((page) => page.sourceSequenceUses !== undefined
    || page.teachingBrief?.teachingPlan?.sourceSequenceUses !== undefined);
  return contracts.map((contract) => {
    if (contract.coveragePolicy !== 'authored-scope') return contract;
    if (!explicitScope) return { ...contract, required: true, coveragePolicy: undefined };
    const uses = pages.flatMap((page) => pageSourceSequenceUses(page))
      .filter((use) => use.resourceId === contract.resourceId);
    const source = { ...contract, requiredStepLabels: undefined };
    if (!uses.length) return { ...source, required: false };
    if (uses.some((use) => use.coverage === 'complete')) return { ...source, required: true };
    const chosenIds = new Set(uses.flatMap((use) => use.sourceStepIds ?? []));
    const requiredStepLabels = (contract.orderedSteps ?? [])
      .filter((step) => step.sourceBlockId && chosenIds.has(step.sourceBlockId)).map((step) => step.label);
    return { ...source, required: true, requiredStepLabels };
  });
}

export function mergeSourceSequenceUses(pages: readonly SourceUsePage[]): SourceSequenceUse[] {
  const byId = new Map<string, SourceSequenceUse>();
  for (const page of pages) for (const use of pageSourceSequenceUses(page)) {
    const existing = byId.get(use.resourceId);
    if (!existing || use.coverage === 'complete') byId.set(use.resourceId, structuredClone(use));
    else if (existing.coverage === 'selected') existing.sourceStepIds = [...new Set([
      ...(existing.sourceStepIds ?? []), ...(use.sourceStepIds ?? []),
    ])];
  }
  return [...byId.values()];
}

export function normalizeSourceSequenceUses(value: unknown, contracts: readonly FigureSequenceContract[],
  knowledgePointIds: readonly string[]): { uses?: SourceSequenceUse[]; issues: string[] } {
  if (value === undefined) return { issues: [] };
  if (!Array.isArray(value)) return { issues: ['sourceSequenceUses 必须为数组'] };
  const issues: string[] = [];
  const seen = new Set<string>();
  const uses: SourceSequenceUse[] = [];
  for (const item of value) {
    const raw = item && typeof item === 'object' && !Array.isArray(item)
      ? item as Record<string, unknown> : {};
    const id = typeof raw.resourceId === 'string' ? raw.resourceId : '';
    const contract = contracts.find((source) => source.resourceId === id
      && source.knowledgePointIds.some((pointId) => knowledgePointIds.includes(pointId)));
    if (!contract || seen.has(id)) { issues.push('教材采用范围包含未知、重复或不属于本页知识点的来源'); continue; }
    seen.add(id);
    if (raw.coverage === 'complete') {
      if (raw.sourceStepIds !== undefined) issues.push('完整讲解不应同时声明选讲条目');
      uses.push({ resourceId: id, coverage: 'complete' });
    } else if (raw.coverage === 'selected') {
      const ids = raw.sourceStepIds;
      if (!Array.isArray(ids) || !ids.length || ids.some((stepId) => typeof stepId !== 'string'
        || !contract.orderedSteps?.some((step) => step.sourceBlockId === stepId))
        || new Set(ids).size !== ids.length) {
        issues.push('选讲须声明该来源中实际采用的非空、唯一 sourceStepIds'); continue;
      }
      uses.push({ resourceId: id, coverage: 'selected', sourceStepIds: [...ids] as string[] });
    } else issues.push('教材采用范围须为 complete 或 selected');
  }
  return { uses, issues };
}
