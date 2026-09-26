import { mergeReflectionForCourse } from "@/lib/course-reflection";
import { courseEvaluationPlan, normalizeCourseRubricScore } from "@/lib/evaluation/course-rubric";
import type {
  ActivityRecord,
  AiSupportRecord,
  AiAssessmentSuggestion,
  AiContribution,
  ArtifactSnapshot,
  ClassConfig,
  ClassroomSubmission,
  CompanionConfirmation,
  CompanionProcessRecord,
  CompanionTask,
  Course,
  CourseAnnouncement,
  CourseContent,
  CourseStatus,
  CourseTodo,
  CourseUiState,
  CourseUpload,
  GroupAnnouncement,
  GroupBoard,
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
  LearningEvidence,
  LearningSignal,
} from "./types";
import { getStageWorkspacePolicy } from "@/lib/classroom/stage-workspace-policy";
import {
  getStagesForSystemMode,
  inferStageCollectionMode,
  mapStageKeyToSystemMode,
  reconcileCourseGenerationMode,
} from "@/lib/system-mode";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import { normalizeReflectionContent } from "@/lib/reflection-survey";
import { OPERATIONAL_SIGNAL_RETENTION_DAYS } from "@/lib/learning-evidence/types";
import {
  completeClassroomTiming,
  createClassroomTimingState,
  resolveCourseTimingMinutes,
  reconcileClassroomTimingState,
  transitionClassroomStageTiming,
} from "@/lib/classroom/timing";

export type SessionState = {
  courses: Course[];
  joinedCourseId?: string;
  user: { role: "teacher" | "student"; name: string };
  studentId?: string;
  studentName?: string;
  hydrated: boolean;
  updatedAt?: string;
};

export type SessionAction =
  | { type: "HYDRATE"; payload: SessionState }
  | { type: "SET_USER"; payload: SessionState["user"] }
  | { type: "CREATE_COURSE"; payload: Course }
  | { type: "UPDATE_COURSE"; payload: { id: string; patch: Partial<Course> } }
  | { type: "DELETE_COURSE"; payload: { id: string } }
  | { type: "SET_COURSE_CONTENT"; payload: { id: string; content: CourseContent } }
  | { type: "SET_COURSE_STAGES"; payload: { id: string; stages: Stage[] } }
  | { type: "PUBLISH_COURSE"; payload: { id: string } }
  | {
      type: "START_TEACHING";
      payload: { id: string; classConfig: ClassConfig; inviteCode: string };
    }
  | { type: "END_TEACHING"; payload: { id: string } }
  | {
      type: "RESTART_TEACHING";
      payload: { id: string; newInviteCode: string; classConfig?: ClassConfig };
    }
  | { type: "ADVANCE_STAGE"; payload: { id: string; direction: 1 | -1 } }
  | { type: "SET_STAGE"; payload: { id: string; index: number } }
  | { type: "JOIN_CLASS"; payload: { courseId: string; student: Student } }
  | { type: "LEAVE_CLASS"; payload: { courseId: string; studentId: string } }
  | { type: "HEARTBEAT"; payload: { courseId: string; studentId: string; lastSeenAt: string } }
  | { type: "MARK_STUDENTS_OFFLINE"; payload: { courseId: string; studentIds: string[] } }
  | {
      type: "UPDATE_STUDENT_PROGRESS";
      payload: { courseId: string; studentId: string; stageKey: string; value: number };
    }
  | { type: "UPSERT_SUBMISSION"; payload: { courseId: string; submission: ClassroomSubmission; expectedSubmissionVersion?: number } }
  | { type: "ADD_FEEDBACK"; payload: { courseId: string; feedback: TeacherFeedback } }
  | { type: "UPSERT_RUBRIC_SCORE"; payload: { courseId: string; score: RubricScore } }
  | { type: "UPSERT_REFLECTION"; payload: { courseId: string; reflection: ReflectionRecord } }
  | { type: "ADD_ACTIVITY"; payload: { courseId: string; activity: ActivityRecord } }
  | { type: "SET_PRESENTING_GROUP"; payload: { courseId: string; groupId: string } }
  | { type: "UPSERT_ANNOUNCEMENT"; payload: { courseId: string; announcement: CourseAnnouncement } }
  | { type: "DELETE_ANNOUNCEMENT"; payload: { courseId: string; announcementId: string } }
  | {
      type: "ADD_ANNOUNCEMENT_REPLY";
      payload: { courseId: string; announcementId: string; reply: CourseAnnouncement["replies"][number] };
    }
  | { type: "UPSERT_TODO"; payload: { courseId: string; todo: CourseTodo } }
  | { type: "SET_STUDENT_TODO_COMPLETION"; payload: { courseId: string; todoId: string; studentId: string; completed: boolean } }
  | {
      type: "MARK_RESOURCE_DOWNLOADED";
      payload: { courseId: string; resourceId: string; studentId: string; studentName: string };
    }
  | { type: "UPSERT_GROUP"; payload: { courseId: string; group: ProjectGroup } }
  | {
      type: "JOIN_GROUP";
      payload: {
        courseId: string;
        groupId: string;
        studentId: string;
        studentName: string;
        role?: string;
      };
    }
  | { type: "LEAVE_GROUP"; payload: { courseId: string; groupId: string; studentId: string } }
  | { type: "SET_GROUP_TOPIC"; payload: { courseId: string; groupId: string; patch: Partial<ProjectGroup>; studentId?: string } }
  | {
      type: "UPSERT_GROUP_ANNOUNCEMENT";
      payload: { courseId: string; announcement: GroupAnnouncement; studentId?: string };
    }
  | { type: "UPSERT_WORK_PLAN_ITEM"; payload: { courseId: string; item: WorkPlanItem; studentId?: string } }
  | { type: "DELETE_WORK_PLAN_ITEM"; payload: { courseId: string; itemId: string; studentId?: string } }
  | { type: "UPSERT_WHITEBOARD_NODE"; payload: { courseId: string; node: WhiteboardNode } }
  | { type: "DELETE_WHITEBOARD_NODE"; payload: { courseId: string; nodeId: string } }
  | { type: "UPSERT_GROUP_BOARD"; payload: { courseId: string; board: GroupBoard } }
  | { type: "UPSERT_UPLOAD"; payload: { courseId: string; upload: CourseUpload } }
  | { type: "DELETE_UPLOAD"; payload: { courseId: string; uploadId: string } }
  | { type: "SET_PREVIEW_UPLOAD"; payload: { courseId: string; uploadId?: string; studentId?: string } }
  | { type: "UPSERT_TEAM_CONTRIBUTION"; payload: { courseId: string; contribution: TeamContribution } }
  | { type: "UPSERT_AI_SUPPORT"; payload: { courseId: string; support: AiSupportRecord } }
  | { type: "ADD_OFFLINE_INTERVENTION"; payload: { courseId: string; intervention: OfflineInterventionRecord } }
  | { type: "RESOLVE_INTERVENTION_SIGNALS"; payload: { courseId: string; signalIds: string[] } }
  | { type: "UPSERT_TEACHER_AGENT_DIRECTIVE"; payload: { courseId: string; directive: TeacherAgentDirective } }
  | { type: "UPSERT_COMPANION_TASK"; payload: { courseId: string; task: CompanionTask } }
  | { type: "UPSERT_COMPANION_CONFIRMATION"; payload: { courseId: string; confirmation: CompanionConfirmation } }
  | { type: "RESOLVE_COMPANION_CONFIRMATION"; payload: { courseId: string; confirmationId: string; status: CompanionConfirmation["status"]; resolvedAt: string; studentId?: string } }
  | { type: "ADD_COMPANION_PROCESS_RECORD"; payload: { courseId: string; record: CompanionProcessRecord } }
  | { type: "REQUEST_TEACHER_HELP"; payload: { courseId: string; signal: LearningSignal } }
  | { type: "UPSERT_LEARNING_EVIDENCE"; payload: { courseId: string; evidence: LearningEvidence } }
  | { type: "REVIEW_LEARNING_EVIDENCE"; payload: { courseId: string; evidenceId: string; status: "teacher-confirmed" | "needs-revision"; feedback?: string; reviewedAt: string } }
  | { type: "UPSERT_ARTIFACT_SNAPSHOT"; payload: { courseId: string; snapshot: ArtifactSnapshot } }
  | { type: "UPSERT_AI_CONTRIBUTION"; payload: { courseId: string; contribution: AiContribution } }
  | { type: "RECORD_STUDENT_AI_DECISION"; payload: { courseId: string; decision: StudentAiDecision } }
  | { type: "UPSERT_AI_ASSESSMENT_SUGGESTION"; payload: { courseId: string; suggestion: AiAssessmentSuggestion } }
  | { type: "SET_UI_STATE"; payload: { courseId: string; patch: Partial<CourseUiState>; projectionControl?: { clientId: string; takeover?: boolean } } };

