import { z } from "zod";
import type { SessionAction } from "@/lib/session/actions";
import type { ProjectionStateSnapshot } from "@/lib/realtime/projection-state";

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string().max(1_000_000),
    z.array(JsonValueSchema).max(2_000),
    z.record(z.string().min(1).max(128), JsonValueSchema).refine(
      (value) =>
        Object.keys(value).length <= 500 &&
        !Object.hasOwn(value, "__proto__") &&
        !Object.hasOwn(value, "constructor"),
      "Object contains too many or unsafe keys.",
    ),
  ]),
);

export const CourseActionTypeSchema = z.enum([
  "CREATE_COURSE",
  "UPDATE_COURSE",
  "DELETE_COURSE",
  "SET_COURSE_CONTENT",
  "SET_COURSE_STAGES",
  "PUBLISH_COURSE",
  "START_TEACHING",
  "RESTART_TEACHING",
  "END_TEACHING",
  "ADVANCE_STAGE",
  "SET_STAGE",
  "JOIN_CLASS",
  "LEAVE_CLASS",
  "UPDATE_STUDENT_PROGRESS",
  "UPSERT_SUBMISSION",
  "ADD_FEEDBACK",
  "UPSERT_RUBRIC_SCORE",
  "UPSERT_REFLECTION",
  "ADD_ACTIVITY",
  "SET_PRESENTING_GROUP",
  "UPSERT_ANNOUNCEMENT",
  "DELETE_ANNOUNCEMENT",
  "ADD_ANNOUNCEMENT_REPLY",
  "UPSERT_TODO",
  "SET_STUDENT_TODO_COMPLETION",
  "MARK_RESOURCE_DOWNLOADED",
  "UPSERT_GROUP",
  "JOIN_GROUP",
  "LEAVE_GROUP",
  "SET_GROUP_TOPIC",
  "UPSERT_GROUP_ANNOUNCEMENT",
  "UPSERT_WORK_PLAN_ITEM",
  "DELETE_WORK_PLAN_ITEM",
  "UPSERT_WHITEBOARD_NODE",
  "DELETE_WHITEBOARD_NODE",
  "UPSERT_GROUP_BOARD",
  "UPSERT_UPLOAD",
  "DELETE_UPLOAD",
  "SET_PREVIEW_UPLOAD",
  "UPSERT_TEAM_CONTRIBUTION",
  "UPSERT_AI_SUPPORT",
  "ADD_OFFLINE_INTERVENTION",
  "RESOLVE_INTERVENTION_SIGNALS",
  "UPSERT_TEACHER_AGENT_DIRECTIVE",
  "UPSERT_COMPANION_TASK",
  "UPSERT_COMPANION_CONFIRMATION",
  "RESOLVE_COMPANION_CONFIRMATION",
  "ADD_COMPANION_PROCESS_RECORD",
  "REQUEST_TEACHER_HELP",
  "UPSERT_LEARNING_EVIDENCE",
  "REVIEW_LEARNING_EVIDENCE",
  "UPSERT_ARTIFACT_SNAPSHOT",
  "UPSERT_AI_CONTRIBUTION",
  "RECORD_STUDENT_AI_DECISION",
  "UPSERT_AI_ASSESSMENT_SUGGESTION",
  "SET_UI_STATE",
]);

const GenericActionSchema = z.object({
  type: CourseActionTypeSchema,
  payload: z.record(z.string().min(1).max(128), JsonValueSchema),
}).strict();

const ProgressActionSchema = z.object({
  type: z.literal("UPDATE_STUDENT_PROGRESS"),
  payload: z.object({
    courseId: z.string().min(1).max(128),
    studentId: z.string().min(1).max(128),
    stageKey: z.string().min(1).max(64),
    value: z.number().finite().min(0).max(100),
  }).strict(),
}).strict();

