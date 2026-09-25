import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudentCoursePage from "./page";

const navigation = vi.hoisted(() => ({ replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useParams: () => ({ offeringId: "series-1" }),
  usePathname: () => "/student/courses/series-1",
}));

const course = {
  id: "series-1",
  name: "城市生态与社区行动",
  term: "2026 秋季",
  status: "open",
  description: "研究城市与自然的关系，并提出可以落地的社区改善方案。",
  outline: "通过观察、访谈、方案设计和公开展示完成项目学习。",
  referenceMaterials: "参考书目：城市观察手册",
  courseReferences: [
    { id: "reading", kind: "link", title: "城市生态延伸阅读", url: "https://example.test/reading" },
    { id: "pdf", kind: "file", title: "课程阅读手册", url: "/api/uploads/pdf", fileName: "阅读手册.pdf", fileSize: "1.2 MB" },
  ],
  startsAt: "2026-09-01T00:00:00.000Z",
  endsAt: "2027-01-10T00:00:00.000Z",
  teacher: { displayName: "李老师" },
  chapters: [
    {
      id: "chapter-1",
      title: "发现问题",
      description: "从日常生活中发现值得研究的真实问题。",
      isOpen: true,
      opensAt: null,
      activities: [
        {
          id: "resource-1",
          type: "Resource",
          title: "社区观察方法",
          description: null,
          isOpen: true,
          progress: { status: "completed" },
        },
        {
          id: "task-current",
          type: "Classroom",
          title: "城市问题发现课",
          description: null,
          isOpen: true,
          progress: { status: "in_progress" },
        },
      ],
    },
    {
      id: "chapter-2",
      title: "形成方案",
      description: "整合证据并形成方案。",
      isOpen: false,
      opensAt: null,
      activities: [
        {
          id: "resource-locked",
          type: "Resource",
          title: "方案设计工具包",
          description: null,
          isOpen: true,
          progress: { status: "not_started" },
        },
      ],
    },
  ],
};

