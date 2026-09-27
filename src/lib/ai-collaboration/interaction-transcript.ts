import type { AiInteractionEvent, CompanionThread } from "@/lib/session/types";

export type InteractionLocation = "sidebar" | "selection" | "paragraph-comment" | "submission";

export type StudentAiInteractionModification = {
  contributionId?: string;
  type: "edit-suggestion" | "work-delivery";
  title?: string;
  targetText?: string;
  replacement?: string;
  documentActions?: unknown[];
  decision?: "adopted" | "rejected" | "revision";
  decisionAt?: string;
  decisionSummary?: string;
  undoneAt?: string;
};

export type StudentAiInteractionMessage = {
  id: string;
  occurredAt: string;
  role: "student" | "ai" | "system";
  content: string;
  requestId?: string;
  responseKind?: string;
  modification?: StudentAiInteractionModification;
  error?: boolean;
};

/**
 * A "turn" is one contextual conversation, not one request/response pair.
 * The sidebar keeps the same turn until reset; every paragraph comment owns
 * an independent turn whose initial AI comment and all replies stay together.
 */
export type StudentAiInteractionTurn = {
  sequence: number;
  occurredAt: string;
  updatedAt: string;
  conversationId: string;
  turn: number;
  location: InteractionLocation;
  locationLabel: string;
  context?: {
    issueType?: string;
    targetText?: string;
    blockIndex?: number;
  };
  messages: StudentAiInteractionMessage[];
};

