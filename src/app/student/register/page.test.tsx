import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudentRegisterPage from "./page";
const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => vi.unstubAllGlobals());
describe("student registration", () => {
  it("requires revalidation when a verified invitation is changed", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            invitation: {
              code: "ABC123",
              offering: {
                id: "course",
                name: "城市生态",
                teacher: { displayName: "李老师" },
              },
            },
          }),
        }),
    );
    render(<StudentRegisterPage />);
    fireEvent.change(screen.getByLabelText("课程邀请码"), {
      target: { value: "ABC123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "验证邀请码" }));
    await screen.findByText("城市生态");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "创建账号并加入课程",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText("课程邀请码"), {
      target: { value: "XYZ789" },
    });
    expect(screen.queryByText("城市生态")).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "创建账号并加入课程",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
