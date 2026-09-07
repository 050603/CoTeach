import type {
  ActivityRecord,
  AiSupportRecord,
  Course,
  CourseUpload,
  EvaluationDimension,
  ProjectGroup,
  WorkPlanItem,
} from "@/lib/session/types";
import { callLLM, parseLLMJson } from "@/lib/llm/client";
import { throwIfAborted } from "@/lib/openmaic/generation/generation-retry";
import { buildStagePolicyPrompt } from "@/lib/companion/stage-policy";
import {
  deriveTeachingConstraints,
  formatTeachingConstraintsForChinesePrompt,
  type LearnerProfileInput,
} from "@/lib/openmaic/pedagogy/teaching-constraints";
import {
  JSON_TEACHER_PROMPT_CONTRACT,
  promptStageLabel,
} from "@/lib/prompt-quality/policy";
import { isLearningEvidenceStructurallyComplete } from "@/lib/learning-evidence/readiness";
import {
  learningEvidenceKindLabel,
  learningEvidenceStatusLabel,
  learningStageLabel,
} from "@/lib/evaluation/process-assessment";
import {
  normalizeReflectionSummaryDraft,
  latestReflectionSurveyEntries,
  reflectionSummaryCoverage,
  reflectionSummaryMinimumSampleSize,
  reflectionSummarySourceRevision,
  reflectionSummarySourceRefs,
  type ReflectionSummaryTrigger,
} from "@/lib/reflection-summary";
import type { ReflectionClassSummaryV1 } from "@/lib/session/types";
import {
  aggregateKnowledgePointMastery,
  firstKnowledgeLectureAttempts,
} from "@/lib/knowledge-lecture";

export type AiSupportDraft = Omit<
  AiSupportRecord,
  "id" | "courseId" | "createdAt" | "updatedAt" | "studentId" | "studentName"
> & {
  studentId?: string;
  studentName?: string;
};

export type TeacherInterventionSignal = {
  groupId: string;
  groupName: string;
  riskLevel: "high" | "medium" | "low";
  reasons: string[];
  evidence: string[];
  supportCard: string;
};

export type TeacherDashboardAdvice = {
  summary: string;
  actions: Array<{
    title: string;
    detail: string;
    kind: "offline-task" | "patrol" | "next-step";
    studentIds: string[];
  }>;
  generatedAt: string;
  source: "llm";
};

export type ArtifactFocus = "steps" | "evidence" | "risk" | "overall";

const TEACHER_SIGNAL_CACHE_TTL_MS = 120_000;

type TeacherSignalCacheEntry = {
  expiresAt: number;
  promise?: Promise<TeacherInterventionSignal[]>;
  value?: TeacherInterventionSignal[];
};

type TeacherDashboardAdviceCacheEntry = {
  expiresAt: number;
  promise?: Promise<TeacherDashboardAdvice>;
  value?: TeacherDashboardAdvice;
};

export type SupportCallOptions = { abortSignal?: AbortSignal };

export type LearnerProfileSuggestion = {
  priorKnowledge: string;
  learningNeeds: string;
  familiarContexts: string;
};

export type ProjectSkeletonTarget =
  | "courseHours"
  | "learningObjectives"
  | "summary"
  | "learnerProfile"
  | "drivingQuestions";

const teacherSignalCache = new Map<string, TeacherSignalCacheEntry>();
const teacherDashboardAdviceCache = new Map<string, TeacherDashboardAdviceCacheEntry>();

// ============================================================
// 第一部分：LLM 调用辅助函数
// ============================================================

/**
 * 调用 LLM 生成结构化 JSON 结果。
 * - LLM 不可用、限流或返回结构错误时直接抛错，由界面提示用户
 * - 统一使用系统 LLM 配置（ai-settings.json / server-providers.yml / env）
 */
async function callLLMForJson<T = unknown>(
  systemPrompt: string,
  userPrompt: string,
  opts: { abortSignal?: AbortSignal } = {},
): Promise<T> {
  const text = await callLLM(
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    { jsonMode: true, abortSignal: opts.abortSignal },
  );
  return parseLLMJson<T>(text);
}

function invalidAiResult(scope: string): never {
  throw new Error(`${scope}失败：AI 返回结构不完整，请检查模型输出后重试。`);
}

export { isStrongPblDrivingQuestion } from "@/lib/pbl-driving-question";
import { isStrongPblDrivingQuestion } from "@/lib/pbl-driving-question";

function cleanStringList(value: unknown, limit = 5): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function normalizeObjectiveOptions(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  if (value.every((item) => typeof item === "string")) {
    const singleOption = cleanStringList(value);
    return singleOption.length ? [singleOption] : [];
  }
  return value
    .filter((item): item is unknown[] => Array.isArray(item))
    .map((item) => cleanStringList(item))
    .filter((item) => item.length > 0)
    .slice(0, 3);
}

function normalizeLearnerProfileOptions(value: unknown): LearnerProfileSuggestion[] {
  const values = Array.isArray(value) ? value : value && typeof value === "object" ? [value] : [];
  return values
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      priorKnowledge: String(item.priorKnowledge ?? item.foundation ?? "").trim(),
      learningNeeds: String(item.learningNeeds ?? item.difficulties ?? "").trim(),
      familiarContexts: String(item.familiarContexts ?? item.contexts ?? "").trim(),
    }))
    .filter((item) => item.priorKnowledge && item.learningNeeds && item.familiarContexts)
    .slice(0, 3);
}

function normalizeCourseHourOptions(value: unknown): Array<{ hours: number; rationale: string; scope: string }> {
  const values = Array.isArray(value) ? value : [];
  const seen = new Set<number>();
  return values
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
    .map((item) => ({
      hours: Math.round(Number(item.hours ?? item.recommendedHours)),
      rationale: String(item.rationale ?? item.reason ?? "").trim(),
      scope: String(item.scope ?? item.contentScope ?? "").trim(),
    }))
    .filter((item) => item.hours >= 1 && item.hours <= 5 && item.rationale && item.scope)
    .filter((item) => {
      if (seen.has(item.hours)) return false;
      seen.add(item.hours);
      return true;
    })
    .slice(0, 3);
}

const SYSTEM_PREAMBLE = `你是一名资深的 PBL（项目式学习）教学支架专家，擅长基于学生当前的项目进度给出具体、可执行、可验证的改进建议。
请始终以严格 JSON 形式返回结果，不要包含任何额外说明文字。
所有建议必须基于学生实际填写的内容，避免空话套话，每条建议应能被学生立即执行并验证。
学生是个人项目的唯一负责人。不得代替学生完成最终作品；优先提问、提示、比较选项和反馈，不替学生作最终决定，并要求学生说明采纳或拒绝建议的理由。

${JSON_TEACHER_PROMPT_CONTRACT}`;

function stageSystemPrompt(stageKey: string): string {
  return `${SYSTEM_PREAMBLE}\n\n${buildStagePolicyPrompt(stageKey)}`;
}

// ============================================================
// 第二部分：个人方案诊断（阶段三）
// ============================================================

/**
 * 诊断学生个人项目方案（异步版，真实 LLM 生成）。
 * 用于阶段三“方案构思与校准”。
 */
export async function diagnoseGroupIdea(input: {
  course: Course;
  group: ProjectGroup;
  tasks: WorkPlanItem[];
}, opts: SupportCallOptions = {}): Promise<AiSupportDraft> {
  throwIfAborted(opts.abortSignal);
  const { course, group, tasks } = input;

  const llmResult = await callLLMForJson<{
    diagnosis: string;
    suggestions: string[];
    evidence: string[];
  }>(
    stageSystemPrompt("proposal"),
    `请诊断以下学生的个人项目方案，给出诊断结论、3-5 条具体建议和依据。

课程名称：${course.name}
驱动问题：${course.drivingQuestion || "（无）"}
个人项目：${group.name}
选题：${group.topic || "未填写"}
项目目标：${group.goal || "未填写"}
成果形式：${group.selectedForms.join("、") || "未选择"}
项目负责人：${group.members[0]?.name ?? "未关联学生"}
实施任务：
${tasks.map((t) => `- ${t.task}，进度 ${t.progress}%`).join("\n") || "（暂无任务）"}

要求：
1. diagnosis：1-2 句话判断方案成熟度（高/中/低），指出最关键的卡点
2. suggestions：3-5 条可立即执行的建议，每条聚焦一个改进点（选题/目标/成果/分工/证据/AI使用计划）
3. evidence：列出诊断依据，引用学生实际填写的内容

仅返回 JSON：{ "diagnosis": "string", "suggestions": ["string"], "evidence": ["string"] }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult && llmResult.diagnosis) {
    return {
      stageKey: "proposal",
      targetType: "student",
      targetId: group.members[0]?.studentId ?? group.id,
      groupId: group.id,
      kind: "idea-check",
      trigger: "检查我的方案",
      inputSummary: `课程：${course.name}；个人项目：${group.name}；选题：${group.topic || "未填写"}；任务数：${tasks.length}`,
      diagnosis: llmResult.diagnosis,
      suggestions: llmResult.suggestions?.slice(0, 5) ?? invalidAiResult("个人方案诊断"),
      evidence: llmResult.evidence?.slice(0, 5) ?? invalidAiResult("个人方案诊断"),
      status: "draft",
      source: "llm",
    };
  }
  return invalidAiResult("个人方案诊断");
}

// ============================================================
// 第三部分：项目作品诊断（阶段五）
// ============================================================

/**
 * 诊断项目作品（异步版，真实 LLM 生成）。
 * 用于阶段五"项目制作与 AI 实时支架"。
 */
export async function diagnoseProjectArtifact(input: {
  course: Course;
  group: ProjectGroup;
  stageKey: string;
  documentHtml: string;
  uploads: CourseUpload[];
  tasks: WorkPlanItem[];
  focus?: ArtifactFocus;
}, opts: SupportCallOptions = {}): Promise<AiSupportDraft> {
  throwIfAborted(opts.abortSignal);
  const { course, group, documentHtml, uploads, tasks, focus = "overall" } = input;

  const focusText = focusLabel(focus);
  const documentText = plainText(documentHtml).slice(0, 4000); // 截断避免超长

  const llmResult = await callLLMForJson<{
    diagnosis: string;
    suggestions: string[];
    evidence: string[];
  }>(
    stageSystemPrompt(input.stageKey),
    `请诊断以下学生的个人项目作品文档，聚焦"${focusText}"维度，给出诊断结论、3-5 条具体建议和依据。

课程名称：${course.name}
驱动问题：${course.drivingQuestion || "（无）"}
个人项目：${group.name}
选题：${group.topic || "未填写"}
当前聚焦：${focusText}
文档字数：约 ${plainText(documentHtml).length} 字
已上传材料：${uploads.map((u) => `${u.title}（${u.fileType}）`).join("、") || "无"}
任务进度：
${tasks.map((t) => `- ${t.memberName ?? "未指派"}：${t.task}（${t.progress}%）`).join("\n") || "（暂无任务）"}

文档内容（截断到 4000 字）：
${documentText}

要求：
1. diagnosis：1-2 句话判断作品当前可推进度，指出最关键的缺口
2. suggestions：3-5 条可立即执行的建议，聚焦"${focusText}"维度
3. evidence：列出诊断依据，引用文档实际内容

仅返回 JSON：{ "diagnosis": "string", "suggestions": ["string"], "evidence": ["string"] }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult && llmResult.diagnosis) {
    return {
      stageKey: input.stageKey,
      targetType: "student",
      targetId: group.members[0]?.studentId ?? group.id,
      groupId: group.id,
      kind: "artifact-diagnosis",
      trigger: `AI 诊断：${focusText}`,
      inputSummary: `课程：${course.name}；个人项目：${group.name}；文档字数：${plainText(documentHtml).length}；上传材料：${uploads.length}`,
      diagnosis: llmResult.diagnosis,
      suggestions: llmResult.suggestions?.slice(0, 5) ?? invalidAiResult("作品诊断"),
      evidence: llmResult.evidence?.slice(0, 5) ?? invalidAiResult("作品诊断"),
      status: "draft",
      source: "llm",
    };
  }
  return invalidAiResult("作品诊断");
}

