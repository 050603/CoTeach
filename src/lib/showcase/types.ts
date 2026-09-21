import type {
  FinalArtifactSummary,
  ShowcaseDisplayMode,
  ShowcasePresentationSnapshot,
} from "@/lib/session/types";

export type ShowcaseQueueItemStatus =
  | "not-ready"
  | "waiting"
  | "called"
  | "pending-approval"
  | "presenting"
  | "evaluating"
  | "rejected"
  | "completed";

export type ShowcaseQueueItem = {
  studentId: string;
  studentName: string;
  groupId?: string;
  position: number;
  status: ShowcaseQueueItemStatus;
  artifacts: FinalArtifactSummary[];
  primaryArtifactTitle?: string;
  readyAt?: string;
  presentationId?: string;
  startedAt?: string;
  endedAt?: string;
  evaluatedAt?: string;
  evaluationNote?: string;
  estimatedWaitMinutes?: number;
};

export type ShowcaseQueueConfig = {
  schemaVersion: 1 | 2;
  selectionMode?: "teacher-selected";
  selectedStudentIds?: string[];
  presentationSec?: number;
  discussionSec?: number;
  transitionSec?: number;
  /** Presenter count explicitly requested by the confirmed resource package. */
  presenterCount?: number;
  orderedStudentIds: string[];
  minutesPerStudent: number;
  updatedAt: string;
};

export type ShowcaseStudentSummary = {
  studentId: string;
  name: string;
  groupId?: string;
  isAssigned: boolean;
  artifacts: FinalArtifactSummary[];
  /** First time this student submitted any document/PDF that can be shown. */
  firstPresentableSubmissionAt?: string;
};

export type ShowcaseData = {
  courseId: string;
  stageKey: string;
  presentingGroupId?: string | null;
  presentingStudentId?: string | null;
  presentingStudentName?: string;
  students: ShowcaseStudentSummary[];
  ownArtifacts: FinalArtifactSummary[];
  /** Active teacher-side projection. Student responses intentionally omit it. */
  activePresentation?: ShowcasePresentationSnapshot | null;
  /** The current student's own history, or all teacher-visible presentation records. */
  presentations: ShowcasePresentationSnapshot[];
  queue: ShowcaseQueueItem[];
  minutesPerStudent: number;
  queueConfig?: ShowcaseQueueConfig;
  budget?: { stageRemainingSec: number; plannedRemainingSec: number; overrunSec: number };
  currentQueueItem?: ShowcaseQueueItem | null;
  nextQueueItem?: ShowcaseQueueItem | null;
};

export type ShowcaseAction =
  | {
      action: "assign";
      groupId: string | null;
      studentId?: string | null;
    }
  | {
      action: "save-queue";
      orderedStudentIds: string[];
      minutesPerStudent: number;
      selectionMode?: "teacher-selected";
      selectedStudentIds?: string[];
      presentationSec?: number;
      discussionSec?: number;
      transitionSec?: number;
      presenterCount?: number;
    }
  | {
      action: "start";
      studentId: string;
      artifactKind: "document" | "pdf";
      artifactVersionId: string;
      displayMode: ShowcaseDisplayMode;
    }
  | {
      action: "end";
      presentationId: string;
    }
  | {
      action: "finish-evaluation";
      presentationId: string;
      note?: string | null;
    };

export type ShowcaseEventPayload = {
  scope?: "course" | "student";
  studentId?: string;
  snapshot?: ShowcasePresentationSnapshot;
  presentingGroupId?: string | null;
  presentingStudentId?: string | null;
  presentingStudentName?: string;
  queue?: ShowcaseQueueItem[];
  minutesPerStudent?: number;
};
