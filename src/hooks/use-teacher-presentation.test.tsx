import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTeacherPresentation } from "./use-teacher-presentation";

let fullscreenElement: Element | null;
let requestFullscreen: ReturnType<typeof vi.fn>;
let exitFullscreen: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fullscreenElement = null;
  requestFullscreen = vi.fn(async () => { fullscreenElement = document.documentElement; document.dispatchEvent(new Event("fullscreenchange")); });
  exitFullscreen = vi.fn(async () => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
  Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreenElement });
  Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: requestFullscreen });
  Object.defineProperty(document, "exitFullscreen", { configurable: true, value: exitFullscreen });
});

afterEach(() => {
  delete (document as unknown as Record<string, unknown>).fullscreenElement;
  delete (document as unknown as Record<string, unknown>).exitFullscreen;
  delete (document.documentElement as unknown as Record<string, unknown>).requestFullscreen;
  document.body.style.overflow = "";
});

describe("teacher presentation fullscreen lifecycle", () => {
  it("requests document fullscreen so body portals remain visible and restores scrolling on exit", async () => {
    document.body.style.overflow = "auto";
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    expect(requestFullscreen).toHaveBeenCalledOnce();
    expect(fullscreenElement).toBe(document.documentElement);
    expect(result.current.active).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    await act(() => result.current.exit());
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(result.current.active).toBe(false);
    expect(document.body.style.overflow).toBe("auto");
  });

  it("keeps presentation usable when fullscreen is rejected and Escape exits the fallback", async () => {
    requestFullscreen.mockRejectedValue(new Error("Denied"));
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(result.current.active).toBe(false);
    expect(exitFullscreen).not.toHaveBeenCalled();
  });

  it("supports browsers without the Fullscreen API", async () => {
    Object.defineProperty(document.documentElement, "requestFullscreen", { configurable: true, value: undefined });
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    expect(result.current.active).toBe(true);
    await act(() => result.current.exit());
    expect(result.current.active).toBe(false);
  });

  it("follows native Escape and does not treat nested video fullscreen as leaving presentation", async () => {
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    act(() => { fullscreenElement = document.createElement("video"); document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current.active).toBe(true);
    act(() => { fullscreenElement = null; document.dispatchEvent(new Event("fullscreenchange")); });
    expect(result.current.active).toBe(false);
  });

  it("exits a late fullscreen request when the user already left presentation", async () => {
    let resolveRequest!: () => void;
    requestFullscreen.mockImplementation(() => new Promise<void>((resolve) => { resolveRequest = () => { fullscreenElement = document.documentElement; resolve(); }; }));
    const { result } = renderHook(useTeacherPresentation);
    let pending!: Promise<void>;
    act(() => { pending = result.current.enter(); });
    await act(() => result.current.exit());
    await act(async () => { resolveRequest(); await pending; });
    expect(result.current.active).toBe(false);
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(fullscreenElement).toBeNull();
  });

  it("cleans up native fullscreen when the classroom unmounts", async () => {
    const { result, unmount } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    unmount();
    expect(exitFullscreen).toHaveBeenCalledOnce();
    expect(document.body.style.overflow).toBe("");
  });

  it("keeps the exit control when the browser refuses to exit", async () => {
    const { result } = renderHook(useTeacherPresentation);
    await act(() => result.current.enter());
    exitFullscreen.mockRejectedValueOnce(new Error("Denied"));
    await act(() => result.current.exit());
    expect(result.current.active).toBe(true);
    await act(() => result.current.exit());
    expect(result.current.active).toBe(false);
  });
});
