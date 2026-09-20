import type { CourseQualityIssue } from './types';

/** A browser measurement is evidence for teacher review, never a server validation. */
export type CourseRenderPageReview = {
  sceneId: string;
  checkedAt: string;
  status: 'completed' | 'failed';
  issues: CourseQualityIssue[];
};

export type CourseRenderReview = {
  schemaVersion: 1;
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
  return issues.filter((issue) => issue.severity === 'error' && issue.status !== 'resolved'
    && (issue.blocking === true || issue.origin === 'structure'));
}

export function reviewableIssues(issues: readonly CourseQualityIssue[]): CourseQualityIssue[] {
  return issues.filter((issue) => issue.status !== 'resolved'
    && !(issue.severity === 'error' && (issue.blocking === true || issue.origin === 'structure')));
}
