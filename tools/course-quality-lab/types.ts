export type LabVariantKey = "baseline" | "enhanced";

export type ArtifactState = "pending" | "running" | "complete" | "failed" | "missing";

export type ReviewOutcome = "baseline" | "enhanced" | "tie" | "undecided";

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

export interface LabVariantResult {
  label?: string;
  statuses: {
    ppt: ArtifactStatus;
    script: ArtifactStatus;
    tts: ArtifactStatus;
  };
  slides: LabSlide[];
  script: LabScriptSegment[];
  quiz: LabQuizQuestion[];
  durationSec?: number;
  checks?: string[];
  downloads?: LabDownloadLinks;
}

export interface LabPair {
  id: string;
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
  coreExplanation?: string[];
  workedExample?: string[];
  conditionsAndMisconceptions?: string[];
  assessmentFocus?: string[];
  pagePlan?: Array<{ page: number; purpose: string }>;
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
  updatedAt?: string;
}

export interface ReviewCollection {
  reviews: PairReview[];
}
