import type { Course } from "@/lib/session/types";
import { parseLLMJson } from "@/lib/llm/client";
import {
  buildAuthoritativeCourseContext,
  type DelegatedWorkDeliverable,
  type DelegatedWorkSource,
  type DocumentCollaborationResponse,
} from "./document-policy";

export type DelegatedWorkAssessment = {
  decision: "accepted" | "protected" | "clarify";
  taskTitle: string;
  reason: string;
  studentMessage: string;
  protectedLearningWork: string;
  studentResponsibility: string;
  proposedScope: string;
  needsWebResearch: boolean;
  searchQuery: string;
};

type DelegatedWorkRevision = {
  title: string;
  content: string;
};

type DelegatedWorkHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

type RawAssessment = Partial<Record<keyof DelegatedWorkAssessment, unknown>>;

type RawDelivery = {
  message?: unknown;
  focus?: unknown;
  deliverable?: {
    title?: unknown;
    summary?: unknown;
    content?: unknown;
    documentActions?: unknown;
    sourceIds?: unknown;
  };
};

/** Repair a malformed delivery once while leaving upstream call failures to the route. */
export async function generateDelegatedDeliveryWithRepair(
  generate: (repair: boolean) => Promise<string>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const parse = (raw: string): Record<string, unknown> => {
    const parsed = parseLLMJson<Record<string, unknown>>(raw);
    const deliverable = parsed?.deliverable;
    if (!deliverable || typeof deliverable !== "object" || Array.isArray(deliverable)
      || typeof (deliverable as Record<string, unknown>).content !== "string"
      || !(deliverable as Record<string, string>).content.trim()) {
      throw new Error("EMPTY_DELEGATED_DELIVERY");
    }
    return parsed;
  };
  const first = await generate(false);
  try {
    return parse(first);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn("[ai-collaboration] Delegated delivery needed one structure repair", error instanceof Error ? error.message : error);
  }
  const repaired = await generate(true);
  try {
    return parse(repaired);
  } catch (error) {
    if (signal?.aborted) throw error;
    console.warn("[ai-collaboration] Delegated delivery structure repair failed", error instanceof Error ? error.message : error);
    return {};
  }
}

type RawDocumentAction = {
  operation?: unknown;
  targetText?: unknown;
  content?: unknown;
  description?: unknown;
};

function cleanText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function boundedDocument(text: string): string {
  const cleaned = cleanText(text, 60_000);
  if (cleaned.length <= 10_000) return cleaned;
  return `${cleaned.slice(0, 5_500)}\n\n……（中间内容已省略）……\n\n${cleaned.slice(-4_400)}`;
}

function boundedHistory(history: DelegatedWorkHistoryMessage[] | undefined): string {
  return (history ?? [])
    .slice(-4)
    .map((item) => `${item.role === "user" ? "学生" : "AI 组员"}：${cleanText(item.content, 500)}`)
    .join("\n") || "（当前对话没有可用的近期内容）";
}

function studentFacingText(value: unknown, maxLength: number): string {
  return cleanText(value, maxLength)
    .replace(/学生必须/g, "你需要")
    .replace(/学生需要/g, "你需要")
    .replace(/学生需/g, "你需要")
    .replace(/学生应/g, "你可以")
    .replace(/学生/g, "你")
    .replace(/AI\s*可以/g, "我可以")
    .replace(/AI\s*可/g, "我可以")
    .replace(/AI\s*不能/g, "我不能")
    .replace(/\bprotected\b|\baccepted\b|\bclarify\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function buildDelegatedWorkStarterPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  documentText: string;
}): { system: string; user: string } {
  return {
    system: [
      "你是 PBL 项目小组中的 AI 组员。请根据项目要求和学生此刻的文稿，提出 3 项现在适合交给你的辅助工作。",
      "每项建议必须扎根于当前文档的实际内容或明显缺口，并且是 AI 可以独立完成、学生随后可以审阅的具体工作。三项建议应有差异，不能使用固定通用模板。",
      "不得建议代替学生完成本项目核心问题、关键调查与分析、关键方案、核心创作、核心结论、最终成果或最终提交。不要建议‘帮我推进项目’这类模糊任务。",
      "快捷建议是学生点击后直接发给 AI 的工作指令。每条必须说明 AI 可以立即独立完成并交付什么，不得反过来要求学生先写草稿、列候选、做判断或补作业。句式应类似‘把当前文稿中已有的……整理成……’，不要写‘请写出你的……，我再……’。",
      "每项使用 20—55 个汉字，说明明确交付物；不要解释推荐理由。",
      "只返回严格 JSON：{\"starters\":[\"建议一\",\"建议二\",\"建议三\"]}",
    ].join("\n"),
    user: [
      "【课程与项目要求】",
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      "",
      "【学生当前文稿】",
      boundedDocument(input.documentText) || "（文稿刚开始，目前为空）",
    ].join("\n"),
  };
}

