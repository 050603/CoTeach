import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Page from "./page";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }), useParams: () => ({ offeringId: "course-1" }), usePathname: () => "/teacher/classes/course-1" }));
const offering = { id: "course-1", name: "设计思维", status: "open", chapters: [{ id: "chapter-1", title: "发现问题", isOpen: true, version: 2, activities: [] }] };
let fetcher: ReturnType<typeof vi.fn>;
beforeEach(() => {
  push.mockReset();
  window.history.replaceState({}, "", "/teacher/classes/course-1");
  fetcher = vi.fn(async (url: string, options?: RequestInit) => {
    if (
      url === "/api/platform/offerings/course-1/cover"
      && (options?.method === "POST" || options?.method === "PUT")
    ) {
      return new Response(JSON.stringify({
        offering: {
          ...offering,
          version: 2,
          coverImageUrl: options.method === "POST"
            ? "/api/openmaic/classroom-media/offering-course-1/media/redrawn.webp"
            : "/api/openmaic/classroom-media/offering-course-1/media/uploaded.webp",
        },
      }));
    }
    if (options?.method) return new Response(JSON.stringify({ success: true }));
    return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [offering] }));
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("课程章节管理", () => {
  it("renders chapters as one continuous directory instead of nested cards", async () => {
    const { container } = render(<Page />);
    await screen.findByRole("heading", { name: "设计思维" });
    const tabs = container.querySelector(".pbl-teacher-course-tabs");
    expect(container.querySelectorAll(".pbl-teacher-chapter-list")).toHaveLength(1);
    expect(container.querySelectorAll(".pbl-teacher-chapter")).toHaveLength(1);
    expect(container.querySelector(".pbl-chapter-card")).toBeNull();
    expect(container.querySelector(".pbl-teacher-chapter-toolbar")).toBeNull();
    expect(tabs).toContainElement(screen.getByRole("button", { name: "添加章节" }));
    expect(screen.queryByText("在章节中添加学习内容；锁定后，学生仍可查看学习路径。")).toBeNull();
    expect(screen.queryByText("以章节组织学习，将课堂与任务串成完整的课程。")).toBeNull();
  });
  it("locks a chapter in its directory with optimistic version protection", async () => {
    render(<Page />);
    const access = await screen.findByRole("button", { name: "锁定章节" });
    const label = access.querySelector(".pbl-access-label");
    expect(access).not.toHaveClass("is-expanded");
    expect(access).toHaveTextContent("已解锁");
    expect(label).toHaveAttribute("aria-hidden", "true");
    expect(screen.getAllByText("已解锁")).toHaveLength(1);
    fireEvent.click(access);
    expect(access).toHaveClass("is-expanded", "is-locked");
    expect(label).toHaveTextContent("已锁定");
    expect(label).toHaveAttribute("aria-hidden", "false");
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/chapters/chapter-1", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ isOpen: false, version: 2 }) })));
    expect(await screen.findByText("章节及其内容已锁定")).toBeTruthy();
  });
  it("toggles a resource from a compact lock icon and collapses its status after two seconds", async () => {
    let currentOffering = {
      ...offering,
      chapters: [{
        ...offering.chapters[0],
        isOpen: false,
        activities: [{ id: "resource-1", title: "社区观察方法", type: "Resource", isOpen: false, version: 4 }],
      }],
    };
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/platform/activities/resource-1/manage" && options?.method === "PATCH") {
        currentOffering = {
          ...currentOffering,
          chapters: [{
            ...currentOffering.chapters[0],
            isOpen: true,
            activities: [{ ...currentOffering.chapters[0].activities[0], isOpen: true, version: 5 }],
          }],
        };
        return new Response(JSON.stringify({ success: true }));
      }
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [currentOffering] }));
    });
    render(<Page />);
    const access = await screen.findByRole("button", { name: "解锁内容" });
    const label = access.querySelector(".pbl-access-label");
    expect(access).not.toHaveClass("is-expanded");
    expect(label).toHaveAttribute("aria-hidden", "true");

    const nativeSetTimeout = globalThis.setTimeout;
    let collapse: (() => void) | undefined;
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: Parameters<typeof setTimeout>[0], delay?: number) => {
      if (delay === 2000 && typeof handler === "function") {
        collapse = handler;
        return -1 as unknown as ReturnType<typeof setTimeout>;
      }
      return nativeSetTimeout(handler, delay);
    }) as typeof setTimeout);

    fireEvent.click(access);
    expect(access).toHaveClass("is-expanded", "is-open");
    expect(label).toHaveTextContent("已解锁");
    expect(label).toHaveAttribute("aria-hidden", "false");
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/resource-1/manage", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ isOpen: true, version: 4 }),
    })));
    await waitFor(() => expect(collapse).toBeTypeOf("function"));
    expect(screen.getByRole("button", { name: "锁定章节" })).toBeInTheDocument();
    expect(screen.queryByText("解锁内容")).not.toBeInTheDocument();

    act(() => collapse?.());
    expect(access).not.toHaveClass("is-expanded");
    expect(label).toHaveAttribute("aria-hidden", "true");
    timeoutSpy.mockRestore();
  });
  it("opens a resource editor from its title and main row area", async () => {
    fetcher.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url === "/api/platform/templates"
        ? { templates: [] }
        : { offerings: [{ ...offering, chapters: [{ ...offering.chapters[0], activities: [{ id: "resource-1", title: "社区观察方法", type: "Resource", isOpen: true, version: 4 }] }] }] },
    )));
    render(<Page />);
    const title = await screen.findByText("社区观察方法");
    const mainArea = screen.getByRole("button", { name: "打开“社区观察方法”：编辑内容" });
    expect(mainArea).toContainElement(title);

    fireEvent.click(title);

    expect(await screen.findByRole("heading", { name: "编辑学习内容" })).toBeInTheDocument();
  });
  it("creates a questionnaire within the chosen chapter with actual questions", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));
    fireEvent.change(screen.getByLabelText("内容类型"), { target: { value: "Form" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "学习前调查" } });
    fireEvent.click(screen.getByRole("button", { name: "单选题" }));
    fireEvent.change(screen.getByLabelText("第 1 题题目内容"), { target: { value: "你最关注什么问题？" } });
    fireEvent.change(screen.getByLabelText("第 1 题选项 1"), { target: { value: "校园环境" } });
    fireEvent.change(screen.getByLabelText("第 1 题选项 2"), { target: { value: "其他" } });
    fireEvent.click(screen.getByRole("button", { name: "第 1 题选项 2 要求补充填写" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "添加学习内容" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "添加题目" }));
    fireEvent.change(screen.getByLabelText("第 2 题题目内容"), { target: { value: "你有哪些相关经验？" } });
    fireEvent.click(screen.getByRole("button", { name: "添加到章节" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/chapters/chapter-1/activities", expect.objectContaining({ method: "POST" })));
    const request = fetcher.mock.calls.find(([url, options]) => url === "/api/platform/offerings/course-1/chapters/chapter-1/activities" && options?.method === "POST");
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body.config.questions).toEqual([
      expect.objectContaining({ title: "你最关注什么问题？", type: "single-choice", required: true, options: [expect.objectContaining({ label: "校园环境" }), expect.objectContaining({ label: "其他", allowTextInput: true })] }),
      expect.objectContaining({ title: "你有哪些相关经验？", type: "short-text", required: true, options: [] }),
    ]);
  });
  it("offers questionnaire CSV export from the resource more menu", async () => {
    fetcher.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url === "/api/platform/templates"
        ? { templates: [] }
        : { offerings: [{ ...offering, chapters: [{ ...offering.chapters[0], activities: [{ id: "survey-1", title: "课堂反馈", type: "Form", isOpen: true, version: 1 }] }] }] },
    )));
    render(<Page />);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "课堂反馈更多操作" }), { button: 0, ctrlKey: false });
    const exportItem = await screen.findByRole("menuitem", { name: "导出问卷数据（CSV）" });
    expect(exportItem).toHaveAttribute("href", "/api/platform/activities/survey-1/survey-export");
  });
  it("deletes an existing resource from the chapter directory after confirmation", async () => {
    let currentOffering = {
      ...offering,
      chapters: [{
        ...offering.chapters[0],
        activities: [{ id: "resource-1", title: "社区观察方法", type: "Resource", isOpen: true, version: 4 }],
      }],
    };
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/platform/activities/resource-1" && options?.method === "DELETE") {
        currentOffering = {
          ...currentOffering,
          chapters: [{ ...currentOffering.chapters[0], activities: [] }],
        };
        return new Response(JSON.stringify({ activity: { id: "resource-1", archivedAt: new Date().toISOString() } }));
      }
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [currentOffering] }));
    });
    render(<Page />);

    fireEvent.pointerDown(await screen.findByRole("button", { name: "社区观察方法更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "删除内容" }));

    expect(screen.getByRole("alertdialog")).toHaveTextContent("删除“社区观察方法”？");
    expect(screen.getByRole("alertdialog")).toHaveTextContent("已有课堂、提交及学习记录会继续保留");
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/platform/activities/resource-1",
      expect.objectContaining({ method: "DELETE" }),
    ));
    expect(await screen.findByText("资料已从章节目录删除")).toBeInTheDocument();
    expect(screen.queryByText("社区观察方法")).toBeNull();
  });
  it("keeps the editor open and explains a failed activity save", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));
    fireEvent.change(screen.getByLabelText("内容类型"), { target: { value: "Assignment" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "调研报告" } });
    fetcher.mockImplementationOnce(async () => new Response(JSON.stringify({ message: "课程已被其他教师更新" }), { status: 409 }));
    fireEvent.click(screen.getByRole("button", { name: "添加到章节" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("课程已被其他教师更新");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("does not offer archived courses when adding classroom content", async () => {
    fetcher.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url === "/api/platform/templates"
        ? { templates: [{ id: "archived", title: "已归档教案", status: "ARCHIVED", versions: [{ id: "version", version: 1, status: "published" }] }] }
        : { offerings: [offering] },
    )));
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));
    expect(screen.queryByRole("option", { name: /已归档教案/ })).toBeNull();
    expect(screen.getByText("课程库暂无可用教案")).toBeInTheDocument();
  });
  it("distinguishes same-name courses in the classroom selector", async () => {
    fetcher.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url === "/api/platform/templates"
        ? { templates: [
          { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "同名课程", status: "ACTIVE", createdAt: "2026-09-20T01:02:03.000Z", versions: [{ id: "version-a", version: 1, status: "published" }] },
          { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", title: "同名课程", status: "ACTIVE", createdAt: "2026-09-21T01:02:03.000Z", versions: [{ id: "version-b", version: 1, status: "published" }] },
        ] }
        : { offerings: [offering] },
    )));
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));

    expect(screen.getByRole("option", { name: /同名课程 · 编号 AAAAAAAA · 首次生成 .+ · v1/ })).toHaveValue("version-a");
    expect(screen.getByRole("option", { name: /同名课程 · 编号 BBBBBBBB · 首次生成 .+ · v1/ })).toHaveValue("version-b");
  });
  it("keeps the exact course version selected before choosing a teaching class", async () => {
    window.history.replaceState({}, "", "/teacher/classes/course-1?templateVersionId=new-version");
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) return new Response(JSON.stringify({ activity: { id: "activity" } }), { status: 201 });
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [
        { id: "old-template", title: "旧课程", status: "ACTIVE", versions: [{ id: "old-version", version: 1, status: "published" }] },
        { id: "new-template", title: "本次选择的课程", status: "ACTIVE", versions: [{ id: "new-version", version: 3, status: "published" }] },
      ] } : { offerings: [offering] }));
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));

    expect(screen.getByLabelText(/课程库教案/)).toHaveValue("new-version");
    expect(screen.getByLabelText("标题")).toHaveValue("本次选择的课程");
    fireEvent.click(screen.getByRole("button", { name: "添加到章节" }));

    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/platform/offerings/course-1/chapters/chapter-1/activities",
      expect.objectContaining({ method: "POST", body: expect.stringContaining('"templateVersionId":"new-version"') }),
    ));
  });
  it("uploads a PDF and saves it as a file reference", async () => {
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/uploads") return new Response(JSON.stringify({ id: "8f31b270-b23d-4ec1-bd2b-8543210bcf88", url: "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88", fileName: "观察方法.pdf", size: "1.2 MB" }), { status: 201 });
      if (options?.method) return new Response(JSON.stringify({ activity: { id: "resource" } }), { status: 201 });
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [offering] }));
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "添加学习内容" }));
    fireEvent.change(screen.getByLabelText("内容类型"), { target: { value: "Resource" } });
    fireEvent.change(screen.getByLabelText("标题"), { target: { value: "社区观察方法" } });
    fireEvent.click(screen.getByRole("button", { name: "PDF 文件" }));
    fireEvent.change(screen.getByLabelText("上传 PDF 文档"), { target: { files: [new File(["%PDF-1.7"], "观察方法.pdf", { type: "application/pdf" })] } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/uploads", expect.objectContaining({ method: "POST", body: expect.any(FormData) })));
    const activityRequest = fetcher.mock.calls.find(([url]) => url === "/api/platform/offerings/course-1/chapters/chapter-1/activities");
    const body = JSON.parse(String(activityRequest?.[1]?.body));
    expect(body.config).toMatchObject({ resourceKind: "file", fileId: "8f31b270-b23d-4ec1-bd2b-8543210bcf88", fileName: "观察方法.pdf", url: "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88" });
  });
  it("manages course-level links and PDF files from course settings", async () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (array: Uint8Array) => {
        array.fill(7);
        return array;
      },
    });
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/uploads") return new Response(JSON.stringify({ id: "8f31b270-b23d-4ec1-bd2b-8543210bcf88", url: "/api/uploads/8f31b270-b23d-4ec1-bd2b-8543210bcf88" }), { status: 201 });
      if (options?.method) return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [offering] }));
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: /课程设置/ }));
    fireEvent.click(screen.getByRole("button", { name: "添加链接" }));
    fireEvent.change(screen.getByLabelText("链接标题"), { target: { value: "延伸阅读" } });
    fireEvent.change(screen.getByLabelText("参考资料链接"), { target: { value: "https://example.test/reading" } });
    fireEvent.change(screen.getByLabelText("上传课程参考资料 PDF"), { target: { files: [new File(["%PDF-1.7"], "课程手册.pdf", { type: "application/pdf" })] } });
    fireEvent.submit(screen.getByRole("dialog").querySelector("form")!);
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/uploads", expect.objectContaining({ method: "POST", body: expect.any(FormData) })));
    const settingsRequest = fetcher.mock.calls.find(([url, options]) => url === "/api/platform/offerings/course-1" && options?.method === "PATCH");
    expect(JSON.parse(String(settingsRequest?.[1]?.body))).toMatchObject({ referenceLinks: [{ title: "延伸阅读", url: "https://example.test/reading" }] });
  });
  it("generates the course cover from the course homepage", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "课程主页" }));
    fireEvent.click(screen.getByRole("button", { name: "AI 生成" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith("/api/platform/offerings/course-1/cover", expect.objectContaining({ method: "POST" })));
    expect(await screen.findByText("课程封面已生成")).toBeInTheDocument();
  });
  it("shows the newly returned cover immediately instead of reloading a stale URL", async () => {
    const oldCover = "/api/openmaic/classroom-media/offering-course-1/media/old-cover.webp";
    const newCover = "/api/openmaic/classroom-media/offering-course-1/media/new-cover-unique.webp";
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === "/api/platform/offerings/course-1/cover" && options?.method === "POST") {
        return new Response(JSON.stringify({
          offering: { ...offering, version: 5, coverImageUrl: newCover },
        }));
      }
      return new Response(JSON.stringify(
        url === "/api/platform/templates"
          ? { templates: [] }
          : { offerings: [{ ...offering, version: 4, coverImageUrl: oldCover }] },
      ));
    });

    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "课程主页" }));
    expect(screen.getByRole("img", { name: "设计思维课程封面" })).toHaveProperty("src", new URL(oldCover, window.location.href).href);
    fireEvent.click(screen.getByRole("button", { name: "AI 重绘" }));

    await waitFor(() => expect(
      screen.getByRole("img", { name: "设计思维课程封面" }),
    ).toHaveProperty("src", new URL(newCover, window.location.href).href));
    expect(await screen.findByText("课程封面已重新生成")).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/platform/offerings")).toHaveLength(1);
  });
  it("uploads a teacher-selected course cover from the course homepage", async () => {
    render(<Page />);
    fireEvent.click(await screen.findByRole("tab", { name: "课程主页" }));
    const file = new File(["image"], "cover.webp", { type: "image/webp" });
    fireEvent.change(screen.getByLabelText("选择课程封面图片"), { target: { files: [file] } });
    await waitFor(() => expect(fetcher).toHaveBeenCalledWith(
      "/api/platform/offerings/course-1/cover",
      expect.objectContaining({ method: "PUT", body: expect.any(FormData) }),
    ));
    expect(await screen.findByText("课程封面已上传")).toBeInTheDocument();
  });
  it("moves chapter name editing into the chapter more menu", async () => {
    render(<Page />);
    fireEvent.pointerDown(await screen.findByRole("button", { name: "发现问题更多操作" }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("menuitem", { name: "编辑章节名称" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByLabelText("章节名称")).toHaveValue("发现问题");
  });
  it("shows the invitation code in a wide copy dialog with success feedback", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [{ ...offering, invitation: { code: "A7B9C2" } }] }));
    });
    render(<Page />);
    const invitation = await screen.findByRole("button", { name: /学生邀请码/ });
    expect(screen.queryByDisplayValue("A7B9C2")).toBeNull();
    fireEvent.click(invitation);
    expect(screen.getByRole("dialog")).toHaveClass("pbl-invitation-dialog");
    expect(screen.getByRole("img", { name: "CoTeach" })).toBeInTheDocument();
    expect(screen.getByLabelText("学生端访问地址")).toHaveTextContent("coteach.cn");
    expect(document.querySelectorAll(".pbl-invitation-connector")).toHaveLength(2);
    expect(screen.getByLabelText("加入课程步骤")).toHaveTextContent(/打开电脑浏览器.*注册 \/ 登录.*输入课程邀请码/);
    expect(screen.getByLabelText("学生邀请码")).toHaveTextContent("A7B 9C2");
    fireEvent.click(screen.getByRole("button", { name: "复制邀请码" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("A7B9C2"));
    expect(await screen.findByText("邀请码已复制")).toBeInTheDocument();
  });
  it("copies the invitation code through the plain-HTTP fallback", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const execCommand = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) return new Response(JSON.stringify({ success: true }));
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [] } : { offerings: [{ ...offering, invitation: { code: "A7B9C2" } }] }));
    });
    render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: /学生邀请码/ }));
    fireEvent.click(screen.getByRole("button", { name: "复制邀请码" }));
    await waitFor(() => expect(execCommand).toHaveBeenCalledWith("copy"));
    expect(await screen.findByText("邀请码已复制")).toBeInTheDocument();
  });
});


