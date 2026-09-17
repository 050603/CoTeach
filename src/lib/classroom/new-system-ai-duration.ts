import { callLLM, parseLLMJson } from "@/lib/llm/client";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";
import type { Course, KnowledgeGraph, KnowledgePoint } from "@/lib/session/types";
import type { AssessmentMode, CourseGenerationMode } from "@/lib/openmaic/types/generation";
import type { GenerationReferenceMaterial } from "@/lib/course-design/generation-references";
import type { NewSystemAiDurationRecommendation } from "@/lib/classroom/new-system-course";
import { allocateLectureBudget, knowledgeLectureBudgetBounds } from "./knowledge-lecture-budget";
import type { CourseStagePlan } from "@/lib/resource-package/types";
import type { AICallFn } from "@/lib/openmaic/generation/pipeline-types";

type ModelCall = typeof callLLM;

export type NewSystemAiDurationInput = {
  course: Pick<
    Course,
    | "name"
    | "subject"
    | "grade"
    | "hours"
    | "summary"
    | "learningObjectives"
    | "learnerProfile"
    | "pblConfig"
  >;
  knowledgePoints: readonly KnowledgePoint[];
  knowledgeGraph?: KnowledgeGraph;
  generationMode: CourseGenerationMode;
  assessmentMode?: AssessmentMode;
  teacherBrief: string;
  referenceMaterials?: readonly GenerationReferenceMaterial[];
  stagePlan?: CourseStagePlan;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function textArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(text).filter(Boolean)
    : [];
}

