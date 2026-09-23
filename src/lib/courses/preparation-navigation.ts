export function courseDetailedEditHref(courseId: string): string {
  return `/teacher/prepare/${encodeURIComponent(courseId)}/verify/edit`;
}

const ACTIVE_GENERATION_STATUSES = new Set([
  "queued",
  "running",
  "review_available",
  "paused",
  "cancelling",
]);

export type CourseLibraryStatus =
  | "published"
  | "completed-unpublished"
  | "incomplete"
  | "generating"
  | "archived";

type CourseLibraryStateInput = {
  archived?: boolean;
  generationStatus?: string | null;
  latestVersionStatus?: string | null;
  generationRun?: {
    scope?: string | null;
    status?: string | null;
  } | null;
};

export function isCourseGenerationActive(status?: string | null): boolean {
  return Boolean(status && ACTIVE_GENERATION_STATUSES.has(status.toLowerCase()));
}

export function courseLibraryStatus(input: CourseLibraryStateInput): CourseLibraryStatus {
  if (input.archived) return "archived";
  if (isCourseGenerationActive(input.generationStatus)) return "generating";
  if (input.latestVersionStatus?.toLowerCase() === "published") return "published";
  if (input.generationRun?.scope === "full-course" && input.generationRun.status === "completed") {
    return "completed-unpublished";
  }
  return "incomplete";
}

export function coursePreparationHref(courseId: string, status: CourseLibraryStatus): string {
  const encodedId = encodeURIComponent(courseId);
  return status === "generating" || status === "incomplete"
    ? `/teacher/prepare/${encodedId}/verify`
    : `/teacher/prepare/${encodedId}/preview`;
}
