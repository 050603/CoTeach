import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { TeachingManuscript } from '@/lib/course-design/teaching-manuscript';
import type { SlideContentBinding } from '@openmaic/dsl';
import { adoptedPageAuthoringContent, pagePresentationContent } from './adopted-page-content';
import { buildSlideTargetInventory, isValidSlideVisualTarget } from './semantic-visual-cues';

/** Read only the actual compiled target; source metadata cannot supply hidden copy. */
function boundVisibleText(page: GeneratedSlideContent, binding: SlideContentBinding): string {
  if (!isValidSlideVisualTarget(page.elements, binding)) return '';
  const target = buildSlideTargetInventory(page.elements).find((item) => item.elementId === binding.elementId);
  if (!target) return '';
  const selector = binding.selector;
  if (selector?.quote) return selector.quote;
  if (selector && 'cellId' in selector) {
    return target.table?.rows.flatMap((row) => row.cells).find((cell) => cell.cellId === selector.cellId)?.text ?? '';
  }
  if (selector && 'rowIndex' in selector) {
    return target.table?.rows[selector.rowIndex]?.cells.map((cell) => cell.text).join('\n') ?? '';
  }
  return target.visibleText ?? '';
}

function compiledVisibleText(page: GeneratedSlideContent): string[] {
  const bound = (page.contentBindings ?? []).map((binding) => boundVisibleText(page, binding)).filter((text) => text.trim());
  // Saved strict projections still need their actual bound slots. Restored
  // native pages have optional provenance; their real canvas remains visible
  // even when no exact source-text binding was supplied.
  if (page.displayItems?.length || page.presentationProjection) return [...new Set(page.contentBindings
    ? bound : page.teachingText?.filter((text) => text.trim()) ?? [])];
  const actual = buildSlideTargetInventory(page.elements).filter((target) => {
    const element = page.elements.find((item) => item.id === target.elementId);
    return element?.type !== 'text' || element.textType !== 'title';
  }).map((target) => target.visibleText ?? '').filter((text) => text.trim());
  return [...new Set([...bound, ...actual, ...(!page.contentBindings ? page.teachingText ?? [] : [])])];
}

function hasNativeSourceDisplay(page: GeneratedSlideContent, sourceId: string): boolean {
  const displayIds = new Set(page.displayItems?.filter((item) => item.sourceContentIds.includes(sourceId))
    .map((item) => item.id));
  return Boolean(page.contentBindings?.some((binding) => (
    displayIds.size ? displayIds.has(binding.sourceContentId) : binding.sourceContentId === sourceId
  ) && boundVisibleText(page, binding).trim()));
}

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

