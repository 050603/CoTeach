import type { PlatformDb } from "./access";

/** Personal group aliases belong to an offering; ordinary database IDs stay unchanged. */
export function projectGroupStorageId(offeringId: string, groupId: string): string {
  return groupId.startsWith("grp-") ? `${offeringId}:${groupId}` : groupId;
}

/** Never strip a namespace from another offering. */
export function projectGroupViewId(offeringId: string, groupId: string): string {
  const prefix = `${offeringId}:grp-`;
  return groupId.startsWith(prefix) ? groupId.slice(offeringId.length + 1) : groupId;
}

/** Resolve an existing alias within its offering, with a scoped fallback for historical rows. */
export async function resolveProjectGroupId(db: PlatformDb, offeringId: string, groupId: string): Promise<string | null> {
  const canonicalId = projectGroupStorageId(offeringId, groupId);
  const canonical = await db.projectGroup.findFirst({ where: { id: canonicalId, offeringId }, select: { id: true } });
  if (canonical) return canonical.id;
  if (canonicalId === groupId) return null;
  const historical = await db.projectGroup.findFirst({ where: { id: groupId, offeringId }, select: { id: true } });
  return historical?.id ?? null;
}
