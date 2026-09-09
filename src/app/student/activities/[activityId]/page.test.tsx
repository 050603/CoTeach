import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

vi.mock("next/navigation", () => ({ useParams: () => ({ activityId: "activity" }), usePathname: () => "/student/activities/activity" }));
vi.mock("@/components/platform/student-shell", () => ({ StudentShell: ({ children }: { children: React.ReactNode }) => children }));
let fetcher: ReturnType<typeof vi.fn>;
const instance = { id: "finished-run", status: "finished", startedAt: null, endedAt: null, canWrite: false };
beforeEach(() => {
  fetcher = vi.fn(async (_url: string, options?: RequestInit) => new Response(JSON.stringify(options?.method ? { message: "活动尚未开放学习" } : { activity: { id: "activity", type: "Classroom", title: "课堂", isOpen: true, offering: { id: "offering", name: "课程", status: "open" }, chapter: { title: "章节" }, progress: { status: "completed" }, instance, instances: [instance] } }), options?.method ? { status: 403 } : undefined));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("student classroom history", () => {
  it("uses the existing entry permission check for a finished run and shows its rejection", async () => {
    render(<Page />);
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
