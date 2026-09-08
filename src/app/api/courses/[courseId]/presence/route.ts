import { z } from "zod";
import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { getRedisClient } from "@/lib/redis/client";
import { prisma } from "@/lib/db/client";
import type { AuthClaims } from "@/lib/auth/session";
import type { PresenceMember, PresenceSnapshot } from "@/lib/presence";
import { canAccessLegacyCourse } from "@/lib/platform/access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ParamsSchema = z.object({ courseId: z.string().uuid() });
const PRESENCE_TTL_MS = 60_000;
const KEY_TTL_SECONDS = 120;
let lastRedisFallbackLogAt = 0;

async function redisOrDatabase() {
  try {
    return await getRedisClient();
  } catch (error) {
    const now = Date.now();
    if (now - lastRedisFallbackLogAt > 30_000) {
      lastRedisFallbackLogAt = now;
      console.error("[presence] Redis unavailable; using database heartbeats", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return null;
  }
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  if (auth.claims.role === "student" && auth.claims.courseId !== parsed.data.courseId) {
    return new Response(null, { status: 404 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, parsed.data.courseId, "write"))) {
    return new Response(null, { status: 403 });
  }
  const redis = await redisOrDatabase();
  if (!redis) {
    if (auth.claims.role === "student") {
      await prisma.student.updateMany({
        where: {
          courseId: parsed.data.courseId,
          id: auth.claims.studentId,
        },
        data: {
          lastSeenAt: new Date().toISOString(),
          version: { increment: 1 },
        },
      });
    }
    return Response.json({ online: true, degraded: true, source: "database" });
  }

  const now = Date.now();
  const member = `${auth.claims.role}:${auth.claims.sub}`;
  const zset = presenceKey(parsed.data.courseId);
  const details = detailsKey(parsed.data.courseId);
  await redis
    .multi()
    .zAdd(zset, { score: now, value: member })
    .zRemRangeByScore(zset, 0, now - PRESENCE_TTL_MS)
    .hSet(details, member, JSON.stringify(publicPresence(auth.claims)))
    .expire(zset, KEY_TTL_SECONDS)
    .expire(details, KEY_TTL_SECONDS)
    .exec();
  return Response.json({
    online: true,
    expiresInSeconds: PRESENCE_TTL_MS / 1_000,
    source: "redis",
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const csrfError = requireSameOrigin(request);
  if (csrfError) return csrfError;
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  if (auth.claims.role === "student" && auth.claims.courseId !== parsed.data.courseId) {
    return new Response(null, { status: 404 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, parsed.data.courseId, "write"))) {
    return new Response(null, { status: 403 });
  }
  const redis = await redisOrDatabase();
  if (!redis && auth.claims.role === "student") {
    await prisma.student.updateMany({
      where: {
        courseId: parsed.data.courseId,
        id: auth.claims.studentId,
      },
      data: { lastSeenAt: null, version: { increment: 1 } },
    });
  } else if (redis) {
    const member = `${auth.claims.role}:${auth.claims.sub}`;
    await redis
      .multi()
      .zRem(presenceKey(parsed.data.courseId), member)
      .hDel(detailsKey(parsed.data.courseId), member)
      .exec();
  }
  return new Response(null, { status: 204 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  const auth = await authenticateRequest(request);
  if ("response" in auth) return auth.response;
  const parsed = ParamsSchema.safeParse(await context.params);
  if (!parsed.success) return new Response(null, { status: 404 });
  if (auth.claims.role === "student" && auth.claims.courseId !== parsed.data.courseId) {
    return new Response(null, { status: 404 });
  }
  if (!(await canAccessLegacyCourse(auth.claims, parsed.data.courseId, "read"))) {
    return new Response(null, { status: 403 });
  }
  const redis = await redisOrDatabase();
  if (!redis) {
    const students = await prisma.student.findMany({
      where: { courseId: parsed.data.courseId, lastSeenAt: { not: null } },
      select: { id: true, name: true, lastSeenAt: true },
    });
    const cutoff = Date.now() - PRESENCE_TTL_MS;
    const members: PresenceMember[] = students.flatMap((student) => {
      const seenAt = student.lastSeenAt ? Date.parse(student.lastSeenAt) : Number.NaN;
      return Number.isFinite(seenAt) && seenAt >= cutoff
        ? [{ id: student.id, role: "student" as const, name: student.name }]
        : [];
    });
    const snapshot: PresenceSnapshot = {
      members,
      degraded: true,
      source: "database",
    };
    return Response.json(snapshot);
  }
  const now = Date.now();
  const zset = presenceKey(parsed.data.courseId);
  await redis.zRemRangeByScore(zset, 0, now - PRESENCE_TTL_MS);
  const members = await redis.zRangeByScore(zset, now - PRESENCE_TTL_MS, "+inf");
  const details = members.length
    ? await redis.hmGet(detailsKey(parsed.data.courseId), members)
    : [];
  const snapshot: PresenceSnapshot = {
    members: details.flatMap((value) => {
      if (!value) return [];
      try {
        return [JSON.parse(value) as PresenceMember];
      } catch {
        return [];
      }
    }),
    source: "redis",
  };
  return Response.json(snapshot);
}

function publicPresence(claims: AuthClaims) {
  return claims.role === "teacher"
    ? { id: claims.sub, role: claims.role, name: claims.displayName }
    : { id: claims.studentId, role: claims.role, name: claims.studentName };
}

function presenceKey(courseId: string): string {
  return `openpbl:presence:${courseId}`;
}

function detailsKey(courseId: string): string {
  return `openpbl:presence-details:${courseId}`;
}
