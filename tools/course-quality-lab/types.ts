export type LabVariantKey = "baseline" | "enhanced";

export type ArtifactState = "pending" | "running" | "complete" | "failed" | "missing";

export type ReviewOutcome = "baseline" | "enhanced" | "tie" | "undecided";

export type TeacherReviewStatus = "pending" | "confirmed" | "needs-revision";

export type LabReviewIssueCategory =
  | "factual-grounding"
  | "knowledge-coverage"
  | "case-reasoning"
  | "slide-narration-alignment"
  | "narration-style"
  | "teacher-note-leak"
  | "cross-page-repetition";

export type LabReviewTargetType = "slide-element" | "speech-segment" | "teaching-requirement";

export interface LabReviewIssue {
  id: string;
  category: LabReviewIssueCategory;
  targetType: LabReviewTargetType;
  /** Existing element/speech id, or a stable requirement id for missing content. */
  targetId: string;
  /** Exact source text for an existing target; requirement text for missing content. */
  evidence: string;
  repair: string;
}

export interface LabTeacherReviewNote {
  /** Stable within one experiment generation so saved teacher decisions can bind safely. */
  id: string;
  /** One-based page number. */
  page: number;
  claim: string;
  reason: string;
  suggestion: string;
  origin: "design" | "content-review";
}

export interface TeacherReviewDecision {
  status: TeacherReviewStatus;
  note?: string;
}

export interface VariantTeacherReview {
  experimentId: string;
  variant: LabVariantKey;
  notes: Record<string, TeacherReviewDecision>;
}

export type ReviewDimension =
  | "explanationDepth"
  | "examples"
  | "teachingAssessmentAlignment"
  | "visualExpression"
  | "listeningExperience";

export interface ArtifactStatus {
  state: ArtifactState;
  message?: string;
  updatedAt?: string;
}

export interface LabDownloadLinks {
  pptx?: string;
  script?: string;
  audioZip?: string;
}

export interface LabSlide {
  id: string;
  title?: string;
  /** A URL served by the lab service. It may point to a PNG or an HTML render page. */
  renderUrl?: string;
  imageUrl?: string;
  narrationSegmentIds?: string[];
  checkMessages?: string[];
}

export interface LabScriptSegment {
  id: string;
  slideIndex: number;
  text: string;
  audioUrl?: string;
  durationSec?: number;
  audioStatus?: ArtifactStatus;
}

export interface LabQuizQuestion {
  id: string;
  prompt: string;
  answer: string;
  rationale?: string;
  sourceSegmentIds?: string[];
}

export interface LabVariantMetrics {
  /** Provider-reported total when available; otherwise the shared 2.5 chars/token estimate. */
  tokenUsage: number;
  tokenUsageEstimated: boolean;
  inputCharacters: number;
  outputCharacters: number;
  modelCalls: number;
  failedModelCalls: number;
  /** Actual provider requests, including transport retries inside one logical call. */
  transportAttempts: number;
  transportRetries: number;
  transportAttemptsRecorded: boolean;
  qualityRepairCalls: number;
  abandonedModelCalls: number;
  checkpointReuses: number;
  telemetryRecorded: boolean;
  wallClockMs: number;
  modelElapsedMs: number;
  designCalls: number;
  generationCalls: number;
  ttsCalls: number;
  failedTtsCalls: number;
  ttsElapsedMs: number;
  ttsCacheHits: number;
  audioBytes: number;
}

export interface LabVariantResult {
  label?: string;
  /** Base URL for this experiment's immutable-ish artifact set; absent on archived v1 manifests. */
  artifactBaseUrl?: string;
  statuses: {
    ppt: ArtifactStatus;
    script: ArtifactStatus;
    tts: ArtifactStatus;
  };
  slides: LabSlide[];
  script: LabScriptSegment[];
  quiz: LabQuizQuestion[];
  durationSec?: number;
  /** Runtime-derived cost and stability indicators. The lab server can backfill archived results. */
  metrics?: LabVariantMetrics;
  checks?: string[];
  /** Teacher-only reminders. A flagged claim may remain in student artifacts until the teacher reviews it. */
  teacherReviewNotes?: LabTeacherReviewNote[];
  downloads?: LabDownloadLinks;
}

export interface LabPair {
  id: string;
  experimentId?: string;
  batch: number;
  label?: string;
  createdAt?: string;
  variants: Record<LabVariantKey, LabVariantResult>;
}

export interface LabSource {
  title: string;
  detail?: string;
  url?: string;
}

export interface TeachingDesign {
  /** Legacy section-level fields are kept so older archived manifests remain readable. */
  coreExplanation?: string[];
  workedExample?: string[];
  conditionsAndMisconceptions?: string[];
  assessmentFocus?: string[];
  pagePlan?: Array<{
    page: number;
    purpose: string;
    priorKnowledge: string;
    newContent: string;
    explanation: string[];
    examples: string[];
    conditions: string[];
    /** Teaching claims/relationships that must remain visible on the slide. */
    requiredVisibleContent: string[];
    /** Reasoning/background assigned to narration instead of repeated on the slide. */
    narrationFocus: string[];
    /** Exact source excerpts selected for this page. */
    evidenceQuotes: string[];
    /** Deterministic budget supplied by the selected TTS voice profile. */
    narrationBudget?: {
      targetDurationSec: number;
      targetUnits: number;
      minUnits: number;
      maxUnits: number;
      unit: "cjk-char" | "latin-word" | "mixed-unit";
    };
    assessmentFocus: string[];
  }>;
  /** Kept outside pagePlan so student-facing prompts cannot receive review prose. */
  teacherReviewNotes?: LabTeacherReviewNote[];
}

export interface LabSection {
  id: string;
  title: string;
  scenario?: string;
  subject?: string;
  grade?: string;
  learningObjectives: string[];
  sources: LabSource[];
  enhancedDesign?: TeachingDesign;
  pairs: LabPair[];
}

export interface CourseQualityLabManifest {
  version: 1;
  generatedAt?: string;
  title?: string;
  ttsConfig?: {
    provider?: string;
    model?: string;
    voice?: string;
    language?: string;
    speed?: number;
  };
  sections: LabSection[];
}

export interface PairReview {
  pairId: string;
  outcome: ReviewOutcome;
  /** Scores are optional; omitted dimensions remain unrated. */
  dimensions: Partial<Record<ReviewDimension, number>>;
  /** Zero-based synchronized slide index -> note. */
  pageNotes: Record<string, string>;
  overallNote?: string;
  /** Optional for backwards compatibility with reviews saved before teacher review existed. */
  teacherReviews?: Partial<Record<LabVariantKey, VariantTeacherReview>>;
  updatedAt?: string;
}

export interface ReviewCollection {
  reviews: PairReview[];
}