export function initialSessionState(): SessionState {
  return {
    courses: [],
    user: { role: "teacher", name: "教师" },
    hydrated: false,
  };
}

export function applySessionAction(
  state: SessionState,
  action: SessionAction,
): SessionState {
  const touchedAt = new Date().toISOString();
  switch (action.type) {
    case "HYDRATE":
      return { ...action.payload, courses: action.payload.courses.map(normalizeCourse), hydrated: true };
    case "SET_USER":
      return { ...state, user: action.payload, updatedAt: touchedAt };
    case "CREATE_COURSE":
      return {
        ...state,
        courses: [normalizeCourse(action.payload), ...state.courses],
        updatedAt: touchedAt,
      };
    case "UPDATE_COURSE": {
      const { id, patch } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === id ? normalizeCourse({ ...c, ...patch, updatedAt: touchedAt }) : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "DELETE_COURSE":
      return {
        ...state,
        courses: state.courses.filter((c) => c.id !== action.payload.id),
        updatedAt: touchedAt,
      };
    case "SET_COURSE_CONTENT": {
      const { id, content } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === id
            ? normalizeCourse({
                ...c,
                content,
                status: c.status === "draft" ? ("preparing" as CourseStatus) : c.status,
                updatedAt: touchedAt,
              })
            : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "SET_COURSE_STAGES": {
      const { id, stages } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === id
            ? normalizeCourse({
                ...c,
                stages,
                currentStageIndex: Math.min(c.currentStageIndex, stages.length - 1),
                updatedAt: touchedAt,
              })
            : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "PUBLISH_COURSE":
      return updateCourse(state, action.payload.id, {
        status: "ready",
        updatedAt: touchedAt,
      });
    case "START_TEACHING": {
      const { id, classConfig, inviteCode } = action.payload;
      const course = state.courses.find((item) => item.id === id);
      const classroomTiming = course
        ? createClassroomTimingState({
            stages: course.stages,
            totalMinutes: resolveCourseTimingMinutes(course),
            projectMainline: course.content.projectMainline,
            moduleTimingPlan: course.content.moduleTimingPlan,
            stagePlan: course.content.stagePlan,
            activeStageKey: course.stages[0]?.key,
            now: touchedAt,
          })
        : undefined;
      return updateCourse(state, id, {
        status: "teaching",
        classConfig,
        inviteCode,
        currentStageIndex: 0,
        presentingStudentId: undefined,
        uiState: {
          ...(course?.uiState ?? {}),
          teacherResourceProjection: null,
          resourceProjection: null,
          showcaseReporting: undefined,
          ...(classroomTiming ? { classroomTiming } : {}),
        },
        // A new class starts with no project spaces. Each student receives one
        // private personal-project space when joining; no real student grouping occurs.
        groups: [],
        workPlan: [],
        whiteboard: [],
        groupAnnouncements: [],
        updatedAt: touchedAt,
      });
    }
    case "END_TEACHING": {
      const course = state.courses.find((item) => item.id === action.payload.id);
      const classroomTiming = course?.uiState?.classroomTiming
        ? completeClassroomTiming(course.uiState.classroomTiming, touchedAt)
        : undefined;
      return updateCourse(state, action.payload.id, {
        status: "finished",
        presentingStudentId: undefined,
        uiState: {
          ...(course?.uiState ?? {}),
          teacherResourceProjection: null,
          resourceProjection: null,
          ...(classroomTiming ? { classroomTiming } : {}),
        },
        updatedAt: touchedAt,
      });
    }
    case "RESTART_TEACHING": {
      const { id, newInviteCode, classConfig } = action.payload;
      const course = state.courses.find((item) => item.id === id);
      if (!course) return state;
      const classroomTiming = createClassroomTimingState({
        stages: course.stages,
        totalMinutes: resolveCourseTimingMinutes(course),
        projectMainline: course.content.projectMainline,
        moduleTimingPlan: course.content.moduleTimingPlan,
        stagePlan: course.content.stagePlan,
        activeStageKey: course.stages[0]?.key,
        now: touchedAt,
      });
      return updateCourse(state, id, {
        status: "teaching",
        inviteCode: newInviteCode,
        currentStageIndex: 0,
        presentingGroupId: undefined,
        presentingStudentId: undefined,
        // Clear classroom data. In DB mode, archiveAndClearCourseSession has
        // already cleared child tables; this reducer keeps the in-memory state
        // consistent and handles JSON-file (demo) mode where no archiving runs.
        students: [],
        submissions: [],
        feedback: [],
        rubricScores: [],
        reflections: [],
        activityLog: [],
        groups: [],
        groupAnnouncements: [],
        workPlan: [],
        whiteboard: [],
        boards: [],
        uploads: [],
        teamContributions: [],
        aiSupports: [],
        teacherInterventions: [],
        resolvedInterventionSignalIds: [],
        stageTransitions: [],
        evaluations: [],
        learningEvents: [],
        companionThreads: [],
        companionTasks: [],
        companionConfirmations: [],
        companionProcessRecords: [],
        learningSignals: [],
        classCommonIssues: [],
        teacherAgentDirectives: [],
        offlineInterventions: [],
        dynamicFacilitationScaffolds: [],
        aiLearningProgress: undefined,
        uiState: {
          ...(course.uiState ?? {}),
          teacherResourceProjection: null,
          resourceProjection: null,
          showcaseReporting: undefined,
          classroomTiming,
        },
        // Preserve course resources: content, stages, pblConfig,
        // stageWorkspacePolicies, coverImageUrl, etc.
        ...(classConfig ? { classConfig } : {}),
        updatedAt: touchedAt,
      });
    }
    case "ADVANCE_STAGE": {
      const { id, direction } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) => {
          if (c.id !== id) return c;
          const next = Math.max(0, Math.min(c.stages.length - 1, c.currentStageIndex + direction));
          const classroomTiming =
            next !== c.currentStageIndex && c.uiState?.classroomTiming
              ? transitionClassroomStageTiming(
                  c.uiState.classroomTiming,
                  c.stages[next]!.key,
                  touchedAt,
              )
              : c.uiState?.classroomTiming;
          const presenterPatch = inferStageCollectionMode(c.stages) === "new"
            ? (c.stages[next]?.key === "showcase"
              ? {}
              : { presentingGroupId: undefined, presentingStudentId: undefined })
            : { presentingStudentId: undefined };
          return normalizeCourse({
            ...c,
            currentStageIndex: next,
            ...presenterPatch,
            uiState:
              next === c.currentStageIndex
                ? c.uiState
                : {
                    ...(c.uiState ?? {}),
                    teacherResourceProjection: null,
                    resourceProjection: null,
                    ...(classroomTiming ? { classroomTiming } : {}),
                  },
            updatedAt: touchedAt,
          });
        }),
        updatedAt: touchedAt,
      };
    }
    case "SET_STAGE": {
      const { id, index } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) => {
          if (c.id !== id) return c;
          const next = Math.max(0, Math.min(c.stages.length - 1, index));
          const classroomTiming =
            next !== c.currentStageIndex && c.uiState?.classroomTiming
              ? transitionClassroomStageTiming(
                  c.uiState.classroomTiming,
                  c.stages[next]!.key,
                  touchedAt,
              )
              : c.uiState?.classroomTiming;
          const presenterPatch = inferStageCollectionMode(c.stages) === "new"
            ? (c.stages[next]?.key === "showcase"
              ? {}
              : { presentingGroupId: undefined, presentingStudentId: undefined })
            : { presentingStudentId: undefined };
          return normalizeCourse({
            ...c,
            currentStageIndex: next,
            ...presenterPatch,
            uiState:
              next === c.currentStageIndex
                ? c.uiState
                : {
                    ...(c.uiState ?? {}),
                    teacherResourceProjection: null,
                    resourceProjection: null,
                    ...(classroomTiming ? { classroomTiming } : {}),
                  },
            updatedAt: touchedAt,
          });
        }),
        updatedAt: touchedAt,
      };
    }
    case "JOIN_CLASS": {
      const { courseId, student } = action.payload;
      return {
        ...state,
        joinedCourseId: courseId,
        studentId: student.id,
        studentName: student.name,
        courses: state.courses.map((c) => {
          if (c.id !== courseId) return c;
          // Keep the legacy ProjectGroup container only as the storage key for
          // one student's private project. It is never presented as a group.
          const alreadyInGroup = (c.groups ?? []).some((g) =>
            g.members.some((m) => m.studentId === student.id),
          );
          const inquiryQuestions = normalizePblCourseConfig(c.pblConfig).inquiryQuestions;
          const initialTopic =
            inquiryQuestions.length === 1
              ? inquiryQuestions[0]
              : "待确定选题方向";
          const groups = !alreadyInGroup
            ? [
                ...(c.groups ?? []),
                {
                  id: `grp-${student.id}`,
                  name: `${student.name}的个人项目`,
                  topic: initialTopic,
                  goal: "",
                  keywords: [],
                  selectedForms: [],
                  members: [{ studentId: student.id, name: student.name, role: "项目负责人" }],
                  createdAt: touchedAt,
                  updatedAt: touchedAt,
                },
              ]
            : c.groups;
          return normalizeCourse({
            ...c,
            students: dedupeStudents([...c.students, student]),
            groups,
            activityLog: addActivity(c.activityLog, activity(student.name, "加入课堂", "通过邀请码进入课堂", touchedAt)),
            updatedAt: touchedAt,
          });
        }),
        updatedAt: touchedAt,
      };
    }
    case "LEAVE_CLASS": {
      const { courseId, studentId } = action.payload;
      return {
        ...state,
        joinedCourseId: state.joinedCourseId === courseId ? undefined : state.joinedCourseId,
        studentId: state.studentId === studentId ? undefined : state.studentId,
        studentName: state.studentId === studentId ? undefined : state.studentName,
        courses: state.courses.map((c) =>
          c.id === courseId
            ? normalizeCourse({
                ...c,
                students: c.students.filter((s) => s.id !== studentId),
                groups: (c.groups ?? []).map((g) => ({
                  ...g,
                  members: g.members.filter((m) => m.studentId !== studentId),
                })),
                updatedAt: touchedAt,
              })
            : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "HEARTBEAT": {
      const { courseId, studentId, lastSeenAt } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === courseId
            ? normalizeCourse({
                ...c,
                students: c.students.map((s) =>
                  s.id === studentId ? { ...s, lastSeenAt } : s,
                ),
                updatedAt: touchedAt,
              })
            : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "MARK_STUDENTS_OFFLINE": {
      const { courseId, studentIds } = action.payload;
      if (studentIds.length === 0) return state;
      const idSet = new Set(studentIds);
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === courseId
            ? normalizeCourse({
                ...c,
                students: c.students.map((s) =>
                  idSet.has(s.id) ? { ...s, lastSeenAt: undefined } : s,
                ),
                updatedAt: touchedAt,
              })
            : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "UPDATE_STUDENT_PROGRESS": {
      const { courseId, studentId, stageKey, value } = action.payload;
      return {
        ...state,
        courses: state.courses.map((c) =>
          c.id === courseId
            ? normalizeCourse({
                ...c,
                students: c.students.map((s) =>
                  s.id === studentId
                    ? { ...s, stageProgress: { ...s.stageProgress, [stageKey]: value } }
                    : s,
                ),
                updatedAt: touchedAt,
              })
            : c,
        ),
        updatedAt: touchedAt,
      };
    }
    case "UPSERT_SUBMISSION": {
      const { courseId, submission } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        submissions: upsertById(c.submissions ?? [], submission),
        activityLog: addActivity(c.activityLog, activity(submission.studentName || "学生", `提交 ${submission.title}`, submission.content.slice(0, 60), touchedAt)),
      }));
    }
    case "ADD_FEEDBACK": {
      const { courseId, feedback } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        feedback: [feedback, ...(c.feedback ?? [])],
        activityLog: addActivity(c.activityLog, activity("教师", "发布反馈", feedback.content.slice(0, 60), touchedAt)),
      }));
    }
    case "UPSERT_RUBRIC_SCORE": {
      const { courseId, score } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => {
        const normalizedScore = normalizeCourseRubricScore(c, score);
        return {
          rubricScores: upsertById(c.rubricScores ?? [], normalizedScore),
          activityLog: addActivity(c.activityLog, activity("教师", "提交评分", `${score.groupId}：${normalizedScore.total} 分`, touchedAt)),
        };
      });
    }
    case "UPSERT_REFLECTION": {
      const { courseId, reflection: submittedReflection } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => {
        const reflection = mergeReflectionForCourse(c, submittedReflection);
        const currentReflections = c.reflections ?? [];
        const existingStructured = reflection.survey
          ? [...currentReflections]
            .filter((item) => item.studentId === reflection.studentId && item.survey)
            .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0]
          : undefined;
        const persistedReflection = existingStructured && existingStructured.id !== reflection.id
          ? {
              ...reflection,
              id: existingStructured.id,
              createdAt: existingStructured.createdAt,
            }
          : reflection;
        const dedupedReflections = reflection.survey
          ? currentReflections.filter((item) => !(
              item.studentId === reflection.studentId
              && item.survey
              && item.id !== persistedReflection.id
            ))
          : currentReflections;
        return {
          reflections: upsertById(dedupedReflections, persistedReflection),
          activityLog: addActivity(c.activityLog, activity(reflection.studentName, "保存反思", reflection.content.slice(0, 60), touchedAt)),
        };
      });
    }
    case "ADD_ACTIVITY": {
      const { courseId, activity: nextActivity } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        activityLog: addActivity(c.activityLog, nextActivity),
      }));
    }
    case "SET_PRESENTING_GROUP":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (course) => {
        const project = course.groups?.find((group) => group.id === action.payload.groupId);
        return {
          presentingGroupId: action.payload.groupId,
          presentingStudentId: undefined,
          activityLog: addActivity(
            course.activityLog,
            activity("教师", "切换当前个人汇报", project?.name ?? action.payload.groupId, touchedAt),
          ),
        };
      });
    case "UPSERT_ANNOUNCEMENT": {
      const { courseId, announcement } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        announcements: upsertById(c.announcements ?? [], announcement),
        activityLog: addActivity(c.activityLog, activity("教师", "发布课堂公告", announcement.title, touchedAt)),
      }));
    }
    case "DELETE_ANNOUNCEMENT":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        announcements: (c.announcements ?? []).filter((a) => a.id !== action.payload.announcementId),
      }));
    case "ADD_ANNOUNCEMENT_REPLY": {
      const { courseId, announcementId, reply } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        announcements: (c.announcements ?? []).map((a) =>
          a.id === announcementId ? { ...a, replies: [reply, ...a.replies], updatedAt: touchedAt } : a,
        ),
        activityLog: addActivity(c.activityLog, activity(reply.studentName, "回复公告", reply.content.slice(0, 60), touchedAt)),
      }));
    }
    case "UPSERT_TODO":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        todos: upsertById(c.todos ?? [], action.payload.todo),
      }));
    case "SET_STUDENT_TODO_COMPLETION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => {
        const todos = (c.todos ?? []).map((todo) => {
          if (todo.id !== action.payload.todoId) return todo;
          const completedBy = new Set(todo.completedBy);
          if (action.payload.completed) completedBy.add(action.payload.studentId);
          else completedBy.delete(action.payload.studentId);
          return { ...todo, completedBy: Array.from(completedBy) };
        });
        return { todos };
      });
    case "MARK_RESOURCE_DOWNLOADED": {
      const { courseId, resourceId, studentId, studentName } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        resources: (c.resources ?? []).map((r) =>
          r.id === resourceId
            ? { ...r, downloadedBy: Array.from(new Set([...(r.downloadedBy ?? []), studentId])) }
            : r,
        ),
        activityLog: addActivity(c.activityLog, activity(studentName, "下载资源", resourceId, touchedAt)),
      }));
    }
    case "UPSERT_GROUP": {
      const { courseId, group } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        groups: upsertById(c.groups ?? [], group),
        activityLog: addActivity(c.activityLog, activity("教师", "更新分组", group.name, touchedAt)),
      }));
    }
    case "JOIN_GROUP": {
      const { courseId, groupId, studentId, studentName, role } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        groups: (c.groups ?? []).map((g) => {
          const members = g.members.filter((m) => m.studentId !== studentId);
          if (g.id !== groupId) return { ...g, members };
          return {
            ...g,
            members: upsertMember(members, { studentId, name: studentName, role }),
            updatedAt: touchedAt,
          };
        }),
        activityLog: addActivity(c.activityLog, activity(studentName, "加入小组", groupId, touchedAt)),
      }));
    }
    case "LEAVE_GROUP":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        groups: (c.groups ?? []).map((g) =>
          g.id === action.payload.groupId
            ? { ...g, members: g.members.filter((m) => m.studentId !== action.payload.studentId), updatedAt: touchedAt }
            : g,
        ),
      }));
    case "SET_GROUP_TOPIC": {
      const { courseId, groupId, patch, studentId } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => ({
        groups: (c.groups ?? []).map((g) =>
          g.id === groupId && (!studentId || g.members.some((member) => member.studentId === studentId))
            ? { ...g, ...patch, updatedAt: touchedAt }
            : g,
        ),
        activityLog: addActivity(c.activityLog, activity("小组", "更新选题方向", patch.topic ?? patch.goal ?? "已更新小组选题", touchedAt)),
      }));
    }
    case "UPSERT_GROUP_ANNOUNCEMENT":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        groupAnnouncements: upsertById(c.groupAnnouncements ?? [], action.payload.announcement),
        activityLog: addActivity(c.activityLog, activity(action.payload.announcement.actor, "发布组内公告", action.payload.announcement.title, touchedAt)),
      }));
    case "UPSERT_WORK_PLAN_ITEM":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        workPlan: upsertById(c.workPlan ?? [], action.payload.item),
      }));
    case "DELETE_WORK_PLAN_ITEM":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        workPlan: (c.workPlan ?? []).filter((item) => item.id !== action.payload.itemId),
      }));
    case "UPSERT_WHITEBOARD_NODE":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        whiteboard: upsertById(c.whiteboard ?? [], action.payload.node),
      }));
    case "DELETE_WHITEBOARD_NODE":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        whiteboard: (c.whiteboard ?? []).filter((node) => node.id !== action.payload.nodeId),
      }));
    case "UPSERT_GROUP_BOARD": {
      const { courseId, board } = action.payload;
      return updateCourseRecord(state, courseId, touchedAt, (c) => {
        const existing = c.boards ?? [];
        const next = existing.some((b) => b.groupId === board.groupId)
          ? existing.map((b) => (b.groupId === board.groupId ? board : b))
          : [...existing, board];
        return { boards: next };
      });
    }
    case "UPSERT_UPLOAD":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        uploads: upsertById(c.uploads ?? [], action.payload.upload),
        activityLog: addActivity(c.activityLog, activity(action.payload.upload.studentName || "学生", "上传文件", action.payload.upload.title, touchedAt)),
      }));
    case "DELETE_UPLOAD":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        uploads: (c.uploads ?? []).filter((u) => u.id !== action.payload.uploadId),
        uiState: c.uiState?.previewUploadId === action.payload.uploadId ? { ...c.uiState, previewUploadId: undefined } : c.uiState,
      }));
    case "SET_PREVIEW_UPLOAD":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        uiState: { ...(c.uiState ?? {}), previewUploadId: action.payload.uploadId },
      }));
    case "UPSERT_TEAM_CONTRIBUTION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        teamContributions: upsertById(c.teamContributions ?? [], action.payload.contribution),
      }));
    case "UPSERT_AI_SUPPORT": {
      const { support } = action.payload;
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        aiSupports: upsertById(c.aiSupports ?? [], support),
        activityLog: addActivity(
          c.activityLog,
          activity(
            support.studentName ?? support.groupId ?? "AI助教",
            `AI支架：${support.trigger}`,
            support.diagnosis.slice(0, 80),
            touchedAt,
          ),
        ),
      }));
    }
    case "ADD_OFFLINE_INTERVENTION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        offlineInterventions: [action.payload.intervention, ...(c.offlineInterventions ?? [])],
      }));
    case "RESOLVE_INTERVENTION_SIGNALS": {
      const resolvedIds = new Set(action.payload.signalIds);
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        resolvedInterventionSignalIds: [
          ...new Set([...(c.resolvedInterventionSignalIds ?? []), ...action.payload.signalIds]),
        ],
        learningSignals: (c.learningSignals ?? []).map((signal) =>
          resolvedIds.has(signal.id)
            ? { ...signal, status: "resolved", resolvedAt: touchedAt, handledAt: signal.handledAt ?? touchedAt }
            : signal,
        ),
        classCommonIssues: (c.classCommonIssues ?? []).map((issue) =>
          issue.signalIds.length > 0 && issue.signalIds.every((id) => resolvedIds.has(id))
            ? { ...issue, status: "resolved", resolvedAt: touchedAt, lastDetectedAt: touchedAt }
            : issue,
        ),
        teacherInterventions: (c.teacherInterventions ?? []).map((intervention) =>
          intervention.signalId && resolvedIds.has(intervention.signalId)
            ? { ...intervention, status: "resolved", resolvedAt: touchedAt }
            : intervention,
        ),
      }));
    }
    case "UPSERT_TEACHER_AGENT_DIRECTIVE":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        teacherAgentDirectives: upsertById(c.teacherAgentDirectives ?? [], action.payload.directive),
      }));
    case "UPSERT_COMPANION_TASK":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        companionTasks: upsertById(c.companionTasks ?? [], action.payload.task),
      }));
    case "UPSERT_COMPANION_CONFIRMATION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        companionConfirmations: upsertById(c.companionConfirmations ?? [], action.payload.confirmation),
      }));
    case "RESOLVE_COMPANION_CONFIRMATION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        companionConfirmations: (c.companionConfirmations ?? []).map((confirmation) =>
          confirmation.id === action.payload.confirmationId
            ? { ...confirmation, status: action.payload.status, resolvedAt: action.payload.resolvedAt }
            : confirmation,
        ),
      }));
    case "ADD_COMPANION_PROCESS_RECORD":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        companionProcessRecords: [action.payload.record, ...(c.companionProcessRecords ?? [])].slice(0, 160),
      }));
    case "REQUEST_TEACHER_HELP":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        learningSignals: upsertById(c.learningSignals ?? [], action.payload.signal),
      }));
    case "UPSERT_LEARNING_EVIDENCE":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        learningEvidence: upsertById(c.learningEvidence ?? [], action.payload.evidence),
      }));
    case "REVIEW_LEARNING_EVIDENCE":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        learningEvidence: (c.learningEvidence ?? []).map((item) =>
          item.id === action.payload.evidenceId
            ? {
                ...item,
                status: action.payload.status,
                teacherFeedback: action.payload.feedback?.trim() || undefined,
                confirmedAt:
                  action.payload.status === "teacher-confirmed"
                    ? action.payload.reviewedAt
                    : undefined,
                updatedAt: action.payload.reviewedAt,
              }
            : item,
        ),
      }));
    case "UPSERT_ARTIFACT_SNAPSHOT":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        artifactSnapshots: upsertById(c.artifactSnapshots ?? [], action.payload.snapshot),
      }));
    case "UPSERT_AI_CONTRIBUTION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        aiContributions: upsertById(c.aiContributions ?? [], action.payload.contribution),
      }));
    case "RECORD_STUDENT_AI_DECISION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        studentAiDecisions: upsertById(c.studentAiDecisions ?? [], action.payload.decision),
        aiContributions: (c.aiContributions ?? []).map((item) =>
          item.id === action.payload.decision.contributionId
            ? { ...item, status: "decided" as const }
            : item,
        ),
      }));
    case "UPSERT_AI_ASSESSMENT_SUGGESTION":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        aiAssessmentSuggestions: upsertById(
          c.aiAssessmentSuggestions ?? [],
          action.payload.suggestion,
        ),
      }));
    case "SET_UI_STATE":
      return updateCourseRecord(state, action.payload.courseId, touchedAt, (c) => ({
        uiState: { ...(c.uiState ?? {}), ...action.payload.patch },
      }));
    default:
      return state;
  }
}