const LOCATION_LABELS: Record<InteractionLocation, string> = {
  sidebar: "侧边栏对话",
  selection: "正文选区编辑",
  "paragraph-comment": "段落批注区",
  submission: "成果提交",
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function eventTime(event: AiInteractionEvent): string {
  const occurredAt = text(record(event.payload).occurredAt);
  return occurredAt && Number.isFinite(Date.parse(occurredAt)) ? occurredAt : event.createdAt;
}

function locationFor(source: AiInteractionEvent["source"]): InteractionLocation {
  if (source === "selection") return "selection";
  if (source === "proactive-comment") return "paragraph-comment";
  if (source === "submission") return "submission";
  return "sidebar";
}

const PRACTICE_THREAD_KEYS = new Set([
  "ai-collaboration:make",
  "ai-collaboration-comments:make",
  "ai-collaboration:external-artifact:make",
  "ai-collaboration-comments:external-artifact:make",
  "ai-code-collaboration:make:python",
  "ai-code-comments:make:python",
  "ai-code-collaboration:make:c",
  "ai-code-comments:make:c",
]);

/** Messages were saved transactionally before the richer audit facts were
 * written. They also recover older conversations whose audit write failed. */
export function companionPracticeEvents(threads: readonly CompanionThread[]): AiInteractionEvent[] {
  return threads
    .filter(thread => PRACTICE_THREAD_KEYS.has(thread.stageKey))
    .flatMap(thread => thread.messages
      .filter(message => message.role === "student" || message.role === "agent")
      .map(message => ({
        id: `thread:${message.id}`,
        courseId: thread.courseId,
        studentId: thread.studentId,
        stageKey: "make",
        conversationId: message.conversationId || thread.id,
        source: thread.stageKey.includes("-comments:") ? "proactive-comment" as const : "sidebar" as const,
        eventType: message.role === "student" ? "request" as const : "response" as const,
        actorRole: message.role === "student" ? "student" as const : "ai" as const,
        actorId: message.authorId,
        content: message.content,
        payload: {
          workspaceKind: thread.stageKey.includes(":external-artifact:") ? "external-artifact" : "document",
          provenance: "companion-message",
        },
        createdAt: message.createdAt,
      })));
}

/** Prefer detailed audit events, filling only messages absent from that log. */
export function mergePracticeAiInteractionEvents(
  audited: readonly AiInteractionEvent[],
  messages: readonly AiInteractionEvent[],
): AiInteractionEvent[] {
  const key = (event: AiInteractionEvent) => JSON.stringify([
    event.studentId, event.conversationId, event.actorRole, event.content,
  ]);
  const auditedCounts = new Map<string, number>();
  for (const event of audited) {
    if ((event.actorRole !== "student" && event.actorRole !== "ai") || !event.content) continue;
    const signature = key(event);
    auditedCounts.set(signature, (auditedCounts.get(signature) ?? 0) + 1);
  }
  const missing = messages.filter(event => {
    const signature = key(event);
    const count = auditedCounts.get(signature) ?? 0;
    if (!count) return true;
    auditedCounts.set(signature, count - 1);
    return false;
  });
  return [...audited, ...missing]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

export function isVisibleAiInteractionEvent(event: AiInteractionEvent): boolean {
  const payload = record(event.payload);
  if (event.eventType === "policy" || event.source === "system") return false;
  if (payload.kind === "model-output") return false;
  if (payload.action === "read" || event.content === "学生阅读了段落批注。") return false;
  if (payload.action === "suggest-delegated-work") return false;
  return true;
}

export function isStudentVisibleAiInteractionEvent(event: AiInteractionEvent): boolean {
  return (event.actorRole === "student" || event.actorRole === "ai")
    && record(event.payload).visibility !== "teacher-only"
    && record(event.payload).kind !== "model-output";
}

function legacyCommentEvents(event: AiInteractionEvent): AiInteractionEvent[] | null {
  if (
    event.source !== "proactive-comment"
    || event.actorRole !== "ai"
    || event.eventType !== "comment"
  ) return null;
  const comments = record(event.payload).comments;
  if (!Array.isArray(comments) || !comments.length) return null;

  return comments.flatMap((value, index) => {
    const comment = record(value);
    const conversationId = text(comment.id);
    const threadComments = Array.isArray(comment.comments) ? comment.comments : [];
    const initial = threadComments
      .map((item) => record(item))
      .find((item) => item.role === "assistant" && text(item.content));
    const content = text(initial?.content);
    if (!conversationId || !content) return [];
    return [{
      ...event,
      id: `${event.id}:comment:${index}`,
      conversationId,
      content,
      payload: {
        commentThreadId: conversationId,
        targetText: text(comment.targetText),
        issueType: text(comment.issueType),
        blockIndex: typeof comment.blockIndex === "number" ? comment.blockIndex : undefined,
        initialComment: true,
      },
    }];
  });
}

function conversationLocation(events: AiInteractionEvent[]): InteractionLocation {
  if (events.some((event) => event.source === "proactive-comment")) return "paragraph-comment";
  if (events.some((event) => event.source === "sidebar")) return "sidebar";
  if (events.some((event) => event.source === "selection")) return "selection";
  return "submission";
}

function modificationFrom(event: AiInteractionEvent): StudentAiInteractionModification | undefined {
  const payload = record(event.payload);
  const suggestion = record(payload.suggestion);
  const deliverable = record(payload.deliverable);
  const contributionId = text(payload.contributionId);
  if (Object.keys(suggestion).length) {
    return {
      contributionId,
      type: "edit-suggestion",
      title: text(suggestion.title),
      targetText: text(suggestion.targetText),
      replacement: text(suggestion.replacement),
    };
  }
  if (Object.keys(deliverable).length) {
    return {
      contributionId,
      type: "work-delivery",
      title: text(deliverable.title),
      replacement: text(deliverable.content),
      documentActions: Array.isArray(deliverable.documentActions) ? deliverable.documentActions : undefined,
    };
  }
  return undefined;
}

export function buildStudentAiInteractionTurns(
  sourceEvents: readonly AiInteractionEvent[],
): StudentAiInteractionTurn[] {
  const events = sourceEvents
    .flatMap((event) => legacyCommentEvents(event) ?? [event])
    .filter(isVisibleAiInteractionEvent)
    .sort((left, right) => eventTime(left).localeCompare(eventTime(right)) || left.id.localeCompare(right.id));
  const grouped = new Map<string, AiInteractionEvent[]>();
  events.forEach((event) => {
    const conversationId = event.conversationId || `未标记对话:${event.id}`;
    grouped.set(conversationId, [...(grouped.get(conversationId) ?? []), event]);
  });

  const turns: StudentAiInteractionTurn[] = [];
  const contributionModifications = new Map<string, StudentAiInteractionModification>();
  const orderedGroups = [...grouped.entries()].sort(([, left], [, right]) =>
    eventTime(left[0]).localeCompare(eventTime(right[0]))
  );

  orderedGroups.forEach(([conversationId, conversationEvents], index) => {
    const location = conversationLocation(conversationEvents);
    const firstPayload = conversationEvents.map((event) => record(event.payload))
      .find((payload) => text(payload.targetText) || text(payload.issueType));
    const messages: StudentAiInteractionMessage[] = [];

    conversationEvents.forEach((event) => {
      const payload = record(event.payload);
      if (event.eventType === "decision") {
        const contributionId = text(payload.contributionId);
        const modification = contributionId ? contributionModifications.get(contributionId) : undefined;
        if (modification) {
          const decision = text(payload.decision);
          modification.decision = decision === "adopted" || decision === "revision" ? decision : "rejected";
          modification.decisionAt = eventTime(event);
          modification.decisionSummary = event.content;
        }
        return;
      }
      if (event.eventType === "undo") {
        const contributionId = text(payload.contributionId);
        const modification = contributionId ? contributionModifications.get(contributionId) : undefined;
        if (modification) modification.undoneAt = eventTime(event);
        return;
      }
      if (!event.content) return;

      const role = event.actorRole === "ai"
        ? "ai"
        : event.actorRole === "student"
          ? "student"
          : "system";
      const modification = modificationFrom(event);
      if (modification?.contributionId) {
        contributionModifications.set(modification.contributionId, modification);
      }
      messages.push({
        id: event.id,
        occurredAt: eventTime(event),
        role,
        content: event.content,
        ...(event.requestId ? { requestId: event.requestId } : {}),
        ...(text(payload.kind) ? { responseKind: text(payload.kind) } : {}),
        ...(modification ? { modification } : {}),
        ...(event.eventType === "error" ? { error: true } : {}),
      });
    });

    if (!messages.length) return;
    turns.push({
      sequence: turns.length + 1,
      occurredAt: eventTime(conversationEvents[0]),
      updatedAt: eventTime(conversationEvents[conversationEvents.length - 1]),
      conversationId: conversationId.startsWith("未标记对话:") ? "未标记对话" : conversationId,
      turn: index + 1,
      location,
      locationLabel: LOCATION_LABELS[location],
      ...(firstPayload ? {
        context: {
          issueType: text(firstPayload.issueType),
          targetText: text(firstPayload.targetText),
          blockIndex: typeof firstPayload.blockIndex === "number" ? firstPayload.blockIndex : undefined,
        },
      } : {}),
      messages,
    });
  });

  return turns.map((turn, index) => ({ ...turn, sequence: index + 1, turn: index + 1 }));
}

export function interactionLocationLabel(source: AiInteractionEvent["source"]): string {
  return LOCATION_LABELS[locationFor(source)];
}
