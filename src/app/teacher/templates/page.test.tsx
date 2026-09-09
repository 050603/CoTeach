import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse, encodePblTemplate } from "@/lib/platform/pbl-template";
import TeacherTemplatesPage from "./page";
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, usePathname: () => "/teacher/templates" }));
const content = { schemaVersion: 1, title: "雨水收集", subject: "科学", grade: "七年级", durationMinutes: 45, summary: "设计校园雨水收集装置。", learningObjectives: ["计算集水面积"], outline: [{ title: "调查与设计", durationMinutes: 45, description: "测量集水区并提出方案。" }], resources: [] };
const template = { id: "template-1", title: content.title, description: content.summary, status: "ACTIVE", versions: [{ id: "version-1", version: 1, snapshot: content }] };
const fetchMock = vi.fn();
describe("teacher course library", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.stubGlobal("fetch", fetchMock); fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [template] }) }); });
  afterEach(() => vi.unstubAllGlobals());
  it("shows course contents and keeps the existing published version when editing", async () => {
    render(<TeacherTemplatesPage />);
    await screen.findByRole("heading", { name: "雨水收集" });
    fireEvent.click(screen.getByRole("button", { name: "查看课程" }));
    expect(screen.getByText("计算集水面积")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "编辑课程内容" }));
    fireEvent.change(screen.getByLabelText("课程简介"), { target: { value: "新的教学说明" } });
    fireEvent.click(screen.getByRole("button", { name: "保存新版本" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1/versions", expect.objectContaining({ method: "POST", body: expect.stringContaining("新的教学说明") })));
  });
  it("creates a durable draft and opens the existing quick generator from the library", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? { ok: true, json: async () => ({ templateId: "quick-course" }) }
      : { ok: true, json: async () => ({ templates: [] }) });
    render(<TeacherTemplatesPage />);
    await screen.findByText("从一堂课开始");
    fireEvent.click(screen.getByRole("button", { name: "新建课程" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/pbl", expect.objectContaining({ method: "POST", body: "{}" })));
    expect(navigation.push).toHaveBeenCalledWith("/teacher/prepare/quick-course/verify");
    expect(screen.queryByRole("link", { name: "完整五阶段备课" })).toBeNull();
  });
  it("opens generated PBL courses and continue-preparation actions in the publish center", async () => {
    const snapshot = encodePblTemplate(createPblTemplateCourse("pbl", { name: "五阶段项目" }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, id: "pbl", title: "五阶段项目", versions: [{ version: 1, snapshot }] }] }) });
    render(<TeacherTemplatesPage />);
    expect((await screen.findByRole("link", { name: "打开课程 五阶段项目" })).getAttribute("href")).toBe("/teacher/prepare/pbl/preview");
    expect(screen.getByRole("link", { name: "继续备课" }).getAttribute("href")).toBe("/teacher/prepare/pbl/preview");
    expect(screen.queryByRole("link", { name: "完整五阶段备课" })).toBeNull();
  });
  it("shows the latest generated classroom cover on its course-library card", async () => {
    const coverImageUrl = "/api/openmaic/classroom-media/template-cover-pbl/media/classroom-cover-v2.webp";
    const snapshot = encodePblTemplate(createPblTemplateCourse("pbl", {
      name: "人工智能教学法",
      coverImageUrl,
    }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{
      ...template,
      id: "pbl",
      title: "人工智能教学法",
      versions: [{ version: 2, snapshot }],
    }] }) });

    render(<TeacherTemplatesPage />);

    expect(await screen.findByRole("img", { name: "人工智能教学法课程封面" }))
      .toHaveAttribute("src", coverImageUrl);
  });
  it("requires confirmation before archiving a reusable course", async () => {
    render(<TeacherTemplatesPage />); await screen.findByRole("heading", { name: "雨水收集" });
    fireEvent.click(screen.getByRole("button", { name: "归档 雨水收集" }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1/versions", { method: "DELETE" }));
  });
  it("restores an archived course", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, status: "ARCHIVED" }] }) });
    render(<TeacherTemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));
    fireEvent.click(await screen.findByRole("button", { name: "恢复 雨水收集" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "restore" }) })));
  });
  it("requires confirmation before deleting an archived course", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, status: "ARCHIVED" }] }) });
    render(<TeacherTemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));
    fireEvent.click(await screen.findByRole("button", { name: "删除 雨水收集" }));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/platform/templates/template-1")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1", { method: "DELETE" }));
  });
});
