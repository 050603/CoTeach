'use client';

import { useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '@openmaic/dsl';

export interface BaseLatexElementProps {
  elementInfo: PPTLatexElement;
}

export function BaseLatexElement({ elementInfo }: BaseLatexElementProps) {
  return (
    <div
      className="base-element-latex"
      style={{
        position: 'absolute',
        top: `${elementInfo.top}px`,
        left: `${elementInfo.left}px`,
        width: `${elementInfo.width}px`,
        height: `${elementInfo.height}px`,
      }}
    >
      <div
        className="rotate-wrapper"
        style={{
          width: '100%',
          height: '100%',
          transform: `rotate(${elementInfo.rotate}deg)`,
        }}
      >
        <div
          className="element-content"
          style={{
            position: 'relative',
            width: '100%',
            height: '100%',
            // KaTeX glyphs inherit `color`; apply the formula's resolved color
            // (e.g. 蓝色权重) so it isn't forced to the browser default.
            ...(elementInfo.color ? { color: elementInfo.color } : {}),
          }}
        >
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
              align={elementInfo.align}
            />
          ) : elementInfo.path && elementInfo.viewBox ? (
            <svg
              overflow="visible"
              width={elementInfo.width}
              height={elementInfo.height}
              stroke={elementInfo.color}
              strokeWidth={elementInfo.strokeWidth}
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ transformOrigin: '0 0', overflow: 'visible' }}
            >
              <g
                transform={`scale(${elementInfo.width / elementInfo.viewBox[0]}, ${
                  elementInfo.height / elementInfo.viewBox[1]
                }) translate(0,0) matrix(1,0,0,1,0,0)`}
              >
                <path d={elementInfo.path} />
              </g>
            </svg>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const ALIGN_MAP = {
  left: 'flex-start',
  center: 'center',
  right: 'flex-end',
} as const;

function KatexContent({
  html,
  width,
  height,
  align = 'center',
}: {
  html: string;
  width: number;
  height: number;
  align?: 'left' | 'center' | 'right';
}) {
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    let disposed = false;
    let frame: number | undefined;
    const measure = () => {
      frame = undefined;
      if (disposed) return;
      // scroll dimensions are untransformed: updating scale cannot resize the
      // observed content and create a ResizeObserver feedback loop.
      // scrollWidth/Height round to integer pixels. Keep the fractional CSS
      // size too, so enlarging a short expression does not clip its edge.
      const style = getComputedStyle(inner);
      const naturalW = Math.max(inner.scrollWidth, Number.parseFloat(style.width) || 0);
      const naturalH = Math.max(inner.scrollHeight, Number.parseFloat(style.height) || 0);
      if (naturalW > 0 && naturalH > 0) {
        const next = Math.min(width / naturalW, height / naturalH, 1);
        setScale((previous) => Math.abs(previous - next) < 0.000001 ? previous : next);
      }
    };
    const schedule = () => {
      if (!disposed && frame === undefined) frame = requestAnimationFrame(measure);
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    observer?.observe(inner);
    const fonts = document.fonts;
    if (fonts) {
      fonts.addEventListener('loadingdone', schedule);
      // Request the faces used by this formula before awaiting ready; otherwise
      // ready can resolve before the browser starts loading KaTeX's fonts.
      const faces = new Set<string>();
      for (const node of [inner, ...inner.querySelectorAll<HTMLElement>('*')]) {
        const style = getComputedStyle(node);
        if (style.fontFamily && style.fontSize) {
          faces.add(`${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
        }
      }
      void Promise.allSettled([...faces].map((face) => fonts.load(face, inner.textContent || 'x')))
        .then(() => fonts.ready).then(schedule, schedule);
    }
    return () => {
      disposed = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      observer?.disconnect();
      fonts?.removeEventListener('loadingdone', schedule);
    };
  }, [html, width, height]);

  const justify = ALIGN_MAP[align];
  const origin =
    align === 'left' ? 'left center' : align === 'right' ? 'right center' : 'center center';

  return (
    <div
      style={{
        width,
        height,
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: justify,
      }}
    >
      <div
        ref={innerRef}
        className="slide-renderer-prose"
        style={{
          transformOrigin: origin,
          transform: `scale(${scale})`,
          whiteSpace: 'nowrap',
          flexShrink: 0,
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
