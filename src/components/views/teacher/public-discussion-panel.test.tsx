import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicDiscussionSnapshot, PublicDiscussionStatus } from "@/lib/public-discussion/types";
import type { Course } from "@/lib/session/types";

const mocks = vi.hoisted(() => ({
  subscribe: vi.fn<(courseId: string, listener: () => void) => () => void>(() => () => undefined),
  speak: vi.fn(),
  cancel: vi.fn(),
}));

vi.mock("@/lib/public-discussion/realtime-client", () => ({
  subscribePublicDiscussionUpdates: mocks.subscribe,
}));

import { PublicDiscussionTeacherPanel } from "./public-discussion-panel";

const course = {
  id: "course-1",
  name: "公开讨论课",
  status: "teaching",
  students: [{ id: "student-a", name: "安同学" }],
  content: { knowledgePoints: [{ id: "kp-1", name: "证据链", description: "用可复核证据支持结论" }] },
} as unknown as Course;

function snapshot(status: PublicDiscussionStatus, roundCount = 1, soundOwner = false): PublicDiscussionSnapshot {
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
      version: status === "awaiting-student" ? 6 : 5,
      roundCount,
      currentStudent: { id: "student-a", name: "安同学" },
      isCurrentStudent: false,
      turns: [{
        id: "assistant-1",
        sequence: 1,
        role: "assistant",
        source: "system",
        content: "请说明证据为什么能够支持你的结论。",
        createdAt: "2026-09-16T00:00:00.000Z",
      }],
      createdAt: "2026-09-16T00:00:00.000Z",
      updatedAt: "2026-09-16T00:00:00.000Z",
      shouldSuggestSummary: roundCount >= 3,
    },
    teacher: { candidates: [], soundOwner },
  };
}

class MockSpeechSynthesisUtterance {
  lang = "";
  rate = 1;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly text: string) {}
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("SpeechSynthesisUtterance", MockSpeechSynthesisUtterance as unknown as typeof SpeechSynthesisUtterance);
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      cancel: mocks.cancel,
      speak: mocks.speak.mockImplementation((utterance: MockSpeechSynthesisUtterance) => {
        queueMicrotask(() => utterance.onend?.());
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("teacher public discussion voice loop", () => {
  it("plays an AI turn once and advances only after playback completes", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settings")) {
        return Response.json({ settings: { asrLanguage: "zh", ttsProviderId: "browser-native-tts", ttsSpeed: 1 } });
      }
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action?: string };
        if (body.action === "acquire-sound") return Response.json(snapshot("ai-ready", 1, true));
        if (body.action === "complete-playback") return Response.json(snapshot("awaiting-student", 1, true));
      }
      return Response.json(snapshot("ai-ready"));
    }));

    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "启用此页面的课堂声音" }));

    await waitFor(() => expect(mocks.speak).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/courses/course-1/public-discussion",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"action":"complete-playback"') }),
    ));
    expect(mocks.speak).toHaveBeenCalledTimes(1);
  });

  it("offers teacher confirmation and continuation before the third round", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/settings")) {
        return Response.json({ settings: { asrLanguage: "zh", ttsProviderId: "browser-native-tts", ttsSpeed: 1 } });
      }
      if (init?.method === "POST") return Response.json(snapshot("ai-generating", 2));
      return Response.json(snapshot("awaiting-teacher-confirmation", 2));
    }));

    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    expect(await screen.findByRole("button", { name: "确认结束并总结" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "继续追问" }));

    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/courses/course-1/public-discussion",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"action":"continue-questioning"') }),
    ));
  });

  it("removes the continuation option at the third-round limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).endsWith("/settings")) {
        return Response.json({ settings: { asrLanguage: "zh", ttsProviderId: "browser-native-tts", ttsSpeed: 1 } });
      }
      return Response.json(snapshot("awaiting-teacher-confirmation", 3));
    }));

    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    expect(await screen.findByRole("button", { name: "确认结束并总结" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "继续追问" })).toBeNull();
  });
});
