import { courseQuestionSet, latestCourseReflection, latestExperienceSurvey } from "@/lib/course-reflection";
import type {
  Course,
  CourseResource,
  LearningEvent,
  Student,
} from "@/lib/session/types";
import { summarizeAiLearningStudent } from "@/components/views/teacher/ai-learning";
import { aggregateKnowledgePointMastery, firstKnowledgeLectureAttempts } from "@/lib/knowledge-lecture";
import {
  latestReflectionByStudent,
  normalizeReflectionSurvey,
} from "@/lib/reflection-survey";
import {
  REFLECTION_SUMMARY_CATEGORY_DEFINITIONS,
  normalizeReflectionClassSummary,
  reflectionClassSummaryIsStale,
} from "@/lib/reflection-summary";
import { buildShowcaseQueue } from "@/lib/showcase/queue";
import type { ShowcaseData, ShowcaseQueueItem } from "@/lib/showcase/types";

export type TeacherDashboardTone = "neutral" | "info" | "success" | "warning" | "danger";

export type TeacherDashboardMetric = {
  metricId: string;
  label: string;
  value: string;
  helper?: string;
  tone?: TeacherDashboardTone;
};

export type TeacherStageFocus =
  | {
      stageKey: "launch";
      target: "reading";
      resourceId?: string;
      studentId?: string;
      status?: LaunchResourceStatus;
    }
  | {
      stageKey: "ai-learning";
      target: "student";
      studentId: string;
      tab: "trajectory" | "answers";
    }
  | {
      stageKey: "make";
      target: "student";
      studentId: string;
      section: "artifact" | "conversation" | "signal";
    }
  | {
      stageKey: "showcase";
      target: "student";
      studentId: string;
    }
  | {
      stageKey: "reflection";
      target: "student-list";
      filter: "all" | "pending" | "low-score";
      studentId?: string;
    };

export type LaunchResourceStatus = "not-opened" | "opened" | "in-progress" | "completed";

export type LaunchStudentResourceState = {
  studentId: string;
  resourceId: string;
  status: LaunchResourceStatus;
  progressPercent: number;
  lastOccurredAt?: string;
};

export type LaunchResourceCoverage = {
  resource: CourseResource;
  openedCount: number;
  completedCount: number;
  inProgressCount: number;
};

export type LaunchDashboardMetrics = {
  studentCount: number;
  startedCount: number;
  completedAllCount: number;
  states: LaunchStudentResourceState[];
  resourceCoverage: LaunchResourceCoverage[];
  studentRows: Array<{
    student: Student;
    status: "not-started" | "in-progress" | "completed";
    openedCount: number;
    completedCount: number;
  }>;
  projection: {
    active: boolean;
    title?: string;
  };
  headlines: TeacherDashboardMetric[];
};

export type KnowledgeDashboardMetrics = {
  headlines: TeacherDashboardMetric[];
  stateCounts: { notStarted: number; learning: number; completed: number };
  masteryRows: ReturnType<typeof aggregateKnowledgePointMastery>;
  sectionRows: Array<{
    id: string;
    title: string;
    answeredCount: number;
    averageScore?: number;
    estimatedMinutes: number;
  }>;
  attentionRows: ReturnType<typeof summarizeAiLearningStudent>[];
  studentRows: ReturnType<typeof summarizeAiLearningStudent>[];
};

export type MakeDashboardMetrics = {
  headlines: TeacherDashboardMetric[];
  draftStudentIds: Set<string>;
  submittedStudentIds: Set<string>;
  highPriorityStudentIds: Set<string>;
  collaborationStudentIds: Set<string>;
  decisionCounts: { adopted: number; rejected: number };
  boundaryTriggerCount: number;
  attentionRows: Array<{ student: Student; reasons: string[]; severity: "warning" | "high" }>;
};

type MakeDecisionRecord = {
  key: string;
  studentId: string;
  decision: "adopted" | "rejected";
};

