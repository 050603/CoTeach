import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { rateLimitedResponse } from "@/lib/auth/rate-limit";
import {
  acquireDiscussionSound,
  addTeacherGuidance,
  completeDiscussionPlayback,
  continueDiscussionQuestioning,
  finishPublicDiscussion,
  getPublicDiscussionSnapshot,
  inviteDiscussionStudent,
  isPublicDiscussionEnabled,
  pausePublicDiscussion,
  PublicDiscussionError,
  recommendDiscussionCandidates,
  respondToInvitation,
  retryAssistantReply,
  setRecordingState,
  startPublicDiscussion,
  submitStudentAnswer,
} from "@/lib/public-discussion/service";
import type { PublicDiscussionCandidate } from "@/lib/public-discussion/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestId = z.string().uuid();
const expectedVersion = z.number().int().positive();
const mode = z.enum(["inquiry", "debate"]);
const CandidateSchema = z.object({
  studentId: z.string().min(1).max(160),
  studentName: z.string().min(1).max(160),
  online: z.boolean(),
  reason: z.string().max(300),
  evidence: z.string().max(600),
  participationCount: z.number().int().nonnegative(),
}).strict();

const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("recommend"), knowledgePointId: z.string().min(1).max(160), mode }).strict(),
  z.object({
    action: z.literal("start"),
    requestId,
    knowledgePointId: z.string().min(1).max(160),
    topic: z.string().trim().min(1).max(200),
    mode,
    openingPrompt: z.string().trim().min(1).max(2_000),
    studentId: z.string().min(1).max(160),
    candidates: z.array(CandidateSchema).max(20).optional(),
  }).strict(),
  z.object({ action: z.enum(["accept", "decline"]), requestId, expectedVersion }).strict(),
  z.object({ action: z.enum(["start-recording", "cancel-recording"]), requestId, expectedVersion }).strict(),
  z.object({
    action: z.literal("submit-answer"),
    requestId,
    expectedVersion,
    content: z.string().trim().min(1).max(3_000),
    source: z.enum(["voice", "text"]),
  }).strict(),
  z.object({ action: z.literal("invite"), requestId, expectedVersion, studentId: z.string().min(1).max(160) }).strict(),
  z.object({ action: z.enum(["pause", "resume", "retry-ai", "continue-questioning", "finish"]), requestId, expectedVersion }).strict(),
  z.object({ action: z.literal("teacher-guide"), requestId, expectedVersion, content: z.string().trim().min(1).max(1_500) }).strict(),
  z.object({ action: z.literal("acquire-sound"), clientId: z.string().min(8).max(160) }).strict(),
  z.object({ action: z.literal("complete-playback"), requestId, expectedVersion, clientId: z.string().min(8).max(160) }).strict(),
]);

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "read"))) {
    return Response.json({ code: "FORBIDDEN", message: "课堂当前不可访问。" }, { status: 403 });
  }
  const soundClientId = new URL(request.url).searchParams.get("soundClientId") ?? undefined;
  return Response.json(await getPublicDiscussionSnapshot(courseId, auth.claims, soundClientId), {
    headers: { "Cache-Control": "private, no-store" },
  });
}
export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  if (!isPublicDiscussionEnabled()) {
    return Response.json({ code: "FEATURE_DISABLED", message: "公开讨论试验功能尚未启用。" }, { status: 404 });
  }
  const { courseId } = await context.params;
  if (!(await canAccessLegacyCourse(auth.claims, courseId, "write"))) {
    return Response.json({ code: "COURSE_LOCKED", message: "课堂当前不允许互动。" }, { status: 403 });
  }
  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ code: "INVALID_ACTION", message: "讨论操作参数无效。", details: parsed.error.flatten() }, { status: 400 });
  }
  const action = parsed.data;
  if (["recommend", "start", "invite", "pause", "resume", "retry-ai", "continue-questioning", "finish", "teacher-guide", "acquire-sound", "complete-playback"].includes(action.action) && auth.claims.role !== "teacher") {
    return Response.json({ code: "TEACHER_REQUIRED", message: "只有教师可以执行此操作。" }, { status: 403 });
  }
  const rate = await checkDistributedRateLimit({
    namespace: "public-discussion",
    key: `${auth.claims.sub}:${courseId}:${action.action}`,
    limit: action.action === "acquire-sound" ? 120 : action.action === "recommend" ? 12 : 40,
    windowSeconds: 60,
  });
  if (!rate.allowed) return rateLimitedResponse(rate.retryAfterMs);

  try {
    if (action.action === "recommend") {
      return Response.json(await recommendDiscussionCandidates(courseId, action.knowledgePointId, action.mode));
    }
    if (action.action === "start") {
      return Response.json(await startPublicDiscussion({
        ...action,
        courseId,
        claims: auth.claims,
        candidates: action.candidates as PublicDiscussionCandidate[] | undefined,
      }));
    }
    if (action.action === "accept" || action.action === "decline") {
      return Response.json(await respondToInvitation({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, response: action.action,
      }));
    }
    if (action.action === "start-recording" || action.action === "cancel-recording") {
      return Response.json(await setRecordingState({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, recording: action.action === "start-recording",
      }));
    }
    if (action.action === "submit-answer") {
      return Response.json(await submitStudentAnswer({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, content: action.content, source: action.source,
      }));
    }
    if (action.action === "invite") {
      return Response.json(await inviteDiscussionStudent({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, studentId: action.studentId,
      }));
    }
    if (action.action === "pause" || action.action === "resume") {
      return Response.json(await pausePublicDiscussion({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, paused: action.action === "pause",
      }));
    }
    if (action.action === "teacher-guide") {
      return Response.json(await addTeacherGuidance({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, content: action.content,
      }));
    }
    if (action.action === "retry-ai") {
      return Response.json(await retryAssistantReply({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion,
      }));
    }
    if (action.action === "continue-questioning") {
      return Response.json(await continueDiscussionQuestioning({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion,
      }));
    }
    if (action.action === "acquire-sound") {
      return Response.json(await acquireDiscussionSound({
        courseId, claims: auth.claims, clientId: action.clientId,
      }));
    }
    if (action.action === "complete-playback") {
      return Response.json(await completeDiscussionPlayback({
        courseId, claims: auth.claims, requestId: action.requestId,
        expectedVersion: action.expectedVersion, clientId: action.clientId,
      }));
    }
    return Response.json(await finishPublicDiscussion({
      courseId, claims: auth.claims, requestId: action.requestId,
      expectedVersion: action.expectedVersion,
    }));
  } catch (error) {
    return publicDiscussionError(error);
  }
}

function publicDiscussionError(error: unknown): Response {
  if (error instanceof PublicDiscussionError) {
    return Response.json({ code: error.code, message: error.message }, { status: error.status });
  }
  console.error("[public-discussion] request failed", error);
  return Response.json({ code: "PUBLIC_DISCUSSION_FAILED", message: "课堂公开讨论操作未完成，请稍后重试。" }, { status: 500 });
}
