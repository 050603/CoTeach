'use client';

import { useId } from 'react';
import type { PPTElement } from '@openmaic/dsl';
import { BaseImageElement } from '@openmaic/components/slide-renderer/components/element/ImageElement/BaseImageElement';
import { BaseTextElement } from '@openmaic/components/slide-renderer/components/element/TextElement/BaseTextElement';
import { BaseShapeElement } from '@openmaic/components/slide-renderer/components/element/ShapeElement/BaseShapeElement';
import { BaseLineElement } from '@openmaic/components/slide-renderer/components/element/LineElement/BaseLineElement';
import { BaseChartElement } from '@openmaic/components/slide-renderer/components/element/ChartElement/BaseChartElement';
import { BaseLatexElement } from '@openmaic/components/slide-renderer/components/element/LatexElement/BaseLatexElement';
import { BaseTableElement } from '@openmaic/components/slide-renderer/components/element/TableElement/BaseTableElement';
import { BaseCodeElement } from '@openmaic/components/slide-renderer/components/element/CodeElement/BaseCodeElement';

/** Native PPT rendering for both board editing and playback, independent of slide context. */
export function WhiteboardElement({ element, animate = false }: {
  element: PPTElement;
  animate?: boolean;
}) {
  const renderId = useId();
  let content;
  switch (element.type) {
    case 'text': content = <BaseTextElement elementInfo={element} />; break;
    case 'image': content = <BaseImageElement elementInfo={element} />; break;
    case 'shape': content = <BaseShapeElement elementInfo={element} />; break;
    // The editing preview and live board can coexist. Scope SVG marker IDs to
    // this render instance so one view cannot pick up the other's arrow color.
    case 'line': content = <BaseLineElement elementInfo={{ ...element, id: `whiteboard-line-${renderId}` }} animate={animate} />; break;
    case 'chart': content = <BaseChartElement elementInfo={element} />; break;
    case 'latex': content = <BaseLatexElement elementInfo={element} allowUpscale={false} />; break;
    case 'table': content = <BaseTableElement elementInfo={element} />; break;
    case 'code': content = <BaseCodeElement elementInfo={element} animate={animate} />; break;
    default: return null;
  }
  return (
    <div
      data-whiteboard-element-id={element.id}
      data-whiteboard-element-type={element.type}
      style={{ color: '#333333', fontFamily: 'Microsoft YaHei, sans-serif' }}
    >
      {content}
    </div>
  );
}
