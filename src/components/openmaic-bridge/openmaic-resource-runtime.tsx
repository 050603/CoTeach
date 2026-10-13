"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { Stage } from "@openmaic/components/stage";
import { ServerProvidersInit } from "@openmaic/components/server-providers-init";
import { MediaStageProvider } from "@openmaic/lib/contexts/media-stage-context";
import { migrateScene } from "@openmaic/lib/edit/slide-schema";
import { I18nProvider } from "@openmaic/lib/hooks/use-i18n";
import { ThemeProvider } from "@openmaic/lib/hooks/use-theme";
import { createLogger } from "@openmaic/lib/logger";
import { useStageStore } from "@openmaic/lib/store";
import type { Scene, Stage as StageType } from "@openmaic/lib/types/stage";
import type { PlaybackSyncState, StageExperience } from "@openmaic/components/stage-experience";
import { cn } from "@/lib/utils";
import { toast } from "@/components/ui";
import { shouldPollClassroomAssets } from "./resource-player-policy";

const log = createLogger("OpenMaicResourcePlayer");
const ASSET_REFRESH_INTERVAL_MS = 5_000;
const MAX_ASSET_REFRESH_ATTEMPTS = 60;

type LoadState = "loading" | "ready" | "error";

interface ClassroomPayload {
  stage: StageType;
  scenes: Scene[];
  assetGeneration?: {
    status: "running" | "completed" | "partial-failure";
    requested: number;
    completed: number;
    failures: Array<{ elementId: string; type: "image" | "video" | "tts"; error: string }>;
  };
}

