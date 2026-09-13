/** Remove private authoring input without changing the stored template. */
export function withoutPrivatePackageContent<T extends object>(content: T): T {
  const copy = { ...content } as T & Record<string, unknown>;
  for (const key of ["resourcePackage", "teacherReview", "renderReview", "qualityReview", "qualityReviewRequired"]) delete copy[key];
  return copy;
}

export function publicResourcePackageSnapshot<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const value = snapshot as Record<string, unknown>;
  if (!value.design || typeof value.design !== "object" || Array.isArray(value.design)) return snapshot;
  const design = value.design as Record<string, unknown>;
  if (!design.content || typeof design.content !== "object" || Array.isArray(design.content)) return snapshot;
  return { ...value, design: { ...design, content: withoutPrivatePackageContent(design.content) } } as T;
}
