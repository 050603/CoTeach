export type ProjectSupportSource = {
  id: string;
  type: "textbook" | "web";
  title: string;
  locator?: string;
  excerpt: string;
  url?: string;
};

export type ProjectReplyBlock = {
  type: "answer" | "analysis" | "reason" | "suggestion" | "next-step";
  content: string;
  sourceIds: string[];
};

export type ProjectSupportDetails = {
  sources: ProjectSupportSource[];
  replyBlocks?: ProjectReplyBlock[];
  knowledgePointIds: string[];
  knowledgePoints: Array<{ id: string; label: string }>;
  nextStep?: string;
  retrievalStatus:
    | "not-needed"
    | "textbook-supported"
    | "web-supplemented"
    | "unavailable";
  retrievalNote?: string;
};

export type ProjectMemoryKind =
  | "project-goal"
  | "student-decision"
  | "attempt-result"
  | "open-question";

export type ProjectMemoryEntry = {
  id: string;
  kind: ProjectMemoryKind;
  content: string;
  rationale?: string;
  stageKey: string;
  sourceMessageIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type ProjectMemoryCandidate = {
  kind: ProjectMemoryKind;
  content: string;
  rationale?: string;
};

const memoryKinds = new Set<ProjectMemoryKind>([
  "project-goal",
  "student-decision",
  "attempt-result",
  "open-question",
]);
const replyBlockKinds = new Set<ProjectReplyBlock["type"]>([
  "answer", "analysis", "reason", "suggestion", "next-step",
]);

function clean(value: unknown, maxLength: number): string {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, maxLength)
    : "";
}

export function normalizeProjectSupportOutput(
  value: unknown,
  sources: ProjectSupportSource[],
  retrieval: Pick<ProjectSupportDetails, "retrievalStatus" | "retrievalNote">,
  knowledgePointLabels: Record<string, string> = {},
): { details: ProjectSupportDetails; memoryCandidates: ProjectMemoryCandidate[] } {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const requestedKnowledgePointIds = Array.isArray(record.knowledgePointIds)
    ? [...new Set(record.knowledgePointIds
      .filter((item): item is string => typeof item === "string")
      .map((item) => clean(item, 120))
      .filter(Boolean))].slice(0, 6)
    : [];
  const knowledgePointIds = requestedKnowledgePointIds.filter((id) => id in knowledgePointLabels);
  const availableSources = new Map(sources.map((source) => [source.id, source]));
  const requestedSourceIds = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && availableSources.has(id))
    : [];
  const replyBlocks: ProjectReplyBlock[] = Array.isArray(record.replyBlocks)
    ? record.replyBlocks.slice(0, 5).flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const block = item as Record<string, unknown>;
      const type = clean(block.type, 32) as ProjectReplyBlock["type"];
      const content = clean(block.content, 1_600)
        .replace(/^(?:观察|具体观察|可执行支架|下一步验证|现状分析|为什么|建议做法|下一步)\s*[：:]\s*/u, "");
      if (!replyBlockKinds.has(type) || !content) return [];
      return [{ type, content, sourceIds: [...new Set(requestedSourceIds(block.sourceIds))].slice(0, 5) }];
    })
    : [];
  const usedSourceIds = [...new Set([
    ...requestedSourceIds(record.sourceIds),
    ...replyBlocks.flatMap((block) => block.sourceIds),
  ])].slice(0, 5);
  const memoryCandidates = Array.isArray(record.memoryUpdates)
    ? record.memoryUpdates.flatMap((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const candidate = item as Record<string, unknown>;
      const kind = clean(candidate.kind, 40) as ProjectMemoryKind;
      const content = clean(candidate.content, 500);
      if (!memoryKinds.has(kind) || !content) return [];
      return [{
        kind,
        content,
        rationale: clean(candidate.rationale, 300) || undefined,
      } satisfies ProjectMemoryCandidate];
    }).slice(0, 2)
    : [];
  return {
    details: {
      sources: usedSourceIds.flatMap((id) => availableSources.get(id) ?? []),
      ...(replyBlocks.length ? { replyBlocks } : {}),
      knowledgePointIds,
      knowledgePoints: knowledgePointIds.map((id) => ({ id, label: knowledgePointLabels[id] ?? id })),
      nextStep: replyBlocks.some((block) => block.type === "next-step")
        ? undefined
        : clean(record.nextStep, 400) || undefined,
      retrievalStatus: retrieval.retrievalStatus,
      retrievalNote: retrieval.retrievalNote,
    },
    memoryCandidates,
  };
}

export function projectSupportJsonInstruction(): string {
  return [
    "响应 JSON 还必须包含 support 字段：",
    '{"replyBlocks":[{"type":"answer|analysis|reason|suggestion|next-step","content":"给学生看的正文，不要写观察、支架等标签","sourceIds":["本段实际使用的教材来源 ID"]}],"sourceIds":["整条回答实际使用的教材来源 ID"],"knowledgePointIds":["仅填写本轮确实关联的课程知识点 ID"],"nextStep":"仅在 replyBlocks 没有 next-step 时填写；不需要时为空","memoryUpdates":[{"kind":"project-goal|student-decision|attempt-result|open-question","content":"从学生本轮原话中连续摘取、只记录下次仍有用的事实","rationale":"为何值得保留"}]}',
    "简单问题只需一个 answer 分块；复杂问题用 2 至 4 块，不要为凑格式重复内容。message 保留简短纯文本，分块承载详细内容。只能引用本轮服务端提供的来源 ID；没有用到教材时返回空 sourceIds，不要编造出处。",
    "memoryUpdates 最多 2 条。AI 自己提出的建议、推测和未被学生采纳的方案不得写成学生决定；没有可靠新信息时返回空数组。",
  ].join("\n");
}
