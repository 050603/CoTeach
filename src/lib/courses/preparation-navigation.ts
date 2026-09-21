export function courseDetailedEditHref(courseId: string): string {
  return `/teacher/prepare/${encodeURIComponent(courseId)}/verify/edit`;
}
