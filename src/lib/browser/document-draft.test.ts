import { beforeEach, describe, expect, it } from 'vitest';
import { acknowledgeDocumentDraft, documentDraftKey, readDocumentDrafts, writeDocumentDraft } from './document-draft';

describe('durable document drafts', () => {
  beforeEach(() => localStorage.clear());
  it('recovers independent tabs and keeps newer edits when an old response arrives', () => {
    const a = { key: documentDraftKey('course:student:make'), scope: 'course:student:make', expectedVersion: 2, content: 'first', updatedAt: 1 };
    const b = { ...a, key: documentDraftKey(a.scope), content: 'other tab', updatedAt: 3 };
    writeDocumentDraft(a);
    writeDocumentDraft(b);
    writeDocumentDraft({ ...a, content: 'newer', updatedAt: 4 });
    acknowledgeDocumentDraft(a);
    expect(readDocumentDrafts(a.scope).map(draft => draft.content)).toEqual(['newer', 'other tab']);
    acknowledgeDocumentDraft(b);
    expect(readDocumentDrafts(a.scope).map(draft => draft.content)).toEqual(['newer']);
    expect(readDocumentDrafts('another-student')).toEqual([]);
  });
});
