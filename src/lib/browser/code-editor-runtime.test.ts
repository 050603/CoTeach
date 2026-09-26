import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ init: vi.fn(), config: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({ loader: mocks }));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  mocks.init.mockReset().mockResolvedValue({});
  vi.stubGlobal("_VSCODE_NLS_LANGUAGE", undefined);
});
afterEach(() => {
  document.querySelectorAll('script[data-openpbl-monaco-locale]').forEach((script) => script.remove());
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("code editor runtime loading", () => {
  it("shares locale loading and waits for the editor itself to initialize", async () => {
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const runtime = loadCodeEditorRuntime();
    expect(loadCodeEditorRuntime()).toBe(runtime);
    expect(mocks.init).not.toHaveBeenCalled();
    const script = document.querySelector('script[data-openpbl-monaco-locale]')!;
    expect(script.getAttribute("src")).toBe("/api/openmaic/interactive-runtime/monaco/nls/lang/zh-cn.js");
    script.dispatchEvent(new Event("load"));
    await expect(runtime).resolves.toBeUndefined();
    expect(mocks.init).toHaveBeenCalledOnce();
  });

  it("removes a failed locale script so another visit can retry", async () => {
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const runtime = loadCodeEditorRuntime();
    const result = expect(runtime).rejects.toThrow("EDITOR_LOCALE_LOAD_FAILED");
    document.querySelector('script[data-openpbl-monaco-locale]')!.dispatchEvent(new Event("error"));
    await result;
    expect(document.querySelector('script[data-openpbl-monaco-locale]')).toBeNull();
    const retry = loadCodeEditorRuntime();
    document.querySelector('script[data-openpbl-monaco-locale]')!.dispatchEvent(new Event("load"));
    await expect(retry).resolves.toBeUndefined();
  });

  it("reports editor bundle failures after localization has loaded", async () => {
    vi.stubGlobal("_VSCODE_NLS_LANGUAGE", "zh-cn");
    mocks.init.mockRejectedValue(new Error("Network error"));
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    await expect(loadCodeEditorRuntime()).rejects.toThrow("EDITOR_LOAD_FAILED");
  });

  it.each([false, true])("times out stalled requests (locale already loaded: %s)", async (localized) => {
    if (localized) vi.stubGlobal("_VSCODE_NLS_LANGUAGE", "zh-cn");
    mocks.init.mockReturnValue(new Promise(() => undefined));
    const { loadCodeEditorRuntime } = await import("./code-editor-runtime");
    const result = expect(loadCodeEditorRuntime()).rejects.toThrow("EDITOR_LOAD_TIMEOUT");
    await vi.advanceTimersByTimeAsync(20_000);
    await result;
  });
});
