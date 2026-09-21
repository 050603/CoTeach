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

export function isCourseGenerationActive(status?: string | null): boolean {
  return Boolean(status && ACTIVE_GENERATION_STATUSES.has(status.toLowerCase()));
}

export function coursePreparationHref(courseId: string, generationStatus?: string | null): string {
  const encodedId = encodeURIComponent(courseId);
  return isCourseGenerationActive(generationStatus)
    ? `/teacher/prepare/${encodedId}/verify`
    : `/teacher/prepare/${encodedId}/preview`;
}
