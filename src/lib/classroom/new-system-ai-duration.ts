import { callLLM, parseLLMJson } from "@/lib/llm/client";
import { teachingRequirementResponsibility, type Course, type CourseTeachingRequirements, type KnowledgeGraph, type KnowledgePoint, type KnowledgeScopePlan } from "@/lib/session/types";
import type { AssessmentMode, CourseGenerationMode } from "@/lib/openmaic/types/generation";
import type { GenerationReferenceMaterial } from "@/lib/course-design/generation-references";
import type { NewSystemAiDurationRecommendation } from "@/lib/classroom/new-system-course";
import { allocateLectureBudget, knowledgeLectureBudgetBounds } from "./knowledge-lecture-budget";
import type { CourseStagePlan } from "@/lib/resource-package/types";
import type { AICallFn } from "@/lib/openmaic/generation/pipeline-types";
import { invalidGeneratedOutput } from "@/lib/openmaic/generation/generated-output-retry";
import { deriveTeachingLearningBoundaries } from "@/lib/course-design/learning-boundary";
import type { TeachingLearningBoundary } from "@/lib/course-quality-review/types";

type ModelCall = typeof callLLM;

export const NEW_SYSTEM_AI_DURATION_AUTHORING_POLICY_VERSION = 'shared-cluster-reference-time-v2';

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
  teachingRequirements?: CourseTeachingRequirements;
  referenceMaterials?: readonly GenerationReferenceMaterial[];
  stagePlan?: CourseStagePlan;
};

export type KnowledgeTeachingCluster = {
  id: string;
  title: string;
  knowledgePointIds: string[];
  learningBoundary: TeachingLearningBoundary;
};

function clusterSourceIds(cluster: KnowledgeTeachingCluster, input: NewSystemAiDurationInput): Set<string> {
  return new Set(cluster.knowledgePointIds.flatMap((id) => {
    const point = input.knowledgePoints.find((candidate) => candidate.id === id);
    return point ? [point.id, ...(point.sourceKnowledgePointIds ?? [])] : [];
  }));
}

function clusterRequirementIds(cluster: KnowledgeTeachingCluster, input: NewSystemAiDurationInput): string[] {
  const sourceIds = clusterSourceIds(cluster, input);
  return (input.teachingRequirements?.items ?? []).flatMap((requirement) => (
    (requirement.kind === "highlight" || requirement.kind === "difficulty")
    && requirement.appliesTo !== "other-stage"
    && teachingRequirementResponsibility(requirement) === "instruction"
    && requirement.sourceKnowledgePointIds.some((id) => sourceIds.has(id))
      ? [requirement.id]
      : []
  ));
}

function priorityRequirements(input: NewSystemAiDurationInput) {
  return (input.teachingRequirements?.items ?? []).filter((requirement) => (
    (requirement.kind === "highlight" || requirement.kind === "difficulty")
    && requirement.appliesTo !== "other-stage"
    && teachingRequirementResponsibility(requirement) === "instruction"
  ));
}

/**
 * Time belongs to a shared explanation sequence, not to each knowledge label.
 * Knowledge generation already provides semantic group ids; preserve those
 * groups here so related definitions, relations and examples can share time.
 */
