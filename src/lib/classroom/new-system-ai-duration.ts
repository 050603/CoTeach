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

export type KnowledgeTeachingCluster = {
  id: string;
  title: string;
  knowledgePointIds: string[];
};

/**
 * Time belongs to a shared explanation sequence, not to each knowledge label.
 * Knowledge generation already provides semantic group ids; preserve those
 * groups here so related definitions, relations and examples can share time.
 */
export function deriveKnowledgeTeachingClusters(
  knowledgePoints: readonly KnowledgePoint[],
): KnowledgeTeachingCluster[] {
  const groups = new Map<string, { title: string; knowledgePointIds: string[] }>();
  for (const point of knowledgePoints) {
    const key = point.groupId?.trim() || point.groupName?.trim() || point.id;
    const title = point.groupName?.trim() || point.name.trim() || "相关知识";
    const current = groups.get(key);
    groups.set(key, current
      ? { ...current, knowledgePointIds: [...current.knowledgePointIds, point.id] }
      : { title, knowledgePointIds: [point.id] });
  }
  return [...groups.values()].map((group, index) => ({
    id: `teaching-cluster-${index + 1}`,
    title: group.title,
    knowledgePointIds: group.knowledgePointIds,
  }));
}

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

function teachingClusterWeight(
  cluster: KnowledgeTeachingCluster,
  pointsById: ReadonlyMap<string, KnowledgePoint>,
  graph: KnowledgeGraph | undefined,
): number {
  const memberWeights = cluster.knowledgePointIds
    .map((id) => pointsById.get(id))
    .filter((point): point is KnowledgePoint => Boolean(point))
    .map((point) => knowledgePointWeight(point, graph));
  const members = new Set(cluster.knowledgePointIds);
  const internalRelations = graph?.edges.filter((edge) => (
    members.has(edge.source) && members.has(edge.target)
  )).length ?? 0;
  return Math.max(1, ...memberWeights)
    + Math.log2(cluster.knowledgePointIds.length + 1) * 0.75
    + Math.min(2, internalRelations * 0.25);
}

