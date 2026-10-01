import type { SceneOutline } from '../types/generation';
import { fingerprintSceneOutline } from '@/lib/course-generation/page-checkpoints';
import { isOutlineWithinSourceSelection } from '@/lib/course-generation/generation-scope';
import { evaluateSemanticPageCapacity, SEMANTIC_PAGE_CAPACITY_VERSION, type SemanticPageCapacityAssessment, type SemanticPageCapacityOptions } from './semantic-page-capacity';
import { replanMeasuredTeachingSection } from './section-capacity-replanner';

export type TeachingPagePreflightOptions = SemanticPageCapacityOptions & {
  /** Teacher-confirmed and already authored pages cannot change their contract. */
  lockedOutlineIds?: readonly string[];
  /** Completed bodies already passed rendering; preserve them without remeasuring. */
  completedOutlineIds?: readonly string[];
  /** Full source plan, needed to avoid redistributing a partial test selection. */
  allOutlines?: readonly SceneOutline[];
  selectedSourceOutlineIds?: readonly string[];
};

export type TeachingPagePreflightResult = {
  outlines: SceneOutline[];
  assessments: SemanticPageCapacityAssessment[];
  changed: boolean;
  /** Unresolved quality findings are retained for review, never a production stop. */
  diagnostics?: string[];
};

export class TeachingPagePreflightError extends Error {
  readonly code = 'TEACHING_PAGE_PREFLIGHT_FAILED';
  readonly isRetryable = false;
  constructor(readonly outlines: SceneOutline[], readonly assessments: SemanticPageCapacityAssessment[]) {
    super(`首稿容量预检未通过，保留页面计划供复核：${assessments.map((item) => `${item.outlineId}：${item.reason}`).join('；')}`);
    this.name = 'TeachingPagePreflightError';
  }
}

/** Shared by blueprint review and page production. It uses renderer fonts and
 * the final display/visual contract, with no model calls or changes to source
 * facts. Only complete unconfirmed teaching sections may be redistributed. */
export async function prepareTeachingPageCapacity(
  outlines: readonly SceneOutline[], options: TeachingPagePreflightOptions = {},
): Promise<TeachingPagePreflightResult> {
  const completed = new Set(options.completedOutlineIds ?? []);
  const locked = new Set([...(options.lockedOutlineIds ?? []), ...completed]);
  const selected = options.selectedSourceOutlineIds ? new Set(options.selectedSourceOutlineIds) : undefined;
  const assessments = new Map<string, SemanticPageCapacityAssessment>();
  const diagnostics: string[] = [];
  const assess = async (page: SceneOutline): Promise<SemanticPageCapacityAssessment> => {
    try { return await evaluateSemanticPageCapacity(page, options); }
    catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      return { schemaVersion: 1, planningVersion: SEMANTIC_PAGE_CAPACITY_VERSION,
        outlineId: page.id, sourcePageId: page.spatialParentId ?? page.id,
        decision: 'measurement-unavailable', measurementMode: 'unavailable', groups: [], layouts: [],
        reason: error instanceof Error ? error.message : String(error) };
    }
  };
  for (const page of outlines.filter((outline) => outline.type === 'slide' && !completed.has(outline.id))) {
    assessments.set(page.id, await assess(page));
  }
  const failed = (assessment: SemanticPageCapacityAssessment | undefined) => assessment
    && ['page-overflow', 'section-overload', 'measurement-unavailable'].includes(assessment.decision);
  const sections = new Map<string, SceneOutline[]>();
  for (const page of outlines) {
    if (page.type !== 'slide' || page.generationPurpose !== 'knowledge-teaching' || !page.lectureSectionId) continue;
    sections.set(page.lectureSectionId, [...(sections.get(page.lectureSectionId) ?? []), page]);
  }
  const replacements = new Map<string, SceneOutline[]>();
  for (const [sectionId, pages] of sections) {
    if (!pages.some((page) => !locked.has(page.id) && failed(assessments.get(page.id)))) continue;
    // Measurement failure is not evidence that more pages will fit.
    if (pages.some((page) => !completed.has(page.id) && assessments.get(page.id)?.decision === 'measurement-unavailable')) continue;
    const fullSection = (options.allOutlines ?? outlines).filter((page) => page.type === 'slide'
      && page.generationPurpose === 'knowledge-teaching' && page.lectureSectionId === sectionId);
    if (fullSection.length !== pages.length || pages.some((page) => !fullSection.some((candidate) => candidate.id === page.id))) continue;
    const completePlan = options.allOutlines ?? outlines;
    const firstPageIndex = completePlan.findIndex((page) => page.id === pages[0]?.id);
    const priorTeachingNodeIds = completePlan.slice(0, Math.max(0, firstPageIndex))
      .flatMap((page) => page.type === 'slide' ? page.teachingBrief?.teachingPlan?.introduces ?? [] : []);
    let proposal: Awaited<ReturnType<typeof replanMeasuredTeachingSection>>;
    try {
      proposal = await replanMeasuredTeachingSection(pages, { ...options, priorTeachingNodeIds,
        allowAcceptedPlan: true, lockedOutlineIds: pages.filter((page) => locked.has(page.id)).map((page) => page.id) });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      diagnostics.push(`${sectionId}：自动容量重规划未完成，保留原稿继续生成：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (proposal.status !== 'replanned') continue;
    if (selected && proposal.outlines.some((page) => !isOutlineWithinSourceSelection(page, selected))) continue;
    if (pages.some((page) => locked.has(page.id) && fingerprintSceneOutline(page)
      !== fingerprintSceneOutline(proposal.outlines.find((candidate) => candidate.id === page.id) ?? { ...page, id: '__missing__' }))) {
      diagnostics.push('容量重规划尝试改动已确认或已完成的页面，已保留原页面计划并继续生成');
      continue;
    }
    const verified: SemanticPageCapacityAssessment[] = [];
    for (const page of proposal.outlines.filter((page) => !completed.has(page.id))) {
      verified.push(await assess(page));
    }
    if (verified.some(failed)) continue;
    replacements.set(sectionId, proposal.outlines);
    for (const page of pages) assessments.delete(page.id);
    for (const assessment of verified) assessments.set(assessment.outlineId, assessment);
  }
  const emitted = new Set<string>();
  const prepared = outlines.flatMap((page) => {
    const sectionId = page.lectureSectionId;
    const replacement = sectionId && page.type === 'slide' ? replacements.get(sectionId) : undefined;
    if (!replacement || !sectionId) return [page];
    if (emitted.has(sectionId)) return [];
    emitted.add(sectionId);
    return replacement;
  }).map((page, order) => page.order === order ? page : { ...page, order });
  const issues = [...assessments.values()].filter((assessment) => failed(assessment));
  diagnostics.push(...issues.map((item) => `${item.outlineId}：${item.reason}；保留当前页面计划并继续生成`));
  return { outlines: prepared, assessments: [...assessments.values()], changed: replacements.size > 0, diagnostics };
}
