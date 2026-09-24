/**
 * Structured configuration for the personal-project PBL classroom mode.
 *
 * This module deliberately contains no React or LLM code. It is the shared
 * contract used by the course creator, prompt builders, and session migration.
 */

import { getCompanion } from "@/lib/ai-companions";
import { COMPANION_STAGE_KEYS, buildStagePolicyPrompt, getCompanionStagePolicy } from "@/lib/companion/stage-policy";
import type { LearningPresetId } from "@/lib/learning-evidence/types";

export type PblCompanionId =
  | "knowledge"
  | "ideation"
  | "critic"
  | "planner"
  | "reviewer"
  | "recorder";

export type PblEvidenceKind =
  | "idea-draft"
  | "proposal-revision"
  | "reflection-log"
  | "data-screenshot"
  | "ai-decision-log"
  | "artifact-version";

export type PblEvidenceRequirement = {
  kind: PblEvidenceKind;
  label: string;
  description: string;
  required: boolean;
  stageKeys: string[];
};

export type PblOutcomeSpec = {
  artifact: string;
  presentation: string;
  reflection: string;
};

export type ResourceInquiryMode = "llm" | "web-search";

/** The project-practice outcome format selected by the teacher. */
export type MakeArtifactMode = "document" | "other" | "python" | "c";

export type CourseGenerationTemplate =
  | "pbl-six-stage"
  | "new-ai-learning-only";

export type PblCourseConfig = {
  /** The new classroom mode intentionally has no real student group. */
  projectMode: "personal";
  /** Used by the deterministic timing model to adjust scaffolding and practice demand. */
  difficultyLevel: "introductory" | "standard" | "advanced";
  /** Optional teacher override; otherwise inferred conservatively from grade. */
  learnerPreset?: LearningPresetId;
  evidenceRequirements: PblEvidenceRequirement[];
  outcome: PblOutcomeSpec;
  companionIds: PblCompanionId[];
  /** Controls how the student resource corner answers newly entered questions. */
  resourceInquiryMode: ResourceInquiryMode;
  /** Allows project-practice AI to use web search only after textbook retrieval is insufficient. */
  practiceWebSearchEnabled: boolean;
  /** Students follow this setting and cannot switch the project-practice format. */
  makeArtifactMode: MakeArtifactMode;
  /** Teacher-authored open PBL questions students can choose as their project focus. */
  inquiryQuestions: string[];
  evaluationModel: "tri-party";
  generationTemplate: CourseGenerationTemplate;
};

export const PBL_COMPANION_ORDER: PblCompanionId[] = [
  "knowledge",
  "ideation",
  "critic",
  "planner",
  "reviewer",
  "recorder",
];

export const DEFAULT_PBL_EVIDENCE_REQUIREMENTS: PblEvidenceRequirement[] = [
  {
    kind: "idea-draft",
    label: "构思草稿",
    description: "保留最初的问题理解、方向选择或方案草图。",
    required: true,
    stageKeys: ["proposal"],
  },
  {
    kind: "proposal-revision",
    label: "方案修订记录",
    description: "记录依据反馈、证据或测试做出的关键修改。",
    required: true,
    stageKeys: ["proposal", "make"],
  },
  {
    kind: "reflection-log",
    label: "反思日志",
    description: "说明学到了什么、遇到什么困难以及下一步如何改进。",
    required: true,
    stageKeys: ["reflection"],
  },
  {
    kind: "data-screenshot",
    label: "数据 / 测试截图",
    description: "上传数据来源、实验结果、测试过程或验证记录。",
    required: true,
    stageKeys: ["make", "showcase"],
  },
  {
    kind: "ai-decision-log",
    label: "AI 建议采纳记录",
    description: "记录采纳、修改或拒绝 AI 建议的理由。",
    required: false,
    stageKeys: ["proposal", "make", "reflection"],
  },
  {
    kind: "artifact-version",
    label: "作品迭代版本",
    description: "保留初稿、修订稿和最终作品之间的变化。",
    required: false,
    stageKeys: ["make", "showcase"],
  },
];

export const DEFAULT_PBL_OUTCOME: PblOutcomeSpec = {
  artifact: "",
  presentation: "围绕作品说明问题、证据、关键取舍与实际价值。",
  reflection: "回顾个人决策、AI 使用、困难解决和下一次项目的改进计划。",
};

export const DEFAULT_PBL_COURSE_CONFIG: PblCourseConfig = {
  projectMode: "personal",
  difficultyLevel: "standard",
  evidenceRequirements: DEFAULT_PBL_EVIDENCE_REQUIREMENTS.filter((item) => item.required),
  outcome: DEFAULT_PBL_OUTCOME,
  companionIds: PBL_COMPANION_ORDER,
  resourceInquiryMode: "llm",
  practiceWebSearchEnabled: false,
  makeArtifactMode: "document",
  inquiryQuestions: [],
  evaluationModel: "tri-party",
  generationTemplate: "new-ai-learning-only",
};

