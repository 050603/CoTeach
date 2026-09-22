'use client';

import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import {
  resolveVisualTarget,
  visualTargetRectToPercentageGeometry,
  type VisualTargetSelector,
} from '@openmaic/lib/utils/visual-target';

export interface VisualTargetGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  centerX: number;
  centerY: number;
}

interface UseVisualTargetGeometryOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  /** Explicit playback slide root. */
  rootRef: RefObject<HTMLElement | null>;
  elementId: string;
  selector?: VisualTargetSelector;
  /** Re-measure transforms driven by the editor/playback canvas scale. */
  canvasScale: number;
  /** Re-measure when rendered slide elements change. */
  contentRevision: unknown;
}

function sameGeometry(
  previous: VisualTargetGeometry | null,
  next: VisualTargetGeometry | null,
): boolean {
  if (previous === next) return true;
  if (!previous || !next) return false;
  return (
    previous.x === next.x &&
    previous.y === next.y &&
    previous.w === next.w &&
    previous.h === next.h &&
    previous.centerX === next.centerX &&
    previous.centerY === next.centerY
  );
}

export function useVisualTargetGeometry({
  containerRef,
  rootRef,
  elementId,
  selector,
  canvasScale,
  contentRevision,
}: UseVisualTargetGeometryOptions): VisualTargetGeometry | null {
  const [geometry, setGeometry] = useState<VisualTargetGeometry | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const canvasRoot = rootRef.current;
    if (!container || !canvasRoot || !elementId) {
      setGeometry((previous) => (previous === null ? previous : null));
      return null;
    }

    const resolved = resolveVisualTarget(canvasRoot, { elementId, selector });
    const next = resolved
      ? visualTargetRectToPercentageGeometry(
          container.getBoundingClientRect(),
          resolved.rect,
        )
      : null;
    if (!next || !resolved) {
      setGeometry((previous) => (previous === null ? previous : null));
      return null;
    }

    setGeometry((previous) => (sameGeometry(previous, next) ? previous : next));
    return resolved.observeElement;
  }, [containerRef, elementId, rootRef, selector]);

  useLayoutEffect(() => {
    let disposed = false;
    let frame = 0;
    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed) measure();
      });
    };

    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial geometry requires DOM measurement
    const observedTarget = measure();
    const container = containerRef.current;
    const canvasRoot = rootRef.current;
    const resizeObserver =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (resizeObserver && canvasRoot) resizeObserver.observe(canvasRoot);
    if (resizeObserver && container) resizeObserver.observe(container);
    if (resizeObserver && observedTarget) resizeObserver.observe(observedTarget);
    if (resizeObserver && canvasRoot) {
      for (const target of canvasRoot.querySelectorAll<HTMLElement>(
        '[data-slide-element-id], [data-slide-cell-id], .element-content',
      )) {
        resizeObserver.observe(target);
      }
    }

    window.addEventListener('resize', schedule);
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', schedule);
    void fonts?.ready.then(schedule);

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', schedule);
      fonts?.removeEventListener?.('loadingdone', schedule);
    };
  }, [measure, containerRef, rootRef, canvasScale, contentRevision]);

  return geometry;
}

/** Measure every rendered quote line in the overlay container's coordinate system. */
export function useVisualTargetFragmentGeometries({
  containerRef,
  rootRef,
  elementId,
  selector,
  canvasScale,
  contentRevision,
}: UseVisualTargetGeometryOptions): VisualTargetGeometry[] {
  const [geometries, setGeometries] = useState<VisualTargetGeometry[]>([]);
  const measure = useCallback(() => {
    const container = containerRef.current;
    const canvasRoot = rootRef.current;
    if (!container || !canvasRoot || !elementId) {
      setGeometries((previous) => previous.length ? [] : previous);
      return null;
    }
    const resolved = resolveVisualTarget(canvasRoot, { elementId, selector });
    const containerRect = container.getBoundingClientRect();
    const rects = resolved?.textRects?.length ? resolved.textRects : resolved ? [resolved.rect] : [];
    const next = rects
      .map((rect) => visualTargetRectToPercentageGeometry(containerRect, rect))
      .filter((item): item is VisualTargetGeometry => item !== null);
    setGeometries((previous) => (
      previous.length === next.length && previous.every((item, index) => sameGeometry(item, next[index] ?? null))
        ? previous
        : next
    ));
    return resolved?.observeElement ?? null;
  }, [containerRef, elementId, rootRef, selector]);

  useLayoutEffect(() => {
    let disposed = false;
    let frame = 0;
    const schedule = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!disposed) measure();
      });
    };
    // eslint-disable-next-line react-hooks/set-state-in-effect -- quote fragments require DOM measurement before paint
    const observedTarget = measure();
    const container = containerRef.current;
    const canvasRoot = rootRef.current;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    if (observer && canvasRoot) observer.observe(canvasRoot);
    if (observer && container) observer.observe(container);
    if (observer && observedTarget) observer.observe(observedTarget);
    window.addEventListener('resize', schedule);
    const fonts = document.fonts;
    fonts?.addEventListener?.('loadingdone', schedule);
    void fonts?.ready.then(schedule);
    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener('resize', schedule);
      fonts?.removeEventListener?.('loadingdone', schedule);
    };
  }, [measure, containerRef, rootRef, canvasScale, contentRevision]);
  return geometries;
}