export type ShowcaseDashboardMetrics = {
  headlines: TeacherDashboardMetric[];
  expectedEndAt?: string;
  queue: ShowcaseQueueItem[];
  statusCounts: Record<ShowcaseQueueItem["status"], number>;
  pendingApprovals: ShowcaseQueueItem[];
  actualDurations: Array<{ studentName: string; actualMinutes: number; plannedMinutes: number }>;
  current?: ShowcaseQueueItem;
  next?: ShowcaseQueueItem;
};

export type ReflectionDashboardMetrics = {
  headlines: TeacherDashboardMetric[];
  submittedCount: number;
  lowScoreRows: Array<{ student: Student; dimensions: string[] }>;
  pendingStudents: Student[];
  averages: { aiHelpfulness?: number; systemUsability?: number; reuseIntention?: number };
  summary: ReturnType<typeof normalizeReflectionClassSummary>;
  summaryStale: boolean;
};

function ratio(numerator: number, denominator: number): string {
  return denominator > 0 ? `${numerator}/${denominator}` : "—";
}

function observedRatio(numerator: number, denominator: number, observed: boolean): string {
  return observed ? ratio(numerator, denominator) : "—";
}

function median(values: number[]): number | undefined {
  if (!values.length) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

function numericMetadata(event: LearningEvent, key: string): number | undefined {
  const value = event.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function resourceIdForEvent(event: LearningEvent): string | undefined {
  const fromMetadata = event.metadata?.resourceId;
  return typeof fromMetadata === "string" && fromMetadata ? fromMetadata : event.sceneId;
}

function resourceState(
  course: Course,
  studentId: string,
  resource: CourseResource,
): LaunchStudentResourceState {
  const events = (course.learningEvents ?? [])
    .filter((event) => event.studentId === studentId && event.stageKey === "launch" && resourceIdForEvent(event) === resource.id)
    .filter((event) => event.metadata?.source !== "teacher-projection")
    .filter((event, index, all) => all.findIndex((candidate) => (candidate.idempotencyKey || candidate.id) === (event.idempotencyKey || event.id)) === index)
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
  let opened = false;
  let completed = false;
  let maxProgress = 0;
  let lastOccurredAt: string | undefined;
  for (const event of events) {
    if (event.type !== "resource-open" && event.type !== "resource-progress" && event.type !== "resource-complete") continue;
    opened = true;
    completed ||= event.type === "resource-complete";
    maxProgress = Math.max(maxProgress, numericMetadata(event, "progressPercent") ?? (event.progressMarker === "completed" ? 100 : 0));
    lastOccurredAt = event.occurredAt;
  }
  // Existing launch records only contain downloadedBy. It means the student
  // opened the resource, never that they reached its end.
  if (!opened && (resource.downloadedBy ?? []).includes(studentId)) opened = true;
  if (completed || maxProgress >= 90) {
    return { studentId, resourceId: resource.id, status: "completed", progressPercent: Math.max(90, maxProgress), lastOccurredAt };
  }
  if (maxProgress > 0) {
    return { studentId, resourceId: resource.id, status: "in-progress", progressPercent: maxProgress, lastOccurredAt };
  }
  return { studentId, resourceId: resource.id, status: opened ? "opened" : "not-opened", progressPercent: 0, lastOccurredAt };
}

export function deriveLaunchDashboardMetrics(course: Course): LaunchDashboardMetrics {
  const resources = (course.resources ?? [])
    .filter((resource) => resource.stageKey === "launch" || !resource.stageKey)
    .filter((resource, index, all) => all.findIndex((candidate) => candidate.id === resource.id) === index);
  const studentStates = course.students.flatMap((student) => resources.map((resource) => resourceState(course, student.id, resource)));
  const statesByKey = new Map(studentStates.map((state) => [`${state.studentId}:${state.resourceId}`, state]));
  const resourceCoverage = resources.map((resource) => {
    const states = course.students.map((student) => statesByKey.get(`${student.id}:${resource.id}`)!);
    return {
      resource,
      openedCount: states.filter((state) => state.status !== "not-opened").length,
      completedCount: states.filter((state) => state.status === "completed").length,
      inProgressCount: states.filter((state) => state.status === "in-progress").length,
    };
  });
  const studentRows = course.students.map((student) => {
    const states = resources.map((resource) => statesByKey.get(`${student.id}:${resource.id}`)!);
    const openedCount = states.filter((state) => state.status !== "not-opened").length;
    const completedCount = states.filter((state) => state.status === "completed").length;
    return {
      student,
      status: resources.length > 0 && completedCount === resources.length
        ? "completed" as const
        : openedCount > 0
          ? "in-progress" as const
          : "not-started" as const,
      openedCount,
      completedCount,
    };
  });
  const startedCount = studentRows.filter((row) => row.openedCount > 0).length;
  const completedAllCount = studentRows.filter((row) => row.status === "completed").length;
  const hasEvidence = studentStates.some((state) => state.status !== "not-opened");
  const projected = course.uiState?.resourceProjection;
  return {
    studentCount: course.students.length,
    startedCount,
    completedAllCount,
    states: studentStates,
    resourceCoverage,
    studentRows,
    projection: { active: Boolean(projected?.stageKey === "launch"), title: projected?.stageKey === "launch" ? projected.title : undefined },
    headlines: [
      { metricId: "launch-started", label: "已开始浏览", value: observedRatio(startedCount, course.students.length, hasEvidence), helper: hasEvidence ? "至少打开一份启动资料" : resources.length ? "等待学生打开启动资料" : "尚未发布启动资料" },
      { metricId: "launch-completed", label: "全部资料浏览完成", value: resources.length ? observedRatio(completedAllCount, course.students.length, hasEvidence) : "—", helper: resources.length ? (hasEvidence ? `${resources.length} 份资料均达到完成边界` : "等待首份有效浏览记录") : "尚未发布启动资料", tone: completedAllCount === course.students.length && resources.length > 0 ? "success" : "info" },
      { metricId: "launch-projection", label: "当前投屏", value: projected?.stageKey === "launch" ? projected.title : "未投屏", helper: projected?.stageKey === "launch" ? "学生端正在同步" : "可从资料预览开始投屏", tone: projected?.stageKey === "launch" ? "success" : "neutral" },
    ],
  };
}

export function deriveKnowledgeDashboardMetrics(course: Course): KnowledgeDashboardMetrics {
  const studentRows = course.students.map((student) => summarizeAiLearningStudent(course, student));
  const progressEntries = Object.entries(course.aiLearningProgress ?? {});
  const answeredStudents = new Set(
    progressEntries.flatMap(([studentId, entry]) => firstKnowledgeLectureAttempts(entry).length ? [studentId] : []),
  );
  const highPriorityStudentIds = new Set(studentRows.flatMap((row) => row.signals.some((signal) => signal.severity === "high") ? [row.student.id] : []));
  const stateCounts = {
    notStarted: studentRows.filter((row) => !row.hasEvidence).length,
    learning: studentRows.filter((row) => row.hasEvidence && row.progress < 100).length,
    completed: studentRows.filter((row) => row.progress >= 100).length,
  };
  const masteryRows = aggregateKnowledgePointMastery(course);
  const sectionRows = (course.content.knowledgeLectureSections ?? []).map((section) => {
    const sectionAttempts = progressEntries.flatMap(([studentId, entry]) => firstKnowledgeLectureAttempts(entry)
      .filter((attempt) => attempt.sectionId === section.id)
      .map((attempt) => ({ studentId, attempt })));
    const score = sectionAttempts.length
      ? Math.round(sectionAttempts.reduce((sum, item) => sum + (item.attempt.maxScore > 0 ? item.attempt.score / item.attempt.maxScore : 0), 0) / sectionAttempts.length * 100)
      : undefined;
    return { id: section.id, title: section.title, answeredCount: new Set(sectionAttempts.map((item) => item.studentId)).size, averageScore: score, estimatedMinutes: section.estimatedMinutes };
  });
  const progressValues = studentRows.map((row) => row.progress);
  const hasProgressEvidence = studentRows.some((row) => row.hasEvidence || row.progress > 0 || row.accuracy !== undefined);
  const hasQuizEvidence = answeredStudents.size > 0;
  const hasSignalEvidence = (course.learningSignals ?? []).some((signal) => signal.stageKey === "ai-learning");
  return {
    headlines: [
      { metricId: "knowledge-median-progress", label: "班级进度中位数", value: hasProgressEvidence ? `${median(progressValues)}%` : "—", helper: hasProgressEvidence ? "按每名学生可靠学习记录计算" : "等待学生产生有效学习记录" },
      { metricId: "knowledge-quiz-coverage", label: "小测覆盖", value: observedRatio(answeredStudents.size, course.students.length, hasQuizEvidence), helper: hasQuizEvidence ? "至少提交一节节末小测" : "等待首份节末小测" },
      { metricId: "knowledge-high-priority", label: "高优先级信号", value: hasSignalEvidence ? `${highPriorityStudentIds.size} 人` : "—", helper: hasSignalEvidence ? "需要教师优先判断的学习信号" : "尚无可排序的学习信号", tone: highPriorityStudentIds.size ? "warning" : "success" },
    ],
    stateCounts,
    masteryRows,
    sectionRows,
    attentionRows: [...studentRows]
      .filter((row) => row.signals.length)
      .sort((left, right) => {
        const severity = (row: typeof left) => Math.max(...row.signals.map((signal) => signal.severity === "high" ? 3 : signal.severity === "warning" ? 2 : 1));
        return severity(right) - severity(left) || right.signals.length - left.signals.length;
      }),
    studentRows,
  };
}

function makeArtifactIds(course: Course): Set<string> {
  return new Set([
    ...(course.submissions ?? []).flatMap((submission) => submission.stageKey === "make" && submission.status !== "failed" && submission.studentId && ["document", "artifact-brief", "code"].includes(submission.type) ? [submission.studentId] : []),
    ...(course.projectDocumentVersions ?? []).filter((version) => version.stageKey === "make" && version.status !== "failed").map((version) => version.studentId),
    ...(course.projectPdfVersions ?? []).filter((version) => version.stageKey === "make" && version.status !== "failed").map((version) => version.studentId),
  ]);
}

function makeSubmittedIds(course: Course): Set<string> {
  return new Set([
    ...(course.projectDocumentVersions ?? []).filter((version) => version.stageKey === "make" && version.status === "submitted").map((version) => version.studentId),
    ...(course.projectPdfVersions ?? []).filter((version) => version.stageKey === "make" && version.status === "submitted").map((version) => version.studentId),
    ...(course.submissions ?? []).flatMap((submission) => submission.stageKey === "make" && submission.status !== "failed" && submission.studentId && submission.files?.length ? [submission.studentId] : []),
  ]);
}

/**
 * StudentAiDecision is the durable source of truth. Older classroom snapshots
 * only persisted the interaction stream, so merge it as a compatibility
 * fallback while letting a durable decision win when both records exist.
 * `modified` is grouped with adopted because the suggestion changed the
 * student's artifact rather than being discarded.
 */
function makeDecisionRecords(course: Course): MakeDecisionRecord[] {
  const records = new Map<string, MakeDecisionRecord>();
  const aliases = new Set<string>();
  const addRecord = (record: MakeDecisionRecord, alternateKeys: string[]) => {
    if (alternateKeys.some((key) => aliases.has(key))) return false;
    records.set(record.key, record);
    alternateKeys.forEach((key) => aliases.add(key));
    return true;
  };
  for (const decision of (course.studentAiDecisions ?? []).filter((item) => item.stageKey === "make")) {
    const key = `${decision.studentId}:${decision.contributionId || decision.id}`;
    addRecord({
      key,
      studentId: decision.studentId,
      decision: decision.decision === "rejected" ? "rejected" : "adopted",
    }, [
      `${decision.studentId}:id:${decision.id}`,
      ...(decision.contributionId ? [`${decision.studentId}:contribution:${decision.contributionId}`] : []),
    ]);
  }
  for (const event of (course.aiInteractionEvents ?? []).filter((item) => item.stageKey === "make" && item.actorRole === "student" && item.eventType === "decision")) {
    const rawDecision = event.payload?.decision;
    if (rawDecision !== "adopted" && rawDecision !== "modified" && rawDecision !== "rejected") continue;
    const contributionId = typeof event.payload?.contributionId === "string" ? event.payload.contributionId : undefined;
    const key = `${event.studentId}:${contributionId ?? event.requestId ?? event.id}`;
    addRecord({
      key,
      studentId: event.studentId,
      decision: rawDecision === "rejected" ? "rejected" : "adopted",
    }, [
      `${event.studentId}:id:${event.id}`,
      ...(event.requestId ? [`${event.studentId}:contribution:${event.requestId}`] : []),
      ...(contributionId ? [`${event.studentId}:contribution:${contributionId}`] : []),
    ]);
  }
  return [...records.values()];
}

export function deriveMakeDashboardMetrics(course: Course): MakeDashboardMetrics {
  const draftStudentIds = makeArtifactIds(course);
  const submittedStudentIds = makeSubmittedIds(course);
  const openSignals = (course.learningSignals ?? []).filter((signal) => signal.stageKey === "make" && signal.status === "open");
  const highPriorityStudentIds = new Set(openSignals.filter((signal) => signal.severity === "high").map((signal) => signal.studentId));
  const collaborationEvents = (course.aiInteractionEvents ?? []).filter((event) => event.stageKey === "make");
  const decisionRecords = makeDecisionRecords(course);
  const collaborationStudentIds = new Set([
    ...collaborationEvents.filter((event) => event.actorRole === "student" && ["request", "decision"].includes(event.eventType)).map((event) => event.studentId),
    ...decisionRecords.map((record) => record.studentId),
  ]);
  const decisionCounts = {
    adopted: decisionRecords.filter((record) => record.decision === "adopted").length,
    rejected: decisionRecords.filter((record) => record.decision === "rejected").length,
  };
  const hasArtifactEvidence = draftStudentIds.size > 0 || submittedStudentIds.size > 0 || (course.submissions ?? []).some((submission) => submission.stageKey === "make") || (course.projectDocumentVersions ?? []).some((version) => version.stageKey === "make") || (course.projectPdfVersions ?? []).some((version) => version.stageKey === "make");
  const hasSignalEvidence = (course.learningSignals ?? []).some((signal) => signal.stageKey === "make");
  const boundaryTriggerCount = new Set(collaborationEvents.flatMap((event) => {
    const payload = event.payload ?? {};
    return (event.eventType === "response" && payload.kind === "boundary") || (event.eventType === "policy" && typeof payload.protectedCapability === "string")
      ? [event.requestId ?? event.id]
      : [];
  })).size;
  const attentionRows = course.students.flatMap((student) => {
    const signals = openSignals.filter((signal) => signal.studentId === student.id);
    if (!signals.length) return [];
    return [{ student, reasons: signals.slice(0, 3).map((signal) => signal.title), severity: signals.some((signal) => signal.severity === "high") ? "high" as const : "warning" as const }];
  }).sort((left, right) => (left.severity === "high" ? -1 : 1) - (right.severity === "high" ? -1 : 1));
  return {
    headlines: [
      { metricId: "make-drafts", label: "已形成成果草稿", value: observedRatio(draftStudentIds.size, course.students.length, hasArtifactEvidence), helper: hasArtifactEvidence ? "已有平台工作稿或上传版本" : "等待首份成果草稿" },
      { metricId: "make-submitted", label: "已提交定稿", value: observedRatio(submittedStudentIds.size, course.students.length, hasArtifactEvidence), helper: hasArtifactEvidence ? "可进入成果汇报的提交版本" : "等待首份定稿提交" },
      { metricId: "make-high-priority", label: "高优先级预警", value: hasSignalEvidence ? `${highPriorityStudentIds.size} 人` : "—", helper: hasSignalEvidence ? "来自真实协作或学习信号" : "尚无可排序的学习信号", tone: highPriorityStudentIds.size ? "warning" : "success" },
    ],
    draftStudentIds,
    submittedStudentIds,
    highPriorityStudentIds,
    collaborationStudentIds,
    decisionCounts,
    boundaryTriggerCount,
    attentionRows,
  };
}

function fallbackShowcaseQueue(course: Course): ShowcaseQueueItem[] {
  const students = course.students.map((student) => {
    const artifacts = [
      ...(course.projectDocumentVersions ?? []).filter((version) => ["make", "showcase"].includes(version.stageKey) && version.studentId === student.id && version.status === "submitted").map((version) => ({ kind: "document" as const, versionId: version.id, title: version.title, sequence: version.sequence, submittedAt: version.submittedAt ?? version.createdAt, displayModes: ["continuous" as const] })),
      ...(course.projectPdfVersions ?? []).filter((version) => ["make", "showcase"].includes(version.stageKey) && version.studentId === student.id && version.status === "submitted").map((version) => ({ kind: "pdf" as const, versionId: version.id, title: version.title, sequence: version.sequence, submittedAt: version.submittedAt, displayModes: ["continuous" as const, "slides" as const] })),
    ];
    return { studentId: student.id, name: student.name, groupId: course.groups?.find((group) => group.members.some((member) => member.studentId === student.id))?.id, artifacts };
  });
  return buildShowcaseQueue(students, course.showcasePresentations ?? [], course.presentingStudentId, course.uiState?.showcaseReporting ?? (course.content.stagePlan?.schemaVersion === 2 ? { schemaVersion: 2, selectionMode: "teacher-selected", selectedStudentIds: [], orderedStudentIds: [] } : undefined)).items;
}

export function deriveShowcaseDashboardMetrics(course: Course, data?: ShowcaseData): ShowcaseDashboardMetrics {
  const queue = data?.queue ?? fallbackShowcaseQueue(course);
  const statusCounts = queue.reduce<Record<ShowcaseQueueItem["status"], number>>((counts, item) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, { "not-ready": 0, waiting: 0, called: 0, "pending-approval": 0, presenting: 0, evaluating: 0, rejected: 0, completed: 0 });
  const presentations = data?.presentations ?? course.showcasePresentations ?? [];
  const plannedMinutes = data?.minutesPerStudent ?? course.uiState?.showcaseReporting?.minutesPerStudent ?? 5;
  const actualDurations = presentations.flatMap((presentation) => {
    if (!presentation.startedAt || !presentation.endedAt) return [];
    const startedAt = Date.parse(presentation.startedAt);
    const endedAt = Date.parse(presentation.endedAt);
    if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt)) return [];
    const elapsed = Math.max(0, (endedAt - startedAt) / 60_000);
    const student = course.students.find((item) => item.id === presentation.studentId);
    return [{ studentName: student?.name ?? presentation.studentName ?? "学生", actualMinutes: Math.round(elapsed * 10) / 10, plannedMinutes }];
  });
  const readyCount = queue.filter((item) => item.status !== "not-ready").length;
  const completedCount = queue.filter((item) => item.status === "completed").length;
  const now = Date.now();
  const remainingMinutes = data?.budget ? data.budget.plannedRemainingSec / 60 : queue.filter((item) => !["completed", "not-ready"].includes(item.status)).reduce((sum, item) => {
    if (item.status === "presenting" && item.startedAt) {
      const startedAt = Date.parse(item.startedAt);
      const elapsed = Number.isFinite(startedAt) ? Math.max(0, (now - startedAt) / 60_000) : 0;
      return sum + Math.max(0, plannedMinutes - Math.min(plannedMinutes, elapsed));
    }
    if (item.status === "evaluating") return sum;
    return sum + (item.estimatedWaitMinutes ?? plannedMinutes);
  }, 0);
  return {
    headlines: [
      { metricId: "showcase-ready", label: "成果已就绪", value: ratio(readyCount, queue.length), helper: "已有可投屏文档或 PDF" },
      { metricId: "showcase-evaluated", label: "已完成评价", value: ratio(completedCount, queue.length), helper: "教师已结束汇报评价", tone: completedCount === queue.length && queue.length > 0 ? "success" : "info" },
      { metricId: "showcase-eta", label: "预计剩余", value: remainingMinutes > 0 ? `${Math.round(remainingMinutes)} 分钟` : "—", helper: queue.length ? `按每人约 ${plannedMinutes} 分钟估算` : "暂无可汇报队列" },
    ],
    expectedEndAt: remainingMinutes > 0 ? new Date(now + remainingMinutes * 60_000).toISOString() : undefined,
    queue,
    statusCounts,
    pendingApprovals: queue.filter((item) => item.status === "pending-approval"),
    actualDurations,
    current: data?.currentQueueItem ?? queue.find((item) => ["called", "pending-approval", "presenting", "evaluating", "rejected"].includes(item.status)),
    next: data?.nextQueueItem ?? queue.find((item) => item.status === "waiting"),
  };
}

