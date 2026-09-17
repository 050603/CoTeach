'use client';

import { useCallback, useLayoutEffect, useState, type RefObject } from 'react';
import type { PercentageGeometry } from '../utils/geometry';
import {
  resolveVisualTarget,
  resolveVisualTargetGeometry,
  type VisualTarget,
} from '../utils/visualTarget';

function sameGeometry(a: PercentageGeometry | null, b: PercentageGeometry | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

export function useVisualTargetGeometry(
  rootRef: RefObject<HTMLElement | null> | undefined,
  target: VisualTarget | undefined,
): PercentageGeometry | null {
  const [geometry, setGeometry] = useState<PercentageGeometry | null>(null);
  const elementId = target?.elementId;
  const cellId = target?.selector && 'cellId' in target.selector
    ? target.selector.cellId
    : undefined;
  const quote = target?.selector?.quote;
  const occurrence = target?.selector?.occurrence;

  const getRoot = useCallback(() => rootRef?.current ?? null, [rootRef]);

  const measure = useCallback(() => {
    const root = getRoot();
    if (!root || !elementId) {
      setGeometry((previous) => (previous === null ? previous : null));
      return;
    }
    const selector = cellId !== undefined
      ? { cellId, quote, occurrence }
      : quote !== undefined
        ? { quote, occurrence }
        : undefined;
    const next = resolveVisualTargetGeometry(root, { elementId, selector });
    setGeometry((previous) => (sameGeometry(previous, next) ? previous : next));
  }, [cellId, elementId, getRoot, occurrence, quote]);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- measure before paint so a newly selected cue never flashes at the previous target
    measure();
    const root = getRoot();
    if (!root || !elementId) return;

    const observer = typeof ResizeObserver === 'undefined'
      ? undefined
      : new ResizeObserver(measure);
    observer?.observe(root);
    const selector = cellId !== undefined
      ? { cellId, quote, occurrence }
      : quote !== undefined
        ? { quote, occurrence }
        : undefined;
    const resolved = resolveVisualTarget(root, { elementId, selector });
    if (resolved && resolved.observeElement !== root) observer?.observe(resolved.observeElement);

    window.addEventListener('resize', measure);
    const fonts = root.ownerDocument.fonts;
    let cancelled = false;
    void fonts?.ready.then(() => {
      if (!cancelled) measure();
    });
    fonts?.addEventListener?.('loadingdone', measure);

    return () => {
      cancelled = true;
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      fonts?.removeEventListener?.('loadingdone', measure);
    };
  }, [cellId, elementId, getRoot, measure, occurrence, quote]);

  return geometry;
}

/** Resolve up to four ordered laser waypoints without creating variable hook counts. */
export function useVisualTargetPathGeometry(
  rootRef: RefObject<HTMLElement | null> | undefined,
  targets: readonly VisualTarget[] | undefined,
): PercentageGeometry[] | null {
  const first = useVisualTargetGeometry(rootRef, targets?.[0]);
  const second = useVisualTargetGeometry(rootRef, targets?.[1]);
  const third = useVisualTargetGeometry(rootRef, targets?.[2]);
  const fourth = useVisualTargetGeometry(rootRef, targets?.[3]);
  if (!targets || targets.length === 0) return [];
  const resolved = [first, second, third, fourth].slice(0, targets.length);
  return resolved.every((geometry): geometry is PercentageGeometry => geometry !== null)
    ? resolved
    : null;
}
