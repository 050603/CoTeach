import { useContext } from "react";
import { PlaybackPreparationContext } from "@openmaic/lib/contexts/playback-preparation-context";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stageMock = vi.hoisted(() => {
  const state = {
    scenes: [] as Array<{ id: string; title: string; actions: unknown[] }>,
    currentSceneId: null as string | null,
    setStage: vi.fn(),
    clearStore: vi.fn(),
  };
  const listeners = new Set<(current: typeof state, previous: typeof state) => void>();
  const currentSceneHistory: string[] = [];
  return {
    state,
    currentSceneHistory,
    reset() {
      state.scenes = [];
      state.currentSceneId = null;
      state.setStage.mockClear();
      state.clearStore.mockClear();
      currentSceneHistory.length = 0;
      listeners.clear();
    },
    setState(patch: Partial<typeof state>) {
      const previous = { ...state };
      Object.assign(state, patch);
      if (typeof patch.currentSceneId === "string") currentSceneHistory.push(patch.currentSceneId);
      listeners.forEach((listener) => listener(state, previous));
    },
    subscribe(listener: (current: typeof state, previous: typeof state) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
});

const telemetryMock = vi.hoisted(() => ({
  createLearningEvent: vi.fn((type: string, draft: Record<string, unknown>) => ({
    ...draft,
    id: `event-${type}`,
    idempotencyKey: `event-${type}`,
    type,
    occurredAt: "2026-07-11T10:00:00.000Z",
  })),
  postLearningEvents: vi.fn(async (input: { events: Array<{ type: string }> }) => {
    void input;
  }),
}));

const settingsMock = vi.hoisted(() => ({
  setState: vi.fn(),
}));

const renderedStage = vi.hoisted(() => ({
  prepare: undefined as ((sceneId: string) => Promise<boolean>) | undefined,
  props: null as null | {
    autoplaySceneId?: string;
    onPlaybackStateChange?: (state: {
      engineMode: "idle" | "playing" | "paused" | "live";
      snapshot: { sceneIndex: number; actionIndex: number; consumedDiscussions: string[]; sceneId?: string };
    }) => void;
  },
}));

vi.mock("@openmaic/components/stage", () => ({
  Stage: (props: typeof renderedStage.props) => {
    renderedStage.props = props;
    renderedStage.prepare = useContext(PlaybackPreparationContext);
    return <div>stage-ready</div>;
  },
}));
vi.mock("@openmaic/components/server-providers-init", () => ({ ServerProvidersInit: () => null }));
vi.mock("@openmaic/lib/hooks/use-theme", () => ({ ThemeProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@openmaic/lib/hooks/use-i18n", () => ({ I18nProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@openmaic/lib/contexts/media-stage-context", () => ({ MediaStageProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("@openmaic/lib/edit/slide-schema", () => ({ migrateScene: (scene: unknown) => scene }));
vi.mock("@openmaic/lib/logger", () => ({ createLogger: () => ({ info: vi.fn(), error: vi.fn() }) }));
vi.mock("@openmaic/lib/store", () => ({
  useStageStore: Object.assign(() => undefined, {
    getState: () => ({
      ...stageMock.state,
      setCurrentSceneId: (sceneId: string) => stageMock.setState({ currentSceneId: sceneId }),
    }),
    setState: stageMock.setState,
    subscribe: stageMock.subscribe,
  }),
}));
vi.mock("@openmaic/lib/store/settings", () => ({ useSettingsStore: settingsMock }));
vi.mock("@/lib/learning-analytics/telemetry", () => telemetryMock);

import {
  composeAdaptiveSceneQueue,
  isClassroomAudioPrepared,
  prepareAdaptiveInsertionScenes,
  quizScoreForScene,
  resolveAdaptiveInsertionIndex,
  selectStudentLearningScenes,
  StudentStageHost,
  shouldTrackStudentLearning,
} from "./student-stage-host";

describe("standalone classroom audio readiness", () => {
  it("requires an audio URL for every narrated speech action", () => {
    const classroom = (audioUrl?: string) => ({
      scenes: [{
        id: "scene-1",
        ttsPolicy: "target-duration",
        actions: [{ id: "speech-1", type: "speech", text: "讲解内容", audioUrl }],
      }],
    }) as never;

    expect(isClassroomAudioPrepared(classroom())).toBe(false);
    expect(isClassroomAudioPrepared(classroom("/api/audio/lesson.mp3"))).toBe(true);
  });
});

describe("adaptive scene preparation", () => {
  it("namespaces inserted ids and marks only the segment tail", () => {
    const scenes = prepareAdaptiveInsertionScenes("run-1", "resource-classroom", [
      { id: "scene-1", title: "补充一", actions: [] },
      { id: "scene-2", title: "补充二", actions: [] },
    ] as never);

    expect(scenes.map((scene) => scene.id)).toEqual([
      "adaptive:run-1:scene-1",
      "adaptive:run-1:scene-2",
    ]);
    expect(
      (scenes[0] as typeof scenes[0] & { openpblAdaptiveLastScene?: boolean })
        .openpblAdaptiveLastScene,
    ).toBe(false);
    expect(
      (scenes[1] as typeof scenes[1] & { openpblAdaptiveLastScene?: boolean })
        .openpblAdaptiveLastScene,
    ).toBe(true);
  });

  it("keeps a late adaptive insertion anchored directly after its completed quiz", () => {
    const scenes = [
      { id: "quiz-1", title: "模块测验", actions: [] },
      { id: "next-1", title: "下一知识页", actions: [] },
      { id: "next-2", title: "后续知识页", actions: [] },
    ] as unknown as import("@openmaic/lib/types/stage").Scene[];

    expect(resolveAdaptiveInsertionIndex(
      scenes,
      "next-2",
      {
        id: "run-1",
        classroomId: "resource-classroom",
        placement: "after-current",
        anchorSceneId: "quiz-1",
      },
    )).toBe(1);
  });

  it("chains multiple prerequisite segments in declared order before the main lesson", () => {
    const first = prepareAdaptiveInsertionScenes("run-a", "resource-a", [
      { id: "review-a", title: "回顾 A", actions: [] },
    ] as never);
    const second = prepareAdaptiveInsertionScenes("run-b", "resource-b", [
      { id: "review-b", title: "回顾 B", actions: [] },
    ] as never);
    const queue = composeAdaptiveSceneQueue(
      [{ id: "main-1", title: "主课开场", actions: [] }] as never,
      "main-1",
      [
        { insertion: { id: "run-a", classroomId: "resource-a", placement: "before-current" }, scenes: first },
        { insertion: { id: "run-b", classroomId: "resource-b", placement: "before-current" }, scenes: second },
      ],
    );

    expect(queue.scenes.map((scene) => scene.id)).toEqual([
      "adaptive:run-a:review-a",
      "adaptive:run-b:review-b",
      "main-1",
    ]);
    expect(queue.activatedSceneId).toBe("adaptive:run-a:review-a");
    expect((queue.scenes[0] as never as { openpblAdaptiveReturnSceneId?: string }).openpblAdaptiveReturnSceneId)
      .toBe("adaptive:run-b:review-b");
    expect((queue.scenes[1] as never as { openpblAdaptiveReturnSceneId?: string }).openpblAdaptiveReturnSceneId)
      .toBe("main-1");
  });
});

function classroomResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      classroom: {
        stage: { id: "classroom-1", title: "AI 课堂" },
        scenes: [{ id: "scene-1", title: "第一课", actions: [] }],
      },
    }),
  } as Response;
}

describe("StudentStageHost reporting modes", () => {
  beforeEach(() => {
    localStorage.clear();
    stageMock.reset();
    telemetryMock.createLearningEvent.mockClear();
    telemetryMock.postLearningEvents.mockClear();
    settingsMock.setState.mockClear();
    renderedStage.props = null;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/openmaic/classroom")) return classroomResponse();
      if (url.includes("/api/openmaic/progress")) {
        return { ok: true, status: 200, json: async () => ({ data: { progress: {} } }) } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("updates same-ID assets, preserves the selected page, and stops polling when generation ends", async () => {
    vi.useFakeTimers();
    const makePayload = (ready: boolean) => ({
      stage: { id: "preview", name: "预览" },
      scenes: ["scene-1", "scene-2"].map((id) => ({
        id, title: id, type: "slide", actions: [{ id: `${id}-speech`, type: "speech", text: "讲解",
          ...(ready ? { audioUrl: `/audio/${id}.mp3`, audioDurationSec: 1 } : {}) }],
      })),
      generationPreview: { contentVersion: ready ? "2" : "1", active: !ready, jobStatus: ready ? "completed" : "running",
        scenes: { "scene-1": { status: ready ? "ready" : "preparing" }, "scene-2": { status: ready ? "ready" : "preparing" } } },
    });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ success: true, classroom: makePayload(false) }) } as Response);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: true, classroom: makePayload(true) }) } as Response);
    await act(async () => { render(<StudentStageHost backHref="/teacher" classroomId="preview" mode="teacher-preview" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(stageMock.state.scenes).toHaveLength(2);
    act(() => stageMock.setState({ currentSceneId: "scene-2" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(stageMock.state.currentSceneId).toBe("scene-2");
    expect(stageMock.state.scenes[1].actions[0]).toMatchObject({ audioUrl: "/audio/scene-2.mp3" });
    expect(stageMock.state.setStage).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(9_000); });
    expect(fetchMock).toHaveBeenCalledTimes(calls);
  });

  it.each([
    { mode: "teacher-preview" as const, nextCourse: "course-1", keepScene: true, includePrevious: true },
    { mode: "teacher-preview" as const, nextCourse: "course-2", keepScene: false, includePrevious: true },
    { mode: "teacher-preview" as const, nextCourse: "course-1", keepScene: false, includePrevious: false },
    { mode: "student" as const, nextCourse: "course-1", keepScene: false, includePrevious: true },
  ])("preserves only the same-course teacher cursor when replacing a classroom: $mode / $nextCourse / $includePrevious", async ({ mode, nextCourse, keepScene, includePrevious }) => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const replacement = String(input).includes("classroom-new");
      return { ok: true, json: async () => ({ success: true, classroom: {
        stage: { id: replacement ? "classroom-new" : "classroom-old" },
        scenes: [{ id: "scene-1", title: "首页", actions: [] },
          ...(!replacement || includePrevious ? [{ id: "scene-2", title: "当前页", actions: [] }] : [])],
      } }) } as Response;
    });
    const view = render(<StudentStageHost backHref="/teacher" classroomId="classroom-old" courseId="course-1" mode={mode} />);
    await waitFor(() => expect(stageMock.state.scenes).toHaveLength(2));
    act(() => stageMock.setState({ currentSceneId: "scene-2" }));
    view.rerender(<StudentStageHost backHref="/teacher" classroomId="classroom-new" courseId={nextCourse} mode={mode} />);
    await waitFor(() => expect(stageMock.state.setStage).toHaveBeenCalledWith({ id: "classroom-new" }));
    expect(stageMock.state.currentSceneId).toBe(keepScene ? "scene-2" : "scene-1");
  });

  it("wakes a completed preview on the parent job lifecycle change and restarts polling without remounting", async () => {
    vi.useFakeTimers();
    let active = false;
    let ready = true;
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, classroom: {
      stage: { id: "preview" }, scenes: [{ id: "scene-1", title: "预览", actions: [] }],
      generationPreview: { active, contentVersion: String(active), jobStatus: active ? "running" : "completed",
        scenes: { "scene-1": { status: ready ? "ready" : "preparing" } } },
    } }) }) as Response);
    let view!: ReturnType<typeof render>;
    await act(async () => { view = render(<StudentStageHost backHref="/teacher" classroomId="preview" mode="teacher-preview" previewRefreshKey="job:completed" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    active = true;
    ready = false;
    await act(async () => { view.rerender(<StudentStageHost backHref="/teacher" classroomId="preview" mode="teacher-preview" previewRefreshKey="job:running" />); });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(view.getByRole("status").textContent).toContain("音频准备中");
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stageMock.state.setStage).toHaveBeenCalledTimes(1);
    expect(stageMock.state.currentSceneId).toBe("scene-1");
  });

  it("refreshes a failed standalone preview on window focus and resumes only active polling", async () => {
    vi.useFakeTimers();
    let active = false;
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, classroom: {
      stage: { id: "preview" }, scenes: [{ id: "scene-1", title: "预览", actions: [] }],
      generationPreview: { active, contentVersion: String(active), jobStatus: active ? "running" : "failed",
        scenes: { "scene-1": { status: active ? "preparing" : "failed" } } },
    } }) }) as Response);
    await act(async () => { render(<StudentStageHost backHref="/teacher" classroomId="preview" mode="teacher-preview" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(6_000); });
    expect(fetch).toHaveBeenCalledTimes(1);
    active = true;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(fetch).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(stageMock.state.setStage).toHaveBeenCalledTimes(1);
  });

  it("keeps the active scene engine stable during playback and applies new assets before the next start", async () => {
    vi.useFakeTimers();
    let ready = false;
    vi.mocked(fetch).mockImplementation(async () => ({ ok: true, json: async () => ({ success: true, classroom: {
      stage: { id: "preview" }, scenes: [{ id: "scene-1", title: "预览", actions: [{ id: "speech", type: "speech", text: "讲解",
        audioUrl: ready ? "/audio/updated.mp3" : "/audio/original.mp3", audioDurationSec: 1 }] }],
      generationPreview: { active: !ready, contentVersion: ready ? "2" : "1", jobStatus: ready ? "completed" : "running",
        scenes: { "scene-1": { status: "ready" } } },
    } }) }) as Response);
    await act(async () => { render(<StudentStageHost backHref="/teacher" classroomId="preview" mode="teacher-preview" />); });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const playingScene = stageMock.state.scenes[0];
    act(() => renderedStage.props?.onPlaybackStateChange?.({ engineMode: "playing", snapshot: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [] } }));
    ready = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(3_000); });
    expect(stageMock.state.scenes[0]).toBe(playingScene);
    act(() => renderedStage.props?.onPlaybackStateChange?.({ engineMode: "idle", snapshot: { sceneIndex: 0, actionIndex: 1, consumedDiscussions: [] } }));
    await act(async () => { expect(await renderedStage.prepare?.("scene-1")).toBe(true); });
    expect(stageMock.state.scenes[0]).not.toBe(playingScene);
    expect(stageMock.state.scenes[0].actions[0]).toMatchObject({ audioUrl: "/audio/updated.mp3" });
  });

  it("refreshes before playback and refuses unfinished narration without replacing the classroom", async () => {
    const classroom = { stage: { id: "preview" }, scenes: [{ id: "scene-1", title: "预览", actions: [{ id: "speech", type: "speech", text: "讲解" }] }],
      generationPreview: { contentVersion: "1", active: false, jobStatus: "failed", scenes: { "scene-1": { status: "failed" } } } };
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ success: true, classroom }) } as Response);
    const view = render(<StudentStageHost backHref="/teacher" classroomId="preview" mode="teacher-preview" />);
    await waitFor(() => expect(renderedStage.prepare).toBeTypeOf("function"));
    let allowed: boolean | undefined;
    await act(async () => { allowed = await renderedStage.prepare?.("scene-1"); });
    expect(allowed).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(view.getByRole("status").textContent).toContain("音频生成未完成");
    expect(stageMock.state.setStage).toHaveBeenCalledTimes(1);
  });

  it("emits initial learning events in student mode", async () => {
    render(
      <StudentStageHost
        backHref="/student"
        classroomId="classroom-1"
        courseId="course-1"
        studentId="student-1"
      />,
    );

    await waitFor(() => expect(telemetryMock.postLearningEvents).toHaveBeenCalled());
    const payload = telemetryMock.postLearningEvents.mock.calls[0]?.[0];
    expect(payload?.events.map((item) => item.type)).toEqual(["stage-enter", "scene-enter"]);
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/openmaic/progress"), expect.anything());
  });

  it("gives the embedded interactive canvas priority over persisted side panels", async () => {
    render(
      <StudentStageHost
        backHref="/student"
        classroomId="classroom-1"
        courseId="course-1"
        studentId="student-1"
        variant="embedded"
      />,
    );

    await waitFor(() => {
      expect(settingsMock.setState).toHaveBeenCalledWith({
        sidebarCollapsed: true,
        chatAreaCollapsed: true,
      });
    });
  });

  it("splices a prepared adaptive classroom into the mounted main scene queue", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("resource-classroom")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            classroom: {
              stage: { id: "resource-classroom", title: "拓展资源" },
              scenes: [{ id: "resource-1", title: "应用拓展", actions: [] }],
            },
          }),
        } as Response;
      }
      if (url.includes("/api/openmaic/classroom")) return classroomResponse();
      if (url.includes("/api/openmaic/progress")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { progress: {} } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(
      <StudentStageHost
        adaptiveInsertions={[{
          id: "run-1",
          classroomId: "resource-classroom",
          placement: "before-current",
        }]}
        backHref="/student"
        classroomId="classroom-1"
        courseId="course-1"
        studentId="student-1"
      />,
    );

    await waitFor(() =>
      expect(stageMock.state.currentSceneId).toBe("adaptive:run-1:resource-1"),
    );
    expect(stageMock.state.scenes.map((scene) => scene.id)).toEqual([
      "adaptive:run-1:resource-1",
      "scene-1",
    ]);
    expect(stageMock.currentSceneHistory[0]).toBe("adaptive:run-1:resource-1");
    expect(stageMock.currentSceneHistory).not.toContain("scene-1");
    expect(renderedStage.props?.autoplaySceneId).toBe("adaptive:run-1:resource-1");
  });

  it("autoplays an anchored adaptive segment and then resumes the original successor", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("resource-classroom")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            classroom: {
              stage: { id: "resource-classroom", title: "Adaptive resource" },
              scenes: [{ id: "resource-1", title: "Extension", actions: [] }],
            },
          }),
        } as Response;
      }
      if (url.includes("/api/openmaic/classroom")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            classroom: {
              stage: { id: "classroom-1", title: "AI classroom" },
              scenes: [
                { id: "quiz-1", title: "Checkpoint", actions: [] },
                { id: "scene-2", title: "Original successor", actions: [] },
              ],
            },
          }),
        } as Response;
      }
      if (url.includes("/api/openmaic/progress")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: { progress: {} } }),
        } as Response;
      }
      throw new Error(`Unexpected fetch: ${url}`);
    }));

    render(
      <StudentStageHost
        adaptiveInsertions={[{
          id: "run-after-quiz",
          classroomId: "resource-classroom",
          placement: "after-current",
          anchorSceneId: "quiz-1",
        }]}
        backHref="/student"
        classroomId="classroom-1"
        courseId="course-1"
        studentId="student-1"
      />,
    );

    await waitFor(() => {
      expect(stageMock.state.currentSceneId).toBe("adaptive:run-after-quiz:resource-1");
      expect(renderedStage.props?.autoplaySceneId).toBe("adaptive:run-after-quiz:resource-1");
    });
    expect(stageMock.state.scenes.map((scene) => scene.id)).toEqual([
      "quiz-1",
      "adaptive:run-after-quiz:resource-1",
      "scene-2",
    ]);
    expect(stageMock.state.scenes[1]).toMatchObject({
      openpblAdaptiveReturnSceneId: "scene-2",
    });

    await act(async () => {
      renderedStage.props?.onPlaybackStateChange?.({
        engineMode: "idle",
        snapshot: {
          sceneIndex: 1,
          actionIndex: 1,
          consumedDiscussions: [],
          sceneId: "adaptive:run-after-quiz:resource-1",
        },
      });
    });

    await waitFor(() => {
      expect(stageMock.state.currentSceneId).toBe("scene-2");
      expect(renderedStage.props?.autoplaySceneId).toBe("scene-2");
    });
  });

  it("teacher preview never reads or writes student progress or telemetry", async () => {
    render(
      <StudentStageHost
        backHref="#"
        classroomId="classroom-1"
        courseId="course-1"
        mode="teacher-preview"
      />,
    );

    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/openmaic/classroom"), expect.anything()));
    await waitFor(() => expect(stageMock.state.scenes).toHaveLength(1));
    expect(telemetryMock.postLearningEvents).not.toHaveBeenCalled();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.some(([url]) => String(url).includes("/api/openmaic/progress"))).toBe(false);
    expect(shouldTrackStudentLearning("teacher-preview")).toBe(false);
  });

  it("filters every explicit teacher-only PBL scene before playback", () => {
    const scenes = [
      { id: "launch", type: "slide", stageKey: "launch", audience: "teacher" },
      { id: "knowledge", type: "interactive", stageKey: "ai-learning", audience: "student", generationPurpose: "knowledge-teaching" },
      { id: "proposal", type: "slide", stageKey: "proposal", audience: "teacher", generationPurpose: "facilitation-scaffold" },
    ] as unknown as import("@openmaic/lib/types/stage").Scene[];

    expect(selectStudentLearningScenes(scenes).map((scene) => scene.id)).toEqual(["knowledge"]);
  });

  it("reads submitted scores from interactive scenes that contain a quiz", () => {
    localStorage.setItem("quizAnswers:interactive-quiz", JSON.stringify({ q1: "A", q2: "B" }));
    localStorage.setItem("quizResults:interactive-quiz", JSON.stringify([
      { status: "correct" },
      { status: "incorrect" },
    ]));

    expect(quizScoreForScene({
      id: "interactive-quiz",
      type: "interactive",
      title: "节点小测",
    } as import("@openmaic/lib/types/stage").Scene)).toBe(50);
  });

  it("reports completion only after the playback cursor exhausts the scene", async () => {
    render(
      <StudentStageHost
        backHref="/student"
        classroomId="classroom-1"
        courseId="course-1"
        studentId="student-1"
      />,
    );
    await waitFor(() => expect(renderedStage.props?.onPlaybackStateChange).toBeTypeOf("function"));

    await act(async () => {
      renderedStage.props?.onPlaybackStateChange?.({
        engineMode: "idle",
        snapshot: { sceneIndex: 0, actionIndex: 0, consumedDiscussions: [], sceneId: "scene-1" },
      });
    });
    const progressPostsBeforeCompletion = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      ([url, init]) => String(url).includes("/api/openmaic/progress") && (init as RequestInit | undefined)?.method === "POST",
    );
    expect(progressPostsBeforeCompletion).toHaveLength(0);

    await act(async () => {
      renderedStage.props?.onPlaybackStateChange?.({
        engineMode: "idle",
        snapshot: { sceneIndex: 0, actionIndex: 1, consumedDiscussions: [], sceneId: "scene-1" },
      });
    });

    await waitFor(() => {
      const post = (fetch as ReturnType<typeof vi.fn>).mock.calls.find(
        ([url, init]) => String(url).includes("/api/openmaic/progress") && (init as RequestInit | undefined)?.method === "POST",
      );
      expect(post).toBeTruthy();
      expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({
        completedScenes: ["scene-1"],
      });
    });
  });

  it("settles a submitted assessment when the student changes page manually", async () => {
    const onSceneComplete = vi.fn();
    render(
      <StudentStageHost
        backHref="/student"
        classroomId="classroom-1"
        courseId="course-1"
        onSceneComplete={onSceneComplete}
        studentId="student-1"
      />,
    );
    await waitFor(() => expect(renderedStage.props?.onPlaybackStateChange).toBeTypeOf("function"));

    localStorage.setItem("quizAnswers:scene-1", JSON.stringify({ q1: "A" }));
    localStorage.setItem("quizResults:scene-1", JSON.stringify([{ status: "correct" }]));
    const scenes = [
      { ...stageMock.state.scenes[0], type: "quiz" },
      { id: "scene-2", title: "下一页", type: "slide", actions: [] },
    ];
    act(() => stageMock.setState({ scenes }));
    act(() => stageMock.setState({ currentSceneId: "scene-2" }));

    await waitFor(() => expect(onSceneComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        scene: expect.objectContaining({ id: "scene-1" }),
        quizScore: 100,
      }),
    ));
  });
});
