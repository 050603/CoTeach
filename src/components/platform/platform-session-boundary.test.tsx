import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const route = vi.hoisted(() => ({ pathname: "/student/courses/demo" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));
vi.mock("@/lib/session/store", () => ({ SessionProvider: ({ children }: { children: React.ReactNode }) => <div data-testid="classroom-session">{children}</div> }));
import { PlatformSessionBoundary } from "./platform-session-boundary";
describe("platform session boundary", () => {
  it("does not request retired classroom session APIs on course pages", () => {
    route.pathname = "/student/courses/demo";
    render(<PlatformSessionBoundary>课程主页</PlatformSessionBoundary>);
    expect(screen.queryByTestId("classroom-session")).not.toBeInTheDocument();
  });
  it("themes settings while retaining its identity session", () => {
    route.pathname = "/teacher/settings";
    const { container } = render(<PlatformSessionBoundary>设置</PlatformSessionBoundary>);
    expect(screen.getByTestId("classroom-session")).toBeInTheDocument();
    expect(container.querySelector(".pbl-platform-theme")).toBeInTheDocument();
  });
  it("keeps teaching and preparation outside the platform theme", () => {
    route.pathname = "/teacher/teach/demo/classroom";
    const { container } = render(<PlatformSessionBoundary>授课</PlatformSessionBoundary>);
    expect(container.querySelector(".pbl-platform-theme")).not.toBeInTheDocument();
  });
  it("preserves the session provider for classroom implementation", () => {
    route.pathname = "/teacher/prepare/demo/verify";
    render(<PlatformSessionBoundary>备课</PlatformSessionBoundary>);
    expect(screen.getByTestId("classroom-session")).toBeInTheDocument();
  });
});
