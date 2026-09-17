import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourcePackageForm } from "./resource-package-form";
import { emptyResourcePackageDraft, type CourseResourcePackage, type ResourcePackageJobSnapshot } from "@/lib/resource-package/types";

function makePackage(): CourseResourcePackage {
  const draft = emptyResourcePackageDraft();
  return {
    schemaVersion: 1, id: "package-1", revision: 1,
    source: { id: "zip-1", fileName: "教学资源包.zip", url: "/api/uploads/zip-1" }, documents: {},
    draft: { ...draft, courseName: "人工智能教育", grade: "本科一年级", drivingQuestion: "如何设计适切的 AI 教学活动？", learningObjectives: ["比较教学方法"], expectedOutcome: "教学设计方案", lessonCount: 3, minutesPerLesson: 45, totalMinutes: 135,
      knowledgePoints: [{ name: "教学理论", description: "比较理论边界", subPoints: ["建构主义", "认知主义"] }],
      stages: draft.stages.map((stage, index) => ({ ...stage, durationMin: [15, 30, 60, 20, 10][index], requirements: "按任务要求学习" })),
    },
  };
}
function ready(pack = makePackage()): ResourcePackageJobSnapshot {
  return { id: "job-1", status: "ready", progress: 100, message: "解析完成", package: pack };
}

