// Domain types for the CoTeach classroom.

import type { PblCourseConfig } from "@/lib/pbl-course-config";
import type {
  PblDetailKind,
  PblTtsPolicy,
  SceneResourceType,
} from "@openmaic/lib/types/generation";
import type { PblModuleTimingPlan, PblProjectMainline } from "@/lib/pbl-time-model";
import type { PblActivityTimingInput } from "@/lib/pbl-time-estimation";
import type { TtsTimingPlan } from "@/lib/openmaic/audio/tts-timing";
import type { ClassroomTimingState } from "@/lib/classroom/timing";
import type {
  AiAssessmentSuggestion,
  AiContribution,
  ArtifactSnapshot,
  LearningEvidence,
  StudentAiDecision,
} from "@/lib/learning-evidence/types";

export type {
  AiAssessmentSuggestion,
  AiContribution,
  ArtifactSnapshot,
  LearningEvidence,
  StageMissionDefinition,
  StageReadiness,
  StudentAiDecision,
} from "@/lib/learning-evidence/types";

export type CourseStatus =
  | "draft"
  | "preparing"
  | "ready"
  | "teaching"
  | "finished";

export const COURSE_STATUS_LABEL: Record<CourseStatus, string> = {
  draft: "草稿",
  preparing: "备课中",
  ready: "已发布",
  teaching: "授课中",
  finished: "已结束",
};

export type StageViewKey =
  | "project-launch"
  | "ai-learning"
  | "ai-collaboration"
  | "simple-resource"
  | "group"
  | "workspace"
  | "proposal-review"
  | "project-making"
  | "showcase-reporting"
  | "showcase"
  | "reflection-survey"
  | "reflection";

export type Stage = {
  key: string;
  label: string;
  view: StageViewKey;
  description: string;
};

export type GroupMode = "none" | "solo" | "free" | "random" | "assigned";

export type ClassConfig = {
  groupMode: GroupMode;
  totalStudents: number;
  perGroup?: number;
  crossClass?: boolean;
};

export type AnnouncementReply = {
  id: string;
  studentId?: string;
  studentName: string;
  content: string;
  createdAt: string;
};

export type CourseAnnouncement = {
  id: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  pinned?: boolean;
  replies: AnnouncementReply[];
};

export type CourseTodo = {
  id: string;
  title: string;
  description: string;
  stageKey?: string;
  completedBy: string[];
};

export type CourseResource = {
  id: string;
  title: string;
  type: string;
  size: string;
  description?: string;
  /** Lightweight new-system resources are scoped to a classroom stage. */
  stageKey?: string;
  url?: string;
  /** Fixed-layout derivative used for in-browser classroom presentation. */
  previewUrl?: string;
  previewType?: string;
  /** PDF classroom behavior: continuous reading or page-by-page presentation. */
  displayMode?: "document" | "slides";
  downloadedBy: string[];
};

export type GroupMemberRole = {
  studentId: string;
  name: string;
  role?: string;
};

export type ProjectGroup = {
  id: string;
  name: string;
  topic: string;
  goal?: string;
  keywords: string[];
  selectedForms: string[];
  members: GroupMemberRole[];
  proposal?: ProjectProposal;
  teacherApproval?: {
    status: "pending" | "approved" | "revision";
    teacherName?: string;
    note?: string;
    updatedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type ProjectProposal = {
  projectQuestion: string;
  outcomeFormat: string;
  implementationPlan: string;
  requiredKnowledge: string[];
  aiUsePlan: string;
  risks: string[];
};

export type GroupAnnouncement = {
  id: string;
  groupId: string;
  title: string;
  content: string;
  actor: string;
  createdAt: string;
};

export type WorkPlanItem = {
  id: string;
  groupId: string;
  role: string;
  memberName: string;
  task: string;
  progress: number;
};

/**
 * A companion task is a piece of work the student has explicitly asked a
 * partner to handle. It is intentionally separate from a chat message: the
 * task can wait for input, wait for confirmation, or produce a result without
 * claiming that a formal project operation already happened.
 */
export type CompanionTaskStatus =
  | "queued"
  | "assigned"
  | "processing"
  | "responding"
  | "waiting-student"
  | "waiting-confirmation"
  | "result"
  | "saved"
  | "failed";

export type CompanionTaskKind =
  | "conversation"
  | "knowledge"
  | "ideation"
  | "critique"
  | "planning"
  | "review"
  | "record"
  | "formal-action";

export type CompanionTask = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  companionId?: string;
  kind: CompanionTaskKind;
  title: string;
  request: string;
  status: CompanionTaskStatus;
  result?: string;
  error?: string;
  confirmationId?: string;
  createdAt: string;
  updatedAt: string;
};

export type CompanionConfirmationAction =
  | "save"
  | "overwrite"
  | "delete"
  | "upload"
  | "submit"
  | "mark-complete"
  | "adopt-draft"
  | "edit-workspace";

export type CompanionConfirmationStatus = "pending" | "confirmed" | "rejected";

export type CompanionConfirmation = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  action: CompanionConfirmationAction;
  title: string;
  summary: string;
  taskId?: string;
  payload?: Record<string, unknown>;
  status: CompanionConfirmationStatus;
  createdAt: string;
  resolvedAt?: string;
};

export type CompanionProcessRecord = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  title: string;
  summary: string;
  source: "student" | "agent" | "system";
  companionId?: string;
  taskId?: string;
  evidenceIds?: string[];
  createdAt: string;
};

export type WhiteboardNode = {
  id: string;
  groupId: string;
  label: string;
  note?: string;
  x: number;
  y: number;
  color: "blue" | "green" | "orange" | "violet" | "slate";
  parentId?: string;
};

/**
 * A tldraw-based collaborative board snapshot stored per group.
 * The snapshot is opaque to the session layer (we never inspect its internals);
 * we only persist it and pass it back to tldraw for rendering.
 */
export type GroupBoard = {
  groupId: string;
  /** Serialized tldraw TLSnapshot (JSON-serializable). */
  snapshot: unknown;
  /** ISO timestamp of the last persisted update. Used for polling merge. */
  updatedAt: string;
  /** Active tool palette: "mindmap" emphasizes nodes/arrows; "whiteboard" emphasizes draw/text/image. */
  mode: GroupBoardMode;
};

export type GroupBoardMode = "mindmap" | "whiteboard";

export type CourseUpload = {
  id: string;
  courseId: string;
  groupId?: string;
  studentId?: string;
  studentName?: string;
  stageKey: string;
  category: "artifact" | "evidence" | "presentation" | "resource";
  title: string;
  fileName: string;
  fileType: string;
  size: string;
  url: string;
  createdAt: string;
};

export type TeamContribution = {
  id: string;
  courseId: string;
  groupId: string;
  studentId?: string;
  studentName: string;
  percent: number;
  note?: string;
  updatedAt: string;
};

export type AiSupportKind =
  | "launch-prep"
  | "idea-check"
  | "proposal-diagnosis"
  | "artifact-diagnosis"
  | "showcase-coach"
  | "reflection-evidence"
  | "reflection-class-summary"
  | "teacher-intervention"
  // 新增：AI 介入模式扩展类型
  | "project-skeleton" // 阶段一：AI 生成项目骨架
  | "direction-suggestion" // 阶段三：AI 项目方向建议
  | "rehearsal" // 阶段四：AI 汇报彩排
  | "peer-question" // 阶段四：AI 同伴评价引导
  | "proposal-review" // 阶段四：教师端 AI 方案诊断摘要
  | "live-evaluation" // 阶段六：AI 实时汇报评价
  | "process-evaluation" // 阶段七：AI 过程性评价报告
  | "growth-advice"; // 阶段七：AI 个性化成长建议

export type AiSupportStatus =
  | "draft"
  | "teacher-confirmed"
  | "student-applied"
  | "dismissed";

/**
 * 标识 AiSupportRecord 的来源：
 * - llm：由真实 LLM 调用生成（统一使用系统 LLM 配置）
 * - local：仅用于历史数据或显式标记的规则诊断，不作为 AI 调用失败兜底
 */
export type AiSupportSource = "llm" | "local";

