import type {
  Course,
  CourseContent,
  CourseDesignWorkspaceArtifactStatus,
  CourseDesignWorkspacePendingUpdate,
  CourseDesignWorkspaceRevision,
  CourseDesignWorkspaceSectionKey,
} from "@/lib/session/types";

export const COURSE_DESIGN_WORKSPACE_SECTIONS: ReadonlyArray<{
  key: CourseDesignWorkspaceSectionKey;
  phase: string;
  label: string;
  shortLabel: string;
  description: string;
}> = [
  { key: "materials", phase: "01", label: "课程资料与定位", shortLabel: "资料定位", description: "课程信息、学习目标、学情、资源包与教材依据" },
  { key: "stage-plan", phase: "02", label: "五阶段教学安排", shortLabel: "教学安排", description: "五阶段时长、任务、师生职责、成果、评价与反思" },
  { key: "knowledge", phase: "03", label: "知识结构", shortLabel: "知识结构", description: "知识点、知识图谱、来源映射与范围规划" },
  { key: "timing", phase: "04", label: "讲授时间规划", shortLabel: "时间规划", description: "知识讲授预算、知识簇分配与容量依据" },
  { key: "blueprint", phase: "05", label: "教学蓝图与大纲", shortLabel: "蓝图大纲", description: "小节、解释内容、互动、检测与页面安排" },
  { key: "classroom", phase: "06", label: "课堂内容与资源", shortLabel: "课堂资源", description: "课件、讲稿、互动、小测、音频与资源状态" },
] as const;

const DOWNSTREAM: Record<CourseDesignWorkspaceSectionKey, readonly CourseDesignWorkspaceSectionKey[]> = {
  materials: ["stage-plan", "knowledge", "timing", "blueprint", "classroom"],
  "stage-plan": ["timing", "blueprint", "classroom"],
  knowledge: ["timing", "blueprint", "classroom"],
  timing: ["blueprint", "classroom"],
  blueprint: ["classroom"],
  classroom: [],
};

function artifactExists(course: Course, key: CourseDesignWorkspaceSectionKey): boolean {
  const content = course.content;
  if (key === "materials") {
    return Boolean(course.name.trim() && course.subject.trim() && course.grade.trim()
      && course.hours > 0 && (course.learningObjectives?.some((item) => item.trim()) ?? false));
  }
  if (key === "stage-plan") {
    return Boolean(content.stagePlan?.stages.length === 5 && content.stagePlan.totalMinutes > 0);
  }
  if (key === "knowledge") return (content.knowledgePoints?.length ?? 0) > 0;
  if (key === "timing") return Boolean(content.moduleTimingPlan?.allocations.length);
  if (key === "blueprint") {
    return Boolean(content.teachingBlueprint?.sections.length
      && content._openmaicSceneOutlines?.length);
  }
  return Boolean(course.aiLearningClassroomId ?? content._openmaicClassroomId);
}

export function courseDesignWorkspaceStatus(
  course: Course,
  key: CourseDesignWorkspaceSectionKey,
): CourseDesignWorkspaceArtifactStatus {
  const recorded = course.content.designWorkspaceRevision?.sections[key]?.status;
  if (recorded === "generating" || recorded === "failed") return recorded;
  if (course.content.designWorkspaceRevision?.pendingUpdates.some((item) => item.target === key)) {
    return "stale";
  }
  return artifactExists(course, key) ? "ready" : "missing";
}

export function courseDesignWorkspaceStatuses(
  course: Course,
): Record<CourseDesignWorkspaceSectionKey, CourseDesignWorkspaceArtifactStatus> {
  return Object.fromEntries(COURSE_DESIGN_WORKSPACE_SECTIONS.map((section) => [
    section.key,
    courseDesignWorkspaceStatus(course, section.key),
  ])) as Record<CourseDesignWorkspaceSectionKey, CourseDesignWorkspaceArtifactStatus>;
}

function affectedIds(
  course: Course,
  source: CourseDesignWorkspaceSectionKey,
  changedKnowledgePointIds: readonly string[],
): { sectionIds: string[]; outlineIds: string[] } {
  const blueprintSections = course.content.teachingBlueprint?.sections ?? [];
  const relevantSections = source === "knowledge" && changedKnowledgePointIds.length
    ? blueprintSections.filter((section) => section.knowledgePointIds.some((id) => changedKnowledgePointIds.includes(id)))
    : blueprintSections;
  const sectionIds = relevantSections.map((section) => section.id);
  const sectionIdSet = new Set(sectionIds);
  const outlineIds = (course.content._openmaicSceneOutlines ?? [])
    .filter((outline) => sectionIdSet.size === 0 || !outline.lectureSectionId || sectionIdSet.has(outline.lectureSectionId))
    .map((outline) => outline.id);
  return { sectionIds, outlineIds };
}