function cloneEvidenceRequirement(item: PblEvidenceRequirement): PblEvidenceRequirement {
  return {
    ...item,
    stageKeys: [...item.stageKeys],
  };
}

/**
 * Normalize persisted or form-provided data without mutating the caller's
 * object. The recorder is always present because it owns process evidence.
 */
export function normalizePblCourseConfig(
  input?: Partial<PblCourseConfig> | null,
): PblCourseConfig {
  const rawEvidence = Array.isArray(input?.evidenceRequirements)
    ? input.evidenceRequirements
    : DEFAULT_PBL_EVIDENCE_REQUIREMENTS.filter((item) => item.required);
  const evidenceRequirements = rawEvidence
    .filter((item): item is PblEvidenceRequirement => Boolean(item && typeof item === "object"))
    .filter((item) => item.required !== false)
    .map((item) => ({
      ...item,
      kind: item.kind,
      label: typeof item.label === "string" ? item.label.trim() : "",
      description: typeof item.description === "string" ? item.description.trim() : "",
      required: true,
      stageKeys: Array.isArray(item.stageKeys)
        ? item.stageKeys.filter(
            (key): key is string => typeof key === "string" && Boolean(key.trim()),
          )
        : [],
    }))
    .filter((item) => item.label && item.stageKeys.length > 0)
    .map(cloneEvidenceRequirement);

  const companionIds = [...PBL_COMPANION_ORDER];
  const inquiryQuestions = Array.from(
    new Set(
      (Array.isArray(input?.inquiryQuestions) ? input.inquiryQuestions : [])
        .filter((question): question is string => typeof question === "string")
        .map((question) => question.trim())
        .filter(Boolean),
    ),
  ).slice(0, 1);

  return {
    projectMode: "personal",
    difficultyLevel:
      input?.difficultyLevel === "introductory" ||
      input?.difficultyLevel === "advanced"
        ? input.difficultyLevel
        : "standard",
    learnerPreset:
      input?.learnerPreset === "guided"
      || input?.learnerPreset === "research"
        ? input.learnerPreset
        : input?.learnerPreset === "standard"
          ? "standard"
          : undefined,
    evidenceRequirements,
    outcome: {
      ...DEFAULT_PBL_OUTCOME,
      ...(input?.outcome ?? {}),
      artifact: typeof input?.outcome?.artifact === "string" ? input.outcome.artifact.trim() : "",
      presentation:
        typeof input?.outcome?.presentation === "string"
          ? input.outcome.presentation.trim()
          : DEFAULT_PBL_OUTCOME.presentation,
      reflection:
        typeof input?.outcome?.reflection === "string"
          ? input.outcome.reflection.trim()
          : DEFAULT_PBL_OUTCOME.reflection,
    },
    companionIds,
    resourceInquiryMode: input?.resourceInquiryMode === "web-search" ? "web-search" : "llm",
    practiceWebSearchEnabled: input?.practiceWebSearchEnabled === true,
    makeArtifactMode:
      input?.makeArtifactMode === "other"
      || input?.makeArtifactMode === "python"
      || input?.makeArtifactMode === "c"
        ? input.makeArtifactMode
        : "document",
    inquiryQuestions,
    evaluationModel: "tri-party",
    generationTemplate: "new-ai-learning-only",
  };
}

export function clonePblCourseConfig(config: PblCourseConfig): PblCourseConfig {
  return normalizePblCourseConfig({
    ...config,
    evidenceRequirements: config.evidenceRequirements.map(cloneEvidenceRequirement),
    outcome: { ...config.outcome },
    companionIds: [...config.companionIds],
    inquiryQuestions: [...config.inquiryQuestions],
  });
}

export function formatPblCourseConfigForPrompt(config?: PblCourseConfig | null): string {
  const normalized = normalizePblCourseConfig(config);
  return JSON.stringify(
    {
      ...normalized,
      companionProfiles: normalized.companionIds.map((id) => {
        const companion = getCompanion(id);
        return {
          id: companion.id,
          name: companion.name,
          role: companion.role,
          description: companion.description,
          stages: companion.stages,
          instruction: companion.instruction,
        };
      }),
      companionStagePolicies: Object.fromEntries(
        COMPANION_STAGE_KEYS.map((stageKey) => {
          const policy = getCompanionStagePolicy(stageKey);
          return [stageKey, {
            label: policy.label,
            objective: policy.objective,
            studentDeliverable: policy.studentDeliverable,
            allowedCompanionIds: policy.allowedCompanionIds,
            helpTypes: policy.helpTypes,
            prohibitedActions: policy.prohibitedActions,
            requiredContext: policy.requiredContext,
            prompt: buildStagePolicyPrompt(stageKey),
          }];
        }),
      ),
    },
    null,
    2,
  );
}
