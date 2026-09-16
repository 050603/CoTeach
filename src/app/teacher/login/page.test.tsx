import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  search: new URLSearchParams("redirect=%2Fteacher%2Fclasses"),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => mocks.search,
}));
vi.mock("@/components/platform/teacher-auth-shell", () => ({
  TeacherAuthShell: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
}));

import { normalizeTeacherRedirect } from "./login-navigation";
import TeacherLoginPage from "./page";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  mocks.replace.mockReset();
  mocks.search = new URLSearchParams("redirect=%2Fteacher%2Fclasses");
  vi.stubGlobal("window", new Proxy(window, {
    get: (target, key) => key === "location"
      ? { ...target.location, replace: mocks.replace }
      : Reflect.get(target, key, target),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("teacher login", () => {
  it("submits values written by browser autofill and verifies the session before navigating", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/teacher-register")) return json({ available: true, mode: "authenticated" });
      if (url.endsWith("/teacher-login")) return json({ user: { role: "teacher" } });
      if (url.endsWith("/api/auth/me")) return json({ user: { role: "teacher" } });
      return json({}, 404);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<TeacherLoginPage />);

    const username = screen.getByPlaceholderText("教师账号") as HTMLInputElement;
    const password = screen.getByPlaceholderText("密码") as HTMLInputElement;
    username.value = " teacher.one ";
    password.value = "secret-value";
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
    fireEvent.submit(username.closest("form")!);

    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/teacher/classes"));
    expect(fetcher).toHaveBeenCalledWith("/api/platform/auth/teacher-login", expect.objectContaining({
      credentials: "same-origin",
      body: JSON.stringify({ username: "teacher.one", password: "secret-value" }),
    }));
    expect(fetcher).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({
      cache: "no-store",
      credentials: "same-origin",
    }));
  });

  it("explains when credentials are valid but the browser did not retain the session", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/teacher-register")) return json({ available: true, mode: "authenticated" });
      if (url.endsWith("/teacher-login")) return json({ user: { role: "teacher" } });
      if (url.endsWith("/api/auth/me")) return json({ user: null });
      return json({}, 404);
    }));
    render(<TeacherLoginPage />);

    fireEvent.change(screen.getByPlaceholderText("教师账号"), { target: { value: "teacher" } });
    fireEvent.change(screen.getByPlaceholderText("密码"), { target: { value: "secret-value" } });
    fireEvent.click(screen.getByRole("button", { name: "登录" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("允许本站使用 Cookie");
    expect(mocks.replace).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "登录" })).toBeEnabled();
  });

  it("keeps post-login navigation on a same-origin path", () => {
    expect(normalizeTeacherRedirect("/teacher/classes?tab=open")).toBe("/teacher/classes?tab=open");
    expect(normalizeTeacherRedirect("https://example.com/phishing")).toBe("/teacher");
    expect(normalizeTeacherRedirect("//example.com/phishing")).toBe("/teacher");
    expect(normalizeTeacherRedirect(null)).toBe("/teacher");
  });
});
