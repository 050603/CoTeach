import type { Action, SpeechAnchor, VisualTargetSelector } from '@openmaic/lib/types/action';
import type { GeneratedSlideContent, SceneOutline } from '@openmaic/lib/types/generation';
import type { PPTElement } from '@openmaic/dsl';
import { buildSlideTargetInventory, extractVisibleElementText, isValidSlideVisualTarget } from '@openmaic/lib/generation/semantic-visual-cues';

type Target = { elementId: string; selector?: VisualTargetSelector };
const compact = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu, '');
const unique = (targets: Target[]) => [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()];
const rendered = (elements: readonly PPTElement[], target: Target) => {
  const element = elements.find((item) => item.id === target.elementId);
  return element && (!('opacity' in element) || element.opacity !== 0)
    && element.width > 0 && ('height' in element ? element.height > 0 : true)
    && isValidSlideVisualTarget(elements, target);
};

function textAt(elements: readonly PPTElement[], target: Target): string {
  if (!rendered(elements, target)) return '';
  const item = buildSlideTargetInventory(elements).find((entry) => entry.elementId === target.elementId);
  const selector = target.selector;
  if (selector?.quote) return selector.quote;
  if (selector && 'cellId' in selector) return item?.table?.rows.flatMap((row) => row.cells)
    .find((cell) => cell.cellId === selector.cellId)?.text ?? '';
  if (selector && 'rowIndex' in selector) return item?.table?.rows[selector.rowIndex]?.cells
    .map((cell) => cell.text).join('\n') ?? '';
  return item?.visibleText ?? '';
}

function sameSlot(left?: VisualTargetSelector, right?: VisualTargetSelector): boolean {
  if (!left) return true;
  if (!right) return false;
  if ('cellId' in left) return 'cellId' in right && left.cellId === right.cellId;
  if ('rowIndex' in left) return 'rowIndex' in right && left.rowIndex === right.rowIndex;
  return left.quote === right.quote && left.occurrence === right.occurrence;
}

function sourceIds(content: GeneratedSlideContent, target: Target): Set<string> {
  return new Set((content.contentBindings ?? []).filter((binding) => binding.elementId === target.elementId
    && sameSlot(target.selector, binding.selector) && isValidSlideVisualTarget(content.elements, binding))
    .flatMap((binding) => [binding.sourceContentId,
      ...(content.displayItems?.find((item) => item.id === binding.sourceContentId)?.sourceContentIds ?? [])]));
}

/** Exact visible wording or a unique exact narration phrase can refine optional
 * provenance. A binding alone never establishes a meaningful rendered target. */
function choose(targets: Target[], elements: PPTElement[], oldText: string, anchor?: SpeechAnchor): Target | undefined {
  const valid = unique(targets).filter((target) => rendered(elements, target) && textAt(elements, target).trim());
  const exact = valid.filter((target) => compact(textAt(elements, target)) === compact(oldText) && compact(oldText));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const phrase = compact(anchor?.quote ?? '');
  if (phrase.length >= 6) {
    const anchored = valid.filter((target) => compact(textAt(elements, target)).includes(phrase));
    if (anchored.length) return anchored.length === 1 ? anchored[0] : undefined;
  }
  const original = compact(oldText);
  const contained = original.length >= 6 ? valid.filter((target) => compact(textAt(elements, target)).includes(original)) : [];
  return contained.length === 1 ? contained[0] : undefined;
}

/** Rebind only visual addresses. Narration, audio, timing, anchors, whiteboards
 * and every other action field are kept byte-for-byte as stored. */
