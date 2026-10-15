'use client';

import { useRef, useEffect, useCallback } from 'react';
import { useHistorySnapshot } from '@openmaic/lib/hooks/use-history-snapshot';
import { measureTextElement } from '@openmaic/lib/edit/text-element-layout';
import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../hooks/useElementShadow';
import { ElementOutline } from '../ElementOutline';
import { ProsemirrorEditor } from '../ProsemirrorEditor';
import { useCanvasOperations } from '@openmaic/lib/hooks/use-canvas-operations';

export interface TextElementProps {
  elementInfo: PPTTextElement;
  selectElement?: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTTextElement,
    canMove?: boolean,
  ) => void;
}

function isEmptyText(content: string) {
  const document = new DOMParser().parseFromString(content, 'text/html');
  return !document.body.textContent?.replace(/\u00a0/g, ' ').trim();
}

/**
 * Editable text element component
 * Includes auto-height adjustment and empty text cleanup
 */
export function TextElement({ elementInfo, selectElement }: TextElementProps) {
  const { updateElement, deleteElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  const elementRef = useRef<HTMLDivElement>(null);
  const currentElementRef = useRef(elementInfo);
  currentElementRef.current = elementInfo;
  const deleteElementRef = useRef(deleteElement);
  deleteElementRef.current = deleteElement;
  const clearedByUserRef = useRef(false);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelEmptyCleanup = useCallback(() => {
    if (cleanupTimerRef.current !== null) clearTimeout(cleanupTimerRef.current);
    cleanupTimerRef.current = null;
  }, []);

  useEffect(() => cancelEmptyCleanup, [cancelEmptyCleanup]);

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent, canMove = true) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo, canMove);
  };

  // ProseMirror has already updated its DOM here. Commit the content and its
  // natural size together so a single undo restores the original geometry.
  // Mounting, font loading and external undo/redo never enter this callback.
  const updateContent = useCallback(
    (content: string, ignore = false) => {
      cancelEmptyCleanup();
      clearedByUserRef.current = isEmptyText(content);
      updateElement({
        id: elementInfo.id,
        props: { content, ...measureTextElement(elementRef.current, elementInfo.vertical) },
      });

      if (!ignore) addHistorySnapshot();
    },
    [elementInfo.id, elementInfo.vertical, updateElement, addHistorySnapshot, cancelEmptyCleanup],
  );

  const cleanupEmptyText = useCallback(() => {
    cancelEmptyCleanup();
    if (!clearedByUserRef.current || !elementRef.current?.isConnected) return;
    cleanupTimerRef.current = setTimeout(() => {
      cleanupTimerRef.current = null;
      const current = currentElementRef.current;
      if (clearedByUserRef.current && elementRef.current?.isConnected
        && !current.lock && isEmptyText(current.content)) deleteElementRef.current(current.id);
    }, 300);
  }, [cancelEmptyCleanup]);

  return (
    <div
      className={`editable-element-text absolute ${elementInfo.lock ? 'lock' : ''}`}
      style={{
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper w-full h-full"
        style={{ transform: `rotate(${elementInfo.rotate}deg)` }}
      >
        <div
          ref={elementRef}
          className={`element-content relative p-[10px] leading-[1.5] break-words ${elementInfo.lock ? 'cursor-default' : 'cursor-move'}`}
          style={{
            width: elementInfo.vertical ? 'auto' : `${elementInfo.width}px`,
            height: elementInfo.vertical ? `${elementInfo.height}px` : 'auto',
            backgroundColor: elementInfo.fill,
            opacity: elementInfo.opacity,
            textShadow: shadowStyle,
            lineHeight: elementInfo.lineHeight,
            letterSpacing: `${elementInfo.wordSpace || 0}px`,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            // @ts-expect-error - CSS custom property
            '--paragraphSpace': `${elementInfo.paragraphSpace === undefined ? 5 : elementInfo.paragraphSpace}px`,
          }}
          onMouseDown={(e) => handleSelectElement(e)}
          onTouchStart={(e) => handleSelectElement(e)}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />

          <div className="text relative">
            <ProsemirrorEditor
              elementId={elementInfo.id}
              defaultColor={elementInfo.defaultColor}
              defaultFontName={elementInfo.defaultFontName}
              editable={!elementInfo.lock}
              value={elementInfo.content}
              onUpdate={({ value, ignore }) => updateContent(value, ignore)}
              onFocus={cancelEmptyCleanup}
              onBlur={cleanupEmptyText}
              onMouseDown={(e) => handleSelectElement(e as React.MouseEvent, false)}
            />
          </div>

          {/* Drag handlers for better interaction when text overflows */}
          <div className="drag-handler top absolute left-0 right-0 h-[10px] top-0" />
          <div className="drag-handler bottom absolute left-0 right-0 h-[10px] bottom-0" />
        </div>
      </div>
    </div>
  );
}
