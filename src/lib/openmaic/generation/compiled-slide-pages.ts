import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { TeachingVisualComponentKind } from '@openmaic/dsl';

const componentRepresentation: Record<TeachingVisualComponentKind, NonNullable<SceneOutline['visualIntent']>['representation']> = {
  'state-change': 'native-diagram', process: 'native-diagram', causal: 'native-diagram', structure: 'native-diagram',
  comparison: 'table', 'annotated-image': 'mixed', data: 'native-chart', 'worked-example': 'native-diagram', text: 'text',
};

/** Integer shares preserve every second of the adopted teaching budget. */
function share(total: number | undefined, index: number, count: number): number | undefined {
  if (total === undefined) return undefined;
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
}

function weightedShares(total: number | undefined, pages: readonly GeneratedSlideContent[]): Array<number | undefined> {
  if (total === undefined) return pages.map(() => undefined);
  const weights = pages.map((page) => page.layoutMeasurement?.contentLoad);
  if (weights.some((weight) => weight === undefined || !Number.isFinite(weight) || weight <= 0)) {
    return pages.map((_, index) => share(total, index, pages.length));
  }
  const sum = weights.reduce<number>((value, weight) => value + weight!, 0);
  const quotas = weights.map((weight) => total * weight! / sum);
  const result = quotas.map(Math.floor);
  const remainder = total - result.reduce((value, current) => value + current, 0);
  const order = quotas.map((quota, index) => ({ index, fraction: quota - Math.floor(quota) }))
    .sort((left, right) => right.fraction - left.fraction || left.index - right.index);
  for (let index = 0; index < remainder; index += 1) {
    result[order[index]!.index]! += 1;
  }
  return result;
}

