// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
const database = vi.hoisted(() => ({}));
vi.mock("./client", () => ({ prisma: database }));
import { readStudentCourseCommon } from "./student-read-coalescing";
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe("in-flight public course reads", () => {
  it("shares identical ongoing queries across students, clones each result and reloads after settlement", async () => {
    const value = { date: new Date(), payload: { title: "one" }, size: BigInt(3) };
    const gate = deferred<typeof value>(); const query = vi.fn(() => gate.promise);
    const read = (studentId: string) => readStudentCourseCommon(database, studentId, "course", "roster", { ids: ["a", "b"] }, query);
    const first = read("a"), second = read("b");
    await Promise.resolve(); expect(query).toHaveBeenCalledOnce();
    gate.resolve(value);
    const [a, b] = await Promise.all([first, second]); expect(a).toEqual(b);
    a.payload.title = "changed"; expect(b.payload.title).toBe("one"); expect(value.payload.title).toBe("one");
    value.payload.title = "new committed value";
    expect((await read("a")).payload.title).toBe("new committed value");
    expect(query).toHaveBeenCalledTimes(2);
  });
  it("separates course, operation and exact query parameters", async () => {
    const gate = deferred<number>(); const query = vi.fn(() => gate.promise);
    const reads = [
      readStudentCourseCommon(database, "a", "course", "groups", { ids: ["a"] }, query),
      readStudentCourseCommon(database, "a", "course", "groups", { ids: ["b"] }, query),
      readStudentCourseCommon(database, "a", "other", "groups", { ids: ["a"] }, query),
      readStudentCourseCommon(database, "a", "course", "roster", { ids: ["a"] }, query),
    ];
    await Promise.resolve(); expect(query).toHaveBeenCalledTimes(4); gate.resolve(1); await Promise.all(reads);
  });
  it("never shares teacher or transaction reads", async () => {
    const gate = deferred<number>(); const query = vi.fn(() => gate.promise);
    const tx = {};
    const reads = [
      ...[0, 1].map(() => readStudentCourseCommon(database, undefined, "course", "instance", {}, query)),
      ...[0, 1].map(() => readStudentCourseCommon(tx, "a", "course", "instance", {}, query)),
    ];
    expect(query).toHaveBeenCalledTimes(4); gate.resolve(1); await Promise.all(reads);
  });
  it("shares a current failure but never caches it", async () => {
    const gate = deferred<number>(); const query = vi.fn(() => gate.promise);
    const first = readStudentCourseCommon(database, "a", "course", "groups", {}, query);
    const second = readStudentCourseCommon(database, "b", "course", "groups", {}, query);
    const settled = Promise.allSettled([first, second]);
    gate.reject(new Error("database failed"));
    expect((await settled).every(result => result.status === "rejected")).toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(await readStudentCourseCommon(database, "a", "course", "groups", {}, async () => 42)).toBe(42);
  });
  it("expires a hung join and ignores an old query settling after its replacement starts", async () => {
    vi.useFakeTimers();
    try {
      const old = deferred<string>(), fresh = deferred<string>();
      const query = vi.fn().mockImplementationOnce(() => old.promise).mockImplementation(() => fresh.promise);
      const read = () => readStudentCourseCommon(database, "a", "course", "hung", {}, query);
      const first = read(); await Promise.resolve();
      await vi.advanceTimersByTimeAsync(2_001);
      const second = read(); await Promise.resolve();
      expect(query).toHaveBeenCalledTimes(2);
      old.resolve("old"); expect(await first).toBe("old");
      const third = read(); await Promise.resolve();
      expect(query).toHaveBeenCalledTimes(2);
      fresh.resolve("new"); expect(await Promise.all([second, third])).toEqual(["new", "new"]);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("bounds active keys and falls back to independent reads without rejecting requests", async () => {
    const gate = deferred<number>(); const query = vi.fn(() => gate.promise);
    const reads = Array.from({ length: 512 }, (_, i) => readStudentCourseCommon(database, "a", "course", "groups", { i }, query));
    const fallback = vi.fn(async () => 7);
    expect(await readStudentCourseCommon(database, "a", "course", "groups", { i: 513 }, fallback)).toBe(7);
    expect(await readStudentCourseCommon(database, "a", "course", "groups", { i: 513 }, fallback)).toBe(7);
    expect(fallback).toHaveBeenCalledTimes(2);
    gate.resolve(1); await Promise.all(reads);
  });
});
