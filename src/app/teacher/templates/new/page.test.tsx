import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import NewTeacherTemplatePage from "./page";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), usePathname: () => "/teacher/templates/new" }));

const generated = {
  schemaVersion: 1,
  title: "雨水收集",
  subject: "科学",
  grade: "七年级",
  durationMinutes: 45,
  summary: "设计校园雨水收集装置。",
  learningObjectives: ["计算集水面积"],
  outline: [{ title: "调查与设计", durationMinutes: 45, description: "测量集水区并提出方案。" }],
  resources: [],
};

describe("teacher course creation flow", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.endsWith("/generate") ? { content: generated } : { template: { id: "template-1" } },
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  it("generates, reviews, and publishes through the three preparation steps", async () => {
    render(<NewTeacherTemplatePage />);
    fireEvent.change(screen.getByLabelText("课程名称"), { target: { value: "雨水收集" } });
    fireEvent.change(screen.getByLabelText("教学要求"), { target: { value: "设计雨水收集装置" } });
    fireEvent.click(screen.getByRole("button", { name: /生成课程方案/ }));

    await screen.findByRole("heading", { name: "完善课程内容" });
    expect((screen.getByLabelText("课程简介") as HTMLTextAreaElement).value).toBe(generated.summary);
    expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/generate", expect.objectContaining({ method: "POST" }));

    fireEvent.click(screen.getByRole("button", { name: "预览课程" }));
    await screen.findByText("发布确认", { exact: false });
    fireEvent.click(screen.getByRole("button", { name: "发布到课程库" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates", expect.objectContaining({
      method: "POST",
      body: expect.stringContaining('"snapshot"'),
    })));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/teacher/templates?created=1"));
  });
});