function finitePositive(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function knowledgePointWeight(
  point: KnowledgePoint,
  graph: KnowledgeGraph | undefined,
): number {
  const levelWeight: Record<NonNullable<KnowledgePoint["level"]>, number> = {
    foundation: 3,
    core: 5,
    application: 6,
    extension: 7,
  };
  const graphNodeIds = new Set([
    point.id,
    ...(graph?.nodes.filter((node) => node.label === point.name).map((node) => node.id) ?? []),
  ]);
  const incidentEdges = graph?.edges.filter(
    (edge) => graphNodeIds.has(edge.source) || graphNodeIds.has(edge.target),
  ).length ?? 0;
  return (point.level ? levelWeight[point.level] : 4) + Math.min(3, incidentEdges * 0.4);
}

export function buildNewSystemAiDurationMessages(input: NewSystemAiDurationInput) {
  const { courseMinutes: availableMinutes, minMinutes, maxMinutes, source } = knowledgeLectureBudgetBounds(input.course.hours, input.stagePlan);
  const fixed = source === "resource-package";
  return [
    {
      role: "system" as const,
      content: `你是 PBL 课程第二阶段“知识讲授”的教学时长规划专家。你只判断：为了让当前学段学生真正理解已确认知识图谱，并完成必要练习与低负担小节检测，知识讲授课堂本身需要多少分钟。

关键规则：
1. ${fixed ? `教师确认的资源包教案规定整课 ${availableMinutes} 分钟，第二阶段知识讲授固定 ${minMinutes} 分钟。不得修改总时长，不得另按比例缩放。` : `教师填写的 ${availableMinutes} 分钟是整节 PBL 课程总时长。第二阶段知识讲授必须占总时长的 20%–40%，即 ${minMinutes}–${maxMinutes} 分钟，这是不可突破的硬约束；其他阶段必须保留充足时间。`}
2. ${fixed ? "总 durationMin 已锁定，只根据知识点数量、层级、概念抽象度、依赖深度与学生基础分配逐知识点时间；rationale 说明怎样在该预算内完成教学。" : "先在上述范围内根据知识点数量、层级、概念抽象度、依赖深度与学生基础选择一个总 durationMin，说明为何选择该时长，而不是默认取上限。"}确定总时长后再分配知识点预算，最后才生成课程；不要根据页数反推或扩大总时长。
3. 每个知识点预算应覆盖必要的讲解、例证、思考或练习；共享讲解只计一次，避免重复和注水。
4. 普通模式只安排教学必要的互动；深度交互模式需给真实操作、观察反馈与修正留出时间，但不得用“点击下一步/查看详情”一类伪互动凑时长。
5. durationMin 必须为 ${minMinutes}–${maxMinutes} 范围内的整数。实质讲解与例子按 68% 规划，小测及反馈合计不超过 20%，其余用于必要操作、思考和切换；不能在总预算外追加时间。若内容过多，优先合并关联知识、缩减非核心拓展与重复例证，在 scopeWarning 说明范围取舍，不得增加总时长。
6. knowledgePointId 必须逐项使用输入中已有的精确 ID；每个本课知识点恰好出现一次；各项 durationMin 之和必须等于总 durationMin。

只返回 JSON：{
  "durationMin": ${Math.round((minMinutes + maxMinutes) / 2)},
  "rationale": "为什么该时长足以讲清且没有注水",
  "confidence": "low|medium|high",
  "knowledgePointBudgets": [
    { "knowledgePointId": "精确ID", "durationMin": 8, "rationale": "本知识点为何需要这些时间" }
  ],
  "evidence": ["影响时长的可观察依据"],
  "assumptions": ["无法从输入确认但规划时采用的假设"],
  "scopeWarning": "可选；只有容量不足时填写"
}。`,
    },
    {
      role: "user" as const,
      content: JSON.stringify({
        course: {
          name: input.course.name,
          subject: input.course.subject,
          grade: input.course.grade,
          teacherRequestedCourseHours: input.course.hours,
          availableMinutes,
          knowledgeLectureBudget: { minMinutes, maxMinutes, source, ...(!fixed ? { minRatio: 0.2, maxRatio: 0.4 } : {}) },
          summary: input.course.summary,
          learningObjectives: input.course.learningObjectives ?? [],
          learnerProfile: input.course.learnerProfile,
          difficultyLevel: input.course.pblConfig?.difficultyLevel,
        },
        teacherBrief: input.teacherBrief,
        teachingRequirements: input.stagePlan?.stages.find((stage) => stage.key === "ai-learning"),
        generationMode: input.generationMode,
        assessmentMode: input.assessmentMode ?? "constructed-response",
        knowledgePoints: input.knowledgePoints,
        knowledgeGraph: input.knowledgeGraph
          ? { nodes: input.knowledgeGraph.nodes, edges: input.knowledgeGraph.edges }
          : undefined,
        teacherReferenceFiles: input.referenceMaterials?.map((material) => material.fileName) ?? [],
      }),
    },
  ];
}

export function normalizeNewSystemAiDurationRecommendation(
  value: unknown,
  input: NewSystemAiDurationInput,
): NewSystemAiDurationRecommendation {
  const raw = asRecord(value);
  const requestedDuration = finitePositive(raw.durationMin);
  if (!requestedDuration) {
    throw new Error("知识讲授时长判断失败：模型未返回有效的 durationMin。");
  }
  const rationale = text(raw.rationale);
  if (!rationale) {
    throw new Error("知识讲授时长判断失败：模型未说明判断依据。");
  }

  const { courseMinutes: availableMinutes, minMinutes, maxMinutes, source } = knowledgeLectureBudgetBounds(input.course.hours, input.stagePlan);
  const fixed = source === "resource-package";
  const durationMin = Math.min(
    maxMinutes,
    Math.max(minMinutes, Math.round(requestedDuration)),
  );
  const rawBudgets = Array.isArray(raw.knowledgePointBudgets)
    ? raw.knowledgePointBudgets.map(asRecord)
    : [];
  const budgetById = new Map<string, Record<string, unknown>>();
  rawBudgets.forEach((budget) => {
    const id = text(budget.knowledgePointId);
    if (id && !budgetById.has(id)) budgetById.set(id, budget);
  });
  const knowledgePointBudgets = input.knowledgePoints.map((point) => {
    const budget = budgetById.get(point.id);
    return {
      knowledgePointId: point.id,
      durationMin: finitePositive(budget?.durationMin)
        ?? knowledgePointWeight(point, input.knowledgeGraph),
      rationale: text(budget?.rationale)
        || `${point.level ?? "core"} 层级，并结合其在知识图谱中的依赖关系分配。`,
    };
  });
  // Fine-grained budgets must also add up to the chosen total, even when the
  // model's original recommendation was clamped or omitted a knowledge point.
  const unit = knowledgePointBudgets.length > durationMin ? 60 : 1;
  const allocations = allocateLectureBudget(durationMin * unit, knowledgePointBudgets.map((budget) => budget.durationMin));
  knowledgePointBudgets.forEach((budget, index) => { budget.durationMin = allocations[index]! / unit; });
  const confidenceValue = text(raw.confidence);
  const confidence = confidenceValue === "low" || confidenceValue === "high"
    ? confidenceValue
    : "medium";
  const modelScopeWarning = text(raw.scopeWarning);
  const scopeWarning = fixed
    ? modelScopeWarning || undefined
    : requestedDuration > maxMinutes
    ? [`模型原建议 ${Math.round(requestedDuration)} 分钟超出整课 40% 上限，已压缩至 ${maxMinutes} 分钟；后续按此预算生成内容，合并关联知识并缩减非核心拓展。`, modelScopeWarning].filter(Boolean).join(" ")
    : modelScopeWarning || undefined;
  const assumptions = textArray(raw.assumptions);
  if (!fixed && requestedDuration < minMinutes) {
    assumptions.push(`原始建议低于整课 20% 下限，已调整为 ${durationMin} 分钟；讲解与节末小测均包含在此预算内。`);
  }
  assumptions.push(fixed
    ? `按教师确认的资源包教案锁定知识讲授 ${minMinutes} 分钟；整课 ${availableMinutes} 分钟，所有讲解、例证、互动和小测均包含在预算内。`
    : `知识讲授预算限定为整课 ${availableMinutes} 分钟的 20%–40%（${minMinutes}–${maxMinutes} 分钟），先确定总时长再生成课程。`);

  return {
    durationMin,
    rationale,
    confidence,
    knowledgePointBudgets,
    evidence: textArray(raw.evidence).length > 0
      ? textArray(raw.evidence)
      : [
          `${input.knowledgePoints.length} 个本课知识点`,
          `${input.knowledgeGraph?.edges.length ?? 0} 条知识关系`,
          `教师提供的课程容量为 ${availableMinutes} 分钟`,
        ],
    assumptions,
    scopeWarning,
  };
}

export async function generateNewSystemAiDurationRecommendation(
  input: NewSystemAiDurationInput,
  options: { abortSignal?: AbortSignal; modelCall?: ModelCall; aiCall?: AICallFn } = {},
): Promise<NewSystemAiDurationRecommendation> {
  const messages = buildNewSystemAiDurationMessages(input);
  const raw = options.aiCall
    ? await options.aiCall(
        messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
        messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n"),
      )
    : await (options.modelCall ?? callLLM)(messages, {
        jsonMode: true,
        abortSignal: options.abortSignal,
        requestClass: "long-generation",
        maxTransientRetries: DURABLE_GENERATION_TRANSIENT_RETRIES,
      });
  return normalizeNewSystemAiDurationRecommendation(parseLLMJson<unknown>(raw), input);
}
