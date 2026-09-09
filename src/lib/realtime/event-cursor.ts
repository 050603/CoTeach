/** Fixed-width UTC timestamp plus UUID orders DomainEvent rows without numeric precision loss. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)~([0-9a-f-]{36})$/i;
export function encodeEventCursor(row: { createdAt: Date; id: string }): string { return `${row.createdAt.toISOString()}~${row.id}`; }
export function decodeEventCursor(value: string): { createdAt: Date; id: string } | null {
  const match = CURSOR.exec(value);
  if (!match) return null;
  const createdAt = new Date(match[1]);
  if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== match[1]) return null;
  return { createdAt, id: match[2] };
}
