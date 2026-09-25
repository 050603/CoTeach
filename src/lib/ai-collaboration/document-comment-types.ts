export type DocumentAiComment = {
  id: string;
  role: 'student' | 'assistant';
  content: string;
  createdAt: string;
};

export type DocumentAiCommentStatus = 'open' | 'resolved' | 'deferred' | 'not-applicable' | 'invalidated';

export type DocumentAiCommentThread = {
  id: string;
  blockId?: string;
  blockIndex: number;
  blockText?: string;
  targetText: string;
  issueType?: string;
  issueKey?: string;
  severity?: 'critical' | 'improvement' | 'style';
  evidenceSource?: 'document' | 'course';
  evidenceQuote?: string;
  impact?: string;
  relatedAnchors?: Array<{ blockId?: string; blockIndex: number; targetText: string }>;
  comments: DocumentAiComment[];
  createdAt: string;
  readAt?: string;
  status?: DocumentAiCommentStatus;
  reviewVersion?: number;
};

/** Older threads have no status field; reading a comment never resolves it. */
export function documentAiCommentStatus(thread: DocumentAiCommentThread): DocumentAiCommentStatus {
  return thread.status ?? 'open';
}

export type DocumentAiCommentSuggestion = {
  operation: 'replace';
  title: string;
  targetText: string;
  replacement: string;
  reason: string;
};

export type DocumentAiCommentReplyResult = {
  kind: 'discussion' | 'edit-suggestion' | 'boundary';
  message: string;
  suggestion?: DocumentAiCommentSuggestion;
};

export type DocumentBlockCandidate = {
  blockId?: string;
  blockIndex: number;
  type: string;
  text: string;
};
