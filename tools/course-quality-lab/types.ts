export type LabVariantKey = "baseline" | "enhanced";

export type LabPipelineModule =
  | "planning"
  | "slide"
  | "narration"
  | "action"
  | "review"
  | "repair"
  | "quiz"
  | "tts";

export type LabTokenUsageSource = "provider-reported" | "estimated" | "mixed" | "unknown";

export type LabRepairScope = "element" | "segment" | "page" | "section";

export interface LabModuleMetrics {
  tokenUsage: number;
  tokenUsageSource: LabTokenUsageSource;
  inputCharacters: number;
  outputCharacters: number;
  calls: number;
  failedCalls: number;
  transportAttempts: number;
  transportRetries: number;
  elapsedMs: number;
}

export interface LabRepairEvent {
  module: string;
  scope: LabRepairScope;
  reason: string;
  targetIds: string[];
  outcome: "resolved" | "no-progress" | "regressed" | "escalated" | "failed";
  attempt: number;
}

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
  /** Exact authoritative excerpt required for confirmed factual contradictions. */
  sourceEvidence?: string;
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
  /** Explicit provenance for the aggregate. Archived logs without provenance remain unknown. */
  tokenUsageSource?: LabTokenUsageSource;
  /** Legacy display hint retained for archived manifests. */
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
  /** Pages accepted from their first model drafts without a quality repair. */
  firstPassPages?: number;
  /** Total teaching pages evaluated for first-pass quality. */
  evaluatedPages?: number;
  /** Non-model geometry/style normalizations applied before review. */
  deterministicAdjustments?: number;
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
  /** Per-module cost and latency, present for versioned pipeline telemetry. */
  moduleMetrics?: Partial<Record<LabPipelineModule, LabModuleMetrics>>;
  /** Sanitized repair decisions; prompts and raw model responses are never included. */
  repairEvents?: LabRepairEvent[];
  pipelineVersion?: string;
  /** Checkpoint artifact name -> producing module/schema version. */
  artifactVersions?: Record<string, string>;
}

export interface LabVariantResult {
  label?: string;
  /** Producing pipeline version, for example v4-clean or v5. */
  pipelineVersion?: string;
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
    /** V5 course position; absent in archived V4 contracts. */
    pageRole?: "opening" | "continuation" | "closing" | "single";
    /** V5 slide composition and explicit ownership of visible requirements. */
    visualPlan?: {
      structure: "comparison" | "process" | "case-reasoning" | "framework";
      regions: Array<{
        purpose: string;
        visibleRequirementIndexes: number[];
      }>;
      relationship: string;
    };
    /** Ordered V5 delivery steps. Indexes refer to requiredVisibleContent. */
    deliveryPlan?: Array<{
      id: string;
      function: "opening" | "knowledge" | "example" | "transition" | "closing";
      instruction: string;
      visibleRequirementIndexes: number[];
      targetUnits: number;
    }>;
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
