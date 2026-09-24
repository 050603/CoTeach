import type { CourseQualityIssue } from './types';

export const COURSE_RENDER_REVIEW_POLICY_VERSION = 'render-visible-content-v2';

/** A browser measurement is evidence for teacher review, never a server validation. */
export type CourseRenderPageReview = {
  sceneId: string;
  checkedAt: string;
  status: 'completed' | 'failed';
  issues: CourseQualityIssue[];
};

export type CourseRenderReview = {
  schemaVersion: 1;
  reviewPolicyVersion?: string;
  runId?: string;
  signature: string;
  classroomId: string;
  status: 'pending' | 'running' | 'completed';
  pages: CourseRenderPageReview[];
  updatedAt: string;
};

export type CourseTeacherReview = {
  schemaVersion: 1;
  courseId: string;
  classroomId: string;
  signature: string;
  teacherId: string;
  confirmedAt: string;
  acceptedIssueIds: string[];
  manualContentReview?: boolean;
  /** Authenticates this server-issued confirmation when a template is copied. */
  seal: string;
};

export function unresolvedHardIssues(issues: readonly CourseQualityIssue[]): CourseQualityIssue[] {
  return issues.filter((issue) => issue.severity === 'error'
    && issue.status !== 'resolved'
    && issue.blocking === true);
}

export function reviewableIssues(issues: readonly CourseQualityIssue[]): CourseQualityIssue[] {
  return issues.filter((issue) => issue.status !== 'resolved'
    && !(issue.severity === 'error' && issue.blocking === true));
}
