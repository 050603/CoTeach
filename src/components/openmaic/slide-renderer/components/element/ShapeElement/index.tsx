'use client';

import { useMemo, useCallback } from 'react';
import type { PPTShapeElement, ShapeText } from '@openmaic/dsl';
import { useCanvasStore } from '@openmaic/lib/store';
import { useCanvasOperations } from '@openmaic/lib/hooks/use-canvas-operations';
import { useHistorySnapshot } from '@openmaic/lib/hooks/use-history-snapshot';
import { useElementShadow } from '../hooks/useElementShadow';
import { useElementFlip } from '../hooks/useElementFlip';
import { useElementFill } from '../hooks/useElementFill';
import { useElementOutline } from '../hooks/useElementOutline';
import { GradientDefs } from './GradientDefs';
import { PatternDefs } from './PatternDefs';
import { ProsemirrorEditor } from '../ProsemirrorEditor';

export { BaseShapeElement } from './BaseShapeElement';

export interface ShapeElementProps {
  elementInfo: PPTShapeElement;
  selectElement?: (
    e: React.MouseEvent | React.TouchEvent,
    element: PPTShapeElement,
    canMove?: boolean,
  ) => void;
}

/**
 * Shape element component with text editing support
 * Supports gradients, patterns, and rich text content
 */
export function ShapeElement({ elementInfo, selectElement }: ShapeElementProps) {
  const editingElementId = useCanvasStore.use.editingElementId();
  const activeElementIds = useCanvasStore.use.activeElementIdList();
  const { updateElement } = useCanvasOperations();
  const { addHistorySnapshot } = useHistorySnapshot();

  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { fill } = useElementFill(elementInfo, 'editable');
  const { outlineWidth, outlineColor, strokeDashArray } = useElementOutline(elementInfo.outline);

  const editable = !elementInfo.lock && editingElementId === elementInfo.id
    && activeElementIds.length === 1 && activeElementIds[0] === elementInfo.id;

  const handleSelectElement = (e: React.MouseEvent | React.TouchEvent, canMove = true) => {
    if (elementInfo.lock) return;
    e.stopPropagation();
    selectElement?.(e, elementInfo, canMove);
  };

  // Default text configuration
  const text = useMemo<ShapeText>(() => {
    const defaultText: ShapeText = {
      content: '',
      align: 'middle',
      defaultFontName: 'Microsoft Yahei',
      defaultColor: '#000000',
    };
    if (!elementInfo.text) return defaultText;
    return elementInfo.text;
  }, [elementInfo.text]);

  // Update text content
  const updateText = useCallback(
    (content: string, ignore = false) => {
      const _text = { ...text, content };
      updateElement({
        id: elementInfo.id,
        props: { text: _text },
      });

      if (!ignore) addHistorySnapshot();
    },
    [elementInfo.id, text, updateElement, addHistorySnapshot],
  );

  // Start editing on double click
  const startEdit = () => {
    if (elementInfo.lock || activeElementIds.length !== 1
      || activeElementIds[0] !== elementInfo.id) return;
    useCanvasStore.getState().setEditingElementId(elementInfo.id);
  };

  return (
    <div
      className={`editable-element-shape absolute pointer-events-none ${elementInfo.lock ? 'lock' : ''}`}
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
          className={`element-content relative w-full h-full ${elementInfo.lock ? '' : 'cursor-move'}`}
          style={{
            opacity: elementInfo.opacity,
            filter: shadowStyle ? `drop-shadow(${shadowStyle})` : '',
            transform: flipStyle,
            color: text.defaultColor,
            fontFamily: text.defaultFontName,
          }}
          onMouseDown={(e) => handleSelectElement(e)}
          onTouchStart={(e) => handleSelectElement(e)}
          onDoubleClick={startEdit}
        >
          <svg
            overflow="visible"
            width={elementInfo.width}
            height={elementInfo.height}
            className="transform-origin-[0_0] block"
          >
            <defs>
              {elementInfo.pattern && (
                <PatternDefs id={`editable-pattern-${elementInfo.id}`} src={elementInfo.pattern} />
              )}
              {elementInfo.gradient && !elementInfo.pattern && (
                <GradientDefs
                  id={`editable-gradient-${elementInfo.id}`}
                  type={elementInfo.gradient.type}
                  colors={elementInfo.gradient.colors}
                  rotate={elementInfo.gradient.rotate}
                />
              )}
            </defs>
            <g
              transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${
                elementInfo.height / elementInfo.viewBox[1]
              }) translate(0,0) matrix(1,0,0,1,0,0)`}
            >
              <path
                className="shape-path pointer-events-auto"
                vectorEffect="non-scaling-stroke"
                strokeLinecap="butt"
                strokeMiterlimit="8"
                d={elementInfo.path}
                fill={fill}
                stroke={outlineColor}
                strokeWidth={outlineWidth}
                strokeDasharray={strokeDashArray}
              />
            </g>
          </svg>

          <div
            className={`shape-text absolute inset-0 flex flex-col p-[10px] leading-[1.5] break-words ${
              editable || text.content ? 'pointer-events-auto' : 'pointer-events-none'
            } ${
              text.align === 'top'
                ? 'justify-start'
                : text.align === 'bottom'
                  ? 'justify-end'
                  : 'justify-center'
            }`}
            style={{
              lineHeight: text.lineHeight,
              letterSpacing: `${text.wordSpace || 0}px`,
              // @ts-expect-error - CSS custom property
              '--paragraphSpace': `${text.paragraphSpace === undefined ? 5 : text.paragraphSpace}px`,
            }}
          >
            {(editable || text.content) && (
              <ProsemirrorEditor
                elementId={elementInfo.id}
                defaultColor={text.defaultColor}
                defaultFontName={text.defaultFontName}
                editable={editable}
                value={text.content}
                onUpdate={({ value, ignore }) => updateText(value, ignore)}
                onMouseDown={(e) => handleSelectElement(e as React.MouseEvent, !editable)}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
