import type { Course, Stage } from "@/lib/session/types";
import { isReliableAiProgress } from "@openmaic/lib/progress/completion-model";
import { isReadyMadeDeliverableRequest } from "@/lib/learning-evidence/ai-policy";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";

export type StageGateItem = {
  code: string;
  message: string;
  targetIds: string[];
};

export type StageGateResult = {
  canAdvance: boolean;
  stage: Stage;
  blockers: StageGateItem[];
  warnings: StageGateItem[];
  completed: string[];
};

export type InterventionSignal = {
  id: string;
  kind: "shared-misconception" | "off-target" | "over-generation" | "ethics" | "low-confidence" | "stalled";
  title: string;
  whatHappened: string;
  evidence: string[];
  targetType: "student" | "group" | "course";
  targetIds: string[];
  suggestedAction: string;
  confidence: "medium" | "high";
  stageKey?: string;
  contentLocation?: string;
};

export function evaluateStageGate(course: Course, stageIndex = course.currentStageIndex): StageGateResult {
  const stage = course.stages[stageIndex] ?? course.stages[0];
  const blockers: StageGateItem[] = [];
  const warnings: StageGateItem[] = [];
  const completed: string[] = [];

  if (stage.key === "make") {
    const makeArtifactMode = normalizePblCourseConfig(course.pblConfig).makeArtifactMode;
    const studentsWithoutArtifact = course.students
      .filter((student) => makeArtifactMode === "other"
        ? !(course.projectPdfVersions ?? []).some((version) =>
            version.stageKey === "make"
            && version.studentId === student.id
            && version.status === "submitted")
        : !(course.submissions ?? []).some((submission) =>
            submission.stageKey === "make"
            && submission.studentId === student.id
            && (submission.type === "document" || submission.type === "code")
            && submission.content.trim().length > 0))
      .map((student) => student.id);
    if (studentsWithoutArtifact.length) {
      blockers.push({
        code: "collaboration-artifact",
        message: makeArtifactMode === "other"
          ? `${studentsWithoutArtifact.length} 名学生尚未上传本地成果文件`
          : `${studentsWithoutArtifact.length} 名学生尚未保存文档或代码项目产物`,
        targetIds: studentsWithoutArtifact,
      });
    } else if (course.students.length) {
      completed.push(makeArtifactMode === "other" ? "所有学生均已上传本地成果文件" : "所有学生均已保存项目实践产物");
    } else {
      warnings.push({
        code: "participants",
        message: "当前尚无学生进入课堂",
        targetIds: [],
      });
    }
    return { canAdvance: blockers.length === 0, stage, blockers, warnings, completed };
  }

  if (stage.key !== "ai-learning") {
    const resourceCount = (course.resources ?? []).filter((resource) =>
      resource.stageKey === stage.key
      || (stage.key === "launch" && !resource.stageKey)).length;
    if (resourceCount) completed.push(`本阶段已准备 ${resourceCount} 份授课资源`);
    else warnings.push({
      code: "stage-resources",
      message: "本阶段尚未上传授课资源，可继续切换阶段",
      targetIds: [course.id],
    });
    return { canAdvance: true, stage, blockers, warnings, completed };
  }

  const hasAiContent = Boolean(
    course.aiLearningClassroomId
    || course.content._openmaicClassroomId
    || course.content._openmaicSceneOutlines?.length,
  );
  if (!hasAiContent) {
    blockers.push({
      code: "ai-content",
      message: "知识讲授内容尚未生成或关联",
      targetIds: [course.id],
    });
  } else {
    completed.push("知识讲授内容可用");
  }
  const unmet = Object.entries(course.aiLearningProgress ?? {})
    .filter(([, progress]) =>
      !isReliableAiProgress(progress)
      || progress.unmetGoals?.length
      || progress.masteryLevel === "not-started")
    .map(([studentId]) => studentId);
  if (unmet.length) {
    warnings.push({
      code: "unmet-goals",
      message: `${unmet.length} 名学生仍有未达成目标，需要教师处理或说明覆盖`,
      targetIds: unmet,
    });
  }

  return { canAdvance: blockers.length === 0, stage, blockers, warnings, completed };
}

