import type { TeacherResourceScene } from "@/lib/session/types";
import { checkPblStageCoverage, type PblStageCoverage } from "@/lib/openmaic/pbl/course-template";
import { classifyScenes } from "@/lib/openmaic-bridge/scene-classifier";
import { persistClassroom, readClassroom } from "@openmaic/lib/server/classroom-storage";
import { throwIfAborted } from "@openmaic/lib/generation/generation-retry";
import type { Scene, Stage } from "@openmaic/lib/types/stage";

export interface ServerClassroomSplitResult {
  studentClassroomId: string;
  teacherClassroomId: string;
  /** In-memory scene arrays used by the post-response asset task. */
  studentScenes: Scene[];
  teacherScenes: Scene[];
  teacherResourceScenes: TeacherResourceScene[];
  studentSceneCount: number;
  teacherSceneCount: number;
  pblCoverage: PblStageCoverage;
}

/**
 * Split a generated classroom before it is exposed through Course. The
 * original classroom id is retained for students and is overwritten with the
 * student-only scene list; teacher resources get a separate stage id.
 */
export async function splitGeneratedClassroom(input: {
  stage: Stage;
  scenes: Scene[];
  courseName?: string;
  pblMode?: boolean;
  signal?: AbortSignal;
}): Promise<ServerClassroomSplitResult> {
  throwIfAborted(input.signal);
  if (input.scenes.length === 0) {
    throw new Error("课堂未包含任何场景，无法完成资源分流");
  }

  const { studentScenes, teacherScenes, teacherResourceMeta } = classifyScenes(input.scenes, {
    pblMode: input.pblMode,
  });
  const pblCoverage = checkPblStageCoverage(
    input.scenes.map((scene) => ({
      title: scene.title ?? "未命名场景",
      type: scene.type,
      stageKey: scene.stageKey,
      stageLabel: scene.stageLabel,
      audience: scene.audience,
      generationPurpose: scene.generationPurpose,
    })),
  );

  if (studentScenes.length === 0) {
    throw new Error("PBL 生成结果没有明确标记为知识讲授的学生学习场景");
  }

  throwIfAborted(input.signal);
  // Splitting rewrites the original classroom before it is linked to the
  // teacher preview. Keep its preparation state visible across that write.
  const assetGeneration = (await readClassroom(input.stage.id))?.assetGeneration;
  await persistClassroom(
    {
      id: input.stage.id,
      stage: input.stage,
      scenes: studentScenes,
      ...(assetGeneration ? { assetGeneration } : {}),
    },
  );

  throwIfAborted(input.signal);
  let teacherClassroomId = "";
  let normalizedTeacherScenes: Scene[] = [];
  if (teacherScenes.length > 0) {
    throwIfAborted(input.signal);
    teacherClassroomId = `${input.stage.id}-teacher`;
    const teacherStage: Stage = {
      ...input.stage,
      id: teacherClassroomId,
      name: `${input.courseName || input.stage.name} - 普通课堂活动`,
    };
    normalizedTeacherScenes = teacherScenes.map((scene, index) => ({
      ...scene,
      stageId: teacherStage.id,
      order: index,
    }));
    await persistClassroom(
      {
        id: teacherStage.id,
        stage: teacherStage,
        scenes: normalizedTeacherScenes,
        ...(assetGeneration ? { assetGeneration } : {}),
      },
    );
    throwIfAborted(input.signal);
  }

  return {
    studentClassroomId: input.stage.id,
    teacherClassroomId,
    studentScenes,
    teacherScenes: normalizedTeacherScenes,
    teacherResourceScenes: teacherResourceMeta,
    studentSceneCount: studentScenes.length,
    teacherSceneCount: teacherScenes.length,
    pblCoverage,
  };
}
