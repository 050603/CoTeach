/** Browser-safe contracts for private, page-scoped lecture questions. */
export type LectureChatPage = {
  classroomId: string;
  sceneId: string;
};

export type LectureChatPosition = {
  actionIndex: number;
  mediaTimeMs?: number;
};

export type LectureChatCitation = {
  id: string;
  textbookTitle: string;
  revisionId: string;
  sectionPath: string[];
  quote: string;
  sourceBlockId?: string;
};

export type LectureChatMessage = {
  id: string;
  role: 'student' | 'assistant';
  content: string;
  createdAt: string;
  requestId: string;
  position: LectureChatPosition;
  citations?: LectureChatCitation[];
};

export type LectureChatThread = {
  id: string;
  page: LectureChatPage;
  pageTitle: string;
  messages: LectureChatMessage[];
};

export type LectureChatRequestState = {
  requestId: string;
  status: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  error?: string;
};

export type LectureChatHistory = {
  thread: LectureChatThread;
  requests: LectureChatRequestState[];
  writable: boolean;
};

export type LectureChatInput = LectureChatPage & LectureChatPosition & {
  message: string;
  requestId: string;
};

export type LectureChatStreamEvent =
  | { type: 'status'; message: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; thread: LectureChatThread }
  | { type: 'error'; error: string; message: string };
