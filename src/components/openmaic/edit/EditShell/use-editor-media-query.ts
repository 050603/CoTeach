'use client';

import { useCallback, useSyncExternalStore } from 'react';

const serverSnapshot = () => false;

/** CSS-sized rails also need a matching collapsed state for accessible controls. */
export function useEditorMediaQuery(query: string): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => {};
    const media = window.matchMedia(query);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, [query]);
  const getSnapshot = useCallback(
    () => typeof window.matchMedia === 'function' && window.matchMedia(query).matches,
    [query],
  );
  return useSyncExternalStore(subscribe, getSnapshot, serverSnapshot);
}
