import { afterAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  buildOpenMaicKnowledgeLectureRequirement,
  normalizeNewSystemAiOutlines,
} from "@/lib/course-design/job-runner";
import { deriveKnowledgeLectureSectionsFromOutlines } from "@/lib/knowledge-lecture";
import type { PersistedCourseGenerationRequest } from "@/lib/course-generation/job-runner";
import type { KnowledgePoint } from "@/lib/session/types";
import { POST as generateOutlineStream } from "@/app/api/openmaic/generate/scene-outlines-stream/route";
import { initializeServerProviderConfig } from "@openmaic/lib/server/provider-config";
import { resolveModel } from "@openmaic/lib/server/resolve-model";
import { createCourseGenerationAiCall } from "@openmaic/lib/server/course-generation-ai-call";
import { generateOpenMaicBaselineContent } from "./openmaic-baseline";
import {
  auditAndRepairSlideOnce,
  auditSlideDensity,
  auditSlideLayout,
} from "./slide-layout-audit";

const verificationJobId = process.env.OPENPBL_BASELINE_JOB_ID;
const liveIt = verificationJobId ? it : it.skip;

describe("live OpenMAIC baseline outline", () => {
  afterAll(async () => {
    if (verificationJobId) await prisma.$disconnect();
  });

  liveIt("uses a real resource package and keeps quizzes at section boundaries", async () => {
    await initializeServerProviderConfig();
    const row = await prisma.generationJob.findUniqueOrThrow({
      where: { id: verificationJobId! },
      select: { request: true },
    });
    const request = row.request as unknown as PersistedCourseGenerationRequest & {
      courseTitle?: string;
      knowledgePoints: KnowledgePoint[];
    };
    const moduleTimingPlan = request.moduleTimingPlan as {
      allocations?: Array<{ stageKey: string; durationMin: number }>;
    } | undefined;
    const minutes = (moduleTimingPlan?.allocations ?? [])
      .filter((allocation) => allocation.stageKey === "ai-learning")
      .reduce((sum, allocation) => sum + allocation.durationMin, 0);
    const sectionMap = new Map<string, string[]>();
    for (const point of request.knowledgePoints) {
      const title = point.groupName?.trim() || "核心知识";
      sectionMap.set(title, [...(sectionMap.get(title) ?? []), point.name]);
    }
    const requirements = {
      ...request,
      requirement: buildOpenMaicKnowledgeLectureRequirement({
        name: request.courseTitle ?? "资源包课程",
        subject: "资源包课程",
        grade: "教师确认的目标学习者",
        summary: "依据资源包完成系统讲授",
        learningObjectives: [],
      } as never, {
        knowledgePoints: request.knowledgePoints,
      } as never, {
        courseId: request.courseId,
        teacherBrief: "",
        referenceMaterials: [],
      } as never, minutes),
    };
    const response = await generateOutlineStream(new NextRequest(
      "http://127.0.0.1/api/openmaic/generate/scene-outlines-stream",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-model": process.env.OPENPBL_BASELINE_MODEL ?? "deepseek:deepseek-v4-flash",
          "x-image-generation-enabled": String(request.enableImageGeneration === true),
          "x-video-generation-enabled": String(request.enableVideoGeneration === true),
        },
        body: JSON.stringify({ requirements, pdfText: request.teachingSourceContext }),
      },
    ));
    expect(response.status).toBe(200);
    const events = (await response.text()).split(/\r?\n/).flatMap((line) => {
      if (!line.startsWith("data: ")) return [];
      try {
        return [JSON.parse(line.slice(6)) as {
          type: string;
          error?: string;
          outlines?: PersistedCourseGenerationRequest["sceneOutlines"];
        }];
      } catch {
        return [];
      }
    });
    const failure = events.find((event) => event.type === "error");
    expect(failure?.error).toBeUndefined();
    const done = events.findLast((event) => event.type === "done");
    expect(done?.outlines?.length).toBeGreaterThan(0);
    const rawOutlines = done!.outlines!;
    const teachingRaw = rawOutlines.filter((outline) => outline.type !== "quiz");
    console.info("OPENMAIC_LIVE_RAW_OUTLINE", JSON.stringify({
      rawTypes: rawOutlines.map((outline) => outline.type),
      titles: teachingRaw.map((outline) => outline.title),
      keyPointCounts: teachingRaw.map((outline) => outline.keyPoints.length),
    }));
    expect(teachingRaw.length).toBeLessThanOrEqual(sectionMap.size * 3);
    expect(teachingRaw.filter((outline) => outline.keyPoints.length >= 4).length)
      .toBeGreaterThanOrEqual(Math.ceil(teachingRaw.length * 0.8));
    // Keep CoTeach section/quiz metadata outside the classic semantic outline.
    const knowledgePoints = request.knowledgePoints;
    const normalized = normalizeNewSystemAiOutlines(rawOutlines, {
      totalDurationSec: minutes * 60,
      knowledgePointIds: knowledgePoints.map((point) => point.id),
      knowledgePoints,
      courseLanguageDirective: "使用专业、清晰的简体中文。",
    });
    expect(normalized.every((outline) => outline.courseVisualDirection === undefined)).toBe(true);
    const sections = deriveKnowledgeLectureSectionsFromOutlines(normalized);
    expect(sections.length).toBeGreaterThan(0);
    if (normalized.filter((outline) => outline.type !== "quiz").length > 1) {
      expect(sections.every((section) => section.sceneOutlineIds.length >= 2)).toBe(true);
    }
    expect(normalized.filter((outline) => outline.type === "quiz")).toHaveLength(sections.length);
    console.info("OPENMAIC_LIVE_OUTLINE", JSON.stringify({
      rawTypes: rawOutlines.map((outline) => outline.type),
      rawKeyPointCounts: teachingRaw.map((outline) => outline.keyPoints.length),
      finalTypes: normalized.map((outline) => outline.type),
      sections: sections.map((section) => ({
        title: section.title,
        teachingPages: section.sceneOutlineIds.length,
      })),
    }));
  }, 300_000);

  liveIt("generates one dense website-reference lecture page with the real model", async () => {
    await initializeServerProviderConfig();
    const resolved = await resolveModel({
      stage: "scene-content:slide",
      modelString: process.env.OPENPBL_BASELINE_MODEL ?? "deepseek:deepseek-v4-flash",
    });
    const aiCall = createCourseGenerationAiCall({
      model: resolved.model,
      vision: resolved.modelInfo?.capabilities?.vision === true,
      source: "openmaic-live-workbench-page",
      maxOutputTokens: resolved.modelInfo?.outputWindow,
      thinking: resolved.thinkingConfig,
      timeoutMs: 240_000,
    });
    const outline = {
      id: "live-workbench-lecture-page",
      type: "slide" as const,
      title: "建构主义如何改变 AI 课堂",
      description: "围绕‘学生主动建构知识’这一论点，解释教师角色、活动机制和 Scratch AI 模型调试案例，并指出纯讲授的边界。",
      keyPoints: [
        "知识不是由教师直接传递，而是学习者基于既有经验主动建构",
        "AI 课堂应让学生通过预测、操作、观察与修正形成概念",
        "教师从结论讲授者转为任务设计者、追问者与资源提供者",
        "Scratch AI 模型调试能把抽象概念转化为可观察的反馈循环",
        "如果活动只有操作而没有解释与反思，仍然不会形成稳定理解",
      ],
      generationPurpose: "knowledge-teaching" as const,
      order: 0,
    };
    const websiteReferenceContext = {
      courseTitle: "中小学人工智能教育的教学理论与方法",
      slideTitles: [
        "学习理论基础：建构主义与情境认知",
        "中小学AI认知特点：直观形象到逻辑推理",
        "主流教学模式：项目式学习与探究式教学",
        "常用教学方法：支架式教学与提问策略",
        "课程设计要素：过程性评价与问题拆解",
        "AI辅助教学设计：资源生成与个性化路径",
      ],
    };
    const first = await generateOpenMaicBaselineContent(outline, aiCall, {
      websiteReferenceContext,
    });
    expect(first && "elements" in first).toBe(true);
    if (!first || !("elements" in first)) throw new Error("expected a generated slide");
    const reviewed = await auditAndRepairSlideOnce({
      outline,
      content: first,
      regenerate: async (editDirective, baselineContent) => {
        const candidate = await generateOpenMaicBaselineContent(outline, aiCall, {
          websiteReferenceContext,
          editDirective,
          baselineContent,
        });
        return candidate && "elements" in candidate ? candidate : null;
      },
    });
    const density = auditSlideDensity(outline, reviewed.content);
    const layout = await auditSlideLayout(reviewed.content, outline.id);
    console.info("OPENMAIC_LIVE_PAGE", JSON.stringify({
      firstElements: first.elements.length,
      finalElements: reviewed.content.elements.length,
      repairAttempted: reviewed.repairAttempted,
      adopted: reviewed.adopted,
      initialVisibleTextCharacters: reviewed.initialVisibleTextCharacters,
      visibleTextCharacters: density.visibleTextCharacters,
      hasDeepBlueTitle: density.hasDeepBlueTitle,
      hasSubtitle: density.hasSubtitle,
      semanticStructures: density.semanticStructures,
      paletteDeviationCount: density.paletteDeviationCount,
      layoutStatus: layout.status,
      layoutIssues: layout.issues,
    }));
    expect(density.visibleTextCharacters).toBeGreaterThanOrEqual(150);
    expect(density.hasDeepBlueTitle).toBe(true);
    expect(density.hasSubtitle).toBe(true);
    expect(density.paletteDeviationCount).toBe(0);
    expect(layout.status).toBe("checked");
    expect(layout.issues).toEqual([]);
  }, 540_000);
});
