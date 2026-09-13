'use client';

import { useMemo } from 'react';
import type { Action } from '@openmaic/lib/types/action';
import { projectWhiteboardActions, getWhiteboardViewport } from '@openmaic/lib/whiteboard/projection';
import { WhiteboardElement } from '@openmaic/components/whiteboard/whiteboard-element';

export function WhiteboardPreview({ actions }: { actions: readonly Action[] }) {
  const elements = useMemo(() => projectWhiteboardActions(actions), [actions]);
  const viewport = getWhiteboardViewport(elements);
  return (
    <svg
      role="img"
      aria-label="白板步骤预览"
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      className="max-h-full w-full bg-white"
      style={{ aspectRatio: '16 / 9' }}
    >
      <rect width={viewport.width} height={viewport.height} fill="white" />
      {!elements.length && (
        <text x={viewport.width / 2} y={viewport.height / 2} textAnchor="middle" fontSize={28} fill="#a8a29e">
          白板已准备好
        </text>
      )}
      <foreignObject x={0} y={0} width={viewport.width} height={viewport.height}>
        <div
          style={{
            position: 'relative',
            width: viewport.width,
            height: viewport.height,
            transform: `translate(${-viewport.left}px, ${-viewport.top}px)`,
          }}
        >
          {elements.map((element) => <WhiteboardElement key={element.id} element={element} />)}
        </div>
      </foreignObject>
    </svg>
  );
}