export function normalizeDelegatedWorkStarters(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const starters = (raw as { starters?: unknown }).starters;
  if (!Array.isArray(starters)) return [];
  return [...new Set(starters
    .map((item) => studentFacingText(item, 90))
    .filter((item) => item.length >= 8 && !/[你您]/.test(item)))]
    .slice(0, 3);
}

export function buildDelegatedWorkStarterReviewPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  documentText: string;
  candidates: string[];
}): { system: string; user: string } {
  return {
    system: [
      "你是 PBL 项目的协作边界审核员。请审核 3 条拟展示给学生的‘安排工作’快捷建议，并直接输出安全的最终版本。",
      "必须逐条比较建议与当前课程的学习目标、预期成果和阶段任务。凡是会让 AI 代替学生完成核心学习工作，例如选题、关键资料调查与分析、提示词设计、核心创作、事实或偏见判断、关键方案、核心结论、完整成果，都必须改写为边缘性支持工作。",
      "改写后仍要具体、可独立交付、贴合当前文稿，不能退化成固定通用模板或空泛的‘帮助推进项目’。每条使用可直接点击发送的第一人称命令句，20—55 个汉字。",
      "这些句子是学生发给 AI 的工作指令，必须描述 AI 现在就能独立完成并交付的内容。不得要求学生先提供草稿、列出候选、完成判断或做完核心任务后再由 AI 检查；不得写‘请写出你的……，我将……’。若文稿尚早，可安排整理已有要求、制作记录模板、汇集非核心背景知识或列出资料来源类型等支持性工作。",
      "只返回严格 JSON：{\"starters\":[\"安全建议一\",\"安全建议二\",\"安全建议三\"]}",
    ].join("\n"),
    user: [
      "【课程与项目要求】",
      buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
      "",
      "【学生当前文稿】",
      boundedDocument(input.documentText) || "（文稿刚开始，目前为空）",
      "",
      "【待审核建议】",
      input.candidates.map((item, index) => `${index + 1}. ${cleanText(item, 90)}`).join("\n"),
    ].join("\n"),
  };
}