/** Runs only inside the resource frame: Stage/Canvas/iframe stores belong to this document. */
export function OpenMaicResourceRuntime({
  classroomId,
  sceneId,
  className,
  experience = "teacher-resource",
  playbackState,
  onPlaybackStateChange,
  interactionState,
}: {
  classroomId: string;
  sceneId?: string;
  className?: string;
  experience?: StageExperience;
  playbackState?: PlaybackSyncState;
  onPlaybackStateChange?: (state: Omit<PlaybackSyncState, "version">) => void;
  /**
   * 互动场景状态快照（由教师端 projection 同步过来）。
   * 仅在 experience="projected-readonly" 时有意义：学生端 PlaybackChromeRoot
   * 监听此属性变化，通过 postMessage apply-state 将状态应用到互动 iframe，
   * 使学生看到教师的操作结果。
   */
  interactionState?: Record<string, unknown> | null;
}) {
  const [state, setState] = useState<LoadState>("loading");
  const [errorMessage, setErrorMessage] = useState<string>();
  const [assetGeneration, setAssetGeneration] = useState<ClassroomPayload["assetGeneration"]>();
  const loadControllerRef = useRef<AbortController | null>(null);

  const loadResource = useCallback(async (options: { silent?: boolean } = {}) => {
    loadControllerRef.current?.abort();
    const loadController = new AbortController();
    loadControllerRef.current = loadController;
    if (!options.silent) {
      setState("loading");
      setErrorMessage(undefined);
    }

    try {
      const response = await fetch(
        `/api/openmaic/classroom?id=${encodeURIComponent(classroomId)}`,
        { cache: "no-store", signal: loadController.signal },
      );
      if (!response.ok) {
        throw new Error(
          response.status === 404
            ? "授课资源课堂不存在或已被移除"
            : `授课资源加载失败（HTTP ${response.status}）`,
        );
      }

      const payload = (await response.json()) as {
        success?: boolean;
        classroom?: ClassroomPayload;
      };
      if (loadController.signal.aborted) return;
      if (!payload.success || !payload.classroom) {
        throw new Error("授课资源课堂返回内容为空");
      }
      setAssetGeneration(payload.classroom.assetGeneration);

      const selectedScene = sceneId
        ? payload.classroom.scenes.find((scene) => scene.id === sceneId)
        : payload.classroom.scenes[0];
      if (!selectedScene) {
        throw new Error("所选授课资源场景不存在，请重新生成课程资源");
      }

      // Older split classrooms kept the original student stageId on teacher
      // scenes. Normalize it at read time so existing courses render too.
      const migratedScene = migrateScene({
        ...selectedScene,
        stageId: payload.classroom.stage.id,
      } as Scene);
      const currentScene = useStageStore.getState().scenes[0];
      const currentSnapshot = currentScene
        ? JSON.stringify({ content: currentScene.content, actions: currentScene.actions })
        : undefined;
      const nextSnapshot = JSON.stringify({ content: migratedScene.content, actions: migratedScene.actions });
      if (!options.silent || currentSnapshot !== nextSnapshot) {
        useStageStore.getState().setStage(payload.classroom.stage);
        useStageStore.setState({
          scenes: [migratedScene],
          currentSceneId: migratedScene.id,
          mode: "playback",
          outlines: [],
          generatingOutlines: [],
          generationComplete: true,
          generationStatus: "completed",
        });
      }
      if (!options.silent) setState("ready");
    } catch (error) {
      if (
        loadController.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        return;
      }
      const message = error instanceof Error ? error.message : "授课资源加载失败";
      log.error("Failed to load projected teacher resource:", error);
      if (!options.silent) {
        setErrorMessage(message);
        setState("error");
        toast.error("资源加载失败", { description: message });
      }
    } finally {
      if (loadControllerRef.current === loadController) loadControllerRef.current = null;
    }
  }, [classroomId, sceneId]);

  useEffect(() => {
    // Loading the external classroom snapshot initializes both Zustand stores
    // and this component's visible loading state as one bridge operation.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadResource();
    return () => {
      loadControllerRef.current?.abort();
      useStageStore.getState().clearStore();
    };
  }, [loadResource]);

  useEffect(() => {
    if (state !== "ready" || !shouldPollClassroomAssets(assetGeneration?.status)) return;
    let attempts = 0;
    const refreshTimer = window.setInterval(() => {
      attempts += 1;
      if (attempts > MAX_ASSET_REFRESH_ATTEMPTS) {
        window.clearInterval(refreshTimer);
        return;
      }
      // Keep the already visible classroom body in place while picking up
      // audio/image/video URLs written by the background asset task.
      void loadResource({ silent: true });
    }, ASSET_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(refreshTimer);
  }, [assetGeneration?.status, loadResource, state]);

  return (
    <ThemeProvider>
      <I18nProvider>
        <ServerProvidersInit />
        <MediaStageProvider value={classroomId}>
          <div
            className={cn(
              "relative flex min-h-0 flex-col overflow-hidden bg-background text-foreground",
              className,
            )}
          >
            {state === "loading" ? (
              <div className="flex flex-1 items-center justify-center bg-stone-50">
                <div className="text-center text-stone-500">
                  <Loader2 className="mx-auto mb-3 h-7 w-7 animate-spin text-blue-600" />
                  <p className="text-sm">正在加载授课资源...</p>
                </div>
              </div>
            ) : state === "error" ? (
              <div className="flex flex-1 items-center justify-center bg-rose-50/40 p-6">
                <div className="max-w-md text-center">
                  <AlertTriangle className="mx-auto mb-3 text-rose-600" size={28} />
                  <p className="text-sm leading-6 text-rose-700">{errorMessage}</p>
                  <button
                    className="mt-4 inline-flex h-9 items-center gap-2 rounded-[6px] bg-rose-600 px-4 text-sm font-semibold text-white hover:bg-rose-700"
                    onClick={() => void loadResource()}
                    type="button"
                  >
                    <RefreshCw size={15} /> 重试
                  </button>
                </div>
              </div>
            ) : (
              <>
                {assetGeneration?.status === "running" ? (
                  <div className="border-b border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-800">
                    图片和视频正在后台生成，完成后会自动回填（{assetGeneration.completed}/{assetGeneration.requested}）。
                  </div>
                ) : null}
                {assetGeneration?.status === "partial-failure" ? (
                  <div className="border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">
                    已生成 {assetGeneration.completed}/{assetGeneration.requested} 项媒体资源；其余资源生成失败，课程正文仍可正常使用。可检查模型配置后重新生成。
                  </div>
                ) : null}
                <Stage
                  experience={experience}
                  onPlaybackStateChange={onPlaybackStateChange}
                  playbackState={playbackState}
                  interactionState={interactionState}
                />
              </>
            )}
          </div>
        </MediaStageProvider>
      </I18nProvider>
    </ThemeProvider>
  );
}
