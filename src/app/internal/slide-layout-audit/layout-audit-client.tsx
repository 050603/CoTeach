'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { PPTElement, SlideTheme } from '@openmaic/dsl';
import type { GeneratedSlideContent } from '@openmaic/lib/types/generation';
import type { Scene } from '@openmaic/lib/types/stage';
import { ReadonlySlideCanvas } from '@/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas';
import {
  inspectRenderedSlide,
  measureSlideElements,
  type RenderedElement,
} from '@/lib/course-quality-review/render-measurements';
import { I18nProvider } from '@openmaic/lib/hooks/use-i18n';

const DEFAULT_THEME: SlideTheme = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Noto Sans SC',
  outline: { color: '#d14424', width: 2, style: 'solid' },
  shadow: { h: 0, v: 0, blur: 10, color: '#000000' },
};

export type LayoutAuditBrowserInput = {
  outlineId: string;
  content: GeneratedSlideContent;
};

export type LayoutAuditBrowserResult = {
  issues: Array<{
    id: string;
    title: string;
    evidence: string;
    elementId?: string;
  }>;
  /** Actual renderer geometry. Returned only to the loopback audit caller and
   * used for bounded, content-preserving layout repair. */
  measurements: RenderedElement[];
};

declare global {
  interface Window {
    __openPblAuditSlide?: (input: LayoutAuditBrowserInput) => Promise<LayoutAuditBrowserResult>;
  }
}

type PendingAudit = LayoutAuditBrowserInput & { sequence: number };

function auditSafeElements(elements: readonly PPTElement[]): PPTElement[] {
  const transparentPixel = 'data:image/gif;base64,R0lGODlhAQABAAAAACwAAAAAAQABAAA=';
  return elements.map((element) => {
    if (element.type === 'image') return { ...element, src: transparentPixel };
    if (element.type === 'video') return { ...element, src: undefined };
    return { ...element };
  }) as PPTElement[];
}

function waitForPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/** Browser-only renderer used by the server-side Playwright quality audit. */
export function LayoutAuditClient() {
  const root = useRef<HTMLDivElement>(null);
  const resolver = useRef<((result: LayoutAuditBrowserResult) => void) | null>(null);
  const sequence = useRef(0);
  const [pending, setPending] = useState<PendingAudit | null>(null);

  useEffect(() => {
    window.__openPblAuditSlide = (input) => new Promise((resolve) => {
      resolver.current = resolve;
      sequence.current += 1;
      setPending({ ...input, sequence: sequence.current });
    });
    return () => {
      delete window.__openPblAuditSlide;
    };
  }, []);

  const scene = useMemo<Scene | null>(() => {
    if (!pending) return null;
    return {
      id: pending.outlineId,
      stageId: 'layout-audit',
      type: 'slide',
      title: 'Layout audit',
      order: 0,
      actions: [],
      content: {
        type: 'slide',
        schemaVersion: 1,
        canvas: {
          id: `${pending.outlineId}-${pending.sequence}`,
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: pending.content.theme ?? DEFAULT_THEME,
          background: pending.content.background,
          elements: auditSafeElements(pending.content.elements),
        },
      },
      createdAt: 0,
      updatedAt: 0,
    };
  }, [pending]);

  useEffect(() => {
    if (!pending || !scene || !root.current) return;
    let cancelled = false;
    void (async () => {
      await document.fonts.ready;
      await waitForPaint();
      if (cancelled || !root.current || scene.content.type !== 'slide') return;
      const measured = measureSlideElements(root.current, scene.content.canvas.elements);
      const issues = inspectRenderedSlide(pending.outlineId, measured).map((issue) => ({
        id: issue.id,
        title: issue.title,
        evidence: issue.evidence,
        elementId: issue.elementId,
      }));
      resolver.current?.({ issues, measurements: measured });
      resolver.current = null;
    })();
    return () => {
      cancelled = true;
    };
  }, [pending, scene]);

  return (
    <main aria-label="OpenMAIC slide layout audit" style={{ margin: 0, width: 1000, height: 562.5, overflow: 'hidden' }}>
      <I18nProvider locale="zh-CN">
        {scene ? <ReadonlySlideCanvas ref={root} scene={scene} /> : null}
      </I18nProvider>
    </main>
  );
}
