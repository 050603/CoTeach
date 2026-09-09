import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const route = vi.hoisted(() => ({ pathname: "/teacher/classes" }));
vi.mock("next/navigation", () => ({ usePathname: () => route.pathname }));

import { StudentShell } from "./student-shell";
import { TeacherPlatformHeader, TeacherPlatformPage } from "./teacher-shell";

describe("platform workspace shells", () => {
  it("puts the teacher return action in the sidebar without a top bar", () => {
    route.pathname = "/teacher/templates/new";
    render(
      <TeacherPlatformPage>
        <TeacherPlatformHeader active="templates" leading={<span>旧面包屑</span>} />
        <div>新建课程</div>
      </TeacherPlatformPage>,
    );

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回课程库" })).toHaveAttribute("href", "/teacher/templates");
    expect(screen.queryByText("旧面包屑")).not.toBeInTheDocument();
    expect(screen.queryByText("教师工作空间")).not.toBeInTheDocument();
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

    expect(screen.getByRole("link", { name: "返回课程系列" })).toHaveAttribute("href", "/teacher/classes");
  });

  it("returns from course members to the owning course", () => {
    route.pathname = "/teacher/classes/course-1/students";
    render(<TeacherPlatformHeader active="classes" />);
    expect(screen.getByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/teacher/classes/course-1");
  });

  it("uses the student course list as the default parent for nested pages", () => {
    route.pathname = "/student/courses/course-1";
    render(<StudentShell>课程内容</StudentShell>);

    expect(screen.queryByRole("banner")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute("href", "/student?all=1");
    expect(screen.queryByText("学生学习空间")).not.toBeInTheDocument();
    expect(screen.getByText("课程内容")).toBeInTheDocument();
  });

  it("allows a student activity to supply its exact parent course", () => {
    route.pathname = "/student/activities/activity-1";
    render(<StudentShell backHref="/student/courses/course-1" backLabel="返回课程">活动</StudentShell>);

    expect(screen.getByRole("link", { name: "返回课程" })).toHaveAttribute("href", "/student/courses/course-1");
  });
});
