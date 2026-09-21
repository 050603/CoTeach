import { createHash } from "node:crypto";
import type { CourseResourcePackage } from "@/lib/resource-package/types";

export type ResourcePackageTeachingPoint = {
  id: string;
  name: string;
  description: string;
  groupId?: string;
  groupName?: string;
  /** A substantive parent concept must be defined before its details are taught. */
  teachingRole?: "core-concept" | "detail-concept";
  /** Source-package parent responsibility for a detail concept. */
  parentKnowledgePointId?: string;
};
const stableId = (text: string) => `kp-${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

function hasSubstantiveParentMeaning(name: string, description: string): boolean {
  const normalizedName = name.replace(/\s+/g, "").trim();
  const normalizedDescription = description.replace(/\s+/g, "").trim();
  if (!normalizedDescription || normalizedDescription === normalizedName) return false;
  if (/^(?:分组|目录|主题|章节|知识点分组|用于组织|包含以下|本节内容)$/u.test(normalizedDescription)) return false;
  // A parent becomes a teaching responsibility only when the package gives it
  // enough independent meaning to teach. Short navigation labels remain groups.
  return normalizedDescription.length >= 12;
}

/**
 * Preserve both teachable parent concepts and their details. Pure navigation
 * groups continue to organize their children without becoming artificial pages.
 */
export function resourcePackageTeachingPoints(resourcePackage?: CourseResourcePackage): ResourcePackageTeachingPoint[] {
  if (!resourcePackage) return [];
  return resourcePackage.draft.knowledgePoints.flatMap<ResourcePackageTeachingPoint>((group): ResourcePackageTeachingPoint[] => {
    const structured = group as typeof group & { id?: string; children?: Array<{ id: string; name: string; description: string }> };
    const groupId = structured.id || stableId(`group:${group.name}`);
    const children = structured.children?.length ? structured.children
      : group.subPoints.map((text) => {
        const separator = text.search(/[:：]/);
        const name = (separator > 0 ? text.slice(0, separator) : text).trim();
        return { id: stableId(`${groupId}:${name}`), name, description: separator > 0 ? text.slice(separator + 1).trim() : name };
      });
    if (!children.length) {
      return [{
        id: groupId,
        name: group.name,
        description: group.description,
        teachingRole: "detail-concept" as const,
      }];
    }
    const parentIsConcept = hasSubstantiveParentMeaning(group.name, group.description);
    return [
      ...(parentIsConcept ? [{
        id: groupId,
        name: group.name,
        description: group.description,
        groupId,
        groupName: group.name,
        teachingRole: "core-concept" as const,
      }] : []),
      ...children.map((point) => ({
        ...point,
        groupId,
        groupName: group.name,
        teachingRole: "detail-concept" as const,
        ...(parentIsConcept ? { parentKnowledgePointId: groupId } : {}),
      })),
    ];
  });
}
