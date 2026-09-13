"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import {
  applySessionAction,
  initialSessionState,
  makeRecordId,
} from "./actions";
import type { SessionAction, SessionState } from "./actions";
import type {
  ActivityRecord,
  AiAssessmentSuggestion,
  AiContribution,
  AiSupportRecord,
  AnnouncementReply,
  ClassConfig,
  ClassroomSubmission,
  ArtifactSnapshot,
  CompanionConfirmation,
  CompanionProcessRecord,
  CompanionTask,
  Course,
  CourseAnnouncement,
  CourseContent,
  CourseTodo,
  CourseUiState,
  CourseUpload,
  GroupAnnouncement,
  GroupBoard,
  GroupBoardMode,
  LearningEvidence,
  LearningSignal,
  OfflineInterventionRecord,
  ProjectGroup,
  ReflectionRecord,
  RubricScore,
  Stage,
  Student,
  StudentAiDecision,
  TeacherFeedback,
  TeamContribution,
  TeacherAgentDirective,
  WhiteboardNode,
  WorkPlanItem,
} from "./types";
import type { ActionAck } from "@/lib/courses/contracts";
import { clientUUID } from "@/lib/uuid";
import { DEFAULT_EVALUATION_FLOWS } from "./types";
import { getStagesForSystemMode } from "@/lib/system-mode";
import { getNewSystemCourseReadiness } from "@/lib/classroom/new-system-course";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import {
  DEFAULT_NEW_COURSE_HOURS,
  DEFAULT_NEW_COURSE_SUBJECT,
} from "@/lib/teacher/course-basics-draft";
import { loadJSON, saveJSON } from "./storage";
import { generateInviteCode, normalizeInviteCode } from "./invite-code";
import { toast } from "sonner";
import { getSessionRouteMode } from "./route-mode";
import {
  retryVersionConflict,
  SessionActionRequestError,
} from "./action-version-retry";
import {
  COURSE_EVENT_POLL_INTERVAL_MS,
  COURSE_SYNC_FAILURE_NOTICE_THRESHOLD,
  SESSION_REFRESH_INTERVAL_MS,
  courseRefreshDelay,
  isClassroomControlEvent,
  isRealtimePollingActive,
  latestEventCursor,
  type RealtimeTransportMode,
} from "@/lib/realtime/sync-policy";
import {
  PROJECTION_COALESCE_MS,
  PROJECTION_CONNECTED_CHECK_INTERVAL_MS,
  PROJECTION_POLL_INTERVAL_MS,
  PROJECTION_REQUEST_TIMEOUT_MS,
  estimateServerClockOffset,
  highestKnownProjectionVersion,
  isImmediateProjectionPatch,
  mergeCourseUiStateWithProjectionGuard,
  projectionPatchFromAction,
  shouldApplyProjectionVersion,
  withProjectionClockOffset,
  type ProjectionStateSnapshot,
} from "@/lib/realtime/projection-state";
import { LatestValueQueue } from "@/lib/realtime/latest-value-queue";
import { emitShowcasePresentation } from "@/lib/showcase/realtime-client";
import type { ShowcaseEventPayload } from "@/lib/showcase/types";

const IDENTITY_KEY = "openpbl.identity.v1";
// Separate identity keys per role to prevent teacher/student identity cross-contamination
// when both are open in the same browser.
const TEACHER_IDENTITY_KEY = "openpbl.identity.teacher.v1";
const STUDENT_IDENTITY_KEY = "openpbl.identity.student.v1";
const LEFT_CLASS_HISTORY_KEY = "openpbl.left-class-history.v1";

type LeftClassRecord = {
  courseId: string;
  courseName: string;
  studentId: string;
  studentName: string;
  leftAt: string;
};

type IdentityState = Pick<
  SessionState,
  "user" | "joinedCourseId" | "studentId" | "studentName"
> & {
  // Cached join timestamp so we can fully reconstruct the Student record
  // when the polling refresh races ahead of the server's JOIN_CLASS ack.
  joinedAt?: string;
  // Cached group membership so applyIdentity can restore the student's
  // group slot when polling returns server state that hasn't yet processed
  // the JOIN_GROUP action.
  joinedGroupId?: string;
  joinedGroupRole?: string;
};

type SubmissionInput = Omit<
  ClassroomSubmission,
  "id" | "courseId" | "createdAt" | "updatedAt"
> & { id?: string; courseId?: string };

type QueuedProjectionUpdate = {
  action: SessionAction;
  requestId: string;
};

type SessionApi = SessionState & {
  saveState: "idle" | "unsaved" | "saving" | "saved" | "error";
  lastSavedAt?: string;
  saveError?: string;
  retrySave: () => Promise<void>;
  /** Wait for queued autosaves before a server-side final submission. */
  flushSaves: () => Promise<boolean>;
  setUser: (u: SessionState["user"]) => void;
  createCourse: (input: Partial<Course>) => Course;
  updateCourse: (id: string, patch: Partial<Course>) => void;
  deleteCourse: (id: string) => void;
  setCourseContent: (id: string, content: CourseContent) => void;
  setCourseStages: (id: string, stages: Stage[]) => void;
  publishCourse: (id: string) => void;
  startTeaching: (id: string, classConfig: ClassConfig) => string;
  restartTeaching: (id: string) => { inviteCode: string };
  endTeaching: (id: string) => void;
  advanceStage: (id: string, direction: 1 | -1) => void;
  setStage: (id: string, index: number) => void;
  joinClass: (code: string, name: string) => { ok: true; course: Course } | { ok: false; reason: string };
  rejoinClass: (record: LeftClassRecord) => { ok: true; course: Course } | { ok: false; reason: string };
  leaveClass: () => Promise<boolean>;
  getLeftClassHistory: () => LeftClassRecord[];
  updateStudentProgress: (stageKey: string, value: number) => void;
  upsertSubmission: (submission: SubmissionInput) => ClassroomSubmission | undefined;
  persistSubmission: (submission: SubmissionInput) => Promise<ClassroomSubmission | undefined>;
  addFeedback: (feedback: Omit<TeacherFeedback, "id" | "courseId" | "createdAt"> & { id?: string; courseId?: string }) => TeacherFeedback | undefined;
  upsertRubricScore: (score: Omit<RubricScore, "id" | "courseId" | "createdAt" | "updatedAt"> & { id?: string; courseId?: string }) => RubricScore | undefined;
  upsertReflection: (reflection: Omit<ReflectionRecord, "id" | "courseId" | "studentId" | "studentName" | "createdAt" | "updatedAt"> & { id?: string; courseId?: string; studentId?: string; studentName?: string }) => ReflectionRecord | undefined;
  upsertAnnouncement: (courseId: string, input: Omit<CourseAnnouncement, "id" | "createdAt" | "updatedAt" | "replies"> & { id?: string; replies?: AnnouncementReply[] }) => CourseAnnouncement;
  deleteAnnouncement: (courseId: string, announcementId: string) => void;
  replyAnnouncement: (courseId: string, announcementId: string, content: string) => AnnouncementReply | undefined;
  upsertTodo: (courseId: string, todo: CourseTodo) => void;
  completeTodo: (courseId: string, todoId: string, completed: boolean) => void;
  markResourceDownloaded: (courseId: string, resourceId: string) => void;
  upsertGroup: (courseId: string, group: ProjectGroup) => void;
  createGroup: (courseId: string, name?: string) => ProjectGroup;
  joinGroup: (courseId: string, groupId: string, role?: string) => void;
  leaveGroup: (courseId: string, groupId: string) => void;
  setGroupTopic: (courseId: string, groupId: string, patch: Partial<ProjectGroup>) => void;
  upsertGroupAnnouncement: (courseId: string, input: Omit<GroupAnnouncement, "id" | "actor" | "createdAt"> & { id?: string; actor?: string }) => GroupAnnouncement;
  upsertWorkPlanItem: (courseId: string, item: Omit<WorkPlanItem, "id"> & { id?: string }) => WorkPlanItem;
  deleteWorkPlanItem: (courseId: string, itemId: string) => void;
  upsertWhiteboardNode: (courseId: string, node: Omit<WhiteboardNode, "id"> & { id?: string }) => WhiteboardNode;
  deleteWhiteboardNode: (courseId: string, nodeId: string) => void;
  upsertGroupBoard: (courseId: string, board: { groupId: string; snapshot: unknown; mode?: GroupBoardMode; updatedAt?: string }) => void;
  upsertUpload: (upload: Omit<CourseUpload, "createdAt">) => CourseUpload;
  deleteUpload: (courseId: string, uploadId: string) => void;
  setPreviewUpload: (courseId: string, uploadId?: string) => void;
  upsertTeamContribution: (contribution: Omit<TeamContribution, "id" | "courseId" | "updatedAt"> & { id?: string; courseId?: string }) => TeamContribution | undefined;
  upsertAiSupport: (support: Omit<AiSupportRecord, "id" | "courseId" | "createdAt" | "updatedAt"> & { id?: string; courseId?: string }) => AiSupportRecord | undefined;
  addOfflineIntervention: (input: Omit<OfflineInterventionRecord, "id" | "teacherName" | "createdAt"> & { id?: string; teacherName?: string }) => OfflineInterventionRecord;
  resolveInterventionSignals: (courseId: string, signalIds: string[]) => void;
  upsertTeacherAgentDirective: (input: Omit<TeacherAgentDirective, "id" | "teacherName" | "createdAt" | "updatedAt"> & { id?: string; teacherName?: string; createdAt?: string }) => TeacherAgentDirective;
  upsertCompanionTask: (input: Omit<CompanionTask, "id" | "createdAt" | "updatedAt"> & { id?: string }) => CompanionTask;
  upsertCompanionConfirmation: (input: Omit<CompanionConfirmation, "id" | "createdAt" | "status"> & { id?: string; status?: CompanionConfirmation["status"] }) => CompanionConfirmation;
  resolveCompanionConfirmation: (courseId: string, confirmationId: string, status: CompanionConfirmation["status"]) => void;
  addCompanionProcessRecord: (input: Omit<CompanionProcessRecord, "id" | "createdAt"> & { id?: string }) => CompanionProcessRecord;
  requestTeacherHelp: (courseId: string, stageKey: string) => LearningSignal | undefined;
  upsertLearningEvidence: (evidence: LearningEvidence) => LearningEvidence;
  reviewLearningEvidence: (courseId: string, evidenceId: string, status: "teacher-confirmed" | "needs-revision", feedback?: string) => void;
  upsertArtifactSnapshot: (snapshot: ArtifactSnapshot) => ArtifactSnapshot;
  upsertAiContribution: (contribution: AiContribution) => AiContribution;
  recordStudentAiDecision: (decision: StudentAiDecision) => StudentAiDecision;
  upsertAiAssessmentSuggestion: (suggestion: AiAssessmentSuggestion) => AiAssessmentSuggestion;
  setUiState: (courseId: string, patch: Partial<CourseUiState>) => void;
  addActivity: (courseId: string, action: string, detail?: string, actor?: string) => void;
  setPresentingGroup: (courseId: string, groupId: string) => void;
  getCourse: (id: string) => Course | undefined;
  findCourseByCode: (code: string) => Course | undefined;
  generateNewInviteCode: (id: string) => string;
  refresh: (preferredRole?: "teacher" | "student") => Promise<void>;
  // Stage 4 realtime sync
  connectWebSocket: (courseId: string | undefined) => void;
  disconnectWebSocket: () => void;
  realtimeMode: "websocket" | "polling";
};

