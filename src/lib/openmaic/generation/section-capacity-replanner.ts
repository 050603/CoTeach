import { createHash } from 'node:crypto';
import type { SceneOutline } from '../types/generation';
import { hasCompatibleOutlinePlan } from '@/lib/course-generation/generation-scope';
import { evaluateSemanticPageCapacity, type SemanticCapacityGroup, type SemanticPageCapacityAssessment,
  type SemanticPageCapacityOptions } from './semantic-page-capacity';

const GAP = 12;

type OwnedGroup = SemanticCapacityGroup & { owner: SceneOutline; height: number };
type Unit = { groups: OwnedGroup[]; height: number; sourcePageIds: string[] };

function distinct<T>(items: readonly T[]): T[] { return [...new Set(items)]; }

/** Preserve related semantic groups and their original reading order. */
function indivisibleUnits(groups: OwnedGroup[], assessments: readonly SemanticPageCapacityAssessment[]): Unit[] {
  const indexById = new Map(groups.map((group, index) => [`${group.sourcePageId}:${group.id}`, index]));
  const spans = groups.map((group, index) => {
    const linked = group.indivisibleWith.flatMap((id) => indexById.get(`${group.sourcePageId}:${id}`) ?? []);
    return { start: Math.min(index, ...linked), end: Math.max(index, ...linked) };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const span of spans) {
    const previous = merged.at(-1);
    if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
    else merged.push({ ...span });
  }
  return merged.map(({ start, end }) => {
    const members = groups.slice(start, end + 1);
    const measured = assessments.filter((assessment) => assessment.outlineId === members[0]?.sourcePageId)
      .flatMap((assessment) => assessment.units ?? []).find((unit) =>
      unit.groupIds.length === members.length && unit.groupIds.every((id, index) => id === members[index]?.id)
      && members.every((group) => group.sourcePageId === members[0]?.sourcePageId));
    return { groups: members,
      // A visual and its observation may share columns. Adding their separate
      // full-width heights rejects a legal atomic composition.
      height: measured?.measuredHeight ?? members.reduce((sum, group) => sum + group.height, 0) + GAP * (members.length - 1),
      sourcePageIds: distinct(members.map((group) => group.sourcePageId)),
    };
  });
}

/** Exact integer apportionment, weighted by measured teaching work. */
function allocate(total: number | undefined, weights: number[]): Array<number | undefined> {
  if (total === undefined) return weights.map(() => undefined);
  const integer = Math.max(0, Math.round(total));
  const sum = weights.reduce((value, weight) => value + weight, 0);
  const quotas = weights.map((weight) => integer * weight / sum);
  const assigned = quotas.map(Math.floor);
  const remainder = integer - assigned.reduce((value, share) => value + share, 0);
  const order = quotas.map((quota, index) => ({ index, fraction: quota - Math.floor(quota) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; index < remainder; index += 1) assigned[order[index]!.index]! += 1;
  return assigned;
}

function giveEveryPageTime(components: Array<Array<number | undefined>>): boolean {
  const pageCount = components[0]?.length ?? 0;
  const pageTotal = (page: number) => components.reduce((sum, component) => sum + (component[page] ?? 0), 0);
  for (let page = 0; page < pageCount; page += 1) {
    if (pageTotal(page) > 0) continue;
    const donor = Array.from({ length: pageCount }, (_, index) => index)
      .sort((left, right) => pageTotal(right) - pageTotal(left))[0];
    if (donor === undefined || pageTotal(donor) <= 1) return false;
    const component = components.find((item) => (item[donor] ?? 0) > 0);
    if (!component) return false;
    component[donor]!--;
    component[page] = (component[page] ?? 0) + 1;
  }
  return true;
}

/** Minimum feasible page count, then balanced heights across complete pages. */
function pageBreaks(units: Unit[], capacity: number, firstCount: number): number[] | undefined {
  if (!units.length || units.some((unit) => unit.height > capacity)) return undefined;
  const prefix = [0];
  for (const unit of units) prefix.push(prefix.at(-1)! + unit.height);
  const used = (start: number, end: number) => prefix[end]! - prefix[start]! + GAP * (end - start - 1);
  for (let count = firstCount; count <= units.length; count += 1) {
    const target = (prefix.at(-1)! + GAP * (units.length - count)) / count;
    const costs = Array.from({ length: count + 1 }, () => Array<number>(units.length + 1).fill(Infinity));
    const previous = Array.from({ length: count + 1 }, () => Array<number>(units.length + 1).fill(-1));
    costs[0]![0] = 0;
    for (let pages = 1; pages <= count; pages += 1) {
      for (let end = pages; end <= units.length; end += 1) {
        for (let start = pages - 1; start < end; start += 1) {
          const height = used(start, end);
          if (height > capacity || !Number.isFinite(costs[pages - 1]![start])) continue;
          const cost = costs[pages - 1]![start]! + (height - target) ** 2;
          if (cost < costs[pages]![end]!) { costs[pages]![end] = cost; previous[pages]![end] = start; }
        }
      }
    }
    if (!Number.isFinite(costs[count]![units.length])) continue;
    const breaks = [units.length];
    let end = units.length;
    for (let pages = count; pages > 0; pages -= 1) {
      end = previous[pages]![end]!;
      breaks.push(end);
    }
    return breaks.reverse();
  }
  return undefined;
}

function total(outlines: readonly SceneOutline[], field: 'targetDurationSec' | 'estimatedDuration'): number | undefined {
  const amounts = outlines.map((outline) => outline[field]).filter((amount): amount is number => amount !== undefined);
  return amounts.length ? amounts.reduce((sum, amount) => sum + amount, 0) : undefined;
}

/** A section-level, measurable redistribution of the existing teaching claims. */
export function rebalanceMeasuredTeachingSection(
  outlines: readonly SceneOutline[],
  assessments: readonly SemanticPageCapacityAssessment[],
  options: { allowAcceptedPlan?: boolean } = {},
): SceneOutline[] | undefined {
  if (!outlines.length || outlines.length !== assessments.length
    || outlines.some((outline) => outline.type !== 'slide' || outline.sectionPlanVersion && !options.allowAcceptedPlan)
    || assessments.some((assessment, index) => assessment.outlineId !== outlines[index]?.id
      || assessment.decision === 'measurement-unavailable')) return undefined;
  const sectionId = outlines[0]!.lectureSectionId;
  if (!sectionId || outlines.some((outline) => outline.lectureSectionId !== sectionId)) return undefined;
  if (!assessments.some((assessment) => assessment.decision === 'page-overflow' || assessment.decision === 'section-overload')) return undefined;
  const owners = new Map(outlines.map((outline) => [outline.id, outline]));
  const groups: OwnedGroup[] = assessments.flatMap((assessment, index) => assessment.groups.map((group) => ({
    ...group, sourcePageId: outlines[index]!.id, owner: outlines[index]!, height: group.measuredHeight ?? Infinity,
  })));
  if (groups.some((group) => !Number.isFinite(group.height) || group.height <= 0)) return undefined;
  const units = indivisibleUnits(groups, assessments);
  const capacities = assessments.flatMap((assessment) => assessment.layouts.map((layout) => layout.availableHeight));
  const capacity = Math.min(...capacities);
  if (!Number.isFinite(capacity)) return undefined;
  const breaks = pageBreaks(units, capacity, outlines.length);
  if (!breaks) return undefined;
  const pageUnits = breaks.slice(0, -1).map((start, index) => units.slice(start, breaks[index + 1]!));
  const pages = pageUnits.map((assigned) => assigned.flatMap((unit) => unit.groups));
  const weights = pageUnits.map((assigned) => Math.max(1, assigned.reduce((sum, unit) => sum + unit.height, 0)));
  const targetDurations = allocate(total(outlines, 'targetDurationSec'), weights);
  const estimatedDurations = allocate(total(outlines, 'estimatedDuration'), weights);
  const narrations = allocate(outlines.reduce((sum, outline) => sum + (outline.plannedTiming?.narrationSec ?? 0), 0), weights);
  const activities = allocate(outlines.reduce((sum, outline) => sum + (outline.plannedTiming?.learnerActivitySec ?? 0), 0), weights);
  const transitions = allocate(outlines.reduce((sum, outline) => sum + (outline.plannedTiming?.transitionSec ?? 0), 0), weights);
  const hasPlannedTiming = outlines.every((outline) => Boolean(outline.plannedTiming));
  if (!hasPlannedTiming && outlines.some((outline) => outline.plannedTiming)) return undefined;
  const sectionDuration = total(outlines, 'targetDurationSec');
  if (sectionDuration !== undefined && sectionDuration < pages.length) return undefined;
  if (hasPlannedTiming && !giveEveryPageTime([narrations, activities, transitions])) return undefined;
  if (!hasPlannedTiming && targetDurations.some((duration) => duration !== undefined && duration < 1)) return undefined;
  const firstPageForSource = new Map<string, number>();
  const firstPageForNode = new Map<string, number>();
  const lastTeachingPageForNode = new Map<string, number>();
  pages.forEach((page, index) => page.forEach((group) => {
    if (!firstPageForSource.has(group.sourcePageId)) firstPageForSource.set(group.sourcePageId, index);
    for (const nodeId of group.sourceNodeIds) {
      const key = `${group.sourcePageId}:${nodeId}`;
      if (!firstPageForNode.has(key)) firstPageForNode.set(key, index);
      // A later deepening does not undo an already established prerequisite.
      // Only the initial source's complete introduces parts establish it.
      if (group.owner.teachingBrief?.teachingPlan?.introduces?.includes(nodeId)) {
        lastTeachingPageForNode.set(nodeId, index);
      }
    }
  }));
  const version = createHash('sha256').update(JSON.stringify({ policy: 'semantic-section-rebalance-v1',
    sectionId, assignments: pages.map((page) => page.map((group) => group.id)),
  })).digest('hex').slice(0, 16);
  return pages.map((page, index) => {
    const ownerPageIds = distinct(page.map((group) => group.sourcePageId));
    const source = owners.get(ownerPageIds[0]!)!;
    const sourcePageIds = distinct(ownerPageIds.flatMap((id) => owners.get(id)?.sourcePageIds?.length
      ? owners.get(id)!.sourcePageIds! : [id]));
    const visible = distinct(page.flatMap((group) => group.sourceClaim ? [group.visibleText]
      : group.visibleText.split('\n').map((text) => text.trim()).filter(Boolean)));
    const semanticSourceClaims = [...new Map(page.flatMap((group) => group.sourceClaim
      ? [[group.sourceClaim.id, { id: group.sourceClaim.id, sourcePageId: group.sourceClaim.sourcePageId,
        text: group.sourceClaim.text, parts: group.sourceClaim.parts }] as const] : [])).values()];
    const resourceIds = new Set(page.flatMap((group) => group.resourceIds));
    const nodeIds = new Set(page.flatMap((group) => group.sourceNodeIds));
    const knowledgePointIds = distinct(page.flatMap((group) => group.knowledgePointIds));
    const sourced = ownerPageIds.map((id) => owners.get(id)!);
    const narrationFocus = distinct(page.flatMap((group) => group.narrationExpansion).concat(sourced.flatMap((item) =>
      firstPageForSource.get(item.id) === index ? (item.teachingBrief?.teachingPlan?.narrationFocus ?? [])
        .filter((focus) => !groups.some((group) => group.sourcePageId === item.id
          && (group.narrationExpansion.includes(focus) || group.sourceClaim?.text === focus))) : [])));
    const responsibilities = (kind: 'introduces' | 'deepens' | 'references') => distinct(sourced.flatMap((item) => {
      const plan = item.teachingBrief?.teachingPlan;
      const original = (plan?.[kind] ?? []).filter((id) => nodeIds.has(id)
        ? kind !== 'introduces' || firstPageForNode.get(`${item.id}:${id}`) === index
        : firstPageForSource.get(item.id) === index && !groups.some((group) => group.sourcePageId === item.id && group.sourceNodeIds.includes(id)));
      return kind === 'deepens' ? [...original, ...(plan?.introduces ?? []).filter((id) => nodeIds.has(id)
        && firstPageForNode.get(`${item.id}:${id}`) !== index)] : original;
    }));
    const mediaGenerations = sourced.flatMap((item) => item.mediaGenerations ?? []).filter((item) => resourceIds.has(item.elementId));
    const resourceRefs = sourced.flatMap((item) => item.visualIntent?.resourceRefs ?? []).filter((item) => resourceIds.has(item.resourceId));
    const diagramOwner = page.find((group) => group.kind === 'diagram')?.owner;
    const sourceImageOwner = page.find((group) => group.kind === 'media'
      && group.owner.visualIntent?.representation === 'source-image'
      && group.owner.visualIntent.resourceRefs?.some((ref) => ref.required && ref.kind === 'source-image'
        && group.resourceIds.includes(ref.resourceId)))?.owner;
    const visualOwner = diagramOwner ?? sourceImageOwner ?? source;
    const selectedRegions = new Map(sourced.map((item) => [item.id, new Set(page.filter((group) => group.sourcePageId === item.id)
      .flatMap((group) => group.sourceRegionIds ?? []))]));
    const regionPositions = new Map<string, { y: number; height: number }>();
    let regionCursor = 145;
    for (const group of page) {
      const originals = (group.owner.visualPlan?.regions ?? [])
        .filter((region) => group.sourceRegionIds?.includes(region.id));
      if (originals.length) {
        const top = Math.min(...originals.map((region) => region.y));
        const bottom = Math.max(...originals.map((region) => region.y + region.height));
        const scale = Math.min(1, group.height / Math.max(1, bottom - top));
        for (const region of originals) regionPositions.set(`${group.sourcePageId}:${region.id}`, {
          y: regionCursor + (region.y - top) * scale, height: region.height * scale,
        });
      }
      regionCursor += group.height + GAP;
    }
    const regions = sourced.flatMap((item) => (item.visualPlan?.regions ?? [])
      .filter((region) => selectedRegions.get(item.id)?.has(region.id))
      .map((region) => ({ ...region, id: `${item.id}:${region.id}`,
        unitId: `${item.id}:${region.unitId || region.id}`,
        ...regionPositions.get(`${item.id}:${region.id}`),
        parentRegionId: region.parentRegionId && selectedRegions.get(item.id)?.has(region.parentRegionId)
          ? `${item.id}:${region.parentRegionId}` : undefined,
        keyPointIndexes: [],
      }))).map((region, readingOrder) => ({ ...region, readingOrder }));
    const relations = sourced.flatMap((item) => (item.visualPlan?.relations ?? [])
      .filter((relation) => selectedRegions.get(item.id)?.has(relation.from)
        && selectedRegions.get(item.id)?.has(relation.to))
      .map((relation) => ({ ...relation, from: `${item.id}:${relation.from}`, to: `${item.id}:${relation.to}` })));
    const visualPlanSource = sourced.find((item) => item.visualPlan)?.visualPlan;
    const resourceNeeds = sourced.flatMap((item) => (item.teachingBrief?.resourceNeeds ?? []).filter((need) => {
      if (need.assetId) return resourceIds.has(need.assetId);
      if (need.kind === 'image' || need.kind === 'video') return item.mediaGenerations?.some((request) =>
        request.prompt === need.prompt && resourceIds.has(request.elementId)) ?? false;
      if (need.kind === 'diagram') return page.some((group) => group.kind === 'diagram'
        && group.sourcePageId === item.id);
      return firstPageForSource.get(item.id) === index;
    }));
    const originalPlan = source.teachingBrief?.teachingPlan;
    const explanation = distinct([...visible, ...narrationFocus]).join('\n');
    const localVisualDescription = visible.join('；') || source.teachingObjective || source.title;
    const localVisualRelationship = originalPlan?.visualRelationship ? {
      ...originalPlan.visualRelationship,
      ...(source.visualIntent?.representation === 'source-image' && !sourceImageOwner
        ? { kind: 'statement' as const, preferredForm: 'text' as const } : {}),
      description: localVisualDescription,
      readingOrder: visible,
      rationale: `以本页实际分配的教学要点和视觉资源组织观察与讲解：${localVisualDescription}`,
    } : undefined;
    const movedDiagram = Boolean(source.visualIntent?.diagram || originalPlan?.visualRelationship?.diagram
      || source.visualIntent?.representation === 'native-diagram');
    const teachingPlan = originalPlan ? {
      ...originalPlan,
      visibleContent: originalPlan.presentationContent?.length ? distinct([...visible, ...narrationFocus]) : visible,
      ...(originalPlan.presentationContent?.length ? { presentationContent: visible } : {}),
      newContent: originalPlan.presentationContent?.length ? explanation : visible.join('；') || originalPlan.newContent,
      takeaway: visible.at(-1) ?? originalPlan.takeaway,
      narrationFocus: narrationFocus.length ? narrationFocus : visible,
      introduces: responsibilities('introduces'), deepens: responsibilities('deepens'),
      references: distinct([...responsibilities('references'), ...page.flatMap((group) => group.prerequisiteNodeIds ?? [])
        .filter((id) => !nodeIds.has(id) && (lastTeachingPageForNode.get(id) ?? Infinity) < index)]),
      visualRelationship: diagramOwner?.teachingBrief?.teachingPlan?.visualRelationship
        ?? sourceImageOwner?.teachingBrief?.teachingPlan?.visualRelationship
        ?? (movedDiagram ? undefined : localVisualRelationship),
      ...(index > 0 ? { entryPoint: { kind: 'continuation' as const,
        object: visible[0] ?? source.title, bridge: '承接前页，继续解释当前教学内容。' } } : {}),
    } : undefined;
    const id = index < outlines.length ? outlines[index]!.id : `${outlines[0]!.id}--capacity-${index + 1}-${version}`;
    return { ...source, id, order: index, sourcePageIds, sectionPlanVersion: version,
      ...(semanticSourceClaims.length ? { semanticSourceClaims } : { semanticSourceClaims: undefined }),
      ...(sourcePageIds.length === 1 ? { spatialParentId: sourcePageIds[0] } : { spatialParentId: undefined }),
      title: source.title, description: visible.length ? `本页讲解：${visible.join('；')}` : source.description,
      keyPoints: visible, knowledgePointIds,
      teachingUnitIds: distinct(sourced.flatMap((item) => item.teachingUnitIds ?? [])),
      ...(targetDurations[index] !== undefined ? { targetDurationSec: hasPlannedTiming
        ? narrations[index]! + activities[index]! + transitions[index]! : targetDurations[index] } : {}),
      ...(estimatedDurations[index] !== undefined ? { estimatedDuration: estimatedDurations[index] } : {}),
      ...(source.plannedTiming ? { plannedTiming: { ...source.plannedTiming,
        narrationSec: narrations[index]!, learnerActivitySec: activities[index]!, transitionSec: transitions[index]!,
      } } : {}),
      timingPlan: undefined,
      // The old box-fit result belongs to the source page. Reposition this
      // page's retained regions and measure the candidate from scratch.
      spatialBudget: undefined,
      visualPlan: visualPlanSource ? { ...visualPlanSource,
        regions: regions.length ? regions : undefined, relations: relations.length ? relations : undefined,
        coreMessage: visible.join('；') || visualPlanSource.coreMessage,
        visualEvidence: visible,
      } : undefined,
      mediaGenerations,
      visualIntent: visualOwner.visualIntent ? {
        ...visualOwner.visualIntent, resourceRefs,
        diagram: diagramOwner?.visualIntent?.diagram,
        ...(!diagramOwner && !sourceImageOwner ? {
          observationGoal: localVisualDescription,
          rationale: localVisualRelationship?.rationale
            ?? `通过本页的完整陈述与已分配视觉资源解释当前教学内容：${localVisualDescription}`,
        } : {}),
        ...(movedDiagram && !diagramOwner && !resourceRefs.length ? {
          observationGoal: visible.join('；') || source.teachingObjective || source.title,
          rationale: `通过本页的完整陈述解释当前教学内容：${visible.join('；') || source.title}`,
        } : {}),
        representation: diagramOwner ? 'native-diagram' as const
          : resourceRefs.length ? visualOwner.visualIntent?.representation === 'native-diagram'
            ? resourceRefs.every((ref) => ref.kind === 'source-image') ? 'source-image' as const
              : resourceRefs.every((ref) => ref.kind === 'generated-image') ? 'generated-image' as const : 'mixed' as const
            : visualOwner.visualIntent?.representation ?? 'mixed' as const
            : source.visualIntent?.representation === 'generated-image'
              || source.visualIntent?.representation === 'source-image'
              || source.visualIntent?.representation === 'video'
              || source.visualIntent?.representation === 'mixed'
              || source.visualIntent?.representation === 'native-diagram' ? 'text' as const
                : source.visualIntent?.representation ?? 'text' as const,
      } : undefined,
      teachingBrief: source.teachingBrief ? { ...source.teachingBrief,
        explanation,
        ...(teachingPlan ? { teachingPlan } : {}),
        resourceNeeds,
      } : undefined,
    };
  });
}

export type MeasuredTeachingSectionReplanOptions = SemanticPageCapacityOptions & {
  /** Only a controlled capacity handoff may replace an adopted measured plan. */
  allowAcceptedPlan?: boolean;
  /** Successfully generated content keeps its exact adopted outline. */
  lockedOutlineIds?: readonly string[];
  reason?: { category: 'page-capacity' | 'section-overload'; requestedPageCount?: number; detail?: string };
};

export type MeasuredTeachingSectionReplanResult =
  | { status: 'replanned'; outlines: SceneOutline[]; assessments: SemanticPageCapacityAssessment[] }
  | { status: 'unchanged'; reason?: string; assessments: SemanticPageCapacityAssessment[] }
  | { status: 'infeasible'; reason: string; assessments: SemanticPageCapacityAssessment[] };

/** Remeasure a complete section and redistribute only its unlocked intervals. */
export async function replanMeasuredTeachingSection(
  outlines: readonly SceneOutline[],
  options: MeasuredTeachingSectionReplanOptions = {},
): Promise<MeasuredTeachingSectionReplanResult> {
  const assessments = await Promise.all(outlines.map((outline) => evaluateSemanticPageCapacity(outline, options)));
  if (!outlines.length || outlines.some((outline) => outline.type !== 'slide'
    || !outline.lectureSectionId || outline.lectureSectionId !== outlines[0]?.lectureSectionId)) {
    return { status: 'infeasible', reason: 'Capacity replanning requires one complete teaching section.', assessments };
  }
  const locked = new Set(options.lockedOutlineIds ?? []);
  const lockedVersions = distinct(outlines.filter((outline) => locked.has(outline.id))
    .flatMap((outline) => outline.sectionPlanVersion ? [outline.sectionPlanVersion] : []));
  if (lockedVersions.length > 1) {
    return { status: 'infeasible', reason: 'Locked pages belong to incompatible section plan versions.', assessments };
  }
  const result: SceneOutline[] = [];
  for (let start = 0; start < outlines.length;) {
    if (locked.has(outlines[start]!.id)) { result.push(outlines[start]!); start += 1; continue; }
    let end = start + 1;
    while (end < outlines.length && !locked.has(outlines[end]!.id)) end += 1;
    const segment = outlines.slice(start, end);
    const measured = assessments.slice(start, end);
    const needsReplan = measured.some((assessment) => assessment.decision === 'page-overflow' || assessment.decision === 'section-overload');
    if (!needsReplan) result.push(...segment);
    else {
      const replanned = rebalanceMeasuredTeachingSection(segment, measured, { allowAcceptedPlan: options.allowAcceptedPlan });
      if (!replanned) return { status: 'infeasible', reason: 'A complete semantic unit cannot fit a measured page while preserving its observations and the section budget.', assessments };
      result.push(...replanned);
    }
    start = end;
  }
  if (result.length === outlines.length && result.every((outline, index) => outline === outlines[index])) {
    return { status: 'unchanged', assessments,
      ...(options.reason ? { reason: `The complete canonical contract fits its measured pages; ${options.reason.category} in an authored layout requires bounded regrouping, not a larger section budget or a forced ${options.reason.requestedPageCount ?? 'extra'}-page split.` } : {}) };
  }
  // A locked page's complete fingerprint must stay stable. Its adopted plan
  // version identifies the section family; revised unlocked page content is
  // still independently fingerprinted and the caller bounds recovery epochs.
  const version = lockedVersions[0] ?? createHash('sha256').update(JSON.stringify({
    policy: 'semantic-section-recovery-v1', sectionId: outlines[0]!.lectureSectionId,
    pages: result.map((outline) => ({ id: outline.id, sourcePageIds: outline.sourcePageIds,
      keyPoints: outline.keyPoints, targetDurationSec: outline.targetDurationSec, plannedTiming: outline.plannedTiming })),
  })).digest('hex').slice(0, 16);
  for (let index = 0; index < result.length; index += 1) {
    const outline = result[index]!;
    if (!locked.has(outline.id)) result[index] = { ...outline, sectionPlanVersion: version };
  }
  const verified = await Promise.all(result.map((outline) => evaluateSemanticPageCapacity(outline, options)));
  if (verified.some((assessment, index) => !locked.has(result[index]!.id)
    && (!assessment.selectedLayout?.fits || assessment.decision === 'measurement-unavailable'))) {
    return { status: 'infeasible', reason: 'The redistributed execution pages have no complete measured layout.', assessments: verified };
  }
  const fields = ['targetDurationSec', 'estimatedDuration'] as const;
  const timingFields = ['narrationSec', 'learnerActivitySec', 'transitionSec'] as const;
  if (!hasCompatibleOutlinePlan(outlines, result)
    || fields.some((field) => total(outlines, field) !== total(result, field))
    || timingFields.some((field) => outlines.reduce((sum, outline) => sum + (outline.plannedTiming?.[field] ?? 0), 0)
      !== result.reduce((sum, outline) => sum + (outline.plannedTiming?.[field] ?? 0), 0))) {
    return { status: 'infeasible', reason: 'Capacity replanning must preserve each section timing component exactly.', assessments: verified };
  }
  return { status: 'replanned', outlines: result, assessments: verified };
}
