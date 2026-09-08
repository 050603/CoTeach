// @ts-nocheck
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { isDatabaseConfigured } from "@/lib/db/client";
import { normalizeInviteCode } from "@/lib/session/invite-code";
import {
  getAuthCookieOptions,
  isAuthConfigured,
  signStudentToken,
  STUDENT_COOKIE_NAME,
} from "@/lib/auth/session";
import { requireSameOrigin } from "@/lib/auth/request-guards";
import { checkDistributedRateLimit } from "@/lib/auth/distributed-rate-limit";
import { getClientIp, rateLimitedResponse } from "@/lib/auth/rate-limit";
import { publishCourseEvent } from "@/lib/realtime/event-bus";
import { runMutationTransaction } from "@/lib/db/transaction-retry";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const JoinSchema = z.object({
  requestId: z.string().uuid().optional(),
  inviteCode: z.string().trim().min(4).max(32),
  studentName: z.string().trim().min(1).max(64),
});

export async function POST(req: Request) {
  const csrfError = requireSameOrigin(req);
  if (csrfError) return csrfError;
  if (!isAuthConfigured()) {
    return apiError(req, "AUTH_NOT_CONFIGURED", "未配置 JWT_SECRET，学生鉴权不可用。", 503);
  }
  if (!isDatabaseConfigured()) {
    return apiError(req, "DB_NOT_CONFIGURED", "数据库未配置，无法加入课堂。", 503);
  }
  const joinLimit = await checkDistributedRateLimit({
    namespace: "join",
    key: getClientIp(req),
    limit: 20,
    windowSeconds: 60,
  });
  if (!joinLimit.allowed) return rateLimitedResponse(joinLimit.retryAfterMs);

  const parsed = JoinSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return apiError(req, "INVALID_INPUT", "Invalid invite code or name.", 400);
  const requestId = parsed.data.requestId ?? randomUUID();
  const inviteCode = normalizeInviteCode(parsed.data.inviteCode);
  const studentName = parsed.data.studentName.normalize("NFC").trim();
  const nameKey = studentName.toLocaleLowerCase("zh-CN");

  try {
    const result = await runMutationTransaction(
      async (tx) => {
        await tx.$executeRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${"student-join:" + inviteCode}, 0)
          )
        `;
        const previous = await tx.courseMutationReceipt.findUnique({ where: { requestId } });
        if (previous?.status === "completed") {
          const account = await tx.studentAccount.findUnique({
            where: { courseId_nameKey: { courseId: previous.courseId, nameKey } },
          });
          if (account) return { account, courseVersion: previous.courseVersion ?? 1, cursor: previous.eventCursor };
        }
        const course = await tx.course.findFirst({
          where: { inviteCode, status: "teaching" },
          select: { id: true, version: true },
        });
        if (!course) throw new JoinError("INVITE_CODE_INVALID", "Invite code is invalid.", 404);
        const existing = await tx.studentAccount.findUnique({
          where: { courseId_nameKey: { courseId: course.id, nameKey } },
        });
        const studentId = existing?.studentId ?? randomUUID();
        const account = await tx.studentAccount.upsert({
          where: { courseId_nameKey: { courseId: course.id, nameKey } },
          create: {
            courseId: course.id,
            studentId,
            studentName,
            nameKey,
            inviteCode,
            lastLoginAt: new Date(),
          },
          update: {
            studentName,
            inviteCode,
            lastLoginAt: new Date(),
          },
        });
        await tx.student.upsert({
          where: { courseId_id: { courseId: course.id, id: studentId } },
          create: {
            id: studentId,
            courseId: course.id,
            name: studentName,
            progress: {},
          },
          update: { name: studentName },
        });

        const groupId = `grp-${studentId}`;
        await tx.projectGroup.upsert({
          where: { id: groupId },
          create: {
            id: groupId,
            courseId: course.id,
            name: `${studentName}的个人项目`,
            topic: "待确定选题方向",
            keywords: [],
            selectedForms: [],
            members: [{ studentId, name: studentName, role: "项目负责人" }],
          },
          update: {
            name: `${studentName}的个人项目`,
            members: [{ studentId, name: studentName, role: "项目负责人" }],
          },
        });
        await tx.groupMember.upsert({
          where: {
            courseId_groupId_studentId: {
              courseId: course.id,
              groupId,
              studentId,
            },
          },
          create: {
            courseId: course.id,
            groupId,
            studentId,
            studentName,
            role: "项目负责人",
          },
          update: { studentName, role: "项目负责人" },
        });
        const updated = await tx.course.update({
          where: { id: course.id },
          data: { version: { increment: 1 } },
          select: { version: true },
        });
        await tx.courseMutationReceipt.upsert({
          where: { requestId },
          create: {
            requestId,
            courseId: course.id,
            actorId: studentId,
            status: "processing",
          },
          update: {},
        });
        const event = await tx.courseEvent.create({
          data: {
            courseId: course.id,
            requestId,
            type: "JOIN_CLASS",
            actorId: studentId,
            actorRole: "student",
            courseVersion: updated.version,
          },
        });
        await tx.courseMutationReceipt.update({
          where: { requestId },
          data: {
            status: "completed",
            courseVersion: updated.version,
            eventCursor: event.cursor,
            completedAt: new Date(),
          },
        });
        return { account, courseVersion: updated.version, cursor: event.cursor };
      },
    );

    const { token, maxAge } = await signStudentToken({
      courseId: result.account.courseId,
      studentId: result.account.studentId,
      studentName: result.account.studentName,
      sessionVersion: result.account.sessionVersion,
    });
    const cookie = getAuthCookieOptions(maxAge);
    void publishCourseEvent(result.account.courseId, {
      type: "student-joined",
      courseId: result.account.courseId,
      at: new Date().toISOString(),
      payload: {
        courseVersion: result.courseVersion,
        eventCursor: result.cursor?.toString() ?? "0",
      },
    });
    return Response.json(
      {
        user: {
          role: "student",
          courseId: result.account.courseId,
          studentId: result.account.studentId,
          studentName: result.account.studentName,
        },
      },
      {
        headers: {
          "Set-Cookie": `${STUDENT_COOKIE_NAME}=${encodeURIComponent(token)}; Path=${cookie.path}; Max-Age=${cookie.maxAge}; HttpOnly; SameSite=${cookie.sameSite}${cookie.secure ? "; Secure" : ""}`,
          "Cache-Control": "no-store",
        },
      },
    );
  } catch (error) {
    if (error instanceof JoinError) return apiError(req, error.code, error.message, error.status);
    console.error("[auth/join] unable to join classroom:", {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    return apiError(req, "JOIN_UNAVAILABLE", "Classroom service is temporarily unavailable.", 503);
  }
}

class JoinError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function apiError(request: Request, code: string, message: string, status: number): Response {
  return Response.json(
    { code, error: code, message, requestId: request.headers.get("x-request-id") ?? "unknown" },
    { status },
  );
}