/** Expand first-pass layout output before the section's narration is authored. */
export function expandCompiledSlidePages(
  outline: SceneOutline,
  content: GeneratedSlideContent,
): Array<{ outline: SceneOutline; content: GeneratedSlideContent }> {
  if (!content.continuationPages?.length) return [{ outline, content }];
  const { continuationPages, ...first } = content;
  const pages = [first, ...continuationPages];
  const total = outline.targetDurationSec ?? outline.estimatedDuration;
  if (total !== undefined && total < pages.length) {
    throw new Error(`页面 ${outline.id} 的教学时间不足以容纳 ${pages.length} 个内容分组`);
  }
  const durationShares = weightedShares(total, pages);
  const narrationShares = weightedShares(outline.plannedTiming?.narrationSec, pages);
  const activityShares = weightedShares(outline.plannedTiming?.learnerActivitySec, pages);
  const transitionShares = weightedShares(outline.plannedTiming?.transitionSec, pages);
  return pages.map((page, index) => {
    const id = index === 0 ? outline.id : `${outline.id}--continuation-${index + 1}`;
    const visible = page.teachingText?.filter((text) => text.trim()) ?? [];
    if (!visible.length) throw new Error(`拆分页 ${id} 缺少教学内容分组`);
    const mediaIds = new Set(page.elements.flatMap((element) =>
      element.type === 'image' || element.type === 'video'
        ? [element.id, element.src, (element as unknown as { resourceId?: string }).resourceId,
          element.type === 'video' ? element.mediaRef : undefined] : []));
    const plannedTiming = outline.plannedTiming ? {
      ...outline.plannedTiming,
      narrationSec: narrationShares[index]!,
      learnerActivitySec: activityShares[index]!,
      transitionSec: transitionShares[index]!,
    } : undefined;
    const duration = plannedTiming
      ? plannedTiming.narrationSec + plannedTiming.learnerActivitySec + plannedTiming.transitionSec
      : durationShares[index];
    const plan = outline.teachingBrief?.teachingPlan;
    const visual = page.teachingVisual;
    const originalSources = visual?.sourceCatalog?.filter((source) => page.sourceGroupIds?.includes(source.id));
    const displayItems = page.presentationProjection?.items ?? [];
    const display = visual ? [...new Set(displayItems.map((item) => [item.row, item.column, item.label, item.text].filter(Boolean).join('：')))] : visible;
    const visualPage = visual?.scene.pages.find((part) => part.id === visual.pageId);
    const ownsAdoptedDiagram = visualPage?.components.some((component) => component.useAdoptedDiagram) === true;
    const graphSibling = Boolean(visualPage && outline.visualIntent?.diagram && !ownsAdoptedDiagram);
    const localRepresentations = [...new Set(visualPage?.components.map((component) => componentRepresentation[component.kind]) ?? [])];
    const originalItemNodes = (sourceIds: string[]) => [...new Set(sourceIds.flatMap((sourceId) => {
      const source = visual?.sourceCatalog?.find((entry) => entry.id === sourceId);
      return source ? plan?.presentationItems?.filter((item) => item.text.trim() === source.text.trim()).flatMap((item) => item.nodeIds) ?? [] : [];
    }))];
    const localNodeIds = originalItemNodes(page.sourceGroupIds ?? []);
    const local: SceneOutline = {
      ...outline, id,
      ...(visualPage ? { title: visualPage.title } : {}),
      // An explicit empty catalog is a real figure-only duty, not permission
      // to inherit the parent's textual facts on this page.
      ...(visual ? { visualSourceCatalog: originalSources ?? [] } : {}),
      sourcePageIds: outline.sourcePageIds ?? [outline.spatialParentId ?? outline.id],
      spatialParentId: outline.spatialParentId ?? outline.id,
      spatialSourceContext: outline.spatialSourceContext ? { ...outline.spatialSourceContext,
        title: outline.spatialSourceContext.title ?? outline.title } : {
        title: outline.title,
        description: outline.description,
        teachingObjective: outline.teachingObjective,
        coreMessage: plan?.newContent ?? outline.description,
      },
      segmentGroupId: outline.id, segmentIndex: index + 1, segmentCount: pages.length,
      segmentRole: visible.join('；'),
      description: `本页观察与解释：${visible.join('；')}`,
      keyPoints: visible,
      targetDurationSec: duration, estimatedDuration: duration,
      plannedTiming, timingPlan: undefined,
      mediaGenerations: outline.mediaGenerations?.filter((request) => mediaIds.has(request.elementId)),
      visualIntent: outline.visualIntent ? {
        ...outline.visualIntent,
        ...(graphSibling ? { observationGoal: visualPage!.focus,
          representation: localRepresentations.length === 1 ? localRepresentations[0]! : 'mixed' as const } : {}),
        resourceRefs: outline.visualIntent.resourceRefs?.filter((resource) => mediaIds.has(resource.resourceId)),
        // Retain the adopted graph on its actual host for audits and regeneration.
        // Siblings own only their local source duties.
        diagram: ownsAdoptedDiagram ? outline.visualIntent.diagram : undefined,
      } : undefined,
      teachingBrief: outline.teachingBrief ? {
        ...outline.teachingBrief,
        resourceNeeds: outline.teachingBrief.resourceNeeds?.filter((need) =>
          need.kind !== 'source-image' || Boolean(need.assetId && mediaIds.has(need.assetId))),
        teachingPlan: plan ? {
          ...plan,
          ...(graphSibling ? { visualRelationship: undefined } : {}),
          visibleContent: visual ? display : visible,
          ...(plan.presentationContent?.length ? { presentationContent: visual ? display : visible } : {}),
          ...(visual && plan.presentationItems ? { presentationItems: displayItems.map((item) => ({ role: 'key-point' as const,
            text: [item.row, item.column, item.label, item.text].filter(Boolean).join('：'), nodeIds: originalItemNodes(item.sourceContentIds) })) } : {}),
          newContent: visual ? plan.newContent : visible.join('；'),
          narrationFocus: [`只展开本页内容，原教学解释作为连续讲解背景，不逐页重复。`, ...visible],
          takeaway: visible.join('；'),
          introduces: visual && (localNodeIds.length || !ownsAdoptedDiagram) ? plan.introduces?.filter((id) => localNodeIds.includes(id)) : index === 0 ? plan.introduces : [],
          deepens: visual && (localNodeIds.length || !ownsAdoptedDiagram) ? plan.deepens?.filter((id) => localNodeIds.includes(id)) : index === 0 ? plan.deepens : [],
          references: index === 0 ? plan.references : [...new Set([
            ...(plan.references ?? []), ...(plan.introduces ?? []), ...(plan.deepens ?? []),
          ])],
          ...(index > 0 ? { entryPoint: { kind: 'continuation' as const,
            object: visible[0]!, bridge: '沿前页的解释继续展开当前内容。' } } : {}),
        } : undefined,
      } : undefined,
    };
    return { outline: local, content: page };
  });
}
