import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useStageStore } from "@openmaic/lib/store";
import { OpenMaicResourcePlayer } from "./openmaic-resource-player";
import { RESOURCE_PLAYER_CHANNEL, resourceIdentity } from "./resource-player-protocol";
import { useInteractionSyncStore } from "@openmaic/lib/store/interaction-sync";

vi.mock("@openmaic/components/stage", () => ({ Stage: () => <div>播放器</div> }));
vi.mock("@openmaic/components/server-providers-init", () => ({ ServerProvidersInit: () => null }));
vi.mock("@openmaic/lib/hooks/use-i18n", () => ({ I18nProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@openmaic/lib/hooks/use-theme", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));

afterEach(() => { vi.unstubAllGlobals(); useStageStore.getState().clearStore(); });

describe("resource player instance isolation", () => {
  it("accepts only this frame's current scene and bridges validated playback and interactions", () => {
    const onPlaybackStateChange = vi.fn();
    const view = render(<OpenMaicResourcePlayer classroomId="room" sceneId="one" onPlaybackStateChange={onPlaybackStateChange} />);
    const frame = screen.getByTitle("授课资源播放器") as HTMLIFrameElement;
    const state = { engineMode: "playing", snapshot: { sceneId: "one", sceneIndex: 0, actionIndex: 1, consumedDiscussions: [] } };
    const send = (overrides = {}, origin = window.location.origin, source: MessageEventSource | null = frame.contentWindow) => {
      fireEvent(window, new MessageEvent("message", { origin, source, data: { channel: RESOURCE_PLAYER_CHANNEL, type: "playback",
        identity: resourceIdentity({ classroomId: "room", sceneId: "one", experience: "teacher-resource" }), state, ...overrides } }));
    };
    send({}, "https://unrelated.example");
    send({}, window.location.origin, window);
    send({ state: { engineMode: "playing", snapshot: {} } });
    expect(onPlaybackStateChange).not.toHaveBeenCalled();
    send();
    expect(onPlaybackStateChange).toHaveBeenCalledExactlyOnceWith(state);
    send({ type: "interaction", sceneId: "one", state: { slider: 3 } });
    expect(useInteractionSyncStore.getState().getState("one")).toEqual({ slider: 3 });
    view.rerender(<OpenMaicResourcePlayer classroomId="room" sceneId="two" onPlaybackStateChange={onPlaybackStateChange} />);
    send();
    expect(onPlaybackStateChange).toHaveBeenCalledTimes(1);
  });

  it("loading and removing a supplementary player cannot replace or clear the main lesson", async () => {
    useStageStore.setState({ stage: { id: "main", name: "主课程", createdAt: 1, updatedAt: 1 }, scenes: [], currentSceneId: "main-page-2" });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, classroom: {
      stage: { id: "supplement", name: "补讲", createdAt: 1, updatedAt: 1 },
      scenes: [{ id: "supplement-page", type: "slide", title: "补讲页面", order: 0, actions: [],
        content: { type: "slide", canvas: { id: "slide", viewportSize: 1000, viewportRatio: 0.5625,
          theme: { fontName: "Noto Sans SC", fontColor: "#000000", themeColors: [] }, elements: [] } } }],
    } })));
    let view: ReturnType<typeof render>;
    await act(async () => { view = render(<OpenMaicResourcePlayer classroomId="supplement" sceneId="supplement-page" />); });
    expect(useStageStore.getState().stage?.id).toBe("main");
    expect(useStageStore.getState().currentSceneId).toBe("main-page-2");
    view!.unmount();
    expect(useStageStore.getState().stage?.id).toBe("main");
    expect(useStageStore.getState().currentSceneId).toBe("main-page-2");
  });
});
