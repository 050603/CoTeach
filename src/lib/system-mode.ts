import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import type { Course, CourseContent, Stage } from "@/lib/session/types";

export type OpenPblSystemMode = "new";

const SYSTEM_STAGES: readonly Stage[] = [
  {
    key: "launch",
    label: "项目启动",
    view: "simple-resource",
    description: "查看教师发布的项目说明与授课资源",
  },
  {
    key: "ai-learning",
    label: "知识讲授",
    view: "ai-learning",
    description: "分节学习核心知识，通过节末小测与 AI 助教讲解及时巩固",
  },
  {
    key: "make",
    label: "项目实践",
    view: "ai-collaboration",
    description: "在文档或代码工作台中与 AI 组员协作完成项目成果",
  },
  {
    key: "showcase",
    label: "成果汇报与评价",
    view: "showcase-reporting",
    description: "查看最终成果、申请汇报并跟随课堂同步展示",
  },
  {
    key: "reflection",
    label: "后测",
    view: "experiment-posttest",
    description: "完成教师设置的课堂后测",
  },
];

/** The application now has one production mode. Kept as a tiny API boundary while callers migrate. */
export function resolveOpenPblSystemMode(value?: string | null): OpenPblSystemMode {
  void value;
  return "new";
}

export function getOpenPblSystemMode(): OpenPblSystemMode {
  return "new";
}

export function getStagesForSystemMode(mode?: string): Stage[] {
  void mode;
  return SYSTEM_STAGES.map((stage) => ({ ...stage }));
}

export function generationTemplateForSystemMode(mode?: string): "new-ai-learning-only" {
  void mode;
  return "new-ai-learning-only";
}

function cloneCourseContent(content: CourseContent): CourseContent {
  return {
    ...content,
    knowledgePoints: [...(content.knowledgePoints ?? [])],
    lessonOutline: [...(content.lessonOutline ?? [])],
    teachingOutline: content.teachingOutline ? [...content.teachingOutline] : undefined,
    _openmaicSceneOutlines: content._openmaicSceneOutlines
      ? [...content._openmaicSceneOutlines]
      : undefined,
  };
}

function deriveCurrentSystemContent(content: CourseContent): CourseContent {
  const sceneOutlines = (content._openmaicSceneOutlines ?? []).filter(
    (outline) => outline.stageKey === "ai-learning" && outline.audience !== "teacher",
  );
  return {
    ...cloneCourseContent(content),
    pblOutline: "",
    projectMainline: undefined,
    teachingOutline: (content.teachingOutline ?? []).filter(
      (section) => section.stageKey === "ai-learning",
    ),
    lessonOutline: (content.lessonOutline ?? []).filter(
      (section) => section.stageKey === "ai-learning",
    ),
    _openmaicSceneOutlines: sceneOutlines,
    _openmaicScenesCount: sceneOutlines.length,
    moduleTimingPlan: undefined,
    teacherResources: undefined,
    teacherClassroomId: undefined,
    adaptiveLearningPlan: undefined,
    designGenerationTrace: undefined,
  };
}

/** Normalize persisted pre-upgrade courses into the only supported generation contract. */
export function reconcileCourseGenerationMode(course: Course, mode?: string): Course {
  void mode;
  const isCurrent = course.pblConfig?.generationTemplate === "new-ai-learning-only";
  const uiState = { ...(course.uiState ?? {}) } as NonNullable<Course["uiState"]> & {
    systemGenerationByMode?: unknown;
    systemStageKeyByMode?: unknown;
    systemStagesByMode?: unknown;
  };
  delete uiState.systemGenerationByMode;
  delete uiState.systemStageKeyByMode;
  delete uiState.systemStagesByMode;
  return {
    ...course,
    teacherClassroomId: undefined,
    dynamicFacilitationScaffolds: [],
    content: isCurrent ? cloneCourseContent(course.content) : deriveCurrentSystemContent(course.content),
    pblConfig: normalizePblCourseConfig({
      ...course.pblConfig,
      generationTemplate: "new-ai-learning-only",
    }),
    uiState: {
      ...uiState,
      activeGenerationMode: "new",
    },
  };
}

export function inferStageCollectionMode(
  stages: readonly Pick<Stage, "key">[] | undefined,
): OpenPblSystemMode | undefined {
  return stages?.length ? "new" : undefined;
}

export function mapStageKeyToSystemMode(stageKey: string | undefined, mode?: string): string {
  void mode;
  if (stageKey === "launch" || stageKey === "ai-learning") return stageKey;
  if (stageKey === "showcase" || stageKey === "reflection") return stageKey;
  return "make";
}

export function collaborationBackHref(courseId?: string): string {
  void courseId;
  return "/student";
}
