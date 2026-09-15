import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), analytics: vi.fn(), settings: vi.fn(), populate: vi.fn(), after: vi.fn() }));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.auth }));
vi.mock("@/lib/platform/survey-keyword-settings", () => ({ getSurveyKeywordSettings: mocks.settings }));
vi.mock("@/lib/platform/survey-terms", () => ({ populateSurveyTerms: mocks.populate }));
vi.mock("@/lib/platform/repository", () => ({ getSurveyAnalytics: mocks.analytics, PlatformError: class extends Error {} }));
import { GET } from "./route";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ claims: { sub: "teacher-a", role: "teacher" } });
  mocks.analytics.mockResolvedValue({ activity: { id: "activity" }, analytics: { questions: [] } });
});

describe("survey results keyword preference", () => {
  it.each(["local", "llm"])("uses the authenticated teacher's %s mode and prevents HTTP caching", async (mode) => {
    mocks.settings.mockResolvedValue({ mode });
    const response = await GET(new Request("http://localhost/api?mode=untrusted"), { params: Promise.resolve({ activityId: "activity" }) });
    expect(response.status).toBe(200);
    expect(mocks.settings).toHaveBeenCalledWith("teacher-a");
    expect(mocks.populate).toHaveBeenCalledWith("activity", [], mocks.after, 500, mode);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("does not resolve settings or schedule analysis before authentication", async () => {
    mocks.auth.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ activityId: "activity" }) });
    expect(response.status).toBe(401);
    expect(mocks.settings).not.toHaveBeenCalled();
    expect(mocks.populate).not.toHaveBeenCalled();
  });

  it.each(["settings", "populate"] as const)("still returns counts and answers when %s fails", async (failure) => {
    const respondent = { studentId: "student-a", displayName: "学生甲", content: "小组讨论帮助理解" };
    mocks.analytics.mockResolvedValue({
      activity: { id: "activity" },
      analytics: { submittedCount: 1, totalStudents: 40, questions: [
        { id: "choice", type: "single-choice", responseCount: 1, options: [{ id: "a", count: 1 }] },
        { id: "text", type: "short-text", responseCount: 1, responses: [respondent], terms: [] },
      ] },
    });
    mocks.settings.mockResolvedValue({ mode: "local" });
    mocks[failure].mockRejectedValue(new Error("analysis unavailable"));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ activityId: "activity" }) });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ analytics: {
        submittedCount: 1, totalStudents: 40, questions: [
          { responseCount: 1, options: [{ id: "a", count: 1 }] },
          { responseCount: 1, responses: [respondent], terms: [], keywordStatus: "unavailable", keywordUnrepresentedResponses: [{ studentId: "student-a", reason: "analysis-unavailable" }] },
        ],
      } });
    } finally { warning.mockRestore(); }
  });

  it("returns an error when the saved survey data cannot be read", async () => {
    mocks.analytics.mockRejectedValue(new Error("database unavailable"));
    const response = await GET(new Request("http://localhost/api"), { params: Promise.resolve({ activityId: "activity" }) });
    expect(response.status).toBe(503);
    expect(mocks.settings).not.toHaveBeenCalled();
  });
});