const SessionContext = createContext<SessionApi | null>(null);

function reducer(state: SessionState, action: SessionAction): SessionState {
  return applySessionAction(state, action);
}

// crypto.randomUUID 仅在安全上下文(HTTPS/localhost)可用,内网 IP 直访
// 需降级,详见 @/lib/uuid。
function makeCourseId(): string {
  return clientUUID();
}

function makeStudentId(): string {
  return clientUUID();
}

function makeEmptyHydratedState(): SessionState {
  return {
    ...initialSessionState(),
    hydrated: true,
    updatedAt: new Date().toISOString(),
  };
}

function getClientRole(): "teacher" | "student" | undefined {
  if (typeof window === "undefined") return undefined;
  if (window.location.pathname.startsWith("/student")) return "student";
  if (window.location.pathname.startsWith("/teacher")) return "teacher";
  return undefined;
}

function redirectAfterUnauthorized(role: "teacher" | "student" | undefined) {
  if (typeof window === "undefined" || !role) return;
  if (role === "teacher") {
    const redirect = `${window.location.pathname}${window.location.search}`;
    window.location.assign(
      `/teacher/login?redirect=${encodeURIComponent(redirect)}`,
    );
    return;
  }
  window.location.assign("/student");
}

async function fetchSession(
  preferredRole?: "teacher" | "student",
): Promise<SessionState> {
  const role = preferredRole ?? getClientRole();
  const classroomId = typeof window !== "undefined" ? window.location.pathname.match(role === "student"
    ? /^\/student\/(?:classroom|ai-learning|ai-collaboration|micro-lesson)\/([^/]+)/
    : /^\/teacher\/(?:teach|prepare)\/([^/]+)/)?.[1] : undefined;
  const res = await fetch(classroomId ? `/api/courses?courseId=${encodeURIComponent(classroomId)}` : "/api/courses", {
    cache: "no-store",
    headers: role ? { "X-OpenPBL-Role": role } : undefined,
  });
  if (!res.ok) {
    // 401 表示未登录——在公开页面（首页、登录页）轮询时属正常情况，
    // 不应作为错误抛出，避免每 5 秒弹出"无法读取课堂数据"提示。
    if (res.status === 401) {
      redirectAfterUnauthorized(role);
      throw new Error("SESSION_UNAUTHORIZED");
    }
    const body = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    throw new Error(body?.error ?? `SESSION_FETCH_FAILED_${res.status}`);
  }
  const state = (await res.json()) as SessionState;
  return { ...state, hydrated: true };
}

async function hasAuthenticatedSession(
  role: "teacher" | "student",
): Promise<boolean> {
  const response = await fetch("/api/auth/me", {
    cache: "no-store",
    headers: { "X-OpenPBL-Role": role },
  });
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as
    | { user?: { role?: string } | null }
    | null;
  return body?.user?.role === role;
}

function courseIdForAction(action: SessionAction): string | null {
  if (!("payload" in action) || typeof action.payload !== "object" || !action.payload) return null;
  const payload = action.payload as Record<string, unknown>;
  const value = payload.courseId ?? payload.id;
  return typeof value === "string" ? value : null;
}

