import { createHash } from "node:crypto";
import type { CourseResourcePackage } from "@/lib/resource-package/types";

export type ResourcePackageTeachingPoint = { id: string; name: string; description: string; groupId?: string; groupName?: string };
const stableId = (text: string) => `kp-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

/** Teach leaf concepts; a six-group/twelve-leaf package has twelve timed targets, not eighteen. */
export function resourcePackageTeachingPoints(resourcePackage?: CourseResourcePackage): ResourcePackageTeachingPoint[] {
  if (!resourcePackage) return [];
  return resourcePackage.draft.knowledgePoints.flatMap((group) => {
    const structured = group as typeof group & { id?: string; children?: Array<{ id: string; name: string; description: string }> };
    const groupId = structured.id || stableId(`group:${group.name}`);
    const children = structured.children?.length ? structured.children
      : group.subPoints.map((text) => {
        const separator = text.search(/[:：]/);
        const name = (separator > 0 ? text.slice(0, separator) : text).trim();
        return { id: stableId(`${groupId}:${name}`), name, description: separator > 0 ? text.slice(separator + 1).trim() : name };
      });
    return children.length ? children.map((point) => ({ ...point, groupId, groupName: group.name }))
      : [{ id: groupId, name: group.name, description: group.description }];
  });
}
