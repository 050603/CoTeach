import { act, renderHook } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeDraft } from "./use-code-draft";
import { documentDraftKey, readDocumentDrafts, writeDocumentDraft } from "@/lib/browser/document-draft";

const scope = "course:student:make:code:python";
describe("confirmed code saves", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());
  it("keeps a failed save durable and retries identical content without claiming success", async () => {
    const persist = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce({ id: "code", version: 2 });
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "server" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "server" } });
    rerender({ content: "edited" });
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(result.current.status).toBe("error");
    expect(readDocumentDrafts(scope)[0]).toMatchObject({ content: "edited", expectedVersion: 1 });
    await act(async () => { expect(await result.current.save()).toBe(true); });
    expect(result.current.status).toBe("saved");
    expect(persist.mock.calls).toEqual([["edited", "code", 1], ["edited", "code", 1]]);
    expect(readDocumentDrafts(scope)).toEqual([]);
  });
  it("does not borrow a newer revision from another tab's server refresh", async () => {
    const persist = vi.fn().mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ version, content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version, content: version === 1 ? "original" : "other tab" },
      enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { version: 1, content: "original" } });
    rerender({ version: 2, content: "my edit" });
    await act(async () => { await result.current.save(); });
    expect(persist).toHaveBeenCalledWith("my edit", "code", 1);
    expect(result.current.status).toBe("error");
  });
  it("serializes edits and preserves the new content when an old acknowledgement arrives", async () => {
    let complete!: (value: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }))
      .mockResolvedValueOnce({ id: "code", version: 3 });
    const { result, rerender } = renderHook(({ content }) => useCodeDraft({ scope, content,
      initial: { id: "code", version: 1, content: "original" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { content: "original" } });
    rerender({ content: "first" });
    let first!: Promise<boolean>;
    await act(async () => { first = result.current.save(); await Promise.resolve(); });
    expect(result.current.status).toBe("saving");
    rerender({ content: "second" });
    let second!: Promise<boolean>;
    await act(async () => { second = result.current.save(); await Promise.resolve(); });
    expect(persist).toHaveBeenCalledTimes(1);
    await act(async () => { complete({ id: "code", version: 2 }); await first; await second; });
    expect(persist.mock.calls).toEqual([["first", "code", 1], ["second", "code", 2]]);
    expect(result.current.status).toBe("saved");
  });
  it("restores unsent drafts but retains conflicting drafts for explicit review", () => {
    const restore = vi.fn();
    writeDocumentDraft({ key: documentDraftKey(scope), scope, content: "unsent", expectedVersion: 2, updatedAt: 2 });
    writeDocumentDraft({ key: documentDraftKey(scope), scope, content: "old tab", expectedVersion: 1, updatedAt: 1 });
    const { result } = renderHook(() => useCodeDraft({ scope, content: "server", initial: { id: "code", version: 2, content: "server" },
      enabled: true, restore, persist: vi.fn() }));
    expect(restore).toHaveBeenCalledWith("unsent");
    expect(result.current.error).toContain("冲突");
    expect(readDocumentDrafts(scope)).toHaveLength(2);
  });
  it("ignores a previous scope's delayed save acknowledgement", async () => {
    let complete!: (value: { id: string; version: number }) => void;
    const persist = vi.fn().mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const { result, rerender } = renderHook(({ currentScope, content }) => useCodeDraft({ scope: currentScope, content,
      initial: { id: currentScope, version: 1, content: "server" }, enabled: true, restore: vi.fn(), persist,
    }), { initialProps: { currentScope: scope, content: "server" } });
    rerender({ currentScope: scope, content: "my code" });
    let saving!: Promise<boolean>;
    await act(async () => { saving = result.current.save(); await Promise.resolve(); });
    rerender({ currentScope: "another-classroom", content: "server" });
    await act(async () => { complete({ id: scope, version: 2 }); expect(await saving).toBe(false); });
    expect(result.current.status).toBe("saved");
    expect(readDocumentDrafts(scope)[0].content).toBe("my code");
  });
  it("keeps the recovered editor content through initialization and autosave", async () => {
    writeDocumentDraft({ key: documentDraftKey(scope), scope, submissionId: "code", content: "recovered", expectedVersion: 2, updatedAt: 2 });
    const persist = vi.fn().mockResolvedValue({ id: "code", version: 3 });
    const { result } = renderHook(() => {
      const [content, setContent] = useState("server");
      const draft = useCodeDraft({ scope, content, initial: { id: "code", version: 2, content: "server" }, enabled: true, restore: setContent, persist });
      return { content, draft };
    });
    expect(result.current.content).toBe("recovered");
    await act(async () => { await vi.advanceTimersByTimeAsync(900); });
    expect(result.current.content).toBe("recovered");
    expect(persist).toHaveBeenCalledWith("recovered", "code", 2);
    expect(result.current.draft.status).toBe("saved");
  });
});