export function buildDelegatedWorkAssessmentPrompts(input: {
  course: Course;
  studentId: string;
  studentName: string;
  stageKey: string;
  request: string;
  documentText: string;
  history?: DelegatedWorkHistoryMessage[];
  revisionOf?: DelegatedWorkRevision;
}): { system: string; user: string } {
  const system = [
    "你是 PBL 项目小组的任务协调员。学生以组长身份向 AI 组员安排一项独立工作。你这一轮只判断能否接单，绝不执行任务。",
    "判断必须是项目情境化的，不能仅凭任务名称做固定黑白名单。比较这项任务与课程学习目标、驱动问题、预期成果、阶段任务和学生项目目标之间的关系。",
    "",
    "判断原则：",
    "1. protected：如果 AI 完成后会代替学生展示本项目主要要锻炼的能力，或直接产出核心问题、关键调查/分析、关键方案、核心创作、核心结论、完整成果、最终提交所需的主要证据，必须拒绝接单。",
    "2. accepted：只有当任务是边缘性、支持性、可核验的子任务，且完成后学生仍需亲自进行核心分析、取舍、创作、验证或结论形成时，才可接单。明确限定 AI 只完成哪一小块，以及学生必须保留什么工作。",
    "3. clarify：项目上下文或任务范围不足以可靠判断，或任务混合了可委派部分与核心部分时，先要求学生缩小范围或澄清，不执行任务。",
    "4. 同一项工作在不同项目中结论可以不同。例如：若项目本身训练资料检索与信息汇总，‘搜集资料并汇总’属于 protected；若项目核心是代码设计、实验论证或研究结论，资料检索可能只是 accepted 的辅助子任务，但资料可信度核验与核心综合仍由学生负责。",
    "5. needsWebResearch 是旧版兼容字段，本轮没有联网工具。一般知识可以基于模型知识完成；若任务必须核验实时事实或学生未提供的实测数据，只针对那项事实说明需要可靠材料，仍完成其余可交付部分。教材没有命中不能作为拒绝接单的理由。",
    "6. studentMessage 是唯一直接展示给学生的话。要像组员本人当面回应组长，使用‘我、你、我们’，不要使用‘学生、用户、评价模型、过程证据、protected、accepted、clarify’等后台或第三人称表达，不要复述内部判定过程。",
    "7. 若需要澄清，只问一个容易回答的具体问题，并提供 2—3 个贴合当前文档的选项；若拒绝核心任务，简短说明‘这部分需要由你完成’，随后提出一项我现在就能承担的辅助工作。",
    "",
    "只返回严格 JSON，不使用 Markdown 代码块：",
    '{"decision":"accepted|protected|clarify","taskTitle":"简短任务名","reason":"供系统留痕的内部判断依据","studentMessage":"直接对学生说的自然回应","protectedLearningWork":"本项目必须由学生保留的核心学习工作","studentResponsibility":"AI 完成后学生仍须亲自完成的内容","proposedScope":"AI 可以承担的精确范围；拒绝时写可替代的辅助范围","needsWebResearch":false,"searchQuery":""}',
  ].join("\n");
  const user = [
    `学生：${input.studentName}`,
    "【课程与项目要求（权威）】",
    buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
    "",
    "【正在形成的项目文档】",
    boundedDocument(input.documentText) || "（当前文档为空）",
    "",
    input.revisionOf
      ? `【上一次组员交付】\n标题：${cleanText(input.revisionOf.title, 120)}\n内容：${cleanText(input.revisionOf.content, 6_000)}\n`
      : "",
    "【当前对话最近内容】",
    boundedHistory(input.history),
    "",
    "【组长安排的工作】",
    cleanText(input.request, 1_200),
  ].filter(Boolean).join("\n");
  return { system, user };
}

export function normalizeDelegatedWorkAssessment(raw: RawAssessment): DelegatedWorkAssessment {
  const requestedDecision = cleanText(raw.decision, 30);
  const decision = requestedDecision === "accepted" || requestedDecision === "protected"
    ? requestedDecision
    : "clarify";
  return {
    decision,
    taskTitle: cleanText(raw.taskTitle, 100) || "小组辅助工作",
    reason: cleanText(raw.reason, 800) || "当前信息不足以可靠判断这项工作是否适合委派给 AI。",
    studentMessage: studentFacingText(raw.studentMessage, 1_000),
    protectedLearningWork: cleanText(raw.protectedLearningWork, 600) || "项目的核心分析、判断与成果责任",
    studentResponsibility: cleanText(raw.studentResponsibility, 600) || "核验材料并完成项目的核心判断",
    proposedScope: cleanText(raw.proposedScope, 800) || "请缩小任务范围并说明希望 AI 承担的辅助部分。",
    needsWebResearch: raw.needsWebResearch === true,
    searchQuery: cleanText(raw.searchQuery, 500),
  };
}

export function assessmentToBoundaryResponse(
  assessment: DelegatedWorkAssessment,
): DocumentCollaborationResponse {
  const protectedTask = assessment.decision === "protected";
  const fallbackMessage = protectedTask
    ? `这部分需要由你亲自完成，因为它关系到项目的核心学习目标。我可以先帮你完成这项辅助工作：${studentFacingText(assessment.proposedScope, 500)}`
    : `我还不能确定你希望我具体完成哪一小块。你可以从这个范围开始说明：${studentFacingText(assessment.proposedScope, 500)}`;
  return {
    kind: protectedTask ? "boundary" : "task-clarification",
    message: assessment.studentMessage || fallbackMessage,
    focus: assessment.taskTitle,
    delegation: {
      decision: assessment.decision,
      reason: assessment.reason,
      protectedLearningWork: assessment.protectedLearningWork,
      studentResponsibility: assessment.studentResponsibility,
    },
  };
}

