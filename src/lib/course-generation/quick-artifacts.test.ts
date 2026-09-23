import { describe, expect, it } from "vitest";
import {
  buildQuickClassroomArtifacts,
  combineQuickGenerationProgress,
  resolveQuickClassroomActiveArtifactId,
  type QuickClassroomGenerationSnapshot,
} from "./quick-artifacts";

function job(overrides: Partial<QuickClassroomGenerationSnapshot> = {}): QuickClassroomGenerationSnapshot {
  return {
    status: "running",
    step: "generating_scenes",
    progress: 52,
    message: "正在制作课堂页面",
    scenesGenerated: 4,
    totalScenes: 6,
    events: [],
    requestPreview: {
      courseTitle: "校园雨水花园",
      sceneOutlines: [
        { id: "1", title: "发布驱动问题", type: "slide", stageKey: "launch", estimatedDuration: 180 },
        { id: "2", title: "识别真实案例", type: "interactive", stageKey: "launch", estimatedDuration: 240 },
        { id: "3", title: "理解核心概念", type: "slide", stageKey: "ai-learning", estimatedDuration: 300 },
        { id: "4", title: "完成知识检测", type: "quiz", stageKey: "ai-learning", estimatedDuration: 180 },
        { id: "5", title: "形成项目方案", type: "pbl", stageKey: "proposal", estimatedDuration: 360 },
        { id: "6", title: "展示项目成果", type: "pbl", stageKey: "showcase", estimatedDuration: 300 },
      ],
      enableImageGeneration: true,
      enableVideoGeneration: false,
      enableTTS: true,
    },
    ...overrides,
  };
}

