// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { EventEmitter } from "node:events";
type FakeWorker = EventEmitter & { postMessage: ReturnType<typeof vi.fn>; terminate: ReturnType<typeof vi.fn>; ref: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> };
const mocks = vi.hoisted(() => ({ workers: [] as FakeWorker[], options: [] as unknown[], throwAt: -1 }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return { Worker: class extends EventEmitter {
    postMessage = vi.fn(); terminate = vi.fn(async () => 0); ref = vi.fn(); unref = vi.fn();
    constructor(filename: string, options: unknown) { super(); if (mocks.workers.length === mocks.throwAt) throw new Error("spawn failed"); mocks.workers.push(this); mocks.options.push({ filename, options }); }
  } };
});
const input = { html: "<p>正文</p>", title: "文档", imageCount: 0 };
const ready = (worker: FakeWorker) => worker.emit("message", { type: "ready", protocol: 1 });
const finish = (worker: FakeWorker) => { const job = worker.postMessage.mock.calls.at(-1)![0]; worker.emit("message", { type: "result", id: job.id, bytes: new Uint8Array([1, 2]), sha256: "a".repeat(64) }); };
async function started() { const poolModule = await import("./document-conversion-pool"); const startup = poolModule.initializeDocumentConversionPool(); mocks.workers.forEach(ready); await startup; return poolModule; }
beforeEach(() => {
  vi.resetModules(); delete globalThis.__openPblDocumentConversionPool; mocks.workers.length = 0; mocks.options.length = 0; mocks.throwAt = -1;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
});
afterEach(async () => {
  const { stopDocumentConversionPool } = await import("./document-conversion-pool"); await stopDocumentConversionPool();
  delete globalThis.__openPblDocumentConversionPool; vi.useRealTimers();
});
it("requires both warmed workers and uses only the release artifact without loaders", async () => {
  const poolModule = await import("./document-conversion-pool"); const initialization = poolModule.initializeDocumentConversionPool();
  ready(mocks.workers[0]); expect(poolModule.documentConversionHealth().ok).toBe(false);
  ready(mocks.workers[1]); await initialization;
  expect(poolModule.documentConversionHealth()).toMatchObject({ ok: true, ready: 2 });
  expect(mocks.options).toHaveLength(2);
  for (const options of mocks.options) expect(options).toMatchObject({ filename: expect.stringMatching(/workers\/docx-converter\.cjs$/), options: { execArgv: [], env: { NODE_ENV: "production" } } });
});
it("dispatches 40 jobs with only two active workers and preserves each matching response", async () => {
  const poolModule = await started();
  const jobs = Array.from({ length: 40 }, (_, index) => poolModule.convertDocumentInWorker({ ...input, title: String(index) }));
  await vi.advanceTimersByTimeAsync(1); expect(poolModule.documentConversionHealth()).toMatchObject({ busy: 2, queued: 38 });
  for (let index = 0; index < 40; index++) { finish(mocks.workers[index % 2]); expect(poolModule.documentConversionHealth().busy).toBeLessThanOrEqual(2); }
  expect(await Promise.all(jobs)).toHaveLength(40); expect(poolModule.documentConversionHealth()).toMatchObject({ busy: 0, queued: 0 });
  const titles = mocks.workers.flatMap(worker => worker.postMessage.mock.calls.map(call => call[0].input.title)).sort((a, b) => Number(a) - Number(b));
  expect(titles).toEqual(Array.from({ length: 40 }, (_, index) => String(index)));
});
it("bounds waiting to 64, expires queued jobs without executing, and never falsely cancels active work", async () => {
  const poolModule = await started();
  const active = [poolModule.convertDocumentInWorker(input), poolModule.convertDocumentInWorker(input)]; await vi.advanceTimersByTimeAsync(1);
  const waiting = Array.from({ length: 65 }, () => poolModule.convertDocumentInWorker(input).catch(error => error));
  await vi.advanceTimersByTimeAsync(1); expect(await waiting.at(-1)).toMatchObject({ code: "DOCUMENT_CONVERSION_BUSY" });
  await vi.advanceTimersByTimeAsync(10000);
  expect((await Promise.all(waiting)).every(value => value.code === "DOCUMENT_CONVERSION_BUSY")).toBe(true);
  expect(poolModule.documentConversionHealth()).toMatchObject({ busy: 2, queued: 0 });
  expect(mocks.workers.flatMap(worker => worker.postMessage.mock.calls)).toHaveLength(2);
  mocks.workers.forEach(finish); await Promise.all(active);
});
it("shares the pool across imports and replaces a crashed worker without replaying its active job", async () => {
  const one = await started(); vi.resetModules(); const two = await import("./document-conversion-pool");
  await two.initializeDocumentConversionPool(); expect(mocks.workers).toHaveLength(2);
  const first = one.convertDocumentInWorker(input).catch(error => error); await vi.advanceTimersByTimeAsync(1);
  mocks.workers[0].emit("error", new Error("crash"));
  expect(await first).toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" });
  expect(one.documentConversionHealth().ok).toBe(false);
  await vi.advanceTimersByTimeAsync(1); expect(mocks.workers).toHaveLength(3); ready(mocks.workers[2]);
  expect(two.documentConversionHealth().ok).toBe(true);
  expect(mocks.workers[2].postMessage).not.toHaveBeenCalled();
  const retry = two.convertDocumentInWorker(input); await vi.advanceTimersByTimeAsync(1); finish(mocks.workers[2]); await retry;
});
it("preserves DOCX_INVALID failures and releases the worker for subsequent work", async () => {
  const poolModule = await started(); const bad = poolModule.convertDocumentInWorker(input).catch(error => error); await vi.advanceTimersByTimeAsync(1);
  const worker = mocks.workers[0]; const job = worker.postMessage.mock.calls[0][0];
  worker.emit("message", { type: "error", id: job.id, code: "DOCX_INVALID", message: "图片未完整包含" });
  expect(await bad).toMatchObject({ code: "DOCX_INVALID", message: "图片未完整包含" });
  const retry = poolModule.convertDocumentInWorker(input); await vi.advanceTimersByTimeAsync(1); finish(worker); await retry;
});
it("fails initialization explicitly when a worker never warms", async () => {
  const poolModule = await import("./document-conversion-pool"); const result = poolModule.initializeDocumentConversionPool().catch(error => error);
  ready(mocks.workers[0]); await vi.advanceTimersByTimeAsync(15000);
  expect(await result).toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" }); expect(poolModule.documentConversionHealth().ok).toBe(false);
  expect(mocks.workers.every(worker => worker.terminate.mock.calls.length > 0)).toBe(true);
});
it("stops restart storms and reports unhealthy after three replacements in one minute", async () => {
  const poolModule = await started();
  for (let index = 0; index < 4; index++) {
    const worker = index ? mocks.workers.at(-1)! : mocks.workers[0]; worker.emit("exit", 1);
    await vi.advanceTimersByTimeAsync(1); if (index < 3) ready(mocks.workers.at(-1)!);
  }
  expect(mocks.workers).toHaveLength(5); expect(poolModule.documentConversionHealth().ok).toBe(false);
  await expect(poolModule.convertDocumentInWorker(input)).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" });
});
it("drains accepted results during shutdown and rejects waiting jobs without false success", async () => {
  const poolModule = await started();
  const active = [poolModule.convertDocumentInWorker(input), poolModule.convertDocumentInWorker(input)];
  const waiting = poolModule.convertDocumentInWorker(input).catch(error => error); await vi.advanceTimersByTimeAsync(1);
  const shutdown = poolModule.stopDocumentConversionPool(); expect(await waiting).toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" });
  mocks.workers.forEach(finish); await Promise.all(active); await vi.advanceTimersByTimeAsync(10); await shutdown;
  expect(mocks.workers.every(worker => worker.terminate.mock.calls.length === 1)).toBe(true);
});


