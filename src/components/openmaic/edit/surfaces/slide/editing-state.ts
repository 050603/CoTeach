import type { PPTElement } from '@openmaic/dsl';

/**
 * The single selected slide element — `undefined` unless exactly one element is
 * selected and it resolves in the content. The basis for the surface's
 * selection-anchored chrome (the text format bar, the image action bar).
 */
export function resolveSelectedElement(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
): PPTElement | undefined {
  if (activeElementIdList.length !== 1) return undefined;
  return elements.find((el) => el.id === activeElementIdList[0]);
}

/**
 * The slide surface's text-editing policy: a single selected text element is,
 * by definition, the element being edited (there is no separate
 * "selected-not-editing" state for text). Shape text enters editing explicitly,
 * through double click or the edit-text action, so selecting a shape still
 * allows moving and resizing it.
 *
 * This is the value the surface writes into the canvas store's
 * `editingElementId`, which the renderer's `TextElementOperate` reads to swap
 * its dashed select frame for a clean solid editing frame.
 */
export function resolveEditingElementId(
  activeElementIdList: readonly string[],
  elements: readonly PPTElement[],
  requestedElementId = '',
): string {
  const el = resolveSelectedElement(activeElementIdList, elements);
  if (!el || el.lock) return '';
  return el.type === 'text' || (el.type === 'shape' && el.id === requestedElementId)
    ? el.id : '';
}
