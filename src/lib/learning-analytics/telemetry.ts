import { boundedFetch } from "@/lib/browser/bounded-fetch";
import type { LearningEvent, LearningEventType } from "@/lib/session/types";

export const RESOURCE_PROGRESS_THRESHOLDS = [25, 50, 75, 100] as const;

/** Return only coarse milestones crossed between two progress readings. */
export function crossedResourceProgressThresholds(previous: number, current: number): number[] {
  const from = Math.max(0, Math.min(100, Math.floor(previous)));
  const to = Math.max(0, Math.min(100, Math.floor(current)));
  if (to <= from) return [];
  return RESOURCE_PROGRESS_THRESHOLDS.filter((threshold) => threshold > from && threshold <= to);
}

export function resourceEventIdempotencyKey(
  courseId: string,
  studentId: string,
  resourceId: string,
  type: "open" | "progress" | "complete",
  milestone?: number,
  source: "student" | "teacher-projection" = "student",
): string {
  return ["resource", courseId, studentId, resourceId, source, type, milestone ?? "once"].join(":");
}

export type LearningEventDraft = Omit<LearningEvent, "id" | "idempotencyKey" | "occurredAt"> & {
  occurredAt?: string;
  idempotencyKey?: string;
};

function clientId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

export function createLearningEvent(
  type: LearningEventType,
  draft: Omit<LearningEventDraft, "type">,
): LearningEvent {
  const id = clientId();
  return {
    ...draft,
    id,
    type,
    occurredAt: draft.occurredAt ?? new Date().toISOString(),
    idempotencyKey: draft.idempotencyKey ?? id,
  };
}

export async function postLearningEvents(input: {
  courseId: string;
  studentId: string;
  events: LearningEvent[];
}): Promise<void> {
  if (!input.events.length) return;
  const response = await boundedFetch("/api/learning-events", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-OpenPBL-Role": "student",
    },
    body: JSON.stringify(input),
    keepalive: true,
  });
  if (!response.ok) throw new Error(`学习事件上报失败（HTTP ${response.status}）`);
}
