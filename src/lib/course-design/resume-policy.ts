import { evaluateLessonOutlines } from "@/lib/course-design/quality-gates";
import type { PblActivityCatalogEntry, SceneOutline } from "@/lib/openmaic/types/generation";

/** Once package import starts, an older free-form request must never resume alongside it. */
export function canResumeCourseDesignWithPackageState(request: unknown, packageJob: { status: string } | null): boolean {
  if (!request || typeof request !== "object") return false;
  return (request as Record<string, unknown>).resourcePackage
    ? packageJob?.status === "ready"
    : packageJob === null;
}

function hasCompletedStep(trace: unknown, step: string): boolean {
  if (!Array.isArray(trace)) return false;
  return trace.some((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const event = entry as { step?: unknown; status?: unknown };
    return event.step === step
      && (event.status === "completed" || event.status === "warning");
  });
}

export function canResumeAfterValidatedStage(input: {
  trace: unknown;
  step: string;
  qualityPassed: boolean;
}): boolean {
  return input.qualityPassed && hasCompletedStep(input.trace, input.step);
}

export function canResumeAfterValidatedPositioning(input: {
  trace: unknown;
  positioningPassed: boolean;
}): boolean {
  return input.positioningPassed && hasCompletedStep(input.trace, "base");
}

export function canResumeAfterValidatedLessonOutline(input: {
  trace: unknown;
  outlines: ReadonlyArray<SceneOutline>;
  activityCatalog?: ReadonlyArray<PblActivityCatalogEntry>;
}): boolean {
  return hasCompletedStep(input.trace, "lessonOutline")
    && input.outlines.length > 0
    && evaluateLessonOutlines(input.outlines, input.activityCatalog).passed;
}

export function canResumeAfterValidatedTeachingOutline(input: {
  trace: unknown;
  positioningPassed: boolean;
  projectDesignPassed: boolean;
  evaluationPlanPassed: boolean;
  knowledgePointCount: number;
  knowledgeGraphNodeCount: number;
  teachingOutlineCount: number;
  timingPlanConfirmed: boolean;
}): boolean {
  return hasCompletedStep(input.trace, "teachingOutline")
    && input.positioningPassed
    && input.projectDesignPassed
    && input.evaluationPlanPassed
    && input.knowledgePointCount > 0
    && input.knowledgeGraphNodeCount >= input.knowledgePointCount
    && input.teachingOutlineCount === 6
    && input.timingPlanConfirmed;
}

function normalizedRequest(value: unknown): {
  courseId: string;
  generationModelString: string | null;
  systemMode: "new";
  generationMode: "standard" | "deep-interaction";
  generationScope: "full-course" | "test-lesson";
  generationContractVersion: 2 | 3 | null;
  assessmentMode: "adaptive" | "constructed-response";
  teacherBrief: string;
  enableImageGeneration: boolean;
  enableTTS: boolean;
  enableVideoGeneration: boolean;
  referenceIds: string[];
  textbookSelections: Array<{ revisionId: string; primary: boolean; sectionIds: string[] }>;
  textbookEvidenceFingerprint: string | null;
  resourcePackageSignature: string | null;
  supplementalBrief: string;
} | null {
  if (!value || typeof value !== "object") return null;
  const request = value as Record<string, unknown>;
  const options = request.options && typeof request.options === "object"
    ? request.options as Record<string, unknown>
    : {};
  if (typeof request.courseId !== "string" || typeof request.teacherBrief !== "string") return null;
  const resourcePackage = request.resourcePackage && typeof request.resourcePackage === "object"
    ? request.resourcePackage as Record<string, unknown> : null;
  const answers = request.supplementalAnswers && typeof request.supplementalAnswers === "object"
    ? request.supplementalAnswers as Record<string, unknown> : {};
  return {
    courseId: request.courseId,
    generationModelString: typeof request.generationModelString === "string"
      ? request.generationModelString.trim() || null
      : null,
    systemMode: "new",
    generationMode: request.generationMode === "deep-interaction"
      ? "deep-interaction"
      : "standard",
    generationScope: request.generationScope === "test-lesson"
      ? "test-lesson"
      : "full-course",
    generationContractVersion: request.generationContractVersion === 3 ? 3
      : request.generationContractVersion === 2 ? 2 : null,
    assessmentMode: request.assessmentMode === "constructed-response"
      ? "constructed-response"
      : "adaptive",
    teacherBrief: request.teacherBrief.trim(),
    supplementalBrief: typeof answers.brief === "string" ? answers.brief.trim() : "",
    resourcePackageSignature: resourcePackage ? JSON.stringify({
      id: resourcePackage.id,
      revision: resourcePackage.revision,
      source: resourcePackage.source,
      draft: resourcePackage.draft,
    }) : null,
    enableImageGeneration: options.enableImageGeneration !== false,
    enableTTS: options.enableTTS !== false,
    enableVideoGeneration: options.enableVideoGeneration === true,
    referenceIds: Array.isArray(request.referenceMaterials)
      ? request.referenceMaterials.flatMap((material) => {
          if (!material || typeof material !== "object") return [];
          const id = (material as Record<string, unknown>).id;
          return typeof id === "string" ? [id] : [];
        }).sort()
      : [],
    textbookSelections: Array.isArray(request.textbookSelections)
      ? request.textbookSelections.flatMap((selection) => {
          if (!selection || typeof selection !== "object") return [];
          const item = selection as Record<string, unknown>;
          if (typeof item.revisionId !== "string") return [];
          return [{
            revisionId: item.revisionId,
            primary: item.primary === true,
            sectionIds: Array.isArray(item.sectionIds)
              ? item.sectionIds.filter((id): id is string => typeof id === "string").sort()
              : [],
          }];
        }).sort((a, b) => a.revisionId.localeCompare(b.revisionId))
      : [],
    textbookEvidenceFingerprint: request.textbookEvidence && typeof request.textbookEvidence === "object"
      && typeof (request.textbookEvidence as Record<string, unknown>).fingerprint === "string"
      ? (request.textbookEvidence as Record<string, unknown>).fingerprint as string
      : null,
  };
}

export function isSameCourseDesignRequest(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizedRequest(left);
  const normalizedRight = normalizedRequest(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && JSON.stringify(normalizedLeft) === JSON.stringify(normalizedRight),
  );
}
