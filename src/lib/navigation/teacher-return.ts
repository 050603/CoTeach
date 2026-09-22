const TEACHER_SETTINGS_PATH = "/teacher/settings";

export function resolveTeacherReturnHref(value: string | null | undefined): string | undefined {
  if (!value?.startsWith("/") || value.startsWith("//")) return undefined;

  const url = new URL(value, "https://coteach.local");
  if (!url.pathname.startsWith("/teacher/") || url.pathname.startsWith(TEACHER_SETTINGS_PATH)) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
}

export function teacherSettingsHref(returnTo: string): string {
  const safeReturnTo = resolveTeacherReturnHref(returnTo);
  return safeReturnTo
    ? `${TEACHER_SETTINGS_PATH}?returnTo=${encodeURIComponent(safeReturnTo)}`
    : TEACHER_SETTINGS_PATH;
}
