'use client';

import { useRef, useState, useLayoutEffect } from 'react';
import type { PPTLatexElement } from '@openmaic/dsl';
import 'katex/dist/katex.min.css';

export interface BaseLatexElementProps {
  elementInfo: PPTLatexElement;
  allowUpscale?: boolean;
}

/**
 * Base latex element for read-only/playback mode.
 * Renders KaTeX HTML if available, falls back to legacy SVG path.
 */
export function BaseLatexElement({ elementInfo, allowUpscale = true }: BaseLatexElementProps) {
  return (
    <div
      className="base-element-latex absolute"
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
        <div className="element-content relative w-full h-full" style={{ color: elementInfo.color }}>
          {elementInfo.html ? (
            <KatexContent
              html={elementInfo.html}
              width={elementInfo.width}
              height={elementInfo.height}
              align={elementInfo.align}
              allowUpscale={allowUpscale}
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
              className="transform-origin-[0_0] overflow-visible"
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
  allowUpscale,
}: {
  html: string;
  width: number;
  height: number;
  align?: 'left' | 'center' | 'right';
  allowUpscale: boolean;
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
        const next = Math.min(width / naturalW, height / naturalH, allowUpscale ? Infinity : 1);
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
  }, [html, width, height, allowUpscale]);

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
        className="[&_.katex-display]:!m-0"
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
