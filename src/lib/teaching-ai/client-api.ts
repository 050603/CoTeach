// 客户端包装器：通过 /api/teaching-ai/support API 调用 support-engine 函数。
// 客户端组件必须从这里导入，而非直接从 @/lib/teaching-ai/support-engine 导入，
// 以避免将 callLLM → settings → node:fs/promises 等服务端模块拉入客户端 bundle。
//
// 类型使用 import type（编译时擦除，不产生运行时依赖）从 support-engine 重新导出。

import type {
  AiSupportDraft,
  ArtifactFocus,
  TeacherDashboardAdvice,
  TeacherInterventionSignal,
} from "@/lib/teaching-ai/support-engine";
import type {
  ActivityRecord,
  AiSupportRecord,
  Course,
  CourseUpload,
  ProjectGroup,
  WorkPlanItem,
} from "@/lib/session/types";
import type { LearnerProfileInput } from "@/lib/openmaic/pedagogy/teaching-constraints";
import type { ReflectionSummaryTrigger } from "@/lib/reflection-summary";

// 重新导出类型（编译时擦除，无运行时依赖）
export type { AiSupportDraft, ArtifactFocus, TeacherDashboardAdvice, TeacherInterventionSignal };

// 返回值类型（显式定义，避免客户端组件用 ReturnType<typeof xxx> 推断时引入运行时 import）
export type ProjectSkeletonResult = {
  courseHourOptions: Array<{ hours: number; rationale: string; scope: string }>;
  learningObjectiveOptions: string[][];
  summaryOptions: string[];
  learnerProfileOptions: Array<{
    priorKnowledge: string;
    learningNeeds: string;
    familiarContexts: string;
  }>;
  drivingQuestions: string[];
  scenario: string;
  suggestedForms: string[];
  evaluationDimensions: Array<{ name: string; weight: number; description: string }>;
  source: "llm" | "local";
};

export type ProposalDiagnosisResult = {
  groupId: string;
  groupName: string;
  topic: string;
  diagnosis: string;
  risks: string[];
  suggestedQuestions: string[];
  source: "llm" | "local";
};

export type ProcessEvaluationResult = {
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
};

export type LiveEvaluationResult = {
  dimensions: Array<{
    dimensionId: string;
    name: string;
    suggestedScore: number;
    rationale: string;
  }>;
  overallComment: string;
  source: "llm" | "local";
};

export type ProjectSkeletonTarget =
  | "courseHours"
  | "learningObjectives"
  | "summary"
  | "learnerProfile"
  | "drivingQuestions";

export type ProjectDirectionResult = {
  directions: Array<{
    title: string;
    description: string;
    suggestedForm: string;
    keyQuestions: string[];
  }>;
  source: "llm" | "local";
};

// ============================================================
// 内部调用辅助
// ============================================================

async function callSupport<T>(action: string, input: unknown): Promise<T> {
  const res = await fetch("/api/teaching-ai/support", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, input }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "UNKNOWN" }));
    const detail = err.detail ? `：${err.detail}` : "";
    throw Object.assign(new Error(err.message ?? `${err.error ?? `API error ${res.status}`}${detail}`), { code: err.error });
  }
  const data = await res.json();
  return data.result as T;
}

// ============================================================
// 函数包装（签名与 support-engine 保持一致）
// ============================================================

export async function diagnoseGroupIdea(input: {
  course: Course;
  group: ProjectGroup;
  tasks: WorkPlanItem[];
}): Promise<AiSupportDraft> {
  return callSupport("diagnoseGroupIdea", input);
}

export async function diagnoseProjectArtifact(input: {
  course: Course;
  group: ProjectGroup;
  stageKey: string;
  documentHtml: string;
  uploads: CourseUpload[];
  tasks: WorkPlanItem[];
  focus?: ArtifactFocus;
}): Promise<AiSupportDraft> {
  return callSupport("diagnoseProjectArtifact", input);
}

export async function buildShowcaseCoach(input: {
  course: Course;
  group: ProjectGroup;
  uploads: CourseUpload[];
  activities: ActivityRecord[];
  aiSupports: AiSupportRecord[];
}): Promise<AiSupportDraft> {
  return callSupport("buildShowcaseCoach", input);
}

export async function buildReflectionEvidencePrompts(input: {
  course: Course;
  group?: ProjectGroup;
  studentId: string;
  format?: "full" | "compact";
}): Promise<AiSupportDraft> {
  return callSupport("buildReflectionEvidencePrompts", input);
}

export async function buildReflectionClassSummary(
  courseId: string,
  trigger: ReflectionSummaryTrigger = "manual",
): Promise<AiSupportRecord> {
  const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/reflections/summary`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger }),
  });
  const payload = await response.json().catch(() => ({})) as {
    support?: AiSupportRecord;
    message?: string;
    code?: string;
  };
  if (!response.ok || !payload.support) {
    const error = new Error(payload.message ?? "AI 课程总结暂时不可用。");
    (error as Error & { code?: string }).code = payload.code;
    throw error;
  }
  return payload.support;
}

export async function buildTeacherInterventionSignals(
  course: Course,
  stageKey: string,
): Promise<TeacherInterventionSignal[]> {
  return callSupport("buildTeacherInterventionSignals", { course, stageKey });
}

export async function buildTeacherDashboardAdvice(
  courseId: string,
  stageKey: string,
): Promise<TeacherDashboardAdvice> {
  return callSupport("buildTeacherDashboardAdvice", { courseId, stageKey });
}

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
}): Promise<ProjectSkeletonResult> {
  return callSupport("generateProjectSkeleton", input);
}

export async function diagnoseAllProposals(input: {
  course: Course;
}): Promise<ProposalDiagnosisResult[]> {
  return callSupport("diagnoseAllProposals", input);
}

export async function generateProcessEvaluation(input: {
  course: Course;
  groupId?: string;
  teacherGuidance?: string;
}): Promise<ProcessEvaluationResult> {
  return callSupport("generateProcessEvaluation", input);
}

export async function generateLiveEvaluation(input: {
  course: Course;
  group: ProjectGroup;
  teacherNotes?: string;
}): Promise<LiveEvaluationResult> {
  return callSupport("generateLiveEvaluation", input);
}

export async function suggestProjectDirections(input: {
  course: Course;
  group: ProjectGroup;
}): Promise<ProjectDirectionResult> {
  return callSupport("suggestProjectDirections", input);
}

// ============================================================
// 学生端聊天 API 包装
// ============================================================

export async function callStudentChat(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
): Promise<string> {
  const res = await fetch("/api/chat/student", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "UNKNOWN" }));
    const detail = err.detail ? `：${err.detail}` : "";
    throw Object.assign(new Error(err.message ?? `${err.error ?? `API error ${res.status}`}${detail}`), { code: err.error });
  }
  const data = await res.json();
  return data.reply as string;
}
