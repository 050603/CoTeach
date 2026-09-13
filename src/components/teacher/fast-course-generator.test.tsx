import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Course } from "@/lib/session/types";
import { FastCourseGenerator } from "./fast-course-generator";
import { emptyResourcePackageDraft } from "@/lib/resource-package/types";

function confirmedPackageJob() {
  const draft = emptyResourcePackageDraft();
  return { id: "package-job", status: "ready", progress: 100, message: "已确认", package: {
    schemaVersion: 1, id: "package-1", revision: 3, confirmedAt: "2026-09-12T00:00:00Z",
    source: { id: "upload-package", fileName: "教学资源.zip", url: "/api/uploads/upload-package" }, documents: {},
    draft: { ...draft, courseName: "机器学习", grade: "高中", drivingQuestion: "如何设计可靠的分类器？", learningObjectives: ["验证模型"], expectedOutcome: "分类模型", knowledgePoints: [{ name: "分类", description: "", subPoints: [] }], totalMinutes: 135, stages: draft.stages.map((stage, index) => ({ ...stage, durationMin: [15, 30, 60, 20, 10][index] })) },
  } };
}

const push = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

describe("FastCourseGenerator knowledge references", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uploads an optional private reference and includes its id in the generation request", async () => {
    const requests: Array<{ url: string; method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      requests.push({
        url,
        method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.endsWith("/resource-package")) return Response.json({ job: confirmedPackageJob() });
      if (url === "/api/uploads" && method === "POST") {
        return Response.json({
          id: "11111111-1111-4111-8111-111111111111",
          fileName: "机器学习基础.md",
          fileType: "MD",
          size: "1.2 KB",
          purpose: "generation-reference",
        }, { status: 201 });
      }
      if (url.endsWith("/design-generation") && method === "POST") {
        return Response.json({ backgroundEnabled: true, job: null }, { status: 202 });
      }
      if (url.endsWith("/design-generation")) {
        return Response.json({ backgroundEnabled: true, job: null });
      }
      throw new Error(`Unexpected request: ${method} ${url}`);
    }));

    render(
      <FastCourseGenerator
        course={{ id: "course-1" } as Course}
        onOpenDetailed={vi.fn()}
        simplified
      />,
    );

    await waitFor(() => expect(requests.some((request) => request.method === "GET")).toBe(true));
    expect(screen.getByText("AI inside practice.")).toBeTruthy();
    expect(screen.queryByText("生成 AI 授知内容")).toBeNull();
    expect(screen.queryByText(/系统只准备第二阶段/)).toBeNull();
    expect(screen.queryByText("普通模式")).toBeNull();
    expect(screen.getByRole("group", { name: "生成内容选项" })).toBeTruthy();
    expect(screen.getByLabelText(/图片：/).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByLabelText(/语音：/).getAttribute("aria-pressed")).toBe("true");
    const videoToggle = screen.getByLabelText(/视频：/);
    expect(videoToggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(videoToggle);
    expect(videoToggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "开启深度交互模式" }).getAttribute("aria-pressed")).toBe("false");
    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toContain("支持 PDF、Word（DOCX）、PPT（PPTX）、TXT 和 Markdown");
    expect(tooltip.className).toContain("opacity-0");
    expect(tooltip.className).toContain("invisible");

    fireEvent.change(screen.getByLabelText("上传知识资料"), {
      target: { files: [new File(["训练数据与验证集"], "机器学习基础.md", { type: "text/markdown" })] },
    });

    expect(await screen.findByText("机器学习基础.md")).toBeTruthy();
    const upload = requests.find((request) => request.url === "/api/uploads" && request.method === "POST");
    expect(upload).toBeTruthy();

    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), {
      target: { value: "为高中生设计机器学习入门课" },
    });
    fireEvent.click(screen.getByRole("button", { name: "开始生成课程" }));

    await waitFor(() => {
      const generationRequest = requests.find((request) => request.url.endsWith("/design-generation") && request.method === "POST");
      expect(JSON.parse(generationRequest?.body ?? "{}")).toMatchObject({
        teacherBrief: "为高中生设计机器学习入门课",
        supplementalAnswers: { brief: "为高中生设计机器学习入门课" },
        resourcePackageId: "package-1",
        resourcePackageRevision: 3,
        generationMode: "standard",
        referenceIds: ["11111111-1111-4111-8111-111111111111"],
        options: {
          enableImageGeneration: true,
          enableTTS: true,
          enableVideoGeneration: true,
        },
      });
    });
  });

  it("places one deep-interaction toggle next to send and submits the lit state", async () => {
    const requests: Array<{ method: string; body?: string }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      requests.push({ method, body: typeof init?.body === "string" ? init.body : undefined });
      if (String(input).endsWith("/resource-package")) return Response.json({ job: confirmedPackageJob() });
      return Response.json({ backgroundEnabled: true, job: null }, { status: method === "POST" ? 202 : 200 });
    }));

    render(<FastCourseGenerator course={{ id: "course-2" } as Course} onOpenDetailed={vi.fn()} simplified />);
    await waitFor(() => expect(requests.some((request) => request.method === "GET")).toBe(true));

    const deepToggle = screen.getByRole("button", { name: "开启深度交互模式" });
    const send = screen.getByRole("button", { name: "开始生成课程" });
    expect(deepToggle.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(deepToggle);
    expect(screen.getByRole("button", { name: "关闭深度交互，使用普通模式" }).getAttribute("aria-pressed")).toBe("true");

    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "设计一节交互式 AI 课程" } });
    fireEvent.click(send);
    await waitFor(() => {
      const request = requests.find((item) => item.method === "POST");
      expect(JSON.parse(request?.body ?? "{}")).toMatchObject({ generationMode: "deep-interaction" });
    });
  });

  it("requires a confirmed package and accepts an empty supplemental brief", async () => {
    let confirmed = false;
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/resource-package")) {
        const job = confirmedPackageJob();
        if (init?.method === "PATCH") confirmed = true;
        return Response.json({ job: { ...job, package: { ...job.package, confirmedAt: confirmed ? job.package.confirmedAt : undefined } } });
      }
      if (init?.method === "POST") post(JSON.parse(String(init.body)));
      return Response.json({ backgroundEnabled: true, job: null });
    }));
    render(<FastCourseGenerator course={{ id: "course-3" } as Course} onOpenDetailed={vi.fn()} simplified />);
    const send = screen.getByRole("button", { name: "开始生成课程" });
    expect((send as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "确认并保存教学要求" }));
    await waitFor(() => expect((send as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ teacherBrief: "", supplementalAnswers: { brief: "" }, resourcePackageId: "package-1", resourcePackageRevision: 3 })));
    fireEvent.change(screen.getByLabelText("项目学习驱动问题（必填）"), { target: { value: "如何比较两种模型？" } });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it("retries an unchanged legacy failed request, but requires a package after editing", async () => {
    const post = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/resource-package")) return Response.json({ job: null });
      if (init?.method === "POST") { post(JSON.parse(String(init.body))); return Response.json({ backgroundEnabled: true, job: null }); }
      return Response.json({ backgroundEnabled: true, job: { id: "legacy", status: "failed", progress: 20, trace: [], message: "可继续", requestPreview: { teacherBrief: "旧的课程要求", generationMode: "standard", options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false }, referenceMaterials: [] } } });
    }));
    render(<FastCourseGenerator course={{ id: "legacy-course" } as Course} onOpenDetailed={vi.fn()} simplified />);
    const retry = await screen.findByRole("button", { name: "从已保存内容继续生成" });
    await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "新的课程要求" } });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("补充课程生成要求（可选）"), { target: { value: "旧的课程要求" } });
    fireEvent.click(retry);
    await waitFor(() => expect(post).toHaveBeenCalledWith({ teacherBrief: "旧的课程要求", generationMode: "standard", options: { enableImageGeneration: true, enableTTS: true, enableVideoGeneration: false }, referenceIds: [] }));
  });
});
