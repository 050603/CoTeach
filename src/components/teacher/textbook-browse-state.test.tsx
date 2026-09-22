import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextbookDetailPayload } from "@/app/teacher/textbooks/textbook-view-types";
import { browseStorageKey, type BrowseState } from "@/lib/textbook/browse-model";
import { useTextbookBrowseState } from "./textbook-browse-state";

const payload: TextbookDetailPayload = {
  textbook: { id: "book", title: "教材" }, revision: { id: "revision-1" },
  sections: [{ id: "section", title: "第一章" }, { id: "second", title: "第二章" }],
  concepts: [{ id: "concept", sectionId: "section", name: "知识点" }],
  sourceBlocks: [{ id: "block", sectionId: "section", content: "原文" }],
};
const initial: BrowseState = { view: "read", sectionId: "all", conceptId: null, blockId: null };
const saved: BrowseState = { view: "graph", sectionId: "section", conceptId: "concept", blockId: null };
const fetchMock = vi.fn();
function save(user: string, revision: string, state = saved) { localStorage.setItem(browseStorageKey(user, "book", revision), JSON.stringify(state)); }
async function ready() { await waitFor(() => expect(window.location.search).toContain("view=")); }

describe("textbook browse history and saved position", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "/teacher/textbooks/book");
    fetchMock.mockReset().mockResolvedValue(Response.json({ user: { sub: "teacher-a", role: "teacher", username: "teacher", displayName: "老师" }, configured: true }));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("restores only the authenticated user's matching textbook revision", async () => {
    save("teacher-b", "revision-1", { ...initial, sectionId: "second" });
    save("teacher-a", "revision-2", { ...initial, sectionId: "second" });
    save("teacher-a", "revision-1");
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(result.current.state).toEqual(saved);
    act(() => result.current.navigate({ view: "read", sectionId: "second", conceptId: null }));
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-1"))!)).toEqual({ ...initial, sectionId: "second" });
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-b", "book", "revision-1"))!)).toEqual({ ...initial, sectionId: "second" });
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-2"))!)).toEqual({ ...initial, sectionId: "second" });
  });

  it("prefers the canonical JWT subject while supporting legacy id responses", async () => {
    save("teacher-a", "revision-1");
    fetchMock.mockResolvedValue(Response.json({ user: { sub: "teacher-a", id: "legacy-other", role: "teacher" }, configured: true }));
    const canonical = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(canonical.result.current.state).toEqual(saved);
    canonical.unmount();
    window.history.replaceState(null, "", "/teacher/textbooks/book");
    fetchMock.mockResolvedValue(Response.json({ user: { id: "teacher-a" } }));
    const legacy = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(legacy.result.current.state).toEqual(saved);
  });

  it("resets old URL ids when a new revision replaces the displayed textbook", async () => {
    const { result, rerender } = renderHook(({ current }) => useTextbookBrowseState(current), { initialProps: { current: payload } });
    await ready();
    act(() => result.current.navigate(saved));
    expect(window.location.search).toContain("concept=concept");
    const nextRevision: TextbookDetailPayload = { ...payload, revision: { id: "revision-2" }, sections: [{ id: "new-section", title: "新版章节" }], concepts: [], sourceBlocks: [] };
    rerender({ current: nextRevision });
    expect(result.current.state).toEqual(initial);
    expect(window.location.search).toBe("?view=read&section=all");
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-1"))!)).toEqual(saved);
    act(() => result.current.navigate({ sectionId: "new-section" }));
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-2"))!).sectionId).toBe("new-section");
  });

  it("does not restore another user or an older revision", async () => {
    save("teacher-b", "revision-1");
    save("teacher-a", "revision-0");
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(result.current.state).toEqual(initial);
  });

  it("gives an explicit URL priority over a saved position and locates evidence", async () => {
    save("teacher-a", "revision-1");
    window.history.replaceState(null, "", "/teacher/textbooks/book?view=graph&block=block");
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await waitFor(() => expect(result.current.state.blockId).toBe("block"));
    expect(result.current.state).toEqual({ ...initial, sectionId: "section", blockId: "block" });
    expect(window.location.search).toContain("view=read");
  });

  it("synchronizes popstate in both history directions without adding history entries", async () => {
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    act(() => result.current.navigate(saved));
    const graphUrl = window.location.href;
    act(() => result.current.navigate({ view: "read", sectionId: "second", conceptId: null }));
    const readerUrl = window.location.href;
    const push = vi.spyOn(window.history, "pushState");
    act(() => { window.history.replaceState(null, "", graphUrl); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.state).toEqual(saved);
    act(() => { window.history.replaceState(null, "", readerUrl); window.dispatchEvent(new PopStateEvent("popstate")); });
    expect(result.current.state).toEqual({ ...initial, sectionId: "second" });
    expect(push).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-1"))!)).toEqual(result.current.state);
    push.mockRestore();
  });

  it("safely resets invalid URL and saved references", async () => {
    window.history.replaceState(null, "", "/teacher/textbooks/book?view=graph&concept=deleted");
    const first = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(first.result.current.state).toEqual(initial);
    first.unmount();
    window.history.replaceState(null, "", "/teacher/textbooks/book");
    save("teacher-a", "revision-1", { ...saved, sectionId: "old-section" });
    const second = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(second.result.current.state).toEqual(initial);
  });

  it.each([401, 500])("does not share storage when authentication returns %s even with a user-shaped body", async (status) => {
    save("teacher-a", "revision-1");
    fetchMock.mockResolvedValue(Response.json({ user: { sub: "teacher-a", role: "teacher", username: "teacher", displayName: "老师" }, configured: true }, { status }));
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    expect(result.current.state).toEqual(initial);
    act(() => result.current.navigate({ sectionId: "second" }));
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-1"))!)).toEqual(saved);
    expect(localStorage.length).toBe(1);
  });

  it("keeps URL navigation usable after authentication network failure without saving anonymous data", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    act(() => result.current.navigate(saved));
    expect(result.current.state).toEqual(saved);
    expect(localStorage.length).toBe(0);
  });

  it("saves a reading block under the current user and revision without creating history entries", async () => {
    const { result } = renderHook(() => useTextbookBrowseState(payload));
    await ready();
    const url = window.location.href;
    act(() => result.current.rememberBlock("block"));
    expect(window.location.href).toBe(url);
    expect(JSON.parse(localStorage.getItem(browseStorageKey("teacher-a", "book", "revision-1"))!)).toEqual({ ...initial, blockId: "block" });
  });
});
