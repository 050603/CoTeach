'use client';

import type { CSSProperties } from 'react';
import type { PPTTextElement } from '@openmaic/dsl';
import { useElementShadow } from '../shared/useElementShadow';
import { ElementOutline } from '../shared/ElementOutline';

export interface BaseTextElementProps {
  elementInfo: PPTTextElement;
  target?: string;
}

export function BaseTextElement({ elementInfo, target }: BaseTextElementProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);

  const vAlign = elementInfo.vAlign ?? 'top';
  const justifyContent =
    vAlign === 'middle' ? 'center' : vAlign === 'bottom' ? 'flex-end' : 'flex-start';

  return (
    <div
      className="base-element-text"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
        // PowerPoint fills the entire shape rectangle with its solid/gradient
        // fill, regardless of how much vertical room the text actually
        // occupies. The inner .element-content div has height: auto so flex
        // alignment can park the text at top/middle/bottom — but if the
        // background lived there, a tall shape with short text (e.g. the 22
        // empty paragraphs that author full-bleed black slide backgrounds in
        // some decks) would only fill the content height and the slide's own
        // background would bleed through below.
        backgroundColor: elementInfo.fill,
        opacity: elementInfo.opacity,
      }}
    >
      <div
        className="rotate-wrapper"
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
          display: 'flex',
          flexDirection: 'column',
          justifyContent,
        }}
      >
        <div
          className="element-content slide-renderer-prose"
          style={{
            position: 'relative',
            // Keep thumbnails and package consumers on the same geometry as
            // the OpenMAIC prompt and the classroom player.
            boxSizing: 'border-box',
            padding: '10px',
            overflowWrap: 'break-word',
            width: elementInfo.vertical ? 'auto' : '100%',
            height: elementInfo.vertical ? '100%' : 'auto',
            textShadow: shadowStyle,
            // Keep read-only playback on the same metrics used by the editor,
            // generation prompt and deterministic layout audit. Browser
            // `normal` differs across fonts and previously turned a valid DSL
            // box into an overlapping classroom slide.
            lineHeight: elementInfo.lineHeight ?? 1.5,
            letterSpacing:
              elementInfo.wordSpace !== undefined ? `${elementInfo.wordSpace}px` : undefined,
            color: elementInfo.defaultColor,
            fontFamily: elementInfo.defaultFontName,
            writingMode: elementInfo.vertical ? 'vertical-rl' : 'horizontal-tb',
            ...({ '--paragraphSpace': `${elementInfo.paragraphSpace ?? 5}px` } as CSSProperties),
          }}
        >
          <ElementOutline
            width={elementInfo.width}
            height={elementInfo.height}
            outline={elementInfo.outline}
          />
          <div
            className="text ProseMirror-static"
            style={{
              position: 'relative',
              pointerEvents: target === 'thumbnail' ? 'none' : undefined,
            }}
            dangerouslySetInnerHTML={{ __html: elementInfo.content }}
          />
        </div>
      </div>
    </div>
  );
}