it("bounds active execution and rejects only after real termination, ignores late success, then recovers", async () => {
  const poolModule = await started();
  let terminated!: (code: number) => void;
  mocks.workers[0].terminate.mockImplementationOnce(() => new Promise<number>(resolve => { terminated = resolve; }));
  let settled = false;
  const active = poolModule.convertDocumentInWorker(input).catch(error => { settled = true; return error; });
  await vi.advanceTimersByTimeAsync(1);
  const original = mocks.workers[0].postMessage.mock.calls[0][0];
  await vi.advanceTimersByTimeAsync(30000);
  expect(settled).toBe(false); expect(poolModule.documentConversionHealth().ok).toBe(false);
  mocks.workers[0].emit("message", { type: "result", id: original.id, bytes: new Uint8Array([1]), sha256: "a".repeat(64) });
  expect(settled).toBe(false);
  terminated(1); await vi.advanceTimersByTimeAsync(1);
  expect(await active).toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" });
  ready(mocks.workers[2]); expect(poolModule.documentConversionHealth().ok).toBe(true);
  const retry = poolModule.convertDocumentInWorker(input); await vi.advanceTimersByTimeAsync(1); finish(mocks.workers[2]); await retry;
});

it("cleans already-started workers and startup timers when another constructor throws", async () => {
  mocks.throwAt = 1;
  const poolModule = await import("./document-conversion-pool");
  await expect(poolModule.initializeDocumentConversionPool()).rejects.toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" });
  expect(mocks.workers).toHaveLength(1);
  expect(mocks.workers[0].terminate).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(poolModule.documentConversionHealth().ok).toBe(false);
});

it("never replaces or releases a slot when thread termination itself rejects", async () => {
  const poolModule = await started();
  const active = poolModule.convertDocumentInWorker(input).catch(error => error); await vi.advanceTimersByTimeAsync(1);
  mocks.workers[0].terminate.mockRejectedValueOnce(new Error("termination failed"));
  mocks.workers[0].emit("error", new Error("worker failure")); await vi.advanceTimersByTimeAsync(1);
  expect(await active).toMatchObject({ code: "DOCUMENT_CONVERSION_UNAVAILABLE" });
  expect(mocks.workers).toHaveLength(2);
  expect(poolModule.documentConversionHealth()).toMatchObject({ ok: false, busy: 1, error: "WORKER_TERMINATION_FAILED" });
  // Test teardown represents external process termination after unrecoverable failure.
  globalThis.__openPblDocumentConversionPool!.slots[0].job = undefined;
});
