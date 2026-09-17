import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CourseDesignGenerationArtifact } from "@/lib/session/types";
import { QuickGenerationStage } from "./quick-generation-stage";
import { buildQuickClassroomArtifacts, type QuickClassroomGenerationSnapshot } from "@/lib/course-generation/quick-artifacts";

const motionPreference = vi.hoisted(() => ({ reduced: false }));
vi.mock("motion/react", async (importOriginal) => ({
  ...await importOriginal<typeof import("motion/react")>(),
  useReducedMotion: () => motionPreference.reduced,
}));

const outlineArtifact: CourseDesignGenerationArtifact = {
  id: "course-outline",
  kind: "pages",
  eyebrow: "主课脚本 · 页面与资源",
  title: "课程大纲",
  summary: "按课程阶段排列，可在卡片内滚动预览。",
  accent: "blue",
  items: [
    { label: "launch", value: "认识项目任务", meta: "教师资源 · 5 分钟" },
    { label: "ai-learning", value: "理解核心概念", meta: "学生页面 · 6 分钟" },
    { label: "ai-learning", value: "判断典型案例", meta: "互动页面 · 5 分钟" },
    { label: "proposal", value: "形成初步方案", meta: "学生页面 · 8 分钟" },
    { label: "make", value: "制作项目成果", meta: "学生页面 · 20 分钟" },
  ],
};

afterEach(() => {
  vi.useRealTimers();
  motionPreference.reduced = false;
});

