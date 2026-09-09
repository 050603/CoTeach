import {
  companionMicroLessonStageContext,
  extractLearningRequestTopic,
  isCompanionMicroLessonStage,
} from "@/lib/adaptive-learning";
import { isAuthConfigured, readAuthFromRequest } from "@/lib/auth/session";
import { callLLM, parseLLMJson } from "@/lib/llm/client";
import { getCourse } from "@/lib/session/server-store";
import { canAccessLegacyCourse } from "@/lib/platform/access";
import {
  JSON_STUDENT_PROMPT_CONTRACT,
  promptStageLabel,
} from "@/lib/prompt-quality/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Decision = {
  decision: "brief-answer" | "systematic-lesson";
  topic: string;
  rationale: string;
  keyPoints: string[];
};

export async function POST(request: Request) {
  const body = await request.json().catch(() => null) as {
    courseId?: string;
    studentId?: string;
    stageKey?: string;
    message?: string;
  } | null;
  if (
    !body?.courseId ||
    !body.studentId ||
    !body.message?.trim() ||
    !isCompanionMicroLessonStage(body.stageKey ?? "")
  ) {
    return Response.json({ error: "INVALID_REQUEST" }, { status: 400 });
  }
  if (isAuthConfigured()) {
    const claims = await readAuthFromRequest(request, "student");
    if (
      !claims ||
      (claims.role === "student" &&
        claims.sub !== body.studentId)
    ) {
      return Response.json({ error: "FORBIDDEN" }, { status: 403 });
    }
    if (!(await canAccessLegacyCourse(claims, body.courseId, "write"))) {
      return Response.json({ error: "COURSE_LOCKED" }, { status: 403 });
    }
  }
  const course = await getCourse(body.courseId);
  if (!course) return Response.json({ error: "COURSE_NOT_FOUND" }, { status: 404 });
  const explicitTopic = extractLearningRequestTopic(body.message);

  const fallback: Decision = {
    decision:
      explicitTopic && (
        explicitTopic.length >= 4
        || /原理|方法|怎么|如何|系统|详细/.test(body.message)
      )
        ? "systematic-lesson"
        : "brief-answer",
    topic: explicitTopic ?? "",
    rationale: explicitTopic
      ? "根据请求的知识范围和当前项目阶段判断"
      : "当前请求不是明确的知识学习或教学解释需求",
    keyPoints: explicitTopic ? [explicitTopic] : [],
  };
  try {
    const raw = await callLLM([
      {
        role: "system",
        content: `你是项目课堂的伴学导演。判断学生的知识请求应该“仅告知”还是“系统讲解”。
仅告知：普通讨论、任务分工、创意发散、简单定义、单一事实或快捷操作，用 1-2 句话、45 秒内就能说清。
系统讲解：学生在检索知识、理解概念、辨析证据、追问原理/多个步骤/概念关系/易错点，无法用 1-2 句话说清，且内容适合形成 1-2 页、2-3 分钟微课。
不要因为消息较长就生成微课；只有教学化呈现明显优于直接对话时才选择 systematic-lesson。
topic、rationale、keyPoints 必须使用自然、准确的简体中文，不得出现阶段代码、内部字段名或中英混杂的流程术语。
只返回 JSON：{"decision":"brief-answer|systematic-lesson","topic":"精炼主题","rationale":"一句话","keyPoints":["2-4个讲解要点"]}

${JSON_STUDENT_PROMPT_CONTRACT}`,
      },
      {
        role: "user",
        content: JSON.stringify({
          course: course.name,
          stage: promptStageLabel(body.stageKey, companionMicroLessonStageContext(body.stageKey ?? "")),
          stageContext: companionMicroLessonStageContext(body.stageKey ?? ""),
          projectQuestion: course.drivingQuestion,
          request: body.message,
          recentWork: (course.submissions ?? [])
            .filter((item) => item.studentId === body.studentId)
            .slice(-2)
            .map((item) => item.content.replace(/<[^>]+>/g, " ").slice(0, 500)),
        }),
      },
    ], { jsonMode: true, abortSignal: request.signal });
    const parsed = parseLLMJson<Partial<Decision>>(raw);
    const decision: Decision = {
      decision:
        parsed.decision === "systematic-lesson" ? "systematic-lesson" : "brief-answer",
      topic: typeof parsed.topic === "string" && parsed.topic.trim() ? parsed.topic.trim() : fallback.topic,
      rationale:
        typeof parsed.rationale === "string" && parsed.rationale.trim()
          ? parsed.rationale.trim()
          : fallback.rationale,
      keyPoints: Array.isArray(parsed.keyPoints)
        ? parsed.keyPoints.filter((item): item is string => typeof item === "string").slice(0, 4)
        : fallback.keyPoints,
    };
    return Response.json({ decision });
  } catch {
    return Response.json({ decision: fallback });
  }
}