/** Paginate display and redistribute existing speech references without rewriting it. */
export function expandCompiledSlidePages(
  outline: SceneOutline,
  content: GeneratedSlideContent,
  manuscripts?: readonly TeachingManuscript[],
): Array<{ outline: SceneOutline; content: GeneratedSlideContent }> {
  if (!content.continuationPages?.length) return [{ outline, content }];
  const { continuationPages, ...first } = content;
  const pages = [first, ...continuationPages];
  const refs = outline.teachingBrief?.manuscript;
  const plan = outline.teachingBrief?.teachingPlan;
  const displayText = (text: string) => text.replace(/\s+/gu, ' ').trim();
  const adoptedContent = adoptedPageAuthoringContent(outline);
  const sourceIdsByText = new Map(adoptedContent.map((item) => [displayText(item.text), item.id]));
  const pageItems = pages.map((page) => (plan?.presentationItems ?? []).filter((item) => {
    const visible = new Set((page.teachingText ?? []).map(displayText));
    const sourceId = sourceIdsByText.get(displayText(item.text));
    if (page.contentBindings && sourceId && hasNativeSourceDisplay(page, sourceId)) return true;
    if (page.contentBindings && (page.displayItems?.length || page.presentationProjection)) return false;
    for (const text of compiledVisibleText(page)) visible.add(displayText(text));
    const mappedIds = sourceId ? page.presentationProjection?.elementIdsBySource[sourceId] : undefined;
    const mappedDisplay = mappedIds?.some((id) => page.elements.some((element) => element.id === id
      && (element.type === 'text' || element.type === 'table' || element.type === 'shape' && element.text)));
    return Boolean(page.presentationProjection?.verified && mappedDisplay) || visible.has(displayText(item.text))
      || item.text.split('\n').filter((text) => text.trim()).every((text) => visible.has(displayText(text)));
  }));
  const segmentIds = [...new Set(refs?.segmentIds ?? [])];
  if (refs && manuscripts) {
    const manuscript = manuscripts.find((item) => item.sectionId === refs.sectionId);
    if (!manuscript || segmentIds.some((id) => !manuscript.segments.some((segment) => segment.id === id))) {
      throw new Error(`页面 ${outline.id} 的讲稿引用不属于已保存的小节正文`);
    }
    segmentIds.sort((left, right) => manuscript.segments.findIndex((segment) => segment.id === left)
      - manuscript.segments.findIndex((segment) => segment.id === right));
  }
  const pageSegments = pages.map(() => [] as string[]);
  // A complete diagram can move ahead of its text notes when a page is split.
  // Keep the original explanation with that visual, then show notes silently.
  const completeDiagramFirst = Boolean(refs && outline.visualIntent?.diagram?.nodes.length
    && outline.visualIntent.diagram.nodes.every((node) => pages[0]!.sourceGroupIds?.includes(`diagram-node:${node.id}`)));
  let previous = 0;
  for (const id of segmentIds) {
    // Match display items to their existing node IDs, never display words to
    // speech. An unbound oral passage follows its preceding passage intact.
    const bound = pageItems.findIndex((items) => items.some((item) => item.nodeIds.includes(id)));
    const destination = completeDiagramFirst ? 0 : Math.max(previous, bound);
    pageSegments[destination]!.push(id);
    previous = destination;
  }
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
    const visible = compiledVisibleText(page);
    if (!visible.length && (!refs || !page.elements.length)) throw new Error(`拆分页 ${id} 缺少教学内容分组`);
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
    const local: SceneOutline = {
      ...outline, id,
      sourcePageIds: outline.sourcePageIds ?? [outline.spatialParentId ?? outline.id],
      spatialParentId: outline.spatialParentId ?? outline.id,
      spatialSourceContext: outline.spatialSourceContext ?? {
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
        resourceRefs: outline.visualIntent.resourceRefs?.filter((resource) => mediaIds.has(resource.resourceId)),
        // The diagram has already been compiled; do not require its nodes on siblings.
        diagram: undefined,
      } : undefined,
      teachingBrief: outline.teachingBrief ? {
        ...outline.teachingBrief,
        ...(refs ? { explanation: '', authoring: undefined } : {}),
        ...(outline.teachingBrief.manuscript ? { manuscript: {
          ...outline.teachingBrief.manuscript,
          segmentIds: pageSegments[index]!,
        } } : {}),
        resourceNeeds: outline.teachingBrief.resourceNeeds?.filter((need) =>
          need.kind !== 'source-image' || Boolean(need.assetId && mediaIds.has(need.assetId))),
        teachingPlan: plan ? {
          ...plan,
          visibleContent: visible,
          ...(refs || page.contentBindings ? { presentationItems: pageItems[index] } : {}),
          ...(plan.presentationContent?.length ? { presentationContent: page.contentBindings && !plan.presentationItems?.length
            ? adoptedContent.filter((item) => hasNativeSourceDisplay(page, item.id)).map((item) => item.text) : visible } : {}),
          newContent: refs ? '' : visible.join('；'),
          narrationFocus: refs ? [] : [`只展开本页内容，原教学解释作为连续讲解背景，不逐页重复。`, ...visible],
          takeaway: visible.join('；'),
          introduces: refs ? pageSegments[index]! : index === 0 ? plan.introduces : [],
          deepens: refs ? [] : index === 0 ? plan.deepens : [],
          references: index === 0 ? plan.references : [...new Set([
            ...(plan.references ?? []), ...(plan.introduces ?? []), ...(plan.deepens ?? []),
          ])],
          ...(index > 0 ? { entryPoint: refs ? undefined : { kind: 'continuation' as const,
            object: visible[0]!, bridge: '沿前页的解释继续展开当前内容。' } } : {}),
        } : undefined,
      } : undefined,
    };
    // Each continuation owns a smaller display catalog. Rebind host mappings
    // to its new source and semantic identities without rewriting display text.
    if (page.contentBindings || refs && page.presentationProjection?.verified) {
      const localIds = new Map(adoptedPageAuthoringContent(local).flatMap((item) => {
        const parentId = sourceIdsByText.get(displayText(item.text));
        return parentId ? [[parentId, item.id] as const] : [];
      }));
      const parentSemanticIds = new Map(pagePresentationContent(outline).map((text, index) =>
        [displayText(text), `${outline.id}:visible-${index + 1}`]));
      const localSemanticIds = new Map(pagePresentationContent(local).flatMap((text, index) => {
        const parentId = parentSemanticIds.get(displayText(text));
        return parentId ? [[parentId, `${local.id}:visible-${index + 1}`] as const] : [];
      }));
      const rebaseSource = (source: string): string | undefined => localIds.get(source) ?? localSemanticIds.get(source)
        ?? (source.startsWith('adopted-content-') || source.startsWith(`${outline.id}:visible-`) ? undefined : source);
      const projection = page.presentationProjection;
      const items = projection?.items.map((item) => ({ ...item,
        sourceContentIds: [...new Set(item.sourceContentIds.flatMap((id) => localIds.has(id) ? [localIds.get(id)!] : []))],
      })).filter((item) => item.sourceContentIds.length);
      const mapping = projection ? Object.fromEntries(Object.entries(projection.elementIdsBySource).flatMap(([source, ids]) => {
        const rebased = rebaseSource(source);
        return rebased ? [[rebased, ids]] : [];
      })) : undefined;
      return { outline: local, content: { ...page,
        sourceGroupIds: page.sourceGroupIds?.map((id) => localIds.get(id) ?? id),
        ...(page.contentBindings ? { contentBindings: page.contentBindings.flatMap((binding) => {
          const sourceContentId = rebaseSource(binding.sourceContentId);
          return sourceContentId ? [{ ...binding, sourceContentId }] : [];
        }) } : {}),
        ...(page.displayItems ? { displayItems: page.displayItems.map((item) => ({ ...item,
          sourceContentIds: [...new Set(item.sourceContentIds.flatMap((source) => {
            const rebased = rebaseSource(source);
            return rebased ? [rebased] : [];
          }))],
        })).filter((item) => item.sourceContentIds.length) } : {}),
        ...(projection && items && mapping ? {
          presentationProjection: { ...projection, items, elementIdsBySource: mapping },
        } : {}),
      } };
    }
    return { outline: local, content: page };
  });
}
