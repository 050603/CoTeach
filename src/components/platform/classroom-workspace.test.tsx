import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClassroomWorkspace } from "./classroom-workspace";

vi.mock("./student-shell", () => ({ StudentShell: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("./teacher-shell", () => ({ TeacherPlatformPage: ({ children }: { children: React.ReactNode }) => children, TeacherPlatformHeader: () => null }));
const results = { submissions: [], artifacts: [{ id: "artifact", title: "水质调查成果", versions: [{ id: "v1", sequence: 1, sourceHtml: "我们的调查报告" }] }], reflections: [{ id: "reflection", content: "下次我们会扩大采样范围。" }], evaluations: [{ id: "evaluation", evaluatorType: "TEACHER", content: "论据充分，建议增加样本。", score: 90 }], showcases: [] };
let fetcher: ReturnType<typeof vi.fn>;
function mockClassroom(status = "finished", teacher = false) {
  fetcher.mockImplementation(async (url: string) => new Response(JSON.stringify(url.endsWith("/outcomes") ? results : url.endsWith("/ai") ? { conversations: [], supportRecords: [] } : {
    participation: { id: "p", completedAt: "2026-09-09T00:00:00Z" }, student: { displayName: "小林" },
    instance: { id: "i", status, activityId: "a", offeringId: "o", offeringName: "科学探索", title: "河流调查", runNo: 1, templateVersion: 2, snapshot: { kind: "pbl-course" }, coverImageUrl: "/generated/river-cover.png" },
    workspace: { version: 4, projectState: { document: "保留的调查文档", code: "<p>历史作品</p>" } }, isTeacher: teacher, canWrite: status === "teaching" && !teacher,
  })));
}
beforeEach(() => { fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("finished classroom records", () => {
  it("opens PBL history on actual artifacts, reflections and evaluations without student authoring forms", async () => {
    mockClassroom(); render(<ClassroomWorkspace participationId="p" />);
    expect(await screen.findByRole("img", { name: "河流调查课堂封面" })).toBeVisible();
    expect(await screen.findByText("水质调查成果")).toBeVisible();
    expect(screen.getByText("下次我们会扩大采样范围。")).toBeVisible();
    expect(screen.getByText("论据充分，建议增加样本。")).toBeVisible();
    expect(screen.getByRole("button", { name: "成果与评价" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: "提交成果新版本" })).toBeNull();
    expect(screen.queryByRole("button", { name: "保存评价" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
    expect(screen.getByLabelText("项目文档")).toHaveValue("保留的调查文档");
    expect(screen.getByLabelText("项目文档")).toHaveAttribute("readonly");
    fireEvent.click(screen.getByRole("button", { name: "AI 协作" }));
    expect(screen.queryByRole("button", { name: "新建讨论" })).toBeNull();
    expect(fetcher.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  });
  it("keeps a scheduled run read-only", async () => {
    mockClassroom("scheduled"); render(<ClassroomWorkspace participationId="p" />);
    await screen.findByText("河流调查");
    expect(screen.queryByRole("button", { name: "提交环节记录" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
    expect(screen.getByLabelText("项目文档")).toHaveAttribute("readonly");
  });
  it("clears a failed refresh message after a successful reload", async () => {
    mockClassroom(); render(<ClassroomWorkspace participationId="p" />);
    await screen.findByText("水质调查成果");
    fireEvent.click(screen.getByRole("button", { name: "项目工作区" }));
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "暂时无法读取" }), { status: 503 }));
    fireEvent.click(screen.getByRole("button", { name: /重新加载/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时无法读取");
    fireEvent.click(screen.getByRole("button", { name: /重新加载/ }));
    await screen.findByDisplayValue("保留的调查文档");
    await vi.waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
  it("preserves teacher post-class evaluation and the outcomes default", async () => {
    mockClassroom("finished", true); render(<ClassroomWorkspace participationId="p" role="teacher" />);
    expect(await screen.findByRole("button", { name: "保存评价" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "成果与评价" })).toHaveAttribute("aria-pressed", "true");
  });
});
