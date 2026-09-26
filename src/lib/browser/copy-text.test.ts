import { afterEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./copy-text";

describe("copyTextToClipboard", () => {
  afterEach(() => vi.restoreAllMocks());

  it("uses the selection fallback when Clipboard API rejects on plain HTTP", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("NotAllowedError")) },
    });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });

    await copyTextToClipboard("A2K9QP");

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("copies on campus HTTP URLs without navigator.clipboard", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    await copyTextToClipboard("学生代码与教师讲稿");
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("reports rejected copy operations instead of showing a false success", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockReturnValue(false) });
    await expect(copyTextToClipboard("copy denied")).rejects.toThrow("COPY_REJECTED");
    expect(document.querySelector("textarea")).toBeNull();
  });
});
