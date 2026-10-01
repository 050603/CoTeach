import type { PPTElement } from '@openmaic/dsl';
import type { SceneOutline, GeneratedSlideContent } from '@/lib/openmaic/types/generation';
import type { Scene } from '@/lib/openmaic/types/stage';
import { inspectFigureSequence, hasSourceSequenceLabel, firstSourceSequenceTeachingOutline, type FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import { fingerprintGenerationValue } from './page-checkpoints';
import { getOutlineSourcePageIds } from './generation-scope';
import { scopeSourceSequenceContracts, usesSourceSequence } from '@/lib/textbook/source-sequence-use';

export type SourceSequenceContentGroup = { statements: string[]; diagramLabels?: string[] };

function plainText(value: string): string {
  return value.replace(/<br\s*\/?\s*>|<\/(?:p|div|li)>/giu, '\n').replace(/<[^>]*>/gu, '')
    .replace(/&nbsp;/giu, ' ').replace(/&amp;/giu, '&').replace(/&lt;/giu, '<').replace(/&gt;/giu, '>').trim();
}

function textValues(value: unknown): string[] {
  return typeof value === 'string' ? [value] : typeof value === 'number' && Number.isFinite(value) ? [String(value)]
    : Array.isArray(value) ? value.flatMap(textValues) : [];
}

/** Read only rendered native content. Groups use flat groupId membership;
 * source IDs, alternative text and authoring metadata are not teaching text. */
export function sourceSequenceSlideContent(content: { elements: readonly PPTElement[] },
  includeDiagramLabels = false): SourceSequenceContentGroup {
  return { statements: content.elements.flatMap((element) => {
    if (element.type === 'text') return [plainText(element.content)];
    if (element.type === 'shape') return element.text ? [plainText(element.text.content)] : [];
    if (element.type === 'table') return element.data.flatMap((row) => row.flatMap((cell) => textValues(cell.text).map(plainText)));
    if (element.type === 'chart') return textValues([element.data?.labels, element.data?.legends]).map(plainText);
    if (element.type === 'latex') return [plainText(element.latex ?? '')];
    return [];
  }).filter(Boolean), ...(includeDiagramLabels ? { diagramLabels: content.elements.flatMap((element) =>
    element.type === 'shape' && element.text ? [plainText(element.text.content)] : []) } : {}) };
}

function compact(value: string): string {
  return value.normalize('NFKC').replace(/[\s，。！？、；：,.!?;:'“”‘’()（）【】\[\]《》<>—_-]+/gu, '');
}

export type SourceContentPage = { outline: SceneOutline; content: GeneratedSlideContent; speech?: readonly string[] };
export type SourceContentIssue = {
  resourceId: string;
  detail: string;
  sectionId: string;
  repairOutlineId: string;
  targetOutlineIds: string[];
  missingCanonicalLabels: string[];
};

export function sourceTeachingSectionId(outline: SceneOutline): string {
  return outline.lectureSectionId || outline.parentActivityId || outline.activityId || outline.stageKey || '__course__';
}

export function canonicalSourceClausesForOutline(outline: SceneOutline, visibleOnly = false): string[] {
  const plan = outline.teachingBrief?.teachingPlan;
  const display = plan?.presentationContent ?? outline.keyPoints;
  return (visibleOnly ? [...display,
    ...(outline.visualIntent?.diagram?.nodes.map((node) => node.label) ?? [])] : [
    outline.description, ...display, ...(plan?.visibleContent ?? []),
    plan?.newContent, ...(plan?.reasoningSteps ?? []), ...(plan?.narrationFocus ?? []),
    outline.teachingBrief?.explanation, ...(outline.teachingBrief?.conditions ?? []),
  ])
    .filter((value): value is string => typeof value === 'string' && Boolean(value));
}

export function outlineOwnsCanonicalSourceClause(outline: SceneOutline, label: string, visibleOnly = false): boolean {
  return hasSourceSequenceLabel(canonicalSourceClausesForOutline(outline, visibleOnly).join('\n'), label);
}

/** Share the adopted list's execution responsibility with first-draft
 * authoring. An unassigned clause stays on the existing best owner; absence
 * from the plan must never erase a required textbook item. */
export function sourceSequenceTeachingResponsibilities(outlines: readonly SceneOutline[],
  contract: FigureSequenceContract): { targets: SceneOutline[]; owners: Array<{ label: string; owner: SceneOutline }> } {
  contract = scopeSourceSequenceContracts([contract], outlines)[0]!;
  if (!contract.required || !contract.orderedSteps?.length) return { targets: [], owners: [] };
  const allTargets = outlines.filter((outline) => outline.type === 'slide'
    && usesSourceSequence(outline, contract)
    && outline.generationPurpose === 'knowledge-teaching'
    && outline.knowledgePointIds?.some((id) => contract.knowledgePointIds.includes(id)));
  const first = contract.scope === 'single-page'
    ? firstSourceSequenceTeachingOutline(allTargets, contract.orderedSteps, contract.resourceId) : allTargets[0];
  if (!first) return { targets: [], owners: [] };
  const parent = first.spatialParentId ?? first.id;
  const targets = contract.scope === 'single-page' ? allTargets.filter((outline) =>
    outline.id === parent || outline.spatialParentId === parent || getOutlineSourcePageIds(outline).includes(parent)) : allTargets;
  const bestOwner = targets.reduce((best, current) => {
    const count = (page: SceneOutline) => contract.orderedSteps!.filter((step) => outlineOwnsCanonicalSourceClause(page, step.label)).length;
    return count(current) > count(best) ? current : best;
  });
  const owners = contract.orderedSteps.filter((step) => !contract.requiredStepLabels
    || contract.requiredStepLabels.includes(step.label)).map((step) => ({ label: step.label,
    owner: targets.find((outline) => outlineOwnsCanonicalSourceClause(outline, step.label)) ?? bestOwner }));
  return { targets, owners };
}

function slideContentGroups(content: GeneratedSlideContent, includeDiagramLabels = false): SourceSequenceContentGroup[] {
  return [content, ...(content.continuationPages ?? [])].map((page) => sourceSequenceSlideContent(page, includeDiagramLabels));
}

/** Lists can span several pages. Keep each source list independent, and
 * locate a missing clause on the page that already owns its visible duty. */
export function findSourceContentIssues(pages: readonly SourceContentPage[],
  contracts: readonly FigureSequenceContract[], options: { visibleOnly?: boolean } = {}): SourceContentIssue[] {
  const scoped = scopeSourceSequenceContracts(contracts, pages.map((page) => page.outline));
  return scoped.flatMap((contract) => {
    if (!contract.required || !contract.orderedSteps?.length) return [];
    const candidates = pages.filter(({ outline }) => outline.type === 'slide'
      && usesSourceSequence(outline, contract)
      && outline.generationPurpose === 'knowledge-teaching'
      && outline.knowledgePointIds?.some((id) => contract.knowledgePointIds.includes(id)));
    const first = contract.scope === 'single-page'
      ? firstSourceSequenceTeachingOutline(candidates.map(({ outline }) => outline), contract.orderedSteps, contract.resourceId) : candidates[0]?.outline;
    const firstParent = first?.spatialParentId ?? first?.id;
    const targets = contract.scope === 'single-page' && firstParent
      ? candidates.filter(({ outline }) => outline.id === firstParent || outline.spatialParentId === firstParent
        || getOutlineSourcePageIds(outline).includes(firstParent)) : candidates;
    if (!targets.length) return [];
    const groups = targets.flatMap(({ content, speech }) => [...slideContentGroups(content, contract.sequenceSemantics !== 'enumerated-items'),
      ...(!options.visibleOnly && speech?.length ? [{ statements: [...speech] }] : [])]);
    const related = scoped.filter((other) => other.required
      && targets.some(({ outline }) => outline.knowledgePointIds?.some((id) => other.knowledgePointIds.includes(id))));
    const problems = inspectFigureSequence({ orderedSteps: contract.orderedSteps, statements: [], contentGroups: groups,
      relatedSequences: related, sequenceSemantics: contract.sequenceSemantics, requireCompleteText: !options.visibleOnly,
      ...(!options.visibleOnly ? { requiredStepLabels: contract.requiredStepLabels } : {}),
      allowPartialDiagram: Boolean(contract.requiredStepLabels) });
    const text = compact(groups.flatMap((group) => group.statements).join('\n'));
    const missing = contract.orderedSteps.filter((step) => (!contract.requiredStepLabels
      || contract.requiredStepLabels.includes(step.label)) && !hasSourceSequenceLabel(text, step.label)
      && (!options.visibleOnly || targets.some(({ outline }) => outlineOwnsCanonicalSourceClause(outline, step.label, true))))
      .map((step) => step.label);
    if (options.visibleOnly && missing.length) problems.push(`遗漏教材条目：${missing.join('、')}`);
    if (!problems.length) return [];
    const responsibilities = missing.length ? missing : contract.orderedSteps.map((step) => step.label);
    const bestOwner = targets.reduce((best, current) => {
      const coverage = (page: SourceContentPage) => responsibilities.filter((label) => outlineOwnsCanonicalSourceClause(page.outline, label, options.visibleOnly)).length;
      return coverage(current) > coverage(best) ? current : best;
    });
    const byOwner = new Map<string, { page: SourceContentPage; labels: string[] }>();
    for (const label of missing) {
      const page = targets.find(({ outline }) => outlineOwnsCanonicalSourceClause(outline, label, options.visibleOnly)) ?? bestOwner;
      const assignment = byOwner.get(page.outline.id) ?? { page, labels: [] };
      assignment.labels.push(label);
      byOwner.set(page.outline.id, assignment);
    }
    if (!byOwner.size) byOwner.set(bestOwner.outline.id, { page: bestOwner, labels: [] });
    return [...byOwner.values()].map(({ page: owner, labels }) => ({ resourceId: contract.resourceId,
      detail: problems.join('；'), sectionId: sourceTeachingSectionId(owner.outline),
      repairOutlineId: owner.outline.id, targetOutlineIds: targets.map(({ outline }) => outline.id),
      missingCanonicalLabels: labels }));
  });
}

/** Inspect the actual finished draft without rewriting it or turning a
 * textbook-coverage diagnostic into another authoring or recovery request. */
export function findClassroomSourceContentIssues(outlines: readonly SceneOutline[], scenes: readonly Scene[],
  contracts: readonly FigureSequenceContract[]): SourceContentIssue[] {
  const byOutline = new Map(outlines.map((outline) => [outline.id, outline]));
  const pages = scenes.flatMap((scene): SourceContentPage[] => {
    const outline = byOutline.get(scene.outlineId ?? scene.id);
    if (!outline || scene.content?.type !== 'slide') return [];
    return [{ outline, content: { elements: scene.content.canvas.elements, background: scene.content.canvas.background },
      speech: (scene.actions ?? []).flatMap((action) => action.type === 'speech' ? [action.text] : []) }];
  });
  return findSourceContentIssues(pages, contracts);
}

export function sourceContentDiagnosticWarnings(issues: readonly SourceContentIssue[]): string[] {
  return [...new Set(issues.map((issue) =>
    `教材内容待核对 [${issue.sectionId}/${issue.repairOutlineId}; ${issue.resourceId}]：${issue.detail}`))];
}

export function findFinalizedSourceContentIssues(outlines: readonly SceneOutline[], scenes: readonly Scene[],
  contracts: readonly FigureSequenceContract[]): SourceContentIssue[] {
  if (!scopeSourceSequenceContracts(contracts, outlines).some((contract) => contract.required && contract.orderedSteps?.length)) return [];
  const byId = new Map(outlines.map((outline) => [outline.id, outline]));
  return findSourceContentIssues(scenes.flatMap((scene) => {
    const outline = byId.get(scene.outlineId ?? scene.id);
    return outline && scene.content?.type === 'slide' ? [{ outline,
      content: { elements: scene.content.canvas.elements } as GeneratedSlideContent,
      speech: (scene.actions ?? []).flatMap((action) => action.type === 'speech' ? [action.text] : []) }] : [];
  }), contracts);
}

/** Validate source teaching at the section's spoken-source boundary. Source
 * lists can span several sections, so assign their clauses from the complete
 * adopted plan instead of demanding another section's clauses on this one. */
export function findSectionSourceContentIssues(outlines: readonly SceneOutline[], pages: readonly SourceContentPage[],
  contracts: readonly FigureSequenceContract[]): SourceContentIssue[] {
  const scoped = scopeSourceSequenceContracts(contracts, outlines);
  return scoped.flatMap((contract) => {
    if (!contract.required || !contract.orderedSteps?.length) return [];
    const { targets, owners } = sourceSequenceTeachingResponsibilities(outlines, contract);
    const ids = new Set(targets.map((outline) => outline.id));
    const actual = pages.filter(({ outline }) => ids.has(outline.id));
    if (!actual.length) return [];
    const sections = new Set(actual.map(({ outline }) => sourceTeachingSectionId(outline)));
    const groups = actual.flatMap(({ content, speech }) => [...slideContentGroups(content, contract.sequenceSemantics !== 'enumerated-items'),
      ...(speech?.length ? [{ statements: [...speech] }] : [])]);
    const text = compact(groups.flatMap((group) => group.statements).join('\n'));
    const missing = owners.filter(({ owner, label }) => sections.has(sourceTeachingSectionId(owner))
      && !hasSourceSequenceLabel(text, label));
    const related = scoped.filter((other) => other.required && actual.some(({ outline }) =>
      outline.knowledgePointIds?.some((id) => other.knowledgePointIds.includes(id))));
    const problems = inspectFigureSequence({ orderedSteps: contract.orderedSteps, statements: [], contentGroups: groups,
      sequenceSemantics: contract.sequenceSemantics, relatedSequences: related,
      allowPartialDiagram: Boolean(contract.requiredStepLabels) });
    if (missing.length) problems.push(`遗漏教材条目：${missing.map(({ label }) => label).join('、')}`);
    if (!problems.length) return [];
    const assignments = new Map<string, { owner: SceneOutline; labels: string[] }>();
    for (const { owner, label } of missing) {
      const value = assignments.get(owner.id) ?? { owner, labels: [] };
      value.labels.push(label);
      assignments.set(owner.id, value);
    }
    if (!assignments.size) assignments.set(actual[0]!.outline.id, { owner: actual[0]!.outline, labels: [] });
    return [...assignments.values()].map(({ owner, labels }) => ({ resourceId: contract.resourceId,
      detail: problems.join('；'), sectionId: sourceTeachingSectionId(owner), repairOutlineId: owner.id,
      targetOutlineIds: actual.map(({ outline }) => outline.id), missingCanonicalLabels: labels }));
  });
}

export const SOURCE_CONTENT_CHECKPOINT_PREFIX = 'source-content:';
export const SOURCE_CONTENT_RECOVERY_POLICY = 'complete-source-narration-v1';
export const MAX_SOURCE_CONTENT_REPAIRS = 2;
export const SOURCE_NARRATION_BASELINE_STEP = 'source-narration-baseline';
export const SOURCE_NARRATION_BASELINE_POLICY = 'immutable-source-narration-v1';
export type SourceContentRecoveryCheckpoint = {
  schemaVersion: 1;
  planningPolicy: typeof SOURCE_CONTENT_RECOVERY_POLICY;
  sectionId: string;
  sourceFingerprint: string;
  inputFingerprint: string;
  modelFingerprint: string;
  attemptsStarted: number;
  /** A new insertion grammar has its own bounded budget. Never replace the
   * calls already spent by the earlier source-recovery authoring grammar. */
  authoringMode?: 'insertion-v1';
  insertionAttemptsStarted?: number;
  status: 'pending' | 'accepted' | 'infeasible';
  issues: SourceContentIssue[];
  failedNarrationFingerprints: Record<string, string>;
  /** Reconstruct the old bridge after a local section repair, without
   * invalidating source-valid narration in unrelated sections. */
  originalFinalNarration?: string[];
  failureReason?: string;
};

export function restoreSourceContentCheckpoint(value: unknown, identity: {
  sectionId: string; sourceFingerprint: string; inputFingerprint: string; modelFingerprint: string;
}): SourceContentRecoveryCheckpoint | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value as Partial<SourceContentRecoveryCheckpoint>;
  if (state.schemaVersion !== 1 || state.planningPolicy !== SOURCE_CONTENT_RECOVERY_POLICY
    || state.sectionId !== identity.sectionId || state.sourceFingerprint !== identity.sourceFingerprint
    || state.inputFingerprint !== identity.inputFingerprint || state.modelFingerprint !== identity.modelFingerprint
    || !Number.isInteger(state.attemptsStarted) || state.attemptsStarted! < 0 || state.attemptsStarted! > MAX_SOURCE_CONTENT_REPAIRS
    || (state.authoringMode !== undefined && state.authoringMode !== 'insertion-v1')
    || (state.insertionAttemptsStarted !== undefined && (state.authoringMode !== 'insertion-v1'
      || !Number.isInteger(state.insertionAttemptsStarted) || state.insertionAttemptsStarted < 0
      || state.insertionAttemptsStarted > MAX_SOURCE_CONTENT_REPAIRS))
    || !['pending', 'accepted', 'infeasible'].includes(state.status ?? '') || !Array.isArray(state.issues)
    || state.issues.some((issue) => !issue || issue.sectionId !== identity.sectionId || typeof issue.detail !== 'string'
      || typeof issue.repairOutlineId !== 'string' || !Array.isArray(issue.missingCanonicalLabels)
      || issue.missingCanonicalLabels.some((label) => typeof label !== 'string'))
    || !state.failedNarrationFingerprints || typeof state.failedNarrationFingerprints !== 'object'
    || Object.values(state.failedNarrationFingerprints).some((fingerprint) => typeof fingerprint !== 'string')
    || (state.originalFinalNarration !== undefined && (!Array.isArray(state.originalFinalNarration)
      || state.originalFinalNarration.length > 3 || state.originalFinalNarration.some((text) => typeof text !== 'string')))) return null;
  return state as SourceContentRecoveryCheckpoint;
}

export function fingerprintSourceContent(content: GeneratedSlideContent): string {
  return fingerprintGenerationValue({ elements: content.elements, background: content.background,
    continuationPages: content.continuationPages });
}

export class SourceContentRecoveryError extends Error {
  readonly isRetryable = false;
  constructor(readonly issues: SourceContentIssue[], readonly reason?: string) {
    super(`教材完整内容尚未进入课堂：${reason ? `${reason}；` : ''}${issues.map((issue) => issue.detail).join('；')}`);
    this.name = 'SourceContentRecoveryError';
  }
}

export function findSourceContentRecoveryError(error: unknown): SourceContentRecoveryError | null {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    if (current instanceof SourceContentRecoveryError) return current;
    seen.add(current);
    current = 'cause' in current ? current.cause : undefined;
  }
  return null;
}
