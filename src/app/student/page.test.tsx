import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import StudentEntryPage from "./page";
const navigation = vi.hoisted(() => ({ replace: vi.fn(), push: vi.fn() }));
const query = vi.hoisted(() => ({ all: false }));
vi.mock("next/navigation", () => ({
  useRouter: () => navigation,
  useSearchParams: () => ({ get: () => (query.all ? "1" : null) }),
}));
const course = {
  id: "series-1",
  name: "城市生态",
  description: null,
  coverImageUrl: null,
  startsAt: null,
  term: "秋季",
  teacher: { displayName: "李老师" },
  chapters: [],
};
describe("student learning entry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    query.all = false;
  });
  afterEach(() => vi.unstubAllGlobals());
  it("takes an unauthenticated visitor directly to the login page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ status: 401, ok: false }),
    );
    render(<StudentEntryPage />);
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith("/student/login"),
    );
    expect(screen.queryByLabelText("姓名")).toBeNull();
  });
  it("opens the single enrolled course automatically", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ courses: [course] }),
        }),
    );
    render(<StudentEntryPage />);
    await waitFor(() =>
      expect(navigation.replace).toHaveBeenCalledWith(
        "/student/courses/series-1",
      ),
    );
  });
  it("allows returning to the course list even with a single enrollment", async () => {
    query.all = true;
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ courses: [course] }),
        }),
    );
    render(<StudentEntryPage />);
    expect(
      await screen.findByRole("heading", { name: "城市生态" }),
    ).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
  it("offers a choice when multiple course series are enrolled", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            courses: [
              course,
              { ...course, id: "series-2", name: "可持续校园" },
            ],
          }),
        }),
    );
    render(<StudentEntryPage />);
    expect(
      await screen.findByRole("heading", { name: "可持续校园" }),
    ).toBeTruthy();
    expect(navigation.replace).not.toHaveBeenCalled();
  });
  it("joins a course using the authenticated enrollment response", async () => {
    query.all = true;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ courses: [] }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ enrollment: { offeringId: "joined-course" } }),
      });
    vi.stubGlobal("fetch", fetcher);
    render(<StudentEntryPage />);
    fireEvent.change(await screen.findByLabelText("课程邀请码"), {
      target: { value: "ABC123" },
    });
    fireEvent.click(screen.getByRole("button", { name: "加入并查看课程" }));
    await waitFor(() =>
      expect(navigation.push).toHaveBeenCalledWith(
        "/student/courses/joined-course",
      ),
    );
  });
  it("continues the most recently visited open task and skips locked or finished courses", async () => {
    query.all = true;
    const task = (id: string, lastAccessedAt: string, isOpen = true) => ({ id, title: id, isOpen, progress: { status: "in_progress", lastAccessedAt } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ courses: [
      { ...course, status: "open", chapters: [{ isOpen: true, activities: [task("older", "2026-09-01"), task("latest", "2026-09-08"), task("locked", "2026-09-09", false)] }] },
      { ...course, id: "ended", status: "finished", chapters: [{ isOpen: true, activities: [task("ended-task", "2026-09-09")] }] },
    ] }) }));
    render(<StudentEntryPage />);
    expect((await screen.findByRole("link", { name: "继续学习" })).getAttribute("href")).toBe("/student/activities/latest");
  });

});
