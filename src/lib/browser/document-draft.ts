import { clientUUID } from '@/lib/uuid';

export type PendingDocumentDraft = {
  key: string;
  scope: string;
  submissionId?: string;
  expectedVersion: number;
  content: string;
  updatedAt: number;
};
const prefix = 'openpbl:document-draft:v1:';

/** Each editor owns a separate key: another tab must never erase its unsent work. */
export function documentDraftKey(scope: string): string {
  return `${prefix}${encodeURIComponent(scope)}:${clientUUID()}`;
}

export function readDocumentDrafts(scope: string): PendingDocumentDraft[] {
  if (typeof window === 'undefined') return [];
  try {
    const result: PendingDocumentDraft[] = [];
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(`${prefix}${encodeURIComponent(scope)}:`)) continue;
      try {
        const value = JSON.parse(localStorage.getItem(key) ?? 'null');
        if (value?.scope === scope && value.key === key && typeof value.content === 'string'
          && Number.isInteger(value.expectedVersion) && value.expectedVersion >= 0
          && Number.isFinite(value.updatedAt)) result.push(value);
      } catch { /* A damaged entry must not hide other recoverable drafts. */ }
    }
    return result.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch { return []; }
}

/** Throws on quota/privacy failures; callers must not claim a durable local save. */
export function writeDocumentDraft(draft: PendingDocumentDraft): void {
  localStorage.setItem(draft.key, JSON.stringify(draft));
}

/** An old response may acknowledge only its own content, never a newer edit. */
export function acknowledgeDocumentDraft(draft: PendingDocumentDraft): void {
  const current = JSON.parse(localStorage.getItem(draft.key) ?? 'null');
  if (current?.content === draft.content && current?.updatedAt === draft.updatedAt) {
    localStorage.removeItem(draft.key);
  }
}