// ============================================================
// 第四部分：汇报教练（阶段六）
// ============================================================

/**
 * 构建汇报教练建议（异步版，真实 LLM 生成）。
 * 用于阶段六"最终汇报展示"。
 */
export async function buildShowcaseCoach(input: {
  course: Course;
  group: ProjectGroup;
  uploads: CourseUpload[];
  activities: ActivityRecord[];
  aiSupports: AiSupportRecord[];
}, opts: SupportCallOptions = {}): Promise<AiSupportDraft> {
  throwIfAborted(opts.abortSignal);
  const { course, group, uploads, activities, aiSupports } = input;

  const llmResult = await callLLMForJson<{
    diagnosis: string;
    suggestions: string[];
    evidence: string[];
  }>(
    stageSystemPrompt("showcase"),
    `请为以下学生的个人成果汇报给出教练建议，覆盖作品质量、过程证据、独立决策和 AI 使用边界。

课程名称：${course.name}
个人项目：${group.name}
选题：${group.topic || "未填写"}
项目目标：${group.goal || "未填写"}
已上传材料：${uploads.map((u) => `${u.title}（${u.fileType}）`).join("、") || "无"}
过程活动记录：${activities.length} 条
AI 支架记录：${aiSupports.length} 条（已采纳 ${aiSupports.filter((s) => s.status === "student-applied").length} 条）

要求：
1. diagnosis：1-2 句话判断汇报准备度，指出最需要补强的环节
2. suggestions：3-5 条汇报准备建议，每条可立即执行（如"准备 6-8 页汇报稿，按问题证据→方案设计→验证过程→反思改进组织"）
3. evidence：列出建议依据，引用学生已有材料和过程记录

仅返回 JSON：{ "diagnosis": "string", "suggestions": ["string"], "evidence": ["string"] }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult && llmResult.diagnosis) {
    return {
      stageKey: "showcase",
      targetType: "student",
      targetId: group.members[0]?.studentId ?? group.id,
      groupId: group.id,
      kind: "showcase-coach",
      trigger: "AI 汇报教练",
      inputSummary: `课程：${course.name}；个人项目：${group.name}；上传材料：${uploads.length}；过程记录：${activities.length}`,
      diagnosis: llmResult.diagnosis,
      suggestions: llmResult.suggestions?.slice(0, 5) ?? invalidAiResult("汇报教练建议"),
      evidence: llmResult.evidence?.slice(0, 5) ?? invalidAiResult("汇报教练建议"),
      status: "draft",
      source: "llm",
    };
  }
  return invalidAiResult("汇报教练建议");
}

// ============================================================
// 第五部分：反思证据提示（旧版阶段六 / 新版阶段五）
// ============================================================

/**
 * 构建反思证据提示（异步版，真实 LLM 生成）。
 * 用于旧版阶段六“学习反思”和新版阶段五轻量反思表单。
 */
export async function buildReflectionEvidencePrompts(input: {
  course: Course;
  group?: ProjectGroup;
  studentId: string;
  format?: "full" | "compact";
}, opts: SupportCallOptions = {}): Promise<AiSupportDraft> {
  throwIfAborted(opts.abortSignal);
  const { course, group, studentId, format = "full" } = input;

  const student = course.students.find((item) => item.id === studentId);
  const stageProgress = student?.stageProgress?.reflection ?? 0;
  const aiLearningProgress = course.aiLearningProgress?.[studentId];
  const supports = (course.aiSupports ?? []).filter(
    (item) => item.studentId === studentId || (group && item.groupId === group.id),
  );
  const uploads = (course.uploads ?? []).filter(
    (item) => item.studentId === studentId || (group && item.groupId === group.id),
  );
  const submissions = (course.submissions ?? [])
    .filter((item) => item.studentId === studentId || (group && item.groupId === group.id))
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8);
  const teacherFeedback = (course.feedback ?? [])
    .filter((item) => item.targetId === studentId || item.targetId === group?.id || item.targetId === course.id)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 8);
  const rubricScores = (course.rubricScores ?? [])
    .filter((item) => item.groupId === group?.id)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 5);
  const evaluations = (course.evaluations ?? [])
    .filter((item) => item.targetId === studentId || item.targetId === group?.id)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8);
  const reflections = (course.reflections ?? [])
    .filter((item) => item.studentId === studentId)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 3);
  const learningEvents = (course.learningEvents ?? [])
    .filter((item) => item.studentId === studentId)
    .sort((a, b) => new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime())
    .slice(0, 12);

  const context = `课程名称：${course.name}
学生姓名：${student?.name ?? "未识别学生"}
个人项目：${group?.name ?? "（项目空间待同步）"}
选题：${group?.topic ?? "（无）"}
阶段进度：学习反思与迁移=${stageProgress}%；知识讲授=${formatAiLearningProgress(aiLearningProgress)}
AI 支架记录：${supports.length} 条
  - 已采纳：${supports.filter((s) => s.status === "student-applied").length} 条
  - 未采纳：${supports.filter((s) => s.status !== "student-applied" && s.status !== "dismissed").length} 条
已上传材料：${uploads.length} 个
  - 证据类：${uploads.filter((u) => u.category === "evidence").length} 个

前序阶段提交成果：
${submissions.map((s) => `- [${learningStageLabel(s.stageKey, course.stages)}] ${s.title}：${plainText(s.content).slice(0, 1000)}（${s.updatedAt}）`).join("\n") || "（无）"}

教师反馈：
${teacherFeedback.map((f) => `- [${learningStageLabel(f.stageKey, course.stages)}] ${plainText(f.content).slice(0, 700)}${f.evidence?.length ? `；证据：${f.evidence.join("；")}` : ""}`).join("\n") || "（无）"}

评分记录（必须区分教师评分、AI评分和最终评分）：
${rubricScores.map((s) => `- 教师总分=${s.teacherTotal ?? "无"}；AI总分=${s.aiTotal ?? "无"}；最终分=${s.finalTotal ?? "无"}；记录总分=${s.total}；教师维度=${JSON.stringify(s.dimensionScores)}；AI维度=${JSON.stringify(s.aiDimensionScores ?? {})}；AI过程总结=${plainText(s.aiProcessSummary ?? "无")}；AI过程证据=${(s.aiProcessEvidence ?? []).join("、") || "无"}；教师评语=${plainText(s.comment)}`).join("\n") || "（无）"}

AI/教师评价记录：
${evaluations.map((e) => `- [${evaluationSourceLabel(e.sourceRole)}/${learningStageLabel(e.stageKey, course.stages)}] 分数=${e.score ?? "未记录"}；${plainText(e.comment)}；证据=${e.evidence.join("；") || "未记录"}`).join("\n") || "（无）"}

学生已有反思：
${reflections.map((r) => `- 正文：${plainText(r.content).slice(0, 1200)}；改进计划：${plainText(r.improvementPlan ?? "")}`).join("\n") || "（无）"}

学生过程事件：
${learningEvents.map((event) => `- [${learningStageLabel(event.stageKey, course.stages)}] ${event.content?.sceneTitle || event.content?.activityTitle || event.progressMarker || "产生一条学习活动记录"}${event.durationMs ? `；持续约 ${Math.max(1, Math.round(event.durationMs / 60000))} 分钟` : ""}（${event.occurredAt}）`).join("\n") || "（无）"}

最近的 AI 支架记录：
${supports.slice(0, 6).map((s) => `- ${s.trigger}：${s.diagnosis}；建议=${s.suggestions.join("；")}；依据=${s.evidence.join("；")}；采纳情况=${supportAdoptionLabel(s.adoption?.decision)}`).join("\n") || "（无）"}`;

  const userPrompt = format === "compact"
    ? `请为新版五阶段“学习反思”表单生成两条简短引导。引导只能帮助学生回忆真实经历，不能替学生写答案，也不能给出评分或结论。

${context}

要求：
1. diagnosis：一句话说明本次反思关注点。
2. suggestions：严格返回 2 条。第一条启发学生同时回顾“主要收获”和“常见困难”，第二条启发学生同时回顾“AI 协作看法”和“下一轮课程改进”；每条不超过 60 个汉字，必须是启发式问句，不复述学生具体经历，不提供示例答案，不评价答案。
3. evidence：列出最多 2 条可引用的真实过程证据。

仅返回 JSON：{ "diagnosis": "string", "suggestions": ["string", "string"], "evidence": ["string"] }`
    : `请为以下学生生成反思证据提示，引导学生基于过程证据进行反思，而不是泛泛描述感受。

${context}

要求：
1. diagnosis：1-2 句话指出该学生反思应聚焦的证据类型
2. suggestions：3-5 条反思提示，每条引导学生引用具体的过程证据（如“选择一条你们采纳过的 AI 建议，写清它解决了什么问题以及你们如何验证它”）
3. evidence：列出可引用的过程证据

仅返回 JSON：{ "diagnosis": "string", "suggestions": ["string"], "evidence": ["string"] }`;

  const llmResult = await callLLMForJson<{
    diagnosis: string;
    suggestions: string[];
    evidence: string[];
  }>(
    stageSystemPrompt("reflection"),
    userPrompt,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult && llmResult.diagnosis) {
    const suggestions = (llmResult.suggestions ?? [])
      .filter((suggestion): suggestion is string => typeof suggestion === "string")
      .map((suggestion) => suggestion.trim())
      .filter(Boolean)
      .map((suggestion) => format === "compact" ? suggestion.slice(0, 60) : suggestion);
    const compactSuggestions = suggestions.filter((suggestion) => /[？?]$/.test(suggestion)).slice(0, 2);
    if (format === "compact" && compactSuggestions.length < 2) {
      return invalidAiResult("紧凑反思提示");
    }
    return {
      stageKey: "reflection",
      targetType: "student",
      targetId: studentId,
      groupId: group?.id,
      studentId,
      studentName: student?.name ?? "未识别学生",
      kind: "reflection-evidence",
      trigger: "AI 反思证据提示",
      inputSummary: `课程：${course.name}；学生：${student?.name ?? "未识别学生"}；个人项目：${group?.name ?? "待同步"}；支架记录：${supports.length}`,
      diagnosis: llmResult.diagnosis,
      suggestions: format === "compact" ? compactSuggestions : suggestions.slice(0, 5),
      evidence: llmResult.evidence?.slice(0, 5) ?? invalidAiResult("反思证据提示"),
      status: "draft",
      source: "llm",
    };
  }
  return invalidAiResult("反思证据提示");
}

// ============================================================
// 第五部分：新版五阶段班级反思摘要
// ============================================================

/**
 * 生成教师端课程级反思摘要。
 *
 * 送入模型的学生身份始终是一次性临时 ID，主题词的来源字段和学生 ID
 * 会在服务端重新映射并校验，弹窗原文不依赖模型返回的任何引文。
 */
export async function buildReflectionClassSummary(
  input: { course: Course; trigger: ReflectionSummaryTrigger },
  opts: SupportCallOptions = {},
): Promise<AiSupportDraft> {
  throwIfAborted(opts.abortSignal);
  const { course, trigger } = input;
  const entries = latestReflectionSurveyEntries(course);
  const minimumSampleSize = reflectionSummaryMinimumSampleSize(course.students.length);
  if (entries.length < minimumSampleSize) {
    throw new Error(`反思样本不足：至少需要 ${minimumSampleSize} 份有效反思。`);
  }

  const aliasByStudentId = new Map(
    entries.map((entry, index) => [entry.studentId, `respondent-${index + 1}`]),
  );
  const promptRows = entries.map(({ survey, studentId }) => ({
    studentId: aliasByStudentId.get(studentId),
    learningReflection: survey.learningReflection,
    systemReflection: survey.systemReflection,
    scores: {
      aiHelpfulness: survey.aiHelpfulness,
      systemUsability: survey.systemUsability,
      reuseIntention: survey.reuseIntention,
    },
  }));
  const userPrompt = `请分析以下新版五阶段“学习反思”数据，生成教师可直接使用的课程洞察。

课程背景：${course.name}（${course.subject}，${course.grade}）
有效反思数：${entries.length}/${course.students.length}
触发方式：${trigger}
字段含义：learningReflection 同时回答“主要收获”和“常见困难”；systemReflection 同时回答“AI 协作看法”和“下一轮课程改进”。

重要约束：
1. 不得输出、推断或改写学生姓名；只能使用输入中的临时 studentId。
2. 只能根据真实回答归纳，不得补造主题。证据不足的类别 summary 必须写“当前反思中尚未形成明确共识”，terms 返回空数组。
3. 每个主题词必须给出来源 studentId 和原文字段 fields；fields 只能是 learningReflection 或 systemReflection。
4. 主题词最多 16 个，去掉重复词。不要生成或保存引文，来源映射足够。
5. studentSummaries 为每位有效反思各写一句不超过 140 字的摘要，不得添加回答中不存在的事实。
6. teachingRecommendations 返回所有当前重要且能由教师执行的课程改进建议，不设固定条数；每条必须对应一个彼此独立的共性问题，相近问题合并处理，没有充分共性证据时返回空数组，禁止凑数或逐生罗列。

固定四类 categories key：learning-gains、common-difficulties、ai-collaboration、course-improvements。

数据：
${JSON.stringify(promptRows)}

仅返回 JSON：
{
  "courseSummary": "string",
  "teachingRecommendations": ["string", "string"],
  "categories": [
    { "key": "learning-gains", "summary": "string", "terms": [{ "label": "string", "sources": [{ "studentId": "respondent-1", "fields": ["learningReflection"] }] }] },
    { "key": "common-difficulties", "summary": "string", "terms": [] },
    { "key": "ai-collaboration", "summary": "string", "terms": [] },
    { "key": "course-improvements", "summary": "string", "terms": [] }
  ],
  "studentSummaries": [{ "studentId": "respondent-1", "summary": "string" }]
}`;

  const llmResult = await callLLMForJson<unknown>(
    stageSystemPrompt("reflection"),
    userPrompt,
    { abortSignal: opts.abortSignal },
  );
  const draft = normalizeReflectionSummaryDraft(llmResult, new Set(aliasByStudentId.values()));
  if (!draft) return invalidAiResult("班级反思摘要");
  if (draft.studentSummaries.length < entries.length) return invalidAiResult("班级反思逐生摘要");

  const coverage = reflectionSummaryCoverage(course);
  const sourceRefs = reflectionSummarySourceRefs(course);
  const studentIdByAlias = new Map(
    [...aliasByStudentId.entries()].map(([studentId, alias]) => [alias, studentId]),
  );
  const summary: ReflectionClassSummaryV1 = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    coveragePercent: coverage.coveragePercent,
    coverageBucket: coverage.coverageBucket,
    trigger,
    responseCount: entries.length,
    totalStudentCount: course.students.length,
    sourceRevision: reflectionSummarySourceRevision(course),
    sourceRefs,
    courseSummary: draft.courseSummary,
    teachingRecommendations: draft.teachingRecommendations,
    categories: draft.categories.map((category) => ({
      ...category,
      terms: category.terms.map((term) => ({
        ...term,
        sources: term.sources.flatMap((source) => {
          const studentId = studentIdByAlias.get(source.studentId);
          return studentId ? [{ ...source, studentId }] : [];
        }),
      })).filter((term) => term.sources.length),
    })),
    studentSummaries: draft.studentSummaries.flatMap((item) => {
      const studentId = studentIdByAlias.get(item.studentId);
      return studentId ? [{ studentId, summary: item.summary }] : [];
    }),
  };

  return {
    stageKey: "reflection",
    targetType: "course",
    targetId: course.id,
    kind: "reflection-class-summary",
    trigger: `AI 课程总结（${trigger}）`,
    inputSummary: `课程：${course.name}；有效反思：${entries.length}/${course.students.length}；覆盖档位：${coverage.coverageBucket}%`,
    diagnosis: summary.courseSummary,
    suggestions: summary.teachingRecommendations,
    evidence: sourceRefs.map((source) => `反思记录 ${source.reflectionId}`),
    status: "draft",
    source: "llm",
    structuredPayload: summary,
  };
}

// ============================================================
// 第六部分：教师干预信号（全阶段，教师监控面板）
// ============================================================

/**
 * 构建教师干预信号（异步版，真实 LLM 生成）。
 * 用于教师监控面板"AI 构思质量雷达"和"AI 实时干预建议"。
 *
 * 注意：本函数对每个个人项目分别调用 LLM 可能成本过高，
 * 这里采用批量方式：让 LLM 一次分析所有学生项目。
 */
export async function buildTeacherInterventionSignals(
  course: Course,
  stageKey: string,
  opts: SupportCallOptions = {},
): Promise<TeacherInterventionSignal[]> {
  throwIfAborted(opts.abortSignal);
  // 如果没有个人项目，直接返回空数组
  if (!course.groups?.length) return [];

  const cacheKey = teacherSignalCacheKey(course, stageKey);
  const useCache = !opts.abortSignal;
  if (useCache) {
    const cached = teacherSignalCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.value) return cached.value;
      if (cached.promise) return cached.promise;
    }
  }

  const promise: Promise<TeacherInterventionSignal[]> = callLLMForJson<{
    groups: Array<{
      groupId: string;
      riskLevel: "high" | "medium" | "low";
      reasons: string[];
      evidence: string[];
      supportCard: string;
    }>;
  }>(
    stageSystemPrompt(stageKey),
    `请分析以下课程所有学生个人项目的当前状态，识别需要教师干预的学生，并给出干预建议。

课程名称：${course.name}
驱动问题：${course.drivingQuestion || "（无）"}
当前阶段：${promptStageLabel(stageKey, learningStageLabel(stageKey, course.stages))}

个人项目列表：
${course.groups.map((g) => {
  const groupTasks = (course.workPlan ?? []).filter((task) => task.groupId === g.id);
  const groupUploads = (course.uploads ?? []).filter((upload) => upload.groupId === g.id);
  const groupSupports = (course.aiSupports ?? []).filter((support) => support.groupId === g.id);
  const progress = averageGroupProgress(course, g, stageKey);
  return `个人项目 ${g.id} - ${g.name}：
  - 选题：${g.topic || "未填写"}
  - 目标：${g.goal || "未填写"}
  - 成果形式：${g.selectedForms.join("、") || "未选择"}
  - 学生：${g.members[0]?.name ?? "未关联"}
  - 任务数：${groupTasks.length}
  - 上传材料：${groupUploads.length} 个
  - AI 支架记录：${groupSupports.length} 条（已采纳 ${groupSupports.filter((s) => s.status === "student-applied").length}）
  - 阶段进度：${progress}%`;
}).join("\n\n")}

要求：
1. 仅返回 riskLevel 为 high 或 medium 的个人项目（low 的项目不需要教师干预）
2. reasons：1-3 条干预理由（如"选题偏离驱动问题""进度偏低""AI 建议多次未采纳"）
3. evidence：引用学生个人项目的实际数据作为依据
4. supportCard：1-2 句具体的教师干预建议（如"建议教师先确认学生卡点：选题偏离；再要求其在 10 分钟内提交一个可检查的小证据"）

仅返回 JSON：{ "groups": [{ "groupId": "string", "riskLevel": "high"|"medium"|"low", "reasons": ["string"], "evidence": ["string"], "supportCard": "string" }] }`,
    { abortSignal: opts.abortSignal },
  ).then((llmResult) => {
    if (Array.isArray(llmResult?.groups)) {
      // 将 LLM 结果与本地个人项目兼容容器合并。
      const groupMap = new Map((course.groups ?? []).map((g) => [g.id, g]));
      return llmResult.groups
        .filter((item) => item.riskLevel !== "low" && groupMap.has(item.groupId))
        .map((item) => {
          const group = groupMap.get(item.groupId)!;
          return {
            groupId: item.groupId,
            groupName: group.name,
            riskLevel: item.riskLevel,
            reasons: item.reasons?.slice(0, 3) ?? [],
            evidence: item.evidence?.slice(0, 3) ?? [],
            supportCard: item.supportCard ?? "",
          };
        })
        .sort((a, b) => riskWeight(b.riskLevel) - riskWeight(a.riskLevel));
    }
    return invalidAiResult("教师 AI 观察");
  });

  if (useCache) {
    teacherSignalCache.set(cacheKey, {
      expiresAt: Date.now() + TEACHER_SIGNAL_CACHE_TTL_MS,
      promise,
    });
  }
  const result = await promise;
  if (useCache) {
    teacherSignalCache.set(cacheKey, {
      expiresAt: Date.now() + TEACHER_SIGNAL_CACHE_TTL_MS,
      value: result,
    });
  }
  return result;
}

/**
 * Generate the compact teacher-side advice shown beside the five-stage
 * classroom. The model receives only a bounded snapshot of this course and
 * must return no action when the evidence is insufficient. There is
 * deliberately no rule-based or generic fallback.
 */
export async function buildTeacherDashboardAdvice(
  course: Course,
  stageKey: string,
  opts: SupportCallOptions = {},
): Promise<TeacherDashboardAdvice> {
  throwIfAborted(opts.abortSignal);
  const studentIds = new Set(course.students.map((student) => student.id));
  const studentNameById = new Map(course.students.map((student) => [student.id, student.name]));
  const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const humanizeStudentReferences = (value: string) => {
    let result = value;
    for (const [studentId, studentName] of studentNameById) {
      const escapedId = escapeRegExp(studentId);
      result = result
        .replace(new RegExp(`(?:该?学生|同学)?\\s*[（(]\\s*ID\\s*[：:]\\s*${escapedId}\\s*[）)]`, "gi"), studentName)
        .replace(new RegExp(`ID\\s*[：:]\\s*${escapedId}`, "gi"), studentName)
        .replace(new RegExp(escapedId, "g"), studentName);
    }
    return result.replace(/\s{2,}/g, " ").trim();
  };
  const containsInternalStudentId = (value: string) => /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/i.test(value);
  const severityRank = { high: 3, warning: 2, notice: 1 } as const;
  const normalizeIssue = (value: string) => value.trim().toLocaleLowerCase("zh-CN").replace(/[\s，。；：、,.!！?？()（）【】\[\]_-]+/g, "");
  type IssueGroup = {
    title: string;
    summary: string;
    severity: keyof typeof severityRank;
    studentIds: Set<string>;
    lastDetectedAt?: string;
    sources: Set<"class-common-issue" | "learning-signal">;
  };
  const issueGroupMap = new Map<string, IssueGroup>();
  const addIssue = (input: Omit<IssueGroup, "studentIds" | "sources"> & { studentIds: string[]; source: "class-common-issue" | "learning-signal"; normalizedIssueKey?: string }) => {
    const key = normalizeIssue(input.normalizedIssueKey ?? "") || normalizeIssue(input.title) || normalizeIssue(input.summary);
    if (!key) return;
    const current = issueGroupMap.get(key);
    if (!current) {
      issueGroupMap.set(key, { ...input, studentIds: new Set(input.studentIds.filter((id) => studentIds.has(id))), sources: new Set([input.source]) });
      return;
    }
    input.studentIds.forEach((id) => {
      if (studentIds.has(id)) current.studentIds.add(id);
    });
    current.sources.add(input.source);
    if (severityRank[input.severity] > severityRank[current.severity]) current.severity = input.severity;
    if (input.summary.length > current.summary.length) current.summary = input.summary;
    if (Date.parse(input.lastDetectedAt ?? "") > Date.parse(current.lastDetectedAt ?? "")) current.lastDetectedAt = input.lastDetectedAt;
  };
  (course.classCommonIssues ?? [])
    .filter((issue) => issue.stageKey === stageKey && issue.status === "open")
    .forEach((issue) => addIssue({
      title: issue.title,
      summary: issue.summary,
      normalizedIssueKey: issue.normalizedIssueKey,
      severity: issue.severity,
      studentIds: issue.studentIds,
      lastDetectedAt: issue.lastDetectedAt,
      source: "class-common-issue",
    }));
  (course.learningSignals ?? [])
    .filter((signal) => signal.stageKey === stageKey && signal.status === "open")
    .forEach((signal) => addIssue({
      title: signal.title,
      summary: signal.summary,
      normalizedIssueKey: signal.normalizedIssueKey,
      severity: signal.severity,
      studentIds: [signal.studentId],
      lastDetectedAt: signal.lastDetectedAt,
      source: "learning-signal",
    }));
  const sortedIssueGroups = [...issueGroupMap.values()]
    .sort((left, right) => severityRank[right.severity] - severityRank[left.severity]
      || right.studentIds.size - left.studentIds.size
      || Date.parse(right.lastDetectedAt ?? "") - Date.parse(left.lastDetectedAt ?? ""))
    .slice(0, 20);
  const issueGroups = sortedIssueGroups.map((issue, index) => ({
      evidenceKey: `issue-${index + 1}`,
      title: issue.title,
      summary: issue.summary,
      severity: issue.severity,
      affectedStudentCount: issue.studentIds.size,
      affectedStudentIds: [...issue.studentIds].slice(0, 12),
      lastDetectedAt: issue.lastDetectedAt,
      sources: [...issue.sources],
    }));
  const stageEvents = (course.learningEvents ?? [])
    .filter((event) => event.stageKey === stageKey)
    .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
    .slice(0, 80);
  const eventCounts = stageEvents.reduce<Record<string, number>>((counts, event) => {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
    return counts;
  }, {});
  const progressRows = course.students.map((student) => ({ studentId: student.id, progress: student.stageProgress?.[stageKey] }));
  const progressSummary = {
    evidenceKey: "progress-summary",
    totalStudentCount: course.students.length,
    noRecordCount: progressRows.filter((row) => row.progress === undefined).length,
    notStartedCount: progressRows.filter((row) => row.progress !== undefined && row.progress <= 0).length,
    learningCount: progressRows.filter((row) => row.progress !== undefined && row.progress > 0 && row.progress < 100).length,
    completedCount: progressRows.filter((row) => row.progress !== undefined && row.progress >= 100).length,
    lowProgressStudentCount: progressRows.filter((row) => row.progress !== undefined && row.progress <= 25).length,
    lowProgressStudentIds: progressRows.filter((row) => row.progress !== undefined && row.progress <= 25).map((row) => row.studentId).slice(0, 12),
  };
  const launchResources = (course.resources ?? [])
    .filter((resource) => resource.stageKey === "launch" || !resource.stageKey)
    .filter((resource, index, all) => all.findIndex((candidate) => candidate.id === resource.id) === index);
  const launchRows = course.students.map((student) => {
    const states = launchResources.map((resource) => {
      const events = (course.learningEvents ?? [])
        .filter((event) => event.stageKey === "launch" && event.studentId === student.id)
        .filter((event) => (typeof event.metadata?.resourceId === "string" ? event.metadata.resourceId : event.sceneId) === resource.id)
        .filter((event) => event.metadata?.source !== "teacher-projection")
        .filter((event, index, all) => all.findIndex((candidate) => (candidate.idempotencyKey || candidate.id) === (event.idempotencyKey || event.id)) === index);
      const opened = events.some((event) => ["resource-open", "resource-progress", "resource-complete"].includes(event.type))
        || (resource.downloadedBy ?? []).includes(student.id);
      const completed = events.some((event) => event.type === "resource-complete"
        || event.progressMarker === "completed"
        || (typeof event.metadata?.progressPercent === "number" && event.metadata.progressPercent >= 90));
      return { opened, completed };
    });
    return {
      studentId: student.id,
      openedCount: states.filter((state) => state.opened).length,
      completedCount: states.filter((state) => state.completed).length,
    };
  });
  const knowledgeRows = course.students.map((student) => {
    const progress = course.aiLearningProgress?.[student.id];
    const attempts = firstKnowledgeLectureAttempts(progress);
    const total = Math.max(0, progress?.totalScenes ?? 0);
    const completed = Math.max(progress?.completedScenes?.length ?? 0, progress?.currentSceneIndex ?? 0);
    const progressPercent = total > 0 ? Math.min(100, Math.round(completed / total * 100)) : student.stageProgress?.[stageKey];
    return {
      studentId: student.id,
      progressPercent,
      quizCount: attempts.length,
      averageQuizScore: attempts.length
        ? Math.round(attempts.reduce((sum, attempt) => sum + (attempt.maxScore > 0 ? attempt.score / attempt.maxScore * 100 : 0), 0) / attempts.length)
        : undefined,
      incorrectAnswerCount: attempts.flatMap((attempt) => attempt.questions).filter((question) => question.correct === false || (question.points > 0 && question.earned / question.points < 0.8)).length,
    };
  });
  const knowledgeMastery = stageKey === "ai-learning" ? aggregateKnowledgePointMastery(course) : [];
  const makeArtifactStudentIds = new Set([
    ...(course.submissions ?? []).flatMap((submission) => submission.stageKey === "make" && submission.status !== "failed" && submission.studentId ? [submission.studentId] : []),
    ...(course.projectDocumentVersions ?? []).filter((version) => version.stageKey === "make" && version.status !== "failed").map((version) => version.studentId),
    ...(course.projectPdfVersions ?? []).filter((version) => version.stageKey === "make" && version.status !== "failed").map((version) => version.studentId),
  ]);
  const makeSubmittedStudentIds = new Set([
    ...(course.submissions ?? []).flatMap((submission) => submission.stageKey === "make" && submission.status !== "failed" && submission.studentId && (submission.submittedAt || submission.files?.length) ? [submission.studentId] : []),
    ...(course.projectDocumentVersions ?? []).filter((version) => version.stageKey === "make" && version.status === "submitted").map((version) => version.studentId),
    ...(course.projectPdfVersions ?? []).filter((version) => version.stageKey === "make" && version.status === "submitted").map((version) => version.studentId),
  ]);
  const makeInteractions = (course.aiInteractionEvents ?? []).filter((event) => event.stageKey === "make");
  const makeMissingStudentIds = course.students.filter((student) => !makeArtifactStudentIds.has(student.id)).map((student) => student.id);
  const showcaseRows = (course.showcasePresentations ?? []).slice(-50);
  const reflectionStudentIds = new Set((course.reflections ?? []).map((reflection) => reflection.studentId));
  const evidenceByKey = new Map<string, { priority: number; studentIds: Set<string> }>();
  issueGroups.forEach((issue, index) => evidenceByKey.set(issue.evidenceKey, {
    priority: severityRank[issue.severity] * 100 + Math.min(issue.affectedStudentCount, 50),
    studentIds: new Set(sortedIssueGroups[index]?.studentIds ?? []),
  }));
  if (course.students.length) evidenceByKey.set("progress-summary", { priority: 100 + Math.min(progressSummary.lowProgressStudentCount, 50), studentIds: new Set(progressSummary.lowProgressStudentIds) });
  if (stageKey === "launch" && launchResources.length && course.students.length) evidenceByKey.set("launch-reading", { priority: 130, studentIds: new Set(launchRows.filter((row) => row.completedCount < launchResources.length).map((row) => row.studentId)) });
  if (stageKey === "ai-learning" && course.students.length) {
    evidenceByKey.set("knowledge-learning", { priority: 140, studentIds: new Set(knowledgeRows.filter((row) => row.progressPercent === undefined || row.progressPercent < 100).map((row) => row.studentId)) });
    evidenceByKey.set("knowledge-quiz", { priority: 190, studentIds: new Set(knowledgeRows.filter((row) => row.quizCount === 0 || row.incorrectAnswerCount > 0).map((row) => row.studentId)) });
  }
  if (stageKey === "make" && course.students.length) {
    evidenceByKey.set("make-artifacts", { priority: 180, studentIds: new Set(makeMissingStudentIds) });
    evidenceByKey.set("make-collaboration", { priority: 120, studentIds: new Set(makeInteractions.map((event) => event.studentId)) });
  }
  if (stageKey === "showcase" && showcaseRows.length) evidenceByKey.set("showcase-status", { priority: 180, studentIds: new Set(showcaseRows.filter((presentation) => presentation.status !== "ended").map((presentation) => presentation.studentId)) });
  if (stageKey === "reflection" && course.students.length) evidenceByKey.set("reflection-status", { priority: 150, studentIds: new Set(course.students.filter((student) => !reflectionStudentIds.has(student.id)).map((student) => student.id)) });
  const median = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    if (!sorted.length) return undefined;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
  };
  const knowledgeProgressValues = knowledgeRows.flatMap((row) => typeof row.progressPercent === "number" ? [row.progressPercent] : []);
  const factualSummary = course.students.length === 0
    ? "本课程暂无学生，尚未形成可分析的课堂数据。"
    : stageKey === "launch"
    ? !launchResources.length
      ? "本阶段尚未发布启动资料。"
      : !launchRows.some((row) => row.openedCount > 0)
        ? `已发布 ${launchResources.length} 份启动资料，尚未收到学生浏览记录。`
        : `${launchRows.filter((row) => row.openedCount > 0).length}/${course.students.length} 名学生已开始浏览，${launchRows.filter((row) => row.completedCount === launchResources.length).length}/${course.students.length} 名已完成全部资料。`
    : stageKey === "ai-learning"
      ? !knowledgeProgressValues.length && !knowledgeRows.some((row) => row.quizCount > 0)
        ? "本阶段尚未收到可靠的学习进度或小测记录。"
        : `班级学习进度中位数为 ${median(knowledgeProgressValues) ?? 0}%，${knowledgeRows.filter((row) => row.quizCount > 0).length}/${course.students.length} 名学生已提交小测。`
      : stageKey === "make"
        ? `${makeArtifactStudentIds.size}/${course.students.length} 名学生已有成果记录，${makeSubmittedStudentIds.size}/${course.students.length} 名已有提交记录，当前记录到 ${makeInteractions.length} 条 AI 协作事件。`
        : stageKey === "showcase"
          ? showcaseRows.length
            ? `当前有 ${showcaseRows.length} 份汇报申请，其中 ${showcaseRows.filter((item) => item.status === "ended").length} 份已结束、${showcaseRows.filter((item) => item.status === "active").length} 份正在汇报。`
            : "本阶段尚未收到汇报申请。"
          : stageKey === "reflection"
            ? `${reflectionStudentIds.size}/${course.students.length} 名学生已提交学习反思。`
            : progressRows.some((row) => row.progress !== undefined)
              ? `${progressSummary.completedCount}/${course.students.length} 名学生已完成本阶段。`
              : "本阶段尚未收到可靠的课堂记录。";
  const evidenceSnapshot = {
    course: {
      id: course.id,
      name: course.name,
      subject: course.subject,
      grade: course.grade,
      drivingQuestion: course.drivingQuestion,
      stage: learningStageLabel(stageKey, course.stages),
      studentCount: course.students.length,
      students: course.students.map((student) => ({ id: student.id, name: student.name })),
    },
    progressSummary,
    priorityIssueGroups: issueGroups,
    recentEventSummary: { evidenceKey: "recent-events", counts: eventCounts },
    launchReading: stageKey === "launch" ? { evidenceKey: "launch-reading", resourceCount: launchResources.length, students: launchRows } : undefined,
    knowledgeLearning: stageKey === "ai-learning" ? { evidenceKey: "knowledge-learning", students: knowledgeRows.map(({ incorrectAnswerCount: _, ...row }) => row) } : undefined,
    knowledgeQuiz: stageKey === "ai-learning" ? { evidenceKey: "knowledge-quiz", students: knowledgeRows.map(({ progressPercent: _, ...row }) => row), knowledgePoints: knowledgeMastery.map((row) => ({ name: row.name, answeredStudents: row.answeredStudents, incorrectStudents: row.incorrectStudents, unmetRate: row.unmetRate, status: row.status })) } : undefined,
    artifacts: stageKey === "make" ? {
      evidenceKey: "make-artifacts",
      artifactStudentIds: [...makeArtifactStudentIds],
      submittedStudentIds: [...makeSubmittedStudentIds],
      missingStudentIds: makeMissingStudentIds,
      submissions: (course.submissions ?? []).filter((submission) => submission.stageKey === "make").slice(-30).map((submission) => ({ studentId: submission.studentId, type: submission.type, title: submission.title, status: submission.status, submittedAt: submission.submittedAt, updatedAt: submission.updatedAt })),
    } : undefined,
    makeCollaboration: stageKey === "make" ? { evidenceKey: "make-collaboration", eventCount: makeInteractions.length, events: makeInteractions.slice(-30).map((event) => ({ studentId: event.studentId, eventType: event.eventType, actorRole: event.actorRole, createdAt: event.createdAt })), aiDecisions: (course.studentAiDecisions ?? []).filter((decision) => decision.stageKey === "make").slice(-20).map((decision) => ({ studentId: decision.studentId, decision: decision.decision })) } : undefined,
    showcase: stageKey === "showcase" ? { evidenceKey: "showcase-status", presentations: showcaseRows.map((presentation) => ({ studentId: presentation.studentId, artifactTitle: presentation.artifactTitle, status: presentation.status, requestedAt: presentation.requestedAt, startedAt: presentation.startedAt, endedAt: presentation.endedAt, evaluatedAt: presentation.evaluatedAt })) } : undefined,
    reflections: stageKey === "reflection" ? { evidenceKey: "reflection-status", responses: (course.reflections ?? []).slice(-30).map((reflection) => ({ studentId: reflection.studentId, submittedAt: reflection.updatedAt, hasStructuredSurvey: Boolean(reflection.survey) })) } : undefined,
    recentOfflineInterventions: { evidenceKey: "recent-interventions", items: (course.offlineInterventions ?? []).filter((item) => item.stageKey === stageKey).slice(-8).map((item) => ({ kind: item.kind, studentIds: item.targetStudentIds, note: item.note, createdAt: item.createdAt })) },
  };
  const issueRevision = issueGroups.map((issue) => `${issue.title}:${issue.severity}:${issue.affectedStudentCount}:${issue.lastDetectedAt ?? "none"}`).join("|");
  const sourceRevision = [stageEvents[0]?.occurredAt, showcaseRows.at(-1)?.updatedAt, makeInteractions.at(-1)?.createdAt, (course.submissions ?? []).at(-1)?.updatedAt, Object.values(course.aiLearningProgress ?? {}).map((item) => item.lastActiveAt).sort().at(-1), (course.reflections ?? []).at(-1)?.updatedAt].join(":");
  const cacheKey = `${course.id}:${stageKey}:${course.updatedAt}:${sourceRevision}:${issueRevision || "none"}`;
  const cached = teacherDashboardAdviceCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.value) return cached.value;
    if (cached.promise) return cached.promise;
  }

  const promise: Promise<TeacherDashboardAdvice> = callLLMForJson<{
    actions?: Array<{ title?: unknown; detail?: unknown; kind?: unknown; studentIds?: unknown; evidenceKey?: unknown; scope?: unknown }>;
  }>(
    stageSystemPrompt(stageKey),
    `请仅依据下面这节课当前阶段的实时证据，为教师生成侧栏教学建议。

实时证据：
${JSON.stringify(evidenceSnapshot)}

要求：
1. 不得输出通用课堂常识、固定流程或未被证据支持的提醒。
2. 目标不是覆盖每位学生。只挑选当前紧迫、影响教学决策且教师现在能够处理的独立问题；不设置固定条数，但每条都必须必要且不可被其他建议合并。证据不足时 actions 返回空数组，没有必要干预时也返回空数组，禁止为了达到数量而凑数。
3. priorityIssueGroups 已将同标题问题合并。相同或相近问题必须继续合并成一条班级/小组建议，detail 同时说明受影响范围与一个统一处理动作；不得为多名学生逐人重复生成相似建议。
4. 每条建议只能解决一个最重要的问题，并填写唯一 evidenceKey；evidenceKey 必须原样取自实时证据。不要把一个问题拆成“先巡场、再讲解”等多条建议。
5. 建议必须是教师现在可执行且能观察结果的线下任务、巡场动作或阶段下一步。已经记录在 recentOfflineInterventions 中且尚无新证据的动作不要重复建议。
6. scope 必须为 class、group 或 individual。涉及具体学生时必须使用 group/individual，并填写该证据中的真实 studentId；title 和 detail 必须使用 course.students 中对应的学生姓名，绝对不得向教师展示 studentId、UUID、“ID：...”或只写“该同学”“一些同学”等无法识别对象的说法。群体共性问题应在同一条建议中合并这些学生。只有面向全班且不针对具体学生时才使用 class 并返回空 studentIds。
7. 事实摘要由系统根据原始记录计算，你只生成 actions，不得自行判断是否有人提交、是否完成或是否缺少数据。

仅返回 JSON：{ "actions": [{ "title": "string", "detail": "string", "kind": "offline-task"|"patrol"|"next-step", "scope": "class"|"group"|"individual", "studentIds": ["string"], "evidenceKey": "issue-1" }] }`,
    { abortSignal: opts.abortSignal },
  ).then((result) => {
    if (!Array.isArray(result?.actions)) return invalidAiResult("教师侧栏实时建议");
    const actions = result.actions.flatMap((action, sourceIndex) => {
      const title = typeof action.title === "string" ? humanizeStudentReferences(action.title) : "";
      const detail = typeof action.detail === "string" ? humanizeStudentReferences(action.detail) : "";
      const evidenceKey = typeof action.evidenceKey === "string" ? action.evidenceKey.trim() : "";
      const evidence = evidenceByKey.get(evidenceKey);
      const scope = action.scope === "class" || action.scope === "group" || action.scope === "individual" ? action.scope : undefined;
      const kind: TeacherDashboardAdvice["actions"][number]["kind"] | undefined = action.kind === "offline-task" || action.kind === "patrol" || action.kind === "next-step" ? action.kind : undefined;
      if (!title || !detail || containsInternalStudentId(title) || containsInternalStudentId(detail) || !kind || !evidence || !scope) return [];
      const suppliedStudentIds = Array.isArray(action.studentIds)
        ? [...new Set(action.studentIds.filter((id): id is string => typeof id === "string" && studentIds.has(id) && evidence.studentIds.has(id)))]
        : [];
      const validStudentIds = scope === "class"
        ? []
        : scope === "individual"
          ? suppliedStudentIds.slice(0, 1)
          : [...evidence.studentIds];
      if (scope !== "class" && validStudentIds.length === 0) return [];
      return [{ title, detail, kind, studentIds: validStudentIds, evidenceKey, priority: evidence.priority, breadth: validStudentIds.length, sourceIndex }];
    })
      .sort((left, right) => right.priority - left.priority || right.breadth - left.breadth || left.sourceIndex - right.sourceIndex)
      .filter((action, index, items) => items.findIndex((candidate) => candidate.evidenceKey === action.evidenceKey) === index)
      .map(({ title, detail, kind, studentIds: validStudentIds }) => ({ title, detail, kind, studentIds: validStudentIds }));
    return { summary: factualSummary, actions, generatedAt: new Date().toISOString(), source: "llm" as const };
  });
  teacherDashboardAdviceCache.set(cacheKey, { expiresAt: Date.now() + TEACHER_SIGNAL_CACHE_TTL_MS, promise });
  const advice = await promise;
  teacherDashboardAdviceCache.set(cacheKey, { expiresAt: Date.now() + TEACHER_SIGNAL_CACHE_TTL_MS, value: advice });
  return advice;
}

// ============================================================
// 第七部分：新增场景 - 阶段一项目骨架生成
// ============================================================

/**
 * AI 生成项目骨架（阶段一：项目启动）。
 * 教师在备课阶段页面点击"AI 生成项目骨架"按钮时调用。
 *
 * 输出：基础信息各字段候选、3-5 个高质量驱动问题、情境故事、成果形式建议、评价量规草案
 */
export async function generateProjectSkeleton(input: {
  courseName: string;
  subject: string;
  grade: string;
  hours: number;
  summary?: string;
  initialDrivingQuestion?: string;
  learningObjectives?: string[];
  learnerProfile?: LearnerProfileInput;
  targetPart?: ProjectSkeletonTarget;
}, opts: SupportCallOptions = {}): Promise<{
  courseHourOptions: Array<{ hours: number; rationale: string; scope: string }>;
  learningObjectiveOptions: string[][];
  summaryOptions: string[];
  learnerProfileOptions: LearnerProfileSuggestion[];
  drivingQuestions: string[];
  scenario: string;
  suggestedForms: string[];
  evaluationDimensions: Array<{ name: string; weight: number; description: string }>;
  source: "llm" | "local";
}> {
  throwIfAborted(opts.abortSignal);
  const teachingConstraints = deriveTeachingConstraints({
    grade: input.grade,
    subject: input.subject,
    topic: input.courseName,
    hours: input.hours,
    learnerProfile: input.learnerProfile,
    learningObjectives: input.learningObjectives,
  });
  const targetPart = input.targetPart ?? "all";
  const targetInstructions: Record<ProjectSkeletonTarget | "all", string> = {
    courseHours: `只推荐课程课时，不生成其他字段。根据课程主题的概念密度、${input.grade} 学生的认知基础和可完成的个人项目深度，给出 3 个差异清晰的课时方案；只能在 1-5 课时中选择。每个方案说明为什么适合以及能覆盖到什么范围，不能为了显得完整而塞入大学专业课程内容，也不得安排团队项目。\n仅返回 JSON：{ "courseHourOptions": [{ "hours": 2, "rationale": "string", "scope": "string" }] }`,
    learningObjectives: `只生成课程目标候选。返回 3 组，每组 3-5 条，使用可观察、可评价的行为动词，覆盖知识理解、证据运用和成果迭代。\n仅返回 JSON：{ "learningObjectiveOptions": [["string"]] }`,
    summary: `只生成课程说明候选。返回 3 个，每个 80-160 字，说明真实情境、探究范围、学生任务与预期判断，不写宣传口号。\n仅返回 JSON：{ "summaryOptions": ["string"] }`,
    learnerProfile: `只生成 3 组学生学情与认知边界候选。每组分别给出已有基础、典型学习困难和熟悉生活情境，不虚构测评数据。\n仅返回 JSON：{ "learnerProfileOptions": [{ "priorKnowledge": "string", "learningNeeds": "string", "familiarContexts": "string" }] }`,
    drivingQuestions: `只生成 3-5 个可供教师择一采用的 PBL 核心驱动问题候选。每个候选本身只能包含一个问句、一个问号，并能统领整门课程和最终项目；必须面向真实对象或利益相关者，以“如何/怎样/什么样”提出，明确学生要设计、制作、改进或提出的项目成果及其证据要求，允许多种有依据的方案，并限定在 ${input.hours} 课时、${input.grade} 学生可完成的范围内。不得把“如何确定参数、如何处理特殊情况、如何验证规则、比较方法优缺点”等知识点问题或技术步骤问题拼成驱动问题；这些只能作为后续探究线索。不得是是否题、知识回忆题或唯一答案题，必须以问号结尾。\n仅返回 JSON：{ "drivingQuestions": ["string"] }`,
    all: `生成以下四类候选：
1. learningObjectiveOptions：3 组课程目标，每组 3-5 条
2. summaryOptions：3 个课程说明，每个 80-160 字
3. learnerProfileOptions：3 组学情候选
4. drivingQuestions：3-5 个供教师择一采用的候选；每个候选只能有一个问句和一个问号，必须统领整个项目，包含真实对象、项目行动、预期成果或改变及证据边界；不得把知识点问题或技术步骤问题拼接成题目
仅返回 JSON：{ "learningObjectiveOptions": [["string"]], "summaryOptions": ["string"], "learnerProfileOptions": [{ "priorKnowledge": "string", "learningNeeds": "string", "familiarContexts": "string" }], "drivingQuestions": ["string"] }`,
  };
  const llmResult = await callLLMForJson<Record<string, unknown>>(
    stageSystemPrompt("launch"),
    `请基于以下课程信息，为教师生成当前基础信息字段的候选内容。

课程名称：${input.courseName}
学科：${input.subject}
年级：${input.grade}
课时：${input.hours} 课时
课程简介：${input.summary || "（无）"}
教师初步想法：${input.initialDrivingQuestion || "（无，请基于课程名称与简介推断）"}

${formatTeachingConstraintsForChinesePrompt(teachingConstraints)}

必须把以上学生画像、课程目标与课时容量视为硬约束：不得假定学生掌握未列出的前置知识，不得把一个短课时课程扩张成完整学期内容，也不得用少量重复活动填充长课时。

${targetInstructions[targetPart]}`,
    { abortSignal: opts.abortSignal },
  );

  const learningObjectiveOptions = normalizeObjectiveOptions(
    llmResult.learningObjectiveOptions ?? llmResult.objectiveOptions ?? llmResult.learningObjectives,
  );
  const courseHourOptions = normalizeCourseHourOptions(
    llmResult.courseHourOptions ?? llmResult.hourOptions,
  );
  const summaryOptions = cleanStringList(
    llmResult.summaryOptions ?? llmResult.summaries ?? llmResult.courseDescriptions ??
      (typeof llmResult.summary === "string" ? [llmResult.summary] : []),
    3,
  );
  const learnerProfileOptions = normalizeLearnerProfileOptions(
    llmResult.learnerProfileOptions ?? llmResult.learnerProfiles ?? llmResult.learnerProfile,
  );
  const drivingQuestions = cleanStringList(
    llmResult.drivingQuestions ?? llmResult.questions,
  )
    .filter(isStrongPblDrivingQuestion);

  const targetHasCandidates = {
    courseHours: courseHourOptions.length > 0,
    learningObjectives: learningObjectiveOptions.length > 0,
    summary: summaryOptions.length > 0,
    learnerProfile: learnerProfileOptions.length > 0,
    drivingQuestions: drivingQuestions.length > 0,
    all:
      learningObjectiveOptions.length > 0 &&
      summaryOptions.length > 0 &&
      learnerProfileOptions.length > 0 &&
      drivingQuestions.length > 0,
  }[targetPart];
  if (!targetHasCandidates) {
    return invalidAiResult(`${targetPart === "all" ? "项目骨架" : "当前字段建议"}生成`);
  }

  return {
    courseHourOptions,
    learningObjectiveOptions,
    summaryOptions,
    learnerProfileOptions,
    drivingQuestions,
    scenario: typeof llmResult.scenario === "string" ? llmResult.scenario.trim() : "",
    suggestedForms: cleanStringList(llmResult.suggestedForms),
    evaluationDimensions: Array.isArray(llmResult.evaluationDimensions)
      ? llmResult.evaluationDimensions.slice(0, 6) as Array<{ name: string; weight: number; description: string }>
      : [],
    source: "llm",
  };
}

// ============================================================
// 第八部分：阶段三方案诊断摘要（教师端）
// ============================================================

/**
 * 教师端方案诊断摘要（阶段三：方案构思与校准）。
 * 教师点击“AI 方案诊断”按钮时调用，批量分析所有个人项目方案。
 */
export async function diagnoseAllProposals(input: {
  course: Course;
}, opts: SupportCallOptions = {}): Promise<Array<{
  groupId: string;
  groupName: string;
  topic: string;
  diagnosis: string;
  risks: string[];
  suggestedQuestions: string[];
  source: "llm" | "local";
}>> {
  throwIfAborted(opts.abortSignal);
  const { course } = input;
  const groups = course.groups ?? [];

  if (!groups.length) return [];

  const llmResult = await callLLMForJson<{
    groups: Array<{
      groupId: string;
      diagnosis: string;
      risks: string[];
      suggestedQuestions: string[];
    }>;
  }>(
    stageSystemPrompt("proposal"),
    `请批量分析以下课程所有学生的个人项目方案，为每个项目生成诊断摘要、风险点和建议追问问题。

课程名称：${course.name}
驱动问题：${course.drivingQuestion || "（无）"}

个人项目方案：
${groups.map((g) => {
  const submission = (course.submissions ?? []).find(
    (s) => s.groupId === g.id && s.type === "document",
  );
  const documentText = submission?.content
    ? plainText(submission.content).slice(0, 800)
    : "（未提交方案文档）";
  return `个人项目 ${g.id} - ${g.name}：
  选题：${g.topic || "未填写"}
  目标：${g.goal || "未填写"}
  成果形式：${g.selectedForms.join("、") || "未选择"}
  方案文档（截断到 800 字）：${documentText}`;
}).join("\n\n")}

要求：
1. 为每个个人项目生成 diagnosis（1-2 句话诊断方案完整性）
2. risks：1-3 个风险点（如"证据来源不明确""AI 使用边界不清""实施步骤不可验证"）
3. suggestedQuestions：2-3 个教师可在汇报时追问的问题

仅返回 JSON：{ "groups": [{ "groupId": "string", "diagnosis": "string", "risks": ["string"], "suggestedQuestions": ["string"] }] }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult?.groups?.length) {
    const groupMap = new Map(groups.map((g) => [g.id, g]));
    const result = llmResult.groups
      .filter((item) => groupMap.has(item.groupId))
      .map((item) => {
        const group = groupMap.get(item.groupId)!;
        return {
          groupId: item.groupId,
          groupName: group.name,
          topic: group.topic,
          diagnosis: item.diagnosis ?? invalidAiResult("方案批量诊断"),
          risks: item.risks?.slice(0, 3) ?? invalidAiResult("方案批量诊断"),
          suggestedQuestions: item.suggestedQuestions?.slice(0, 3) ?? invalidAiResult("方案批量诊断"),
          source: "llm" as const,
        };
      });
    if (result.length === groups.length) return result;
  }

  return invalidAiResult("方案批量诊断");
}

