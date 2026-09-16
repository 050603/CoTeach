import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import { ReadonlySlideCanvas } from "../../src/components/openmaic/slide-renderer/Editor/ReadonlySlideCanvas";
import { WhiteboardPreview } from "../../src/components/openmaic/edit/ActionsBar/WhiteboardPreview";
import { I18nProvider } from "../../src/lib/openmaic/hooks/use-i18n";
import type { Action } from "../../src/lib/openmaic/types/action";
import type { Scene } from "../../src/lib/openmaic/types/stage";

type FrameConfig = {
  scenesUrl: string;
  imageUrl?: string;
  slideIndex: number;
};

declare global {
  interface Window {
    __COURSE_QUALITY_LAB_SLIDE__?: FrameConfig;
  }
}

function sceneList(value: unknown): Scene[] {
  if (Array.isArray(value)) return value as Scene[];
  if (value && typeof value === "object" && Array.isArray((value as { scenes?: unknown[] }).scenes)) {
    return (value as { scenes: Scene[] }).scenes;
  }
  return [];
}

function SlideFrame() {
  const config = window.__COURSE_QUALITY_LAB_SLIDE__;
  const hostRef = useRef<HTMLDivElement>(null);
  const [scene, setScene] = useState<Scene>();
  const [activeSegmentId, setActiveSegmentId] = useState<string>();
  const [scale, setScale] = useState(1);
  const [error, setError] = useState<string | undefined>(() => (
    config?.scenesUrl ? undefined : "缺少可渲染的课件数据"
  ));

  useEffect(() => {
    if (!config?.scenesUrl) {
      return;
    }
    const controller = new AbortController();
    void fetch(config.scenesUrl, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`课件数据加载失败（${response.status}）`);
        return response.json() as Promise<unknown>;
      })
      .then((value) => {
        const next = sceneList(value)[config.slideIndex];
        if (!next) throw new Error("课件中没有这一页");
        setScene(next);
      })
      .catch((reason: unknown) => {
        if ((reason as Error).name !== "AbortError") {
          setError(reason instanceof Error ? reason.message : "课件数据加载失败");
        }
      });
    return () => controller.abort();
  }, [config?.scenesUrl, config?.slideIndex]);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const resize = () => setScale(Math.min(host.clientWidth / 1000, host.clientHeight / 562.5));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.origin !== window.location.origin || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: unknown; segmentId?: unknown };
      if (message.type !== "course-quality-lab:active-segment") return;
      setActiveSegmentId(typeof message.segmentId === "string" ? message.segmentId : undefined);
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, []);

  const actionState = (() => {
    if (!scene || !activeSegmentId) return undefined;
    const actions = scene.actions ?? [];
    const prefix = `${scene.outlineId ?? scene.id}:`;
    const speechIndex = actions.findIndex((action) =>
      action.type === "speech" && `${prefix}${action.id}` === activeSegmentId,
    );
    if (speechIndex < 0) return undefined;
    const visibleActions = actions.slice(0, speechIndex + 1);
    const previousSpeech = visibleActions.slice(0, -1).findLastIndex((action) => action.type === "speech");
    const currentCues = visibleActions.slice(previousSpeech + 1);
    const focus = [...currentCues].reverse().find((action) => action.type === "spotlight" || action.type === "laser");
    let whiteboardOpen = false;
    for (const action of visibleActions) {
      if (action.type === "wb_close") whiteboardOpen = false;
      else if (action.type === "wb_open" || action.type.startsWith("wb_draw_")) whiteboardOpen = true;
    }
    return { visibleActions, focus, whiteboardOpen };
  })();

  const focusElement = (() => {
    if (!scene || !actionState?.focus || scene.content.type !== "slide") return undefined;
    return scene.content.canvas.elements.find((element) => element.id === actionState.focus?.elementId);
  })();
  const focusBox = focusElement ? {
    left: focusElement.left,
    top: focusElement.top,
    width: focusElement.type === "line"
      ? Math.max(24, Math.abs(focusElement.end[0] - focusElement.start[0]))
      : focusElement.width,
    height: focusElement.type === "line"
      ? Math.max(24, Math.abs(focusElement.end[1] - focusElement.start[1]))
      : focusElement.height,
  } : undefined;

  return (
    <div className="lab-slide-host" ref={hostRef}>
      {scene ? (
        <div className="lab-slide-scale" style={{ transform: `scale(${scale})` }}>
          <I18nProvider locale="zh-CN">
            <ReadonlySlideCanvas scene={scene} />
            {focusBox && actionState?.focus?.type === "spotlight" && (
              <div
                className="lab-action-spotlight"
                style={{
                  left: focusBox.left,
                  top: focusBox.top,
                  width: focusBox.width,
                  height: focusBox.height,
                }}
              />
            )}
            {focusBox && actionState?.focus?.type === "laser" && (
              <div
                className="lab-action-laser"
                style={{
                  left: focusBox.left + focusBox.width / 2,
                  top: focusBox.top + focusBox.height / 2,
                }}
              />
            )}
            {actionState?.whiteboardOpen && (
              <div className="lab-whiteboard">
                <WhiteboardPreview actions={actionState.visibleActions as Action[]} />
              </div>
            )}
          </I18nProvider>
        </div>
      ) : config?.imageUrl ? (
        // The artifact is already the exact slide rendering; image optimization
        // would alter the experiment evidence and add a formal-app dependency.
        // eslint-disable-next-line @next/next/no-img-element
        <img className="lab-slide-fallback" src={config.imageUrl} alt="幻灯片预览" />
      ) : (
        <div className="lab-slide-error">{error ?? "正在加载课件…"}</div>
      )}
      {error && config?.imageUrl && <div className="lab-slide-warning">真实渲染不可用，当前显示生成截图</div>}
    </div>
  );
}

const mount = document.getElementById("slide-frame");
if (!mount) throw new Error("Missing #slide-frame");
createRoot(mount).render(<SlideFrame />);
