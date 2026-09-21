export type PublicDiscussionMode = "inquiry" | "debate";

export type PublicDiscussionStatus =
  | "inviting"
  | "awaiting-student"
  | "recording"
  | "transcribing"
  | "awaiting-retry"
  | "awaiting-confirmation"
  | "ai-generating"
  | "ai-ready"
  | "ai-completion-ready"
  | "awaiting-teacher-confirmation"
  | "ai-failed"
  | "awaiting-replacement"
  | "paused"
  | "summarizing"
  | "ended";

export type PublicDiscussionTurn = {
  id: string;
  sequence: number;
  role: "student" | "assistant" | "teacher";
  content: string;
  source: "voice" | "text" | "system";
  studentId?: string;
  studentName?: string;
  createdAt: string;
};
export type PublicDiscussionSummary = {
  keyConclusion: string;
  misconceptionRepair: string;
  transferQuestion: string;
};

export type PublicDiscussionCandidate = {
  studentId: string;
  studentName: string;
  online: boolean;
  reason: string;
  evidence: string;
  participationCount: number;
};

export type PublicDiscussionSnapshot = {
  enabled: boolean;
  session?: {
    id: string;
    courseId: string;
    knowledgePointId: string;
    topic: string;
    mode: PublicDiscussionMode;
    openingPrompt: string;
    status: PublicDiscussionStatus;
    version: number;
    roundCount: number;
    currentStudent?: { id: string; name: string };
    isCurrentStudent: boolean;
    turns: PublicDiscussionTurn[];
    summary?: PublicDiscussionSummary;
    createdAt: string;
    updatedAt: string;
    endedAt?: string;
    shouldSuggestSummary: boolean;
  };
  teacher?: {
    candidates: PublicDiscussionCandidate[];
    soundOwner: boolean;
    soundLeaseUntil?: string;
  };
};

export type PublicDiscussionRecommendation = {
  knowledgePointId: string;
  topic: string;
  openingPrompt: string;
  candidates: PublicDiscussionCandidate[];
};

export type PublicDiscussionSettings = {
  modelString?: string;
  asrProviderId?: string;
  asrModelId?: string;
  asrLanguage: string;
  ttsProviderId?: string;
  ttsModelId?: string;
  ttsVoice?: string;
  ttsSpeed: number;
};