// ============================================================
// 第九部分：阶段六过程性评价报告（教师端）
// ============================================================

/**
 * 教师端 AI 过程性评价报告（阶段六：学习反思）。
 * 教师点击"AI 生成过程评价"按钮时调用。
 */
const PROCESS_EVALUATION_DIMENSIONS = [
  { dimensionId: "process-progress", name: "过程推进" },
  { dimensionId: "ai-collaboration-health", name: "AI协作健康度" },
  { dimensionId: "evidence-iteration-quality", name: "证据与迭代质量" },
  { dimensionId: "professional-accuracy", name: "专业知识准确性" },
  { dimensionId: "plan-feasibility", name: "方案逻辑与可行性" },
] as const;

export async function generateProcessEvaluation(input: {
  course: Course;
  groupId?: string;
  teacherGuidance?: string;
}, opts: SupportCallOptions = {}): Promise<{
  summary: string;
  dimensions: Array<{
    dimensionId: string;
    name: string;
    score: number;
    rationale: string;
    evidenceIds: string[];
    evidenceGaps: string[];
  }>;
  evidenceIds: string[];
  evidenceGaps: string[];
  confidence: "low" | "medium" | "high";
  highlights: string[];
  improvements: string[];
  source: "llm" | "local";
}> {
  throwIfAborted(opts.abortSignal);
  const { course, groupId, teacherGuidance } = input;
  const targetGroups = groupId
    ? (course.groups ?? []).filter((g) => g.id === groupId)
    : (course.groups ?? []);

  const targetStudents = targetGroups.flatMap((g) => g.members);
  const studentIds = new Set(targetStudents.map((m) => m.studentId));

  const snapshots = (course.artifactSnapshots ?? []).filter((snapshot) =>
    studentIds.has(snapshot.studentId));
  const evidence = (course.learningEvidence ?? []).filter((item) =>
    studentIds.has(item.studentId)
    && item.countsTowardReadiness
    && ["submitted", "teacher-confirmed"].includes(item.status)
    && isLearningEvidenceStructurallyComplete(item, snapshots));
  const decisions = (course.studentAiDecisions ?? []).filter((item) =>
    studentIds.has(item.studentId));
  const allowedEvidenceIds = new Set(evidence.map((item) => item.id));

  if (!evidence.length) {
    return {
      summary: "当前没有足以支持过程评价的新流程学习证据。",
      dimensions: [],
      evidenceIds: [],
      evidenceGaps: ["缺少已提交且结构完整的学习证据"],
      confidence: "low",
      highlights: [],
      improvements: ["先让学生完成并提交当前阶段证据，再生成评价建议。"],
      source: "local",
    };
  }

  const llmResult = await callLLMForJson<{
    summary: string;
    dimensions: Array<{
      dimensionId: string;
      name: string;
      score?: number | null;
      rationale: string;
      evidenceIds: string[];
      evidenceGaps: string[];
    }>;
    evidenceIds: string[];
    evidenceGaps: string[];
    confidence: "low" | "medium" | "high";
    highlights: string[];
    improvements: string[];
  }>(
    stageSystemPrompt("make"),
    `请基于以下“可进入评价的新流程学习证据”，生成待教师确认的过程评价建议。

课程名称：${course.name}
评价范围：${groupId ? `单个个人项目（${targetGroups[0]?.name ?? ""}）` : `全班（${targetGroups.length} 个个人项目）`}
学生数：${studentIds.size}

教师本轮评分指导：
${teacherGuidance?.trim() || "（无；按既定评价维度独立判断）"}

学习证据（方括号内是唯一允许引用的真实证据 ID）：
${evidence.map((item) =>
  `- [${item.id}] 学生=${item.studentId}；阶段=${learningStageLabel(item.stageKey, course.stages)}；类型=${learningEvidenceKindLabel(item.kind)}；状态=${learningEvidenceStatusLabel(item.status)}；摘要=${item.summary.slice(0, 700)}`,
).join("\n")}

学生对AI建议的真实决定：
${decisions.length
  ? decisions.map((item) =>
      `- 建议=${item.contributionId}；决定=${item.decision}；理由=${item.reason}；实际关联证据=${item.resultingEvidenceIds.join("、") || "无"}`,
    ).join("\n")
  : "（无AI建议决定记录；不得据此推断学生AI协作质量）"}

要求：
1. summary：1 段 100-200 字的过程性评价总结
2. dimensions：严格按以下顺序返回且不得缺项：过程推进、AI协作健康度、证据与迭代质量、专业知识准确性、方案逻辑与可行性；每项包含 dimensionId、name、rationale、evidenceIds、evidenceGaps
3. 每个维度都必须返回 score（0-100整数）；证据不足、无法评价时 score 必须为 0，并在 evidenceGaps 中说明缺少什么证据
4. evidenceIds 只能逐字引用上方方括号中的真实证据 ID，禁止引用聊天、保存、上传、页面、活动或自行编造的 ID
5. evidenceIds：汇总所有维度引用；evidenceGaps：汇总所有关键缺口；confidence 只能是 low、medium、high
6. highlights：2-3 条过程亮点
7. improvements：2-3 条改进建议
8. AI 协作健康度不能按使用频率评分：高频但有核验、修改和产出可为健康；低频但直接照搬或要求代做仍可能不健康
9. 若某维度证据不足，明确说明“证据不足，本维度记 0 分”；不得评价教师负责的现场表达、答辩和课堂通用表现

仅返回 JSON：{ "summary": "string", "dimensions": [{ "dimensionId": "string", "name": "string", "score": 80, "rationale": "string", "evidenceIds": ["真实ID"], "evidenceGaps": [] }], "evidenceIds": ["真实ID"], "evidenceGaps": [], "confidence": "medium", "highlights": ["string"], "improvements": ["string"] }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult?.summary) {
    const dimensions = PROCESS_EVALUATION_DIMENSIONS.map((expected, index) => {
      const dimension = llmResult.dimensions?.[index];
      const evidenceIds = (dimension?.evidenceIds ?? []).filter((id) =>
        allowedEvidenceIds.has(id));
      const score = evidenceIds.length && typeof dimension?.score === "number"
        ? Math.max(0, Math.min(100, Math.round(dimension.score)))
        : 0;
      return {
        dimensionId: expected.dimensionId,
        name: expected.name,
        score,
        rationale: dimension?.rationale?.trim() || "未获得可核验理由，证据不足，本维度记 0 分。",
        evidenceIds: dimension ? evidenceIds : [],
        evidenceGaps: Array.isArray(dimension?.evidenceGaps) && dimension.evidenceGaps.some(Boolean)
          ? dimension.evidenceGaps.filter(Boolean)
          : score === 0
            ? ["证据不足，本维度记 0 分"]
            : [],
      };
    });
    const evidenceIds = Array.from(new Set(
      dimensions.flatMap((dimension) => dimension.evidenceIds),
    ));
    const evidenceGaps = Array.from(new Set([
      ...(llmResult.evidenceGaps ?? []).filter(Boolean),
      ...dimensions.flatMap((dimension) => dimension.evidenceGaps),
    ]));
    return {
      summary: llmResult.summary,
      dimensions,
      evidenceIds,
      evidenceGaps,
      confidence: ["low", "medium", "high"].includes(llmResult.confidence)
        ? llmResult.confidence
        : evidenceIds.length >= 5
          ? "high"
          : evidenceIds.length >= 2
            ? "medium"
            : "low",
      highlights: llmResult.highlights?.slice(0, 3) ?? invalidAiResult("过程性评价生成"),
      improvements: llmResult.improvements?.slice(0, 3) ?? invalidAiResult("过程性评价生成"),
      source: "llm",
    };
  }

  return invalidAiResult("过程性评价生成");
}

// ============================================================
// 第十部分：新增场景 - 阶段六实时汇报评价（教师端）
// ============================================================

/**
 * 教师端 AI 实时汇报评价（阶段六：最终汇报展示）。
 * 教师点击"AI 实时评价"按钮时调用，基于学生汇报材料生成 4 维度评分建议。
 */
export async function generateLiveEvaluation(input: {
  course: Course;
  group: ProjectGroup;
  teacherNotes?: string;
}, opts: SupportCallOptions = {}): Promise<{
  dimensions: Array<{
    dimensionId: string;
    name: string;
    suggestedScore: number;
    rationale: string;
  }>;
  overallComment: string;
  source: "llm" | "local";
}> {
  throwIfAborted(opts.abortSignal);
  const { course, group, teacherNotes } = input;
  const uploads = (course.uploads ?? []).filter((u) => u.groupId === group.id);
  const submission = (course.submissions ?? []).find(
    (s) => s.groupId === group.id && s.type === "document",
  );
  const documentText = submission?.content ? plainText(submission.content).slice(0, 2000) : "";
  const rubricDimensions = getShowcaseRubricDimensions(course);

  const llmResult = await callLLMForJson<{
    dimensions: Array<{
      dimensionId: string;
      name: string;
      suggestedScore: number;
      rationale: string;
    }>;
    overallComment: string;
  }>(
    stageSystemPrompt("showcase"),
    `请为以下学生的个人项目最终汇报生成实时评价建议。必须严格按照“课程评分维度”逐项返回，不要新增、合并或改名维度。

课程名称：${course.name}
个人项目：${group.name}
选题：${group.topic || "未填写"}
项目目标：${group.goal || "未填写"}

个人项目材料：
- 上传文件：${uploads.map((u) => `${u.title}（${u.fileType}）`).join("、") || "无"}
- 方案文档（截断到 2000 字）：${documentText || "无"}

教师现场速记：${teacherNotes || "（无）"}

课程评分维度：
${rubricDimensions
  .map(
    (dimension) =>
      `- dimensionId: ${dimension.id}；name: ${dimension.name}；weight: ${dimension.weight}%；description: ${dimension.description}`,
  )
  .join("\n")}

要求：
1. dimensions：必须与上方课程评分维度数量一致，且每项保留原 dimensionId 和 name。
2. suggestedScore：每维度 0-100 分，必须是整数。
3. rationale：每维度 1 句话评分理由，必须结合学生材料或教师现场速记。
4. overallComment：1 段 50-100 字总体评价。

仅返回 JSON：{ "dimensions": [{ "dimensionId": "string", "name": "string", "suggestedScore": 80, "rationale": "string" }], "overallComment": "string" }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult?.dimensions?.length && llmResult.overallComment) {
    const normalizedDimensions = normalizeLiveEvaluationDimensions(
      llmResult.dimensions,
      rubricDimensions,
    );
    return {
      dimensions: normalizedDimensions,
      overallComment: llmResult.overallComment,
      source: "llm",
    };
  }

  return invalidAiResult("实时汇报评价");
}

