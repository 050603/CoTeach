import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import StudentCoursePage from "./page";
const navigation = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useParams: () => ({ offeringId: "series-1" }),
}));
const activity = {
  id: "task-1",
  type: "Classroom",
  title: "第一堂课",
  isOpen: true,
  progress: { status: "not_started" },
};
const course = {
  id: "series-1",
  name: "城市生态",
  description: "研究城市与自然的关系",
  outline: "通过调查开展项目学习",
  referenceMaterials: "参考书目：城市观察手册",
  teacher: { displayName: "李老师" },
  chapters: [
    {
      id: "chapter-1",
      title: "发现问题",
      isOpen: false,
      activities: [activity],
    },
  ],
};
afterEach(() => vi.unstubAllGlobals());
describe("student MOOC course home", () => {
  it("never links to tasks inside a locked chapter, even when a task says it is open", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ courses: [course] }),
      }),
    );
    render(<StudentCoursePage />);
    expect(
      await screen.findByRole("heading", { name: "城市生态" }),
    ).toBeTruthy();
    expect(screen.getByText("第一堂课").closest("a")).toBeNull();
    expect(screen.queryByRole("link", { name: /开始学习/ })).toBeNull();
    expect(screen.getByText("未解锁")).toBeTruthy();
  });
  it("provides course details, the overall outline, and reference materials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ courses: [course] }),
      }),
    );
    render(<StudentCoursePage />);
    await screen.findByRole("heading", { name: "城市生态" });
    fireEvent.click(screen.getByRole("button", { name: "课程详情" }));
    expect(screen.getByRole("heading", { name: "关于这门课程" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "课程大纲" }));
    expect(screen.getByText("通过调查开展项目学习")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "参考资料" }));
    expect(screen.getByText("参考书目：城市观察手册")).toBeTruthy();
  });
});
