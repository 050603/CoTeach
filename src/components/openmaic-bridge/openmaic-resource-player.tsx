"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import type { PlaybackSyncState, StageExperience } from "@openmaic/components/stage-experience";
import { cn } from "@/lib/utils";
import { useInteractionSyncStore } from "@openmaic/lib/store/interaction-sync";
import { isResourcePlayback, RESOURCE_PLAYER_CHANNEL, resourceIdentity, type ResourcePlayerConfiguration } from "./resource-player-protocol";

/** A separate document isolates the resource's playback, canvas, keyboard and widget stores. */
export function OpenMaicResourcePlayer({
  classroomId, sceneId, className, experience = "teacher-resource", playbackState,
  onPlaybackStateChange, interactionState,
}: {
  classroomId: string;
  sceneId?: string;
  className?: string;
  experience?: StageExperience;
  playbackState?: PlaybackSyncState;
  onPlaybackStateChange?: (state: Omit<PlaybackSyncState, "version">) => void;
  interactionState?: Record<string, unknown> | null;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const configuration = useMemo<ResourcePlayerConfiguration>(() => ({ classroomId, sceneId,
    experience: experience === "projected-readonly" ? "projected-readonly" : "teacher-resource",
    playbackState, interactionState,
  }), [classroomId, sceneId, experience, playbackState, interactionState]);
  const identity = resourceIdentity(configuration);
  const sendConfiguration = useCallback(() => {
    frameRef.current?.contentWindow?.postMessage({ channel: RESOURCE_PLAYER_CHANNEL, type: "configure", configuration }, window.location.origin);
  }, [configuration]);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!message || message.channel !== RESOURCE_PLAYER_CHANNEL) return;
      if (message.type === "escape") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else if (message.type === "ready") {
        setReady(true);
        setFailed(false);
        sendConfiguration();
      } else if (message.type === "playback" && message.identity === identity && isResourcePlayback(message.state)
        && (!sceneId || message.state.snapshot.sceneId === sceneId)) {
        onPlaybackStateChange?.(message.state);
      } else if (message.type === "interaction" && message.identity === identity && message.sceneId === sceneId && sceneId
        && configuration.experience === "teacher-resource" && message.state && typeof message.state === "object" && !Array.isArray(message.state)) {
        useInteractionSyncStore.getState().broadcast(sceneId, message.state);
      }
    };
    window.addEventListener("message", receive);
    sendConfiguration();
    return () => window.removeEventListener("message", receive);
  }, [configuration.experience, identity, onPlaybackStateChange, sceneId, sendConfiguration]);

  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => setFailed(true), 20_000);
    return () => window.clearTimeout(timer);
  }, [ready, attempt]);

  return <div className={cn("relative flex min-h-0 flex-col overflow-hidden bg-white", className)}>
    <iframe key={attempt} ref={frameRef} src="/internal/resource-player" title="授课资源播放器"
      allow="autoplay; fullscreen" className="h-full min-h-0 w-full flex-1 border-0" onLoad={sendConfiguration} />
    {!ready ? <div className="absolute inset-0 grid place-items-center bg-stone-50 p-4 text-center text-sm text-stone-600" role={failed ? "alert" : "status"}>
      {failed ? <div><p>播放器加载失败，请重试。</p><button className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-md border px-4" type="button" onClick={() => { setFailed(false); setReady(false); setAttempt(value => value + 1); }}><RefreshCw size={16} />重新加载播放器</button></div>
        : <span><Loader2 className="mx-auto mb-2 animate-spin" size={24} />正在加载授课资源…</span>}
    </div> : null}
  </div>;
}
