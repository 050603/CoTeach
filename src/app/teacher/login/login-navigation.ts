export function normalizeTeacherRedirect(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/teacher";
  return value;
}
