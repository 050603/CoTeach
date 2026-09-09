import { authenticateRequest, requireSameOrigin } from "@/lib/auth/request-guards";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import { callLLM } from "@/lib/llm/client";
import { getCourse, updateCourse } from "@/lib/session/server-store";
import { TEACHER_FACING_PROMPT_CONTRACT } from "@/lib/prompt-quality/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null) as { courseId?: string; scaffoldId?: string } | null;
  if (!body?.courseId || !body.scaffoldId) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  if (request.signal.aborted) return new Response(null, { status: 499 });
  if (!await canAccessLegacyCourse(auth.claims, body.courseId)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const course = await getCourse(body.courseId);
  if (request.signal.aborted) return new Response(null, { status: 499 });
  const scaffold = course?.dynamicFacilitationScaffolds?.find((item) => item.id === body.scaffoldId);
  if (!course || !scaffold) return Response.json({ error: "SCAFFOLD_NOT_FOUND" }, { status: 404 });
  const submissions = (course.submissions ?? []).filter((item) => item.stageKey === scaffold.stageKey).slice(-12);
  const messages = (course.companionThreads ?? []).filter((thread) => thread.stageKey === scaffold.stageKey).flatMap((thread) => thread.messages).filter((message) => message.visibility === "student-and-teacher").slice(-30);
  const issues = (course.classCommonIssues ?? []).filter((issue) => issue.stageKey === scaffold.stageKey && issue.status === "open");
  if (!submissions.length && !messages.length && !issues.length) {
    return Response.json({ error: "INSUFFICIENT_REAL_EVIDENCE" }, { status: 409 });
  }
  const evidence = [
    ...submissions.map((item) => `提交[${item.id}] ${item.title}：${item.content.replace(/<[^>]+>/g, " ").slice(0, 600)}`),
    ...messages.map((item) => `对话[${item.id}] ${item.authorName ?? item.role}：${item.content.slice(0, 400)}`),
    ...issues.map((item) => `共性问题[${item.id}]：${item.summary}`),
  ];
  let content: string;
  try {
    content = await callLLM([
      { role: "system", content: `你是教师课堂主持助手。只能依据给定的真实学生证据填充主持支架；每个判断必须标注证据 ID，不得编造学生表现，不得替教师作最终价值判断。
输出必须沿用给定支架的章节顺序，每一节包含“主持目标、可直接使用的引导语、对应证据、需要教师确认的判断”四部分。直接证据与基于证据的推断必须明确区分；证据不足时写“证据不足，需教师现场确认”，不得补写。

${TEACHER_FACING_PROMPT_CONTRACT}` },
      { role: "user", content: `课程：${course.name}\n主持支架：${scaffold.title}\n章节结构（仅用于确定顺序和范围，不得复述内部字段名）：${JSON.stringify(scaffold.sections)}\n真实证据：\n${evidence.join("\n")}\n请生成教师可审阅、可在课堂直接使用的主持草稿。` },
    ], { abortSignal: request.signal });
  } catch (error) {
    if (request.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return new Response(null, { status: 499 });
    }
    throw error;
  }
  if (request.signal.aborted) return new Response(null, { status: 499 });
  if (!await canAccessLegacyCourse(auth.claims, body.courseId)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const now = new Date().toISOString();
  await updateCourse(course.id, (current) => ({
    ...current,
    dynamicFacilitationScaffolds: (current.dynamicFacilitationScaffolds ?? []).map((item) => item.id === scaffold.id ? { ...item, status: "draft", filledContent: content, evidenceIds: [...submissions.map((item) => item.id), ...messages.map((item) => item.id), ...issues.map((item) => item.id)], updatedAt: now } : item),
  }), { actor: { id: auth.claims.sub!, role: "teacher" } });
  return Response.json({ content, evidenceIds: evidence.map((_, index) => index) });
}

export async function PATCH(request: Request) {
  const csrf = requireSameOrigin(request); if (csrf) return csrf;
  const auth = await authenticateRequest(request, "teacher"); if ("response" in auth) return auth.response;
  const body = await request.json().catch(() => null) as { courseId?: string; scaffoldId?: string } | null;
  if (!body?.courseId || !body.scaffoldId) return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  if (request.signal.aborted) return new Response(null, { status: 499 });
  if (!await canAccessLegacyCourse(auth.claims, body.courseId)) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const now = new Date().toISOString();
  await updateCourse(body.courseId, (course) => ({
    ...course,
    dynamicFacilitationScaffolds: (course.dynamicFacilitationScaffolds ?? []).map((item) => item.id === body.scaffoldId && item.status === "draft" ? { ...item, status: "teacher-confirmed", confirmedAt: now, updatedAt: now } : item),
  }), { actor: { id: auth.claims.sub!, role: "teacher" } });
  return Response.json({ ok: true });
}