describe("buildQuickClassroomArtifacts", () => {
  it("builds a live AI-learning page-production card for the new system", () => {
    const aiLearningJob = job({
      scenesGenerated: 0,
      totalScenes: 4,
      requestPreview: {
        courseTitle: "理解生成式人工智能",
        sceneOutlines: [
          { id: "1", title: "认识生成模型", type: "slide", stageKey: "ai-learning", estimatedDuration: 240 },
          { id: "2", title: "观察模型如何预测", type: "interactive", stageKey: "ai-learning", estimatedDuration: 300 },
          { id: "3", title: "检查核心概念", type: "quiz", stageKey: "ai-learning", estimatedDuration: 180 },
          { id: "4", title: "理解使用边界", type: "slide", stageKey: "ai-learning", estimatedDuration: 240 },
        ],
        enableImageGeneration: true,
        enableVideoGeneration: false,
        enableTTS: true,
      },
    });

    const artifacts = buildQuickClassroomArtifacts(aiLearningJob, { aiLearningOnly: true });
    const blueprint = artifacts[0];

    expect(blueprint).toMatchObject({
      id: "ai-learning-page-production",
      title: "正在制作课堂页面",
      visualization: {
        generationPlan: {
          totalScenes: 4,
          estimatedDuration: 960,
          assets: { images: true, videos: false, tts: true },
          activePages: [],
          stageProgress: [],
        },
      },
    });
    expect(blueprint.visualization?.generationPlan?.scenes.map((scene) => scene.title)).toEqual([
      "认识生成模型",
      "观察模型如何预测",
      "检查核心概念",
      "理解使用边界",
    ]);
    expect(resolveQuickClassroomActiveArtifactId(aiLearningJob, { aiLearningOnly: true })).toBe("ai-learning-page-production");
  });

  it("uses readable fallbacks for malformed generated labels", () => {
    const artifacts = buildQuickClassroomArtifacts(job({
      scenesGenerated: 1,
      totalScenes: 1,
      requestPreview: {
        sceneOutlines: [{ id: "scene-1", title: "scene-runtime-1", type: "slide", stageKey: "internal-stage-1" }],
        enableImageGeneration: false,
        enableVideoGeneration: false,
        enableTTS: false,
      },
    }));

    expect(artifacts[1]?.items[0]).toMatchObject({
      label: "课程学习阶段 · 1",
      value: "未命名课程页面",
    });
  });

  it("keeps the live workbench during parallel page production and recovery", () => {
    for (const step of ["generating_scenes", "recovering_scenes", "persisting", "completed"]) {
      const snapshot = job({ step, scenesGenerated: 4 });
      const artifacts = buildQuickClassroomArtifacts(snapshot, { aiLearningOnly: true });
      expect(resolveQuickClassroomActiveArtifactId(snapshot, { aiLearningOnly: true })).toBe("ai-learning-page-production");
      expect(artifacts[0].visualization?.generationPlan).toMatchObject({ completedScenes: 4, phaseIndex: 1 });
      expect(artifacts.some((artifact) => artifact.id.startsWith("classroom-pages-"))).toBe(false);
    }
  });

  it.each([
    ["queued", "queued", -1],
    ["running", "initializing", 0],
    ["running", "generating_scenes", 1],
    ["running", "generating_adaptive_resources", 2],
    ["running", "generating_tts_assets", 2],
    ["running", "generating_course_cover", 3],
    ["running", "auditing_resources", 4],
    ["completed", "completed", 5],
  ] as const)("uses actual job phase for %s / %s", (status, step, phaseIndex) => {
    const artifact = buildQuickClassroomArtifacts(job({ status, step }), { aiLearningOnly: true })[0];
    expect(artifact.visualization?.generationPlan).toMatchObject({ status, phaseIndex });
  });

  it("retains the last observed phase after failure without marking more pages complete", () => {
    const snapshot = job({
      status: "failed", step: "failed", scenesGenerated: 2,
      events: [{ step: "generating_scenes", progress: 40, message: "正在制作页面", scenesGenerated: 2, totalScenes: 6, ts: 1 }],
    });
    const artifact = buildQuickClassroomArtifacts(snapshot, { aiLearningOnly: true })[0];
    expect(artifact.title).toBe("课堂页面制作等待继续");
    expect(artifact.visualization?.generationPlan).toMatchObject({ completedScenes: 2, phaseIndex: 1, status: "failed" });
  });

  it("handles missing outlines and does not promise teacher resources in the new system", () => {
    const empty = buildQuickClassroomArtifacts(job({
      status: "queued", step: "queued", totalScenes: 0, scenesGenerated: 0, requestPreview: undefined,
    }), { aiLearningOnly: true })[0];
    expect(empty.visualization?.generationPlan).toMatchObject({ totalScenes: 0, scenes: [], phaseIndex: -1 });

    const artifacts = buildQuickClassroomArtifacts(job({ status: "completed", step: "completed" }), { aiLearningOnly: true });
    expect(JSON.stringify(artifacts)).not.toContain("教师资源");
    expect(resolveQuickClassroomActiveArtifactId(job({ status: "completed", step: "completed" }), { aiLearningOnly: true })).toBe("ai-learning-finalizing");
  });

  it("uses four forward-only classroom cards after the four design cards", () => {
    const events: QuickClassroomGenerationSnapshot["events"] = [
      { step: "separating_classrooms", progress: 91, message: "正在关联课堂", scenesGenerated: 6, totalScenes: 6, ts: 1 },
      { step: "generating_media_assets", assetPhaseStatus: "completed", assetCompleted: 4, assetTotal: 4, progress: 99, message: "已完成 4 项图片资源", scenesGenerated: 6, totalScenes: 6, ts: 2 },
      { step: "generating_tts_assets", assetPhaseStatus: "completed", assetCompleted: 1, assetTotal: 1, progress: 99, message: "课堂讲授语音已经生成并写入页面", scenesGenerated: 6, totalScenes: 6, ts: 3 },
      { step: "course_cover_ready", progress: 99, message: "课程封面已生成并保存", scenesGenerated: 6, totalScenes: 6, ts: 4 },
      { step: "generation_resources_ready", progress: 99, message: "课程封面与课堂资源已经就绪", scenesGenerated: 6, totalScenes: 6, ts: 5 },
    ];
    const artifacts = buildQuickClassroomArtifacts(job({ status: "completed", step: "completed", events }), { aiLearningOnly: true });

    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "ai-learning-page-production",
      "ai-learning-resources",
      "ai-learning-course-cover",
      "ai-learning-finalizing",
    ]);
    expect(artifacts[1].visualization?.resourcePlan?.lanes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "media", status: "completed", completed: 4, total: 4 }),
      expect.objectContaining({ id: "tts", status: "completed" }),
    ]));
  });

  it("continues the quick canvas with real outline titles and forward-only page batches", () => {
    const artifacts = buildQuickClassroomArtifacts(job());

    expect(artifacts.map((artifact) => artifact.id)).toEqual([
      "classroom-generation-plan",
      "classroom-pages-1",
      "classroom-pages-2",
    ]);
    expect(artifacts[1]?.items.map((item) => item.value)).toEqual([
      "发布驱动问题",
      "识别真实案例",
      "理解核心概念",
    ]);
    expect(artifacts[2]?.items[0]).toMatchObject({ value: "完成知识检测" });
  });

  it("ends with a durable-save card instead of requiring publication", () => {
    const artifacts = buildQuickClassroomArtifacts(job({
      status: "completed",
      step: "completed",
      progress: 100,
      scenesGenerated: 6,
      result: {
        id: "classroom-1",
        scenesCount: 6,
        studentSceneCount: 6,
        teacherSceneCount: 4,
        qualityReport: { summary: "结构与资源覆盖检查通过" },
      },
    }));

    expect(artifacts.at(-1)).toMatchObject({
      id: "classroom-persisting",
      title: "课程内容已经生成并保存",
    });
    expect(artifacts.at(-1)?.items.some((item) => item.value === "已自动保存")).toBe(true);
  });

  it("moves beyond the final page into routing, adaptive, media, TTS and persistence cards", () => {
    const events = [
      ["separating_classrooms", "正在拆分学生课堂与教师授课资源"],
      ["generating_adaptive_resources", "正在生成个性化学习资源"],
      ["generating_media_assets", "正在生成并插入 6 项图片与视频资源"],
      ["generating_tts_assets", "正在生成课堂讲授语音"],
      ["persisting_assets", "正在合并并保存课堂资源"],
    ].map(([step, message], index) => ({ step, message, progress: 98, scenesGenerated: 6, totalScenes: 6, ts: index }));
    const artifacts = buildQuickClassroomArtifacts(job({
      step: "persisting_assets",
      progress: 99,
      scenesGenerated: 6,
      events,
    }));

    expect(artifacts.map((artifact) => artifact.id)).toEqual(expect.arrayContaining([
      "classroom-routing",
      "classroom-adaptive-resources",
      "classroom-media-assets",
      "classroom-tts-assets",
      "classroom-persisting",
    ]));
  });

  it("maps adaptive work to its own active card and keeps unfinished progress below 100%", () => {
    const adaptiveJob = job({
      step: "generating_adaptive_resources",
      progress: 95,
      scenesGenerated: 6,
      message: "正在生成分层学习资源：如何选择合适的学习方法 · 模块拓展（已完成 8 / 12）",
      events: [{
        step: "generating_adaptive_resources",
        progress: 95,
        message: "正在生成分层学习资源：如何选择合适的学习方法 · 模块拓展（已完成 8 / 12）",
        scenesGenerated: 6,
        totalScenes: 6,
        ts: 1,
      }],
    });

    const artifacts = buildQuickClassroomArtifacts(adaptiveJob);
    expect(resolveQuickClassroomActiveArtifactId(adaptiveJob)).toBe("classroom-adaptive-resources");
    expect(artifacts.find((item) => item.id === "classroom-adaptive-resources")).toMatchObject({
      title: "诊断补缺与达标拓展",
      summary: expect.stringContaining("已完成 8 / 12"),
    });
    expect(combineQuickGenerationProgress(100, 100, false)).toBe(99);
    expect(combineQuickGenerationProgress(100, 100, true)).toBe(100);
  });

  it("gives quick course cover generation its own live card", () => {
    const coverJob = job({
      step: "generating_course_cover",
      progress: 99,
      scenesGenerated: 6,
      message: "正在生成课程封面：校园雨水花园",
      events: [{
        step: "generating_course_cover",
        progress: 99,
        message: "正在生成课程封面：校园雨水花园",
        scenesGenerated: 6,
        totalScenes: 6,
        ts: 1,
      }],
    });

    const artifacts = buildQuickClassroomArtifacts(coverJob);
    expect(resolveQuickClassroomActiveArtifactId(coverJob)).toBe("classroom-course-cover");
    expect(artifacts.find((item) => item.id === "classroom-course-cover")).toMatchObject({
      title: "正在生成课程专属封面",
      items: expect.arrayContaining([expect.objectContaining({ value: "校园雨水花园" })]),
    });
  });

  it("uses the latest cover outcome after a managed recovery", () => {
    const recovered = job({
      status: "completed",
      step: "completed",
      events: [
        { step: "generating_course_cover", progress: 99, message: "正在生成课程封面", scenesGenerated: 6, totalScenes: 6, ts: 1 },
        { step: "course_cover_failed", progress: 99, message: "课程封面生成未完成", scenesGenerated: 6, totalScenes: 6, ts: 2 },
        { step: "generating_course_cover", progress: 99, message: "正在重新生成课程封面", scenesGenerated: 6, totalScenes: 6, ts: 3 },
        { step: "course_cover_ready", progress: 99, message: "课程封面已生成并保存", scenesGenerated: 6, totalScenes: 6, ts: 4 },
        { step: "generation_resources_ready", progress: 99, message: "课程封面与课堂资源已经就绪", scenesGenerated: 6, totalScenes: 6, ts: 5 },
      ],
    });

    const artifacts = buildQuickClassroomArtifacts(recovered);
    expect(artifacts.find((item) => item.id === "classroom-course-cover")).toMatchObject({
      kind: "audit",
      title: "课程专属封面已经生成",
      summary: "课程封面已生成并保存",
      items: expect.arrayContaining([expect.objectContaining({ label: "保存状态", value: "已写入课程" })]),
    });
    expect(artifacts.find((item) => item.id === "classroom-resources-ready")?.items[0]).toMatchObject({
      label: "课程封面",
      value: "主题封面已写入课程",
    });
  });

  it("keeps concurrent media and TTS cards in a single forward sequence", () => {
    const events: QuickClassroomGenerationSnapshot["events"] = [
      { step: "generating_media_assets", assetPhaseStatus: "running", progress: 98, message: "正在生成图片", scenesGenerated: 6, totalScenes: 6, ts: 1 },
      { step: "generating_tts_assets", assetPhaseStatus: "running", progress: 98, message: "正在生成语音", scenesGenerated: 6, totalScenes: 6, ts: 2 },
    ];
    expect(resolveQuickClassroomActiveArtifactId(job({ step: "generating_tts_assets", events })))
      .toBe("classroom-media-assets");

    events.push({
      step: "generating_media_assets",
      assetPhaseStatus: "completed",
      progress: 99,
      message: "图片已经生成",
      scenesGenerated: 6,
      totalScenes: 6,
      ts: 3,
    });
    expect(resolveQuickClassroomActiveArtifactId(job({ step: "generating_media_assets", events: [...events] })))
      .toBe("classroom-tts-assets");

    events.push({
      step: "generating_tts_assets",
      assetPhaseStatus: "completed",
      progress: 99,
      message: "语音已经生成",
      scenesGenerated: 6,
      totalScenes: 6,
      ts: 4,
    });
    expect(resolveQuickClassroomActiveArtifactId(job({ step: "generating_tts_assets", events })))
      .toBe("classroom-tts-assets");
  });

  it("shows exhausted media as a preview repair instead of an indefinitely running write", () => {
    const events: QuickClassroomGenerationSnapshot["events"] = [{
      step: "generating_media_assets",
      assetPhaseStatus: "partial-failure",
      progress: 99,
      message: "已插入 1 / 2 项媒体资源",
      scenesGenerated: 6,
      totalScenes: 6,
      ts: 1,
    }];
    const artifacts = buildQuickClassroomArtifacts(job({
      step: "generating_tts_assets",
      events,
    }));

    expect(artifacts.find((artifact) => artifact.id === "classroom-media-assets")).toMatchObject({
      title: "部分视觉资源需要在预览页处理",
      summary: "已插入 1 / 2 项媒体资源",
      items: expect.arrayContaining([expect.objectContaining({
        label: "课堂配图",
        value: expect.stringContaining("定向重试"),
      })]),
    });
    expect(resolveQuickClassroomActiveArtifactId(job({ step: "generating_tts_assets", events })))
      .toBe("classroom-tts-assets");
  });
});