describe("QuickGenerationStage", () => {
  it("lets the teacher preview completed pages before generation finishes", () => {
    const onPreviewGenerated = vi.fn();
    render(
      <QuickGenerationStage
        artifacts={[outlineArtifact]}
        backgroundEnabled
        brief="设计一节项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="正在制作课堂页面"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onPreviewGenerated={onPreviewGenerated}
        onReview={vi.fn()}
        paused={false}
        previewScenesCount={3}
        progress={72}
        remainingLabel="预计还需约 3 分钟"
        reviewAvailable={false}
        startedAt={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "预览已生成 3 页" }));
    expect(onPreviewGenerated).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "中断生成" })).toBeTruthy();
  });

  it("shows live concurrent page work as a detailed production card", () => {
    render(
      <QuickGenerationStage
        activeArtifactId="ai-learning-page-production"
        artifacts={[{
          id: "ai-learning-page-production",
          kind: "timeline",
          eyebrow: "课程生成 · 页面制作",
          title: "正在并行制作课堂页面",
          summary: "4 个课堂页面，将知识讲解、互动练习与节点检测编排成完整学习链路",
          accent: "blue",
          items: [
            { label: "知识讲解", value: "2 个页面" },
            { label: "互动练习", value: "1 个页面" },
            { label: "节点检测", value: "1 个页面" },
          ],
          visualization: {
            generationPlan: {
              scope: "ai-learning",
              totalScenes: 4,
              estimatedDuration: 960,
              completedScenes: 0,
              status: "running",
              phaseIndex: 1,
              message: "正在制作课堂页面",
              scenes: [
                { id: "1", title: "认识生成模型", type: "slide", typeLabel: "课件页面", estimatedDuration: 240 },
                { id: "2", title: "观察模型如何预测", type: "interactive", typeLabel: "互动页面", estimatedDuration: 300 },
                { id: "3", title: "检查核心概念", type: "quiz", typeLabel: "测验页面", estimatedDuration: 180 },
                { id: "4", title: "理解使用边界", type: "slide", typeLabel: "课件页面", estimatedDuration: 240 },
              ],
              assets: { images: true, videos: false, tts: true },
              activePages: [
                { index: 2, title: "观察模型如何预测", stage: "reviewed-content", startedAt: 1, executionMs: 12_000 },
                { index: 3, title: "检查核心概念", stage: "actions", startedAt: 2, executionMs: 8_000 },
                { index: 4, title: "理解使用边界", stage: "narration", startedAt: 3 },
              ],
            },
          },
        }]}
        backgroundEnabled
        brief="生成一节知识讲授课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="准备制作课堂页面"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={vi.fn()}
        paused={false}
        progress={64}
        remainingLabel="预计还需约 4 分钟"
        reviewAvailable={false}
        startedAt={null}
      />,
    );

    expect(screen.getByRole("heading", { name: "正在并行制作课堂页面" })).toBeTruthy();
    expect(screen.getByLabelText("当前并行页面任务")).toBeTruthy();
    expect(screen.getByLabelText("单页制作流程")).toBeTruthy();
    expect(screen.getByText("观察模型如何预测")).toBeTruthy();
    expect(screen.getByText("检查核心概念")).toBeTruthy();
    expect(screen.getByText("理解使用边界")).toBeTruthy();
    expect(screen.getByText("检查版式与知识覆盖")).toBeTruthy();
    expect(screen.getByText("生成讲稿与教学动作")).toBeTruthy();
    expect(screen.getByText("校验课堂口语")).toBeTruthy();
    expect(screen.getByText("预计授课 约 16 分钟")).toBeTruthy();
  });

  it("updates aggregate page progress and stops live effects during recovery or reduced motion", () => {
    const snapshot: QuickClassroomGenerationSnapshot = {
      status: "running", step: "generating_scenes", progress: 40,
      message: "正在制作课堂页面", scenesGenerated: 0, totalScenes: 4, events: [],
      activePages: [{ index: 1, title: "第一节课", stage: "actions", startedAt: 1 }],
      requestPreview: {
        sceneOutlines: [{ id: "p1", title: "第一节课", type: "slide", estimatedDuration: 180 }],
        enableImageGeneration: false, enableVideoGeneration: false, enableTTS: false,
      },
    };
    const props = {
      activeArtifactId: "ai-learning-page-production", backgroundEnabled: true,
      brief: "生成知识讲授课", cancelling: false, completed: false, confirmCancel: false,
      message: snapshot.message, onCancel: vi.fn(), onOpenCourse: vi.fn(), onReview: vi.fn(),
      paused: false, progress: 70, remainingLabel: "正在制作", reviewAvailable: false, startedAt: null,
    };
    const artifacts = (completed: number) => buildQuickClassroomArtifacts({ ...snapshot, scenesGenerated: completed }, { aiLearningOnly: true });
    const { rerender } = render(<QuickGenerationStage {...props} artifacts={artifacts(0)} />);
    expect(screen.getByTestId("ai-plan-shimmer")).toBeTruthy();
    rerender(<QuickGenerationStage {...props} artifacts={artifacts(2)} />);
    expect(screen.getByRole("progressbar", { name: "课堂页面制作进度" }).getAttribute("aria-valuenow")).toBe("2");
    const currentStep = within(screen.getByLabelText("单页制作流程")).getAllByRole("listitem").find((item) => item.getAttribute("aria-current") === "step");
    expect(currentStep?.textContent).toContain("讲稿与教学动作");

    rerender(<QuickGenerationStage {...props} artifacts={artifacts(2)} recovering />);
    expect(screen.queryByTestId("ai-plan-shimmer")).toBeNull();
    expect(screen.getAllByText("正在恢复").length).toBeGreaterThan(0);

    motionPreference.reduced = true;
    rerender(<QuickGenerationStage {...props} artifacts={artifacts(2)} />);
    expect(screen.getByTestId("ai-plan-shimmer").className).toContain("motion-reduce:hidden");
    expect(screen.getByRole("progressbar", { name: "课堂页面制作进度" }).getAttribute("aria-valuenow")).toBe("2");
  });

  it("renders one scrollable course outline card with timing and flowing progress", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T10:01:05.000Z"));
    const onReview = vi.fn();
    render(
      <QuickGenerationStage
        artifacts={[outlineArtifact]}
        backgroundEnabled
        brief="设计一节项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="正在等待教师审阅课程大纲"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={onReview}
        paused={false}
        progress={80}
        remainingLabel="预计还需约 3 分钟"
        reviewAvailable
        startedAt="2026-08-10T10:00:00.000Z"
      />,
    );

    expect(screen.getByRole("heading", { name: "课程大纲" })).toBeTruthy();
    expect(screen.getByText("项目启动")).toBeTruthy();
    expect(screen.getByText("知识讲授")).toBeTruthy();
    expect(screen.getByText("已用时 1 分 05 秒")).toBeTruthy();
    expect(screen.getByText("预计还需约 3 分钟")).toBeTruthy();
    expect(screen.getByTestId("quick-generation-progress-flow")).toBeTruthy();
    expect(screen.getByTestId("quick-generation-card-scroll").className).toContain("overflow-y-auto");

    fireEvent.click(screen.getByRole("button", { name: /查看课程大纲并确认/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("offers a timed knowledge-graph checkpoint before generating the outline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-10T10:00:00.000Z"));
    const onReview = vi.fn();
    render(
      <QuickGenerationStage
        artifacts={[{
          id: "knowledge-graph",
          kind: "graph",
          eyebrow: "知识图谱",
          title: "知识讲授知识图谱",
          summary: "大纲将采用这份知识结构。",
          accent: "blue",
          items: [{ label: "核心", value: "机器学习" }],
        }]}
        backgroundEnabled
        brief="设计一节 AI 课程"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="知识图谱已生成"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={onReview}
        paused={false}
        progress={55}
        remainingLabel="预计还需约 5 分钟"
        reviewAvailable
        reviewAvailableUntil="2026-08-10T10:00:20.000Z"
        reviewKind="knowledge"
        startedAt="2026-08-10T09:59:00.000Z"
      />,
    );

    expect(screen.getByText("20 秒后自动继续")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /查看知识图谱并确认/ }));
    expect(onReview).toHaveBeenCalledTimes(1);
  });

  it("shows concrete evaluation dimensions with the same 40/60 evaluator split", () => {
    render(
      <QuickGenerationStage
        artifacts={[{
          id: "evaluation-dimensions",
          kind: "rubric",
          eyebrow: "成功标准 · 正在审校",
          title: "作品评价标准",
          summary: "正在核对可观察的评价依据。",
          accent: "green",
          items: [
            { label: "24%", value: "概念理解", meta: "能准确解释 AI 误判的原因。", evaluator: "ai" },
            { label: "30%", value: "证据质量", meta: "案例来源可靠且经过事实核验。", evaluator: "teacher" },
            { label: "30%", value: "成果表达", meta: "结构完整、表达清楚。", evaluator: "teacher" },
            { label: "16%", value: "反思改进", meta: "说明修改依据与使用边界。", evaluator: "ai" },
          ],
        }]}
        backgroundEnabled
        brief="设计 AI 项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="正在审校评价标准"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={vi.fn()}
        paused={false}
        progress={42}
        remainingLabel="预计还需约 18 分钟"
        reviewAvailable={false}
        startedAt={null}
      />,
    );

    expect(screen.getByText("概念理解")).toBeTruthy();
    expect(screen.getByText("证据质量")).toBeTruthy();
    expect(screen.getByText("成果表达")).toBeTruthy();
    expect(screen.getByText("反思改进")).toBeTruthy();
    expect(screen.getByTestId("rubric-evaluation-ring")).toBeTruthy();
    expect(screen.getAllByText(/教师评/)).toHaveLength(3);
    expect(screen.getAllByText(/AI 评/)).toHaveLength(3);
    expect(screen.getByText(/教师评\s*60%/)).toBeTruthy();
    expect(screen.getByText(/AI 评\s*40%/)).toBeTruthy();
  });

  it("switches to the live adaptive-resource card and never falls back after artifacts shrink", () => {
    const { rerender } = render(
      <QuickGenerationStage
        activeArtifactId="course-outline"
        artifacts={[outlineArtifact]}
        backgroundEnabled
        brief="设计一节项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="正在制作课堂页面"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={vi.fn()}
        paused={false}
        progress={94}
        remainingLabel="预计还需约 2 分钟"
        reviewAvailable={false}
        startedAt={null}
      />,
    );

    const adaptiveArtifact: CourseDesignGenerationArtifact = {
      id: "classroom-adaptive-resources",
      kind: "branches",
      eyebrow: "课堂内容生成 · 分层学习资源",
      title: "诊断补缺与达标拓展",
      summary: "正在生成分层学习资源：模块拓展（已完成 8 / 12）",
      accent: "violet",
      items: [{ label: "当前资源", value: "如何选择合适的学习方法 · 模块拓展" }],
    };
    rerender(
      <QuickGenerationStage
        activeArtifactId="classroom-adaptive-resources"
        artifacts={[adaptiveArtifact]}
        backgroundEnabled
        brief="设计一节项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="正在生成分层学习资源"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={vi.fn()}
        paused={false}
        progress={97}
        remainingLabel="预计还需约 1 分钟"
        reviewAvailable={false}
        startedAt={null}
      />,
    );

    expect(screen.getByRole("heading", { name: "诊断补缺与达标拓展" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "拆解教师输入" })).toBeNull();
  });

  it("shows an explicit recoverable failure instead of pretending generation is still running", () => {
    const onRetry = vi.fn();
    render(
      <QuickGenerationStage
        artifacts={[outlineArtifact]}
        backgroundEnabled
        brief="设计一节项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        failed
        failureMessage="已完成 15 / 16 个课堂页面，最后一页生成超时。"
        message="课程生成未完成"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onRetry={onRetry}
        onReview={vi.fn()}
        paused={false}
        progress={86}
        remainingLabel="已完成页面均已保存，可从断点继续"
        reviewAvailable={false}
        startedAt="2026-08-10T10:00:00.000Z"
      />,
    );

    expect(screen.getAllByText("课程生成未完成").length).toBeGreaterThan(0);
    expect(screen.getByText(/已完成 15 \/ 16/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /从已完成页面继续/ }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("shows automatic recovery and stops presenting stale progress as live", () => {
    render(
      <QuickGenerationStage
        artifacts={[outlineArtifact]}
        backgroundEnabled
        brief="设计一节项目课"
        cancelling={false}
        completed={false}
        confirmCancel={false}
        message="正在规划诊断补缺与达标拓展路径"
        onCancel={vi.fn()}
        onOpenCourse={vi.fn()}
        onReview={vi.fn()}
        paused={false}
        progress={82}
        recovering
        remainingLabel="预计还需约 13 分钟"
        reviewAvailable={false}
        startedAt="2026-08-24T05:00:17.018Z"
      />,
    );

    expect(screen.getAllByText("正在自动恢复").length).toBeGreaterThan(0);
    expect(screen.getByText(/任务心跳暂时中断/)).toBeTruthy();
    expect(screen.getByText("正在重新连接后台生成任务")).toBeTruthy();
    expect(screen.getByTestId("quick-generation-progress-flow").className).toContain("animation:none");
  });
});
