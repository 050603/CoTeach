import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicDiscussionSnapshot } from "@/lib/public-discussion/types";

const mocks = vi.hoisted(() => ({
  playbackBlock: vi.fn(),
  subscribe: vi.fn(() => () => undefined),
}));

vi.mock("@openmaic/lib/playback/activity-events", () => ({
  dispatchPlaybackModalBlock: mocks.playbackBlock,
}));
vi.mock("@/lib/public-discussion/realtime-client", () => ({
  subscribePublicDiscussionUpdates: mocks.subscribe,
}));

import { PublicDiscussionStudentOverlay } from "./public-discussion-overlay";

function snapshot(current = true): PublicDiscussionSnapshot {
  return {
    enabled: true,
    session: {
      id: "session-1",
      courseId: "course-1",
      knowledgePointId: "kp-1",
      topic: "证据链",
      mode: "inquiry",
      openingPrompt: "你的判断依据是什么？",
      status: "awaiting-student",
      version: 3,
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

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(snapshot())));
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: undefined });
});

describe("student public discussion overlay", () => {
  it("keeps the text fallback available when microphone permission is denied", async () => {
    const getUserMedia = vi.fn().mockRejectedValue(new Error("麦克风权限已拒绝"));
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia } });
    render(<PublicDiscussionStudentOverlay courseId="course-1" />);

    fireEvent.click(await screen.findByRole("button", { name: "点击开始录音" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("麦克风权限已拒绝");
    expect(screen.getByRole("textbox", { name: "识别文字可修改，也可直接键入" })).toBeEnabled();
    expect(mocks.playbackBlock).toHaveBeenCalledWith({ blocked: true, source: "public-discussion" });
  });

  it("shows the public conversation without exposing recording controls to other students", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json(snapshot(false)));
    render(<PublicDiscussionStudentOverlay courseId="course-1" />);

    expect(await screen.findByRole("dialog", { name: "全班公开讨论" })).toBeVisible();
    expect(screen.getByText("请关注大屏和现场发言。当前由被点名同学的设备负责收音。")).toBeVisible();
    expect(screen.queryByRole("button", { name: "点击开始录音" })).toBeNull();

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledWith("course-1", expect.any(Function)));
  });
});
