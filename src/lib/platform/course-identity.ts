export function courseReferenceCode(id: string): string {
  const compact = id.replace(/[^a-zA-Z0-9]/g, "");
  return (compact.slice(0, 8) || id.slice(0, 8)).toUpperCase();
}

export function formatCourseTimestamp(value?: string | null): string {
  if (!value) return "时间未知";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

