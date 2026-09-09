import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({ useParams: () => ({ activityId: "activity" }), usePathname: () => "/student/activities/activity" }));
vi.mock("@/components/platform/student-shell", () => ({ StudentShell: ({ children }: { children: React.ReactNode }) => children }));
let fetcher: ReturnType<typeof vi.fn>;
const instance = { id: "finished-run", status: "finished", startedAt: null, endedAt: null, canWrite: false, coverImageUrl: "/generated/classroom-cover.png" };
beforeEach(() => {
  fetcher = vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method ? { message: "活动尚未开放学习" } : { activity: { id: "activity", type: "Classroom", title: "课堂", isOpen: true, offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" }, progress: { status: "completed" }, instance, instances: [instance] } }), options?.method ? { status: 403 } : undefined));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("student classroom history", () => {
  it("uses the existing entry permission check for a finished run and shows its rejection", async () => {
    render(<Page />);
    expect(await screen.findByRole("img", { name: "课堂课堂封面" })).toHaveAttribute("src", expect.stringContaining("classroom-cover.png"));
    fireEvent.click(await screen.findByRole("button", { name: /查看课堂记录/ }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/finished-run/enter", { method: "POST" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("活动尚未开放学习");
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });
  it("does not offer writable entry for a closed offering even if an older API reports canWrite", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ activity: { id: "activity", type: "Classroom", title: "课堂", isOpen: true, offering: { id: "offering", name: "课程", status: "finished" }, chapter: { title: "章节" }, progress: { status: "completed" }, instance: { ...instance, status: "teaching", canWrite: true } } })));
    render(<Page />);
    await screen.findByRole("heading", { name: "课堂" });
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });
});

describe("student questionnaire", () => {
  it("renders mixed question types and submits option ids with text answers", async () => {
    fetcher.mockImplementation(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method ? { progress: { progressData: JSON.parse(String(options.body)) } } : { activity: {
      id: "activity", type: "Form", title: "课堂反馈", description: null, isOpen: true,
      offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" },
      config: { content: "请真实表达", questions: [
        { id: "pace", title: "课堂节奏如何？", type: "single-choice", required: true, options: [{ id: "fast", label: "偏快" }, { id: "good", label: "合适" }] },
        { id: "idea", title: "最有启发的内容？", type: "short-text", required: true, options: [] },
      ] }, progress: { status: "not_started", progressData: {} }, instance: null,
    } })));
    render(<Page />);
    expect(screen.queryByText("我的学习空间")).toBeNull();
    fireEvent.click(await screen.findByRole("radio", { name: /合适/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "最有启发的内容？" }), { target: { value: "小组共创让我理解了设计思维" } });
    fireEvent.click(screen.getByRole("button", { name: "提交问卷" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/submit", expect.objectContaining({ method: "POST", body: JSON.stringify({ answer: "", answers: { pace: "good", idea: "小组共创让我理解了设计思维" } }) })));
  });
});
