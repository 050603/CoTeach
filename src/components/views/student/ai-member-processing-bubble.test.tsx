import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AiMemberProcessingBubble } from "./ai-member-processing-bubble";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("AI member processing bubble", () => {
  it("rotates while working and stops on completion", () => {
    vi.useFakeTimers();
    const { unmount } = render(<AiMemberProcessingBubble />);
    expect(screen.getByRole("status")).toHaveTextContent("思考中…");
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("status")).toHaveTextContent("工作中…");
    act(() => vi.advanceTimersByTime(3_000));
    expect(screen.getByRole("status")).toHaveTextContent("正在组织回答…");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps recovery and reduced-motion states still", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
    const { rerender } = render(<AiMemberProcessingBubble />);
    expect(screen.getByRole("status")).toHaveTextContent("正在处理回答…");
    rerender(<AiMemberProcessingBubble recovering />);
    act(() => vi.advanceTimersByTime(6_000));
    expect(screen.getByRole("status")).toHaveTextContent("正在恢复回答…");
    expect(vi.getTimerCount()).toBe(0);
  });
});