describe("课堂主入口", () => {
  function classrooms(status?: string, published = true) {
    fetcher.mockImplementation(async (url: string, options?: RequestInit) => {
      if (options?.method) return new Response(JSON.stringify({ instance: { id: "new-run", status: "scheduled" } }));
      return new Response(JSON.stringify(url === "/api/platform/templates" ? { templates: [{ id: "template", title: "课堂教案", status: "ACTIVE", versions: [{ id: "version", version: 1, status: published ? "published" : "draft" }] }] } : { offerings: [{ ...offering, chapters: [{ ...offering.chapters[0], activities: [{ id: "activity", title: "项目课堂", type: "Classroom", isOpen: true, templateId: "template", instances: status ? [{ id: "run", status }] : [] }] }] }] }));
    });
  }
  it.each([["scheduled", "进入课堂", "/teacher/teach/run/setup"], ["teaching", "继续授课", "/teacher/teach/run/setup?enter=1"], ["finished", "查看课堂记录", "/teacher/classrooms/run"]])("routes %s with one teaching entry", async (status, label, href) => {
    classrooms(status); render(<Page />);
    const entry = await screen.findByRole("link", { name: label });
    const mainArea = screen.getByRole("link", { name: `打开“项目课堂”：${label}` });
    expect(entry).toHaveAttribute("href", href);
    expect(mainArea).toHaveAttribute("href", href);
    expect(mainArea).toContainElement(screen.getByText("项目课堂"));
    expect(entry).toHaveClass("pbl-row-secondary-action");
    expect(entry.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(screen.queryByRole("button", { name: "开始课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "结束课堂" })).toBeNull();
    expect(screen.queryByRole("button", { name: "配置" })).toBeNull();
  });
  it("keeps classroom and dashboard actions icon-first with the same control structure", async () => {
    fetcher.mockImplementation(async (url: string) => new Response(JSON.stringify(
      url === "/api/platform/templates"
        ? { templates: [{ id: "template", title: "课堂教案", status: "ACTIVE", versions: [{ id: "version", version: 1, status: "published" }] }] }
        : { offerings: [{ ...offering, chapters: [{ ...offering.chapters[0], activities: [
          { id: "activity", title: "项目课堂", type: "Classroom", isOpen: true, templateId: "template", instances: [{ id: "run", status: "teaching" }] },
          { id: "survey", title: "课堂反馈", type: "Form", isOpen: true, instances: [] },
        ] }] }] },
    )));
    render(<Page />);
    const classroom = await screen.findByRole("link", { name: "继续授课" });
    const dashboard = screen.getByRole("link", { name: "数据看板" });
    expect(classroom).toHaveClass("pbl-row-secondary-action");
    expect(dashboard).toHaveClass("pbl-row-secondary-action");
    expect(classroom.firstElementChild?.tagName.toLowerCase()).toBe("svg");
    expect(dashboard.firstElementChild?.tagName.toLowerCase()).toBe("svg");
  });
  it("creates a scheduled run then opens setup without a start request", async () => {
    classrooms(); render(<Page />);
    fireEvent.click(await screen.findByRole("button", { name: "进入课堂" }));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/teacher/teach/new-run/setup"));
    expect(fetcher).toHaveBeenCalledWith("/api/platform/activities/activity/instance", expect.objectContaining({ method: "POST", body: JSON.stringify({ templateVersionId: "version" }) }));
    expect(fetcher.mock.calls.filter(([, options]) => options?.method)).toHaveLength(1);
  });
  it("keeps creation failures reviewable and does not navigate or start teaching", async () => {
    classrooms(); render(<Page />);
    const enter = await screen.findByRole("button", { name: "进入课堂" });
    fetcher.mockResolvedValueOnce(new Response(JSON.stringify({ message: "教案已更新，请重新选择" }), { status: 409 }));
    fireEvent.click(enter);
    expect(await screen.findByRole("alert")).toHaveTextContent("教案已更新，请重新选择");
    expect(push).not.toHaveBeenCalled();
    expect(enter).toBeEnabled();
  });
  it("explains an unpublished lesson instead of creating an unusable run", async () => {
    classrooms(undefined, false); render(<Page />);
    expect(await screen.findByRole("link", { name: "前往课程库" })).toHaveAttribute("href", "/teacher/templates");
    expect(screen.queryByRole("button", { name: "进入课堂" })).toBeNull();
  });
});