function getShowcaseRubricDimensions(course: Course): EvaluationDimension[] {
  const dimensions = course.content.evaluationPlan.dimensions ?? [];
  if (!dimensions.length) {
    return invalidAiResult("实时汇报评价");
  }
  return dimensions;
}

function normalizeLiveEvaluationDimensions(
  aiDimensions: Array<{
    dimensionId?: string;
    name?: string;
    suggestedScore?: number;
    rationale?: string;
  }>,
  rubricDimensions: EvaluationDimension[],
) {
  return rubricDimensions.map((rubricDimension) => {
    const aiDimension = aiDimensions.find(
      (item) => item.dimensionId === rubricDimension.id || item.name === rubricDimension.name,
    );
    if (!aiDimension) {
      return invalidAiResult(`实时汇报评价：缺少维度「${rubricDimension.name}」`);
    }
    if (typeof aiDimension.suggestedScore !== "number" || !aiDimension.rationale) {
      return invalidAiResult(`实时汇报评价：维度「${rubricDimension.name}」结构不完整`);
    }
    return {
      dimensionId: rubricDimension.id,
      name: rubricDimension.name,
      suggestedScore: Math.max(0, Math.min(100, Math.round(aiDimension.suggestedScore))),
      rationale: aiDimension.rationale,
    };
  });
}

