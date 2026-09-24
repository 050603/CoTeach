import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPblTemplateCourse, encodePblTemplate } from "@/lib/platform/pbl-template";
import TeacherTemplatesPage from "./page";
const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, usePathname: () => "/teacher/templates" }));
const content = { schemaVersion: 1, title: "雨水收集", subject: "科学", grade: "七年级", durationMinutes: 45, summary: "设计校园雨水收集装置。", learningObjectives: ["计算集水面积"], outline: [{ title: "调查与设计", durationMinutes: 45, description: "测量集水区并提出方案。" }], resources: [] };
const template = { id: "template-1", title: content.title, description: content.summary, status: "ACTIVE", createdAt: "2026-09-20T01:02:03.000Z", updatedAt: "2026-09-21T04:05:06.000Z", versions: [{ id: "version-1", version: 1, status: "PUBLISHED", snapshot: content }] };
const fetchMock = vi.fn();

function completedPblSnapshot(id: string, input: { name: string; coverImageUrl?: string }) {
  const course = createPblTemplateCourse(id, input);
  course.content.classroomGenerationRun = {
    scope: "full-course",
    status: "completed",
    generatedOutlineIds: ["page-1"],
    fullOutlineCount: 1,
  };
  return encodePblTemplate(course);
}

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
    await screen.findByText("课程库为空");
    fireEvent.click(screen.getByRole("button", { name: "新建课程" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/pbl", expect.objectContaining({ method: "POST", body: "{}" })));
    expect(navigation.push).toHaveBeenCalledWith("/teacher/prepare/quick-course/verify");
    expect(screen.queryByRole("link", { name: "完整五阶段备课" })).toBeNull();
  });
  it("opens generated PBL courses and continue-preparation actions in the publish center", async () => {
    const snapshot = completedPblSnapshot("pbl", { name: "五阶段项目" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, id: "pbl", title: "五阶段项目", versions: [{ version: 1, status: "DRAFT", snapshot }] }] }) });
    render(<TeacherTemplatesPage />);
    expect((await screen.findByRole("link", { name: /打开课程 五阶段项目/ })).getAttribute("href")).toBe("/teacher/prepare/pbl/preview");
    expect(screen.getByRole("link", { name: "查看并发布" }).getAttribute("href")).toBe("/teacher/prepare/pbl/preview");
    expect(screen.getByText("已完成未发布")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "完整五阶段备课" })).toBeNull();
  });
  it("returns an incomplete PBL course to the generation card instead of opening partial details", async () => {
    const snapshot = encodePblTemplate(createPblTemplateCourse("pbl", { name: "尚未完成的项目" }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{
      ...template,
      id: "pbl",
      title: "尚未完成的项目",
      versions: [{ version: 1, status: "DRAFT", snapshot }],
    }] }) });
    render(<TeacherTemplatesPage />);

    expect((await screen.findByRole("link", { name: /打开课程 尚未完成的项目/ })).getAttribute("href"))
      .toBe("/teacher/prepare/pbl/verify");
    expect(screen.getByRole("link", { name: "继续生成" }).getAttribute("href"))
      .toBe("/teacher/prepare/pbl/verify");
    expect(screen.getByText("未完成")).toBeTruthy();
  });
  it("returns generating courses to the generation workspace", async () => {
    const snapshot = encodePblTemplate(createPblTemplateCourse("pbl", { name: "生成中的项目" }));
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{
      ...template,
      id: "pbl",
      title: "生成中的项目",
      generationStatus: "running",
      versions: [{ version: 1, status: "DRAFT", snapshot }],
    }] }) });
    render(<TeacherTemplatesPage />);

    expect((await screen.findByRole("link", { name: /打开课程 生成中的项目/ })).getAttribute("href"))
      .toBe("/teacher/prepare/pbl/verify");
    expect(screen.getByRole("link", { name: "查看生成进度" }).getAttribute("href"))
      .toBe("/teacher/prepare/pbl/verify");
    expect(screen.getByText("生成中")).toBeTruthy();
  });
  it("marks a published course and opens its complete details", async () => {
    const snapshot = completedPblSnapshot("pbl", { name: "已发布的项目" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{
      ...template,
      id: "pbl",
      title: "已发布的项目",
      versions: [{ version: 3, status: "PUBLISHED", snapshot }],
    }] }) });
    render(<TeacherTemplatesPage />);

    expect((await screen.findByRole("link", { name: /打开课程 已发布的项目/ })).getAttribute("href"))
      .toBe("/teacher/prepare/pbl/preview");
    expect(screen.getByRole("link", { name: "查看课程" }).getAttribute("href"))
      .toBe("/teacher/prepare/pbl/preview");
    expect(screen.getByText("已发布")).toBeTruthy();
  });
  it("shows the latest generated classroom cover on its course-library card", async () => {
    const coverImageUrl = "/api/openmaic/classroom-media/template-cover-pbl/media/classroom-cover-v2.webp";
    const snapshot = completedPblSnapshot("pbl", {
      name: "人工智能教学法",
      coverImageUrl,
    });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{
      ...template,
      id: "pbl",
      title: "人工智能教学法",
      versions: [{ version: 2, snapshot }],
    }] }) });

    render(<TeacherTemplatesPage />);

    expect(await screen.findByRole("img", { name: "人工智能教学法课程封面" }))
      .toHaveProperty("src", new URL(coverImageUrl, window.location.href).href);
  });
  it("keeps same-name courses visibly distinct and routes each card by its own id", async () => {
    const snapshot = completedPblSnapshot("source", { name: "相同资源课" });
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [
      { ...template, id: "11111111-1111-4111-8111-111111111111", title: "相同资源课", createdAt: "2026-09-20T01:02:03.000Z", updatedAt: "2026-09-20T02:03:04.000Z", versions: [{ version: 1, status: "DRAFT", snapshot }] },
      { ...template, id: "22222222-2222-4222-8222-222222222222", title: "相同资源课", createdAt: "2026-09-21T01:02:03.000Z", updatedAt: "2026-09-22T02:03:04.000Z", versions: [{ version: 1, status: "DRAFT", snapshot }] },
    ] }) });

    const { container } = render(<TeacherTemplatesPage />);

    expect((await screen.findByRole("link", { name: /打开课程 相同资源课（课程编号 11111111）/ })).getAttribute("href"))
      .toBe("/teacher/prepare/11111111-1111-4111-8111-111111111111/preview");
    expect(screen.getByRole("link", { name: /打开课程 相同资源课（课程编号 22222222）/ }).getAttribute("href"))
      .toBe("/teacher/prepare/22222222-2222-4222-8222-222222222222/preview");
    expect(screen.getAllByText("首次生成时间")).toHaveLength(2);
    expect(screen.getAllByText("最近修改时间")).toHaveLength(2);
    expect(container.querySelectorAll('time[datetime="2026-09-20T01:02:03.000Z"]')).toHaveLength(1);
    expect(container.querySelectorAll('time[datetime="2026-09-22T02:03:04.000Z"]')).toHaveLength(1);
  });
  it("requires confirmation before archiving a reusable course", async () => {
    render(<TeacherTemplatesPage />); await screen.findByRole("heading", { name: "雨水收集" });
    fireEvent.click(screen.getByRole("button", { name: /归档 雨水收集/ }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认归档" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1/versions", { method: "DELETE" }));
  });
  it("restores an archived course", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, status: "ARCHIVED" }] }) });
    render(<TeacherTemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));
    fireEvent.click(await screen.findByRole("button", { name: /恢复 雨水收集/ }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "restore" }) })));
  });
  it("opens an archived PBL course for read-only review without restoring it", async () => {
    const snapshot = completedPblSnapshot("pbl", { name: "归档的项目课" });
    snapshot.design.summary = "研究校园雨水收集方案";
    snapshot.design.drivingQuestion = "怎样减少校园用水？";
    snapshot.design.learningObjectives = ["估算集水量"];
    snapshot.design.content._openmaicSceneOutlines = [{ id: "page-1", title: "认识雨水循环", audience: "student" }];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{
      ...template, id: "pbl", title: "归档的项目课", status: "ARCHIVED",
      versions: [{ version: 2, status: "PUBLISHED", snapshot }],
    }] }) });

    render(<TeacherTemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));
    fireEvent.click(await screen.findByRole("button", { name: /打开课程 归档的项目课/ }));

    expect(screen.getByText("怎样减少校园用水？")).toBeTruthy();
    expect(screen.getByText("估算集水量")).toBeTruthy();
    expect(screen.getByText("认识雨水循环")).toBeTruthy();
    expect(screen.getByText("已归档，仅供查看。恢复后可继续备课或安排到教学班。")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑课程内容" })).toBeNull();
    expect(screen.queryByRole("link", { name: /到教学班中安排/ })).toBeNull();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method && init.method !== "GET")).toBe(false);
  });
  it("keeps archived course-design details readable without offering edit or scheduling", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, status: "ARCHIVED" }] }) });
    render(<TeacherTemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));
    fireEvent.click(await screen.findByRole("button", { name: /打开课程 雨水收集/ }));

    expect(screen.getByText("计算集水面积")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑课程内容" })).toBeNull();
    expect(screen.queryByRole("link", { name: /到教学班中安排/ })).toBeNull();
  });
  it("requires confirmation before deleting an archived course", async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ templates: [{ ...template, status: "ARCHIVED" }] }) });
    render(<TeacherTemplatesPage />);
    fireEvent.click(await screen.findByRole("button", { name: "已归档" }));
    fireEvent.click(await screen.findByRole("button", { name: /删除 雨水收集/ }));
    expect(fetchMock.mock.calls.some(([url]) => url === "/api/platform/templates/template-1")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/platform/templates/template-1", { method: "DELETE" }));
  });
});
