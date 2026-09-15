import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudentRegisterPage from "./page";
const navigation = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => new URLSearchParams(),
}));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe("student registration", () => {
  it("keeps the native input value unchanged while presenting a normalized invite code", () => {
    render(<StudentRegisterPage />);

    const inviteInput = screen.getByLabelText("课程邀请码");
    inviteInput.focus();
    fireEvent.change(inviteInput, { target: { value: "a" } });

    expect(inviteInput).toHaveValue("a");
    expect(inviteInput).toHaveAttribute("autocapitalize", "none");
    expect(inviteInput).toHaveAttribute("autocomplete", "off");
    expect(inviteInput).toHaveAttribute("autocorrect", "off");
    expect(document.activeElement).toBe(inviteInput);
    expect(
      Array.from(document.querySelectorAll(".pbl-student-code-cell"), (cell) => cell.textContent),
    ).toEqual(["A", "", "", "", "", ""]);
  });

  it("does not rewrite iOS composition text", () => {
    render(<StudentRegisterPage />);

    const inviteInput = screen.getByLabelText("课程邀请码");
    inviteInput.focus();
    fireEvent.compositionStart(inviteInput);
    fireEvent.change(inviteInput, { target: { value: "ab" } });
    expect(inviteInput).toHaveValue("ab");

    fireEvent.compositionEnd(inviteInput, { data: "ab" });
    expect(inviteInput).toHaveValue("ab");
    expect(
      Array.from(document.querySelectorAll(".pbl-student-code-cell"), (cell) => cell.textContent),
    ).toEqual(["A", "B", "", "", "", ""]);
    expect(document.activeElement).toBe(inviteInput);
  });

  it("collects a student ID and requires matching password confirmation", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ offeringId: "course" }),
      });
    vi.stubGlobal("fetch", fetcher);

    render(<StudentRegisterPage />);
    expect(screen.queryByLabelText("学号")).toBeNull();

    fireEvent.change(screen.getByLabelText("课程邀请码"), { target: { value: "ABC123" } });
    fireEvent.click(screen.getByRole("button", { name: "下一步：填写信息" }));
    await screen.findByText("城市生态");
    expect(screen.getByLabelText("学号")).toHaveAttribute("placeholder", "输入你的学号");
    expect(screen.getByLabelText("密码", { exact: true })).toHaveAttribute("placeholder", "密码至少 10 位");
    expect(screen.getByLabelText("确认密码")).toBeRequired();
    fireEvent.change(screen.getByLabelText("学号"), { target: { value: "20260001" } });
    fireEvent.change(screen.getByLabelText("姓名"), { target: { value: "王同学" } });
    fireEvent.change(screen.getByLabelText("密码", { exact: true }), { target: { value: "student-pass" } });
    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "different-pass" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建账号并加入课程" }).closest("form")!);

    expect(await screen.findByRole("alert")).toHaveTextContent("两次输入的密码不一致");
    expect(fetcher).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText("确认密码"), { target: { value: "student-pass" } });
    fireEvent.submit(screen.getByRole("button", { name: "创建账号并加入课程" }).closest("form")!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher).toHaveBeenLastCalledWith(
      "/api/platform/auth/register",
      expect.objectContaining({
        body: JSON.stringify({
          invitationCode: "ABC123",
          username: "20260001",
          displayName: "王同学",
          password: "student-pass",
          confirmPassword: "student-pass",
        }),
      }),
    );
  });

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
    fireEvent.click(screen.getByRole("button", { name: "下一步：填写信息" }));
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
    fireEvent.click(screen.getByRole("button", { name: "修改" }));
    fireEvent.change(screen.getByLabelText("课程邀请码"), {
      target: { value: "XYZ789" },
    });
    expect(screen.queryByText("城市生态")).toBeNull();
    expect(screen.queryByRole("button", { name: "创建账号并加入课程" })).toBeNull();
  });
});
