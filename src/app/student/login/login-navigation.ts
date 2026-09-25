const origin = "https://student-redirect.invalid";

export function normalizeStudentRedirect(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return null;
  try {
    const target = new URL(value, origin);
    if (target.origin !== origin || !target.pathname.startsWith("/student/")) return null;
    if (["/student/login", "/student/register", "/student/reset-password"].includes(target.pathname)) return null;
    return `${target.pathname}${target.search}${target.hash}`;
  } catch {
    return null;
  }
}
