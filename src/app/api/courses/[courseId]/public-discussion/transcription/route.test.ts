// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  sameOrigin: vi.fn(),
  canAccess: vi.fn(),
  enabled: vi.fn(),
  begin: vi.fn(),
  finish: vi.fn(),
  settings: vi.fn(),
  transcribe: vi.fn(),
  initialize: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.authenticate,
  requireSameOrigin: mocks.sameOrigin,
}));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.canAccess }));
vi.mock("@/lib/public-discussion/service", () => ({
  PublicDiscussionError: class PublicDiscussionError extends Error {
    constructor(readonly code: string, message: string, readonly status = 409) { super(message); }
  },
  isPublicDiscussionEnabled: mocks.enabled,
  beginTranscription: mocks.begin,
  finishTranscription: mocks.finish,
}));
vi.mock("@/lib/public-discussion/settings", () => ({ getPublicDiscussionSettings: mocks.settings }));
vi.mock("@openmaic/lib/audio/asr-providers", () => ({ transcribeAudio: mocks.transcribe }));
vi.mock("@openmaic/lib/server/provider-config", () => ({
  initializeServerProviderConfig: mocks.initialize,
  resolveASRApiKey: vi.fn(() => "server-key"),
  resolveASRBaseUrl: vi.fn(() => "https://asr.example.test/v1"),
  resolveASRModel: vi.fn(() => "qwen-audio-3.0-asr-flash"),
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };
const requestId = "018f47a2-89d4-7c12-a4f4-18f244f6ec0b";

function recordingRequest(): Request {
  const form = new FormData();
  form.set("audio", new File(["audio-bytes"], "answer.webm", { type: "audio/webm" }));
  form.set("requestId", requestId);
  form.set("expectedVersion", "4");
  return new Request("http://localhost/api/courses/course-1/public-discussion/transcription", {
    method: "POST",
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(null);
  mocks.authenticate.mockResolvedValue({ claims: { sub: "student-a", role: "student" } });
  mocks.canAccess.mockResolvedValue(true);
  mocks.enabled.mockReturnValue(true);
  mocks.begin.mockResolvedValue({ sessionId: "session-1", generationVersion: 5 });
  mocks.settings.mockResolvedValue({ asrProviderId: "qwen-asr", asrModelId: "stale-model", asrLanguage: "zh" });
  mocks.transcribe.mockResolvedValue({ text: "实验记录能够支持判断。" });
  mocks.finish.mockResolvedValue({ enabled: true, session: { status: "ai-ready", version: 7 } });
});

describe("public discussion transcription", () => {
  it("passes recognized speech directly into the atomic answer flow", async () => {
    const response = await POST(recordingRequest(), context);

    expect(response.status).toBe(200);
    expect(mocks.finish).toHaveBeenCalledWith({
      courseId: "course-1",
      claims: { sub: "student-a", role: "student" },
      requestId,
      sessionId: "session-1",
      generationVersion: 5,
      success: true,
      text: "实验记录能够支持判断。",
    });
    await expect(response.json()).resolves.toMatchObject({ text: "实验记录能够支持判断。" });
  });

  it("returns the retry snapshot when ASR fails", async () => {
    mocks.transcribe.mockRejectedValue(new Error("provider unavailable"));
    mocks.finish.mockResolvedValue({ enabled: true, session: { status: "awaiting-retry", version: 6 } });

    const response = await POST(recordingRequest(), context);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({
      code: "TRANSCRIPTION_FAILED",
      snapshot: { session: { status: "awaiting-retry" } },
    });
    expect(mocks.finish).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });
});