export function buildDelegatedWorkExecutionPrompts(input: {
  course: Course;
  studentId: string;
  stageKey: string;
  request: string;
  documentText: string;
  assessment: DelegatedWorkAssessment;
  history?: DelegatedWorkHistoryMessage[];
  researchContext?: string;
  revisionOf?: DelegatedWorkRevision;
}): { system: string; user: string } {
  const system = [
    "你是项目小组中的 AI 组员。任务协调员已经确认这是一项可委派的辅助工作。现在完成精确范围内的实际工作，并像真人组员一样向组长提交可审阅的交付物。",
    "不得扩大范围，不得触碰被保留给学生的核心学习工作，不得替学生形成最终判断或完整成果。输出应当能节省机械劳动，同时仍要求学生核验、取舍并决定是否纳入项目文档。",
    "可以运用模型已有知识完成辅助任务；教材片段是可选依据。实际使用的教材来源 ID 只填写在 deliverable.sourceIds，不要把内部 ID 写进交付内容或给学生看的话。不得声称浏览过网页，不得编造来源、学生实测数据或实时事实。无法确认的具体事实要标为‘待核验’，但不要因教材缺失而放弃能完成的内容。",
    "交付内容不包含未确认的评分规则、权重、比例或自动评分结论；仅围绕已明确的任务和作品提供帮助。",
    "交付内容使用简洁 Markdown，可包含标题、列表和表格。不要写成聊天回复，不要包含‘已写入文档’之类的表述。",
    "不要在交付内容末尾附加‘学生需核验、加入前核验、学习责任’等说教式模块；某项事实不确定时，只在对应内容旁简短标注‘待确认’。",
    "你还要像能独立工作的真实组员一样决定这份交付如何进入当前文档，而不是要求学生移动光标或帮你寻找位置。用 documentActions 给出最多 4 个可执行操作：append（文末追加）、insert-before/insert-after（在指定段落前后插入）、replace（替换整个指定段落）、delete（删除整个指定段落）、none（本次只交付资料，不改文档）。",
    "除 append 和 none 外，targetText 必须逐字复制当前文档中的一个完整段落，不能概括、截断或自行创造；content 使用 Markdown。replace/delete 只用于任务确实要求且不涉及学生核心判断的内容。找不到可靠位置时使用 append，不得把定位工作交回给学生。",
    "message 要直接对学生说话，使用‘我、你、我们’，不要出现‘学生需核验、评价模型、过程证据、accepted’等后台措辞。",
    "只返回严格 JSON，不使用 Markdown 代码块：",
    '{"message":"像组员一样直接向学生说明完成了什么","focus":"本次交付焦点","deliverable":{"title":"交付物标题","summary":"一句话摘要","content":"可独立审阅的 Markdown 内容","sourceIds":["交付物实际使用的教材来源 ID；没有则为空"],"documentActions":[{"operation":"append|insert-before|insert-after|replace|delete|none","targetText":"需要定位时逐字复制完整段落，否则为空","content":"该操作要写入的 Markdown；delete/none 时为空","description":"直接告诉学生将对文档做什么"}]}}',
  ].join("\n");
  const user = [
    "【已批准的委派边界】",
    `任务：${input.assessment.taskTitle}`,
    `AI 只负责：${input.assessment.proposedScope}`,
    `学生保留：${input.assessment.studentResponsibility}`,
    `判断依据：${input.assessment.reason}`,
    "",
    "【课程与项目要求（权威）】",
    buildAuthoritativeCourseContext(input.course, input.studentId, input.stageKey),
    "",
    "【组长原始安排】",
    cleanText(input.request, 1_200),
    "",
    input.revisionOf
      ? `【需要修改的上一次交付】\n标题：${cleanText(input.revisionOf.title, 120)}\n${cleanText(input.revisionOf.content, 6_000)}\n`
      : "",
    "【当前项目文档】",
    boundedDocument(input.documentText) || "（当前文档为空）",
    "",
    "【当前对话最近内容】",
    boundedHistory(input.history),
    "",
    "【可选教材依据】",
    input.researchContext || "（没有教材依据；运用已有知识完成可完成的部分）",
  ].filter(Boolean).join("\n");
  return { system, user };
}

