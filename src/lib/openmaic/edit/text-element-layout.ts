import type { PPTTextElement } from '@openmaic/dsl';

/** Read unscaled DOM geometry only when committing an actual text/resize edit. */
export function measureTextElement(
  node: HTMLElement | null,
  vertical?: boolean,
): Partial<Pick<PPTTextElement, 'width' | 'height'>> {
  if (!node?.isConnected) return {};
  const size = vertical ? node.offsetWidth : node.offsetHeight;
  // Hidden/detached canvases cannot supply an authoring measurement.
  if (!Number.isFinite(size) || size <= 0) return {};
  return vertical ? { width: size } : { height: size };
}
