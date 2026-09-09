import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TeacherProfilePanel } from "./teacher-profile-panel";

describe("TeacherProfilePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("submits a changed display name and keeps the saved value", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (input === "/api/auth/me") {
        return Response.json({
          user: { role: "teacher", username: "teacher.li", displayName: "李老师" },
        });
      }
      if (input === "/api/platform/auth/teacher-profile" && init?.method === "PATCH") {
        return Response.json({
          user: { role: "teacher", username: "teacher.li", displayName: "李明老师" },
        });
      }
      throw new Error(`Unexpected request: ${String(input)}`);
    });

    render(<TeacherProfilePanel />);

    const nameInput = await screen.findByLabelText("显示姓名");
    fireEvent.change(nameInput, { target: { value: " 李明老师 " } });
    fireEvent.click(screen.getByRole("button", { name: "保存个人信息" }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/platform/auth/teacher-profile",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ displayName: "李明老师" }),
        }),
      );
    });
    expect(await screen.findByText("个人信息已更新")).toBeInTheDocument();
    expect(nameInput).toHaveValue("李明老师");
  });

  it("uses submit buttons for both account forms", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({
      user: { role: "teacher", username: "teacher.li", displayName: "李老师" },
    }));

    render(<TeacherProfilePanel />);

    expect(await screen.findByRole("button", { name: "保存个人信息" })).toHaveAttribute("type", "submit");
    expect(screen.getByRole("button", { name: "更新登录密码" })).toHaveAttribute("type", "submit");
  });
});