function normalizeDocumentActions(
  value: unknown,
  fallbackContent: string,
): DelegatedWorkDeliverable["documentActions"] {
  type DocumentAction = DelegatedWorkDeliverable["documentActions"][number];
  const allowedOperations = new Set<DocumentAction["operation"]>([
    "append",
    "insert-before",
    "insert-after",
    "replace",
    "delete",
    "none",
  ]);
  const actions: DocumentAction[] = [];
  for (const rawItem of (Array.isArray(value) ? value : []).slice(0, 4)) {
      const item = rawItem && typeof rawItem === "object"
        ? rawItem as RawDocumentAction
        : {};
      const requestedOperation = cleanText(item.operation, 30);
      if (!allowedOperations.has(requestedOperation as DocumentAction["operation"])) continue;
      const operation = requestedOperation as DocumentAction["operation"];
      const targetText = cleanText(item.targetText, 2_000);
      const content = cleanText(item.content, 8_000);
      const valid = operation === "append"
        ? Boolean(content)
        : operation === "none"
          ? true
          : operation === "delete"
            ? Boolean(targetText)
            : Boolean(targetText && content);
      if (!valid) continue;
      const defaultDescription = operation === "append"
        ? "在文档末尾加入本次组员交付"
        : operation === "insert-before"
          ? "在指定段落前加入新内容"
          : operation === "insert-after"
            ? "在指定段落后加入新内容"
            : operation === "replace"
              ? "用本次交付替换指定段落"
              : operation === "delete"
                ? "删除指定段落"
                : "本次只提交资料，不修改文档";
      actions.push({
        operation,
        targetText,
        content: operation === "delete" || operation === "none" ? "" : content,
        description: studentFacingText(item.description, 300) || defaultDescription,
      });
  }
  return actions.length ? actions : [{
    operation: "append",
    targetText: "",
    content: fallbackContent,
    description: "在文档末尾加入本次组员交付",
  }];
}

export function normalizeDelegatedWorkDelivery(input: {
  raw: RawDelivery;
  assessment: DelegatedWorkAssessment;
  sources?: DelegatedWorkSource[];
  researchMode: DelegatedWorkDeliverable["researchMode"];
}): DocumentCollaborationResponse {
  const rawDelivery = input.raw.deliverable;
  const content = cleanText(rawDelivery?.content, 8_000);
  if (!content) {
    return {
      kind: "task-clarification",
      message: "这次内容生成未完成，请重试。",
      focus: input.assessment.taskTitle,
      delegation: {
        decision: "unavailable",
        reason: "模型没有返回可审阅的交付内容。",
        protectedLearningWork: input.assessment.protectedLearningWork,
        studentResponsibility: input.assessment.studentResponsibility,
      },
    };
  }
  const title = cleanText(rawDelivery?.title, 120) || input.assessment.taskTitle;
  const allowedSources = new Map((input.sources ?? []).filter((source) => source.id).map((source) => [source.id, source]));
  const usedSourceIds = Array.isArray(rawDelivery?.sourceIds)
    ? [...new Set(rawDelivery.sourceIds.filter((id): id is string => typeof id === "string" && allowedSources.has(id)))].slice(0, 5)
    : [];
  const usedSources = usedSourceIds.flatMap((id) => allowedSources.get(id) ?? []);
  const documentActions = normalizeDocumentActions(rawDelivery?.documentActions, content);
  const changesDocument = documentActions.some((action) => action.operation !== "none");
  return {
    kind: "work-delivery",
    message: changesDocument
      ? `我已经完成“${title}”，也规划好了它在当前文档中的具体改动。你先看一下交付内容，确认后我再一次性应用。`
      : `我已经完成“${title}”。这次交付只作为参考资料，不会改动当前文档。`,
    focus: cleanText(input.raw.focus, 160) || input.assessment.taskTitle,
    delegation: {
      decision: "accepted",
      reason: input.assessment.reason,
      protectedLearningWork: input.assessment.protectedLearningWork,
      studentResponsibility: input.assessment.studentResponsibility,
    },
    deliverable: {
      title,
      summary: studentFacingText(rawDelivery?.summary, 500) || "我已经完成这项辅助工作，等你决定是否采用。",
      content,
      documentActions,
      sources: usedSources,
      researchMode: usedSources.length ? "textbook" : "model",
    },
  };
}
