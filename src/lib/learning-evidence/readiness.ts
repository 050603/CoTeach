import type { Course } from "@/lib/session/types";
import { isReliableAiProgress } from "@openmaic/lib/progress/completion-model";
import {
  getStageMissionDefinition,
  resolveCourseLearningPreset,
} from "./missions";
import type {
  ArtifactSnapshot,
  KeyDecisionPayload,
  LearningEvidence,
  LearningEvidenceKind,
  StageReadiness,
  StageReadinessCheck,
  StageReadinessStatus,
} from "./types";
import {
  haveAllResourcesBeenViewed,
  hasSelectedProjectTopic,
} from "@/lib/project-launch-readiness";

function hasText(value: unknown): boolean {
  return typeof value === "string" && Boolean(value.trim());
}

function hasTextList(value: unknown): boolean {
  return Array.isArray(value) && value.some(hasText);
}

export function isLearningEvidenceStructurallyComplete(
  evidence: LearningEvidence,
  snapshots: ArtifactSnapshot[] = [],
): boolean {
  const payload = evidence.payload as Record<string, unknown>;
  switch (evidence.kind) {
    case "project-intent":
      return ["concern", "affectedPeople", "importance", "successIndicator", "personalQuestion"]
        .every((key) => hasText(payload[key]));
    case "knowledge-transfer":
      return ["concept", "ownExplanation", "projectConstraint", "application"]
        .every((key) => hasText(payload[key]));
    case "key-decision": {
      const decision = evidence.payload as KeyDecisionPayload;
      return (
        Array.isArray(decision.alternatives)
        && decision.alternatives.length >= 2
        && hasTextList(decision.successCriteria)
        && decision.alternatives.every((item) =>
          hasText(item.title)
          && hasText(item.description)
          && decision.successCriteria.every((criterion) =>
            hasText(item.comparison?.[criterion])))
        && decision.alternatives.some((item) => item.id === decision.selectedAlternativeId)
        && hasText(decision.reason)
      );
    }
    case "plan-version":
      return (
        hasText(payload.versionLabel)
        && hasText(payload.changeSummary)
        && hasTextList(payload.nextActions)
        && hasText(payload.validationMethod)
      );
    case "artifact-version": {
      const snapshotId = hasText(payload.snapshotId) ? String(payload.snapshotId) : undefined;
      const snapshot = snapshotId ? snapshots.find((item) => item.id === snapshotId) : undefined;
      return (
        hasText(payload.iterationId)
        && hasText(payload.versionLabel)
        && hasText(payload.artifactTitle)
        && hasText(payload.changeSummary)
        && (
          hasText(payload.contentExcerpt)
          || Boolean(snapshot?.sourceUrl)
          || isSnapshotInspectable(snapshot)
        )
      );
    }
    case "test-result":
      return (
        ["iterationId", "method", "observation", "result"]
          .every((key) => hasText(payload[key]))
        && (
          !("researchMethod" in payload || "ethics" in payload)
          || (
            hasText(payload.researchMethod)
            && hasText(payload.ethics)
            && hasText(payload.limitation)
          )
        )
      );
    case "revision-decision":
      if (hasText(payload.processDraft)) {
        return hasText(payload.iterationId);
      }
      return (
        ["iterationId", "reason", "plannedChange"]
          .every((key) => hasText(payload[key]))
        && ["revise", "keep", "retry"].includes(String(payload.decision))
      );
    case "final-artifact": {
      const snapshotId = hasText(payload.snapshotId) ? String(payload.snapshotId) : undefined;
      return (
        hasText(payload.title)
        && hasText(payload.description)
        && (snapshotId ? isSnapshotInspectable(snapshots.find((item) => item.id === snapshotId)) : false)
      );
    }
    case "presentation-claim":
      return (
        hasText(payload.claim)
        && hasTextList(payload.evidenceIds)
        && hasText(payload.evidenceSummary)
        && hasText(payload.limitation)
      );
    case "defense-response":
      return hasText(payload.question) && hasText(payload.response) && hasTextList(payload.evidenceIds);
    case "reflection-chain":
      return (
        hasTextList(payload.selectedEvidenceIds)
        && ["choice", "action", "result", "learning"].every((key) => hasText(payload[key]))
      );
    case "transfer-response":
      return ["scenario", "response", "rationale"].every((key) => hasText(payload[key]));
    case "ai-decision":
      return (
        hasText(payload.contributionId)
        && hasText(payload.decisionId)
        && ["adopted", "modified", "rejected"].includes(String(payload.decision))
        && hasText(payload.reason)
      );
    default:
      return false;
  }
}

