import type { PPTElement } from '@openmaic/dsl';

/**
 * Resolve one selected element or an explicitly handled member of one group.
 * A group member keeps the renderer's group selection for geometry gestures
 * while its text and image controls apply only to that member.
 */
export function resolveSelectedElement(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
  activeGroupElementId?: string,
): PPTElement | undefined {
  if (activeGroupElementId && activeElementIdList.includes(activeGroupElementId)) {
    const member = elements.find((element) => element.id === activeGroupElementId);
    if (member?.groupId && activeElementIdList.every((id) =>
      elements.find((element) => element.id === id)?.groupId === member.groupId,
    )) return member;
  }
  if (activeElementIdList.length !== 1) return undefined;
  return elements.find((el) => el.id === activeElementIdList[0]);
}

/**
 * The slide surface's text-editing policy: a single selected text element is,
 * by definition, the element being edited, including a handled group member (there is no separate
 * "selected-not-editing" state for text). Anything else resolves to "".
 *
 * This is the value the surface writes into the canvas store's
 * `editingElementId`, which the renderer's `TextElementOperate` reads to swap
 * its dashed select frame for a clean solid editing frame.
 */
export function resolveEditingElementId(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
  activeGroupElementId?: string,
): string {
  const el = resolveSelectedElement(activeElementIdList, elements, activeGroupElementId);
  return el?.type === 'text' ? el.id : '';
}
