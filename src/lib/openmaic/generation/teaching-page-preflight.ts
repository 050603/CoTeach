import type { SceneOutline } from '../types/generation';
import { fingerprintGenerationValue, fingerprintSceneOutline } from '@/lib/course-generation/page-checkpoints';
import { hasCompatibleOutlinePlan, isOutlineWithinSourceSelection } from '@/lib/course-generation/generation-scope';
import { evaluateSemanticPageCapacity, SEMANTIC_PAGE_CAPACITY_VERSION, type SemanticPageCapacityAssessment, type SemanticPageCapacityOptions } from './semantic-page-capacity';
import { replanMeasuredTeachingSection } from './section-capacity-replanner';
import { usesRestoredSlideAuthoring } from './restored-slide-authoring';

export type TeachingPagePreflightOptions = SemanticPageCapacityOptions & {
  /** New runtime native drafts use their actual fonts; historical replay keeps its contract. */
  nativeLectureAuthoring?: boolean;
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

/** Pagination may redistribute responsibilities, but it cannot rewrite what
 * is taught. Compare the executed contract before adopting a measured draft. */
function preservesTeachingContent(original: readonly SceneOutline[], proposed: readonly SceneOutline[]): boolean {
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    fingerprintGenerationValue([...new Set(left)].sort()) === fingerprintGenerationValue([...new Set(right)].sort());
  const speech = (pages: readonly SceneOutline[]) => pages.flatMap((page) =>
    page.teachingBrief?.manuscript?.segmentIds.map((id) => [page.teachingBrief!.manuscript!.sectionId, id]) ?? []);
  const planDuties = (pages: readonly SceneOutline[]) => pages.flatMap((page) => [
    ...(page.teachingBrief?.teachingPlan?.introduces ?? []), ...(page.teachingBrief?.teachingPlan?.deepens ?? []),
  ]);
  const duties = (pages: readonly SceneOutline[]) => pages.flatMap((page) => page.teachingBrief?.manuscript?.segmentIds
    ?? planDuties([page]));
  const media = (pages: readonly SceneOutline[]) => pages.flatMap((page) =>
    page.visualIntent?.resourceRefs?.filter((ref) => ref.required || ref.kind === 'source-image')
      .map((ref) => `${ref.kind}:${ref.resourceId}`) ?? []);
  const diagrams = (pages: readonly SceneOutline[]) => pages.flatMap((page) =>
    page.visualIntent?.diagram ? [fingerprintGenerationValue(page.visualIntent.diagram)] : []);
  const total = (pages: readonly SceneOutline[], value: (page: SceneOutline) => number | undefined) =>
    pages.reduce((sum, page) => sum + (value(page) ?? 0), 0);
  const originalDuties = planDuties(original), proposedDuties = new Set(planDuties(proposed));
  const allowedDuties = new Set([...duties(original), ...originalDuties]);
  return hasCompatibleOutlinePlan(original, proposed)
    && fingerprintGenerationValue(speech(original)) === fingerprintGenerationValue(speech(proposed))
    && sameSet(original.flatMap((page) => page.knowledgePointIds ?? []), proposed.flatMap((page) => page.knowledgePointIds ?? []))
    && sameSet(duties(original), duties(proposed))
    && originalDuties.every((id) => proposedDuties.has(id))
    && [...proposedDuties].every((id) => allowedDuties.has(id))
    && sameSet(media(original), media(proposed))
    && sameSet(diagrams(original), diagrams(proposed))
    && total(original, (page) => page.targetDurationSec) === total(proposed, (page) => page.targetDurationSec)
    && total(original, (page) => page.estimatedDuration) === total(proposed, (page) => page.estimatedDuration)
    && (['narrationSec', 'learnerActivitySec', 'transitionSec'] as const).every((key) =>
      total(original, (page) => page.plannedTiming?.[key]) === total(proposed, (page) => page.plannedTiming?.[key]));
}

/** Shared by blueprint review and page production. It uses renderer fonts and
 * the final display/visual contract, with no model calls or changes to source
 * facts. Candidate layouts establish feasibility, never prescribe composition.
 * Only complete unconfirmed teaching sections may be redistributed. */
export async function prepareTeachingPageCapacity(
  outlines: readonly SceneOutline[], options: TeachingPagePreflightOptions = {},
): Promise<TeachingPagePreflightResult> {
  const completed = new Set(options.completedOutlineIds ?? []);
  const locked = new Set([...(options.lockedOutlineIds ?? []), ...completed]);
  const measurementOptions: SemanticPageCapacityOptions = options.nativeLectureAuthoring ? { ...options,
    useRestoredNativeDisplay: (page) => !locked.has(page.id)
      && (usesRestoredSlideAuthoring(page) || Boolean(options.useRestoredNativeDisplay?.(page))),
    useReferenceLectureTypography: (page) => !locked.has(page.id)
      && (usesRestoredSlideAuthoring(page) || Boolean(options.useReferenceLectureTypography?.(page))),
  } : options;
  const selected = options.selectedSourceOutlineIds ? new Set(options.selectedSourceOutlineIds) : undefined;
  const assessments = new Map<string, SemanticPageCapacityAssessment>();
  const diagnostics: string[] = [];
  const assess = async (page: SceneOutline): Promise<SemanticPageCapacityAssessment> => {
    try { return await evaluateSemanticPageCapacity(page, measurementOptions); }
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
    // Joint authoring already owns the complete page boundaries. A candidate
    // semantic layout can diagnose capacity, but cannot replace that plan.
    // Preserve the whole section even during a mixed-version recovery so an
    // older neighbour cannot pull an adopted joint page into redistribution.
    if (pages.some((page) => page.teachingBrief?.pptPlanningVersion === 'joint-native-pages-4615-v1')) continue;
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
      proposal = await replanMeasuredTeachingSection(pages, { ...measurementOptions, priorTeachingNodeIds,
        allowAcceptedPlan: true, lockedOutlineIds: pages.filter((page) => locked.has(page.id)).map((page) => page.id) });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw error;
      diagnostics.push(`${sectionId}：自动容量重规划未完成，保留原稿继续生成：${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (proposal.status !== 'replanned') {
      if (proposal.status === 'infeasible') diagnostics.push(`${sectionId}：${proposal.reason}；保留原页面计划并继续生成`);
      continue;
    }
    if (selected && proposal.outlines.some((page) => !isOutlineWithinSourceSelection(page, selected))) {
      diagnostics.push(`${sectionId}：容量调整超出本次来源范围，保留原页面计划并继续生成`);
      continue;
    }
    if (pages.some((page) => locked.has(page.id) && fingerprintSceneOutline(page)
      !== fingerprintSceneOutline(proposal.outlines.find((candidate) => candidate.id === page.id) ?? { ...page, id: '__missing__' }))) {
      diagnostics.push('容量重规划尝试改动已确认或已完成的页面，已保留原页面计划并继续生成');
      continue;
    }
    if (!preservesTeachingContent(pages, proposal.outlines)) {
      diagnostics.push(`${sectionId}：容量调整未完整保留讲稿顺序、知识职责、必要媒体、真实图示或小节时长，保留原页面计划并继续生成`);
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
