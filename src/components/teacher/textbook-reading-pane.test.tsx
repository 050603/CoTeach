import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TextbookDetailPayload } from "@/app/teacher/textbooks/textbook-view-types";
import type { BrowseState } from "@/lib/textbook/browse-model";
import { TextbookReadingPane } from "./textbook-reading-pane";

const payload: TextbookDetailPayload = { textbook: { id: "book", title: "教材" }, sections: [{ id: "chapter", title: "第一章" }, { id: "second", title: "第二章" }], sourceBlocks: [{ id: "first", sectionId: "chapter", position: 1, content: "段落一" }, { id: "target", sectionId: "chapter", position: 2, content: "段落二" }, { id: "last", sectionId: "chapter", position: 3, content: "段落三" }] };
const state: BrowseState = { view: "read", sectionId: "chapter", conceptId: null, blockId: null };
let mobile = false;
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
const mediaListeners = new Set<() => void>();
const observations: { callback: IntersectionObserverCallback; options: IntersectionObserverInit; disconnect: ReturnType<typeof vi.fn> }[] = [];
const scrollIntoView = vi.fn();
const scrollTo = vi.fn();
function flushFrames() { act(() => { for (let count = 0; count < 3; count++) { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(0)); } }); }
function emit(items: [string, boolean][]) { act(() => observations.at(-1)!.callback(items.map(([id, isIntersecting]) => ({ target: document.getElementById(`source-${id}`)!, isIntersecting, boundingClientRect: new DOMRect(), intersectionRatio: isIntersecting ? 1 : 0, intersectionRect: new DOMRect(), rootBounds: null, time: 0 })), {} as IntersectionObserver)); }
function tick() { act(() => vi.advanceTimersByTime(400)); }
function setup(blockId: string | null = null) { const onVisibleBlock = vi.fn(); const props = { payload, state: { ...state, blockId }, navigate: vi.fn(), onVisibleBlock }; return { ...render(<TextbookReadingPane {...props} />), props, onVisibleBlock }; }

describe("textbook responsive reading position", () => {
  beforeEach(() => {
    vi.useFakeTimers(); mobile = false; frames.clear(); observations.length = 0; mediaListeners.clear(); scrollIntoView.mockClear(); scrollTo.mockClear();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.stubGlobal("matchMedia", () => ({ get matches() { return mobile; }, addEventListener: (_: string, fn: () => void) => mediaListeners.add(fn), removeEventListener: (_: string, fn: () => void) => mediaListeners.delete(fn) }));
    vi.stubGlobal("IntersectionObserver", class { constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { observations.push({ callback, options, disconnect: this.disconnect }); } observe() {} disconnect = vi.fn(); });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
    Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: scrollTo });
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView; delete (HTMLElement.prototype as Partial<HTMLElement>).scrollTo; });

  it("uses the desktop scroll container and scrolls new chapters to their top", () => {
    const { rerender, props } = setup(); flushFrames();
    const host = screen.getByLabelText("教材阅读区");
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    expect(scrollTo.mock.contexts[0]).toBe(host);
    expect(observations.at(-1)!.options.root).toBe(host);
    rerender(<TextbookReadingPane {...props} state={{ ...state, sectionId: "second" }} />); flushFrames();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("uses the viewport on mobile and brings each new chapter into view", () => {
    mobile = true;
    const { rerender, props } = setup(); flushFrames();
    expect(observations.at(-1)!.options.root).toBeNull();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
    expect(scrollIntoView.mock.contexts[0]).toBe(screen.getByLabelText("教材阅读区"));
    rerender(<TextbookReadingPane {...props} state={{ ...state, sectionId: "second" }} />); flushFrames();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it.each([false, true])("centers evidence and protects restored position before observer settlement (mobile=%s)", (isMobile) => {
    mobile = isMobile;
    const { onVisibleBlock } = setup("target"); flushFrames();
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center", behavior: "instant" });
    expect(scrollIntoView.mock.contexts[0]).toBe(document.getElementById("source-target"));
    emit([["first", true]]); tick();
    expect(onVisibleBlock).not.toHaveBeenCalled();
    emit([["target", true]]); tick();
    expect(onVisibleBlock).toHaveBeenLastCalledWith("target");
    emit([["first", false], ["target", false], ["last", true]]); tick();
    expect(onVisibleBlock).toHaveBeenLastCalledWith("last");
  });

  it("retains other intersecting blocks when a callback only reports a leaving block", () => {
    const { onVisibleBlock } = setup(); flushFrames();
    emit([["first", true], ["target", true]]); tick();
    expect(onVisibleBlock).toHaveBeenLastCalledWith("first");
    emit([["first", false]]); tick();
    expect(onVisibleBlock).toHaveBeenLastCalledWith("target");
  });

  it("limits knowledge chips, retains a selected concept, and collapses on chapter changes", () => {
    const concepts = Array.from({ length: 25 }, (_, index) => ({ id: `concept-${index}`, name: `知识点${index}`, sectionId: "chapter" }));
    const richPayload = { ...payload, concepts };
    const props = { payload: richPayload, state: { ...state, conceptId: "concept-20" }, navigate: vi.fn(), onVisibleBlock: vi.fn() };
    const { rerender } = render(<TextbookReadingPane {...props} />);
    const strip = () => within(screen.getByLabelText("本节知识点"));
    expect(strip().getAllByRole("button", { pressed: false })).toHaveLength(8);
    expect(strip().getByRole("button", { pressed: true })).toHaveTextContent("知识点20");
    const expand = strip().getByRole("button", { name: "展开全部 25 个知识点" });
    expect(expand).toHaveStyle({ minHeight: "44px" });
    fireEvent.click(expand);
    expect(strip().getAllByRole("button", { pressed: false })).toHaveLength(24);
    fireEvent.click(strip().getByRole("button", { name: "收起知识点" }));
    expect(strip().getAllByRole("button", { pressed: false })).toHaveLength(8);
    fireEvent.click(strip().getByRole("button", { name: "展开全部 25 个知识点" }));
    rerender(<TextbookReadingPane {...props} state={{ ...state, sectionId: "second" }} />);
    rerender(<TextbookReadingPane {...props} />);
    expect(strip().getByRole("button", { name: "展开全部 25 个知识点" })).toHaveAttribute("aria-expanded", "false");
  });

  it("rebuilds observation at the responsive breakpoint and removes pending work on unmount", () => {
    const { onVisibleBlock, unmount } = setup(); flushFrames();
    const desktop = observations[0];
    act(() => { mobile = true; mediaListeners.forEach(fn => fn()); }); flushFrames();
    expect(desktop.disconnect).toHaveBeenCalled();
    expect(observations.at(-1)!.options.root).toBeNull();
    emit([["target", true]]);
    unmount(); tick();
    expect(onVisibleBlock).not.toHaveBeenCalled();
    expect(mediaListeners.size).toBe(0);
  });
});
