import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/teacher/prepare/course-1/verify" }));

const sessionMocks = vi.hoisted(() => ({
  courses: [] as Array<Record<string, unknown>>,
  studentId: "student-1",
}));

vi.mock("@/lib/session/store", () => ({
  useSession: () => ({
    activityLog: [],
    courses: sessionMocks.courses,
    lastSavedAt: null,
    retrySave: vi.fn(),
    saveState: "saved",
    setUser: vi.fn(),
    studentId: sessionMocks.studentId,
    studentName: "学生",
    user: { name: "学生" },
  }),
}));

import { DashboardShell } from "./dashboard-shell";

describe("DashboardShell immersive mode", () => {
  beforeEach(() => {
    sessionMocks.courses = [];
    sessionMocks.studentId = "student-1";
    localStorage.clear();
  });
  it("removes permanent product chrome while preserving the learning surface", () => {
    const { container } = render(<DashboardShell immersive role="student"><div>沉浸课堂</div></DashboardShell>);
    expect(screen.getByText("沉浸课堂")).toBeTruthy();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(container.firstElementChild?.className).toContain("h-dvh");
    expect(container.firstElementChild?.className).toContain("overflow-hidden");
    expect(container.querySelector("main")?.className).toContain("h-full");
    expect(container.querySelector("main")?.className).toContain("overflow-hidden");
    expect(container.querySelector("main")?.firstElementChild?.className).toContain("h-full");
  });

  it("keeps normal product chrome outside immersive mode", () => {
    render(<DashboardShell role="student"><div>任务页面</div></DashboardShell>);
    expect(screen.getByRole("banner")).toBeTruthy();
    expect(screen.getByText("任务页面")).toBeTruthy();
  });

  it("keeps the header but constrains a student learning page to the viewport", () => {
    const { container } = render(
      <DashboardShell role="student" viewportLocked><div>AI 授知</div></DashboardShell>,
    );

    expect(screen.getByRole("banner")).toBeTruthy();
    expect(container.firstElementChild?.className).toContain("fixed");
    expect(container.firstElementChild?.className).toContain("h-dvh");
    expect(container.querySelector("main")?.className).toContain("overflow-hidden");
    expect(container.querySelector("main")?.firstElementChild?.className).not.toContain("pb-10");
  });

  it("lets a wide AI learning surface grow with the viewport up to a 16:9 frame", () => {
    const { container } = render(
      <DashboardShell role="student" viewportLocked wide><div>宽屏 AI 授知</div></DashboardShell>,
    );

    const learningViewport = container.querySelector("main")?.firstElementChild as HTMLElement;
    expect(learningViewport.style.maxWidth).toContain("177.7778dvh");
    expect(learningViewport.className).not.toContain("max-w-[1600px]");
    expect(learningViewport.className).toContain("pbl-wide-container");
  });

  it("uses the fluid desktop container on regular application pages", () => {
    const { container } = render(
      <DashboardShell role="teacher"><div>教师工作台</div></DashboardShell>,
    );

    expect(container.querySelector("main")?.firstElementChild?.className).toContain(
      "pbl-dashboard-container",
    );
  });

  it("uses the supplied parent route for the teacher workspace return action", () => {
    render(
      <DashboardShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher">
        <div>课程编辑</div>
      </DashboardShell>,
    );

    expect(screen.getByRole("link", { name: "返回课程库" })).toHaveAttribute("href", "/teacher/templates");
  });

  it("places a classroom action on the right while hiding only its extra header entries", () => {
    render(
      <DashboardShell
        headerEndSlot={<button type="button">全屏授课</button>}
        hideAiSettings
        hideNotifications
        role="teacher"
      >
        <div>教师课堂</div>
      </DashboardShell>,
    );

    expect(screen.queryByRole("link", { name: "AI 设置" })).toBeNull();
    expect(screen.queryByRole("button", { name: "通知中心" })).toBeNull();
    expect(screen.getByRole("button", { name: "全屏授课" }).parentElement).toContainElement(
      screen.getByRole("button", { name: "个人信息" }),
    );
  });

  it("anchors the notification menu to its button and clears the unread badge when opened", () => {
    sessionMocks.courses = [{
      id: "course-1",
      activityLog: [
        { id: "activity-2", actor: "教师", action: "发布公告", createdAt: "2026-08-08T10:00:00.000Z" },
        { id: "activity-1", actor: "学生", action: "提交成果", createdAt: "2026-08-08T09:00:00.000Z" },
      ],
    }];
    render(
      <DashboardShell currentCourse={{ id: "course-1", name: "测试课程", status: "teaching" }} role="teacher">
        <div>课堂</div>
      </DashboardShell>,
    );

    const trigger = screen.getByRole("button", { name: "通知中心" });
    expect(within(trigger).getByText("2")).toBeTruthy();
    fireEvent.click(trigger);

    expect(within(trigger).queryByText("2")).toBeNull();
    expect(screen.getByText(/教师 · 发布公告/)).toBeTruthy();
    expect(screen.getByText("通知中心").closest(".pbl-glass")?.className).toContain("absolute");
  });

  it.each(["teacher", "student"] as const)(
    "persists read notifications for the %s dashboard and only alerts for newer activity",
    (role) => {
      sessionMocks.courses = [{
        id: "course-1",
        activityLog: [
          { id: "activity-2", actor: "教师", action: "发布公告", createdAt: "2026-08-08T10:00:00.000Z" },
          { id: "activity-1", actor: "学生", action: "提交成果", createdAt: "2026-08-08T09:00:00.000Z" },
        ],
      }];

      const view = render(
        <DashboardShell currentCourse={{ id: "course-1", name: "测试课程", status: "teaching" }} role={role}>
          <div>课堂</div>
        </DashboardShell>,
      );
      const trigger = screen.getByRole("button", { name: "通知中心" });
      expect(within(trigger).getByText("2")).toBeTruthy();
      fireEvent.click(trigger);
      expect(within(trigger).queryByText("2")).toBeNull();

      view.unmount();
      const reopened = render(
        <DashboardShell currentCourse={{ id: "course-1", name: "测试课程", status: "teaching" }} role={role}>
          <div>课堂</div>
        </DashboardShell>,
      );
      expect(within(screen.getByRole("button", { name: "通知中心" })).queryByText("2")).toBeNull();

      reopened.unmount();
      sessionMocks.courses = [{
        id: "course-1",
        activityLog: [
          { id: "activity-3", actor: "教师", action: "发布新公告", createdAt: "2026-08-08T11:00:00.000Z" },
          { id: "activity-2", actor: "教师", action: "发布公告", createdAt: "2026-08-08T10:00:00.000Z" },
          { id: "activity-1", actor: "学生", action: "提交成果", createdAt: "2026-08-08T09:00:00.000Z" },
        ],
      }];
      render(
        <DashboardShell currentCourse={{ id: "course-1", name: "测试课程", status: "teaching" }} role={role}>
          <div>课堂</div>
        </DashboardShell>,
      );
      expect(within(screen.getByRole("button", { name: "通知中心" })).getByText("1")).toBeTruthy();
    },
  );

  it("keeps teacher and student read state separate", () => {
    sessionMocks.courses = [{
      id: "course-1",
      activityLog: [
        { id: "activity-1", actor: "教师", action: "发布公告", createdAt: "2026-08-08T10:00:00.000Z" },
      ],
    }];

    const teacherView = render(
      <DashboardShell currentCourse={{ id: "course-1", name: "测试课程", status: "teaching" }} role="teacher">
        <div>教师课堂</div>
      </DashboardShell>,
    );
    fireEvent.click(screen.getByRole("button", { name: "通知中心" }));
    teacherView.unmount();

    render(
      <DashboardShell currentCourse={{ id: "course-1", name: "测试课程", status: "teaching" }} role="student">
        <div>学生课堂</div>
      </DashboardShell>,
    );
    expect(within(screen.getByRole("button", { name: "通知中心" })).getByText("1")).toBeTruthy();
  });
});
