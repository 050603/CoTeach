// @ts-nocheck
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { hashPassword } from "@/lib/auth/password";
import { prisma } from "@/lib/db/client";
import { authorizeLoadTestRequest } from "@/lib/load-test/authorization";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateRunSchema = z.object({
  runId: z.string().uuid(),
  studentCount: z.number().int().min(1).max(150),
  teacherCount: z.number().int().min(1).max(10).default(1),
}).strict();

export async function POST(request: Request) {
  const denied = authorizeLoadTestRequest(request);
  if (denied) return denied;
  const parsed = CreateRunSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { code: "INVALID_INPUT", message: "Invalid load-test run request." },
      { status: 400 },
    );
  }

  const existing = await prisma.loadTestRun.findUnique({
    where: { runId: parsed.data.runId },
  });
  if (existing) {
    return Response.json(
      { code: "RUN_EXISTS", message: "The runId already exists." },
      { status: 409 },
    );
  }

  const suffix = parsed.data.runId.replaceAll("-", "");
  const courseId = randomUUID();
  const teacherUsernamePrefix = `load_${suffix.slice(0, 20)}`;
  const inviteCode = `K6${suffix.slice(0, 8).toUpperCase()}`;
  const teachers = await Promise.all(
    Array.from({ length: parsed.data.teacherCount }, async (_, index) => {
      const password = randomBytes(24).toString("base64url");
      return {
        id: randomUUID(),
        username: `${teacherUsernamePrefix}_${String(index + 1).padStart(2, "0")}`,
        displayName: `k6-${suffix.slice(0, 8)}-teacher-${index + 1}`,
        password,
        passwordHash: await hashPassword(password),
      };
    }),
  );
  const primaryTeacher = teachers[0]!;
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);

  await prisma.$transaction(async (tx) => {
    await tx.teacher.createMany({
      data: teachers.map((teacher) => ({
        id: teacher.id,
        username: teacher.username,
        displayName: teacher.displayName,
        passwordHash: teacher.passwordHash,
      })),
    });
    await tx.course.create({
      data: {
        id: courseId,
        name: `k6-${suffix.slice(0, 8)}`,
        subject: "load-test",
        grade: "test",
        hours: 1,
        summary: `Isolated load-test fixture ${parsed.data.runId}`,
        drivingQuestion: "Can confirmed writes remain consistent under load?",
        status: "teaching",
        inviteCode,
        learningObjectives: [],
        stages: [],
        content: {},
        uiState: {},
        aiLearningProgress: {},
        resolvedInterventionSignalIds: [],
      },
    });
    await tx.loadTestRun.create({
      data: {
        runId: parsed.data.runId,
        // The existing ownership marker remains the primary principal. All
        // additional teachers use the run-specific username prefix and are
        // deleted as one isolated set during teardown.
        teacherId: primaryTeacher.id,
        courseId,
        studentCount: parsed.data.studentCount,
        expiresAt,
      },
    });
  });

  return Response.json(
    {
      runId: parsed.data.runId,
      teacher: {
        username: primaryTeacher.username,
        password: primaryTeacher.password,
      },
      teachers: teachers.map((teacher) => ({
        username: teacher.username,
        password: teacher.password,
      })),
      course: { id: courseId, inviteCode, version: 1 },
      students: Array.from({ length: parsed.data.studentCount }, (_, index) => ({
        name: `k6-${suffix.slice(0, 8)}-student-${String(index + 1).padStart(3, "0")}`,
      })),
      expiresAt: expiresAt.toISOString(),
    },
    { status: 201, headers: { "Cache-Control": "no-store" } },
  );
}
