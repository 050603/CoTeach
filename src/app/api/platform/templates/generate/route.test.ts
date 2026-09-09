import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), origin: vi.fn(), rateLimit: vi.fn(), llm: vi.fn() }));
vi.mock("@/lib/auth/request-guards", () => ({ authenticateRequest: mocks.authenticate, requireSameOrigin: mocks.origin }));
vi.mock("@/lib/auth/distributed-rate-limit", () => ({ checkDistributedRateLimit: mocks.rateLimit }));
vi.mock("@/lib/llm/client", () => ({ callLLM: mocks.llm, parseLLMJson: JSON.parse }));
const output = { summary: "通过测量设计校园雨水收集装置。", learningObjectives: ["计算集水面积"], outline: [{ title: "调查与设计", durationMinutes: 45, description: "测量集水区，分组计算并提出设计方案。" }], resources: [{ title: "学校平面图", url: "" }] };
function request(body: unknown = { title: "雨水收集", subject: "科学", grade: "七年级", durationMinutes: 45, brief: "设计雨水收集装置" }) { return new Request("http://localhost/api/platform/templates/generate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
describe("course library generation", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.origin.mockReturnValue(null); mocks.authenticate.mockResolvedValue({ claims: { role: "teacher", sub: "teacher-1" } }); mocks.rateLimit.mockResolvedValue({ allowed: true }); mocks.llm.mockResolvedValue(JSON.stringify(output)); });
  it("returns a validated reviewable teaching plan with teacher-specified metadata", async () => {
    const response = await POST(request()); const data = await response.json();
    expect(response.status).toBe(200); expect(data.content).toMatchObject({ schemaVersion: 1, title: "雨水收集", durationMinutes: 45, ...output });
    expect(mocks.authenticate).toHaveBeenCalledWith(expect.any(Request), "teacher");
  });
  it("rejects invalid timing rather than publishing a misleading plan", async () => {
    mocks.llm.mockResolvedValue(JSON.stringify({ ...output, outline: [{ ...output.outline[0], durationMinutes: 10 }] }));
    const response = await POST(request()); expect(response.status).toBe(502); expect((await response.json()).code).toBe("GENERATION_INVALID");
  });
  it("does not call the model for unauthenticated requests", async () => {
    mocks.authenticate.mockResolvedValue({ response: new Response(null, { status: 401 }) });
    expect((await POST(request())).status).toBe(401); expect(mocks.llm).not.toHaveBeenCalled();
  });
  it("keeps invalid requests away from the model", async () => {
    expect((await POST(request({ title: "", durationMinutes: 0 }))).status).toBe(400); expect(mocks.llm).not.toHaveBeenCalled();
  });
  it("rejects unsafe reference links from generated output", async () => {
    mocks.llm.mockResolvedValue(JSON.stringify({ ...output, resources: [{ title: "链接", url: "javascript:alert(1)" }] }));
    expect((await POST(request())).status).toBe(502);
  });
});
