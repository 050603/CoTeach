"use client";

import { useCallback, useEffect, useState } from "react";
import type { PlaybackSyncState } from "@openmaic/components/stage-experience";
import { OpenMaicResourceRuntime } from "@/components/openmaic-bridge/openmaic-resource-runtime";
import { useInteractionSyncStore } from "@openmaic/lib/store/interaction-sync";
import { isResourceConfiguration, RESOURCE_PLAYER_CHANNEL, resourceIdentity, type ResourcePlayerConfiguration } from "@/components/openmaic-bridge/resource-player-protocol";

export default function ResourcePlayerFrame() {
  const [configuration, setConfiguration] = useState<ResourcePlayerConfiguration>();
  useEffect(() => {
    if (window.parent === window) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== window.location.origin) return;
      if (event.data?.channel === RESOURCE_PLAYER_CHANNEL && event.data.type === "configure" && isResourceConfiguration(event.data.configuration)) {
        setConfiguration(event.data.configuration);
      }
    };
    window.addEventListener("message", receive);
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || document.fullscreenElement) return;
      if ([...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')].some(node => node.getClientRects().length)) return;
      window.parent.postMessage({ channel: RESOURCE_PLAYER_CHANNEL, type: "escape" }, window.location.origin);
    };
    window.addEventListener("keydown", keydown);
    window.parent.postMessage({ channel: RESOURCE_PLAYER_CHANNEL, type: "ready" }, window.location.origin);
    return () => { window.removeEventListener("message", receive); window.removeEventListener("keydown", keydown); };
  }, []);
  const identity = configuration ? resourceIdentity(configuration) : undefined;
  useEffect(() => {
    if (!configuration || configuration.experience !== "teacher-resource") return;
    return useInteractionSyncStore.subscribe((next, previous) => {
      const sceneId = configuration.sceneId;
      if (!sceneId || next.versions[sceneId] === previous.versions[sceneId]) return;
      window.parent.postMessage({ channel: RESOURCE_PLAYER_CHANNEL, type: "interaction", identity,
        sceneId, state: next.states[sceneId] ?? null }, window.location.origin);
    });
  }, [configuration, identity]);
  const onPlaybackStateChange = useCallback((state: Omit<PlaybackSyncState, "version">) => {
    window.parent.postMessage({ channel: RESOURCE_PLAYER_CHANNEL, type: "playback", identity, state }, window.location.origin);
  }, [identity]);
  return <main className="fixed inset-0 flex min-h-0 flex-col overflow-hidden">
    {configuration ? <OpenMaicResourceRuntime {...configuration} className="h-full flex-1" onPlaybackStateChange={onPlaybackStateChange} />
      : <p className="m-auto text-sm text-stone-500" role="status">正在加载授课资源…</p>}
  </main>;
}