export function isSnapshotInspectable(snapshot: ArtifactSnapshot | undefined): boolean {
  if (!snapshot) return false;
  if (snapshot.inspectionStatus === "inspectable") return hasText(snapshot.inspectableText);
  if (snapshot.inspectionStatus === "student-annotated") {
    return hasText(snapshot.studentExcerpt) || hasText(snapshot.annotation);
  }
  return false;
}

function submittedEvidence(
  course: Course,
  studentId: string,
  stageKey: string,
): LearningEvidence[] {
  return (course.learningEvidence ?? []).filter(
    (item) =>
      item.studentId === studentId
      && item.stageKey === stageKey
      && item.countsTowardReadiness
      && item.status !== "draft",
  );
}

function validEvidenceOfKind(
  evidence: LearningEvidence[],
  kind: LearningEvidenceKind,
  snapshots: ArtifactSnapshot[],
): LearningEvidence[] {
  return evidence.filter(
    (item) =>
      item.kind === kind
      && item.status !== "needs-revision"
      && isLearningEvidenceStructurallyComplete(item, snapshots),
  );
}

function projectIdForStudent(course: Course, studentId: string): string | undefined {
  return (course.groups ?? []).find((group) =>
    group.members.some((member) => member.studentId === studentId))?.id;
}

function teacherCalibrationForStage(
  course: Course,
  studentId: string,
  stageKey: string,
  evidence: LearningEvidence[],
): StageReadiness["teacherCalibration"] {
  if (evidence.some((item) => item.status === "needs-revision")) return "needs-revision";

  if (stageKey === "launch") {
    const intent = evidence.find((item) => item.kind === "project-intent");
    if (intent?.status === "teacher-confirmed") return "confirmed";
    return "pending";
  }

  if (stageKey === "proposal") {
    if (evidence.some(
      (item) =>
        item.kind === "plan-version" && item.status === "teacher-confirmed",
    )) return "confirmed";
    return "pending";
  }

  if (stageKey === "showcase") {
    const projectId = projectIdForStudent(course, studentId);
    const hasTeacherEvaluation = Boolean(
      projectId
      && (course.rubricScores ?? []).some(
        (score) =>
          score.groupId === projectId
          && score.stageKey === "showcase"
          && score.status !== "draft"
          && typeof score.teacherTotal === "number",
      ),
    );
    return hasTeacherEvaluation ? "confirmed" : "pending";
  }

  return "not-required";
}

function readinessReason(
  status: StageReadinessStatus,
  checks: StageReadinessCheck[],
): string {
  if (status === "ready") return "必需证据与校准条件均已满足。";
  if (status === "needs-revision") return "教师或证据检查已指出需要修订的内容。";
  if (status === "awaiting-calibration") return "学生任务已完成，正在等待教师校准。";
  if (status === "not-started") return "尚未形成可检查的学习证据。";
  const next = checks.find((item) => !item.satisfied);
  return next ? `下一步：${next.label}` : "正在形成阶段证据。";
}

