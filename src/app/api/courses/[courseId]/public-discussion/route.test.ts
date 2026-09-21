import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  sameOrigin: vi.fn(),
  canAccess: vi.fn(),
  rateLimit: vi.fn(),
  enabled: vi.fn(),
  snapshot: vi.fn(),
  submit: vi.fn(),
  start: vi.fn(),
  continueQuestioning: vi.fn(),
}));

vi.mock("@/lib/auth/request-guards", () => ({
  authenticateRequest: mocks.authenticate,
  requireSameOrigin: mocks.sameOrigin,
}));
vi.mock("@/lib/platform/access", () => ({ canAccessLegacyCourse: mocks.canAccess }));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.rateLimit }));
vi.mock("@/lib/auth/rate-limit", () => ({ rateLimitedResponse: () => new Response(null, { status: 429 }) }));
vi.mock("@/lib/public-discussion/service", () => ({
  PublicDiscussionError: class PublicDiscussionError extends Error {},
  isPublicDiscussionEnabled: mocks.enabled,
  getPublicDiscussionSnapshot: mocks.snapshot,
  submitStudentAnswer: mocks.submit,
  startPublicDiscussion: mocks.start,
  acquireDiscussionSound: vi.fn(),
  addTeacherGuidance: vi.fn(),
  completeDiscussionPlayback: vi.fn(),
  continueDiscussionQuestioning: mocks.continueQuestioning,
  finishPublicDiscussion: vi.fn(),
  inviteDiscussionStudent: vi.fn(),
  pausePublicDiscussion: vi.fn(),
  recommendDiscussionCandidates: vi.fn(),
  respondToInvitation: vi.fn(),
  retryAssistantReply: vi.fn(),
  setRecordingState: vi.fn(),
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ courseId: "course-1" }) };
const requestId = "018f47a2-89d4-7c12-a4f4-18f244f6ec0b";

function post(body: unknown): Request {
  return new Request("http://localhost/api/courses/course-1/public-discussion", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.sameOrigin.mockReturnValue(null);
  mocks.canAccess.mockResolvedValue(true);
  mocks.rateLimit.mockResolvedValue({ allowed: true });
  mocks.enabled.mockReturnValue(true);
  mocks.authenticate.mockResolvedValue({ claims: { sub: "student-a", role: "student" } });
  mocks.snapshot.mockResolvedValue({ enabled: true });
  mocks.submit.mockResolvedValue({ enabled: true, session: { version: 4 } });
  mocks.continueQuestioning.mockResolvedValue({ enabled: true, session: { version: 8 } });
});

describe("public discussion classroom API", () => {
  it("returns the disabled snapshot without exposing an active session", async () => {
    mocks.snapshot.mockResolvedValue({ enabled: false });
    const response = await GET(new Request("http://localhost/api/courses/course-1/public-discussion"), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ enabled: false });
  });

  it("rejects cross-class access before reading the action", async () => {
    mocks.canAccess.mockResolvedValue(false);
    const response = await POST(post({ action: "submit-answer" }), context);

    expect(response.status).toBe(403);
    expect(mocks.submit).not.toHaveBeenCalled();
  });

  it("prevents a student from using teacher controls", async () => {
    const response = await POST(post({
      action: "start",
      requestId,
      knowledgePointId: "kp-1",
      topic: "证据链",
      mode: "inquiry",
      openingPrompt: "你的判断依据是什么？",
      studentId: "student-a",
    }), context);

    expect(response.status).toBe(403);
    expect(mocks.start).not.toHaveBeenCalled();
  });

  it("submits an answer using the authenticated student's claims and request id", async () => {
    const response = await POST(post({
      action: "submit-answer",
      requestId,
      expectedVersion: 3,
      content: "实验记录能让判断被复核。",
      source: "voice",
    }), context);

    expect(response.status).toBe(200);
    expect(mocks.submit).toHaveBeenCalledWith({
      courseId: "course-1",
      claims: { sub: "student-a", role: "student" },
      requestId,
      expectedVersion: 3,
      content: "实验记录能让判断被复核。",
      source: "voice",
    });
  });

  it("allows only a teacher to continue after an AI completion recommendation", async () => {
    const denied = await POST(post({
      action: "continue-questioning",
      requestId,
      expectedVersion: 7,
    }), context);
    expect(denied.status).toBe(403);
    expect(mocks.continueQuestioning).not.toHaveBeenCalled();

    mocks.authenticate.mockResolvedValue({ claims: { sub: "teacher-a", role: "teacher" } });
    const accepted = await POST(post({
      action: "continue-questioning",
      requestId,
      expectedVersion: 7,
    }), context);
    expect(accepted.status).toBe(200);
    expect(mocks.continueQuestioning).toHaveBeenCalledWith({
      courseId: "course-1",
      claims: { sub: "teacher-a", role: "teacher" },
      requestId,
      expectedVersion: 7,
    });
  });
});
