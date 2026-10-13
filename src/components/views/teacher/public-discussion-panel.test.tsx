import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("teacher public discussion voice loop", () => {
  it("recovers an initial load failure and keeps a visible discussion during later refresh failures", async () => {
    let offline = true;
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (offline) throw new TypeError("网络已断开");
      return Response.json(snapshot("awaiting-student"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("网络已断开");
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载讨论" }));
    expect(await screen.findByLabelText("公开讨论记录")).toHaveTextContent("请说明证据为什么能够支持你的结论。");
    offline = true;
    act(() => mocks.subscribe.mock.calls.at(-1)![1]());
    expect(await screen.findByRole("alert")).toHaveTextContent("网络已断开");
    expect(screen.getByLabelText("公开讨论记录")).toHaveTextContent("请说明证据为什么能够支持你的结论。");
    offline = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载讨论" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("reports settings failures separately and retries without discarding a discussion", async () => {
    let failed = true;
    vi.stubGlobal("fetch", vi.fn(async (input) => String(input).endsWith("/settings")
      ? Response.json(failed ? { message: "语音设置暂时不可用" } : { settings: { asrLanguage: "zh" } }, { status: failed ? 503 : 200 })
      : Response.json(snapshot("awaiting-student"))));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("语音设置暂时不可用");
    expect(screen.getByLabelText("公开讨论记录")).toBeVisible();
    failed = false;
    fireEvent.click(screen.getByRole("button", { name: "重试加载语音设置" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /语音识别设置/ }));
    expect(screen.getByLabelText("语言")).toHaveValue("zh");
  });

  it("cancels old classroom loads and ignores their late responses after switching courses", async () => {
    let resolveOld!: (value: Response) => void;
    let oldSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (String(input).includes("course-1/")) {
        oldSignal = init?.signal;
        return new Promise<Response>((resolve) => { resolveOld = resolve; });
      }
      const fresh = snapshot("awaiting-student");
      fresh.session!.topic = "新课堂主题";
      return Response.json(fresh);
    }));
    const view = render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    await waitFor(() => expect(resolveOld).toBeDefined());
    view.rerender(<PublicDiscussionTeacherPanel course={{ ...course, id: "course-2" }} recommendedKnowledgePointIds={["kp-1"]} />);
    expect(await screen.findByText("新课堂主题")).toBeVisible();
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => resolveOld(Response.json(snapshot("paused"))));
    expect(screen.getByText("新课堂主题")).toBeVisible();
    expect(screen.queryByRole("button", { name: "恢复" })).toBeNull();
  });

  it("handles a failed recovery read after a failed classroom action", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") return Response.json({ message: "暂停失败，请重试" }, { status: 503 });
      if (++reads > 1) throw new TypeError("恢复读取失败");
      return Response.json(snapshot("awaiting-student"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "暂停" }));
    expect(await screen.findByText("暂停失败，请重试")).toBeVisible();
    expect(await screen.findByText(/恢复读取失败/)).toBeVisible();
    expect(screen.getByLabelText("公开讨论记录")).toBeVisible();
  });

  it("coalesces pending refreshes and aborts them when the panel unmounts", async () => {
    let resolveRead!: (value: Response) => void;
    let signal: AbortSignal | undefined;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      reads += 1;
      signal = init?.signal;
      return new Promise<Response>((resolve) => { resolveRead = resolve; });
    }));
    const view = render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    await waitFor(() => expect(reads).toBe(1));
    act(() => { mocks.subscribe.mock.calls.at(-1)![1](); mocks.subscribe.mock.calls.at(-1)![1](); });
    expect(reads).toBe(1);
    view.unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () => resolveRead(Response.json(snapshot("awaiting-student"))));
    expect(screen.queryByLabelText("公开讨论记录")).toBeNull();
  });

  it("does not roll an accepted pause back when an older refresh arrives", async () => {
    let resolveRefresh!: (value: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") {
        const paused = snapshot("paused");
        paused.session!.version = 7;
        return Response.json(paused);
      }
      if (++reads === 1) return Response.json(snapshot("awaiting-student"));
      return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    await screen.findByRole("button", { name: "暂停" });
    act(() => mocks.subscribe.mock.calls.at(-1)![1]());
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(await screen.findByRole("button", { name: "恢复" })).toBeVisible();
    await act(async () => resolveRefresh(Response.json(snapshot("awaiting-student"))));
    expect(screen.getByRole("button", { name: "恢复" })).toBeVisible();
  });

  it.each(["empty", "ended"])("ignores a late %s-session refresh after a new discussion starts", async (previousKind) => {
    const previous = previousKind === "empty" ? { enabled: true } : snapshot("ended");
    const started = snapshot("inviting", 0, true);
    started.session!.id = "new-session";
    started.session!.topic = "新讨论";
    started.session!.version = 1;
    let reads = 0;
    let resolveRefresh!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") return Response.json(started);
      if (++reads === 1) return Response.json(previous);
      if (reads === 2) return new Promise<Response>((resolve) => { resolveRefresh = resolve; });
      return Response.json({ ...started, session: { ...started.session, version: 2, status: "paused" } });
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.change(await screen.findByLabelText("班级名单"), { target: { value: "student-a" } });
    fireEvent.change(screen.getByLabelText("公开问题"), { target: { value: "新问题" } });
    act(() => mocks.subscribe.mock.calls.at(-1)![1]());
    fireEvent.click(screen.getByRole("button", { name: "点名并开始讨论" }));
    expect(await screen.findByText("课堂声音已连接")).toBeVisible();
    await act(async () => resolveRefresh(Response.json(previous)));
    expect(screen.getByText("新讨论")).toBeVisible();
    expect(screen.queryByRole("button", { name: "点名并开始讨论" })).toBeNull();
    act(() => mocks.subscribe.mock.calls.at(-1)![1]());
    expect(await screen.findByRole("button", { name: "恢复" })).toBeVisible();
  });

  it("keeps the latest sound ownership when acquisition responses arrive out of order at the same version", async () => {
    const resolves: Array<(value: Response) => void> = [];
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => resolves.push(resolve));
      return Response.json(snapshot("awaiting-student"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    const enable = await screen.findByRole("button", { name: "启用此页面的课堂声音" });
    fireEvent.click(enable);
    fireEvent.click(enable);
    expect(resolves).toHaveLength(2);
    await act(async () => resolves[1](Response.json(snapshot("awaiting-student", 1, true))));
    expect(screen.getByText("课堂声音已连接")).toBeVisible();
    await act(async () => resolves[0](Response.json(snapshot("awaiting-student", 1, false))));
    expect(screen.getByText("课堂声音已连接")).toBeVisible();
    expect(screen.queryByText(/另一教师页面正在控制课堂声音/)).toBeNull();
  });

  it("accepts a newly started session after a newer poll still reports the previous ended session", async () => {
    let resolveStart!: (value: Response) => void;
    let reads = 0;
    const started = snapshot("inviting", 0, true);
    started.session!.id = "new-session";
    started.session!.topic = "新讨论";
    started.session!.version = 1;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") {
        if (JSON.parse(String(init.body)).action === "start") return new Promise<Response>((resolve) => { resolveStart = resolve; });
        return Response.json(started);
      }
      reads += 1;
      return Response.json(snapshot("ended"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.change(await screen.findByLabelText("班级名单"), { target: { value: "student-a" } });
    fireEvent.change(screen.getByLabelText("公开问题"), { target: { value: "新问题" } });
    fireEvent.click(screen.getByRole("button", { name: "点名并开始讨论" }));
    await act(async () => mocks.subscribe.mock.calls.at(-1)![1]());
    expect(reads).toBe(2);
    await act(async () => resolveStart(Response.json(started)));
    expect(await screen.findByText("课堂声音已连接")).toBeVisible();
    expect(screen.getByText("新讨论")).toBeVisible();
  });

  it("enables sound after a poll reads the same session version before the sound lease commits", async () => {
    let resolveSound!: (value: Response) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { resolveSound = resolve; });
      reads += 1;
      return Response.json(snapshot("awaiting-student"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "启用此页面的课堂声音" }));
    await act(async () => mocks.subscribe.mock.calls.at(-1)![1]());
    expect(reads).toBe(2);
    await act(async () => resolveSound(Response.json(snapshot("awaiting-student", 1, true))));
    expect(screen.getByText("课堂声音已连接")).toBeVisible();
    expect(screen.queryByText(/另一教师页面正在控制课堂声音/)).toBeNull();
  });

  it("does not undo a newer pause when an earlier sound heartbeat finishes", async () => {
    const intervals = vi.spyOn(window, "setInterval");
    let acquisitions = 0;
    let resolveHeartbeat!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string };
        if (body.action === "acquire-sound" && ++acquisitions > 1) return new Promise<Response>((resolve) => { resolveHeartbeat = resolve; });
        if (body.action === "pause") {
          const paused = snapshot("paused", 1, true);
          paused.session!.version = 7;
          return Response.json(paused);
        }
        return Response.json(snapshot("awaiting-student", 1, true));
      }
      return Response.json(snapshot("awaiting-student"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "启用此页面的课堂声音" }));
    await screen.findByText("课堂声音已连接");
    const heartbeat = intervals.mock.calls.find(([, timeout]) => timeout === 15_000)![0] as () => void;
    act(() => heartbeat());
    fireEvent.click(screen.getByRole("button", { name: "暂停" }));
    expect(await screen.findByRole("button", { name: "恢复" })).toBeVisible();
    await act(async () => resolveHeartbeat(Response.json(snapshot("awaiting-student", 1, true))));
    expect(screen.getByRole("button", { name: "恢复" })).toBeVisible();
  });

  it("refreshes generation progress while a summary request is pending and accepts its newer final version", async () => {
    let reads = 0;
    let resolveSummary!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn(async (input, init) => {
      if (String(input).endsWith("/settings")) return Response.json({ settings: { asrLanguage: "zh" } });
      if (init?.method === "POST") return new Promise<Response>((resolve) => { resolveSummary = resolve; });
      if (++reads === 1) return Response.json(snapshot("awaiting-student"));
      const summarizing = snapshot("summarizing");
      summarizing.session!.version = 7;
      return Response.json(summarizing);
    }));
    render(<PublicDiscussionTeacherPanel course={course} recommendedKnowledgePointIds={["kp-1"]} />);
    fireEvent.click(await screen.findByRole("button", { name: "结束并总结" }));
    act(() => mocks.subscribe.mock.calls.at(-1)![1]());
    expect(await screen.findByText("正在形成课堂总结…")).toBeVisible();
    const ended = snapshot("ended");
    ended.session!.version = 8;
    ended.session!.summary = { keyConclusion: "最新课堂总结", misconceptionRepair: "保留条件", transferQuestion: "如何复核？" };
    await act(async () => resolveSummary(Response.json(ended)));
    expect(screen.getByText("最新课堂总结")).toBeVisible();
  });

  it("renders the discussion panel on HTTP origins without crypto.randomUUID", async () => {
    const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
    vi.stubGlobal("crypto", { getRandomValues });
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).endsWith("/settings")) {
        return Response.json({ settings: { asrLanguage: "zh", ttsProviderId: "browser-native-tts", ttsSpeed: 1 } });
      }
      return Response.json(snapshot("awaiting-student"));
    }));
    render(<PublicDiscussionTeacherPanel course={course} immersive recommendedKnowledgePointIds={["kp-1"]} />);
    expect(await screen.findByText("AI 公开讨论")).toBeVisible();
    expect(await screen.findByText("证据链")).toBeVisible();
  });

  it("uses the dedicated discussion console layout in immersive mode", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input) => {
      if (String(input).endsWith("/settings")) {
        return Response.json({ settings: { asrLanguage: "zh", ttsProviderId: "browser-native-tts", ttsSpeed: 1 } });
      }
      return Response.json(snapshot("awaiting-student"));
    }));

    render(<PublicDiscussionTeacherPanel course={course} immersive recommendedKnowledgePointIds={["kp-1"]} />);

    const title = await screen.findByText("AI 公开讨论");
    expect(title).toBeVisible();
    expect(title.closest("header")).not.toHaveClass("bg-stone-950");
    expect(await screen.findByRole("complementary", { name: "教师讨论控制" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /语音识别设置/ }));
    expect(screen.getByLabelText("服务端 ASR")).toBeVisible();
  });

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
