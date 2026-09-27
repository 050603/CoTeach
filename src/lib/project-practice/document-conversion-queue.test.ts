// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules(); delete globalThis.__openPblDocumentConversionQueue;
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "performance"] });
});
afterEach(() => {
  expect(globalThis.__openPblDocumentConversionQueue?.waiting.length ?? 0).toBe(0);
  expect(globalThis.__openPblDocumentConversionQueue?.active ?? false).toBe(false);
  vi.useRealTimers(); delete globalThis.__openPblDocumentConversionQueue;
});
const load = () => import("./document-conversion-queue");
it("serializes 40 conversions FIFO and yields to another immediate before the next job", async () => {
  vi.useRealTimers();
  const { runDocumentConversion } = await load();
  const order: Array<number | string> = []; let active = 0, peak = 0;
  const tasks = Array.from({ length: 40 }, (_, index) => runDocumentConversion(async () => {
    peak = Math.max(peak, ++active); order.push(index);
    setImmediate(() => order.push(`io-${index}`));
    await Promise.resolve(); active--; return index;
  }));
  const results = await Promise.all(tasks);
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(results).toEqual(Array.from({ length: 40 }, (_, index) => index));
  expect(peak).toBe(1);
  expect(order).toEqual(Array.from({ length: 40 }, (_, index) => [index, `io-${index}`]).flat());
});
it("rejects overflow beyond 64 waiting jobs and accepts work after draining", async () => {
  const { runDocumentConversion } = await load(); let release!: () => void;
  const first = runDocumentConversion(() => new Promise<void>(resolve => { release = resolve; }));
  await vi.advanceTimersByTimeAsync(1);
  const tasks = Array.from({ length: 65 }, () => runDocumentConversion(async () => "saved").catch(error => error));
  expect(await tasks.at(-1)).toMatchObject({ code: "DOCUMENT_CONVERSION_BUSY" });
  expect(globalThis.__openPblDocumentConversionQueue?.waiting).toHaveLength(64);
  release(); await vi.runAllTimersAsync(); await first;
  expect((await Promise.all(tasks)).filter(value => value === "saved")).toHaveLength(64);
  const later = runDocumentConversion(async () => "later"); await vi.runAllTimersAsync(); expect(await later).toBe("later");
});
it("expired waiting work never executes and active conversion is not falsely cancelled", async () => {
  const { runDocumentConversion } = await load(); let release!: () => void;
  const first = runDocumentConversion(() => new Promise<string>(resolve => { release = () => resolve("active result"); }));
  await vi.advanceTimersByTimeAsync(1);
  const operation = vi.fn(async () => "must not execute");
  const waiting = runDocumentConversion(operation).catch(error => error);
  await vi.advanceTimersByTimeAsync(20000);
  expect(await waiting).toMatchObject({ code: "DOCUMENT_CONVERSION_BUSY" });
  expect(operation).not.toHaveBeenCalled(); expect(globalThis.__openPblDocumentConversionQueue?.active).toBe(true);
  release(); await vi.runAllTimersAsync(); expect(await first).toBe("active result");
});
it("a failed conversion releases the slot and preserves the original error", async () => {
  const { runDocumentConversion } = await load(); const failure = new Error("bad DOCX");
  const first = runDocumentConversion(async () => { throw failure; }).catch(error => error);
  const next = runDocumentConversion(async () => "next");
  await vi.runAllTimersAsync(); expect(await first).toBe(failure); expect(await next).toBe("next");
});
it("independently imported modules share the queue and recognize cross-module busy errors", async () => {
  const one = await load(); vi.resetModules(); const two = await load();
  let release!: () => void; const order: string[] = [];
  const first = one.runDocumentConversion(() => { order.push("first"); return new Promise<void>(resolve => { release = resolve; }); });
  await vi.advanceTimersByTimeAsync(1);
  const second = two.runDocumentConversion(async () => { order.push("second"); });
  await vi.advanceTimersByTimeAsync(1); expect(order).toEqual(["first"]);
  expect(two.isDocumentConversionBusy(new one.DocumentConversionBusyError())).toBe(true);
  release(); await vi.runAllTimersAsync(); await Promise.all([first, second]); expect(order).toEqual(["first", "second"]);
});