export function deriveKnowledgeTeachingClusters(
  knowledgePoints: readonly KnowledgePoint[],
  knowledgeGraph?: KnowledgeGraph,
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
  const orderedGroups = [...groups.values()];
  const learningBoundaries = deriveTeachingLearningBoundaries(
    knowledgePoints,
    knowledgeGraph,
    orderedGroups,
  );
  return orderedGroups.map((group, index) => ({
    id: `teaching-cluster-${index + 1}`,
    title: group.title,
    knowledgePointIds: group.knowledgePointIds,
    learningBoundary: learningBoundaries[index],
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
  const teachingClusters = deriveKnowledgeTeachingClusters(input.knowledgePoints, input.knowledgeGraph);
  return [
    {
      role: "system" as const,
      content: `你是 PBL 课程第二阶段“知识讲授”的教学时长规划专家。authoringContract 必须为 duration-v1。你为已确认知识图谱分配名义参考时长，投入依据是让当前学段学生真正理解知识并完成必要练习与低负担小节检测。名义计划用于课程安排，不是实际讲授上限；清晰完整优先，必要解释可以超出参考时间。

关键规则：
1. ${fixed ? `教师确认的资源包教案名义计划为整课 ${availableMinutes} 分钟，第二阶段知识讲授 ${minMinutes} 分钟。保持这一参考分配，不另按比例缩放；实际讲清必要内容可以超过预计时长。` : `教师填写的 ${availableMinutes} 分钟是整节 PBL 课程参考时长。第二阶段名义分配仍按整课的 20%–40%，即 ${minMinutes}–${maxMinutes} 分钟安排，保留其他阶段的计划份额；这个区间不是实际讲授的质量边界或上限。`}
2. 上游知识要求已通过 sourceKnowledgePointIds 映射到教材化课程节点，并已按 groupId/groupName 形成可共同讲解的 teachingClusters；原始节点名称和解释不要求逐字保留。时间分配的最小单位是知识簇，不是单个知识点。${fixed ? "名义 durationMin 已锁定，只根据各知识簇的共同解释主线、抽象度、依赖深度与学生基础分配时间。" : "在上述范围内选择名义 durationMin，不在这个阶段删除或扩张知识点。"}确定总时长后再分配知识簇预算，最后才生成课程；不按页数反推名义总量，实际理解需要更多时间时在 rationale/evidence/assumptions 中如实记录。
3. 多个紧密相关知识点共用一次概念引入、关系图、案例和判断过程，共享讲解只计一次。不得先给每个知识点设置最低分钟数再相加，不得输出逐知识点时间表，也不得用“知识点数量 × 单点分钟数”判断容量冲突。知识簇内每个知识点仍须获得可识别的解释责任，但不各自占用互斥时间。
4. 普通模式只安排教学必要的互动；深度交互模式需给真实操作、观察反馈与修正留出时间，但不得用“点击下一步/查看详情”一类伪互动凑时长。
5. ${fixed ? "名义总时长已锁定，不重复返回 durationMin。" : `名义 durationMin 必须为 ${minMinutes}–${maxMinutes} 范围内的整数。`}按知识簇共同解释、例子分析、操作或思考、小节检测的实际需要分别估时；小测及反馈仍按现有策略预留，不超过名义计划的 20%。不得套用固定讲解比例，必要内容实际超时允许，不能通过删减条件、推理或加快朗读伪造预算达标。
6. teachingClusterBudgets 必须逐项使用输入 teachingClusters 的精确 clusterId，成员完整沿用输入，不由模型重写；每个知识簇恰好出现一次；只输出 relativeWeight 表示相对投入，最终名义分钟数和总量守恒由系统计算，不重复输出 knowledgePointIds。需要更多实际讲授时间不构成 capacityConflict；在 rationale/evidence/assumptions 如实记录时间参考差异，并保留完整理解责任。capacityConflict 仅用于仍缺少必要前提、资源或教学动作等实质缺口，必须列出真实 unresolvedClusterIds，不能按知识点平均分钟数判断冲突，也不能用时间差宣布无法讲清。
7. applicableRequirementIds 表示知识簇可承担的重点或难点，只返回真正影响本簇投入的 requirementIds 和简短时长理由；不要求每个相关簇重复落实；同一要求关联的每个来源知识主题至少有一个相关簇承担，全局未映射要求只选一个最相关簇。难点的具体障碍、讲法和理解证据由后续蓝图一次性编写，本阶段不输出 difficultyStrategies。分配相对投入时已考虑重点和难点，系统不再额外加权。学生阶段任务不占用讲授要求。不得压掉核心定义和必要解释，只能减少重复铺垫及可选扩展。
8. learningBoundary 是该知识簇开讲时的权威学习边界。masteryBoundary 描述课程完成后的达成表现，绝不代表学生在开课时已经掌握。用于判断投入的教学例子、比较、分类与练习只能依赖 prerequisiteKnowledge、previouslyTaughtKnowledge，或先在本簇 currentKnowledge 中完整建立再使用的概念。futureKnowledge 只可在目录或学习目标中预告名称，不得作为当前理解前提、例子对象、判断选项或练习材料。跨概念综合判断必须安排到相关概念都进入 previouslyTaughtKnowledge/currentKnowledge 之后；若当前重点或难点原文使用了未来概念，应换成学生熟悉的具体行为、现象或课堂片段，不得据此提前搬入未来概念。

只返回 JSON：{
  "authoringContract": "duration-v1",
  ${fixed ? "" : `"durationMin": ${Math.round((minMinutes + maxMinutes) / 2)},`}
  "rationale": "为何这样分配参考投入，是否需要更多实际时间讲清，避免无意义重复",
  "confidence": "low|medium|high",
  "teachingClusterBudgets": [
    { "clusterId": "精确知识簇ID", "relativeWeight": 1, "rationale": "共同解释和重点难点为何需要这些投入", "requirementIds": ["本簇实际承担的 applicableRequirementIds"] }
  ],
  "evidence": ["影响时长的可观察依据"],
  "assumptions": ["无法从输入确认但规划时采用的假设"],
  "capacityConflict": { "unresolvedClusterIds": ["仍有实质前提或资源缺口的知识簇ID，没有则空数组"], "reason": "不因时间偏差判定冲突，说明真实缺少的前提、资源或必要教学动作", "compressionTried": "已采用的共享解释与去重复方式，不删减必要条件或推理" }
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
        aiLearningStage: input.stagePlan?.stages.find((stage) => stage.key === "ai-learning"),
        generationMode: input.generationMode,
        assessmentMode: input.assessmentMode ?? "adaptive",
        teachingRequirements: input.teachingRequirements && {
          ...input.teachingRequirements,
          items: input.teachingRequirements.items.filter((requirement) => teachingRequirementResponsibility(requirement) === "instruction"),
        },
        unassignedPriorityRequirementIds: priorityRequirements(input).filter((requirement) => (
          !requirement.sourceKnowledgePointIds.length
        )).map((requirement) => requirement.id),
        teachingClusters: teachingClusters.map((cluster) => {
          const applicableRequirementIds = clusterRequirementIds(cluster, input);
          return {
            ...cluster,
            applicableRequirementIds,

          };
        }),
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
  options: { normalized?: boolean; qualityMode?: 'strict' | 'diagnostic' } = {},
): NewSystemAiDurationRecommendation {
  const raw = asRecord(value);
  const qualityDiagnostics = textArray(raw.qualityDiagnostics);
  const qualityIssue = (message: string): void => {
    if (options.qualityMode !== 'diagnostic') throw new Error(message);
    qualityDiagnostics.push(message);
  };
  const normalizedBudget = options.normalized === true || raw.normalizationVersion === "duration-v1";
  // An omitted marker does not turn relative weights into legacy minute budgets.
  const singleAuthoring = normalizedBudget || raw.authoringContract === "duration-v1"
    || (Array.isArray(raw.teachingClusterBudgets) && raw.teachingClusterBudgets.some((budget) =>
      Object.hasOwn(asRecord(budget), "relativeWeight")));
  const { courseMinutes: availableMinutes, minMinutes, maxMinutes, source } = knowledgeLectureBudgetBounds(input.course.hours, input.stagePlan);
  const fixed = source === "resource-package";
  const requestedDuration = singleAuthoring && fixed ? minMinutes : finitePositive(raw.durationMin);
  if (!requestedDuration) {
    throw new Error("知识讲授时长判断失败：模型未返回有效的 durationMin。");
  }
  const rationale = text(raw.rationale);
  if (!rationale) {
    qualityIssue("知识讲授时长诊断：模型未说明判断依据。");
  }

  const durationMin = Math.min(
    maxMinutes,
    Math.max(minMinutes, Math.round(requestedDuration)),
  );
  const teachingClusters = deriveKnowledgeTeachingClusters(input.knowledgePoints, input.knowledgeGraph);
  const priorityRequirementList = priorityRequirements(input);
  const requirementById = new Map(priorityRequirementList.map((item) => [item.id, item]));
  const mappedClustersByRequirementId = new Map(priorityRequirementList.map((requirement) => [
    requirement.id,
    teachingClusters.filter((cluster) => clusterRequirementIds(cluster, input).includes(requirement.id)).map((cluster) => cluster.id),
  ]));
  const pointsById = new Map(input.knowledgePoints.map((point) => [point.id, point]));
  const rawBudgets = Array.isArray(raw.teachingClusterBudgets)
    ? raw.teachingClusterBudgets.map(asRecord)
    : [];
  const budgetById = new Map<string, Record<string, unknown>>();
  rawBudgets.forEach((budget) => {
    const id = text(budget.clusterId);
    if (singleAuthoring && (!teachingClusters.some((cluster) => cluster.id === id) || budgetById.has(id)
      || !finitePositive(normalizedBudget ? budget.durationMin : budget.relativeWeight))) {
      qualityIssue("知识讲授时长诊断：知识簇身份或相对投入无效，沿用有效投入并按既有知识簇权重分配缺失部分。");
    }
    if (id && !budgetById.has(id)) budgetById.set(id, budget);
  });
  if (singleAuthoring && budgetById.size !== teachingClusters.length) qualityIssue("知识讲授时长诊断：缺少知识簇投入，按既有知识簇权重分配。");
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
    const applicableRequirementIds = clusterRequirementIds(cluster, input);
    const requirementRationale = text(budget?.rationale);
    const returnedRequirementIds = [...new Set(textArray(budget?.requirementIds).filter((id) => requirementById.has(id)))];
    const difficultyStrategies = (Array.isArray(budget?.difficultyStrategies)
      ? budget.difficultyStrategies.map(asRecord)
      : []).flatMap((strategy) => {
      const requirementId = text(strategy.requirementId);
      const learnerObstacle = text(strategy.learnerObstacle);
      const teachingApproach = text(strategy.teachingApproach);
      const understandingEvidence = text(strategy.understandingEvidence);
      if (requirementById.get(requirementId)?.kind !== "difficulty"
        || !learnerObstacle || !teachingApproach || !understandingEvidence) return [];
      return [{ requirementId, learnerObstacle, teachingApproach, understandingEvidence }];
    });
    for (const requirementId of returnedRequirementIds) {
      if (mappedClustersByRequirementId.get(requirementId)?.length && !applicableRequirementIds.includes(requirementId)) {
        qualityIssue(`知识讲授时长诊断：教学重点或难点被安排到不相关的知识簇“${cluster.title}”。`);
      }
      const requirement = requirementById.get(requirementId)!;
      if (!singleAuthoring && requirement.kind === "difficulty") {
        const strategy = difficultyStrategies.find((item) => item.requirementId === requirementId);
        if (!strategy || /^(?:举例讲解|加强理解|详细讲解|重点讲解)$/u.test(strategy.teachingApproach.replace(/\s+/g, ""))) {
          qualityIssue(`知识讲授时长诊断：知识簇“${cluster.title}”缺少教学难点的具体障碍、讲法或理解证据。`);
        }
      }
    }
    if (returnedRequirementIds.length && !requirementRationale) {
      qualityIssue(`知识讲授时长诊断：知识簇“${cluster.title}”未说明重点或难点如何影响投入。`);
    }
    const legacyWeight = cluster.knowledgePointIds.reduce(
      (sum, id) => sum + (legacyWeightByPointId.get(id) ?? 0),
      0,
    );
    return {
      clusterId: cluster.id,
      title: cluster.title,
      knowledgePointIds: cluster.knowledgePointIds,
      durationMin: singleAuthoring ? (finitePositive(normalizedBudget ? budget?.durationMin : budget?.relativeWeight)
        ?? teachingClusterWeight(cluster, pointsById, input.knowledgeGraph)) : (finitePositive(budget?.durationMin)
        ?? (legacyWeight > 0 ? legacyWeight : teachingClusterWeight(cluster, pointsById, input.knowledgeGraph)))
        * (1 + returnedRequirementIds.reduce((sum, id) => (
          sum + (requirementById.get(id)?.kind === "difficulty" ? 0.35 : 0.25)
        ), 0)),
      rationale: requirementRationale
        || `围绕“${cluster.title}”共享引入、关系解释与案例，覆盖 ${cluster.knowledgePointIds.length} 个相关知识点。`,
      ...(returnedRequirementIds.length ? { requirementIds: returnedRequirementIds } : {}),
      ...(difficultyStrategies.length ? { difficultyStrategies } : {}),
    };
  });
  for (const requirement of priorityRequirementList) {
    const assignedBudgets = teachingClusterBudgets.filter((budget) => budget.requirementIds?.includes(requirement.id));
    const mappedClusterIds = mappedClustersByRequirementId.get(requirement.id) ?? [];
    if (!assignedBudgets.length) {
      qualityIssue(`知识讲授时长诊断：教学${requirement.kind === "highlight" ? "重点" : "难点"}“${requirement.text}”未进入任何知识簇预算。`);
    }
    if (!mappedClusterIds.length && assignedBudgets.length !== 1) {
      qualityIssue(`知识讲授时长诊断：全局教学${requirement.kind === "highlight" ? "重点" : "难点"}“${requirement.text}”必须只安排到一个最相关的知识簇。`);
    }
    for (const sourceId of requirement.sourceKnowledgePointIds) {
      const eligibleClusters = teachingClusters.filter((cluster) => clusterSourceIds(cluster, input).has(sourceId));
      if (!eligibleClusters.length) {
        qualityIssue(`知识讲授时长诊断：教学${requirement.kind === "highlight" ? "重点" : "难点"}“${requirement.text}”关联的知识主题“${sourceId}”未纳入本次知识讲授范围。`);
      }
      if (!eligibleClusters.some((cluster) => assignedBudgets.some((budget) => budget.clusterId === cluster.id))) {
        qualityIssue(`知识讲授时长诊断：教学${requirement.kind === "highlight" ? "重点" : "难点"}“${requirement.text}”关联的知识主题“${sourceId}”未进入任何知识簇预算。`);
      }
    }
  }
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
  const scopeWarning = normalizedBudget && text(raw.scopeWarning) ? text(raw.scopeWarning)
    : unresolvedClusterIds.length > 0 && conflictReason && compressionTried
    ? `${conflictReason}（涉及：${unresolvedClusterIds.map((id) => (
        teachingClusters.find((cluster) => cluster.id === id)?.title ?? id
      )).join("、")}；已尝试：${compressionTried}）`
    : undefined;
  const assumptions = textArray(raw.assumptions);
  if (!fixed && requestedDuration > maxMinutes) {
    assumptions.push(`模型原建议 ${Math.round(requestedDuration)} 分钟；名义计划按整课 40% 参考份额记录为 ${maxMinutes} 分钟，相关知识共享知识簇分配，完整实际讲授可超过参考时间。`);
  }
  if (!fixed && requestedDuration < minMinutes) {
    assumptions.push(`原始建议低于整课 20% 参考份额，名义计划记录为 ${durationMin} 分钟；讲解与节末小测按此参考安排，不要求重复内容填满时间。`);
  }
  assumptions.push(fixed
    ? `保留教师确认的资源包名义安排：知识讲授 ${minMinutes} 分钟，整课 ${availableMinutes} 分钟；参考计划计入讲解、例证、互动和小测，实际讲清必要内容允许超时。`
    : `知识讲授名义计划按整课 ${availableMinutes} 分钟的 20%–40%（${minMinutes}–${maxMinutes} 分钟）分配；实际讲授清晰完整优先，时长仅供参考，必要超时允许。`);

  return {
    ...(qualityDiagnostics.length ? { qualityDiagnostics: [...new Set(qualityDiagnostics)] } : {}),
    ...(singleAuthoring ? { normalizationVersion: "duration-v1" as const } : {}),
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
    assumptions: [...new Set(assumptions)],
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

  const raw = options.aiCall
    ? await options.aiCall(
        messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n"),
        messages.filter((message) => message.role !== "system").map((message) => message.content).join("\n\n"),
      )
    : await (options.modelCall ?? callLLM)(messages, {
        jsonMode: true,
        abortSignal: options.abortSignal,
        requestClass: "long-generation",
        maxTransientRetries: 0,
      });
  try {
    return normalizeNewSystemAiDurationRecommendation(parseLLMJson<unknown>(raw), input, { qualityMode: 'diagnostic' });
  } catch (error) {
    throw invalidGeneratedOutput(error, "知识讲授时长结果无法解析或缺少必要字段");
  }
}
