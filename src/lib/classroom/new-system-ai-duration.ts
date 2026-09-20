import { callLLM, parseLLMJson } from "@/lib/llm/client";
import { DURABLE_GENERATION_TRANSIENT_RETRIES } from "@/lib/llm/request-policy";
import type { Course, KnowledgeGraph, KnowledgePoint, KnowledgeScopePlan } from "@/lib/session/types";
import type { AssessmentMode, CourseGenerationMode } from "@/lib/openmaic/types/generation";
import type { GenerationReferenceMaterial } from "@/lib/course-design/generation-references";
import type { NewSystemAiDurationRecommendation } from "@/lib/classroom/new-system-course";
import { allocateLectureBudget, knowledgeLectureBudgetBounds } from "./knowledge-lecture-budget";
import type { CourseStagePlan } from "@/lib/resource-package/types";
import type { AICallFn } from "@/lib/openmaic/generation/pipeline-types";
import { invalidGeneratedOutput, withGeneratedOutputRetry } from "@/lib/openmaic/generation/generated-output-retry";

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
  knowledgeScopePlan?: KnowledgeScopePlan;
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
2. 上游知识图谱已经完整保留资源包规定的全部必授知识点，并可能增加必要的桥接或拓展节点。${fixed ? "总 durationMin 已锁定，只根据这些节点的层级、抽象度、依赖深度、可组合关系与学生基础分配时间。" : "在上述范围内选择总 durationMin，用更多时间深化已确认结构，不要在这个阶段删除或扩张知识点。"}确定总时长后再分配知识点预算，最后才生成课程；不要根据页数反推或扩大总时长。
3. 时间分配以解释工作量和知识关系为依据。多个紧密相关知识点可共用概念引入、关系图、案例和判断过程，共享讲解只计一次；每个知识点仍须获得可识别的讲授责任。不得按知识点数量机械平均，也不得以“定义＋一个例子”的最低配置冒充完整覆盖。
4. 普通模式只安排教学必要的互动；深度交互模式需给真实操作、观察反馈与修正留出时间，但不得用“点击下一步/查看详情”一类伪互动凑时长。
5. durationMin 必须为 ${minMinutes}–${maxMinutes} 范围内的整数。按必要解释、可共享的关系讲解、例子分析、操作或思考、小节检测的实际需要分别估时；小测及反馈合计不超过 20%，不得套用固定讲解比例或在总预算外追加时间。scopeWarning 只用于“在合理组合讲授并减少可选扩展后，必授知识仍无法达到最低掌握边界”的真实冲突，不能仅因知识点数量多或简单计算平均分钟数而报警。
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
        knowledgeScopePlan: input.knowledgeScopePlan,
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
  options: {
    abortSignal?: AbortSignal;
    modelCall?: ModelCall;
    aiCall?: AICallFn;
    retrySleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  } = {},
): Promise<NewSystemAiDurationRecommendation> {
  const messages = buildNewSystemAiDurationMessages(input);
  return withGeneratedOutputRetry(async () => {
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
    try {
      return normalizeNewSystemAiDurationRecommendation(parseLLMJson<unknown>(raw), input);
    } catch (error) {
      throw invalidGeneratedOutput(error, "知识讲授时长结果无法解析或缺少必要字段");
    }
  }, {
    label: "ai-duration-output",
    signal: options.abortSignal,
    maxRetries: 2,
    sleep: options.retrySleep,
  });
}
