// 将 OpenMAIC 生成的 classroom 与 openPBL 的 Course 关联
// 这是 openPBL 侧的逻辑，不修改 OpenMAIC 任何代码

import { updateCourse, getCourse } from '@/lib/session/server-store';
import type {
  Course,
  OpenMaicSceneOutlineSnapshot,
  TeacherResourceScene,
} from '@/lib/session/types';
import type { SceneOutline } from '@/lib/openmaic/types/generation';
import { throwIfAborted } from '@openmaic/lib/generation/generation-retry';

export interface ClassroomLinkInfo {
  scenesCount: number;
  stageName: string;
  teacherClassroomId?: string;
  teacherResourceScenes?: TeacherResourceScene[];
  /** Canonical, media-planned outlines used to generate the persisted scenes. */
  sceneOutlines?: SceneOutline[];
  systemMode?: "new";
}

export async function linkClassroomToCourse(
  courseId: string,
  classroomId: string,
  info: ClassroomLinkInfo,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  throwIfAborted(options.signal);
  await updateCourse(courseId, (course): Course => {
    throwIfAborted(options.signal);
    const teacherResources = info.systemMode === "new"
      ? undefined
      : info.teacherResourceScenes
      ? {
          generatedAt: new Date().toISOString(),
          scenes: info.teacherResourceScenes,
        }
      : course.content.teacherResources;
    return {
      ...course,
      aiLearningClassroomId: classroomId,
      ...(info.systemMode === "new"
        ? { teacherClassroomId: undefined }
        : info.teacherClassroomId !== undefined
        ? { teacherClassroomId: info.teacherClassroomId || undefined }
        : {}),
      content: {
        ...course.content,
        _openmaicClassroomId: classroomId,
        _openmaicScenesCount: info.scenesCount,
        ...(info.sceneOutlines
          ? {
              _openmaicSceneOutlines:
                info.sceneOutlines as unknown as OpenMaicSceneOutlineSnapshot[],
            }
          : {}),
        ...(info.systemMode === "new"
          ? { teacherClassroomId: undefined, teacherResources: undefined }
          : info.teacherClassroomId !== undefined
          ? { teacherClassroomId: info.teacherClassroomId || undefined }
          : {}),
        ...(info.systemMode !== "new" && info.teacherResourceScenes
          ? { teacherResources }
          : {}),
      },
    };
  });
  throwIfAborted(options.signal);
}

export async function getCourseClassroomId(courseId: string): Promise<string | undefined> {
  const course = await getCourse(courseId);
  return course?.aiLearningClassroomId;
}