export function makeRecordId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function updateCourse(
  state: SessionState,
  id: string,
  patch: Partial<Course>,
): SessionState {
  return {
    ...state,
    courses: state.courses.map((c) => (c.id === id ? normalizeCourse({ ...c, ...patch }) : c)),
    updatedAt: new Date().toISOString(),
  };
}

function updateCourseRecord(
  state: SessionState,
  id: string,
  touchedAt: string,
  derivePatch: (course: Course) => Partial<Course>,
): SessionState {
  return {
    ...state,
    courses: state.courses.map((c) =>
      c.id === id
        ? normalizeCourse({
            ...c,
            ...derivePatch(normalizeCourse(c)),
            updatedAt: touchedAt,
          })
        : c,
    ),
    updatedAt: touchedAt,
  };
}

function dedupeStudents(list: Student[]): Student[] {
  // Dedupe by id, and also by name (case-insensitive) as a safety net.
  // When a student with the same name joins again, we keep the existing
  // account and merge the new record into it (preserving stageProgress etc.).
  const map = new Map<string, Student>();
  for (const s of list) {
    const key = s.id;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, s);
    } else {
      // Merge: prefer the newer lastSeenAt and keep existing stageProgress.
      map.set(key, {
        ...existing,
        ...s,
        stageProgress: { ...existing.stageProgress, ...s.stageProgress },
        lastSeenAt: s.lastSeenAt ?? existing.lastSeenAt,
      });
    }
  }
  return Array.from(map.values());
}

