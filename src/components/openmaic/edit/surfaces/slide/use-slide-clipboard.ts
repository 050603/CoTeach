'use client';

import { useEffect, type RefObject } from 'react';
import {
  copySlideElements,
  cutSlideElements,
  pasteSlideElements,
  SLIDE_CLIPBOARD_MIME,
} from '@openmaic/lib/edit/slide-clipboard';
import { useCanvasStore } from '@openmaic/lib/store/canvas';

export function isTextInput(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest(
    'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
  );
}

/** Native clipboard events work without async clipboard permissions, including HTTP. */
export function useSlideClipboard(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const handleClipboard = (event: ClipboardEvent) => {
      const canvas = useCanvasStore.getState();
      const inCanvas = rootRef.current?.contains(event.target as Node);
      // Closing a portaled context menu can return focus to the document body.
      const afterCanvasMenu = event.target === document.body && canvas.editorAreaFocus;
      if (event.defaultPrevented || (!inCanvas && !afterCanvasMenu)
        || isTextInput(event.target) || canvas.pickTarget) return;
      // Preserve ordinary text copied from a control or other browser selection.
      if (event.type !== 'paste' && window.getSelection()?.isCollapsed === false) return;
      let handled = false;
      if (event.type === 'copy') handled = copySlideElements(event.clipboardData ?? undefined);
      if (event.type === 'cut') handled = cutSlideElements(event.clipboardData ?? undefined);
      if (event.type === 'paste' && event.clipboardData) {
        handled = pasteSlideElements(event.clipboardData.getData(SLIDE_CLIPBOARD_MIME)
          || event.clipboardData.getData('text/plain'));
      }
      if (handled) event.preventDefault();
    };
    document.addEventListener('copy', handleClipboard);
    document.addEventListener('cut', handleClipboard);
    document.addEventListener('paste', handleClipboard);
    return () => {
      document.removeEventListener('copy', handleClipboard);
      document.removeEventListener('cut', handleClipboard);
      document.removeEventListener('paste', handleClipboard);
    };
  }, [rootRef]);
}
