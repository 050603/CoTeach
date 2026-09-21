/** Remove private authoring input without changing the stored template. */
export function withoutPrivatePackageContent<T extends object>(content: T): T {
  const copy = { ...content } as Record<string, unknown>;
  for (const key of ["resourcePackage", "textbookSelections", "courseEvidence", "teachingBlueprint", "teachingTimingAudit", "teachingAdoptions", "teachingRevisionState", "designGenerationTrace", "teacherReviewItems", "teacherReviewSummary", "teacherReviewVersion", "knowledgeScopePlan", "teacherReview", "renderReview", "qualityReview", "qualityReviewRequired"]) delete copy[key];
  if (Array.isArray(copy.knowledgePoints)) {
    copy.knowledgePoints = copy.knowledgePoints.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const point = { ...value } as Record<string, unknown>;
      delete point.evidenceItemIds;
      return point;
    });
  }
  if (copy.knowledgeGraph && typeof copy.knowledgeGraph === "object" && !Array.isArray(copy.knowledgeGraph)) {
    const graph = copy.knowledgeGraph as Record<string, unknown>;
    copy.knowledgeGraph = {
      ...graph,
      nodes: Array.isArray(graph.nodes) ? graph.nodes.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return value;
        const node = { ...value } as Record<string, unknown>;
        delete node.evidenceItemIds;
        return node;
      }) : graph.nodes,
    };
  }
  return copy as T;
}

export function publicResourcePackageSnapshot<T>(snapshot: T): T {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const value = snapshot as Record<string, unknown>;
  if (!value.design || typeof value.design !== "object" || Array.isArray(value.design)) return snapshot;
  const design = value.design as Record<string, unknown>;
  if (!design.content || typeof design.content !== "object" || Array.isArray(design.content)) return snapshot;
  return { ...value, design: { ...design, content: withoutPrivatePackageContent(design.content) } } as T;
}