function latestReflectionSummary(course: Course) {
  const support = (course.aiSupports ?? [])
    .filter((item) => item.kind === "reflection-class-summary" && item.targetType === "course")
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];
  return normalizeReflectionClassSummary(support?.structuredPayload, new Set(course.students.map((student) => student.id)));
}

export function deriveReflectionDashboardMetrics(course: Course): ReflectionDashboardMetrics {
  const latest = latestReflectionByStudent(course.reflections);
  const records = course.students.map((student) => ({ student, reflection: courseQuestionSet(course) ? latestCourseReflection(course, student.id) : latest.get(student.id), survey: courseQuestionSet(course) ? latestExperienceSurvey(course, student.id) : normalizeReflectionSurvey(latest.get(student.id)?.survey) }));
  const submitted = records.filter((item) => courseQuestionSet(course) ? Boolean(item.reflection?.courseReflection) : Boolean(item.survey));
  const lowScoreRows = records.flatMap(({ student, survey }) => {
    if (!survey) return [];
    const dimensions = [
      survey.aiHelpfulness <= 2 ? "AI 引导帮助" : "",
      survey.systemUsability <= 2 ? "系统易理解" : "",
      survey.reuseIntention <= 2 ? "继续使用意愿" : "",
    ].filter(Boolean);
    return dimensions.length ? [{ student, dimensions }] : [];
  });
  const summary = latestReflectionSummary(course);
  const hasValidSurvey = submitted.length > 0;
  const average = (key: "aiHelpfulness" | "systemUsability" | "reuseIntention") => {
    const values = records.flatMap((item) => item.survey ? [item.survey[key]] : []);
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : undefined;
  };
  return {
    headlines: [
      { metricId: "reflection-coverage", label: "有效反思提交", value: observedRatio(submitted.length, course.students.length, hasValidSurvey), helper: courseQuestionSet(course) ? "按课程题集统计，体验问卷独立提交" : hasValidSurvey ? "仅统计新版结构化问卷" : "等待有效结构化问卷" },
      { metricId: "reflection-ai-helpfulness", label: "AI 帮助度", value: average("aiHelpfulness")?.toFixed(1) ?? "—", helper: "满分 5 分" },
      { metricId: "reflection-system-usability", label: "系统易理解度", value: average("systemUsability")?.toFixed(1) ?? "—", helper: "满分 5 分" },
      { metricId: "reflection-reuse", label: "继续使用意愿", value: average("reuseIntention")?.toFixed(1) ?? "—", helper: "满分 5 分" },
    ],
    submittedCount: submitted.length,
    lowScoreRows,
    pendingStudents: records.filter((item) => courseQuestionSet(course) ? !item.reflection?.courseReflection : !item.survey).map((item) => item.student),
    averages: {
      aiHelpfulness: average("aiHelpfulness") ?? undefined,
      systemUsability: average("systemUsability") ?? undefined,
      reuseIntention: average("reuseIntention") ?? undefined,
    },
    summary,
    summaryStale: reflectionClassSummaryIsStale(summary, course),
  };
}

export function reflectionSummaryCategoryTitles(): string[] {
  return REFLECTION_SUMMARY_CATEGORY_DEFINITIONS.map((definition) => definition.title);
}