const SubmissionActionSchema = z.object({
  type: z.literal("UPSERT_SUBMISSION"),
  payload: z.object({
    courseId: z.string().min(1).max(128),
    submission: z.object({
      id: z.string().min(1).max(128),
      courseId: z.string().min(1).max(128),
      studentId: z.string().min(1).max(128).optional(),
      studentName: z.string().trim().min(1).max(64).optional(),
      groupId: z.string().min(1).max(128).optional(),
      stageKey: z.string().min(1).max(64),
      type: z.enum([
        "idea",
        "plan",
        "document",
        "artifact-brief",
        "code",
        "resource",
        "showcase",
        "reflection",
        "evidence",
      ]),
      title: z.string().max(256),
      content: z.string().max(1_000_000),
      files: z.array(z.object({
        name: z.string().min(1).max(255),
        type: z.string().min(1).max(128),
        size: z.string().max(64).optional(),
        url: z.string().max(2_048).optional(),
      }).strict()).max(20).optional(),
      status: z.enum(["draft", "submitted", "failed"]).optional(),
      submittedAt: z.iso.datetime().optional(),
      version: z.number().int().positive().optional(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }).strict(),
  }).strict(),
}).strict();

const ReflectionSurveyResponseSchema = z.object({
  schemaVersion: z.literal(1),
  learningReflection: z.string().trim().min(1).max(300),
  systemReflection: z.string().trim().min(1).max(300),
  aiHelpfulness: z.number().int().min(1).max(5),
  systemUsability: z.number().int().min(1).max(5),
  reuseIntention: z.number().int().min(1).max(5),
}).strict();

const ReflectionActionSchema = z.object({
  type: z.literal("UPSERT_REFLECTION"),
  payload: z.object({
    courseId: z.string().min(1).max(128),
    reflection: z.object({
      id: z.string().min(1).max(128),
      courseId: z.string().min(1).max(128),
      studentId: z.string().min(1).max(128),
      studentName: z.string().trim().min(1).max(64),
      content: z.string().max(1_000_000),
      improvementPlan: z.string().max(1_000_000).optional(),
      survey: ReflectionSurveyResponseSchema.optional(),
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    }).strict(),
  }).strict(),
}).strict();

const ResourceProjectionSchema = z.object({
  resourceId: z.string().min(1).max(128),
  stageKey: z.string().min(1).max(64),
  title: z.string().max(256),
  startedAt: z.iso.datetime(),
  viewState: z.object({
    scrollRatio: z.number().finite().min(0).max(1).optional(),
    page: z.number().int().positive().optional(),
    mediaTime: z.number().finite().min(0).optional(),
    mediaPlaying: z.boolean().optional(),
    mediaPlaybackRate: z.number().finite().min(0.25).max(4).optional(),
    updatedAt: z.iso.datetime(),
    revision: z.number().int().nonnegative(),
  }).strict().optional(),
}).strict();

const TeacherProjectionSchema = z.object({
  classroomId: z.string().min(1).max(256),
  sceneId: z.string().min(1).max(128),
  stageKey: z.string().min(1).max(64),
  title: z.string().max(256),
  sceneType: z.enum(["slide", "quiz", "interactive", "pbl"]),
  startedAt: z.iso.datetime(),
  mode: z.enum(["forced", "optional"]).optional(),
  version: z.number().int().nonnegative().optional(),
  updatedAt: z.iso.datetime().optional(),
  engineMode: z.enum(["idle", "playing", "paused", "live"]).optional(),
  playback: z.object({
    sceneIndex: z.number().int().nonnegative(),
    actionIndex: z.number().int().nonnegative(),
    consumedDiscussions: z.array(z.string().max(128)).max(500),
    sceneId: z.string().max(128).optional(),
  }).strict().optional(),
  interactionState: z.record(z.string().min(1).max(128), JsonValueSchema).nullable().optional(),
}).strict();

const UiStateActionSchema = z.object({
  type: z.literal("SET_UI_STATE"),
  payload: z.object({
    courseId: z.string().min(1).max(128),
    patch: z.record(z.string().min(1).max(128), JsonValueSchema),
  }).strict(),
}).strict().superRefine((action, context) => {
  const keys = Object.keys(action.payload.patch);
  if (
    keys.length === 0
    || !keys.every((key) => key === "resourceProjection" || key === "teacherResourceProjection")
  ) return;
  const projectionPatch = z.object({
    resourceProjection: ResourceProjectionSchema.nullable().optional(),
    teacherResourceProjection: TeacherProjectionSchema.nullable().optional(),
  }).strict().safeParse(action.payload.patch);
  if (!projectionPatch.success) {
    for (const issue of projectionPatch.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["payload", "patch", ...issue.path],
        message: issue.message,
      });
    }
  }
});

export const ActionEnvelopeSchema = z.object({
  requestId: z.string().uuid(),
  expectedVersion: z.number().int().positive().optional(),
  action: GenericActionSchema,
}).strict().superRefine((envelope, context) => {
  const specialized =
    envelope.action.type === "UPDATE_STUDENT_PROGRESS"
      ? ProgressActionSchema
      : envelope.action.type === "UPSERT_SUBMISSION"
        ? SubmissionActionSchema
        : envelope.action.type === "UPSERT_REFLECTION"
          ? ReflectionActionSchema
          : envelope.action.type === "SET_UI_STATE"
            ? UiStateActionSchema
            : null;
  if (!specialized) return;
  const result = specialized.safeParse(envelope.action);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({
        code: "custom",
        path: ["action", ...issue.path],
        message: issue.message,
      });
    }
  }
});

export type ActionEnvelope = {
  requestId: string;
  expectedVersion?: number;
  action: SessionAction;
};

export type ActionAck = {
  requestId: string;
  courseVersion: number;
  eventCursor: string;
  projection?: ProjectionStateSnapshot;
};

export function actionCourseId(action: SessionAction): string | null {
  if (!("payload" in action) || typeof action.payload !== "object" || !action.payload) return null;
  const payload = action.payload as Record<string, unknown>;
  const candidate = payload.courseId ?? payload.id;
  return typeof candidate === "string" ? candidate : null;
}
