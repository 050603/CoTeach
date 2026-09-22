export type ProjectSupportSource = {
  id: string;
  type: "textbook" | "web";
  title: string;
  locator?: string;
  excerpt: string;
  url?: string;
};

export type ProjectSupportDetails = {
  sources: ProjectSupportSource[];
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
      sources: sources.slice(0, 8),
      knowledgePointIds,
      knowledgePoints: knowledgePointIds.map((id) => ({ id, label: knowledgePointLabels[id] ?? id })),
      nextStep: clean(record.nextStep, 400) || undefined,
      retrievalStatus: retrieval.retrievalStatus,
      retrievalNote: retrieval.retrievalNote,
    },
    memoryCandidates,
  };
}

export function projectSupportJsonInstruction(): string {
  return [
    "响应 JSON 还必须包含 support 字段：",
    '{"knowledgePointIds":["仅填写本轮确实关联的课程知识点 ID"],"nextStep":"一个可验证的下一步；不需要时为空","memoryUpdates":[{"kind":"project-goal|student-decision|attempt-result|open-question","content":"从学生本轮原话中连续摘取、只记录下次仍有用的事实","rationale":"为何值得保留"}]}',
    "memoryUpdates 最多 2 条。AI 自己提出的建议、推测和未被学生采纳的方案不得写成学生决定；没有可靠新信息时返回空数组。",
  ].join("\n");
}