function upsertById<T extends { id: string }>(list: T[], item: T): T[] {
  const exists = list.some((entry) => entry.id === item.id);
  return exists ? list.map((entry) => (entry.id === item.id ? item : entry)) : [item, ...list];
}

function upsertMember<T extends { studentId: string }>(list: T[], item: T): T[] {
  const exists = list.some((entry) => entry.studentId === item.studentId);
  return exists
    ? list.map((entry) => (entry.studentId === item.studentId ? item : entry))
    : [...list, item];
}

function addActivity(
  list: ActivityRecord[] | undefined,
  item: ActivityRecord,
): ActivityRecord[] {
  return [item, ...(list ?? [])].slice(0, 120);
}

function activity(actor: string, action: string, detail: string | undefined, createdAt: string): ActivityRecord {
  return {
    id: makeRecordId("act"),
    actor,
    action,
    detail,
    createdAt,
  };
}

export function normalizeCourse(course: Course): Course {
  const observedStageKey = course.stages?.[course.currentStageIndex]?.key;
  const stages = getStagesForSystemMode();
  const currentStageIndex = Math.max(
    0,
    stages.findIndex((stage) => stage.key === mapStageKeyToSystemMode(observedStageKey)),
  );
  const existingPersonalProjects = course.groups ?? [];
  const personalProjects = (course.students ?? []).map((student) => {
    const exactProject = existingPersonalProjects.find(
      (project) =>
        project.id === `grp-${student.id}`
        && project.members.length === 1
        && project.members[0]?.studentId === student.id,
    );
    const now = course.updatedAt || new Date().toISOString();
    return {
      ...(exactProject ?? {
        id: `grp-${student.id}`,
        topic: "待确定选题方向",
        goal: "",
        keywords: [],
        selectedForms: [],
        createdAt: now,
        updatedAt: now,
      }),
      id: `grp-${student.id}`,
      name: `${student.name}的个人项目`,
      members: [{ studentId: student.id, name: student.name, role: "项目负责人" }],
    };
  });
  const normalized: Course = {
    ...course,
    pblConfig: normalizePblCourseConfig(course.pblConfig),
    stageWorkspacePolicies: {
      ...(course.stageWorkspacePolicies ?? {}),
      ...Object.fromEntries(
        stages.map((stage) => [
          stage.key,
          getStageWorkspacePolicy(course.stageWorkspacePolicies, stage.key),
        ]),
      ),
    },
    stages,
    currentStageIndex,
    classConfig: course.classConfig
      ? { ...course.classConfig, groupMode: "solo", perGroup: 1, crossClass: false }
      : course.classConfig,
    students: course.students ?? [],
    submissions: course.submissions ?? [],
    feedback: (course.feedback ?? []).map((item) => ({
      sourceRole: "teacher" as const,
      evidence: [],
      status: "open" as const,
      ...item,
    })),
    rubricScores: course.rubricScores ?? [],
    // Demo-mode session JSON can contain the same historical reflection
    // payloads as the database (raw string, legacy object, or survey wrapper).
    // Normalize at the aggregate boundary so both stores expose one domain
    // shape to the student and teacher views.
    reflections: (course.reflections ?? []).map((reflection) => {
      const normalized = normalizeReflectionContent(
        (reflection as unknown as { content?: unknown }).content,
      );
      return {
        ...reflection,
        content: normalized.content,
        improvementPlan: normalized.improvementPlan ?? reflection.improvementPlan,
        survey: normalized.survey ?? reflection.survey,
      };
    }),
    activityLog: course.activityLog ?? [],
    announcements: course.announcements ?? [],
    todos: course.todos ?? [],
    resources: course.resources ?? [],
    groups: personalProjects,
    groupAnnouncements: course.groupAnnouncements ?? [],
    workPlan: course.workPlan ?? [],
    whiteboard: course.whiteboard ?? [],
    boards: course.boards ?? [],
    uploads: course.uploads ?? [],
    teamContributions: course.teamContributions ?? [],
    aiSupports: course.aiSupports ?? [],
    teacherInterventions: course.teacherInterventions ?? [],
    resolvedInterventionSignalIds: course.resolvedInterventionSignalIds ?? [],
    stageTransitions: course.stageTransitions ?? [],
    evaluations: course.evaluations ?? [],
    learningEvents: (course.learningEvents ?? []).filter((item) =>
      isWithinOperationalRetention(item.occurredAt)),
    companionThreads: course.companionThreads ?? [],
    companionTasks: course.companionTasks ?? [],
    companionConfirmations: course.companionConfirmations ?? [],
    companionProcessRecords: course.companionProcessRecords ?? [],
    learningSignals: (course.learningSignals ?? []).filter((item) =>
      isWithinOperationalRetention(item.lastDetectedAt)),
    learningEvidence: course.learningEvidence ?? [],
    artifactSnapshots: course.artifactSnapshots ?? [],
    aiContributions: course.aiContributions ?? [],
    studentAiDecisions: course.studentAiDecisions ?? [],
    aiAssessmentSuggestions: course.aiAssessmentSuggestions ?? [],
    classCommonIssues: (course.classCommonIssues ?? []).filter((item) =>
      isWithinOperationalRetention(item.lastDetectedAt)),
    teacherAgentDirectives: course.teacherAgentDirectives ?? [],
    offlineInterventions: course.offlineInterventions ?? [],
    dynamicFacilitationScaffolds: course.dynamicFacilitationScaffolds ?? [],
    uiState: {
      ...(course.uiState ?? {}),
      teacherResourceProjection: course.uiState?.teacherResourceProjection ?? null,
      resourceProjection: course.uiState?.resourceProjection ?? null,
    },
    content: {
      ...course.content,
      lessonOutline: course.content.lessonOutline ?? [],
      teachingOutline: course.content.teachingOutline,
      evaluationPlan: courseEvaluationPlan(course),
    },
  };
  const selected = reconcileCourseGenerationMode(normalized);
  const classroomTiming = selected.uiState?.classroomTiming;
  if (!classroomTiming) return selected;
  const stageKeysMatch = classroomTiming.stages.length === selected.stages.length
    && classroomTiming.stages.every(
      (stage, index) => stage.stageKey === selected.stages[index]?.key,
    );
  if (stageKeysMatch) return selected;
  return {
    ...selected,
    uiState: {
      ...(selected.uiState ?? {}),
      classroomTiming: reconcileClassroomTimingState({
        state: classroomTiming,
        stages: selected.stages,
        totalMinutes: resolveCourseTimingMinutes(selected),
        projectMainline: selected.content.projectMainline,
        moduleTimingPlan: selected.content.moduleTimingPlan,
        stagePlan: selected.content.stagePlan,
        activeStageKey: selected.stages[selected.currentStageIndex]?.key,
      }),
    },
  };
}

function isWithinOperationalRetention(value: string): boolean {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  return Date.now() - timestamp
    <= OPERATIONAL_SIGNAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
}

/** Heartbeat timeout in ms. Students whose lastSeenAt is older than this are
 * considered offline. The frontend sends a heartbeat every 10s, so 30s gives
 * a comfortable margin for occasional network latency without false negatives. */
export const HEARTBEAT_TIMEOUT_MS = 30_000;

/** Returns true if the student is currently considered online (last heartbeat
 * within HEARTBEAT_TIMEOUT_MS). A student with no lastSeenAt is offline. */
export function isStudentOnline(student: { lastSeenAt?: string }, now: number = Date.now()): boolean {
  if (!student.lastSeenAt) return false;
  const ts = new Date(student.lastSeenAt).getTime();
  if (Number.isNaN(ts)) return false;
  return now - ts < HEARTBEAT_TIMEOUT_MS;
}

/** Returns the list of student IDs in a course whose heartbeats have expired
 * and should be marked offline by a MARK_STUDENTS_OFFLINE action. */
export function getStaleStudentIds(course: Course, now: number = Date.now()): string[] {
  return course.students
    .filter((s) => s.lastSeenAt && !isStudentOnline(s, now))
    .map((s) => s.id);
}