export function rebindSlideVisualActions(input: {
  outline: SceneOutline;
  before: GeneratedSlideContent;
  after: GeneratedSlideContent;
  actions: readonly Action[];
}): { actions: Action[]; diagnostics: string[]; essentialUnresolved: boolean } {
  const { outline, before, after } = input;
  const diagnostics: string[] = [];
  let essentialUnresolved = false;
  const inventory = buildSlideTargetInventory(after.elements);
  const candidates = (original?: VisualTargetSelector): Target[] => inventory.flatMap<Target>((item) => {
    if (original && 'cellId' in original) return item.table?.rows.flatMap((row) => row.cells
      .map((cell) => ({ elementId: item.elementId, selector: { cellId: cell.cellId } }))) ?? [];
    if (original && 'rowIndex' in original) return item.table?.rows.map((row) => ({
      elementId: item.elementId, selector: { rowIndex: row.rowIndex },
    })) ?? [];
    return [{ elementId: item.elementId, ...(original?.quote ? { selector: original } : {}) }];
  });
  const target = (original: Target, anchor?: SpeechAnchor): Target | undefined => {
    if (!rendered(before.elements, original)) return undefined;
    const previous = before.elements.find((element) => element.id === original.elementId)!;
    if (previous.type === 'image' || previous.type === 'video') {
      const matches = after.elements.filter((element) => rendered(after.elements, { elementId: element.id })
        && (element.type === 'image' || element.type === 'video') && element.type === previous.type
        && element.src === previous.src
        && (previous.type !== 'video' || element.type === 'video' && element.mediaRef === previous.mediaRef));
      return matches.length === 1 ? { elementId: matches[0].id } : undefined;
    }
    const oldText = textAt(before.elements, original);
    const ids = sourceIds(before, original);
    if (ids.size) {
      const displayIds = new Set(after.displayItems?.filter((item) => item.sourceContentIds.some((id) => ids.has(id)))
        .map((item) => item.id));
      const bound = (after.contentBindings ?? []).filter((binding) => (ids.has(binding.sourceContentId)
        || displayIds.has(binding.sourceContentId)) && isValidSlideVisualTarget(after.elements, binding))
        .map(({ elementId, selector }) => ({ elementId, ...(selector ? { selector } : {}) }));
      const mapped = choose(bound, after.elements, oldText, anchor);
      if (mapped) return mapped;
    }
    const nodes = outline.visualIntent?.diagram?.nodes.filter((node) => original.elementId.endsWith(`-node-${node.id}`)
      || compact(node.label) === compact(oldText)) ?? [];
    if (nodes.length === 1) {
      const node = nodes[0];
      const bound = (after.contentBindings ?? []).filter((binding) => binding.sourceContentId === `diagram-node:${node.id}`);
      const canonical = after.elements.filter((element) => element.id.endsWith(`-node-${node.id}`))
        .map((element) => ({ elementId: element.id }));
      const mapped = choose([...bound, ...canonical], after.elements, node.label, anchor);
      if (mapped) return mapped;
    }
    // Native free composition may omit all provenance. Compare actual visible
    // slots, including precise table cells/rows, without requiring a projection.
    const mapped = choose(candidates(original.selector), after.elements, oldText, anchor);
    if (mapped) return mapped;
    const next = after.elements.find((element) => element.id === original.elementId);
    if (next && JSON.stringify(previous) === JSON.stringify(next)
      && rendered(after.elements, original)
      && (!ids.size || [...sourceIds(after, original)].some((id) => ids.has(id)))) return original;
    if (previous.type === 'chart' && next?.type === 'chart' && previous.chartType === next.chartType
      && JSON.stringify(previous.data) === JSON.stringify(next.data)
      && extractVisibleElementText(previous) === extractVisibleElementText(next)) return original;
    return undefined;
  };
  const actions = input.actions.flatMap((original): Action[] => {
    if (original.type !== 'spotlight' && original.type !== 'laser') return [structuredClone(original)];
    const primary = target(original, original.speechAnchor);
    const waypoints = original.type === 'laser' ? original.waypoints?.map((point) => {
      const mapped = target(point, point.speechAnchor);
      return mapped ? { ...structuredClone(point), ...mapped, selector: mapped.selector } : undefined;
    }) : undefined;
    if (!primary || waypoints?.some((point) => !point)) {
      const essential = original.necessity === 'essential';
      essentialUnresolved ||= essential;
      diagnostics.push(`PPT redraw visual cue ${original.id}: no unique actual visual target; ${essential
        ? 'retained the saved slide and its essential cue' : 'omitted this optional cue'}.`);
      return [];
    }
    return [{ ...structuredClone(original), ...primary, selector: primary.selector,
      ...(waypoints ? { waypoints } : {}) } as Action];
  });
  return { actions, diagnostics, essentialUnresolved };
}
