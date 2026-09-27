import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { appendDurableAiInteractionEvents } from "@/lib/ai-collaboration/audit-outbox";
import { callLLM } from "@openmaic/lib/ai/llm";
import { gradeKnowledgeLectureQuestion } from "./knowledge-lecture-grading";
vi.mock("@/lib/db/client", () => ({ isDatabaseConfigured: () => true }));
vi.mock("@/lib/ai-collaboration/audit-outbox", () => ({ appendDurableAiInteractionEvents: vi.fn() }));
vi.mock("@openmaic/lib/ai/llm", () => ({ callLLM: vi.fn() }));
const input = () => ({ courseId: "course", studentId: "student", classroomId: "classroom", attemptId: "attempt",
  question: { questionId: "question", questionType: "short_answer" as const, prompt: "完整题目", answer: "原始学生答案", rawAnswer: "原始学生答案", points: 6, earned: 0, correct: null, gradingStatus: "pending" as const, feedback: "待批阅", knowledgePointIds: [] },
  signal: new AbortController().signal, resolveModel: vi.fn(async () => ({ model: { modelId: "test-model" } }) as never) });
const facts = () => vi.mocked(appendDurableAiInteractionEvents).mock.calls.flatMap(([events]) => events);
beforeEach(() => { vi.clearAllMocks(); vi.mocked(appendDurableAiInteractionEvents).mockResolvedValue(undefined); vi.mocked(callLLM).mockResolvedValue({ text: '{"score":6,"comment":"完整评分"}' } as never); });
describe("immutable subjective grading evidence", () => {
  it("retains full raw beyond feedback limit, exact input, stable IDs and terminal status", async () => {
    const raw = JSON.stringify({ score: 6, comment: "完整长评语".repeat(700), additional: "原始扩展字段" });
    vi.mocked(callLLM).mockResolvedValueOnce({ text: raw } as never);
    const result = await gradeKnowledgeLectureQuestion(input());
    expect(result.feedback).toHaveLength(1500); expect(result.answer).toBe("原始学生答案");
    const events = facts(); expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({ content: "原始学生答案", eventType: "request", payload: { status: "started", prompt: expect.stringContaining("原始学生答案") } });
    expect(events[1]).toMatchObject({ content: raw, actorRole: "system", payload: { kind: "model-output", rawLength: raw.length, rawSha256: createHash("sha256").update(raw).digest("hex"), status: "success", modelId: "test-model" } });
    expect(events[2]).toMatchObject({ eventType: "policy", payload: { status: "success", earned: 6, gradingStatus: "graded", elapsedMs: expect.any(Number) } });
    expect(new Set(events.map(event => event.requestId)).size).toBe(1); expect(new Set(events.map(event => event.id)).size).toBe(3);
  });
  it("invalid output survives retry with new facts and unchanged original input", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce({ text: "{malformed private raw}" } as never);
    const first = await gradeKnowledgeLectureQuestion(input()); const original = structuredClone(facts());
    expect(first.gradingStatus).toBe("failed"); expect(original[1].content).toBe("{malformed private raw}");
    expect(original[2].payload).toMatchObject({ status: "failed", errorCode: "INVALID_JSON" });
    const retry = await gradeKnowledgeLectureQuestion(input()); expect(retry.gradingStatus).toBe("graded");
    expect(facts().slice(0, 3)).toEqual(original); expect(facts()[3].requestId).not.toBe(original[0].requestId);
  });
  for (const [name, error, code] of [
    ["provider timeout", Object.assign(new Error("secret upstream URL"), { cause: { code: "UND_ERR_HEADERS_TIMEOUT" } }), "PROVIDER_TIMEOUT"],
    ["provider error", new Error("secret credentials"), "PROVIDER_REQUEST_FAILED"],
    ["rate limit", Object.assign(new Error("secret"), { statusCode: 429 }), "CAPACITY_OR_RATE_LIMIT"],
    ["cancelled", new DOMException("secret", "AbortError"), "CANCELLED"],
  ] as const) it(`retains safe ${name} category without exception secrets`, async () => {
    vi.mocked(callLLM).mockRejectedValueOnce(error);
    expect((await gradeKnowledgeLectureQuestion(input())).gradingStatus).toBe("failed");
    expect(facts()).toHaveLength(2); expect(facts()[1].payload).toMatchObject({ status: code === "CANCELLED" ? "cancelled" : "failed", errorCode: code });
    expect(JSON.stringify(facts())).not.toContain("secret");
  });
  it("persists cancellation facts even when the original HTTP signal is already aborted", async () => {
    const args = input(); const controller = new AbortController(); controller.abort(); args.signal = controller.signal;
    expect((await gradeKnowledgeLectureQuestion(args)).gradingStatus).toBe("failed");
    expect(args.resolveModel).not.toHaveBeenCalled(); expect(callLLM).not.toHaveBeenCalled();
    expect(facts()).toHaveLength(2); expect(facts()[1].payload).toMatchObject({ status: "cancelled", errorCode: "CANCELLED" });
  });
  it("records resolution failure without calling provider", async () => {
    const args = input(); args.resolveModel.mockRejectedValueOnce(new Error("secret configuration"));
    await gradeKnowledgeLectureQuestion(args); expect(callLLM).not.toHaveBeenCalled();
    expect(facts()[1].payload?.errorCode).toBe("MODEL_RESOLUTION_FAILED");
  });
  it("records invalid numeric grade separately from JSON failures", async () => {
    vi.mocked(callLLM).mockResolvedValueOnce({ text: '{"score":999}' } as never); await gradeKnowledgeLectureQuestion(input());
    expect(facts()[2].payload?.errorCode).toBe("INVALID_SCORE");
  });
  it("does not call a model when both audit stores reject request retention", async () => {
    vi.mocked(appendDurableAiInteractionEvents).mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(gradeKnowledgeLectureQuestion(input())).rejects.toThrow("ENOSPC"); expect(callLLM).not.toHaveBeenCalled();
  });
  it("does not acknowledge grading if raw and terminal retention fails", async () => {
    vi.mocked(appendDurableAiInteractionEvents).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(gradeKnowledgeLectureQuestion(input())).rejects.toThrow("ENOSPC");
  });
});
