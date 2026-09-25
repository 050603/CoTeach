import type {
  AiAssessmentConfidence,
  AiAssessmentSuggestion,
  AiAssessmentSuggestionStatus,
  LearningEvidenceKind,
  LearningEvidenceStatus,
} from "@/lib/learning-evidence/types";

export function calculateProcessSuggestionTotal(
  dimensions: Array<{ score?: number | null }>,
): number {
  if (!dimensions.length) return 0;
  const total = dimensions.reduce((sum, dimension) =>
    sum + (typeof dimension.score === "number" ? dimension.score : 0), 0);
  return Math.round(total / dimensions.length);
}

export function confirmedProcessScore(
  suggestion: AiAssessmentSuggestion | null | undefined,
): number | null {
  if (
    !suggestion
    || !["confirmed", "adjusted"].includes(suggestion.status)
    || typeof suggestion.teacherScore !== "number"
  ) return null;
  return suggestion.teacherScore;
}

const STATUS_LABELS: Record<AiAssessmentSuggestionStatus, string> = {
  "pending-teacher-confirmation": "待教师确认",
  confirmed: "教师已确认",
  adjusted: "教师已调整并确认",
  rejected: "教师未采用",
  "insufficient-evidence": "证据不足",
};

const CONFIDENCE_LABELS: Record<AiAssessmentConfidence, string> = {
  low: "较低",
  medium: "中等",
  high: "较高",
};

export function aiAssessmentStatusLabel(
  status: AiAssessmentSuggestionStatus,
): string {
  return STATUS_LABELS[status];
}

export function aiAssessmentConfidenceLabel(
  confidence: AiAssessmentConfidence,
): string {
  return CONFIDENCE_LABELS[confidence];
}

export function uniqueEvidenceGaps(gaps: string[]): string[] {
  return Array.from(new Set(gaps.map((gap) => gap.trim()).filter(Boolean)));
}

const STAGE_LABELS: Record<string, string> = {
  launch: "项目启动",
  "ai-learning": "知识讲授",
  proposal: "方案构思与校准",
  make: "项目实践",
  showcase: "成果汇报与评价",
  reflection: "后测",
};

const EVIDENCE_KIND_LABELS: Record<LearningEvidenceKind, string> = {
  "project-intent": "项目立意",
  "knowledge-transfer": "知识迁移说明",
  "key-decision": "关键方案决策",
  "plan-version": "项目方案版本",
  "artifact-version": "作品版本",
  "test-result": "测试结果",
  "revision-decision": "作品过程记录",
  "final-artifact": "最终作品",
  "presentation-claim": "汇报主张与证据",
  "defense-response": "答辩回应",
  "reflection-chain": "反思证据链",
  "transfer-response": "迁移应用回答",
  "ai-decision": "AI建议采用决定",
};

const EVIDENCE_STATUS_LABELS: Record<LearningEvidenceStatus, string> = {
  draft: "草稿",
  submitted: "已提交",
  "teacher-confirmed": "教师已确认",
  "needs-revision": "需要修改",
};

export function learningStageLabel(
  stageKey: string,
  stages: Array<{ key: string; label: string }> = [],
): string {
  return stages.find((stage) => stage.key === stageKey)?.label
    ?? STAGE_LABELS[stageKey]
    ?? "课程学习阶段";
}

export function learningEvidenceKindLabel(kind: LearningEvidenceKind | string): string {
  return EVIDENCE_KIND_LABELS[kind as LearningEvidenceKind] ?? "学习证据";
}

export function learningEvidenceStatusLabel(status: LearningEvidenceStatus | string): string {
  return EVIDENCE_STATUS_LABELS[status as LearningEvidenceStatus] ?? "待更新";
}

const INTERNAL_TERM_LABELS = {
  ...STAGE_LABELS,
  ...EVIDENCE_KIND_LABELS,
  ...EVIDENCE_STATUS_LABELS,
  "pending-teacher-confirmation": "待教师确认",
  "insufficient-evidence": "证据不足",
} as Record<string, string>;

export function localizeEvaluationText(text: string): string {
  const localized = Object.entries(INTERNAL_TERM_LABELS)
    .sort(([left], [right]) => right.length - left.length)
    .reduce(
      (result, [internalTerm, label]) => result.replace(
        new RegExp(`\\b${internalTerm.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`, "gi"),
        label,
      ),
      text,
    );
  return localized.replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, "$1$2");
}