export function detectInterventionSignals(course: Course): InterventionSignal[] {
  const signals: InterventionSignal[] = [];
  const resolvedIds = new Set(course.resolvedInterventionSignalIds ?? []);
  const progress = Object.entries(course.aiLearningProgress ?? {});
  const activeStageKey = course.stages[course.currentStageIndex]?.key;
  const misconception = new Map<string, string[]>();
  progress.forEach(([studentId, item]) => item.unmetGoals?.forEach((goal) => misconception.set(goal, [...(misconception.get(goal) ?? []), studentId])));
  misconception.forEach((studentIds, goal) => {
    const population = Math.max(course.students.length, progress.length);
    if (population < 2) return;
    const required = Math.min(population, Math.max(2, Math.ceil(population * 0.3)));
    if (studentIds.length >= required) signals.push({ id: `misconception:${goal}`, kind: "shared-misconception", title: "共性知识目标持续未达成", whatHappened: `${studentIds.length} 名学生在知识点“${goal}”上仍未达标`, evidence: studentIds.map((id) => `${course.students.find((student) => student.id === id)?.name ?? "未识别学生"}：目标未达成`), targetType: "student", targetIds: studentIds, suggestedAction: "向全班补充一个对比案例，并要求学生重新解释判断依据", confidence: "high", stageKey: "ai-learning", contentLocation: `知识点：${goal}` });
  });

  // Runtime telemetry may trigger timely support, but never contributes to
  // readiness or scoring. The detector consumes only the retained signal
  // records instead of inferring learning from page time or save counts.
  (course.learningSignals ?? [])
    .filter((item) =>
      item.stageKey === activeStageKey
      && item.status === "open"
      && ["idle", "conversation-no-progress", "goal-stalled"].includes(item.kind))
    .forEach((item) => {
      const studentName = course.students.find((student) =>
        student.id === item.studentId)?.name ?? item.studentId;
      signals.push({
        id: `operational:${item.id}`,
        kind: "stalled",
        title: "学生可能需要即时支援",
        whatHappened: `${studentName} 出现“${item.title}”运行信号；该信号只提示教师查看，不代表学习质量低。`,
        evidence: [
          `运行信号 ${item.id}：${item.summary}`,
          ...item.evidenceEventIds.map((id) => `运行事件 ${id}`),
        ],
        targetType: "student",
        targetIds: [item.studentId],
        suggestedAction: "先查看学生最近的有效产物和证据缺口，再帮助其缩小为一个可立即完成的动作。",
        confidence: item.severity === "high" ? "high" : "medium",
        stageKey: item.stageKey,
        contentLocation: item.content?.activityTitle ?? item.content?.sceneTitle,
      });
    });

  // Ready-made deliverable requests and high-impact suggestions without a
  // student seed are audit-backed support signals, not negative marks.
  (course.aiContributions ?? [])
    .filter((item) =>
      item.stageKey === activeStageKey
      && (
        isReadyMadeDeliverableRequest(item.request)
        || (item.impact === "high" && item.sourceEvidenceIds.length === 0)
      ))
    .forEach((item) => {
      signals.push({
        id: `over-generation:${item.id}`,
        kind: "over-generation",
        title: "高影响 AI 请求需要学生先提供种子产物",
        whatHappened: "系统记录到完整代做请求，或一条没有学生证据来源的高影响建议。",
        evidence: [
          `AI 建议记录 ${item.id}`,
          item.sourceEvidenceIds.length
            ? `关联学生证据：${item.sourceEvidenceIds.join("、")}`
            : "未关联学生种子证据",
        ],
        targetType: "student",
        targetIds: [item.studentId],
        suggestedAction: "要求学生先提交自己的想法、草稿或测试结果，再让 AI 提供局部反馈。",
        confidence: "high",
        stageKey: item.stageKey,
      });
    });

  const revisionPatterns: Array<{
    kind: "off-target" | "ethics";
    pattern: RegExp;
    title: string;
    suggestedAction: string;
  }> = [
    {
      kind: "off-target",
      pattern: /偏离|离题|目标不一致|范围不当|off[- ]?target/i,
      title: "教师反馈指出项目方向需要校准",
      suggestedAction: "与学生重新核对驱动问题、成功标准和项目范围，再提交修订版本。",
    },
    {
      kind: "ethics",
      pattern: /伦理|隐私|安全|公平|价值冲突|ethic|privacy|safety/i,
      title: "教师反馈指出伦理、安全或隐私问题",
      suggestedAction: "暂停相关实施动作，先明确数据边界、风险控制和教师要求。",
    },
  ];
  (course.learningEvidence ?? [])
    .filter((item) =>
      item.stageKey === activeStageKey
      && item.status === "needs-revision"
      && Boolean(item.teacherFeedback?.trim()))
    .forEach((item) => {
      revisionPatterns
        .filter(({ pattern }) => pattern.test(item.teacherFeedback ?? ""))
        .forEach(({ kind, title, suggestedAction }) => {
          signals.push({
            id: `${kind}:${item.id}`,
            kind,
            title,
            whatHappened: item.teacherFeedback ?? "教师要求修订该证据。",
            evidence: [`学习证据 ${item.id}`, `教师反馈：${item.teacherFeedback}`],
            targetType: "student",
            targetIds: [item.studentId],
            suggestedAction,
            confidence: "high",
            stageKey: item.stageKey,
            contentLocation: item.title,
          });
        });
    });

  (course.aiAssessmentSuggestions ?? [])
    .filter((item) =>
      item.stageKey === activeStageKey
      && (
        item.status === "insufficient-evidence"
        || item.confidence === "low"
        || item.evidenceGaps.length > 0
      ))
    .forEach((item) => {
      signals.push({
        id: `assessment-gap:${item.id}`,
        kind: "low-confidence",
        title: "AI 评价建议存在证据缺口",
        whatHappened: item.evidenceGaps.length
          ? item.evidenceGaps.join("；")
          : "当前证据不足以形成稳定评价建议。",
        evidence: [
          `AI 评价建议 ${item.id}`,
          ...item.evidenceIds.map((id) => `引用证据 ${id}`),
        ],
        targetType: "student",
        targetIds: [item.studentId],
        suggestedAction: "教师先检查所列证据及缺口；证据不足的维度记 0 分，并可补充指导让 AI 重新评分后再确认。",
        confidence: "high",
        stageKey: item.stageKey,
      });
    });

  const selectedSnapshotIds = new Map<string, string>();
  (course.learningEvidence ?? [])
    .filter((item) =>
      item.stageKey === activeStageKey
      && item.status !== "draft")
    .forEach((item) => {
      const payloadSnapshotId = (item.payload as { snapshotId?: unknown }).snapshotId;
      const snapshotIds = [
        ...item.artifactSnapshotIds,
        ...(typeof payloadSnapshotId === "string" ? [payloadSnapshotId] : []),
      ];
      snapshotIds.forEach((snapshotId) =>
        selectedSnapshotIds.set(snapshotId, item.id));
    });
  (course.artifactSnapshots ?? [])
    .filter((item) =>
      item.stageKey === activeStageKey
      && selectedSnapshotIds.has(item.id)
      && ["metadata-only", "unsupported"].includes(item.inspectionStatus))
    .forEach((item) => {
      signals.push({
        id: `snapshot-uninspectable:${item.id}`,
        kind: "low-confidence",
        title: "已提交证据引用了不可检查的文件快照",
        whatHappened: `快照“${item.title}”只有文件元数据，系统和 AI 均不能据此判断作品内容。`,
        evidence: [
          `作品快照 ${item.id}`,
          `引用证据 ${selectedSnapshotIds.get(item.id)}`,
        ],
        targetType: "student",
        targetIds: [item.studentId],
        suggestedAction: "请学生补充真实内容摘录或定位标注；不要把上传成功当作任务完成。",
        confidence: "high",
        stageKey: item.stageKey,
        contentLocation: item.title,
      });
    });

  return signals.filter((signal, index, all) => !resolvedIds.has(signal.id) && all.findIndex((item) => item.id === signal.id) === index);
}