// ============================================================
// 第十一部分：新增场景 - 阶段三项目方向建议（学生端）
// ============================================================

/**
 * 学生端 AI 项目方向建议（阶段三：方案构思与校准）。
 * 学生点击"AI 建议项目方向"按钮时调用。
 */
export async function suggestProjectDirections(input: {
  course: Course;
  group: ProjectGroup;
}, opts: SupportCallOptions = {}): Promise<{
  directions: Array<{
    title: string;
    description: string;
    suggestedForm: string;
    keyQuestions: string[];
  }>;
  source: "llm" | "local";
}> {
  throwIfAborted(opts.abortSignal);
  const { course, group } = input;

  const llmResult = await callLLMForJson<{
    directions: Array<{
      title: string;
      description: string;
      suggestedForm: string;
      keyQuestions: string[];
    }>;
  }>(
    stageSystemPrompt("proposal"),
    `请基于以下课程信息，为学生的个人项目生成 3-5 个可调查的方向建议。

课程名称：${course.name}
学科：${course.subject}
年级：${course.grade}
驱动问题：${course.drivingQuestion || "（无）"}
个人当前选题：${group.topic || "未填写"}
项目负责人：${group.members[0]?.name ?? "未关联学生"}

要求：
1. directions：3-5 个项目方向，每个方向应可调查、可验证、与驱动问题相关
2. 每个方向包含：title（方向名称）、description（50-100 字描述）、suggestedForm（建议成果形式）、keyQuestions（2-3 个引导问题）

仅返回 JSON：{ "directions": [{ "title": "string", "description": "string", "suggestedForm": "string", "keyQuestions": ["string"] }] }`,
    { abortSignal: opts.abortSignal },
  );

  if (llmResult?.directions?.length) {
    return {
      directions: llmResult.directions.slice(0, 5),
      source: "llm",
    };
  }

  return invalidAiResult("项目方向建议");
}