export function deriveStageReadiness(
  course: Course,
  studentId: string,
  stageKey: string,
  now = new Date().toISOString(),
): StageReadiness {
  const preset = resolveCourseLearningPreset(course);
  const snapshots = (course.artifactSnapshots ?? []).filter((item) => item.studentId === studentId);
  const allStageEvidence = (course.learningEvidence ?? []).filter(
    (item) => item.studentId === studentId && item.stageKey === stageKey,
  );
  const evidence = submittedEvidence(course, studentId, stageKey);

  if (stageKey === "ai-learning") {
    const progress = course.aiLearningProgress?.[studentId];
    const completed = Boolean(
      (progress && isReliableAiProgress(progress) && ["completed", "mastered"].includes(progress.masteryLevel))
    );
    const started = Boolean(progress && progress.masteryLevel !== "not-started");
    const status: StageReadinessStatus = completed ? "ready" : started ? "working" : "not-started";
    return {
      courseId: course.id,
      studentId,
      stageKey,
      preset,
      status,
      checks: [{
        id: "ai-learning-existing-flow",
        label: "完成知识讲授流程",
        satisfied: completed,
        evidenceIds: [],
      }],
      missingEvidenceKinds: [],
      evidenceIds: [],
      completedIterations: 0,
      requiredIterations: 0,
      teacherCalibration: "not-required",
      reason: readinessReason(status, []),
      derivedAt: now,
    };
  }

  if (stageKey === "launch") {
    const project = (course.groups ?? []).find((group) =>
      group.members.some((member) => member.studentId === studentId));
    const topicSelected = hasSelectedProjectTopic(
      project,
      course.pblConfig?.inquiryQuestions,
    );
    const resourcesViewed = haveAllResourcesBeenViewed(course, studentId);
    const checks: StageReadinessCheck[] = [
      {
        id: "launch-topic",
        label: "选择感兴趣的研究方向",
        satisfied: topicSelected,
        evidenceIds: [],
      },
      {
        id: "launch-resources",
        label: "查阅课程启动资料",
        satisfied: resourcesViewed,
        evidenceIds: [],
      },
    ];
    const complete = checks.every((item) => item.satisfied);
    const started = topicSelected || (course.resources ?? []).some((resource) =>
      resource.downloadedBy.includes(studentId));
    const status: StageReadinessStatus = complete ? "ready" : started ? "working" : "not-started";
    return {
      courseId: course.id,
      studentId,
      stageKey,
      preset,
      status,
      checks,
      missingEvidenceKinds: [],
      evidenceIds: [],
      completedIterations: 0,
      requiredIterations: 0,
      teacherCalibration: "not-required",
      reason: readinessReason(status, checks),
      derivedAt: now,
    };
  }

  if (stageKey === "showcase") {
    const projectId = projectIdForStudent(course, studentId);
    const hasFinalWork = (course.uploads ?? []).some((item) =>
      item.stageKey === "showcase"
      && (item.studentId === studentId || Boolean(projectId && item.groupId === projectId)))
      || (course.submissions ?? []).some((item) =>
        item.stageKey === "showcase"
        && (item.studentId === studentId || Boolean(projectId && item.groupId === projectId)));
    const teacherCalibration = teacherCalibrationForStage(course, studentId, stageKey, []);
    const status: StageReadinessStatus = hasFinalWork
      ? teacherCalibration === "confirmed" ? "ready" : "awaiting-calibration"
      : "not-started";
    const checks: StageReadinessCheck[] = [{
      id: "showcase-final-work",
      label: "提交成果展示材料",
      satisfied: hasFinalWork,
      evidenceIds: [],
    }];
    return {
      courseId: course.id,
      studentId,
      stageKey,
      preset,
      status,
      checks,
      missingEvidenceKinds: [],
      evidenceIds: [],
      completedIterations: 0,
      requiredIterations: 0,
      teacherCalibration,
      reason: readinessReason(status, checks),
      derivedAt: now,
    };
  }

  if (stageKey === "make") {
    const versions = (course.uploads ?? []).filter((item) =>
      item.stageKey === "make"
      && (item.studentId === studentId || Boolean(
        projectIdForStudent(course, studentId)
        && item.groupId === projectIdForStudent(course, studentId),
      )));
    const artifactEvidence = validEvidenceOfKind(evidence, "artifact-version", snapshots);
    const revisionDecisions = validEvidenceOfKind(evidence, "revision-decision", snapshots);
    const completedIterationIds = new Set(revisionDecisions
      .map((item) => String((item.payload as { iterationId?: string }).iterationId ?? ""))
      .filter(Boolean));
    const submitted = versions.length > 0 || artifactEvidence.length > 0;
    const requiredIterations = 1;
    const iterationReady = completedIterationIds.size >= requiredIterations;
    const checks: StageReadinessCheck[] = [
      {
        id: "make-artifact-version",
        label: "提交至少一个可查看的作品版本",
        satisfied: submitted,
        evidenceIds: artifactEvidence.map((item) => item.id),
        detail: submitted ? `已保存 ${Math.max(versions.length, artifactEvidence.length)} 个版本` : undefined,
      },
      {
        id: "make-process-draft",
        label: "保存一条真实的作品进展",
        satisfied: iterationReady,
        evidenceIds: revisionDecisions.map((item) => item.id),
        detail: iterationReady ? "已保存作品工作稿" : undefined,
      },
    ];
    const needsRevision = allStageEvidence.some((item) => item.status === "needs-revision");
    const complete = submitted && iterationReady;
    const hasWork = submitted || allStageEvidence.some((item) => item.countsTowardReadiness);
    const status: StageReadinessStatus = needsRevision
      ? "needs-revision"
      : complete
        ? "ready"
        : hasWork
          ? "working"
          : "not-started";
    return {
      courseId: course.id,
      studentId,
      stageKey,
      preset,
      status,
      checks,
      missingEvidenceKinds: [
        ...(!submitted ? ["artifact-version" as const] : []),
        ...(revisionDecisions.length ? [] : ["revision-decision" as const]),
      ],
      evidenceIds: evidence.map((item) => item.id),
      completedIterations: completedIterationIds.size,
      requiredIterations,
      teacherCalibration: "not-required",
      reason: readinessReason(status, checks),
      derivedAt: now,
    };
  }

  if (stageKey === "reflection") {
    const summary = course.experimentPosttestSummary;
    const complete = !summary?.enabled || summary.studentRows.some((item) => item.studentId === studentId && item.status === "submitted");
    const checks: StageReadinessCheck[] = [{
      id: "posttest-submission",
      label: summary?.enabled ? "提交课堂后测" : "本课堂未开启后测",
      satisfied: complete,
      evidenceIds: [],
    }];
    const status: StageReadinessStatus = complete ? "ready" : "not-started";
    return {
      courseId: course.id,
      studentId,
      stageKey,
      preset,
      status,
      checks,
      missingEvidenceKinds: [],
      evidenceIds: [],
      completedIterations: 0,
      requiredIterations: 0,
      teacherCalibration: "not-required",
      reason: readinessReason(status, checks),
      derivedAt: now,
    };
  }

  const mission = getStageMissionDefinition(stageKey, preset);
  const checks: StageReadinessCheck[] = mission.requiredEvidenceKinds.map((kind) => {
    const matching = validEvidenceOfKind(evidence, kind, snapshots);
    return {
      id: `evidence-${kind}`,
      label: evidenceLabel(kind),
      satisfied: matching.length > 0,
      evidenceIds: matching.map((item) => item.id),
    };
  });
  const completedIterations = 0;

  const teacherCalibration = teacherCalibrationForStage(course, studentId, stageKey, evidence);
  const studentRequirementsMet = checks.every((item) => item.satisfied);
  const teacherRequirementsMet =
    teacherCalibration === "not-required" || teacherCalibration === "confirmed";
  const needsRevision =
    teacherCalibration === "needs-revision"
    || allStageEvidence.some((item) => item.status === "needs-revision");
  const hasWork = allStageEvidence.some((item) => item.countsTowardReadiness);
  const status: StageReadinessStatus = needsRevision
    ? "needs-revision"
    : studentRequirementsMet && !teacherRequirementsMet
      ? "awaiting-calibration"
      : studentRequirementsMet && teacherRequirementsMet
        ? "ready"
        : hasWork
          ? "working"
          : "not-started";

  return {
    courseId: course.id,
    studentId,
    stageKey,
    preset,
    status,
    checks,
    missingEvidenceKinds: mission.requiredEvidenceKinds.filter(
      (kind) => !checks.find((item) => item.id === `evidence-${kind}`)?.satisfied,
    ),
    evidenceIds: evidence.map((item) => item.id),
    completedIterations,
    requiredIterations: mission.requiredIterations,
    teacherCalibration,
    reason: readinessReason(status, checks),
    derivedAt: now,
  };
}

export function deriveAllStageReadiness(
  course: Course,
  studentId: string,
): StageReadiness[] {
  return course.stages.map((stage) => deriveStageReadiness(course, studentId, stage.key));
}

export function evidenceLabel(kind: LearningEvidenceKind): string {
  const labels: Record<LearningEvidenceKind, string> = {
    "project-intent": "项目立意完整",
    "knowledge-transfer": "知识迁移成立",
    "key-decision": "候选方向比较与选择",
    "plan-version": "可验证方案版本",
    "artifact-version": "作品版本",
    "test-result": "真实测试结果",
    "revision-decision": "作品过程记录",
    "final-artifact": "可检查的最终作品",
    "presentation-claim": "主张—证据—局限汇报",
    "defense-response": "答辩回应",
    "reflection-chain": "因果反思链",
    "transfer-response": "新情境迁移",
    "ai-decision": "AI 建议决定记录",
  };
  return labels[kind];
}
