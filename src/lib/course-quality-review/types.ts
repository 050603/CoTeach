export const COURSE_QUALITY_REVIEW_POLICY_VERSION = "textbook-guidance-v3-concept-responsibility";

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
  /** Invalidates reports produced by obsolete literal-coverage rules. */
  reviewPolicyVersion?: string;
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

export type TeachingDifficultyStrategy = {
  requirementId: string;
  learnerObstacle: string;
  teachingApproach: string;
  understandingEvidence: string;
};

export type TeachingKnowledgeReference = {
  id: string;
  name: string;
};

export type TeachingPrerequisiteReference = TeachingKnowledgeReference & {
  /** Evidence that this capability may be treated as pre-course knowledge. */
  priorKnowledgeEvidence?: string;
  /** Observable boundary used when the teacher needs to diagnose the prerequisite. */
  diagnosticBoundary?: string;
};

/**
 * Deterministic learner-state boundary for one cluster or page.
 *
 * Future knowledge may be named in an agenda, but it cannot be used as an
 * explanation dependency, example, comparison target, exercise, or assessment
 * premise until it moves into current/previously taught knowledge.
 */
export type TeachingLearningBoundary = {
  prerequisiteKnowledge: TeachingPrerequisiteReference[];
  previouslyTaughtKnowledge: TeachingKnowledgeReference[];
  currentKnowledge: TeachingKnowledgeReference[];
  futureKnowledge: TeachingKnowledgeReference[];
};

export type TeachingResourceNeed = {
  kind: "diagram" | "image" | "video" | "interactive";
  purpose: string;
  required: boolean;
  prompt?: string;
  durationSec?: number;
};

/**
 * Page-local decision about whether the final task is actually a useful
 * teaching context. Historical briefs may omit it; current authoring always
 * makes the decision explicitly so downstream generation cannot reintroduce
 * the project merely because it is present in the course-level request.
 */
export type TeachingTaskConnection = {
  mode: "none" | "helpful-context" | "direct-application";
  rationale: string;
};

/**
 * The meaning a page should make visible and the authoring form that is most
 * likely to make that meaning easy to inspect. The form remains a preference:
 * the slide generator may choose an equivalent native representation when the
 * actual data or available media makes it clearer.
 */
export type TeachingVisualRelationship = {
  kind: "comparison" | "process" | "causal" | "system" | "quantitative" | "sequence" | "spatial" | "statement";
  description: string;
  readingOrder: string[];
  preferredForm?: "text" | "table" | "chart" | "diagram" | "illustration" | "mixed";
  rationale?: string;
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
  /** Compiled from the confirmed course order; models may consume but never rewrite it. */
  learningBoundary?: TeachingLearningBoundary;
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
    visualRelationship?: TeachingVisualRelationship;
    /** Internal authoring gate; never printed or narrated to learners. */
    taskConnection?: TeachingTaskConnection;
  };
  explanation: string;
  examples: string[];
  conditions: string[];
  evidence: Array<{ sourceId: string; quote: string }>;
  assessmentFocus: string;
  understandingCriteria?: TeachingUnderstandingCriteria;
  resourceNeeds?: TeachingResourceNeed[];
  /** Teacher-private trace from unified requirements into this page. */
  requirementIds?: string[];
  difficultyStrategies?: TeachingDifficultyStrategy[];
  /** Aggregated after generation and shown only in the teacher review flow. */
  reviewItems?: TeacherReviewItem[];
};
