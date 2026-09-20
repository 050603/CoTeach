/** Teacher-private authoring diagnostics. A completed check is not a quality score. */
export type CourseQualityIssue = {
  id: string;
  origin: "semantic" | "render" | "structure";
  severity: "error" | "suggestion";
  sceneId?: string;
  elementId?: string;
  questionId?: string;
  title: string;
  evidence: string;
  suggestion: string;
  status?: "open" | "resolved" | "accepted";
  /** Deterministic, teacher-visible problem that prevents publishing the current revision. */
  blocking?: boolean;
};

export type CourseQualityReport = {
  schemaVersion: 1;
  signature: string;
  courseId: string;
  classroomId: string;
  classroomRevision: number;
  /** Exact model used by the optional post-generation semantic reviewer. */
  reviewModelString?: string;
  status: "pending" | "running" | "completed" | "failed";
  issues: CourseQualityIssue[];
  sections?: Array<{ id: string; sceneIds: string[]; status: "pending" | "completed" | "failed"; issues: CourseQualityIssue[]; checkedAt?: string; error?: string }>;
  sourceCoverage?: { totalChars: number; perSectionLimit: number; partial: boolean };
  checkedAt?: string;
  error?: string;
};

/** Stable section-level meaning reused by every page, narration, and check. */
export type SharedTeachingContext = {
  learningPurpose: string;
  /** Optional stable identifier when the section reuses one concrete case. */
  caseId: string;
  /** Actions, observations, or results that later judgments may rely on. */
  caseFacts: string[];
  /** Exact case sentences that must not drift between pages. */
  fixedWording: string[];
  /** Step names and technical terms that remain stable across the section. */
  stableTerms: string[];
  /** Necessary distinctions, qualifications, and non-equivalences. */
  conceptBoundaries: string[];
};

export type PageLearningTask = {
  learnerAction: string;
  newContribution: string;
  reasoningFocus: string;
  caseUse: "introduce" | "reuse" | "variant" | "independent";
  changedConditions: string[];
  preservedConditions: string[];
};

/** Defined during section design and kept stable while concrete quiz items are authored later. */
export type TeachingUnderstandingCriteria = {
  goals: string[];
  answerEssentials: string[];
  misconceptions: string[];
  supportingUnitIds: string[];
};

export type TeachingResourceNeed = {
  kind: "diagram" | "image" | "video" | "interactive";
  purpose: string;
  required: boolean;
  prompt?: string;
  durationSec?: number;
};

/**
 * Teacher-private provenance for content that may be useful in class but is
 * not fully established by the supplied course material. These records never
 * become learner-facing labels or narration.
 */
export type TeacherReviewItem = {
  id: string;
  kind: "illustrative-data" | "constructed-example" | "unverified-claim";
  provenance: "course-source" | "derived" | "general-knowledge" | "constructed" | "unverified";
  content: string;
  teachingPurpose: string;
  source?: string;
  values?: Array<{ value: string; unit?: string; label?: string }>;
  comparisonObjects?: string[];
  sectionId?: string;
  outlineId?: string;
  sceneId?: string;
  elementId?: string;
  narrationSegmentId?: string;
};

export type TeacherReviewVersion = {
  generationPolicyVersion: string;
  classroomId: string;
  classroomRevision?: number;
  generatedAt: string;
};

/** Shared teaching meaning supplied by the existing outline call, not another generation step. */
export type TeachingBrief = {
  schemaVersion: 1;
  designVersion?: string;
  sharedContext?: SharedTeachingContext;
  pageTask?: PageLearningTask;
  teachingPlan?: {
    purpose: string;
    priorKnowledge: string;
    newContent: string;
    learnerQuestion: string;
    reasoningSteps: string[];
    takeaway: string;
    visibleContent: string[];
    narrationFocus: string[];
    /** Actual learner-facing entry and the reasoning bridge into new content. */
    entryPoint?: {
      kind: "familiar-experience" | "concrete-observation" | "problem" | "direct-explanation" | "continuation";
      object: string;
      bridge: string;
    };
    /** Stable explanation ownership inherited from the teaching blueprint. */
    introduces?: string[];
    deepens?: string[];
    references?: string[];
    /** The relationship the slide should make visible, without prescribing a layout template. */
    visualRelationship?: {
      kind: "comparison" | "process" | "causal" | "system" | "quantitative" | "sequence" | "spatial" | "statement";
      description: string;
      readingOrder: string[];
    };
  };
  explanation: string;
  examples: string[];
  conditions: string[];
  evidence: Array<{ sourceId: string; quote: string }>;
  assessmentFocus: string;
  understandingCriteria?: TeachingUnderstandingCriteria;
  resourceNeeds?: TeachingResourceNeed[];
  /** Aggregated after generation and shown only in the teacher review flow. */
  reviewItems?: TeacherReviewItem[];
};