async function postSessionAction(
  action: SessionAction,
  state: SessionState,
  requestId: string,
  expectedVersionOverride?: number,
  includeExpectedVersion = true,
): Promise<ActionAck> {
  const role = getClientRole();
  const courseId = courseIdForAction(action);
  if (!courseId) throw new Error("ACTION_COURSE_REQUIRED");
  const courseVersion = state.courses.find((course) => course.id === courseId)?.version;
  const expectedVersion = expectedVersionOverride ?? courseVersion;
  const res = await fetch(`/api/courses/${encodeURIComponent(courseId)}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(role ? { "X-OpenPBL-Role": role } : {}),
    },
    body: JSON.stringify({
      requestId,
      ...(includeExpectedVersion && action.type !== "CREATE_COURSE" && expectedVersion
        ? { expectedVersion }
        : {}),
      action,
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      | {
          code?: string;
          error?: string;
          message?: string;
          details?: { currentVersion?: number };
        }
      | null;
    if (res.status === 401) redirectAfterUnauthorized(role);
    throw new SessionActionRequestError(
      body?.code ?? body?.message ?? body?.error ?? `SESSION_ACTION_FAILED_${res.status}`,
      res.status,
      body?.details?.currentVersion,
    );
  }
  return (await res.json()) as ActionAck;
}

async function postSessionActionWithRetry(
  action: SessionAction,
  state: SessionState,
  requestId: string,
): Promise<ActionAck> {
  const courseId = courseIdForAction(action);
  const initialVersion = courseId
    ? state.courses.find((course) => course.id === courseId)?.version
    : undefined;
  return retryVersionConflict(
    (expectedVersion) => postSessionAction(action, state, requestId, expectedVersion),
    initialVersion,
  );
}

async function postProjectionActionWithRetry(
  update: QueuedProjectionUpdate,
  state: SessionState,
): Promise<ActionAck> {
  return retryVersionConflict(
    () => postSessionAction(
      update.action,
      state,
      update.requestId,
      undefined,
      false,
    ),
    undefined,
  );
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const [state, dispatch] = useReducer(reducer, undefined, initialSessionState);
  const stateRef = useRef(state);
  const [saveState, setSaveState] = useState<SessionApi["saveState"]>("idle");
  const [lastSavedAt, setLastSavedAt] = useState<string>();
  const [saveError, setSaveError] = useState<string>();
  const lastFailedActionRef = useRef<{ action: SessionAction; requestId: string } | null>(null);
  const commitQueueRef = useRef<Promise<unknown>>(Promise.resolve());
  const pollingRef = useRef(true);
  // Tracks the number of in-flight commit POSTs. Only the LAST response
  // (when pending drops to 0) triggers a HYDRATE; intermediate responses
  // are ignored so they can't overwrite newer local optimistic state.
  const pendingCommitsRef = useRef(0);
  // Tracks the most recent course.updatedAt we've seen from the server, so
  // the long-polling fallback can skip HYDRATE when nothing changed (Stage 4).
  const lastSeenUpdatedAtRef = useRef<string | undefined>(undefined);
  // WebSocket connection state (Stage 4 realtime sync).
  const wsRef = useRef<WebSocket | null>(null);
  const wsFailureCountRef = useRef(0);
  const wsRetryTimerRef = useRef<number | null>(null);
  const wsCourseIdRef = useRef<string | undefined>(undefined);
  const wsModeRef = useRef<"websocket" | "polling">("polling");
  const eventCursorRef = useRef<Record<string, string>>({});
  const courseRefreshTimerRef = useRef<number | null>(null);
  const coursePollTimerRef = useRef<number | null>(null);
  const coursePollInFlightRef = useRef(false);
  const coursePollFailuresRef = useRef(0);
  const wsConnectionTimerRef = useRef<number | null>(null);
  const wsSubscriptionTimerRef = useRef<number | null>(null);
  const projectionPollTimerRef = useRef<number | null>(null);
  const projectionPollAbortRef = useRef<AbortController | null>(null);
  const projectionPollSequenceRef = useRef(0);
  const projectionVersionRef = useRef<Record<string, number>>({});
  const projectionQueuesRef = useRef<Map<string, LatestValueQueue<QueuedProjectionUpdate>>>(new Map());
  const projectionFailureCountRef = useRef<Record<string, number>>({});
  const [realtimeMode, setRealtimeMode] = useState<"websocket" | "polling">("polling");

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function applyIdentity(next: SessionState): SessionState {
    // With JWT auth, the session endpoint derives identity from the signed
    // cookie. Never overwrite that trusted identity with stale localStorage.
    if (
      next.user.role === "student" &&
      next.studentId &&
      next.joinedCourseId
    ) {
      return next;
    }
    if (getClientRole() === "teacher") return next;

    // Try role-specific identity keys first, then fall back to the legacy
    // shared key. This prevents cross-contamination when teacher and student
    // tabs are open in the same browser.
    const identity =
      loadJSON<IdentityState | null>(STUDENT_IDENTITY_KEY, null) ??
      loadJSON<IdentityState | null>(IDENTITY_KEY, null);
    if (!identity) return next;
    let result: SessionState = {
      ...next,
      user: identity.user ?? next.user,
      joinedCourseId: identity.joinedCourseId,
      studentId: identity.studentId,
      studentName: identity.studentName,
    };
    // Ensure the local student is registered in the joined course's student list.
    // Polling refresh may HYDRATE with server state that hasn't yet processed
    // our JOIN_CLASS action, causing the student to transiently disappear from
    // course.students. We restore them here so teacher & peer views always show
    // the joined student (and online counts stay accurate).
    if (identity.joinedCourseId && identity.studentId && identity.studentName) {
      const restoredStudent: Student = {
        id: identity.studentId,
        name: identity.studentName,
        joinedAt: identity.joinedAt ?? new Date().toISOString(),
        stageProgress: {},
      };
      result = {
        ...result,
        courses: result.courses.map((c) => {
          if (c.id !== identity.joinedCourseId) return c;
          let course = c;
          // Restore student in students list if missing
          if (!course.students.some((s) => s.id === restoredStudent.id)) {
            course = { ...course, students: [...course.students, restoredStudent] };
          }
          // Restore student in group members if missing (same race condition
          // as above: JOIN_GROUP may not have been processed by the server yet).
          if (identity.joinedGroupId && course.groups) {
            const group = course.groups.find((g) => g.id === identity.joinedGroupId);
            if (group && !group.members.some((m) => m.studentId === identity.studentId)) {
              course = {
                ...course,
                groups: course.groups.map((g) =>
                  g.id === identity.joinedGroupId
                    ? {
                        ...g,
                        members: [
                          ...g.members,
                          {
                            studentId: identity.studentId!,
                            name: identity.studentName!,
                            role: identity.joinedGroupRole ?? "成员",
                          },
                        ],
                      }
                    : g,
                ),
              };
            }
          }
          return course;
        }),
      };
    }
    return result;
  }

  async function refresh(preferredRole?: "teacher" | "student") {
    if (getSessionRouteMode(pathname) === "identity") {
      const role = preferredRole ?? (pathname.startsWith("/teacher") ? "teacher" : "student");
      const response = await fetch("/api/auth/me", { cache: "no-store", headers: { "X-OpenPBL-Role": role } });
      const body = response.ok ? await response.json() as { user?: { role?: string; displayName?: string; studentName?: string } } : null;
      const next = makeEmptyHydratedState();
      if (body?.user?.role === role) next.user = { ...next.user, role, name: body.user.displayName || body.user.studentName || (role === "teacher" ? "教师" : "学生") };
      dispatch({ type: "HYDRATE", payload: next });
      return;
    }
    // Skip polling refresh while commits are in-flight — the server file
    // may not yet reflect those actions (they're queued), and HYDRATEing
    // would overwrite local optimistic state, causing the same
    // "course disappears" symptom as the commit race condition.
    if (pendingCommitsRef.current > 0) return;
    try {
      const next = applyIdentity(await fetchSession(preferredRole));
      // Long-polling optimisation (Stage 4): skip HYDRATE if nothing changed.
      // When WebSocket is connected, we rely on patch-driven refreshes; the
      // 5s long-poll is only a fallback and shouldn't churn the UI.
      if (
        wsModeRef.current === "polling" &&
        lastSeenUpdatedAtRef.current &&
        next.updatedAt === lastSeenUpdatedAtRef.current
      ) {
        return;
      }
      lastSeenUpdatedAtRef.current = next.updatedAt;
      dispatch({ type: "HYDRATE", payload: next });
    } catch (error) {
      // 401（未登录）在公开页面轮询时属正常情况，静默处理不弹提示。
      // 仅对真正的服务器错误（500 等）弹出错误提示。
      const isUnauthorized = error instanceof Error && error.message === "SESSION_UNAUTHORIZED";
      if (!isUnauthorized) {
        console.error("[session] Failed to fetch session state:", error);
        toast.error("无法读取课堂数据", { id: "session-read-error", description: "请检查会话接口或服务器数据文件后重试。" });
      }
      if (!stateRef.current.hydrated) {
        dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
      }
    }
  }

  function commit(
    action: SessionAction,
    options?: { localOnly?: boolean },
  ): Promise<boolean> {
    dispatch(action);
    // Identity and hydration are client state, never persisted business
    // actions. Keep this invariant here so a future caller cannot accidentally
    // send SET_USER to the role-protected action endpoint.
    if (
      options?.localOnly ||
      action.type === "SET_USER" ||
      action.type === "HYDRATE"
    ) {
      return Promise.resolve(true);
    }
    setSaveState("saving");
    setSaveError(undefined);
    pendingCommitsRef.current++;
    const requestId = clientUUID();
    const run = async () => {
      const ack = await postSessionActionWithRetry(action, stateRef.current, requestId);
      const courseId = courseIdForAction(action);
      if (courseId) {
        const versionAction: SessionAction = {
          type: "UPDATE_COURSE",
          payload: { id: courseId, patch: { version: ack.courseVersion } },
        };
        stateRef.current = applySessionAction(stateRef.current, versionAction);
        dispatch(versionAction);
      }
      return ack;
    };
    const queued = commitQueueRef.current.then(run, run);
    commitQueueRef.current = queued.catch(() => undefined);
    return queued
      .then(() => {
        pendingCommitsRef.current--;
        if (pendingCommitsRef.current === 0) {
          setLastSavedAt(new Date().toISOString());
          setSaveState("saved");
          lastFailedActionRef.current = null;
        }
        return true;
      })
      .catch((error) => {
        pendingCommitsRef.current--;
        console.error("[session] Failed to persist session action:", error);
        lastFailedActionRef.current = { action, requestId };
        setSaveState("error");
        setSaveError("数据保存失败，请检查服务器状态后重试。");
        toast.error("课堂数据尚未保存", { id: "session-write-error", description: "当前页面内容仍保留在本地，可直接重试。" });
        return false;
      });
  }

  function projectionQueueFor(courseId: string) {
    const existing = projectionQueuesRef.current.get(courseId);
    if (existing) return existing;
    const queue = new LatestValueQueue<QueuedProjectionUpdate>(
      async (update) => {
        const requestStartedAt = Date.now();
        const ack = await postProjectionActionWithRetry(update, stateRef.current);
        const responseReceivedAt = Date.now();
        if (ack.projection) {
          applyProjectionSnapshot(
            courseId,
            ack.projection,
            requestStartedAt,
            responseReceivedAt,
            queue.hasPending(),
          );
        }
      },
      PROJECTION_COALESCE_MS,
      PROJECTION_POLL_INTERVAL_MS,
      (error) => {
        const failures = (projectionFailureCountRef.current[courseId] ?? 0) + 1;
        projectionFailureCountRef.current[courseId] = failures;
        console.error("[session] Projection update failed; retrying latest state:", error);
        if (failures === COURSE_SYNC_FAILURE_NOTICE_THRESHOLD) {
          toast.error("投屏同步暂时中断", {
            id: "projection-sync-error",
            description: "系统正在重试最新投屏状态。",
          });
        }
      },
    );
    projectionQueuesRef.current.set(courseId, queue);
    return queue;
  }

  function queueProjectionAction(action: SessionAction): void {
    const patch = projectionPatchFromAction(action);
    const courseId = courseIdForAction(action);
    if (!patch || !courseId) {
      void commit(action);
      return;
    }
    const previous = stateRef.current.courses.find(
      (course) => course.id === courseId,
    )?.uiState;
    const immediate = isImmediateProjectionPatch(previous, patch);
    const next = applySessionAction(stateRef.current, action);
    stateRef.current = next;
    dispatch(action);
    projectionQueueFor(courseId).enqueue(
      { action, requestId: clientUUID() },
      immediate,
    );
  }

  function hasProjectionWork(courseId: string): boolean {
    return projectionQueuesRef.current.get(courseId)?.hasWork() ?? false;
  }

  async function retrySave() {
    const failed = lastFailedActionRef.current;
    if (!failed) return;
    setSaveState("saving");
    setSaveError(undefined);
    // Route retry through the same pendingCommitsRef serialization as commit():
    // bump the in-flight counter so polling refresh is suppressed while the
    // retry is in flight, and only HYDRATE from the response when this is the
    // last pending commit. Otherwise a concurrent commit's response could be
    // overwritten by the (older) retry response.
    pendingCommitsRef.current++;
    try {
      const ack = await postSessionActionWithRetry(
        failed.action,
        stateRef.current,
        failed.requestId,
      );
      pendingCommitsRef.current--;
      const courseId = courseIdForAction(failed.action);
      if (courseId) {
        const versionAction: SessionAction = {
          type: "UPDATE_COURSE",
          payload: { id: courseId, patch: { version: ack.courseVersion } },
        };
        stateRef.current = applySessionAction(stateRef.current, versionAction);
        dispatch(versionAction);
      }
      if (pendingCommitsRef.current === 0) {
        setLastSavedAt(new Date().toISOString());
        setSaveState("saved");
        lastFailedActionRef.current = null;
        toast.success("已重新保存");
      }
    } catch (error) {
      pendingCommitsRef.current--;
      console.error("[session] Retry failed:", error);
      setSaveState("error");
      setSaveError("重试失败，请确认服务器可用。");
      toast.error("重新保存失败");
    }
  }

  async function flushSaves(): Promise<boolean> {
    await commitQueueRef.current;
    return pendingCommitsRef.current === 0 && !lastFailedActionRef.current;
  }

  // ---- Stage 4: WebSocket realtime sync ----
  // The WebSocket server runs on a separate port (default 3001). Clients
  // try to connect once on mount; on 5 consecutive failures they give up
  // and stay on the durable per-course event polling fallback. The first
  // successful connection switches wsModeRef to "websocket" while retaining
  // a lower-frequency durable cursor check for cross-instance correctness.
  function teardownWebSocket() {
    if (courseRefreshTimerRef.current !== null) {
      window.clearTimeout(courseRefreshTimerRef.current);
      courseRefreshTimerRef.current = null;
    }
    if (wsRetryTimerRef.current !== null) {
      window.clearTimeout(wsRetryTimerRef.current);
      wsRetryTimerRef.current = null;
    }
    if (wsSubscriptionTimerRef.current !== null) {
      window.clearTimeout(wsSubscriptionTimerRef.current);
      wsSubscriptionTimerRef.current = null;
    }
    if (wsConnectionTimerRef.current !== null) {
      window.clearTimeout(wsConnectionTimerRef.current);
      wsConnectionTimerRef.current = null;
    }
    stopCoursePolling();
    stopProjectionPolling();
    const ws = wsRef.current;
    if (!ws) return;
    try {
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.onopen = null;
      ws.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
  }

  function stopCoursePolling() {
    if (coursePollTimerRef.current !== null) {
      window.clearInterval(coursePollTimerRef.current);
      coursePollTimerRef.current = null;
    }
  }

  function stopProjectionPolling() {
    if (projectionPollTimerRef.current !== null) {
      window.clearInterval(projectionPollTimerRef.current);
      projectionPollTimerRef.current = null;
    }
    projectionPollAbortRef.current?.abort();
    projectionPollAbortRef.current = null;
    projectionPollSequenceRef.current += 1;
  }

  function recordCourseSyncSuccess() {
    if (coursePollFailuresRef.current >= COURSE_SYNC_FAILURE_NOTICE_THRESHOLD) {
      toast.success("课堂实时同步已恢复", { id: "course-sync-error" });
    }
    coursePollFailuresRef.current = 0;
  }

  function recordCourseSyncFailure(error: unknown) {
    coursePollFailuresRef.current += 1;
    console.error("[session] Course synchronization failed:", error);
    if (coursePollFailuresRef.current === COURSE_SYNC_FAILURE_NOTICE_THRESHOLD) {
      toast.error("课堂实时同步中断", {
        id: "course-sync-error",
        description: "无法从服务器读取最新课堂状态，系统正在自动重试。",
      });
    }
  }

  function applyProjectionSnapshot(
    courseId: string,
    snapshot: ProjectionStateSnapshot,
    requestStartedAt: number,
    responseReceivedAt: number,
    preserveOptimisticProjection = false,
  ): boolean {
    if (snapshot.courseId !== courseId) return false;
    const incomingVersion = snapshot.projectionVersion;
    const current = stateRef.current;
    const currentCourse = current.courses.find((course) => course.id === courseId);
    const hydratedVersion = currentCourse?.uiState?.projectionVersion;
    const trackedVersion = projectionVersionRef.current[courseId];
    const knownVersion = highestKnownProjectionVersion(
      hydratedVersion,
      trackedVersion,
    );
    if (!shouldApplyProjectionVersion(
      knownVersion,
      incomingVersion,
    )) {
      return false;
    }
    const offsetMs = estimateServerClockOffset(
      snapshot.serverTime,
      requestStartedAt,
      responseReceivedAt,
    );
    const adjusted = withProjectionClockOffset(snapshot, offsetMs);
    if (!currentCourse) return false;
    const patch: Partial<CourseUiState> = {
      projectionVersion: incomingVersion,
      projectionUpdatedAt: snapshot.projectionUpdatedAt,
      projectionClockOffsetMs: offsetMs,
      ...(preserveOptimisticProjection
        ? {}
        : {
            resourceProjection: adjusted.resourceProjection,
            teacherResourceProjection: adjusted.teacherResourceProjection,
          }),
    };
    let next = applySessionAction(current, {
      type: "SET_UI_STATE",
      payload: { courseId, patch },
    });
    next = {
      ...next,
      courses: next.courses.map((course) => course.id === courseId
        ? { ...course, version: Math.max(course.version ?? 0, snapshot.courseVersion) }
        : course),
    };
    projectionVersionRef.current[courseId] = incomingVersion;
    stateRef.current = next;
    dispatch({ type: "HYDRATE", payload: next });
    if (
      (projectionFailureCountRef.current[courseId] ?? 0)
      >= COURSE_SYNC_FAILURE_NOTICE_THRESHOLD
    ) {
      toast.success("投屏同步已恢复", { id: "projection-sync-error" });
    }
    projectionFailureCountRef.current[courseId] = 0;
    return true;
  }

  async function refreshProjectionState(courseId: string): Promise<void> {
    if (
      !isRealtimePollingActive(document.visibilityState)
      || projectionPollAbortRef.current
      || wsCourseIdRef.current !== courseId
    ) return;
    const controller = new AbortController();
    const sequence = ++projectionPollSequenceRef.current;
    projectionPollAbortRef.current = controller;
    const timeout = window.setTimeout(
      () => controller.abort(),
      PROJECTION_REQUEST_TIMEOUT_MS,
    );
    const requestStartedAt = Date.now();
    try {
      const response = await fetch(
        `/api/courses/${encodeURIComponent(courseId)}/projection`,
        {
          cache: "no-store",
          headers: { "X-OpenPBL-Role": getClientRole() ?? "student" },
          signal: controller.signal,
        },
      );
      const responseReceivedAt = Date.now();
      if (!response.ok) throw new Error(`PROJECTION_STATE_FAILED_${response.status}`);
      const snapshot = await response.json() as ProjectionStateSnapshot;
      if (
        sequence !== projectionPollSequenceRef.current
        || wsCourseIdRef.current !== courseId
      ) return;
      applyProjectionSnapshot(
        courseId,
        snapshot,
        requestStartedAt,
        responseReceivedAt,
        hasProjectionWork(courseId),
      );
    } catch (error) {
      if (!controller.signal.aborted || wsCourseIdRef.current === courseId) {
        recordCourseSyncFailure(error);
      }
    } finally {
      window.clearTimeout(timeout);
      if (projectionPollAbortRef.current === controller) {
        projectionPollAbortRef.current = null;
      }
    }
  }

  function startProjectionPolling(courseId: string | undefined): void {
    stopProjectionPolling();
    if (!courseId) return;
    void refreshProjectionState(courseId);
    projectionPollTimerRef.current = window.setInterval(
      () => void refreshProjectionState(courseId),
      wsModeRef.current === "websocket"
        ? PROJECTION_CONNECTED_CHECK_INTERVAL_MS
        : PROJECTION_POLL_INTERVAL_MS,
    );
  }

  function startCoursePolling(
    courseId: string | undefined,
    mode: RealtimeTransportMode = wsModeRef.current,
  ) {
    stopCoursePolling();
    if (!courseId) return;

    const poll = async () => {
      if (
        !isRealtimePollingActive(document.visibilityState)
        || coursePollInFlightRef.current
        || pendingCommitsRef.current > 0
      ) return;
      coursePollInFlightRef.current = true;
      try {
        // Seed the durable cursor from the current course snapshot. Afterwards
        // only the lightweight event endpoint is polled. This is independent
        // of process-local WebSocket delivery and therefore remains reliable
        // behind reverse proxies, Redis outages, and blue/green instances.
        if (eventCursorRef.current[courseId] === undefined) {
          await refreshCourse(courseId);
        } else {
          await catchUpCourseEvents(courseId);
        }
        recordCourseSyncSuccess();
      } catch (error) {
        recordCourseSyncFailure(error);
      } finally {
        coursePollInFlightRef.current = false;
      }
    };

    void poll();
    coursePollTimerRef.current = window.setInterval(
      () => void poll(),
      COURSE_EVENT_POLL_INTERVAL_MS[mode],
    );
  }

  function switchToPolling() {
    pollingRef.current = true;
    if (wsModeRef.current !== "polling") {
      wsModeRef.current = "polling";
      setRealtimeMode("polling");
    }
    startCoursePolling(wsCourseIdRef.current, "polling");
    startProjectionPolling(wsCourseIdRef.current);
  }

  async function refreshCourse(courseId: string, cursor?: string): Promise<boolean> {
    if (pendingCommitsRef.current > 0) return false;
    const response = await fetch(`/api/courses/${encodeURIComponent(courseId)}/state`, {
      cache: "no-store",
      headers: { "X-OpenPBL-Role": getClientRole() ?? "student" },
    });
    if (!response.ok) throw new Error(`COURSE_STATE_FAILED_${response.status}`);
    const body = (await response.json()) as {
      course: Course;
      eventCursor: string;
    };
    // A local action may have started while the request was in flight. Never
    // overwrite that optimistic state with an older server snapshot.
    if (pendingCommitsRef.current > 0) return false;
    const current = stateRef.current;
    const currentCourse = current.courses.find((course) => course.id === courseId);
    if (
      typeof currentCourse?.version === "number"
      && typeof body.course.version === "number"
      && currentCourse.version > body.course.version
    ) {
      return false;
    }
    const incomingCourse: Course = currentCourse
      ? {
          ...body.course,
          uiState: mergeCourseUiStateWithProjectionGuard(
            currentCourse.uiState,
            body.course.uiState,
            hasProjectionWork(courseId),
          ),
        }
      : body.course;
    const found = current.courses.some((course) => course.id === courseId);
    const next = applyIdentity({
      ...current,
      courses: found
        ? current.courses.map((course) => (course.id === courseId ? incomingCourse : course))
        : [incomingCourse, ...current.courses],
      updatedAt: body.course.updatedAt,
      hydrated: true,
    });
    eventCursorRef.current[courseId] = latestEventCursor(
      eventCursorRef.current[courseId],
      cursor,
      body.eventCursor,
    );
    stateRef.current = next;
    dispatch({ type: "HYDRATE", payload: next });
    return true;
  }

  function scheduleCourseRefresh(
    courseId: string,
    cursor?: string,
    priority: "classroom-control" | "standard" = "standard",
  ) {
    if (courseRefreshTimerRef.current !== null) {
      window.clearTimeout(courseRefreshTimerRef.current);
    }
    courseRefreshTimerRef.current = window.setTimeout(() => {
      courseRefreshTimerRef.current = null;
      void refreshCourse(courseId, cursor)
        .then((refreshed) => {
          if (refreshed) recordCourseSyncSuccess();
        })
        .catch(recordCourseSyncFailure);
    }, courseRefreshDelay(Math.random(), priority));
  }

  async function catchUpCourseEvents(courseId: string) {
    const after = eventCursorRef.current[courseId] ?? "0";
    const response = await fetch(
      `/api/courses/${encodeURIComponent(courseId)}/events?after=${encodeURIComponent(after)}`,
      { cache: "no-store", headers: { "X-OpenPBL-Role": getClientRole() ?? "student" } },
    );
    if (!response.ok) throw new Error(`COURSE_EVENTS_FAILED_${response.status}`);
    const body = (await response.json()) as {
      events: Array<{
        cursor?: string;
        type?: string;
        courseVersion?: number;
        payload?: Record<string, unknown> | null;
      }>;
      nextCursor: string;
      hasMore: boolean;
      requiresReconciliation?: boolean;
      courseVersion?: number;
    };
    const localVersion = stateRef.current.courses.find(
      (course) => course.id === courseId,
    )?.version ?? 0;
    const versionGap = body.requiresReconciliation === true
      && typeof body.courseVersion === "number"
      && body.courseVersion > localVersion;
    const projectionsApplied = body.events.length > 0
      && body.events.every((event) => applyProjectionEvent(courseId, {
        type: event.type,
        courseVersion: event.courseVersion,
        cursor: event.cursor,
        payload: event.payload ?? undefined,
      }));
    if (
      (body.events.length > 0 && !projectionsApplied)
      || (versionGap && !projectionsApplied)
    ) {
      const refreshed = await refreshCourse(courseId, body.nextCursor);
      if (!refreshed) return;
    } else {
      eventCursorRef.current[courseId] = latestEventCursor(
        eventCursorRef.current[courseId],
        body.nextCursor,
      );
    }
    if (body.hasMore) await catchUpCourseEvents(courseId);
  }

  function applyProjectionEvent(
    courseId: string,
    event: {
      type?: string;
      courseVersion?: number;
      cursor?: string;
      payload?: Record<string, unknown>;
    },
  ): boolean {
    const payload = event.payload;
    if (
      !payload
      || (event.type !== "projection-changed" && event.type !== "SET_UI_STATE")
    ) return false;
    const hasResourceProjection = Object.prototype.hasOwnProperty.call(
      payload,
      "resourceProjection",
    );
    const hasTeacherProjection = Object.prototype.hasOwnProperty.call(
      payload,
      "teacherResourceProjection",
    );
    if (!hasResourceProjection && !hasTeacherProjection) return false;
    if (
      typeof payload.projectionVersion !== "number"
      || typeof payload.projectionUpdatedAt !== "string"
      || typeof payload.serverTime !== "string"
    ) {
      return false;
    }
    const receivedAt = Date.now();
    const snapshot: ProjectionStateSnapshot = {
      courseId,
      courseVersion: typeof payload.courseVersion === "number"
        ? payload.courseVersion
        : event.courseVersion ?? 0,
      projectionVersion: payload.projectionVersion,
      projectionUpdatedAt: payload.projectionUpdatedAt,
      serverTime: payload.serverTime,
      resourceProjection: hasResourceProjection
        ? payload.resourceProjection as CourseUiState["resourceProjection"]
        : null,
      teacherResourceProjection: hasTeacherProjection
        ? payload.teacherResourceProjection as CourseUiState["teacherResourceProjection"]
        : null,
    };
    applyProjectionSnapshot(
      courseId,
      snapshot,
      receivedAt,
      receivedAt,
      hasProjectionWork(courseId),
    );
    return true;
  }

  function connectWebSocket(courseId: string | undefined) {
    if (typeof window === "undefined") return;
    const previousCourseId = wsCourseIdRef.current;
    wsCourseIdRef.current = courseId;
    if (!courseId) {
      teardownWebSocket();
      switchToPolling();
      return;
    }
    // Focus/network recovery on an already subscribed room only needs an
    // immediate durable catch-up. A course switch gets a fresh socket so old
    // handler closures cannot apply messages to the new room.
    if (
      wsRef.current
      && wsRef.current.readyState === WebSocket.OPEN
      && previousCourseId === courseId
    ) {
      startProjectionPolling(courseId);
      void Promise.all([
        catchUpCourseEvents(courseId),
        refreshProjectionState(courseId),
      ]).then(recordCourseSyncSuccess).catch(recordCourseSyncFailure);
      return;
    }
    if (
      wsRef.current
      && wsRef.current.readyState === WebSocket.CONNECTING
      && previousCourseId === courseId
    ) {
      startCoursePolling(courseId, "polling");
      startProjectionPolling(courseId);
      return;
    }
    // Tear down any half-open socket before retrying.
    teardownWebSocket();
    startProjectionPolling(courseId);

    const role = getClientRole();
    if (!role) return;
    const configuredUrl = process.env.NEXT_PUBLIC_WEBSOCKET_URL?.trim();
    // `next dev` does not expose the standalone WebSocket server on `/ws`.
    // Without an explicit development URL, polling is the intended transport;
    // repeatedly opening a socket here only produces noisy browser errors.
    if (process.env.NODE_ENV === "development" && !configuredUrl) {
      switchToPolling();
      return;
    }
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = new URL(
      configuredUrl || `${protocol}//${window.location.host}/ws`,
      window.location.href,
    );
    url.searchParams.set("role", role);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (err) {
      console.warn("[session] WebSocket construction failed:", err);
      switchToPolling();
      return;
    }
    wsRef.current = ws;
    wsConnectionTimerRef.current = window.setTimeout(() => {
      wsConnectionTimerRef.current = null;
      if (wsRef.current === ws && ws.readyState === WebSocket.CONNECTING) {
        ws.close();
      }
    }, 5_000);
    // Keep the durable event-cursor fallback active while the upgrade is in
    // flight. A proxy can leave a failed upgrade pending for several seconds.
    startCoursePolling(courseId);

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      if (wsConnectionTimerRef.current !== null) {
        window.clearTimeout(wsConnectionTimerRef.current);
        wsConnectionTimerRef.current = null;
      }
      wsFailureCountRef.current = 0;
      // Opening the transport is not enough: stay in fast polling mode until
      // the server confirms that this socket joined the requested room.
      switchToPolling();
      try {
        ws.send(JSON.stringify({ type: "subscribe", courseId }));
        if (wsSubscriptionTimerRef.current !== null) {
          window.clearTimeout(wsSubscriptionTimerRef.current);
        }
        wsSubscriptionTimerRef.current = window.setTimeout(() => {
          wsSubscriptionTimerRef.current = null;
          if (wsRef.current === ws) ws.close(4008, "SUBSCRIBE_TIMEOUT");
        }, 3_000);
      } catch {
        ws.close(1011, "SUBSCRIBE_FAILED");
      }
    };

    ws.onmessage = (event) => {
      // Course events advance a durable cursor. Catch up only the affected
      // course instead of downloading the full cross-course session.
      try {
        const data = event.data as unknown;
        if (typeof data === "string") {
          const parsed = JSON.parse(data) as {
            type?: string;
            courseId?: string;
            event?: {
              type?: string;
              payload?: { eventCursor?: string; actionType?: string; [key: string]: unknown };
            };
          };
          if (parsed.type === "subscribed" && parsed.courseId === courseId) {
            if (wsSubscriptionTimerRef.current !== null) {
              window.clearTimeout(wsSubscriptionTimerRef.current);
              wsSubscriptionTimerRef.current = null;
            }
            pollingRef.current = false;
            if (wsModeRef.current !== "websocket") {
              wsModeRef.current = "websocket";
              setRealtimeMode("websocket");
            }
            startProjectionPolling(courseId);
            startCoursePolling(courseId, "websocket");
            void Promise.all([
              catchUpCourseEvents(courseId),
              refreshProjectionState(courseId),
            ]).then(recordCourseSyncSuccess).catch(recordCourseSyncFailure);
            return;
          }
          if (parsed.type === "course-event" && parsed.courseId === courseId) {
            if (parsed.event?.type === "showcase-presentation") {
              emitShowcasePresentation(
                courseId,
                (parsed.event.payload ?? {}) as ShowcaseEventPayload,
              );
              return;
            }
            if (applyProjectionEvent(courseId, {
              type: parsed.event?.type,
              courseVersion: typeof parsed.event?.payload?.courseVersion === "number"
                ? parsed.event.payload.courseVersion
                : undefined,
              cursor: parsed.event?.payload?.eventCursor,
              payload: parsed.event?.payload,
            })) {
              recordCourseSyncSuccess();
              return;
            }
            scheduleCourseRefresh(
              courseId,
              parsed.event?.payload?.eventCursor,
              isClassroomControlEvent(
                parsed.event?.type,
                parsed.event?.payload?.actionType,
              )
                ? "classroom-control"
                : "standard",
            );
          }
        }
      } catch {
        /* noop */
      }
    };

    // Browsers expose WebSocket failures as an opaque Event. `onclose` below
    // owns the actionable fallback/retry path, so logging the Event here adds
    // noise without diagnostic information.
    ws.onerror = () => {};

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      if (wsConnectionTimerRef.current !== null) {
        window.clearTimeout(wsConnectionTimerRef.current);
        wsConnectionTimerRef.current = null;
      }
      if (wsSubscriptionTimerRef.current !== null) {
        window.clearTimeout(wsSubscriptionTimerRef.current);
        wsSubscriptionTimerRef.current = null;
      }
      wsRef.current = null;
      wsFailureCountRef.current++;
      switchToPolling();
      const delay = Math.min(
        30_000,
        1_000 * 2 ** Math.min(wsFailureCountRef.current - 1, 5),
      );
      const jitter = Math.floor(Math.random() * 500);
      wsRetryTimerRef.current = window.setTimeout(() => {
        wsRetryTimerRef.current = null;
        connectWebSocket(wsCourseIdRef.current);
      }, delay + jitter);
    };
  }

  useEffect(() => {
    const mode = getSessionRouteMode(pathname);
    const role = pathname.startsWith("/teacher") ? "teacher" : "student";
    let cancelled = false;
    let refreshEnabled = false;
    let intervalId: number | undefined;

    const refreshWhenVisible = () => {
      if (
        refreshEnabled
        && !cancelled
        && document.visibilityState === "visible"
        && pollingRef.current
        && !wsCourseIdRef.current
      ) {
        void refresh(role);
      }
    };

    async function startSessionRefresh() {
      if (mode === "identity") {
        // AI settings need the signed-in name but have no legacy classroom data.
        await refresh(role).catch(() => {
          if (!cancelled) dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
        });
        return;
      }
      if (mode === "none") {
        if (!stateRef.current.hydrated) {
          dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
        }
        return;
      }

      if (mode === "optional" && !(await hasAuthenticatedSession(role))) {
        if (!cancelled && !stateRef.current.hydrated) {
          dispatch({ type: "HYDRATE", payload: makeEmptyHydratedState() });
        }
        return;
      }
      if (cancelled) return;

      refreshEnabled = true;
      await refresh(role);
      if (cancelled) return;

      // Poll only while the current route can legitimately access course
      // data. A client-side route change tears this interval down.
      intervalId = window.setInterval(() => {
        // Classroom views already reconcile a lightweight per-course event
        // cursor. Avoid downloading the full cross-course session as well.
        if (
          isRealtimePollingActive(document.visibilityState)
          && pollingRef.current
          && !wsCourseIdRef.current
        ) void refresh(role);
      }, SESSION_REFRESH_INTERVAL_MS);
    }

    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    void startSessionRefresh();
    return () => {
      cancelled = true;
      refreshEnabled = false;
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      if (intervalId !== undefined) window.clearInterval(intervalId);
    };
    // refresh reads mutable state through refs. Pathname is the intended
    // lifecycle boundary; render-local callback identities are not.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Classroom pages subscribe through useRealtimeSync. Connections fail
  // silently and the per-course event cursor keeps the UI fresh regardless.
  // Tear down both transports on unmount.
  useEffect(() => {
    const projectionQueues = projectionQueuesRef.current;
    return () => {
      teardownWebSocket();
      for (const queue of projectionQueues.values()) queue.dispose();
      projectionQueues.clear();
    };
    // The provider owns one socket lifecycle; render-local function identity
    // changes must not tear it down and recreate it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function disconnectRealtime() {
    wsCourseIdRef.current = undefined;
    pollingRef.current = true;
    teardownWebSocket();
    if (wsModeRef.current !== "polling") {
      wsModeRef.current = "polling";
      setRealtimeMode("polling");
    }
  }

  useEffect(() => {
    // Persist identity per-browser so refreshes keep the joined student context.
    // We also cache joinedAt (looked up from the joined course's students list)
    // and group membership so applyIdentity can fully reconstruct the Student
    // record when polling refresh races ahead of the server's action processing.
    let joinedAt: string | undefined;
    let joinedGroupId: string | undefined;
    let joinedGroupRole: string | undefined;
    if (state.joinedCourseId && state.studentId) {
      const joinedCourse = state.courses.find((c) => c.id === state.joinedCourseId);
      joinedAt = joinedCourse?.students.find((s) => s.id === state.studentId)?.joinedAt;
      // Find which group the student belongs to
      const studentGroup = joinedCourse?.groups?.find((g) =>
        g.members.some((m) => m.studentId === state.studentId),
      );
      if (studentGroup) {
        joinedGroupId = studentGroup.id;
        joinedGroupRole = studentGroup.members.find((m) => m.studentId === state.studentId)?.role;
      }
    }
    const identity: IdentityState = {
      user: state.user,
      joinedCourseId: state.joinedCourseId,
      studentId: state.studentId,
      studentName: state.studentName,
      joinedAt,
      joinedGroupId,
      joinedGroupRole,
    };
    // Save to role-specific key to prevent teacher/student cross-contamination
    const identityKey = state.user.role === "teacher" ? TEACHER_IDENTITY_KEY : STUDENT_IDENTITY_KEY;
    saveJSON(identityKey, identity);
    // Also save to legacy key for backwards compat
    saveJSON(IDENTITY_KEY, identity);
  }, [state.user, state.joinedCourseId, state.studentId, state.studentName, state.courses]);

  const api: SessionApi = useMemo(() => {
    const prepareSubmission = (input: SubmissionInput): {
      courseId: string;
      submission: ClassroomSubmission;
    } | undefined => {
      const courseId = input.courseId ?? state.joinedCourseId;
      if (!courseId) return undefined;
      const now = new Date().toISOString();
      const existingSubmission = input.id
        ? state.courses
          .find((course) => course.id === courseId)
          ?.submissions?.find((submission) => submission.id === input.id)
        : undefined;
      return {
        courseId,
        submission: {
          id: input.id ?? makeRecordId("sub"),
          courseId,
          studentId: input.studentId ?? state.studentId,
          studentName: input.studentName ?? state.studentName ?? state.user.name,
          groupId: input.groupId,
          stageKey: input.stageKey,
          type: input.type,
          title: input.title,
          content: input.content,
          files: input.files,
          status: "draft",
          version: existingSubmission ? (existingSubmission.version ?? 1) + 1 : 1,
          createdAt: existingSubmission?.createdAt ?? now,
          updatedAt: now,
        },
      };
    };
    return {
      ...state,
      saveState,
      lastSavedAt,
      saveError,
      retrySave,
      flushSaves,
      setUser(u) {
        commit({ type: "SET_USER", payload: u }, { localOnly: true });
      },
      createCourse(input) {
        const id = makeCourseId();
        const now = new Date().toISOString();
        const course: Course = {
          ...input,
          id,
          name: input.name ?? "未命名课程",
          subject: input.subject ?? DEFAULT_NEW_COURSE_SUBJECT,
          grade: input.grade ?? "",
          hours: input.hours ?? DEFAULT_NEW_COURSE_HOURS,
          summary: input.summary ?? "",
          drivingQuestion: input.drivingQuestion ?? "",
          pblConfig: normalizePblCourseConfig(input.pblConfig),
          status: "draft",
          stages: input.stages ?? getStagesForSystemMode(),
          currentStageIndex: 0,
          content: input.content ?? {
            pblOutline: "",
            knowledgePoints: [],
            teachingOutline: [],
            lessonOutline: [],
            evaluationPlan: {
              dimensions: [],
              overallRubric: "",
              flows: DEFAULT_EVALUATION_FLOWS.map((flow) => ({
                ...flow,
                evidenceRequirements: [...flow.evidenceRequirements],
              })),
            },
          },
          classConfig: undefined,
          inviteCode: undefined,
          students: [],
          submissions: [],
          feedback: [],
          rubricScores: [],
          reflections: [],
          activityLog: [],
          announcements: [],
          todos: defaultTodos(),
          resources: [],
          groups: [],
          groupAnnouncements: [],
          workPlan: [],
          whiteboard: [],
          boards: [],
          uploads: [],
          teamContributions: [],
          aiSupports: [],
          companionTasks: [],
          companionConfirmations: [],
          companionProcessRecords: [],
          learningEvidence: [],
          artifactSnapshots: [],
          aiContributions: [],
          studentAiDecisions: [],
          aiAssessmentSuggestions: [],
          teacherInterventions: [],
          stageTransitions: [],
          evaluations: [],
          uiState: {},
          createdAt: now,
          updatedAt: now,
          version: 1,
        };
        commit({ type: "CREATE_COURSE", payload: course });
        return course;
      },
      updateCourse(id, patch) {
        commit({ type: "UPDATE_COURSE", payload: { id, patch } });
      },
      deleteCourse(id) {
        commit({ type: "DELETE_COURSE", payload: { id } });
      },
      setCourseContent(id, content) {
        commit({ type: "SET_COURSE_CONTENT", payload: { id, content } });
      },
      setCourseStages(id, stages) {
        commit({ type: "SET_COURSE_STAGES", payload: { id, stages } });
      },
      publishCourse(id) {
        const course = state.courses.find((item) => item.id === id);
        const blocker = course
          ? getNewSystemCourseReadiness(course).find((check) => !check.ok)
          : undefined;
        if (!course || blocker) {
          throw new Error(blocker?.message ?? "课程不存在，无法发布。");
        }
        commit({ type: "PUBLISH_COURSE", payload: { id } });
      },
      startTeaching(id, classConfig) {
        const course = state.courses.find((item) => item.id === id);
        const blockers = course
          ? getNewSystemCourseReadiness(course).filter((check) => !check.ok)
          : [];
        if (!course || blockers.length > 0) {
          throw new Error(
            blockers[0]?.message ?? "课程不存在，无法开始授课。",
          );
        }
        const code = course.platformContext ? (course.inviteCode ?? "") : generateInviteCode(6);
        commit({
          type: "START_TEACHING",
          payload: { id, classConfig, inviteCode: code },
        });
        return code;
      },
      restartTeaching(id) {
        const newInviteCode = generateInviteCode(6);
        commit({
          type: "RESTART_TEACHING",
          payload: { id, newInviteCode },
        });
        return { inviteCode: newInviteCode };
      },
      endTeaching(id) {
        commit({ type: "END_TEACHING", payload: { id } });
      },
      advanceStage(id, direction) {
        commit({ type: "ADVANCE_STAGE", payload: { id, direction } });
      },
      setStage(id, index) {
        commit({ type: "SET_STAGE", payload: { id, index } });
      },
      joinClass(code, name) {
        const target = state.courses.find(
          (c) =>
            c.inviteCode &&
            c.inviteCode.toUpperCase() === normalizeInviteCode(code) &&
            c.status === "teaching",
        );
        if (!target) {
          return { ok: false, reason: "邀请码无效，或教师尚未开始授课" };
        }
        const trimmedName = name?.trim() || "学生";

        // ===== Same-name account merge =====
        // If a student with the same name already exists in this course,
        // reuse the existing account instead of creating a new one. This
        // ensures each student name appears only once in the teacher's
        // roster, and preserves all of the student's prior learning data
        // (stageProgress, submissions, group membership, etc.).
        const existing = target.students.find(
          (s) => s.name.toLowerCase() === trimmedName.toLowerCase(),
        );
        const student: Student = existing
          ? { ...existing, name: trimmedName, lastSeenAt: new Date().toISOString() }
          : {
              id: makeStudentId(),
              name: trimmedName,
              joinedAt: new Date().toISOString(),
              stageProgress: {},
              lastSeenAt: new Date().toISOString(),
            };

        // Update the user object so the top-right avatar shows the student's
        // name and role, not the default teacher identity.
        const studentUser = { role: "student" as const, name: student.name };
        // Pre-seed the identity cache so the next polling refresh cannot
        // drop the just-joined student from course.students before the
        // server's JOIN_CLASS ack lands.
        const identity: IdentityState = {
          user: studentUser,
          joinedCourseId: target.id,
          studentId: student.id,
          studentName: student.name,
          joinedAt: student.joinedAt,
        };
        saveJSON(STUDENT_IDENTITY_KEY, identity);
        saveJSON(IDENTITY_KEY, identity);
        void commit(
          { type: "SET_USER", payload: studentUser },
          { localOnly: true },
        );
        commit({ type: "JOIN_CLASS", payload: { courseId: target.id, student } });
        return { ok: true, course: target };
      },
      async leaveClass() {
        if (state.joinedCourseId && state.studentId) {
          // Save left-class history so the student can rejoin by name later.
          const leftCourse = state.courses.find((c) => c.id === state.joinedCourseId);
          if (leftCourse) {
            const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
            const record: LeftClassRecord = {
              courseId: leftCourse.id,
              courseName: leftCourse.name,
              studentId: state.studentId!,
              studentName: state.studentName ?? state.user.name,
              leftAt: new Date().toISOString(),
            };
            // Keep only the latest record per course
            const filtered = history.filter((r) => r.courseId !== record.courseId);
            filtered.push(record);
            saveJSON(LEFT_CLASS_HISTORY_KEY, filtered);
          }
          const leaveAction: SessionAction = {
            type: "LEAVE_CLASS",
            payload: {
              courseId: state.joinedCourseId,
              studentId: state.studentId,
            },
          };
          const persisted = await commit(leaveAction);
          if (!persisted) return false;
          // The authenticated response is scoped by the still-valid student
          // cookie and can carry the old course identity. Clear it again only
          // after the response arrives.
          dispatch(leaveAction);
          // Reset user to a generic student so the avatar no longer shows
          // the previous student name after leaving.
          await commit(
            { type: "SET_USER", payload: { role: "student", name: "" } },
            { localOnly: true },
          );
        }
        return true;
      },
      rejoinClass(record: LeftClassRecord) {
        const target = state.courses.find((c) => c.id === record.courseId);
        if (!target || target.status !== "teaching") {
          // Remove stale history entry
          const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
          saveJSON(LEFT_CLASS_HISTORY_KEY, history.filter((r) => r.courseId !== record.courseId));
          return { ok: false as const, reason: "课堂已结束或不存在，无法重新加入" };
        }
        // Check if student is still in the course's student list
        const existingStudent = target.students.find((s) => s.id === record.studentId);
        if (existingStudent) {
          // Student record still exists (teacher may not have removed them) — just restore identity
          const studentUser = { role: "student" as const, name: record.studentName };
          const identity: IdentityState = {
            user: studentUser,
            joinedCourseId: target.id,
            studentId: record.studentId,
            studentName: record.studentName,
            joinedAt: existingStudent.joinedAt,
          };
          saveJSON(STUDENT_IDENTITY_KEY, identity);
          saveJSON(IDENTITY_KEY, identity);
          void commit(
            { type: "SET_USER", payload: studentUser },
            { localOnly: true },
          );
          commit({ type: "JOIN_CLASS", payload: { courseId: target.id, student: existingStudent } });
        } else {
          // Student was removed from the course — re-add them
          const student: Student = {
            id: record.studentId,
            name: record.studentName,
            joinedAt: new Date().toISOString(),
            stageProgress: {},
          };
          const studentUser = { role: "student" as const, name: record.studentName };
          const identity: IdentityState = {
            user: studentUser,
            joinedCourseId: target.id,
            studentId: student.id,
            studentName: student.name,
            joinedAt: student.joinedAt,
          };
          saveJSON(STUDENT_IDENTITY_KEY, identity);
          saveJSON(IDENTITY_KEY, identity);
          void commit(
            { type: "SET_USER", payload: studentUser },
            { localOnly: true },
          );
          commit({ type: "JOIN_CLASS", payload: { courseId: target.id, student } });
        }
        // Remove the history entry after successful rejoin
        const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
        saveJSON(LEFT_CLASS_HISTORY_KEY, history.filter((r) => r.courseId !== record.courseId));
        return { ok: true as const, course: target };
      },
      getLeftClassHistory() {
        const history = loadJSON<LeftClassRecord[]>(LEFT_CLASS_HISTORY_KEY, []);
        // Filter out entries for courses that are no longer teaching
        return history.filter((r) => {
          const course = state.courses.find((c) => c.id === r.courseId);
          return course?.status === "teaching";
        });
      },
      updateStudentProgress(stageKey, value) {
        if (!state.joinedCourseId || !state.studentId) return;
        commit({
          type: "UPDATE_STUDENT_PROGRESS",
          payload: {
            courseId: state.joinedCourseId,
            studentId: state.studentId,
            stageKey,
            value,
          },
        });
      },
      upsertSubmission(input) {
        const prepared = prepareSubmission(input);
        if (!prepared) return undefined;
        commit({ type: "UPSERT_SUBMISSION", payload: prepared });
        return prepared.submission;
      },
      async persistSubmission(input) {
        const prepared = prepareSubmission(input);
        if (!prepared) return undefined;
        const persisted = await commit({ type: "UPSERT_SUBMISSION", payload: prepared });
        return persisted ? prepared.submission : undefined;
      },
      addFeedback(input) {
        const courseId = input.courseId;
        if (!courseId) return undefined;
        const feedback: TeacherFeedback = {
          id: input.id ?? makeRecordId("fb"),
          courseId,
          targetType: input.targetType,
          targetId: input.targetId,
          stageKey: input.stageKey,
          kind: input.kind,
          content: input.content,
          sourceRole: input.sourceRole ?? "teacher",
          sourceName: input.sourceName ?? state.user.name,
          evidence: input.evidence ?? [],
          status: input.status ?? "open",
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_FEEDBACK", payload: { courseId, feedback } });
        return feedback;
      },
      upsertRubricScore(input) {
        const courseId = input.courseId;
        if (!courseId) return undefined;
        const now = new Date().toISOString();
        const score: RubricScore = {
          id: input.id ?? makeRecordId("score"),
          courseId,
          groupId: input.groupId,
          stageKey: input.stageKey,
          dimensionScores: input.dimensionScores,
          rubricSnapshot: input.rubricSnapshot,
          teacherTotal: input.teacherTotal,
          aiDimensionScores: input.aiDimensionScores,
          aiTotal: input.aiTotal,
          aiProcessSummary: input.aiProcessSummary,
          aiProcessEvidence: input.aiProcessEvidence,
          finalTotal: input.finalTotal,
          scoringMode: input.scoringMode,
          comment: input.comment,
          total: input.total,
          status: input.status,
          createdAt: now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_RUBRIC_SCORE", payload: { courseId, score } });
        return score;
      },
      upsertReflection(input) {
        const courseId = input.courseId ?? state.joinedCourseId;
        const studentId = input.studentId ?? state.studentId;
        if (!courseId || !studentId) return undefined;
        const now = new Date().toISOString();
        const course = state.courses.find((candidate) => candidate.id === courseId);
        const existing = course?.reflections?.find((reflection) => reflection.id === input.id)
          ?? (input.survey
            ? [...(course?.reflections ?? [])]
              .filter((reflection) => reflection.studentId === studentId)
              .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
            : undefined);
        const reflectionId = existing?.id ?? input.id ?? makeRecordId("ref");
        const reflection: ReflectionRecord = {
          id: reflectionId,
          courseId,
          studentId,
          studentName: input.studentName ?? state.studentName ?? state.user.name,
          content: input.content,
          improvementPlan: input.improvementPlan,
          survey: input.survey,
          courseReflection: input.courseReflection,
          experienceSurvey: input.experienceSurvey,
          // A legacy reflection may share the same record id, but its
          // creation time predates the survey. Start the survey's first
          // submission clock at this save; subsequent structured updates
          // retain that original timestamp.
          createdAt: input.survey && !existing?.survey
            ? now
            : existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_REFLECTION", payload: { courseId, reflection } });
        return reflection;
      },
      upsertAnnouncement(courseId, input) {
        const now = new Date().toISOString();
        const announcement: CourseAnnouncement = {
          id: input.id ?? makeRecordId("ann"),
          title: input.title,
          content: input.content,
          pinned: input.pinned,
          replies: input.replies ?? [],
          createdAt: now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_ANNOUNCEMENT", payload: { courseId, announcement } });
        return announcement;
      },
      deleteAnnouncement(courseId, announcementId) {
        commit({ type: "DELETE_ANNOUNCEMENT", payload: { courseId, announcementId } });
      },
      replyAnnouncement(courseId, announcementId, content) {
        if (!content.trim()) return undefined;
        const reply: AnnouncementReply = {
          id: makeRecordId("reply"),
          studentId: state.studentId,
          studentName: state.studentName ?? state.user.name,
          content: content.trim(),
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_ANNOUNCEMENT_REPLY", payload: { courseId, announcementId, reply } });
        return reply;
      },
      upsertTodo(courseId, todo) {
        commit({ type: "UPSERT_TODO", payload: { courseId, todo } });
      },
      completeTodo(courseId, todoId, completed) {
        const course = state.courses.find((c) => c.id === courseId);
        const todo = course?.todos?.find((item) => item.id === todoId);
        if (!todo || !state.studentId) return;
        commit({
          type: "SET_STUDENT_TODO_COMPLETION",
          payload: { courseId, todoId, studentId: state.studentId, completed },
        });
      },
      markResourceDownloaded(courseId, resourceId) {
        if (!state.studentId) return;
        commit({
          type: "MARK_RESOURCE_DOWNLOADED",
          payload: {
            courseId,
            resourceId,
            studentId: state.studentId,
            studentName: state.studentName ?? state.user.name,
          },
        });
      },
      upsertGroup(courseId, group) {
        commit({ type: "UPSERT_GROUP", payload: { courseId, group } });
      },
      createGroup(courseId, name) {
        const now = new Date().toISOString();
        const course = state.courses.find((c) => c.id === courseId);
        const inquiryQuestions = normalizePblCourseConfig(course?.pblConfig).inquiryQuestions;
        const group: ProjectGroup = {
          id: makeRecordId("group"),
          name: name || `第 ${(course?.groups?.length ?? 0) + 1} 组`,
          topic: inquiryQuestions.length === 1 ? inquiryQuestions[0] : "待确定选题方向",
          goal: "明确问题、形成可落地方案，并准备阶段性汇报。",
          keywords: ["项目研究", "真实情境", "数据驱动"],
          selectedForms: ["方案报告"],
          members: [],
          createdAt: now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_GROUP", payload: { courseId, group } });
        return group;
      },
      joinGroup(courseId, groupId, role) {
        if (!state.studentId) return;
        commit({
          type: "JOIN_GROUP",
          payload: {
            courseId,
            groupId,
            studentId: state.studentId,
            studentName: state.studentName ?? state.user.name,
            role,
          },
        });
      },
      leaveGroup(courseId, groupId) {
        if (!state.studentId) return;
        commit({ type: "LEAVE_GROUP", payload: { courseId, groupId, studentId: state.studentId } });
      },
      setGroupTopic(courseId, groupId, patch) {
        commit({
          type: "SET_GROUP_TOPIC",
          payload: {
            courseId,
            groupId,
            patch,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
      },
      upsertGroupAnnouncement(courseId, input) {
        const announcement: GroupAnnouncement = {
          id: input.id ?? makeRecordId("gann"),
          groupId: input.groupId,
          title: input.title,
          content: input.content,
          actor: input.actor ?? state.studentName ?? state.user.name,
          createdAt: new Date().toISOString(),
        };
        commit({
          type: "UPSERT_GROUP_ANNOUNCEMENT",
          payload: {
            courseId,
            announcement,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
        return announcement;
      },
      upsertWorkPlanItem(courseId, input) {
        const item: WorkPlanItem = {
          id: input.id ?? makeRecordId("task"),
          groupId: input.groupId,
          role: input.role,
          memberName: input.memberName,
          task: input.task,
          progress: input.progress,
        };
        commit({
          type: "UPSERT_WORK_PLAN_ITEM",
          payload: {
            courseId,
            item,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
        return item;
      },
      deleteWorkPlanItem(courseId, itemId) {
        commit({
          type: "DELETE_WORK_PLAN_ITEM",
          payload: {
            courseId,
            itemId,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
      },
      upsertWhiteboardNode(courseId, input) {
        const node: WhiteboardNode = {
          id: input.id ?? makeRecordId("node"),
          groupId: input.groupId,
          label: input.label,
          note: input.note,
          x: input.x,
          y: input.y,
          color: input.color,
          parentId: input.parentId,
        };
        commit({ type: "UPSERT_WHITEBOARD_NODE", payload: { courseId, node } });
        return node;
      },
      deleteWhiteboardNode(courseId, nodeId) {
        commit({ type: "DELETE_WHITEBOARD_NODE", payload: { courseId, nodeId } });
      },
      upsertGroupBoard(courseId, input) {
        const existing = state.courses.find((c) => c.id === courseId)?.boards?.find((b) => b.groupId === input.groupId);
        const board: GroupBoard = {
          groupId: input.groupId,
          snapshot: input.snapshot,
          mode: input.mode ?? existing?.mode ?? "mindmap",
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        };
        commit({ type: "UPSERT_GROUP_BOARD", payload: { courseId, board } });
      },
      upsertUpload(input) {
        const upload: CourseUpload = {
          ...input,
          createdAt: new Date().toISOString(),
        };
        commit({ type: "UPSERT_UPLOAD", payload: { courseId: upload.courseId, upload } });
        return upload;
      },
      deleteUpload(courseId, uploadId) {
        commit({ type: "DELETE_UPLOAD", payload: { courseId, uploadId } });
      },
      setPreviewUpload(courseId, uploadId) {
        commit({
          type: "SET_PREVIEW_UPLOAD",
          payload: {
            courseId,
            uploadId,
            studentId: state.user.role === "student" ? state.studentId : undefined,
          },
        });
      },
      upsertTeamContribution(input) {
        const courseId = input.courseId ?? state.joinedCourseId;
        if (!courseId) return undefined;
        const contribution: TeamContribution = {
          id: input.id ?? makeRecordId("contrib"),
          courseId,
          groupId: input.groupId,
          studentId: input.studentId ?? state.studentId,
          studentName: input.studentName,
          percent: input.percent,
          note: input.note,
          updatedAt: new Date().toISOString(),
        };
        commit({ type: "UPSERT_TEAM_CONTRIBUTION", payload: { courseId, contribution } });
        return contribution;
      },
      upsertAiSupport(input) {
        const courseId = input.courseId ?? state.joinedCourseId;
        if (!courseId) return undefined;
        const existing = state.courses.find((c) => c.id === courseId)?.aiSupports?.find((item) => item.id === input.id);
        const now = new Date().toISOString();
        const support: AiSupportRecord = {
          id: input.id ?? makeRecordId("ais"),
          courseId,
          stageKey: input.stageKey,
          targetType: input.targetType,
          targetId: input.targetId,
          groupId: input.groupId,
          studentId: input.studentId ?? state.studentId,
          studentName: input.studentName ?? state.studentName ?? state.user.name,
          kind: input.kind,
          trigger: input.trigger,
          inputSummary: input.inputSummary,
          diagnosis: input.diagnosis,
          suggestions: input.suggestions,
          evidence: input.evidence,
          status: input.status,
          source: input.source,
          editedContent: input.editedContent,
          structuredPayload: input.structuredPayload,
          adoption: input.adoption,
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_AI_SUPPORT", payload: { courseId, support } });
        return support;
      },
      addOfflineIntervention(input) {
        const intervention: OfflineInterventionRecord = {
          ...input,
          id: input.id ?? makeRecordId("offline-intervention"),
          teacherName: input.teacherName ?? state.user.name,
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_OFFLINE_INTERVENTION", payload: { courseId: input.courseId, intervention } });
        return intervention;
      },
      resolveInterventionSignals(courseId, signalIds) {
        if (!signalIds.length) return;
        commit({ type: "RESOLVE_INTERVENTION_SIGNALS", payload: { courseId, signalIds } });
      },
      upsertTeacherAgentDirective(input) {
        const existing = state.courses
          .find((course) => course.id === input.courseId)
          ?.teacherAgentDirectives?.find((directive) => directive.id === input.id);
        const now = new Date().toISOString();
        const directive: TeacherAgentDirective = {
          ...input,
          id: input.id ?? makeRecordId("teacher-directive"),
          teacherName: input.teacherName ?? state.user.name,
          createdAt: input.createdAt ?? existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_TEACHER_AGENT_DIRECTIVE", payload: { courseId: input.courseId, directive } });
        return directive;
      },
      upsertCompanionTask(input) {
        const now = new Date().toISOString();
        const courseId = input.courseId;
        const existing = state.courses
          .find((course) => course.id === courseId)
          ?.companionTasks?.find((task) => task.id === input.id);
        const task: CompanionTask = {
          ...input,
          id: input.id ?? makeRecordId("companion-task"),
          createdAt: existing?.createdAt ?? now,
          updatedAt: now,
        };
        commit({ type: "UPSERT_COMPANION_TASK", payload: { courseId, task } });
        return task;
      },
      upsertCompanionConfirmation(input) {
        const now = new Date().toISOString();
        const courseId = input.courseId;
        const existing = state.courses
          .find((course) => course.id === courseId)
          ?.companionConfirmations?.find((confirmation) => confirmation.id === input.id);
        const confirmation: CompanionConfirmation = {
          ...input,
          id: input.id ?? makeRecordId("companion-confirmation"),
          status: input.status ?? existing?.status ?? "pending",
          createdAt: existing?.createdAt ?? now,
        };
        commit({ type: "UPSERT_COMPANION_CONFIRMATION", payload: { courseId, confirmation } });
        return confirmation;
      },
      resolveCompanionConfirmation(courseId, confirmationId, status) {
        commit({
          type: "RESOLVE_COMPANION_CONFIRMATION",
          payload: {
            courseId,
            confirmationId,
            status,
            resolvedAt: new Date().toISOString(),
            studentId: state.studentId,
          },
        });
      },
      addCompanionProcessRecord(input) {
        const record: CompanionProcessRecord = {
          ...input,
          id: input.id ?? makeRecordId("companion-process"),
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_COMPANION_PROCESS_RECORD", payload: { courseId: input.courseId, record } });
        return record;
      },
      requestTeacherHelp(courseId, stageKey) {
        if (!state.studentId) return undefined;
        const course = state.courses.find((item) => item.id === courseId);
        const existing = course?.learningSignals?.find((item) =>
          item.studentId === state.studentId
          && item.stageKey === stageKey
          && item.kind === "student-help-request"
          && item.status === "open");
        if (existing) return existing;

        const now = new Date().toISOString();
        const signal: LearningSignal = {
          id: makeRecordId("student-help"),
          courseId,
          studentId: state.studentId,
          stageKey,
          kind: "student-help-request",
          severity: "warning",
          status: "open",
          title: "学生主动请求帮助",
          summary: "学生希望教师查看当前任务或证据缺口；该请求不计入学习评价。",
          normalizedIssueKey: `student-help-request:${state.studentId}:${stageKey}`,
          evidenceEventIds: [],
          aiInterventionAttempts: 0,
          firstDetectedAt: now,
          lastDetectedAt: now,
        };
        commit({ type: "REQUEST_TEACHER_HELP", payload: { courseId, signal } });
        return signal;
      },
      upsertLearningEvidence(evidence) {
        commit({
          type: "UPSERT_LEARNING_EVIDENCE",
          payload: { courseId: evidence.courseId, evidence },
        });
        return evidence;
      },
      reviewLearningEvidence(courseId, evidenceId, status, feedback) {
        commit({
          type: "REVIEW_LEARNING_EVIDENCE",
          payload: {
            courseId,
            evidenceId,
            status,
            feedback,
            reviewedAt: new Date().toISOString(),
          },
        });
      },
      upsertArtifactSnapshot(snapshot) {
        commit({
          type: "UPSERT_ARTIFACT_SNAPSHOT",
          payload: { courseId: snapshot.courseId, snapshot },
        });
        return snapshot;
      },
      upsertAiContribution(contribution) {
        commit({
          type: "UPSERT_AI_CONTRIBUTION",
          payload: { courseId: contribution.courseId, contribution },
        });
        return contribution;
      },
      recordStudentAiDecision(decision) {
        commit({
          type: "RECORD_STUDENT_AI_DECISION",
          payload: { courseId: decision.courseId, decision },
        });
        return decision;
      },
      upsertAiAssessmentSuggestion(suggestion) {
        commit({
          type: "UPSERT_AI_ASSESSMENT_SUGGESTION",
          payload: { courseId: suggestion.courseId, suggestion },
        });
        return suggestion;
      },
      setUiState(courseId, patch) {
        const action: SessionAction = {
          type: "SET_UI_STATE",
          payload: { courseId, patch },
        };
        if (projectionPatchFromAction(action)) queueProjectionAction(action);
        else void commit(action);
      },
      addActivity(courseId, action, detail, actor = state.user.name) {
        const activity: ActivityRecord = {
          id: makeRecordId("act"),
          actor,
          action,
          detail,
          createdAt: new Date().toISOString(),
        };
        commit({ type: "ADD_ACTIVITY", payload: { courseId, activity } });
      },
      setPresentingGroup(courseId, groupId) {
        commit({ type: "SET_PRESENTING_GROUP", payload: { courseId, groupId } });
      },
      getCourse(id) {
        return state.courses.find((c) => c.id === id);
      },
      findCourseByCode(code) {
        return state.courses.find(
          (c) => c.inviteCode && c.inviteCode.toUpperCase() === normalizeInviteCode(code),
        );
      },
      generateNewInviteCode(id) {
        const code = generateInviteCode(6);
        commit({
          type: "UPDATE_COURSE",
          payload: { id, patch: { inviteCode: code } },
        });
        return code;
      },
      refresh,
      connectWebSocket,
      disconnectWebSocket: disconnectRealtime,
      realtimeMode,
    };
  // The API is rebuilt for every session-state change. refresh and
  // connectWebSocket deliberately read live mutable state from refs; adding
  // their render-local identities would defeat memoization without changing
  // the exposed behavior.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state,
    saveState,
    lastSavedAt,
    saveError,
    realtimeMode,
  ]);

  return <SessionContext.Provider value={api}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionApi {
  const ctx = useContext(SessionContext);
  if (!ctx) {
    throw new Error("useSession must be used within SessionProvider");
  }
  return ctx;
}

export function useCourse(id: string | undefined): Course | undefined {
  const { courses } = useSession();
  if (!id) return undefined;
  return courses.find((c) => c.id === id);
}

export function useSessionSnapshot() {
  const { courses, user, hydrated, joinedCourseId, studentName } = useSession();
  return { courses, user, hydrated, joinedCourseId, studentName };
}

export function useHydrated(): boolean {
  return useSession().hydrated;
}

function defaultTodos(): CourseTodo[] {
  // CourseTodo.id 是全局主键（@id），不能跨课程重复。
  // 使用 makeRecordId 生成唯一 ID，避免创建第二个课程时触发 P2002 唯一约束冲突。
  return [
    {
      id: makeRecordId("todo-read-brief"),
      title: "阅读项目说明",
      description: "了解项目背景、目标与成果要求。",
      stageKey: "launch",
      completedBy: [],
    },
    {
      id: makeRecordId("todo-pick-direction"),
      title: "选择研究主题",
      description: "从本节课程主题中选择你希望深入研究的方向。",
      stageKey: "launch",
      completedBy: [],
    },
  ];
}