export type AiSupportRecord = {
  id: string;
  courseId: string;
  stageKey: string;
  targetType: "student" | "group" | "course";
  targetId: string;
  groupId?: string;
  studentId?: string;
  studentName?: string;
  kind: AiSupportKind;
  trigger: string;
  inputSummary: string;
  diagnosis: string;
  suggestions: string[];
  evidence: string[];
  status: AiSupportStatus;
  /** 标识本记录由 LLM 还是显式规则诊断生成；AI 调用失败时不再自动回退到 local。 */
  source?: AiSupportSource;
  /**
   * 教师/学生二次编辑后的内容。
   * - diagnosis / suggestions / evidence 均为 AI 原始生成内容，保留不动
   * - editedContent 用于存储人工编辑后的最终采用内容（如编辑后的项目骨架、过程评价报告）
   */
  editedContent?: string;
  /** AI 生成的结构化扩展内容（如项目骨架 JSON、过程评价报告 JSON），用于可编辑展示 */
  structuredPayload?: unknown;
  adoption?: {
    decision: "adopted" | "adopted-after-edit" | "rejected";
    reason?: string;
    before?: string;
    after?: string;
    handledBy: string;
    handledAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

export type CourseUiState = {
  previewUploadId?: string;
  activeGroupId?: string;
  aiPanelCollapsed?: boolean;
  presentationTimerSeconds?: number;
  timerRunning?: boolean;
  /** Persisted stage-aware classroom clock; live elapsed time is derived from absolute timestamps. */
  classroomTiming?: ClassroomTimingState;
  /**
   * 学生端有更新时，系统置位此标志提醒教师。
   * 教师下次进入监控页时主动触发 LLM 重新分析后清除此标志。
   * 避免打断式主动推送：教师自己决定何时刷新。
   */
  aiAnalysisPending?: boolean;
  /** 上次教师主动刷新 AI 分析的时间戳，用于 UI 显示"已刷新 X 分钟前" */
  aiAnalysisRefreshedAt?: string;
  /** 教师当前投屏的 OpenMAIC 授课资源；null 表示已停止投屏。 */
  teacherResourceProjection?: TeacherResourceProjection | null;
  /** 当前课程内容使用唯一的五阶段生成契约。 */
  activeGenerationMode?: "new";
  /** 教师选择并向当前阶段全班投屏的上传资源。 */
  resourceProjection?: ClassroomResourceProjection | null;
  /** 服务端为两类课堂投屏统一分配的单调递增版本。 */
  projectionVersion?: number;
  /** 最近一次投屏状态在服务端提交的时间。 */
  projectionUpdatedAt?: string;
  /** 仅存在于浏览器内存中，用于校正视频跟随时的客户端时钟偏差。 */
  projectionClockOffsetMs?: number;
  /** 第四阶段个人汇报队列配置。 */
  showcaseReporting?: import("@/lib/showcase/types").ShowcaseQueueConfig;
};

export type ClassroomResourceProjection = {
  resourceId: string;
  stageKey: string;
  title: string;
  startedAt: string;
  /** 教师端课堂播放器的当前位置；学生端只读跟随。 */
  viewState?: ClassroomResourceViewState;
};

export type ClassroomResourceViewState = {
  /** PDF 当前滚动比例，取值 0-1。 */
  scrollRatio?: number;
  /** PDF/PPT 当前页码，从 1 开始。 */
  page?: number;
  /** 音视频当前播放位置，单位为秒。 */
  mediaTime?: number;
  mediaPlaying?: boolean;
  mediaPlaybackRate?: number;
  /** 用于播放中的时间推算和客户端去重。 */
  updatedAt: string;
  revision: number;
};

/** Student-facing workspace surfaces available during a classroom stage. */
export type StageWorkspaceMode = "task" | "companions";

/** Which workspace surfaces the teacher makes available for one stage. */
export type StageWorkspaceAccess = "task-only" | "companions-only" | "student-choice";

export type StageWorkspacePolicy = {
  access: StageWorkspaceAccess;
  /** Used when students may choose and have not made a stage-scoped choice yet. */
  defaultMode: StageWorkspaceMode;
};

export type ProjectionMode = "forced" | "optional";
export type ProjectedEngineMode = "idle" | "playing" | "paused" | "live";

export type ProjectionPlaybackSnapshot = {
  sceneIndex: number;
  actionIndex: number;
  consumedDiscussions: string[];
  sceneId?: string;
};

export type TeacherResourceProjection = {
  classroomId: string;
  sceneId: string;
  stageKey: string;
  title: string;
  sceneType: TeacherResourceScene["type"];
  startedAt: string;
  mode?: ProjectionMode;
  version?: number;
  updatedAt?: string;
  engineMode?: ProjectedEngineMode;
  playback?: ProjectionPlaybackSnapshot;
  /**
   * 互动场景状态快照（仅 interactive 类型场景使用）。
   * 教师端在 iframe 内操作时由桥接脚本广播出 state-broadcast 消息，
   * 经 InteractiveIframeHost 捕获后写入此字段；
   * 学生端读取此字段并通过 postMessage apply-state 应用到对应 iframe。
   * null/undefined 表示尚无互动状态需要同步。
   */
  interactionState?: Record<string, unknown> | null;
};

export type LearningEventType =
  | "scene-enter"
  | "scene-leave"
  | "scene-complete"
  | "heartbeat"
  | "scene-replay"
  | "interaction-result"
  | "artifact-change"
  | "stage-enter"
  | "stage-goal-complete"
  /** First exposure to a stage-scoped resource (student or teacher projection). */
  | "resource-open"
  /** A coarse, idempotent reading milestone (25/50/75/100). */
  | "resource-progress"
  /** The resource reached its type-specific completion boundary. */
  | "resource-complete";

export type LearningEvent = {
  id: string;
  idempotencyKey: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  sceneId?: string;
  type: LearningEventType;
  occurredAt: string;
  durationMs?: number;
  expectedDurationSec?: number;
  /** Duration of generated speech measured from the actual audio files in the student player. */
  ttsDurationSec?: number;
  /** Planned silent time for reading, thinking, answering, or manipulating an activity. */
  plannedStudentActivitySec?: number;
  visible?: boolean;
  progressMarker?: string;
  content?: LearningContentReference;
  metadata?: Record<string, string | number | boolean | null>;
};

export type LearningContentReference = {
  stageLabel?: string;
  sceneTitle?: string;
  sceneIndex?: number;
  sceneType?: string;
  activityId?: string;
  activityTitle?: string;
  knowledgePointIds?: string[];
  knowledgePointLabels?: string[];
};

export type CompanionMessageVisibility = "student-and-teacher" | "teacher-only";
export type CompanionMessageRole = "student" | "agent" | "teacher-guidance" | "system-trigger";
export type CompanionTriggerKind =
  | "stage-opening"
  | "idle"
  | "no-progress"
  | "artifact-stalled"
  | "document-saved"
  | "file-uploaded"
  | "teacher-goal"
  | "milestone"
  | "document-comment-read"
  | "conversation-reset";

export type CompanionMessage = {
  id: string;
  role: CompanionMessageRole;
  content: string;
  createdAt: string;
  visibility: CompanionMessageVisibility;
  companionId?: string;
  authorId?: string;
  authorName?: string;
  triggerKind?: CompanionTriggerKind;
  /** Groups messages into the student-visible/current model conversation. */
  conversationId?: string;
  /** Soft deletion: retained for learning analysis but hidden from the student. */
  hiddenFromStudentAt?: string;
  /** Soft deletion: retained for learning analysis but excluded from future model context. */
  excludedFromAiAt?: string;
};

export type CompanionThread = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  messages: CompanionMessage[];
  openingSentAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectDocumentVersion = {
  id: string;
  courseId: string;
  submissionId: string;
  studentId: string;
  stageKey: string;
  sequence: number;
  sourceVersion: number;
  title: string;
  sourceHtml: string;
  docxUploadId?: string;
  docxSha256?: string;
  docxSize?: number;
  status: "processing" | "submitted" | "failed";
  error?: string;
  requestId?: string;
  submittedAt?: string;
  createdAt: string;
};

/** Immutable local-artifact outcome version submitted from project practice. */
export type ProjectPdfVersion = {
  id: string;
  courseId: string;
  studentId: string;
  groupId?: string;
  stageKey: string;
  sequence: number;
  title: string;
  uploadId: string;
  kind?: "pdf" | "file";
  mimeType?: string;
  sha256?: string;
  size?: number;
  status: "submitted" | "failed";
  requestId?: string;
  submittedAt: string;
  createdAt: string;
};

export type FinalArtifactKind = "document" | "pdf" | "file";
export type ShowcaseDisplayMode = "continuous" | "slides";

/** Public metadata for a student's latest submitted outcome. */
export type FinalArtifactSummary = {
  kind: FinalArtifactKind;
  versionId: string;
  title: string;
  sequence: number;
  submittedAt: string;
  displayModes: ShowcaseDisplayMode[];
  mimeType?: string;
  size?: number;
  downloadUrl?: string;
};

export type ShowcasePresentationStatus =
  | "pending"
  | "active"
  | "rejected"
  | "ended"
  | "evaluating"
  | "cancelled";

export type ShowcaseViewState = {
  /** PDF page number when display mode is slides. */
  page?: number;
  /** Normalised scroll position for rich documents and continuous PDFs. */
  scrollRatio?: number;
  updatedAt: string;
  revision: number;
};

/** Role-scoped snapshot used by the fourth-stage presentation controller. */
export type ShowcasePresentationSnapshot = {
  id: string;
  courseId: string;
  groupId: string;
  studentId: string;
  studentName?: string;
  artifactKind: FinalArtifactKind;
  artifactVersionId: string;
  artifactTitle: string;
  displayMode: ShowcaseDisplayMode;
  status: ShowcasePresentationStatus;
  /** Monotonic lifecycle and viewport revision assigned by the server. */
  revision: number;
  viewState?: ShowcaseViewState;
  rejectionReason?: string;
  requestedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  startedAt?: string;
  endedAt?: string;
  evaluationNote?: string;
  evaluatedAt?: string;
  evaluatedBy?: string;
  updatedAt: string;
};

export type AiInteractionEvent = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  conversationId?: string;
  source: "sidebar" | "selection" | "proactive-comment" | "submission" | "system";
  eventType: "request" | "response" | "policy" | "proposal" | "decision" | "undo" | "comment" | "submit" | "error";
  actorRole: "student" | "ai" | "system" | "teacher";
  actorId?: string;
  content?: string;
  payload?: Record<string, unknown>;
  requestId?: string;
  createdAt: string;
};

export type LearningSignalKind =
  | "dwell-overrun"
  | "repeated-playback"
  | "idle"
  | "conversation-no-progress"
  | "goal-stalled"
  | "student-help-request";
export type InterventionStatus = "open" | "handled" | "resolved" | "dismissed";

export type LearningSignal = {
  id: string;
  courseId: string;
  studentId: string;
  stageKey: string;
  sceneId?: string;
  kind: LearningSignalKind;
  severity: "notice" | "warning" | "high";
  status: InterventionStatus;
  title: string;
  summary: string;
  content?: LearningContentReference;
  normalizedIssueKey: string;
  evidenceEventIds: string[];
  aiInterventionAttempts: number;
  firstDetectedAt: string;
  lastDetectedAt: string;
  handledAt?: string;
  resolvedAt?: string;
};

export type ClassCommonIssue = {
  id: string;
  courseId: string;
  stageKey: string;
  normalizedIssueKey: string;
  title: string;
  summary: string;
  content?: LearningContentReference;
  severity: "warning" | "high";
  studentIds: string[];
  signalIds: string[];
  affectedStudents?: Array<{ studentId: string; signalId: string; reason: string }>;
  status: InterventionStatus;
  firstDetectedAt: string;
  lastDetectedAt: string;
  handledAt?: string;
  resolvedAt?: string;
};

export type TeacherDirectiveStatus = "active" | "goal-completed" | "revoked";

export type TeacherAgentDirective = {
  id: string;
  courseId: string;
  stageKey: string;
  targetStudentIds: string[];
  targetScope: "student" | "multiple" | "course";
  goal: string;
  instruction: string;
  successCriteria: string[];
  status: TeacherDirectiveStatus;
  teacherName: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  revokedAt?: string;
};

export type OfflineInterventionKind = "patrol" | "individual-guidance" | "whole-class-teaching";

export type OfflineInterventionRecord = {
  id: string;
  courseId: string;
  stageKey: string;
  kind: OfflineInterventionKind;
  targetStudentIds: string[];
  signalIds: string[];
  note?: string;
  teacherName: string;
  createdAt: string;
};

export type DynamicFacilitationScaffold = {
  id: string;
  courseId: string;
  stageKey: string;
  kind: "proposal-critique" | "artifact-critique" | "common-issue" | "presentation-summary";
  title: string;
  sections: Array<{ id: string; title: string; prompt: string; evidenceSlots: string[] }>;
  status: "template" | "draft" | "teacher-confirmed";
  filledContent?: string;
  evidenceIds: string[];
  generatedAt: string;
  updatedAt: string;
  confirmedAt?: string;
};

export type OpenMaicSceneOutlineSnapshot = {
  /** Course-level directive returned by the upstream outline generator. */
  courseLanguageDirective?: string;
  teachingBrief?: import("@/lib/course-quality-review/types").TeachingBrief;
  visualPlan?: import("@/lib/openmaic/generation/slide-visual-plan").SlideVisualPlan;
  courseVisualDirection?: string;
  courseVisualTheme?: import("@/lib/openmaic/types/generation").CourseVisualTheme;
  id: string;
  type?: string;
  title: string;
  stageKey?: string;
  stageLabel?: string;
  audience?: "student" | "teacher";
  generationPurpose?:
    | "knowledge-teaching"
    | "teacher-resource"
    | "facilitation-scaffold"
    | "companion-guidance";
  companionIds?: string[];
  companionPrompt?: string;
  activityId?: string;
  parentActivityId?: string;
  lectureSectionId?: string;
  lectureSectionTitle?: string;
  detailKind?: PblDetailKind;
  knowledgePointIds?: string[];
  teachingUnitIds?: string[];
  assessmentUnitIds?: string[];
  assessmentUnitMap?: Array<{ unitId: string; knowledgePointIds: string[] }>;
  assessmentTargets?: Array<{
    unitId: string;
    knowledgePointId: string;
    unitTitle: string;
    learningOutcome: string;
  }>;
  targetDurationSec?: number;
  plannedTiming?: import("@/lib/openmaic/types/generation").SceneOutline["plannedTiming"];
  segmentIndex?: number;
  segmentCount?: number;
  segmentRole?: string;
  segmentGroupId?: string;
  ttsPolicy?: PblTtsPolicy;
  timingPlan?: TtsTimingPlan;
  narrationMode?: "standalone-course" | "embedded-segment";
  teachingToolPlan?: import("@/lib/openmaic/types/generation").TeachingToolPlanItem[];
  resourceTypes?: SceneResourceType[];
  description?: string;
  keyPoints?: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order?: number;
  languageNote?: string;
  suggestedImageIds?: string[];
  mediaGenerations?: unknown[];
  quizConfig?: unknown;
  interactiveConfig?: unknown;
  pblConfig?: unknown;
  widgetType?: string;
  widgetOutline?: unknown;
  [key: string]: unknown;
};

export type StudentAiProgress = {
  classroomId: string;
  studentId: string;
  currentSceneIndex: number;
  totalScenes: number;
  completedScenes: string[];
  /**
   * Stable generation-outline ids corresponding to completed runtime scenes.
   * Runtime scene ids may change when classroom resources are regenerated;
   * adaptive triggers must use these stable teaching-node identities instead.
   */
  completedOutlineIds?: string[];
  /** v2 means scenes were completed by an exhausted PlaybackEngine cursor. */
  completionModelVersion?: number;
  quizScore?: number;
  lastActiveAt: string;
  masteryLevel: "not-started" | "in-progress" | "completed" | "mastered";
  currentGoals?: string[];
  achievedGoals?: string[];
  unmetGoals?: string[];
  pathAdjustmentReason?: string;
  currentTeachingAction?: string;
  nextStageCondition?: string;
  /** Per-student adaptive path state for pretests, branch lessons, and just-in-time micro lessons. */
  adaptiveLearning?: StudentAdaptiveLearningState;
  /** Persisted section-quiz evidence used by the student tutor and teacher live analytics. */
  knowledgeLectureAttempts?: KnowledgeLectureAttempt[];
  /** Question-scoped tutor conversations and the notes currently written on the explanation board. */
  knowledgeLectureTutorThreads?: KnowledgeLectureTutorThread[];
};

export type KnowledgeLectureSection = {
  id: string;
  title: string;
  order: number;
  knowledgePointIds: string[];
  /** Stable generation-outline ids, not runtime scene ids. */
  sceneOutlineIds: string[];
  quizOutlineId: string;
  estimatedMinutes: number;
};

export type TeachingBlueprintSourceKind = "course-source" | "general-knowledge";

export type TeachingExplanationNode = {
  id: string;
  kind: "term" | "concept" | "relation" | "mechanism" | "example" | "condition" | "misconception";
  content: string;
  prerequisiteNodeIds: string[];
  provenance: "course-source" | "derived" | "general-knowledge" | "constructed" | "unverified";
};

export type TeachingBlueprintUnit = {
  id: string;
  title: string;
  knowledgePointIds: string[];
  learningOutcome: string;
  explanation: string;
  mechanism: string;
  workedExample: string;
  conditions: string[];
  misconceptions: string[];
  sourceKind: TeachingBlueprintSourceKind;
  evidenceQuotes: string[];
  /** Small, addressable explanation responsibilities used for page ownership. */
  explanationNodes?: TeachingExplanationNode[];
  /** Relative effort estimated by the planner; normalized against the real input budget. */
  estimatedTeachingWeight?: number;
  reviewItems?: import("@/lib/course-quality-review/types").TeacherReviewItem[];
};

export type TeachingBlueprintPage = {
  id: string;
  title: string;
  type: "slide" | "interactive";
  unitIds: string[];
  knowledgePointIds: string[];
  description: string;
  keyPoints: string[];
  teachingObjective: string;
  /** Chosen during content design; empty is valid for a text/shape explanation page. */
  resourceNeeds?: import("@/lib/course-quality-review/types").TeachingResourceNeed[];
  /** Optional student-facing intellectual work; omit for a pure explanation page. */
  learningTask?: import("@/lib/course-quality-review/types").PageLearningTask;
  widgetType?: import("@/lib/openmaic/types/widgets").WidgetType;
  widgetOutline?: import("@/lib/openmaic/types/generation").WidgetOutline;
  outlineId?: string;
  /** Nodes first established, developed further, or only bridged on this page. */
  introducesNodeIds?: string[];
  deepensNodeIds?: string[];
  referencesNodeIds?: string[];
  estimatedTeachingWeight?: number;
  /** Concrete way into this page's reasoning; optional when a direct continuation is clearer. */
  entryPoint?: {
    kind: "familiar-experience" | "concrete-observation" | "problem" | "direct-explanation" | "continuation";
    object: string;
    bridge: string;
  };
  visualRelationship?: {
    kind: "comparison" | "process" | "causal" | "system" | "quantitative" | "sequence" | "spatial" | "statement";
    description: string;
    readingOrder: string[];
  };
  reviewItems?: import("@/lib/course-quality-review/types").TeacherReviewItem[];
};

export type TeachingBlueprintSection = {
  id: string;
  title: string;
  order: number;
  learningObjective: string;
  sharedContext: import("@/lib/course-quality-review/types").SharedTeachingContext;
  knowledgePointIds: string[];
  units: TeachingBlueprintUnit[];
  pages: TeachingBlueprintPage[];
  assessmentFocus: string[];
  understandingCriteria: import("@/lib/course-quality-review/types").TeachingUnderstandingCriteria;
  teachingDurationSec: number;
  learnerActivityDurationSec: number;
  assessmentDurationSec: number;
  quizOutlineId?: string;
};

/** Teacher-private, versioned intermediate artifact used to make classroom pages. */
export type TeachingBlueprint = {
  /** Older versions remain readable; only the current version is generated. */
  schemaVersion: 1 | 2 | 3;
  inputFingerprint: string;
  assessmentMode: import("@/lib/openmaic/types/generation").AssessmentMode;
  createdAt: string;
  budget: {
    totalDurationSec: number;
    teachingDurationSec: number;
    learnerActivityDurationSec: number;
    assessmentDurationSec: number;
    teachingRatio: number;
    assessmentRatio: number;
  };
  sections: TeachingBlueprintSection[];
};

export type TeachingTimingAudit = {
  schemaVersion: 1;
  /** Exact approved knowledge-learning stage budget. */
  totalBudgetSec: number;
  plannedSubstantiveTeachingSec: number;
  plannedAssessmentSec: number;
  plannedLearnerActivitySec: number;
  /** Speech audio on teaching pages only; quiz prompts and feedback are separate. */
  substantiveTeachingDurationSec: number;
  assessmentAudioDurationSec: number;
  narrationDurationSource: "actual-audio" | "estimated-script";
  measuredSegmentCount: number;
  narrationSegmentCount: number;
  complete: boolean;
  substantiveTeachingRatio: number;
  /** Absolute deviation from the approved teaching duration; actual classrooms allow normal pacing variance. */
  teachingDurationDeviationRatio?: number;
  teachingDurationToleranceRatio?: number;
  teachingRatioValid: boolean;
  generatedAt: string;
};

export type KnowledgeLectureQuestionReview = {
  questionId: string;
  prompt: string;
  answer: string;
  points: number;
  earned: number;
  correct: boolean | null;
  feedback: string;
  referenceAnswer?: string;
  knowledgePointIds: string[];
  /** Blueprint units that this question checks. */
  teachingUnitIds?: string[];
};

export type KnowledgeLectureAttempt = {
  id: string;
  sectionId: string;
  quizOutlineId: string;
  runtimeSceneId: string;
  submittedAt: string;
  score: number;
  maxScore: number;
  knowledgePointIds: string[];
  questions: KnowledgeLectureQuestionReview[];
};

export type KnowledgeLectureBoardNote = {
  id: string;
  title: string;
  body: string;
  kind: "concept" | "evidence" | "correction" | "example";
  createdAt: string;
};

export type KnowledgeLectureTutorMessage = {
  id: string;
  role: "student" | "assistant";
  content: string;
  createdAt: string;
};

export type KnowledgeLectureTutorThread = {
  id: string;
  attemptId: string;
  questionId: string;
  messages: KnowledgeLectureTutorMessage[];
  boardNotes: KnowledgeLectureBoardNote[];
  createdAt: string;
  updatedAt: string;
};

/**
 * @deprecated Adaptive teaching is evidence-driven. This alias remains only
 * for unrelated historical snapshots and must not be shown in the UI.
 */
export type StudentLearningTier = "foundation" | "standard" | "advanced";

export type AdaptiveAssessmentQuestion = {
  id: string;
  /** All supported formats are objectively scorable; free-text diagnostics are intentionally excluded. */
  type?: "single-choice" | "true-false" | "matching";
  prompt: string;
  options: string[];
  correctOptionIndex: number;
  /** A matching question stores the canonical left -> right pairs here. */
  matchingPairs?: Array<{ left: string; right: string }>;
  rationale?: string;
  /** IDs from AdaptiveLearningPlan.prerequisiteKnowledgePoints. */
  knowledgePointIds: string[];
};

export type AdaptiveAssessmentAnswer = number | Record<string, string>;

export type AdaptivePrerequisiteKnowledgePoint = KnowledgePoint & {
  /** Why this learner group can reasonably be expected to know it before class. */
  expectedPriorKnowledgeEvidence: string;
  /** Why lacking it would directly block a named main-course target, not merely make learning easier. */
  necessityRationale: string;
  /** Observable, objectively diagnosable boundary for "ready to enter the main course". */
  diagnosticBoundary: string;
};

export type AdaptivePrerequisiteDecision = {
  targetKnowledgePointId: string;
  decision: "diagnose-prerequisite" | "teach-in-main-course" | "no-specific-prerequisite";
  prerequisiteKnowledgePointIds: string[];
  rationale: string;
};

export type AdaptivePrerequisiteSemanticReview = {
  status: "passed" | "failed";
  summary: string;
  decisions: Array<{
    prerequisiteKnowledgePointId: string;
    verdict: "accept" | "reject";
    issues: string[];
  }>;
};

export type AdaptiveBranchKind =
  | "prerequisite"
  | "worked-example"
  | "application"
  | "extension";

export type AdaptiveBranchTrigger = {
  /** Prerequisite resources run before the main course; other resources run after the terminal mastery assessment. */
  placement: "before-main-course" | "after-module";
  /** Legacy/manual fixed insertion point. Prefer assessmentSceneIds for module resources. */
  afterSceneId?: string;
  /** Informational next scene: the branch is visually inserted before it. */
  beforeSceneId?: string;
  /** Stable quiz-outline ids whose submitted answers may activate this material. */
  assessmentSceneIds?: string[];
  /** Optional exact generated question ids; empty means all questions in the linked quiz. */
  linkedQuestionIds?: string[];
  answerRule?: "all-correct" | "score-at-least";
  evidenceRule: "pretest-gap" | "module-mastery";
  scoreThreshold?: number;
  minimumRemainingSec: number;
};

export type AdaptivePreparedBranchResource = {
  /** `stale` keeps the previous classroom preview available after its branch design changes. */
  status: "generating" | "ready" | "stale" | "failed";
  classroomId?: string;
  scenesCount?: number;
  generatedAt?: string;
  /** Signature of the branch design used to generate this classroom. */
  sourceSignature?: string;
  error?: string;
};

export type AdaptiveBranchOutline = {
  id: string;
  /** Whether this resource participates in the current course path. */
  enabled?: boolean;
  /** Original generated placement used by the teacher's auto-assign action. */
  defaultTrigger?: AdaptiveBranchTrigger;
  kind: AdaptiveBranchKind;
  title: string;
  objective: string;
  keyPoints: string[];
  anchorKnowledgePointIds: string[];
  /** Explicit prerequisite concepts covered by this resource. */
  prerequisiteKnowledgePointIds: string[];
  /** What this resource adds beyond the complete main course. */
  noveltyStatement: string;
  /** Main-course scenes checked during preparation to prevent re-teaching. */
  mainCourseOverlapSceneIds: string[];
  sceneType: "slide" | "interactive";
  targetDurationSec: number;
  trigger?: AdaptiveBranchTrigger;
  /** Teacher-authored constraints that guide the final branch classroom generation. */
  generationGuidance?: string;
  /** Prepared during course generation and reused by students at runtime. */
  preparedResource?: AdaptivePreparedBranchResource;
  status: "draft" | "teacher-confirmed";
};

export type AdaptiveLearningPlan = {
  enabled: boolean;
  status: "draft" | "teacher-confirmed";
  generatedAt?: string;
  updatedAt: string;
  timeBudgetMin: number;
  thresholds: {
    /** Module score required before optional enrichment may be inserted. */
    enrichmentMasteryMin: number;
  };
  /**
   * Knowledge students should already know before this lesson. These concepts
   * are intentionally separate from CourseContent.knowledgePoints, which are
   * taught by the lesson itself.
   */
  prerequisiteKnowledgePoints?: AdaptivePrerequisiteKnowledgePoint[];
  prerequisiteAnalysis?: {
    summary: string;
    decisions: AdaptivePrerequisiteDecision[];
  };
  /** Independent semantic audit of grade fit, necessity, and new-content overlap. */
  prerequisiteSemanticReview?: AdaptivePrerequisiteSemanticReview;
  pretest: {
    title: string;
    introduction: string;
    estimatedMinutes: number;
    questions: AdaptiveAssessmentQuestion[];
  };
  /** Course-level opportunity review. Enrichment is selective, but a rich course cannot silently yield none. */
  enrichmentStrategy?: {
    /** Candidate resources to pre-generate into the reusable course library. */
    recommendedMin: number;
    recommendedMax: number;
    /** Hard cap for resources actually inserted into one student's live lesson. */
    runtimeMaxPerStudent: number;
    summary: string;
    decisions: Array<{
      id: string;
      decision: "selected" | "rejected";
      title: string;
      valueType: "task-transfer" | "concept-depth" | "classic-extension";
      rationale: string;
      anchorKnowledgePointIds: string[];
      afterAssessmentSceneId?: string;
      branchId?: string;
    }>;
  };
  branches: AdaptiveBranchOutline[];
};

export type AdaptiveAssessmentEvidence = {
  id: string;
  source: "pretest" | "node-quiz";
  score: number;
  occurredAt: string;
  sceneId?: string;
  knowledgePointIds: string[];
  questionResults?: Array<{
    questionId: string;
    correct: boolean | null;
  }>;
  knowledgePointScores?: KnowledgePointAssessmentScore[];
  /** Knowledge points answered incorrectly in this assessment. */
  weakKnowledgePointIds?: string[];
  /** Knowledge points answered correctly in this assessment. */
  masteredKnowledgePointIds?: string[];
};

export type KnowledgePointAssessmentScore = {
  knowledgePointId: string;
  correct: number;
  total: number;
  score: number;
};

export type AdaptiveBranchRun = {
  id: string;
  branchOutlineId: string;
  kind: AdaptiveBranchKind;
  status: "generating" | "ready" | "completed" | "skipped" | "failed";
  classroomId?: string;
  reason: string;
  createdAt: string;
  completedAt?: string;
};

export type AdaptiveTriggerCondition = {
  key: "plan" | "resource" | "student-path" | "path-limit" | "anchor" | "unused" | "evidence" | "score" | "time" | "novelty";
  label: string;
  expected: string;
  actual: string;
  passed: boolean;
};

export type AdaptiveTriggerEvaluation = {
  id: string;
  branchOutlineId: string;
  branchKind: AdaptiveBranchKind;
  completedSceneId: string;
  /** Concrete player scene id, retained only for diagnostics. */
  runtimeSceneId?: string;
  completedSceneTitle?: string;
  matchedBy: "pretest-gap" | "scene-id" | "knowledge-point";
  evaluatedAt: string;
  result: "triggered" | "conditions-not-met";
  reason: string;
  score?: number;
  scoreSource?: "current-node-quiz" | "recorded-node-quiz" | "pretest";
  remainingBudgetSec: number;
  conditions: AdaptiveTriggerCondition[];
};

export type AdaptiveMicroLesson = {
  id: string;
  stageKey: "proposal" | "make" | "showcase" | "reflection";
  topic: string;
  decision: "brief-answer" | "systematic-lesson";
  rationale: string;
  classroomId?: string;
  status: "decided" | "generating" | "ready" | "completed" | "failed";
  createdAt: string;
  completedAt?: string;
};

export type StudentAdaptiveLearningState = {
  /** Undefined keeps backwards compatibility and means enabled. */
  enabled?: boolean;
  tier?: StudentLearningTier;
  tierSource?: "pretest" | "teacher";
  tierUpdatedAt?: string;
  pretestScore?: number;
  pretestCompletedAt?: string;
  /** Knowledge-level pretest evidence used to select prerequisite resources. */
  pretestWeakKnowledgePointIds?: string[];
  pretestMasteredKnowledgePointIds?: string[];
  startedAt?: string;
  evidence: AdaptiveAssessmentEvidence[];
  branchRuns: AdaptiveBranchRun[];
  /** Runtime trigger decisions, including failed conditions, for teacher inspection. */
  triggerEvaluations?: AdaptiveTriggerEvaluation[];
  microLessons: AdaptiveMicroLesson[];
};

export type TeacherInterventionScope = "student" | "group" | "course";
export type TeacherInterventionAction =
  | "guidance"
  | "scope-adjustment"
  | "regroup"
  | "evaluation-requirement"
  | "pause-ai"
  | "request-reasoning"
  | "override-stage";

export type TeacherIntervention = {
  id: string;
  stageKey: string;
  scope: TeacherInterventionScope;
  targetIds: string[];
  reason: string;
  evidence: string[];
  action: TeacherInterventionAction;
  instruction: string;
  severity: "notice" | "warning" | "high";
  status: "open" | "resolved";
  signalId?: string;
  teacherName: string;
  createdAt: string;
  resolvedAt?: string;
};

export type StageTransitionRecord = {
  id: string;
  fromStageKey: string;
  toStageKey: string;
  gateStatus: "passed" | "overridden";
  blockers: string[];
  warnings: string[];
  overrideReason?: string;
  actor: string;
  createdAt: string;
};

export type Course = {
  /** Navigation context of a projected platform classroom; never part of a template snapshot. */
  platformContext?: { offeringId: string; activityId: string; templateId: string; templateVersionId: string };
  id: string;
  version?: number;
  name: string;
  subject: string;
  grade: string;
  hours: number;
  summary: string;
  drivingQuestion: string;
  learningObjectives?: string[];
  expectedOutcome?: string;
  /** Optional teacher-authored learner context; generation fills conservative defaults when omitted. */
  learnerProfile?: import("@/lib/openmaic/pedagogy/teaching-constraints").LearnerProfileInput;
  status: CourseStatus;
  stages: Stage[];
  currentStageIndex: number;
  content: CourseContent;
  /** Structured configuration for the personal-project AI-companion mode. */
  pblConfig?: PblCourseConfig;
  /** Teacher-authored student workspace availability, keyed by stage.key. */
  stageWorkspacePolicies?: Record<string, StageWorkspacePolicy>;
  classConfig?: ClassConfig;
  inviteCode?: string;
  /** AI 生成的项目封面图 URL */
  coverImageUrl?: string;
  students: Student[];
  submissions?: ClassroomSubmission[];
  projectDocumentVersions?: ProjectDocumentVersion[];
  projectPdfVersions?: ProjectPdfVersion[];
  showcasePresentations?: ShowcasePresentationSnapshot[];
  aiInteractionEvents?: AiInteractionEvent[];
  feedback?: TeacherFeedback[];
  rubricScores?: RubricScore[];
  reflections?: ReflectionRecord[];
  activityLog?: ActivityRecord[];
  presentingGroupId?: string;
  /** The single student currently authorised to request a showcase. */
  presentingStudentId?: string;
  announcements?: CourseAnnouncement[];
  todos?: CourseTodo[];
  resources?: CourseResource[];
  groups?: ProjectGroup[];
  groupAnnouncements?: GroupAnnouncement[];
  workPlan?: WorkPlanItem[];
  whiteboard?: WhiteboardNode[];
  /** tldraw snapshots for collaborative group boards, keyed by groupId. */
  boards?: GroupBoard[];
  uploads?: CourseUpload[];
  teamContributions?: TeamContribution[];
  aiSupports?: AiSupportRecord[];
  teacherInterventions?: TeacherIntervention[];
  /** 已由教师处理的规则型介入信号 ID，避免刷新后重新出现。 */
  resolvedInterventionSignalIds?: string[];
  stageTransitions?: StageTransitionRecord[];
  evaluations?: EvaluationRecord[];
  uiState?: CourseUiState;
  /** OpenMAIC AI 课堂 ID（生成后关联） */
  aiLearningClassroomId?: string;
  /** 教师授课资源 OpenMAIC 课堂 ID（课程引入+PBL讲解，供教师 PPT 预览播放） */
  teacherClassroomId?: string;
  /** 学生在 AI 课堂中的学习进度，key 为 studentId */
  aiLearningProgress?: Record<string, StudentAiProgress>;
  /** 学生学习行为的结构化、幂等事件流。 */
  learningEvents?: LearningEvent[];
  /** 学生与伴学圆桌的后端持久化会话。 */
  companionThreads?: CompanionThread[];
  /** 学生明确分配给伴学伙伴的可视化任务。 */
  companionTasks?: CompanionTask[];
  /** 需要学生确认后才能执行的正式项目动作。 */
  companionConfirmations?: CompanionConfirmation[];
  /** 记记整理的可查看过程记录。 */
  companionProcessRecords?: CompanionProcessRecord[];
  /** 由确定性规则从学习事件和会话中派生的个体信号。 */
  learningSignals?: LearningSignal[];
  /** 可用于形成性评价的统一学习证据；运行信号不得混入此集合。 */
  learningEvidence?: LearningEvidence[];
  /** 文档、图片和演示材料的可检查快照或学生标注。 */
  artifactSnapshots?: ArtifactSnapshot[];
  /** AI 提议本身，仅在学生作出决定后才可能影响项目。 */
  aiContributions?: AiContribution[];
  /** 学生对 AI 提议的采纳、修改或拒绝决定。 */
  studentAiDecisions?: StudentAiDecision[];
  /** 等待教师确认的 AI 评价建议；未确认不得计分。 */
  aiAssessmentSuggestions?: AiAssessmentSuggestion[];
  /** 达到班级阈值的共性问题。 */
  classCommonIssues?: ClassCommonIssue[];
  /** 教师对单人、多人与全班 Agent 下发的目标指令。 */
  teacherAgentDirectives?: TeacherAgentDirective[];
  /** AI 授知阶段的线下巡视、个别辅导与全班讲解记录。 */
  offlineInterventions?: OfflineInterventionRecord[];
  /** 课堂前生成框架、课堂中基于真实证据填充的主持支架。 */
  dynamicFacilitationScaffolds?: DynamicFacilitationScaffold[];
  createdAt: string;
  updatedAt: string;
};

export type CourseContent = {
  knowledgeGroups?: Array<{ id: string; name: string; description: string; knowledgePointIds: string[] }>;
  /** Private package provenance and teacher-confirmed authoring input. */
  resourcePackage?: import("@/lib/resource-package/types").CourseResourcePackage;
  /** Authoritative five-stage teaching requirements and minute budgets. */
  stagePlan?: import("@/lib/resource-package/types").CourseStagePlan;
  qualityReview?: import("@/lib/course-quality-review/types").CourseQualityReport;
  qualityReviewRequired?: boolean;
  renderReview?: import("@/lib/course-quality-review/teacher-review").CourseRenderReview;
  teacherReview?: import("@/lib/course-quality-review/teacher-review").CourseTeacherReview;
  /** The production classroom pipeline's latest bounded or full generation run. */
  classroomGenerationRun?: {
    scope: import("@/lib/course-generation/generation-scope").ClassroomGenerationScope;
    status: "pending" | "completed";
    generatedOutlineIds: string[];
    fullOutlineCount: number;
    testLesson?: import("@/lib/course-generation/generation-scope").TestLessonGenerationTarget;
    generatedAt?: string;
  };
  pblOutline: string;
  /** 教师在生成知识图谱前指定、要求模型完整保留的知识点。 */
  teacherRequiredKnowledgePoints?: string[];
  /** Teacher-private record of how the available teaching time shaped the lesson-owned knowledge scope. */
  knowledgeScopePlan?: KnowledgeScopePlan;
  knowledgePoints: KnowledgePoint[];
  knowledgeGraph?: KnowledgeGraph;
  /** Private, traceable curriculum compilation artifact. Student projections remove it. */
  teachingBlueprint?: TeachingBlueprint;
  /** Durable authoring decisions; an elapsed intervention window is never represented as teacher confirmation. */
  teachingAdoptions?: Array<{
    kind: "knowledge" | "capacity" | "outline";
    mode: "auto-adopted" | "teacher-confirmed";
    contentRevision: string;
    adoptedAt: string;
    actorId?: string;
  }>;
  /** Teacher-private dependency state after a bounded classroom edit. */
  teachingRevisionState?: {
    schemaVersion: 1;
    baseClassroomRevision: number;
    classroomRevision: number;
    changeType: "narration" | "layout" | "visual-content" | "mixed";
    affectedSceneIds: string[];
    invalidated: Array<"audio" | "narration-anchors" | "timing-audit" | "actions" | "assessment-opportunity">;
    updatedAt: string;
  };
  /** Teacher-facing aggregate that distinguishes measured TTS from script estimates. */
  teachingTimingAudit?: TeachingTimingAudit;
  /** Teacher-private items to verify before teaching; never projected to learners. */
  teacherReviewItems?: import("@/lib/course-quality-review/types").TeacherReviewItem[];
  teacherReviewSummary?: string;
  teacherReviewVersion?: import("@/lib/course-quality-review/types").TeacherReviewVersion;
  /** Deterministic six-module timeline regenerated from the final teacher allocation. */
  projectMainline?: PblProjectMainline;
  /**
   * 教师备课阶段确认的整节课程授课大纲。
   * 粒度接近教案：说明教师、平台与 AI 在每个教学活动中的分工。
   */
  teachingOutline?: TeachingOutlineSection[];
  lessonOutline: LessonOutlineSection[];
  /** Sectioned structure for stage two: teaching pages followed by a short subjective quiz. */
  knowledgeLectureSections?: KnowledgeLectureSection[];
  evaluationPlan: EvaluationPlan;
  /** 临时字段：OpenMAIC classroom ID（迁移期间使用） */
  _openmaicClassroomId?: string;
  /** 临时字段：OpenMAIC classroom 场景数 */
  _openmaicScenesCount?: number;
  /** Confirmed OpenMAIC outline snapshot used by the final classroom generator. */
  _openmaicSceneOutlines?: OpenMaicSceneOutlineSnapshot[];
  /** AI授知动态时长计划；旧版课程也复用该字段保存教师确认的全阶段分配。 */
  moduleTimingPlan?: PblModuleTimingPlan;
  /**
   * 教师授课资源：从 OpenMAIC 生成结果中拆分出的课程引入与 PBL 题目讲解内容。
   * 这些内容不会出现在学生 AI 授知课堂中，仅供教师在授课时使用。
   */
  teacherResources?: TeacherResources;
  /** 阶段六教师课程总结演示（只填充已获得的班级证据）。 */
  courseSummaryPresentation?: CourseSummaryPresentation;
  /** 教师授课资源对应的 OpenMAIC classroom ID（用于 PPT 预览播放） */
  teacherClassroomId?: string;
  /**
   * 教师在备课阶段确认的生成模式开关。
   * - false（默认）：保持原有方式，AI 授知以 PPT 形式呈现知识点
   * - true：仅 AI 授知互动优先；静态参考内容可保留 PPT，其他阶段仍为教师 PPT/讲稿
   * 该值由备课阶段页面编辑，generate 页面读取后传给生成 API。
   */
  /** Teacher-confirmed pretest and adaptive branch outlines for new courses. */
  adaptiveLearningPlan?: AdaptiveLearningPlan;
  /** Traceable outputs and quality gates produced by the quick-design mode. */
  designGenerationTrace?: CourseDesignGenerationTrace;
};

export type CourseDesignGenerationTraceEntry = {
  step: string;
  label: string;
  summary: string;
  status: "completed" | "warning";
  completedAt: string;
  checks: string[];
  /** Real course artifacts exposed to the quick-generation progress canvas. */
  artifacts?: CourseDesignGenerationArtifact[];
};

export type CourseDesignGenerationArtifact = {
  id: string;
  kind: "facts" | "graph" | "outcome" | "rubric" | "timeline" | "pages" | "branches" | "audit";
  eyebrow: string;
  title: string;
  summary: string;
  accent: "orange" | "blue" | "violet" | "green";
  items: Array<{
    label: string;
    value: string;
    meta?: string;
    /** The evaluator responsible for this concrete rubric dimension. */
    evaluator?: "ai" | "teacher";
  }>;
  /** Structured visualization payload for mature renderers such as React Flow. */
  visualization?: {
    knowledgeGraph?: KnowledgeGraph;
    knowledgePoints?: KnowledgePoint[];
    knowledgeScopePlan?: KnowledgeScopePlan;
    /** A scene-by-scene production plan for the AI-learning classroom. */
    generationPlan?: {
      scope: "ai-learning";
      totalScenes: number;
      estimatedDuration: number;
      completedScenes: number;
      status: "queued" | "running" | "recovering" | "cancelling" | "cancelled" | "completed" | "failed";
      /** -1 means queued; otherwise the current phase in the production workflow. */
      phaseIndex: number;
      message: string;
      scenes: Array<{
        id: string;
        title: string;
        type: string;
        typeLabel: string;
        estimatedDuration?: number;
      }>;
      assets: {
        images: boolean;
        videos: boolean;
        tts: boolean;
      };
      /** Concurrent page work currently reported by the classroom generator. */
      activePages?: Array<{
        index: number;
        title: string;
        stage: string;
        startedAt: number;
        queueMs?: number;
        requestStartedAt?: number;
        executionMs?: number;
        retryCount?: number;
        lastOutputAt?: number;
      }>;
    };
    /** Parallel post-page work shown together instead of as competing cards. */
    resourcePlan?: {
      lanes: Array<{
        id: "routing" | "adaptive" | "media" | "tts";
        label: string;
        status: "pending" | "running" | "completed" | "warning" | "skipped";
        message: string;
        completed?: number;
        total?: number;
      }>;
    };
  };
};

export type CourseDesignGenerationTrace = {
  mode: "quick";
  teacherBrief: string;
  startedAt: string;
  completedAt?: string;
  entries: CourseDesignGenerationTraceEntry[];
  qualityScore?: number;
  qualitySummary?: string;
};

/**
 * 教师授课资源：课程引入 + PBL 题目讲解
 */
export type TeacherResources = {
  /** 资源生成时间（ISO） */
  generatedAt: string;
  /** 教师资源场景列表 */
  scenes: TeacherResourceScene[];
};

export type CourseSummarySlide = {
  id: string;
  title: string;
  bullets: string[];
  speakerNotes: string;
  evidenceIds: string[];
};

export type CourseSummaryPresentation = {
  id: string;
  title: string;
  generatedAt: string;
  updatedAt: string;
  status: "draft" | "teacher-confirmed";
  slides: CourseSummarySlide[];
  script: string;
  evidenceIds: string[];
};

export type TeacherResourceScene = {
  id: string;
  /** 场景角色：课程引入 / PBL 题目讲解 / 其他课堂演示资源 */
  role: "introduction" | "pbl-topic" | "teaching-aid";
  /** 对应课程阶段 key。旧数据可能没有，由课堂端按角色与标题推断。 */
  stageKey?: string;
  /** 场景标题 */
  title: string;
  /** OpenMAIC 场景真实类型。 */
  type: "slide" | "quiz" | "interactive" | "pbl";
  /** 大纲描述 */
  description: string;
  /** 核心要点 */
  keyPoints: string[];
  /** 讲稿文本（从 speech action 汇总） */
  script?: string;
  generationMode?: "predictable" | "dynamic-scaffold";
  scaffoldKind?: DynamicFacilitationScaffold["kind"];
  /** Explicit routing metadata from the PBL course template. */
  audience?: "teacher" | "student";
  generationPurpose?: "knowledge-teaching" | "teacher-resource" | "facilitation-scaffold" | "companion-guidance";
  stageLabel?: string;
  companionIds?: string[];
  companionPrompt?: string;
  activityId?: string;
  parentActivityId?: string;
  detailKind?: PblDetailKind;
  targetDurationSec?: number;
  segmentIndex?: number;
  segmentCount?: number;
  segmentRole?: string;
  segmentGroupId?: string;
  ttsPolicy?: PblTtsPolicy;
  timingPlan?: TtsTimingPlan;
  resourceTypes?: Array<
    "ppt" | "interactive-demo" | "code-interactive" | "script" | "worksheet" | "rubric" | "project-brief"
  >;
};

export type KnowledgePoint = {
  sourceId?: string;
  /** Source-package leaf concepts compiled into this teachable target. */
  sourceKnowledgePointIds?: string[];
  sourceKnowledgePointNames?: string[];
  groupId?: string;
  groupName?: string;
  id: string;
  name: string;
  description: string;
  keyInfo?: string;
  /** Observable evidence that this lesson-owned target has been learned. */
  masteryBoundary?: string;
  /** Zero-based indexes into Course.learningObjectives. */
  objectiveIndexes?: number[];
  relatedIds?: string[];
  level?: "foundation" | "core" | "application" | "extension";
};

export type KnowledgeScopePlan = {
  schemaVersion: 1;
  /** Guaranteed budget used while deciding the lesson-owned knowledge scope. */
  planningDurationMin: number;
  durationRangeMin: number;
  durationRangeMax: number;
  durationSource: "resource-package" | "course-range";
  assessmentReserveMin: number;
  explanationAndActivityMin: number;
  sourcePointCount: number;
  targetPointCount: number;
  rationale: string;
  decisions: Array<{
    sourceKnowledgePointId: string;
    sourceKnowledgePointName: string;
    disposition: "standalone" | "embedded" | "deferred";
    targetKnowledgePointId?: string;
    rationale: string;
  }>;
};

export type KnowledgeGraph = {
  nodes: KnowledgeGraphNode[];
  edges: KnowledgeGraphEdge[];
  semanticReview?: KnowledgeStructureSemanticReview;
};

export type KnowledgeStructureSemanticReview = {
  status: "passed" | "failed";
  summary: string;
  sourceSignature: string;
  /** Non-blocking Agent suggestions that could not be verified from supplied course facts. */
  advisoryIssues?: string[];
  lessonDecisions: Array<{
    knowledgePointId: string;
    verdict: "accept" | "reject";
    issues: string[];
  }>;
  prerequisiteDecisions: Array<{
    nodeId: string;
    verdict: "accept" | "reject";
    issues: string[];
  }>;
  relationshipDecisions: Array<{
    edgeId: string;
    verdict: "accept" | "reject";
    issues: string[];
  }>;
};

export type KnowledgeGraphNode = {
  groupId?: string;
  groupName?: string;
  id: string;
  label: string;
  description: string;
  keyInfo?: string;
  level?: "foundation" | "core" | "application" | "extension";
  /** Lesson targets and curriculum prerequisites share one graph but not one teaching scope. */
  instructionalRole?: "lesson" | "prerequisite";
  /** Zero-based indexes into Course.learningObjectives; lesson nodes only. */
  objectiveIndexes?: number[];
  /** Observable end-of-lesson performance; lesson nodes only. */
  masteryBoundary?: string;
  /** Why students should already know this before the lesson; prerequisite nodes only. */
  priorKnowledgeEvidence?: string;
  /** Objective, gradable pre-course capability; prerequisite nodes only. */
  diagnosticBoundary?: string;
  relatedLessonIds?: string[];
  position?: { x: number; y: number };
};

export type KnowledgeGraphEdge = {
  id: string;
  source: string;
  target: string;
  label: string;
  type?: "required-prerequisite" | "supports" | "application" | "contrast" | "transfer";
  strength?: "required" | "helpful";
  /** Concrete explanation of how the source affects learning or applying the target. */
  rationale?: string;
};

export type TeachingOutlineSection = {
  id: string;
  stageKey: string;
  title: string;
  durationMin: number;
  teachingGoal: string;
  teacherRole: string;
  platformRole: string;
  aiRole: string;
  studentActivity: string;
  /** Optional category override for the standard PBL time model. */
  activityKind?: "launch" | "knowledge" | "proposal" | "practice" | "showcase" | "reflection" | "other";
  knowledgePointIds?: string[];
  /** `none` is the ordinary classroom activity route; it includes teacher support resources. */
  openMaicUse?: "none" | "student-ai-learning";
  resourceTypes?: Array<
    "ppt" | "interactive-demo" | "code-interactive" | "script" | "worksheet" | "rubric" | "project-brief"
  >;
  /** Optional structured inputs used by the multi-element time estimator. */
  timingProfile?: Omit<PblActivityTimingInput, "id" | "title" | "stageKey" | "activityKind" | "targetDurationSec">;
  notes?: string;
};

export type LessonOutlineSection = {
  id: string;
  stageKey: string;
  title: string;
  objectives: string[];
  activities: string[];
  durationMin: number;
  /** Second-level detail ownership; multiple sections may share one parent. */
  parentActivityId?: string;
  detailKind?: PblDetailKind;
  knowledgePointIds?: string[];
  resourceTypes?: SceneResourceType[];
  targetDurationSec?: number;
  segmentIndex?: number;
  segmentCount?: number;
  segmentRole?: string;
  segmentGroupId?: string;
  ttsPolicy?: PblTtsPolicy;
  timingPlan?: TtsTimingPlan;
  narrationMode?: "standalone-course" | "embedded-segment";
  teachingToolPlan?: import("@/lib/openmaic/types/generation").TeachingToolPlanItem[];
};

export type EvaluationPlan = {
  rubricId?: string;
  rubricVersion?: number;
  dimensions: EvaluationDimension[];
  overallRubric: string;
  flows?: EvaluationFlow[];
};

export type EvaluationSourceRole = "ai" | "teacher" | "peer" | "self";

export type EvaluationFlow = {
  id: string;
  sourceRole: EvaluationSourceRole;
  name: string;
  weight: number;
  evidenceRequirements: string[];
  enabled: boolean;
  /** 是否计入最终成绩；学生反思保留为非计分流程。 */
  scored?: boolean;
};

export type EvaluationRecord = {
  id: string;
  courseId: string;
  stageKey: string;
  sourceRole: EvaluationSourceRole;
  targetType: "student" | "group";
  targetId: string;
  score?: number;
  comment: string;
  evidence: string[];
  status: "draft" | "submitted" | "confirmed";
  createdAt: string;
  updatedAt: string;
};

export const DEFAULT_EVALUATION_FLOWS: EvaluationFlow[] = [
  { id: "evaluation-ai", sourceRole: "ai", name: "AI 过程与专业评价", weight: 40, evidenceRequirements: ["学习过程与产物推进", "AI 协作健康度", "方案迭代与证据", "专业准确性、逻辑与可行性"], enabled: true, scored: true },
  { id: "evaluation-teacher", sourceRole: "teacher", name: "教师现场汇报评价", weight: 60, evidenceRequirements: ["现场汇报与答辩", "成果呈现", "课堂规范与通用能力", "项目价值理解"], enabled: true, scored: true },
  { id: "evaluation-self", sourceRole: "self", name: "学生课程反思", weight: 0, evidenceRequirements: ["课程收获与困难", "成长总结", "后续改进与迁移计划"], enabled: true, scored: false },
];

export type EvaluationDimension = {
  id: string;
  name: string;
  weight: number;
  description: string;
  responsibleRole?: "ai" | "teacher";
};

export type Student = {
  id: string;
  name: string;
  joinedAt: string;
  stageProgress: Record<string, number>;
  /** ISO timestamp of the student's last heartbeat. Used to derive online status. */
  lastSeenAt?: string;
};

export type ClassroomSubmission = {
  id: string;
  courseId: string;
  studentId?: string;
  studentName?: string;
  groupId?: string;
  stageKey: string;
  type:
    | "idea"
    | "plan"
    | "document"
    | "artifact-brief"
    | "code"
    | "resource"
    | "showcase"
    | "reflection"
    | "evidence";
  title: string;
  content: string;
  files?: { name: string; type: string; size?: string; url?: string }[];
  status?: "draft" | "submitted" | "failed";
  submittedAt?: string;
  version?: number;
  createdAt: string;
  updatedAt: string;
};

export type TeacherFeedback = {
  id: string;
  courseId: string;
  targetType: "student" | "group" | "course";
  targetId: string;
  stageKey: string;
  kind: "comment" | "question" | "ai-support" | "revision" | "praise";
  content: string;
  sourceRole?: "ai" | "teacher" | "peer";
  sourceName?: string;
  evidence?: string[];
  status?: "open" | "resolved";
  createdAt: string;
};

export type RubricScore = {
  id: string;
  courseId: string;
  groupId: string;
  stageKey: string;
  dimensionScores: Record<string, number>;
  /** Frozen scoring contract; historical scores never follow later template edits. */
  rubricSnapshot?: NonNullable<import("@/lib/resource-package/types").CourseStagePlan["evaluationRubric"]>;
  teacherTotal?: number;
  aiDimensionScores?: Record<string, number>;
  aiTotal?: number | null;
  aiProcessSummary?: string;
  aiProcessEvidence?: string[];
  finalTotal?: number;
  scoringMode?: "teacher" | "hybrid" | "ai-import";
  comment: string;
  total: number;
  status: "draft" | "submitted" | "passed" | "revision";
  createdAt: string;
  updatedAt: string;
};

export type ReflectionRecord = {
  id: string;
  courseId: string;
  studentId: string;
  studentName: string;
  content: string;
  improvementPlan?: string;
  /** Structured response used by the new five-stage reflection survey. */
  survey?: ReflectionSurveyResponseV1;
  courseReflection?: CourseReflectionResponse;
  experienceSurvey?: ExperienceSurveyResponse;
  createdAt: string;
  updatedAt: string;
};

export type ReflectionSurveyScore = 1 | 2 | 3 | 4 | 5;

export type CourseReflectionResponse = {
  schemaVersion: 1;
  questionSetId: string;
  questionSetVersion: number;
  questions: Array<{ id: string; prompt: string; required: boolean }>;
  answers: Record<string, string>;
  submittedAt: string;
};

export type ExperienceSurveyResponse = {
  schemaVersion: 1;
  systemReflection: string;
  aiHelpfulness: ReflectionSurveyScore;
  systemUsability: ReflectionSurveyScore;
  reuseIntention: ReflectionSurveyScore;
  submittedAt: string;
};

export type ReflectionSurveyResponseV1 = {
  schemaVersion: 1;
  learningReflection: string;
  systemReflection: string;
  aiHelpfulness: ReflectionSurveyScore;
  systemUsability: ReflectionSurveyScore;
  reuseIntention: ReflectionSurveyScore;
};

export type ReflectionSummaryCategoryKey =
  | "learning-gains"
  | "common-difficulties"
  | "ai-collaboration"
  | "course-improvements";

export type ReflectionSummaryAnswerField = "learningReflection" | "systemReflection";

export type ReflectionSummarySource = {
  studentId: string;
  fields: ReflectionSummaryAnswerField[];
};

export type ReflectionSummaryTerm = {
  label: string;
  sources: ReflectionSummarySource[];
};

export type ReflectionSummaryCategory = {
  key: ReflectionSummaryCategoryKey;
  title: string;
  summary: string;
  terms: ReflectionSummaryTerm[];
};

export type ReflectionSummarySourceRef = {
  reflectionId: string;
  studentId: string;
  updatedAt: string;
};

export type ReflectionClassSummaryV1 = {
  schemaVersion: 1;
  generatedAt: string;
  coveragePercent: number;
  coverageBucket: 0 | 20 | 40 | 60 | 80 | 100;
  trigger: "threshold" | "course-finished" | "manual";
  responseCount: number;
  totalStudentCount: number;
  sourceRevision: string;
  sourceRefs: ReflectionSummarySourceRef[];
  courseSummary: string;
  teachingRecommendations: string[];
  categories: ReflectionSummaryCategory[];
  studentSummaries: Array<{ studentId: string; summary: string }>;
};

export type ActivityRecord = {
  id: string;
  actor: string;
  action: string;
  detail?: string;
  createdAt: string;
};

export type SessionSnapshot = {
  courses: Course[];
  updatedAt: string;
};

// ============================================================================
// CourseSession — archived historical teaching session (Stage 2: RESTART_TEACHING)
// ============================================================================

export type ArchivedCourseData = {
  students?: Student[];
  submissions?: ClassroomSubmission[];
  projectDocumentVersions?: ProjectDocumentVersion[];
  projectPdfVersions?: ProjectPdfVersion[];
  aiInteractionEvents?: AiInteractionEvent[];
  feedback?: TeacherFeedback[];
  rubricScores?: RubricScore[];
  reflections?: ReflectionRecord[];
  activityLog?: ActivityRecord[];
  groups?: ProjectGroup[];
  workPlan?: WorkPlanItem[];
  whiteboard?: WhiteboardNode[];
  groupAnnouncements?: GroupAnnouncement[];
  boards?: GroupBoard[];
  uploads?: CourseUpload[];
  teamContributions?: TeamContribution[];
  aiSupports?: AiSupportRecord[];
  teacherInterventions?: TeacherIntervention[];
  learningSignals?: LearningSignal[];
  classCommonIssues?: ClassCommonIssue[];
  teacherAgentDirectives?: TeacherAgentDirective[];
  offlineInterventions?: OfflineInterventionRecord[];
  companionThreads?: CompanionThread[];
  stageTransitions?: StageTransitionRecord[];
  evaluations?: EvaluationRecord[];
  learningEvents?: LearningEvent[];
  learningEvidence?: LearningEvidence[];
  artifactSnapshots?: ArtifactSnapshot[];
  aiContributions?: AiContribution[];
  studentAiDecisions?: StudentAiDecision[];
  aiAssessmentSuggestions?: AiAssessmentSuggestion[];
  presentingGroupId?: string | null;
  presentingStudentId?: string | null;
};

export type CourseSession = {
  id: string;
  courseId: string;
  inviteCode: string;
  startedAt: string;
  endedAt: string;
  archivedData: ArchivedCourseData;
  studentCount: number;
  submissionCount: number;
  createdAt: string;
};

export type AiProviderSettings = {
  endpoint: string;
  model: string;
  apiKey?: string;
  updatedAt?: string;
};

export type PublicAiProviderSettings = Omit<AiProviderSettings, "apiKey"> & {
  hasApiKey: boolean;
};

export const DEFAULT_STAGES: Stage[] = [
  {
    key: "launch",
    label: "项目启动",
    view: "simple-resource",
    description: "查看教师发布的项目说明与授课资源",
  },
  {
    key: "ai-learning",
    label: "知识讲授",
    view: "ai-learning",
    description: "分节学习核心知识，并通过节末小测与 AI 助教讲解及时巩固",
  },
  {
    key: "make",
    label: "项目实践",
    view: "ai-collaboration",
    description: "在文档或代码工作台中与 AI 组员协作完成项目成果",
  },
  {
    key: "showcase",
    label: "成果汇报与评价",
    view: "showcase-reporting",
    description: "查看最终成果、申请汇报并跟随课堂同步展示",
  },
  {
    key: "reflection",
    label: "学习反思",
    view: "reflection-survey",
    description: "用约 3–5 分钟回顾课程收获与系统使用体验",
  },
];

export const GROUP_MODE_LABEL: Record<GroupMode, string> = {
  none: "不分组（全班统一）",
  solo: "一人一组（独立完成）",
  free: "按学生自由组队",
  random: "按系统自动分组",
  assigned: "按教师指定分组",
};
