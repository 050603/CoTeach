import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { SimplifiedStudentStageView, SimplifiedTeacherStageView, StudentProjectionPrecache, StudentResourceProjection, videoPrecacheRanges } from "./simple-stage-resources";

const session = vi.hoisted(() => ({
  refresh: vi.fn(),
  setUiState: vi.fn(),
  markResourceDownloaded: vi.fn(),
  studentId: "student-1",
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => session,
}));

const course = {
  id: "course-1",
  uiState: {},
  resources: [
    { id: "launch-file", title: "启动说明.pdf", type: "PDF", size: "1 MB", stageKey: "launch", url: "/launch", downloadedBy: [] },
    { id: "reflection-file", title: "反思提示.pdf", type: "PDF", size: "1 MB", stageKey: "reflection", url: "/reflection", downloadedBy: [] },
  ],
} as unknown as Course;

describe("simplified stage resources", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the student title card in the first stage", () => {
    const emptyCourse = { ...course, resources: [] } as Course;
    render(<SimplifiedStudentStageView course={emptyCourse} stageKey="launch" />);

    expect(screen.getByRole("heading", { name: "了解项目任务，完成资料阅读" }).closest("header")?.className)
      .toContain("classroom-stage-header--student-card");
    expect(screen.getByText(/明确要解决的问题、阶段目标与协作分工/)).toBeTruthy();
  });

  it("uses one consistent three-state reading vocabulary", () => {
    const readingCourse = {
      ...course,
      resources: [
        { id: "launch-file", title: "启动说明.pdf", type: "PDF", size: "1 MB", stageKey: "launch", url: "/launch", downloadedBy: [] },
        { id: "launch-read", title: "分工提示.pdf", type: "PDF", size: "2 MB", stageKey: "launch", url: "/read", downloadedBy: ["student-1"] },
        { id: "launch-unread", title: "评价说明.pdf", type: "PDF", size: "3 MB", stageKey: "launch", url: "/unread", downloadedBy: [] },
      ],
    } as Course;
    render(<SimplifiedStudentStageView course={readingCourse} stageKey="launch" />);

    expect(screen.getByText(/1 MB · 阅读中/)).toBeTruthy();
    expect(screen.getByText("阅读中")).toBeTruthy();
    expect(screen.getByText(/2 MB · 已阅读/)).toBeTruthy();
    expect(screen.getByText(/3 MB · 未阅读/)).toBeTruthy();
    expect(screen.queryByText("已打开")).toBeNull();
    expect(screen.queryByText("未查看")).toBeNull();
    expect(session.markResourceDownloaded).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /评价说明\.pdf/ }));
    expect(session.markResourceDownloaded).toHaveBeenCalledWith("course-1", "launch-unread");
  });

  it("warms only bounded video ranges and staggers the request", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi.fn().mockResolvedValue({
      status: 206,
      arrayBuffer: async () => new ArrayBuffer(0),
    });
    vi.stubGlobal("fetch", fetchMock);
    const video = { id: "lesson-video", title: "课堂示范.mp4", type: "video/mp4", size: String(20 * 1024 * 1024), stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] };
    const videoCourse = { ...course, resources: [video] } as Course;

    expect(videoPrecacheRanges(video)).toEqual([
      "bytes=0-2097151",
      "bytes=20447232-20971519",
    ]);
    render(<StudentProjectionPrecache course={videoCourse} stageKey="launch" />);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.runAllTimersAsync();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([, init]) => (init as RequestInit).headers)).toEqual([
      { Range: "bytes=0-2097151" },
      { Range: "bytes=20447232-20971519" },
    ]);
    vi.useRealTimers();
  });

  it("lets a student open and leave an immersive reader", () => {
    render(<SimplifiedStudentStageView course={course} stageKey="launch" />);

    fireEvent.click(screen.getByRole("button", { name: "全屏阅读" }));
    const dialog = screen.getByRole("dialog", { name: "全屏阅读" });
    expect(dialog).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "退出全屏阅读" }));
    expect(screen.queryByRole("dialog", { name: "全屏阅读" })).toBeNull();
  });

  it("shows only the active stage files and starts a classroom projection", () => {
    render(<SimplifiedTeacherStageView course={course} stageKey="reflection" />);

    expect(screen.getAllByText("反思提示.pdf")).toHaveLength(2);
    expect(screen.queryByText("启动说明.pdf")).toBeNull();
    expect(screen.getAllByRole("heading", { name: "学习资料" })).toHaveLength(2);
    expect(screen.queryByText("轻量授课阶段")).toBeNull();
    expect(screen.queryByText(/会自动生成稳定/)).toBeNull();
    expect(screen.getByText(/PPT 请先导出为 PDF/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "删除学习资料 反思提示.pdf" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
    expect(within(screen.getByRole("dialog", { name: "学习资料预览" })).getByRole("button", { name: "投屏" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("dialog", { name: "学习资料预览" })).getByRole("button", { name: "退出全屏阅读" }));
    fireEvent.click(screen.getByRole("button", { name: "投屏" }));
    expect(session.setUiState).toHaveBeenCalledWith("course-1", {
      resourceProjection: expect.objectContaining({
        resourceId: "reflection-file",
        stageKey: "reflection",
        title: "反思提示.pdf",
        viewState: expect.objectContaining({
          page: 1,
          scrollRatio: 0,
          mediaPlaying: false,
        }),
      }),
    });
  });

  it("uses one authoritative video controller in immersive projection", () => {
    const videoCourse = {
      ...course,
      resources: [
        { id: "lesson-video", title: "课堂示范.mp4", type: "MP4", size: "58 MB", stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] },
      ],
    } as Course;
    const view = render(<SimplifiedTeacherStageView course={videoCourse} stageKey="launch" />);

    fireEvent.click(screen.getByRole("button", { name: "全屏预览" }));
    const dialog = screen.getByRole("dialog", { name: "学习资料预览" });
    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(document.querySelector("video")?.getAttribute("src")).toBe("/api/uploads/lesson-video");
    expect(document.querySelector("video")?.getAttribute("preload")).toBe("metadata");
    expect(within(dialog).getByText("全屏播放")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "投屏" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "退出全屏播放" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "投屏" }));
    const projectedCourse = {
      ...videoCourse,
      uiState: {
        resourceProjection: {
          resourceId: "lesson-video",
          stageKey: "launch",
          title: "课堂示范.mp4",
          startedAt: new Date().toISOString(),
          viewState: {
            mediaTime: 12,
            mediaPlaying: false,
            mediaPlaybackRate: 1,
            updatedAt: new Date().toISOString(),
            revision: 2,
          },
        },
      },
    } as Course;
    view.rerender(<SimplifiedTeacherStageView course={projectedCourse} stageKey="launch" />);

    expect(document.querySelectorAll("video")).toHaveLength(1);
    expect(within(screen.getByRole("dialog", { name: "学习资料预览" })).getByText("实时投屏控制")).toBeTruthy();
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "currentTime", { configurable: true, value: 18, writable: true });
    Object.defineProperty(video, "playbackRate", { configurable: true, value: 1.25, writable: true });
    fireEvent.play(video);
    expect(session.setUiState).toHaveBeenLastCalledWith("course-1", {
      resourceProjection: expect.objectContaining({
        viewState: expect.objectContaining({ mediaPlaying: true, mediaTime: 18, mediaPlaybackRate: 1.25 }),
      }),
    });
    fireEvent.ended(video);
    expect(session.setUiState).toHaveBeenLastCalledWith("course-1", {
      resourceProjection: expect.objectContaining({
        viewState: expect.objectContaining({ mediaPlaying: false, mediaTime: 18 }),
      }),
    });
  });

  it("shows a paused projected video without an authorization cover", () => {
    const resource = { id: "lesson-video", title: "课堂示范.mp4", type: "MP4", size: "58 MB", stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] };
    const projection = {
      resourceId: resource.id,
      stageKey: "launch",
      title: resource.title,
      startedAt: new Date().toISOString(),
      viewState: { mediaTime: 0, mediaPlaying: false, mediaPlaybackRate: 1, updatedAt: new Date().toISOString(), revision: 3 },
    };

    const view = render(<StudentResourceProjection course={course} projection={projection} resource={resource} />);

    expect(document.querySelector("video")?.getAttribute("src")).toBe("/api/uploads/lesson-video");
    expect(document.querySelector("video")?.muted).toBe(true);
    expect(screen.queryByRole("button", { name: /同步播放|同步声音/ })).toBeNull();
    view.unmount();
    expect(document.querySelector("video")).toBeNull();
  });

  it("falls back to muted picture sync when the browser blocks sound autoplay", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play")
      .mockRejectedValueOnce(new DOMException("autoplay blocked", "NotAllowedError"))
      .mockResolvedValue(undefined);
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const resource = { id: "lesson-video", title: "课堂示范.mp4", type: "MP4", size: "58 MB", stageKey: "launch", url: "/api/uploads/lesson-video", downloadedBy: [] };
    const playingProjection = {
      resourceId: resource.id,
      stageKey: "launch",
      title: resource.title,
      startedAt: new Date().toISOString(),
      viewState: { mediaTime: 8, mediaPlaying: true, mediaPlaybackRate: 1, updatedAt: new Date().toISOString(), revision: 4 },
    };
    const view = render(<StudentResourceProjection course={course} projection={playingProjection} resource={resource} />);
    const video = document.querySelector("video")!;
    Object.defineProperty(video, "readyState", { configurable: true, value: 4 });
    Object.defineProperty(video, "duration", { configurable: true, value: 120 });

    fireEvent.loadedMetadata(video);

    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(video.muted).toBe(true);
    expect(screen.getByRole("button", { name: "点击开启同步声音" })).toBeTruthy();

    view.rerender(<StudentResourceProjection
      course={course}
      projection={{ ...playingProjection, viewState: { ...playingProjection.viewState, mediaPlaying: false, revision: 5 } }}
      resource={resource}
    />);
    await waitFor(() => expect(pause).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "点击开启同步声音" })).toBeNull();
  });

  it("asks whether an uploaded PDF is a slide deck and submits slide mode", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "POST"
        ? { ok: true, json: async () => ({ id: "new-pdf", title: "课堂演示.pdf" }) }
        : { ok: false, status: 404 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    session.refresh.mockResolvedValue(undefined);
    render(<SimplifiedTeacherStageView course={course} stageKey="reflection" />);

    fireEvent.change(screen.getByLabelText("上传资料"), {
      target: {
        files: [new File(["%PDF-1.7"], "课堂演示.pdf", { type: "application/pdf" })],
      },
    });

    expect(screen.getByRole("dialog", { name: "这份 PDF 如何用于课堂？" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /幻灯片演示/ }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));
    const request = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")?.[1] as { body: FormData };
    expect(request.body.get("pdfDisplayMode")).toBe("slides");
  });

  it("switches an existing PDF to slide playback without re-uploading it", async () => {
    const fetchMock = vi.fn().mockImplementation(async (_input: RequestInfo | URL, init?: RequestInit) => (
      init?.method === "PATCH"
        ? { ok: true, json: async () => ({ id: "reflection-file", displayMode: "slides" }) }
        : { ok: false, status: 404 }
    ));
    vi.stubGlobal("fetch", fetchMock);
    session.refresh.mockResolvedValue(undefined);
    render(<SimplifiedTeacherStageView course={course} stageKey="reflection" />);

    fireEvent.click(screen.getByRole("button", { name: "逐页演示" }));

    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true));
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(patchCall?.[0]).toBe("/api/uploads/reflection-file");
    expect(JSON.parse(String(patchCall?.[1]?.body))).toEqual({ displayMode: "slides" });
    expect(session.refresh).toHaveBeenCalledWith("teacher");
  });
});
