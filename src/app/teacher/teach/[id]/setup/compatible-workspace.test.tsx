import "@testing-library/jest-dom/vitest";
import type { ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CompatibleWorkspace from "./compatible-workspace";
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/dashboard-shell", () => ({ DashboardShell: ({ children }: { children: ReactNode }) => <main>{children}</main> }));
const props = { id: "run", title: "实践课堂", userName: "教师", offeringId: "offering", activityId: "activity", templateVersionId: "version", status: "SCHEDULED", snapshot: { schemaVersion: 1, title: "实践课堂", subject: "科学", grade: "七年级", durationMinutes: 45, summary: "调查社区并制作作品", learningObjectives: ["分析调研证据"], outline: [{ title: "社区调查", durationMinutes: 45, description: "访谈社区成员" }], resources: [{ title: "参考资料", url: "https://example.com/reference" }] } };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => { vi.clearAllMocks(); fetcher = vi.fn(async () => new Response(JSON.stringify({ instance: { id: "next-run" } }))); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("非 PBL 原工作台兼容", () => {
  it("shows the published instructions without automatically starting", async () => {
    render(<CompatibleWorkspace {...props}/>);
    expect(screen.getByText("调查社区并制作作品")).toBeInTheDocument();
    expect(screen.getByText("分析调研证据")).toBeInTheDocument();
    expect(screen.getByText("访谈社区成员")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "参考资料" })).toHaveAttribute("href", "https://example.com/reference");
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始上课" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/run/start", expect.objectContaining({ method: "POST" }));
  });
  it("keeps the workbench available when start fails so it can be retried", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "课堂状态已变化" }), { status: 409 }));
    render(<CompatibleWorkspace {...props}/>);
    fireEvent.click(screen.getByRole("button", { name: "开始上课" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("课堂状态已变化");
    expect(router.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "开始上课" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
  });
  it("requires the original workbench end dialog before completing a lesson", async () => {
    render(<CompatibleWorkspace {...props} status="TEACHING"/>);
    fireEvent.click(screen.getByRole("button", { name: "结束课堂" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(fetcher).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "结束课堂" }).at(-1)!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/classroom-instances/run/finish", expect.objectContaining({ method: "POST" })));
  });
  it("keeps a failed end confirmation open and permits retry", async () => {
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "暂时无法结束" }), { status: 503 }));
    render(<CompatibleWorkspace {...props} status="TEACHING"/>);
    fireEvent.click(screen.getByRole("button", { name: "结束课堂" }));
    fireEvent.click(screen.getAllByRole("button", { name: "结束课堂" }).at(-1)!);
    await waitFor(() => expect(screen.getByRole("alertdialog")).toHaveTextContent("暂时无法结束"));
    expect(router.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole("button", { name: "结束课堂" }).at(-1)!);
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
  });
  it("creates a new run from a finished lesson without resetting history", async () => {
    render(<CompatibleWorkspace {...props} status="FINISHED"/>);
    fireEvent.click(screen.getByRole("button", { name: "再次授课" }));
    await waitFor(() => expect(router.push).toHaveBeenCalledWith("/teacher/teach/next-run/setup"));
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/instance", expect.objectContaining({ method: "POST", body: JSON.stringify({ templateVersionId: "version" }) }));
  });
});