// ============================================================
// 第十二部分：辅助函数
// ============================================================

function averageGroupProgress(course: Course, group: ProjectGroup, stageKey: string): number {
  if (!group.members.length) return 0;
  const sum = group.members.reduce((total, member) => {
    return total + (course.students.find((student) => student.id === member.studentId)?.stageProgress?.[stageKey] ?? 0);
  }, 0);
  return Math.round(sum / group.members.length);
}

function teacherSignalCacheKey(course: Course, stageKey: string): string {
  const groupDigest = (course.groups ?? [])
    .map((group) => {
      const progress = averageGroupProgress(course, group, stageKey);
      const uploads = (course.uploads ?? []).filter((upload) => upload.groupId === group.id).length;
      const supports = (course.aiSupports ?? []).filter((support) => support.groupId === group.id).length;
      return `${group.id}:${group.updatedAt}:${progress}:${uploads}:${supports}`;
    })
    .join("|");
  return `${course.id}:${stageKey}:${course.updatedAt}:${groupDigest}`;
}

function focusLabel(focus: ArtifactFocus): string {
  if (focus === "steps") return "检查实施步骤";
  if (focus === "evidence") return "查找证据缺口";
  if (focus === "risk") return "扫描风险与伦理";
  return "诊断当前作品";
}

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function formatAiLearningProgress(progress?: NonNullable<Course["aiLearningProgress"]>[string]): string {
  if (!progress) return "未记录";
  const mastery = {
    "not-started": "尚未开始",
    "in-progress": "学习中",
    completed: "已完成",
    mastered: "已掌握",
  }[progress.masteryLevel];
  const total = Math.max(0, progress.totalScenes);
  const completed = Math.min(total, progress.completedScenes.length);
  return `${mastery}，已完成 ${completed}/${total} 个学习场景${typeof progress.quizScore === "number" ? `，测验得分 ${progress.quizScore}` : ""}`;
}

function evaluationSourceLabel(source: "ai" | "teacher" | "peer" | "self"): string {
  return {
    ai: "AI 过程评价",
    teacher: "教师评价",
    peer: "同伴评价",
    self: "学生自评",
  }[source];
}

function supportAdoptionLabel(decision?: "adopted" | "adopted-after-edit" | "rejected"): string {
  if (decision === "adopted") return "已采纳";
  if (decision === "adopted-after-edit") return "修改后采纳";
  if (decision === "rejected") return "未采纳";
  return "未记录";
}

function riskWeight(value: TeacherInterventionSignal["riskLevel"]): number {
  if (value === "high") return 3;
  if (value === "medium") return 2;
  return 1;
}
