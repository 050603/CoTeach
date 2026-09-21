import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicDiscussionSnapshot, PublicDiscussionStatus } from "@/lib/public-discussion/types";

const mocks = vi.hoisted(() => ({
  playbackBlock: vi.fn(),
  subscribe: vi.fn<(courseId: string, listener: () => void) => () => void>(() => () => undefined),
}));

vi.mock("@openmaic/lib/playback/activity-events", () => ({
  dispatchPlaybackModalBlock: mocks.playbackBlock,
}));
vi.mock("@/lib/public-discussion/realtime-client", () => ({
  subscribePublicDiscussionUpdates: mocks.subscribe,
}));

import { PublicDiscussionStudentOverlay } from "./public-discussion-overlay";

function snapshot(
  status: PublicDiscussionStatus = "awaiting-student",
  current = true,
  version = 3,
): PublicDiscussionSnapshot {
  return {
    enabled: true,
    session: {
      id: "session-1",
      courseId: "course-1",
      knowledgePointId: "kp-1",
      topic: "证据链",
      mode: "inquiry",
      openingPrompt: "你的判断依据是什么？",
      status,
      version,
      roundCount: 0,
      currentStudent: { id: "student-a", name: "安同学" },
      isCurrentStudent: current,
      turns: [],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      shouldSuggestSummary: false,
    },
  };
}

function mediaStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

class MockMediaRecorder {
  static isTypeSupported = vi.fn(() => true);
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onstop: (() => void) | null = null;

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["recorded-audio"], { type: "audio/webm" }) } as BlobEvent);
    this.onstop?.();
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot())));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("student public discussion overlay", () => {
  it("falls back to text when automatic microphone access is denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error("麦克风权限已拒绝"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    render(<PublicDiscussionStudentOverlay courseId="course-1" />);

    expect(await screen.findByRole("alert")).toHaveTextContent("麦克风权限已拒绝");
    expect(screen.getByRole("textbox", { name: "文字回答" })).toBeEnabled();
    expect(mocks.playbackBlock).toHaveBeenCalledWith({ blocked: true, source: "public-discussion" });
  });

  it("shows the public conversation without exposing recording controls to other students", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(snapshot("awaiting-student", false)));
    render(<PublicDiscussionStudentOverlay courseId="course-1" />);

    expect(await screen.findByRole("dialog", { name: "全班公开讨论" })).toBeVisible();
    expect(screen.getByText("请关注教师大屏和现场发言。当前由被点名同学的设备负责收音。")).toBeVisible();
    expect(screen.queryByRole("button", { name: /点击回答|重新回答|结束回答/ })).toBeNull();
    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("course-1", expect.any(Function)));
  });

  it.each(["awaiting-retry", "awaiting-confirmation"] as const)(
    "allows recording again from %s",
    async (status) => {
      const getUserMedia = vi.fn().mockResolvedValue(mediaStream());
      Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
      vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
      vi.mocked(fetch).mockImplementation(async (_input, init) => {
        if (init?.method === "POST") return Response.json(snapshot("recording", true, 4));
        return Response.json(snapshot(status));
      });

      render(<PublicDiscussionStudentOverlay courseId="course-1" />);
      fireEvent.click(await screen.findByRole("button", { name: "重新回答" }));

      expect(await screen.findByRole("button", { name: "结束回答" })).toBeVisible();
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/api/courses/course-1/public-discussion",
        expect.objectContaining({ method: "POST", body: expect.stringContaining('"action":"start-recording"') }),
      );
    },
  );

  it("automatically starts recording only once for a waiting session version", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream());
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
    let startCalls = 0;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        startCalls += 1;
        return Response.json(snapshot("recording", true, 4));
      }
      return Response.json(snapshot());
    });

    render(<PublicDiscussionStudentOverlay courseId="course-1" />);
    expect(await screen.findByRole("button", { name: "结束回答" })).toBeVisible();
    const listener = mocks.subscribe.mock.calls[0]?.[1] as (() => void) | undefined;
    listener?.();

    await waitFor(() => expect(startCalls).toBe(1));
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("uploads the recording and does not require transcript confirmation", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream());
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/transcription")) {
        return Response.json({ text: "实验记录能够支持判断。", snapshot: snapshot("ai-generating", true, 6) });
      }
      if (init?.method === "POST") return Response.json(snapshot("recording", true, 4));
      return Response.json(snapshot());
    });

    render(<PublicDiscussionStudentOverlay courseId="course-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "结束回答" }));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/courses/course-1/public-discussion/transcription",
      expect.objectContaining({ method: "POST", body: expect.any(FormData) }),
    ));
    expect(screen.queryByRole("button", { name: "提交给 AI" })).toBeNull();
  });

  it("returns to voice-first automatic recording after a text fallback turn", async () => {
    const getUserMedia = vi.fn().mockResolvedValue(mediaStream());
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    vi.stubGlobal("MediaRecorder", MockMediaRecorder as unknown as typeof MediaRecorder);
    let nextRound = false;
    let startCalls = 0;
    vi.mocked(fetch).mockImplementation(async (_input, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string };
        if (body.action === "submit-answer") {
          nextRound = true;
          return Response.json(snapshot("ai-ready", true, 4));
        }
        if (body.action === "start-recording") {
          startCalls += 1;
          return Response.json(snapshot("recording", true, 6));
        }
      }
      return Response.json(nextRound
        ? snapshot("awaiting-student", true, 5)
        : snapshot("awaiting-retry", true, 3));
    });

    render(<PublicDiscussionStudentOverlay courseId="course-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "改用文字" }));
    fireEvent.change(screen.getByRole("textbox", { name: "文字回答" }), {
      target: { value: "用文字说明实验条件。" },
    });
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    await waitFor(() => expect(nextRound).toBe(true));

    const listener = mocks.subscribe.mock.calls[0]?.[1] as (() => void) | undefined;
    listener?.();

    expect(await screen.findByRole("button", { name: "结束回答" })).toBeVisible();
    expect(startCalls).toBe(1);
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });
});
