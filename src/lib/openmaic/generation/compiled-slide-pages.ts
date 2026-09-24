import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';

/** Integer shares preserve every second of the adopted teaching budget. */
function share(total: number | undefined, index: number, count: number): number | undefined {
  if (total === undefined) return undefined;
  return Math.floor(total / count) + (index < total % count ? 1 : 0);
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
      narrationSec: share(outline.plannedTiming.narrationSec, index, pages.length)!,
      learnerActivitySec: share(outline.plannedTiming.learnerActivitySec, index, pages.length)!,
      transitionSec: share(outline.plannedTiming.transitionSec, index, pages.length)!,
    } : undefined;
    const duration = plannedTiming
      ? plannedTiming.narrationSec + plannedTiming.learnerActivitySec + plannedTiming.transitionSec
      : share(total, index, pages.length);
    const plan = outline.teachingBrief?.teachingPlan;
    const local: SceneOutline = {
      ...outline, id,
      spatialParentId: outline.spatialParentId ?? outline.id,
      spatialSourceContext: outline.spatialSourceContext ?? {
        description: outline.description,
        teachingObjective: outline.teachingObjective,
        coreMessage: plan?.newContent ?? outline.description,
      },
      segmentGroupId: outline.id, segmentIndex: index + 1, segmentCount: pages.length,
      segmentRole: visible.join('；'),
      description: `连续讲解第 ${index + 1}/${pages.length} 页。本页观察与解释：${visible.join('；')}`,
      keyPoints: visible,
      targetDurationSec: duration, estimatedDuration: duration,
      plannedTiming, timingPlan: undefined,
      mediaGenerations: outline.mediaGenerations?.filter((request) => mediaIds.has(request.elementId)),
      visualIntent: outline.visualIntent ? {
        ...outline.visualIntent,
        resourceRefs: outline.visualIntent.resourceRefs?.filter((resource) => mediaIds.has(resource.resourceId)),
        // The diagram has already been compiled; do not require its nodes on siblings.
        diagram: undefined,
      } : undefined,
      teachingBrief: outline.teachingBrief ? {
        ...outline.teachingBrief,
        teachingPlan: plan ? {
          ...plan,
          visibleContent: visible,
          newContent: visible.join('；'),
          narrationFocus: [`只展开本页内容，原教学解释作为连续讲解背景，不逐页重复。`, ...visible],
          takeaway: visible.join('；'),
          ...(index > 0 ? { entryPoint: { kind: 'continuation' as const,
            object: visible[0]!, bridge: '沿前页的解释继续展开当前内容。' } } : {}),
        } : undefined,
      } : undefined,
    };
    return { outline: local, content: page };
  });
}
