import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DocumentModelStructureError, repairDocumentModelResponse } from "./document-model-response";

const good = JSON.stringify({ kind: "discussion", message: "记录时间、设备、用电量和相同条件。", focus: "测量条件", suggestion: null });
const messages = [{ role: "system" as const, content: "保留学习边界" }, { role: "user" as const, content: "怎样记录条件？" }];
const setup = (raw = good) => ({ raw, messages, signal: new AbortController().signal,
  generate: vi.fn<Parameters<typeof repairDocumentModelResponse>[0]["generate"]>().mockResolvedValue(good),
  recordInvalid: vi.fn<Parameters<typeof repairDocumentModelResponse>[0]["recordInvalid"]>().mockResolvedValue(undefined),
  recordSuccess: vi.fn<Parameters<typeof repairDocumentModelResponse>[0]["recordSuccess"]>().mockResolvedValue(undefined),
});

describe("document model response recovery", () => {
  it("recovers only a missing outer brace without another model call, retaining original bytes", async () => {
    const value = { kind: "discussion", message: '保留原话："证据 } [ 不代表结构"', support: { replyBlocks: [], memoryUpdates: [{ content: "核对测量条件" }] } };
    const raw = JSON.stringify(value).slice(0, -1);
    const input = setup(raw);
    expect(await repairDocumentModelResponse(input)).toEqual(value);
    expect(input.generate).not.toHaveBeenCalled();
    expect(input.recordInvalid).toHaveBeenCalledOnce();
    expect(input.recordSuccess).toHaveBeenCalledWith({ attempt: 1, raw, sha256: createHash("sha256").update(raw).digest("hex"), recovery: "closed-outer-object" });
  });
  it.each([
    '{"kind":"discussion","message":"unfinished',
    '{"kind":"discussion","message":"answer","support":{"n":1',
    '{"kind":"discussion","message":"answer","support":{"x":[]',
    '{"kind":"discussion","message":"answer","support":{},',
    '{"kind":"unknown","message":"answer","support":{}',
  ])("does not fabricate unfinished values or bypass schema checks: %s", async raw => {
    const input = setup(raw);
    expect(await repairDocumentModelResponse(input)).toEqual(JSON.parse(good));
    expect(input.generate).toHaveBeenCalledOnce();
    expect(input.recordSuccess.mock.calls[0][0].raw).toBe(good);
  });
  it("accepts a complete response without another model call or failure event", async () => {
    const input = setup(); expect(await repairDocumentModelResponse(input)).toEqual(JSON.parse(good));
    expect(input.generate).not.toHaveBeenCalled(); expect(input.recordInvalid).not.toHaveBeenCalled();
    expect(input.recordSuccess).toHaveBeenCalledWith({ attempt: 1, raw: good, sha256: createHash("sha256").update(good).digest("hex") });
  });
  it("preserves the full successful output before returning data to the display normalizer", async () => {
    const raw = JSON.stringify({ kind: "edit-suggestion", message: "完整理由".repeat(1_000),
      suggestion: { operation: "replace", replacement: "完整修订".repeat(5_000) } });
    const input = setup(raw);
    expect(await repairDocumentModelResponse(input)).toEqual(JSON.parse(raw));
    expect(input.recordSuccess).toHaveBeenCalledWith({ attempt: 1, raw, sha256: createHash("sha256").update(raw).digest("hex") });
    expect(input.generate).not.toHaveBeenCalled();
    input.recordSuccess.mockRejectedValue(new Error("raw output persistence failed"));
    await expect(repairDocumentModelResponse(input)).rejects.toThrow("raw output persistence failed");
  });
  it("uses exact field constraints to repair invalid kind while keeping the original question and boundary", async () => {
    const raw = JSON.stringify({ kind: "discussion|edit-suggestion|boundary", message: "先记录时间。" });
    const input = setup(raw);
    expect(await repairDocumentModelResponse(input)).toEqual(JSON.parse(good));
    expect(input.recordInvalid).toHaveBeenCalledWith({ attempt: 1, reason: "INVALID_KIND", raw, sha256: createHash("sha256").update(raw).digest("hex") });
    const [repair, signal] = input.generate.mock.calls[0] as unknown as [typeof messages, AbortSignal];
    expect(signal).toBe(input.signal); expect(repair.slice(0, 2)).toEqual(messages);
    expect(repair.at(-1)?.content).toContain('kind 必须仅选择 "discussion"');
    expect(repair.at(-1)?.content).toContain("INVALID_KIND");
  });
  it("rejects array-shaped fields rather than coercing them into a valid action", async () => {
    const input = setup(JSON.stringify({ kind: ["discussion"], message: "回答" }));
    expect(await repairDocumentModelResponse(input)).toEqual(JSON.parse(good));
    expect(input.recordInvalid.mock.calls[0][0].reason).toBe("INVALID_KIND");
  });
  it("durably records every original malformed answer before repair, retaining text beyond the model context limit", async () => {
    const input = setup("bad-json:" + "长".repeat(20_000));
    const order: string[] = [];
    input.recordInvalid.mockImplementation(async () => { order.push("record"); });
    input.generate.mockImplementationOnce(async () => { order.push("repair"); return '{"kind":"discussion","message":""}'; })
      .mockImplementationOnce(async () => { order.push("repair"); return good; });
    expect(await repairDocumentModelResponse(input)).toEqual(JSON.parse(good));
    expect(order).toEqual(["record", "repair", "record", "repair"]);
    expect(input.recordInvalid.mock.calls[0][0]).toMatchObject({ attempt: 1, reason: "INVALID_JSON", raw: input.raw });
    expect(input.recordInvalid.mock.calls[1][0]).toMatchObject({ attempt: 2, reason: "EMPTY_MESSAGE" });
    expect(input.recordSuccess).toHaveBeenCalledWith(expect.objectContaining({ attempt: 3, raw: good }));
    const prompt = input.generate.mock.calls[0][0] as unknown as Array<{ role: string; content: string }>;
    expect(prompt.find(item => item.role === "assistant")?.content).toHaveLength(12_000);
  });
  it("stops after two repairs and reports a structured failure instead of manufacturing a successful answer", async () => {
    const raw = '{"kind":"edit-suggestion","message":"修改段落","suggestion":{"operation":"delete","replacement":"内容"}}';
    const input = setup(raw); input.generate.mockResolvedValue(raw);
    await expect(repairDocumentModelResponse(input)).rejects.toMatchObject({ name: "DocumentModelStructureError", code: "AI_RESPONSE_INVALID_STRUCTURE", attempts: 3, reason: "INVALID_SUGGESTION" });
    expect(input.generate).toHaveBeenCalledTimes(2); expect(input.recordInvalid).toHaveBeenCalledTimes(3);
    expect(input.recordInvalid.mock.calls.map(call => call[0].attempt)).toEqual([1, 2, 3]);
  });
  it("records the available failed output but never starts a repair after the original deadline", async () => {
    const input = setup("invalid"); const controller = new AbortController(); controller.abort(new Error("original deadline")); input.signal = controller.signal;
    await expect(repairDocumentModelResponse(input)).rejects.toThrow("original deadline");
    expect(input.recordInvalid).toHaveBeenCalledOnce(); expect(input.generate).not.toHaveBeenCalled();
  });
  it("stops if failed output cannot be durably recorded", async () => {
    const input = setup("invalid"); input.recordInvalid.mockRejectedValue(new Error("outbox disk failed"));
    await expect(repairDocumentModelResponse(input)).rejects.toThrow("outbox disk failed");
    expect(input.generate).not.toHaveBeenCalled();
  });
  it("preserves an upstream failure without misclassifying it as malformed model output", async () => {
    const input = setup("invalid"); const upstream = new Error("upstream unavailable"); input.generate.mockRejectedValue(upstream);
    await expect(repairDocumentModelResponse(input)).rejects.toBe(upstream);
    expect(input.recordInvalid).toHaveBeenCalledOnce(); expect(input.generate).toHaveBeenCalledOnce();
  });
  it("accepts the model boundary without changing its meaning", async () => {
    const value = { kind: "boundary", message: "我可以提示核验方法，最终结论请你依据测量数据作出。" };
    const input = setup(JSON.stringify(value)); expect(await repairDocumentModelResponse(input)).toEqual(value);
    expect(input.generate).not.toHaveBeenCalled();
    expect(new DocumentModelStructureError(3, "INVALID_KIND").message).toBe("AI_RESPONSE_INVALID_STRUCTURE");
  });
});
