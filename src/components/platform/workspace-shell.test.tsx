import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/teacher/classes" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

import { StudentShell } from "./student-shell";
import { TeacherPlatformHeader, TeacherPlatformPage } from "./teacher-shell";

afterEach(() => vi.unstubAllGlobals());

describe("platform workspace shells", () => {
  it("puts teacher navigation and the contextual return action in a light top bar", () => {
    route.pathname = "/teacher/templates/new";
    render(
      <TeacherPlatformPage>
        <TeacherPlatformHeader active="templates" leading={<span>旧面包屑</span>} />
        <div>新建课程</div>
      </TeacherPlatformPage>,
    );

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回课程库" })).toHaveAttribute("href", "/teacher/templates");
    expect(screen.getByRole("link", { name: "课程库" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByText("旧面包屑")).not.toBeInTheDocument();
    expect(screen.queryByText("教师工作空间")).not.toBeInTheDocument();
    expect(screen.queryByText("让学习真正发生")).not.toBeInTheDocument();
  });

  it("shows the signed-in teacher account and common account actions", async () => {
    route.pathname = "/teacher/classes";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { role: "teacher", displayName: "李老师", username: "teacher.li" } })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: "暂时无法退出" }), { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    render(<TeacherPlatformHeader active="classes" />);

    const account = await screen.findByRole("button", { name: "教师账号：李老师" });
    expect(account).toHaveTextContent("李老师");
    expect(account).toHaveTextContent("@teacher.li");
    expect(screen.queryByRole("link", { name: "AI 设置" })).toBeNull();
    fireEvent.pointerDown(account, { button: 0, ctrlKey: false });
    expect(await screen.findByText("账号：teacher.li")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "个人中心" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "创建教师账号" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ method: "POST", headers: { "X-OpenPBL-Role": "teacher" } })));
    expect(await screen.findByRole("alert")).toHaveTextContent("退出失败，请重试");
  });

  it("keeps course pages on the same top-navigation layout", () => {
    route.pathname = "/teacher/classes/course-1";
    render(
      <TeacherPlatformPage compactNav>
        <TeacherPlatformHeader compact active="classes" />
      </TeacherPlatformPage>,
    );

    expect(screen.getByRole("main")).not.toHaveClass("pbl-workspace-teacher");
    expect(screen.getByRole("banner")).toHaveAttribute("data-compact", "true");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByText("让学习真正发生")).not.toBeInTheDocument();
  });

  it("uses a supplied parent route for dynamic teacher pages", () => {
    route.pathname = "/teacher/classrooms/run-1";
    render(
      <TeacherPlatformPage>
        <TeacherPlatformHeader backHref="/teacher/classes/course-1" backLabel="返回课程" />
      </TeacherPlatformPage>,
    );

    expect(screen.getByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/teacher/classes/course-1");
    expect(screen.queryByRole("link", { name: "平台首页" })).not.toBeInTheDocument();
  });

  it("returns from the teacher course library to course management", () => {
    route.pathname = "/teacher/templates";
    render(<TeacherPlatformHeader active="templates" />);

    expect(screen.getByRole("link", { name: "返回教学班" })).toHaveAttribute("href", "/teacher/classes");
  });

  it("links the shared textbook library and returns textbook details to it", () => {
    route.pathname = "/teacher/textbooks/book-1";
    render(<TeacherPlatformHeader active="textbooks" />);

    expect(screen.getByRole("link", { name: "教材库" })).toHaveAttribute("href", "/teacher/textbooks");
    expect(screen.getByRole("link", { name: "教材库" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "返回教材库" })).toHaveAttribute("href", "/teacher/textbooks");
  });

  it("returns from course members to the owning course", () => {
    route.pathname = "/teacher/classes/course-1/students";
    render(<TeacherPlatformHeader active="classes" />);
    expect(screen.getByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/teacher/classes/course-1");
  });

  it("uses the student course list as the default parent for nested pages", () => {
    route.pathname = "/student/courses/course-1";
    render(<StudentShell>课程内容</StudentShell>);

    expect(screen.getByRole("banner")).toBeInTheDocument();
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute("href", "/student?all=1");
    expect(screen.queryByText("学生学习空间")).not.toBeInTheDocument();
    expect(screen.getByText("课程内容")).toBeInTheDocument();
  });

  it("allows a student activity to supply its exact parent course", () => {
    route.pathname = "/student/activities/activity-1";
    render(<StudentShell backHref="/student/courses/course-1" backLabel="返回课程">活动</StudentShell>);

    expect(screen.getByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/student/courses/course-1");
  });
  it("opens student personal center and uses student-scoped logout", async () => {
    route.pathname = "/student";
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ user: { role: "student", displayName: "小林", username: "lin" } })))
      .mockResolvedValueOnce(new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetcher);
    render(<StudentShell>课程内容</StudentShell>);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "学生个人中心：小林" }), { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "个人中心" })).toHaveAttribute("href", "/student/profile");
    expect(screen.queryByRole("menuitem", { name: "创建教师账号" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "退出登录" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/auth/logout", expect.objectContaining({ headers: { "X-OpenPBL-Role": "student" } })));
    expect(await screen.findByRole("alert")).toHaveTextContent("退出失败，请重试");
  });

});