function respond(value: Omit<typeof course, "description"> & { description: string | null } = course) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        courses: [value],
        viewer: { id: "student-1", displayName: "林晓雨" },
      }),
    }),
  );
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("学生课程工作区", () => {
  it("uses the full-width learning workspace and prioritizes the in-progress task", async () => {
    respond();
    const { container } = render(<StudentCoursePage />);

    expect(await screen.findByRole("heading", { name: course.name })).toBeInTheDocument();
    expect(container.querySelector(".pbl-workspace-nav")).toBeNull();
    expect(container.querySelectorAll(".pbl-student-course-main")).toHaveLength(1);
    expect(container.querySelectorAll(".pbl-student-chapter")).toHaveLength(2);
    expect(container.querySelector(".pbl-student-chapter .pbl-chapter-card")).toBeNull();
    expect(container.querySelector(".pbl-student-chapter-description")).toBeNull();
    expect(container.querySelectorAll(".pbl-student-task-list")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "返回我的课程" })).toHaveAttribute("href", "/student?all=1");
    const account = screen.getByRole("button", { name: "学生个人中心：林晓雨" });
    expect(account).toBeInTheDocument();
    expect(account).toHaveAttribute("data-role", "student");
    fireEvent.pointerDown(account, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: "个人中心" })).toHaveAttribute("href", "/student/profile");
    expect(screen.getByRole("menu")).toHaveAttribute("data-role", "student");
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.getByRole("button", { name: "课程学习" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("link", { name: /继续学习/ })).toHaveAttribute(
      "href",
      "/student/activities/task-current",
    );
    expect(screen.queryByText("当前任务")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".pbl-student-task-row.is-current")).toHaveLength(1);
    expect(screen.getByRole("progressbar", { name: "课程学习进度" })).toHaveAttribute("aria-valuenow", "1");
    expect(screen.getByText("已完成 1 / 3 项任务")).toBeInTheDocument();
  });

  it("does not invent an explanatory subtitle when the course has no introduction", async () => {
    respond({ ...course, description: null });
    render(<StudentCoursePage />);

    expect(await screen.findByRole("heading", { name: course.name })).toBeInTheDocument();
    expect(screen.queryByText("围绕真实问题，按章节完成课堂学习与实践任务。")).toBeNull();
    expect(screen.getByRole("progressbar", { name: "课程学习进度" })).toBeInTheDocument();
  });

  it("expands locked chapters while keeping their tasks unavailable", async () => {
    respond();
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: course.name });

    const lockedChapter = screen.getByRole("button", { name: /形成方案/ });
    expect(lockedChapter).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(lockedChapter);
    expect(lockedChapter).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("方案设计工具包").closest("a")).toBeNull();
    expect(screen.getAllByText("未解锁").length).toBeGreaterThan(0);
  });

  it("merges the introduction, outline and course metadata into one tab", async () => {
    respond();
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: course.name });

    fireEvent.click(screen.getByRole("button", { name: "课程介绍" }));
    expect(screen.getByRole("heading", { name: "课程介绍" })).toBeInTheDocument();
    expect(screen.getByText(course.outline)).toBeInTheDocument();
    expect(screen.getAllByText("李老师").length).toBeGreaterThan(0);
    expect(screen.getByRole("heading", { name: "课程大纲" })).toBeInTheDocument();
  });

  it("shows only separately uploaded course references", async () => {
    respond();
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: course.name });

    fireEvent.click(screen.getByRole("button", { name: "课程资料" }));
    expect(screen.getByText(course.referenceMaterials)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /城市生态延伸阅读/ })).toHaveAttribute("href", "https://example.test/reading");
    expect(screen.getByRole("link", { name: /课程阅读手册/ })).toHaveAttribute("href", "/api/uploads/pdf");
    expect(screen.queryByText("社区观察方法")).not.toBeInTheDocument();
    expect(screen.queryByText("方案设计工具包")).not.toBeInTheDocument();
  });

  it("marks computed course reminders read when opened and keeps them read after closing", async () => {
    respond();
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: course.name });

    const trigger = await screen.findByRole("button", { name: "课程提醒，共 2 条" });
    fireEvent.click(trigger);
    const reminder = await screen.findByText("继续：城市问题发现课");
    expect(reminder).toBeInTheDocument();
    expect(screen.getByText("1 个章节尚待教师解锁。")).toBeInTheDocument();
    expect(trigger).toHaveAccessibleName("课程提醒，共 0 条");

    fireEvent.click(trigger);
    expect(trigger).toHaveAccessibleName("课程提醒，共 0 条");
  });

  it("does not restore read course reminders after the page remounts", async () => {
    respond();
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: course.name });
    fireEvent.click(await screen.findByRole("button", { name: "课程提醒，共 2 条" }));

    cleanup();
    respond();
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: course.name });

    expect(screen.getByRole("button", { name: "课程提醒，共 0 条" })).toBeInTheDocument();
  });

  it("shows completion state when every task is complete", async () => {
    const completeCourse = {
      ...course,
      status: "finished",
      chapters: course.chapters.slice(0, 1).map((chapter) => ({
        ...chapter,
        activities: chapter.activities.map((activity) => ({
          ...activity,
          progress: { status: "completed" },
        })),
      })),
    };
    respond(completeCourse);
    render(<StudentCoursePage />);
    const state = await screen.findByText("课程学习已完成");

    expect(state).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /开始学习|继续学习/ })).toBeNull();
    fireEvent.click(await screen.findByRole("button", { name: "课程提醒，共 1 条" }));
    const popover = await screen.findByText("你已完成全部学习任务，可以查看学习记录。");
    expect(within(popover.closest("li")!).getByText(/全部学习任务/)).toBeInTheDocument();
  });

  it("changes the primary action to learning records after the course ends", async () => {
    respond({ ...course, status: "finished" });
    render(<StudentCoursePage />);

    expect(await screen.findByRole("link", { name: /查看学习记录/ })).toHaveAttribute(
      "href",
      "/student/activities/task-current",
    );
  });

  it("keeps request failures inside the new workspace", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ message: "课程服务暂时不可用" }),
      }),
    );
    const { container } = render(<StudentCoursePage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("课程服务暂时不可用");
    expect(container.querySelector(".pbl-student-course-workspace")).toBeInTheDocument();
    expect(container.querySelector(".pbl-workspace-nav")).toBeNull();
    expect(screen.getByRole("button", { name: "重新加载" })).toBeInTheDocument();
  });
});
