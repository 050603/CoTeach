import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({
  useParams: () => ({ offeringId: "course-1" }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/components/platform/teacher-shell", () => ({
  TeacherPlatformPage: ({ children }: { children: React.ReactNode }) => <main>{children}</main>,
  TeacherPlatformHeader: () => <nav>教师课程</nav>,
}));

const summary = {
  offering: { id: "course-1", name: "设计思维", term: "秋季" },
  activities: [
    { id: "form", chapterId: "chapter", chapterTitle: "第一章", chapterPosition: 1, position: 1, title: "学习调查", type: "FORM", isOpen: true, archived: false },
  ],
  totals: { members: 2, participated: 1, incomplete: 1, pendingEvaluation: 1 },
  updatedAt: "2026-09-10T08:00:00.000Z",
  students: [
    { id: "student-1", enrollmentId: "enrollment-1", username: "=formula", displayName: "小林", status: "active", joinedAt: "2026-09-01T08:00:00.000Z", participated: true, completedOpenActivities: 1, openActivityCount: 1, classroomParticipationCount: 1, lastLearningAt: "2026-09-10T08:00:00.000Z", activityStatuses: { form: "completed" }, attentionReasons: ["pending_teacher_evaluation"] },
    { id: "student-2", enrollmentId: "enrollment-2", username: "wang", displayName: "小王", status: "active", joinedAt: "2026-09-01T08:00:00.000Z", participated: false, completedOpenActivities: 0, openActivityCount: 1, classroomParticipationCount: 0, lastLearningAt: null, activityStatuses: { form: "not_started" }, attentionReasons: ["not_participated", "incomplete_open_activity"] },
  ],
};
const detail = {
  student: { id: "student-1", enrollmentId: "enrollment-1", username: "=formula", displayName: "小林", status: "active", joinedAt: "2026-09-01T08:00:00.000Z" },
  activities: [{ ...summary.activities[0], config: { questions: [{ id: "q1", title: "你选择什么？", options: [{ id: "a", label: "校园环境" }] }] }, progress: { status: "completed", startedAt: null, completedAt: "2026-09-10T08:00:00.000Z", lastAccessedAt: "2026-09-10T08:00:00.000Z" } }],
  classrooms: [],
};

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  vi.spyOn(window.history, "replaceState").mockImplementation(() => {});
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function mockFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/students?view=summary")) return Response.json(summary);
    if (url.endsWith("/students/enrollment-1") && init?.method !== "DELETE") return Response.json(detail);
    if (url.endsWith("/students/enrollment-2")) return Response.json({ ...detail, student: { ...detail.student, enrollmentId: "enrollment-2", displayName: "小王", username: "wang" } });
    if (url.includes("/submissions?")) return Response.json({
      activity: { id: "form", title: "学习调查", type: "FORM" },
      submissions: [{ id: "s1", activityVersion: 1, activitySnapshot: { config: detail.activities[0].config }, payload: { answers: { q1: "a" } }, submittedAt: "2026-09-10T08:00:00.000Z", snapshotSource: "submission" }],
      pagination: { page: 1, pageSize: 20, total: 1, hasMore: false },
    });
    if (url.endsWith("/students/export") && init?.method === "POST") return new Response("zip-bytes", { headers: { "Content-Type": "application/zip", "Content-Disposition": "attachment; filename*=UTF-8''%E8%AE%BE%E8%AE%A1%E6%80%9D%E7%BB%B4-%E5%AD%A6%E7%94%9F%E5%AD%A6%E4%B9%A0%E8%AE%B0%E5%BD%95.zip" } });
    if (url.endsWith("/students/enrollment-1") && init?.method === "DELETE") return Response.json({ enrollmentId: "enrollment-1", status: "withdrawn" });
    if (url.endsWith("/reset-password") && init?.method === "POST") return Response.json({ token: "one-time" }, { status: 201 });
    throw new Error(`Unexpected request: ${url}`);
  });
}

describe("教师学生学习记录页面", () => {
  it("shows real summary data and filters the list by attention and activity status", async () => {
    mockFetch();
    render(<Page/>);
    expect(await screen.findByRole("heading", { name: "学生与学习记录" })).toBeInTheDocument();
    expect(screen.getByText("设计思维")).toBeInTheDocument();
    expect(screen.getByText("含真实访问或提交记录")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("关注筛选"), { target: { value: "not_participated" } });
    expect(screen.getByRole("button", { name: /小王/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /小林/ })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("筛选活动"), { target: { value: "form" } });
    fireEvent.change(screen.getByLabelText("学习状态"), { target: { value: "completed" } });
    expect(await screen.findByText("没有符合条件的学生")).toBeInTheDocument();
  });

  it("restores question and option labels from the submission snapshot", async () => {
    mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "提交记录" }));
    expect(await screen.findByText("你选择什么？")).toBeInTheDocument();
    expect(screen.getByText("校园环境")).toBeInTheDocument();
  });

  it("keeps the latest selected student when an earlier detail request finishes later", async () => {
    let releaseFirst!: (response: Response) => void;
    const firstDetail = new Promise<Response>((resolve) => { releaseFirst = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/students?view=summary")) return Response.json(summary);
      if (url.endsWith("/students/enrollment-1")) return firstDetail;
      if (url.endsWith("/students/enrollment-2")) return Response.json({ ...detail, student: { ...detail.student, enrollmentId: "enrollment-2", displayName: "小王", username: "wang" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<Page/>);
    fireEvent.click(await screen.findByRole("button", { name: /小王/ }));
    expect(await screen.findByRole("heading", { name: "小王" })).toBeInTheDocument();
    releaseFirst(Response.json(detail));
    await Promise.resolve();
    expect(screen.getByRole("heading", { name: "小王" })).toBeInTheDocument();
  });

  it("lets the teacher choose data types and downloads the current filtered results as a ZIP", async () => {
    const fetcher = mockFetch();
    vi.stubGlobal("URL", { ...URL, createObjectURL: vi.fn(() => "blob:zip"), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<Page/>);
    await screen.findByRole("heading", { name: "学生与学习记录" });
    fireEvent.click(screen.getByRole("button", { name: "导出当前结果" }));
    expect(screen.getByRole("dialog", { name: "导出学生学习记录数据包" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /评价记录/ }));
    fireEvent.click(screen.getByRole("button", { name: "生成并下载 ZIP" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/students/export", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ enrollmentIds: ["enrollment-1", "enrollment-2"], sections: ["summary", "activity_progress", "activity_submissions", "classrooms", "artifacts", "reflections"] }),
    })));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
  });

  it("generates a student-scoped reset link and copies it", async () => {
    const fetcher = mockFetch();
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockResolvedValue(undefined) } });
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    expect(screen.queryByRole("button", { name: "生成密码重置链接" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "账号设置" }));
    fireEvent.click(await screen.findByRole("button", { name: "生成密码重置链接" }));
    expect(await screen.findByText(/token=one-time/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "复制链接" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining("token=one-time")));
    expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/reset-password", expect.objectContaining({ body: JSON.stringify({ enrollmentId: "enrollment-1" }) }));
  });

  it("keeps member removal in account settings and uses the scoped enrollment endpoint", async () => {
    const fetcher = mockFetch();
    render(<Page/>);
    await screen.findByRole("heading", { name: "小林" });
    fireEvent.click(screen.getByRole("tab", { name: "账号设置" }));
    fireEvent.click(screen.getByRole("button", { name: "移出教学班" }));
    fireEvent.click(await screen.findByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/students/enrollment-1", { method: "DELETE" }));
  });
});