export function planCourseDesignImpacts(
  course: Course,
  source: CourseDesignWorkspaceSectionKey,
  options: {
    changedKnowledgePointIds?: readonly string[];
    impactTargets?: readonly CourseDesignWorkspaceSectionKey[];
    now?: string;
  } = {},
): CourseDesignWorkspacePendingUpdate[] {
  const createdAt = options.now ?? new Date().toISOString();
  const { sectionIds, outlineIds } = affectedIds(course, source, options.changedKnowledgePointIds ?? []);
  const revision = (course.content.designWorkspaceRevision?.revision ?? 0) + 1;
  const downstream = options.impactTargets === undefined
    ? DOWNSTREAM[source]
    : DOWNSTREAM[source].filter((target) => options.impactTargets!.includes(target));
  return downstream
    .filter((target) => artifactExists(course, target))
    .map((target) => ({
      id: `${revision}:${source}:${target}`,
      source,
      target,
      reason: `${COURSE_DESIGN_WORKSPACE_SECTIONS.find((item) => item.key === source)?.label ?? source}已修改，需要核对并更新${COURSE_DESIGN_WORKSPACE_SECTIONS.find((item) => item.key === target)?.label ?? target}`,
      affectedSectionIds: target === "timing" ? [] : sectionIds,
      affectedOutlineIds: target === "classroom" ? outlineIds : [],
      includesManualEdits: Boolean(
        course.content.designWorkspaceRevision?.sections[target]?.manuallyEdited
        || (target === "classroom" && course.content.teachingRevisionState),
      ),
      createdAt,
    }));
}

export function recordCourseDesignEdit(
  course: Course,
  source: CourseDesignWorkspaceSectionKey,
  options: {
    changedKnowledgePointIds?: readonly string[];
    impactTargets?: readonly CourseDesignWorkspaceSectionKey[];
    now?: string;
  } = {},
): CourseDesignWorkspaceRevision {
  const now = options.now ?? new Date().toISOString();
  const current = course.content.designWorkspaceRevision;
  const revision = (current?.revision ?? 0) + 1;
  const impacts = planCourseDesignImpacts(course, source, { ...options, now });
  const retained = (current?.pendingUpdates ?? []).filter((item) => (
    item.target !== source
    && !impacts.some((impact) => impact.target === item.target)
  ));
  const sections = { ...(current?.sections ?? {}) };
  sections[source] = {
    status: "ready",
    revision,
    manuallyEdited: true,
    updatedAt: now,
  };
  for (const impact of impacts) {
    const previous = sections[impact.target];
    sections[impact.target] = {
      status: "stale",
      revision: previous?.revision ?? 0,
      manuallyEdited: previous?.manuallyEdited ?? false,
      updatedAt: previous?.updatedAt ?? now,
    };
  }
  return {
    schemaVersion: 1,
    revision,
    updatedAt: now,
    lastEditedSection: source,
    sections,
    pendingUpdates: [...retained, ...impacts],
  };
}

export function resolveCourseDesignUpdate(
  content: CourseContent,
  target: CourseDesignWorkspaceSectionKey,
  now = new Date().toISOString(),
): CourseDesignWorkspaceRevision {
  const current = content.designWorkspaceRevision ?? {
    schemaVersion: 1 as const,
    revision: 0,
    updatedAt: now,
    sections: {},
    pendingUpdates: [],
  };
  const revision = current.revision + 1;
  return {
    ...current,
    revision,
    updatedAt: now,
    sections: {
      ...current.sections,
      [target]: {
        status: "ready",
        revision,
        manuallyEdited: current.sections[target]?.manuallyEdited ?? false,
        updatedAt: now,
      },
    },
    pendingUpdates: current.pendingUpdates.filter((item) => item.target !== target),
  };
}

export function hasPendingCourseDesignUpdates(course: Course): boolean {
  return Boolean(course.content.designWorkspaceRevision?.pendingUpdates.length);
}

export function mergeCourseDesignClassroomScenes<T extends { id: string; outlineId?: string }>(options: {
  outlineIds: readonly string[];
  affectedOutlineIds: readonly string[];
  baseScenes: readonly T[];
  candidateScenes: readonly T[];
}): T[] | null {
  const affected = new Set(options.affectedOutlineIds);
  const sceneOutlineId = (scene: T) => scene.outlineId || scene.id;
  const baseByOutline = new Map(options.baseScenes.map((scene) => [sceneOutlineId(scene), scene]));
  const candidateByOutline = new Map(options.candidateScenes.map((scene) => [sceneOutlineId(scene), scene]));
  if (options.affectedOutlineIds.some((outlineId) => !candidateByOutline.has(outlineId))) return null;
  const merged = options.outlineIds.flatMap((outlineId) => {
    const scene = affected.has(outlineId) ? candidateByOutline.get(outlineId) : baseByOutline.get(outlineId);
    return scene ? [scene] : [];
  });
  return merged.length === options.outlineIds.length ? merged : null;
}