describe("ResourcePackageForm", () => {
  beforeEach(() => { window.sessionStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it("uploads a ZIP as a private resource package and displays parsed requirements", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      if (String(input) === "/api/uploads") return Response.json({ id: "zip-1" });
      return Response.json({ job: init?.method === "POST" ? ready() : null });
    }));
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={vi.fn()} />);
    await waitFor(() => expect((screen.getByLabelText("上传课堂资源包") as HTMLInputElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("上传课堂资源包"), { target: { files: [new File(["example"], "资源包.zip", { type: "application/zip" })] } });
    expect(await screen.findByDisplayValue("本科一年级")).toBeTruthy();
    expect((screen.getByLabelText("课程总分钟数（必填）") as HTMLInputElement).value).toBe("135");
    expect((screen.getByLabelText("知识讲授分钟数") as HTMLInputElement).value).toBe("30");
    const upload = requests.find((request) => request.url === "/api/uploads")?.init?.body as FormData;
    expect(upload.get("purpose")).toBe("course-resource-package");
    expect(upload.get("courseId")).toBe("course-1");
    const start = requests.find((request) => request.url.endsWith("/resource-package") && request.init?.method === "POST");
    expect(JSON.parse(String(start?.init?.body))).toEqual({ uploadId: "zip-1" });
  });

  it("rejects unsupported files and oversized ZIPs before upload", async () => {
    const fetchMock = vi.fn(async () => Response.json({ job: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={vi.fn()} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const input = screen.getByLabelText("上传课堂资源包");
    fireEvent.change(input, { target: { files: [new File(["text"], "教案.docx")] } });
    expect(screen.getByText("请上传 ZIP 格式的完整资源包。")).toBeTruthy();
    const large = new File(["x"], "超大.zip");
    Object.defineProperty(large, "size", { value: 50 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [large] } });
    expect(screen.getByText("资源包不能超过 50 MiB。")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks conflicting minutes and confirms the corrected full draft with revision", async () => {
    const pack = makePackage();
    pack.draft.stages[1].durationMin = 40;
    const confirm = vi.fn();
    const onConfirmed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        confirm(body);
        return Response.json({ job: ready({ ...pack, draft: body.draft, revision: 2, confirmedAt: "2026-09-12T01:00:00Z" }) });
      }
      return Response.json({ job: ready(pack) });
    }));
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={onConfirmed} />);
    const button = await screen.findByRole("button", { name: "确认并保存教学要求" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("五阶段时长之和必须等于课程总分钟数，请修正教案时间。")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("知识讲授分钟数"), { target: { value: "30" } });
    fireEvent.click(button);
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ action: "confirm", revision: 1, draft: expect.objectContaining({ totalMinutes: 135, stages: expect.arrayContaining([expect.objectContaining({ key: "ai-learning", durationMin: 30 })]) }) })));
    await waitFor(() => expect(onConfirmed).toHaveBeenLastCalledWith(expect.objectContaining({ id: "package-1", revision: 2, confirmedAt: expect.any(String) })));
  });

  it("shows handoff evidence and sends a revision-bound planning acknowledgement", async () => {
    const pack = makePackage();
    pack.handoff = { handoffFormatVersion: 1, projectId: "project-1", packageId: "handoff-1", presentationVersion: 1,
      documents: { knowledge: { handoffFormatVersion: 1, projectId: "project-1", packageId: "handoff-1", presentationVersion: 1, resourceType: "KNOWLEDGE", resourceVersion: 2 },
        lessonPlan: { handoffFormatVersion: 1, projectId: "project-1", packageId: "handoff-1", presentationVersion: 1, resourceType: "LESSON_PLAN", resourceVersion: 3 } } };
    pack.planningIssueVersion = "issues-v1";
    pack.planningIssues = [{ id: "duration-review", kind: "duration", severity: "warning", requiresAcknowledgement: true, summary: "时间描述不一致", detail: "阶段时间表为59分钟，正文描述为85分钟。", suggestion: "确认采用阶段时间表", evidence: [] },
      { id: "evidence-review", kind: "evidence", severity: "info", requiresAcknowledgement: false, summary: "证据状态为PARTIAL", detail: "部分内容待核对", suggestion: "保留提示", evidence: [] }];
    const mutation = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") { mutation(JSON.parse(String(init.body))); return Response.json({ job: ready({ ...pack, revision: 2, confirmedAt: new Date().toISOString() }) }); }
      return Response.json({ job: ready(pack) });
    }));
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={vi.fn()} />);
    expect(await screen.findByText(/格式 v1 · 项目 project-1/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "确认并保存教学要求" });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/我已核对上述规划问题/));
    fireEvent.click(confirm);
    await waitFor(() => expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ action: "confirm", acknowledgement: { issueVersion: "issues-v1", issueIds: ["duration-review"] } })));
  });

  it("restores unsaved edits without treating them as confirmed", async () => {
    const pack = { ...makePackage(), confirmedAt: "2026-09-12T00:00:00Z" };
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ job: ready(pack) })));
    const callback = vi.fn();
    const view = render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={callback} />);
    await screen.findByDisplayValue("本科一年级");
    fireEvent.change(screen.getByLabelText("教学对象 / 学段（必填）"), { target: { value: "本科二年级" } });
    expect(callback).toHaveBeenLastCalledWith(null);
    view.unmount();
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={callback} />);
    expect(await screen.findByDisplayValue("本科二年级")).toBeTruthy();
    expect(callback).toHaveBeenLastCalledWith(null);
    expect(screen.getByText("有修改待确认，草稿已保留")).toBeTruthy();
  });

  it("requires an explicit choice for ambiguous files and submits the selected paths", async () => {
    const retry = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") { retry(JSON.parse(String(init.body))); return Response.json({ job: ready() }); }
      return Response.json({ job: { id: "job-1", status: "needs_selection", progress: 20, message: "找到多份知识文档", candidates: { knowledge: ["文件夹/知识点一.md", "文件夹/知识点二.md"], lessonPlan: ["教案.md"], launchPresentation: ["项目启动.pptx"] } } });
    }));
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={vi.fn()} />);
    const button = await screen.findByRole("button", { name: "使用所选文件继续解析" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("知识点文档"), { target: { value: "文件夹/知识点二.md" } });
    fireEvent.click(button);
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ action: "retry", selections: { knowledge: "文件夹/知识点二.md", lessonPlan: "教案.md", launchPresentation: "项目启动.pptx" } }));
  });

  it("shows conversion errors with a retry while retaining the package identity", async () => {
    const retry = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "PATCH") { retry(JSON.parse(String(init.body))); return Response.json({ job: ready() }); }
      return Response.json({ job: { ...ready(), status: "failed", error: "启动 PPT 转换失败" } });
    }));
    const callback = vi.fn();
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={callback} />);
    expect(await screen.findByText("启动 PPT 转换失败")).toBeTruthy();
    expect(screen.getByText("教学资源包.zip")).toBeTruthy();
    expect(callback).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "重试解析与课件转换" }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ action: "retry", selections: {} }));
  });

  it("shows source conflicts without silently adapting and sends an explicit revision-bound authorization", async () => {
    const pack = makePackage(); pack.conflictVersion = "conflicts-v1"; pack.conflicts = [{ id: "groups", kind: "organization", summary: "资源包要求真人分组", reason: "系统使用个人与AI伙伴协作", suggestion: "全员提交，教师选取部分学生现场汇报", evidence: [{ documentRole: "launchPresentation", locator: "第4页", quote: "每组5名学生" }] }];
    const mutation = vi.fn(); const onConfirmed = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") { mutation(JSON.parse(String(init.body))); return Response.json({ job: { ...ready(pack), status: "queued" } }); }
      return Response.json({ job: { ...ready(pack), status: "blocked" } });
    }));
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={onConfirmed} />);
    expect(await screen.findByText("先处理课堂流程冲突")).toBeTruthy();
    expect(screen.getByRole("link", { name: "下载上游修改反馈" }).getAttribute("href")).toContain("download=feedback");
    expect(mutation).not.toHaveBeenCalled();
    expect(onConfirmed).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole("button", { name: "按系统流程适配后继续" }));
    await waitFor(() => expect(mutation).toHaveBeenCalledWith(expect.objectContaining({ action: "adapt", revision: 1, conflictVersion: "conflicts-v1", draft: expect.objectContaining({ totalMinutes: 135 }) })));
  });
  it("resumes a persisted running parse on refresh and prevents replacing its input", async () => {
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      reads += 1;
      return Response.json({ job: reads === 1 ? { id: "job-1", status: "running", progress: 55, message: "正在转换项目启动课件" } : ready() });
    }));
    render(<ResourcePackageForm courseId="course-1" disabled={false} onConfirmed={vi.fn()} />);
    expect(await screen.findByText("正在转换项目启动课件")).toBeTruthy();
    expect((screen.getByLabelText("上传课堂资源包") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("progressbar", { name: "资源包解析进度" }) as HTMLProgressElement).value).toBe(55);
    expect(await screen.findByDisplayValue("本科一年级", {}, { timeout: 3_000 })).toBeTruthy();
    expect((screen.getByLabelText("上传课堂资源包") as HTMLInputElement).disabled).toBe(false);
  });
});
