const DATA_IMAGE_URL = /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i;

export const OFFERING_COVER_MEDIA_PREFIX = "offering-";

export function isSafeCoverImageUrl(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) return true;
  if (DATA_IMAGE_URL.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Read the preparation-stage PBL cover without trusting an arbitrary snapshot shape or URL. */
export function classroomCoverImageUrl(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const root = snapshot as Record<string, unknown>;
  if (root.kind !== "pbl-course" || root.schemaVersion !== 2) return null;
  const design = root.design;
  if (!design || typeof design !== "object" || Array.isArray(design)) return null;
  const value = (design as Record<string, unknown>).coverImageUrl;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && isSafeCoverImageUrl(normalized) ? normalized : null;
}
