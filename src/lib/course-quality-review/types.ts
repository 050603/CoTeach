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

/** Shared teaching meaning supplied by the existing outline call, not another generation step. */
export type TeachingBrief = {
  schemaVersion: 1;
  explanation: string;
  examples: string[];
  conditions: string[];
  evidence: Array<{ sourceId: string; quote: string }>;
  assessmentFocus: string;
};