export function buildNewSystemAiDurationMessages(input: NewSystemAiDurationInput) {
  const { courseMinutes: availableMinutes, minMinutes, maxMinutes, source } = knowledgeLectureBudgetBounds(input.course.hours, input.stagePlan);
  const fixed = source === "resource-package";
  const teachingClusters = deriveKnowledgeTeachingClusters(input.knowledgePoints);
  return [
    {
      role: "system" as const,
      content: `你是 PBL 课程第二阶段“知识讲授”的教学时长规划专家。你只判断：为了让当前学段学生真正理解已确认知识图谱，并完成必要练习与低负担小节检测，知识讲授课堂本身需要多少分钟。

关键规则：
1. ${fixed ? `教师确认的资源包教案规定整课 ${availableMinutes} 分钟，第二阶段知识讲授固定 ${minMinutes} 分钟。不得修改总时长，不得另按比例缩放。` : `教师填写的 ${availableMinutes} 分钟是整节 PBL 课程总时长。第二阶段知识讲授必须占总时长的 20%–40%，即 ${minMinutes}–${maxMinutes} 分钟，这是不可突破的硬约束；其他阶段必须保留充足时间。`}
2. 上游知识图谱已经完整保留资源包规定的全部必授知识点，并已按 groupId/groupName 形成可共同讲解的 teachingClusters。时间分配的最小单位是知识簇，不是单个知识点。${fixed ? "总 durationMin 已锁定，只根据各知识簇的共同解释主线、抽象度、依赖深度与学生基础分配时间。" : "在上述范围内选择总 durationMin，用更多时间深化已确认结构，不要在这个阶段删除或扩张知识点。"}确定总时长后再分配知识簇预算，最后才生成课程；不要根据页数反推或扩大总时长。
3. 多个紧密相关知识点共用一次概念引入、关系图、案例和判断过程，共享讲解只计一次。不得先给每个知识点设置最低分钟数再相加，不得输出逐知识点时间表，也不得用“知识点数量 × 单点分钟数”判断容量冲突。知识簇内每个知识点仍须获得可识别的解释责任，但不各自占用互斥时间。
4. 普通模式只安排教学必要的互动；深度交互模式需给真实操作、观察反馈与修正留出时间，但不得用“点击下一步/查看详情”一类伪互动凑时长。
5. durationMin 必须为 ${minMinutes}–${maxMinutes} 范围内的整数。按知识簇共同解释、例子分析、操作或思考、小节检测的实际需要分别估时；小测及反馈合计不超过 20%，不得套用固定讲解比例或在总预算外追加时间。
6. teachingClusterBudgets 必须逐项使用输入 teachingClusters 的精确 clusterId 和完整 knowledgePointIds；每个知识簇恰好出现一次，各簇 durationMin 之和必须等于总 durationMin。只有在共享引入、共享案例、减少重复和取消可选扩展后，某个完整知识簇仍无法达到最低掌握边界时，才返回 capacityConflict；必须列出真实 unresolvedClusterIds。按单个知识点平均分钟数得出的冲突无效。

只返回 JSON：{
  "durationMin": ${Math.round((minMinutes + maxMinutes) / 2)},
  "rationale": "为什么该时长足以讲清且没有注水",
  "confidence": "low|medium|high",
  "teachingClusterBudgets": [
    { "clusterId": "精确知识簇ID", "knowledgePointIds": ["该簇全部知识点ID"], "durationMin": 8, "rationale": "这组相关知识如何共享讲解以及为何需要这些时间" }
  ],
  "evidence": ["影响时长的可观察依据"],
  "assumptions": ["无法从输入确认但规划时采用的假设"],
  "capacityConflict": { "unresolvedClusterIds": ["确实无法达到最低掌握边界的知识簇ID"], "reason": "共享讲解和缩减可选扩展后仍缺少哪些必要教学动作", "compressionTried": "已经采用的组合与压缩方式" }
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
        teachingClusters,
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
  const teachingClusters = deriveKnowledgeTeachingClusters(input.knowledgePoints);
  const pointsById = new Map(input.knowledgePoints.map((point) => [point.id, point]));
  const rawBudgets = Array.isArray(raw.teachingClusterBudgets)
    ? raw.teachingClusterBudgets.map(asRecord)
    : [];
  const budgetById = new Map<string, Record<string, unknown>>();
  rawBudgets.forEach((budget) => {
    const id = text(budget.clusterId);
    if (id && !budgetById.has(id)) budgetById.set(id, budget);
  });
  // Accept an old completed response only as weight evidence. It is folded
  // into canonical semantic groups and never restored as per-point timing.
  const legacyPointBudgets = Array.isArray(raw.knowledgePointBudgets)
    ? raw.knowledgePointBudgets.map(asRecord)
    : [];
  const legacyWeightByPointId = new Map(legacyPointBudgets.flatMap((budget) => {
    const id = text(budget.knowledgePointId);
    const duration = finitePositive(budget.durationMin);
    return id && duration ? [[id, duration] as const] : [];
  }));
  const teachingClusterBudgets = teachingClusters.map((cluster) => {
    const budget = budgetById.get(cluster.id);
    const legacyWeight = cluster.knowledgePointIds.reduce(
      (sum, id) => sum + (legacyWeightByPointId.get(id) ?? 0),
      0,
    );
    return {
      clusterId: cluster.id,
      title: cluster.title,
      knowledgePointIds: cluster.knowledgePointIds,
      durationMin: finitePositive(budget?.durationMin)
        ?? (legacyWeight > 0 ? legacyWeight : teachingClusterWeight(cluster, pointsById, input.knowledgeGraph)),
      rationale: text(budget?.rationale)
        || `围绕“${cluster.title}”共享引入、关系解释与案例，覆盖 ${cluster.knowledgePointIds.length} 个相关知识点。`,
    };
  });
  // Shared cluster budgets add up to the chosen total. Knowledge points inside
  // a cluster intentionally do not receive mutually exclusive sub-budgets.
  const unit = teachingClusterBudgets.length > durationMin ? 60 : 1;
  const allocations = allocateLectureBudget(
    durationMin * unit,
    teachingClusterBudgets.map((budget) => budget.durationMin),
  );
  teachingClusterBudgets.forEach((budget, index) => { budget.durationMin = allocations[index]! / unit; });
  const confidenceValue = text(raw.confidence);
  const confidence = confidenceValue === "low" || confidenceValue === "high"
    ? confidenceValue
    : "medium";
  const rawConflict = asRecord(raw.capacityConflict);
  const validClusterIds = new Set(teachingClusters.map((cluster) => cluster.id));
  const unresolvedClusterIds = textArray(rawConflict.unresolvedClusterIds)
    .filter((id) => validClusterIds.has(id));
  const conflictReason = text(rawConflict.reason);
  const compressionTried = text(rawConflict.compressionTried);
  const scopeWarning = unresolvedClusterIds.length > 0 && conflictReason && compressionTried
    ? `${conflictReason}（涉及：${unresolvedClusterIds.map((id) => (
        teachingClusters.find((cluster) => cluster.id === id)?.title ?? id
      )).join("、")}；已尝试：${compressionTried}）`
    : undefined;
  const assumptions = textArray(raw.assumptions);
  if (!fixed && requestedDuration > maxMinutes) {
    assumptions.push(`模型原建议 ${Math.round(requestedDuration)} 分钟，已按整课 40% 上限调整为 ${maxMinutes} 分钟；相关知识继续使用共享知识簇预算。`);
  }
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
    teachingClusterBudgets,
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
