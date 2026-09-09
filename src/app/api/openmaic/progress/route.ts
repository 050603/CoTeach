// AI 课堂学习进度端点
// GET  读取 course.aiLearningProgress
// POST 更新某学生在 AI 课堂中的学习进度

import { type NextRequest } from 'next/server';
import {
  apiError,
  apiSuccess,
  API_ERROR_CODES,
} from '@openmaic/lib/server/api-response';
import { createLogger } from '@openmaic/lib/logger';
import { getCourse } from '@/lib/session/server-store';
import type { StudentAiProgress } from '@/lib/session/types';
import { persistStudentAiProgress } from '@/lib/courses/ai-progress-service';
import { readClassroom } from '@openmaic/lib/server/classroom-storage';
import { normalizeProgressUpdate } from '@openmaic/lib/progress/normalize-progress';
import {
  AI_PROGRESS_COMPLETION_MODEL_VERSION,
  isReliableAiProgress,
} from '@openmaic/lib/progress/completion-model';
import {
  authenticateRequest,
  requireSameOrigin,
} from '@/lib/auth/request-guards';
import { isAuthConfigured } from '@/lib/auth/session';
import { canAccessLegacyCourse } from '@/lib/platform/access';

const log = createLogger('ProgressAPI');

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type ProgressRequestBody = {
  courseId?: string;
  studentId?: string;
  studentName?: string;
  classroomId?: string;
  currentSceneIndex?: number;
  totalScenes?: number;
  completedScenes?: string[];
  completionModelVersion?: number;
  quizScore?: number;
};

// 计算 masteryLevel：
// - not-started: index===0 且 completedScenes 为空
// - mastered: 已完成全部场景 且 quizScore>=80
// - completed: 已完成全部场景
// - in-progress: 其它
function computeMasteryLevel(
  currentSceneIndex: number,
  totalScenes: number,
  completedScenes: string[],
  quizScore?: number,
): StudentAiProgress['masteryLevel'] {
  if (currentSceneIndex === 0 && completedScenes.length === 0) {
    return 'not-started';
  }
  const allDone = completedScenes.length >= totalScenes;
  if (allDone && quizScore !== undefined && quizScore >= 80) {
    return 'mastered';
  }
  if (allDone) {
    return 'completed';
  }
  return 'in-progress';
}

export async function GET(request: NextRequest) {
  try {
    const auth = isAuthConfigured() ? await authenticateRequest(request) : null;
    if (auth && 'response' in auth) return auth.response;
    const courseId = request.nextUrl.searchParams.get('courseId');
    const studentId = request.nextUrl.searchParams.get('studentId');

    if (!courseId) {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required parameter: courseId',
      );
    }

    const course = await getCourse(courseId);
    if (!course) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }

    if (
      auth
      && !('response' in auth)
      && auth.claims.role === 'student'
      && auth.claims.sub !== studentId
    ) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, 'Progress is outside the signed-in student scope');
    }
    if (auth && !('response' in auth) && !(await canAccessLegacyCourse(auth.claims, courseId, 'read'))) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, 'Course is not accessible');
    }

    const progress = course.aiLearningProgress ?? {};
    return apiSuccess({
      data: {
        progress: studentId
          ? { ...(progress[studentId] ? { [studentId]: progress[studentId] } : {}) }
          : progress,
      },
    });
  } catch (error) {
    log.error(
      `Progress retrieval failed [courseId=${request.nextUrl.searchParams.get('courseId') ?? 'unknown'}]:`,
      error,
    );
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to retrieve progress',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const csrfError = requireSameOrigin(request);
    if (csrfError) return csrfError;
    const auth = isAuthConfigured() ? await authenticateRequest(request) : null;
    if (auth && 'response' in auth) return auth.response;
    const body = (await request.json()) as ProgressRequestBody;
    const {
      courseId,
      studentId,
      studentName,
      classroomId,
      currentSceneIndex,
      totalScenes,
      completedScenes,
      quizScore,
    } = body;

    if (!courseId || typeof courseId !== 'string') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required field: courseId (string)',
      );
    }
    if (!studentId || typeof studentId !== 'string') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required field: studentId (string)',
      );
    }
    if (
      auth
      && !('response' in auth)
      && (
        auth.claims.role !== 'student'
        || auth.claims.sub !== studentId
      )
    ) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, 'Progress updates require the matching student identity');
    }
    if (auth && !('response' in auth) && !(await canAccessLegacyCourse(auth.claims, courseId, 'write'))) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, 'Course is locked');
    }
    if (!classroomId || typeof classroomId !== 'string') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required field: classroomId (string)',
      );
    }
    if (typeof currentSceneIndex !== 'number' || typeof totalScenes !== 'number') {
      return apiError(
        API_ERROR_CODES.MISSING_REQUIRED_FIELD,
        400,
        'Missing required fields: currentSceneIndex, totalScenes (number)',
      );
    }

    const course = await getCourse(courseId);
    if (!course) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Course not found');
    }
    const linkedClassroomId = course.aiLearningClassroomId ?? course.content._openmaicClassroomId;
    if (!linkedClassroomId || linkedClassroomId !== classroomId) {
      return apiError(
        API_ERROR_CODES.INVALID_REQUEST,
        400,
        'Classroom does not belong to this course',
      );
    }
    if (!course.students.some((student) => student.id === studentId)) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 403, 'Student is not enrolled in this course');
    }
    const classroom = await readClassroom(classroomId);
    if (!classroom || classroom.scenes.length === 0) {
      return apiError(API_ERROR_CODES.INVALID_REQUEST, 404, 'Classroom scenes not found');
    }

    const normalized = normalizeProgressUpdate({
      validSceneIds: classroom.scenes.map((scene) => scene.id),
      requestedCurrentSceneIndex: currentSceneIndex,
      requestedCompletedScenes: Array.isArray(completedScenes) ? completedScenes : [],
      previousCompletedScenes: isReliableAiProgress(course.aiLearningProgress?.[studentId])
        ? course.aiLearningProgress?.[studentId]?.completedScenes ?? []
        : [],
    });
    const score =
      typeof quizScore === 'number' && !Number.isNaN(quizScore) ? quizScore : undefined;
    const masteryLevel = computeMasteryLevel(
      normalized.currentSceneIndex,
      normalized.totalScenes,
      normalized.completedScenes,
      score,
    );
    const completedRuntimeIds = new Set(normalized.completedScenes);
    const completedOutlineIds = Array.from(new Set(
      classroom.scenes
        .filter((scene) => completedRuntimeIds.has(scene.id))
        .map((scene) => scene.outlineId?.trim() || scene.id),
    ));

    const now = new Date().toISOString();

    const updatedEntry: StudentAiProgress = {
      ...course.aiLearningProgress?.[studentId],
      classroomId,
      studentId,
      currentSceneIndex: normalized.currentSceneIndex,
      totalScenes: normalized.totalScenes,
      completedScenes: normalized.completedScenes,
      completedOutlineIds,
      completionModelVersion: AI_PROGRESS_COMPLETION_MODEL_VERSION,
      lastActiveAt: now,
      masteryLevel,
      ...(score !== undefined ? { quizScore: score } : {}),
    };
    void studentName;
    const savedProgress = await persistStudentAiProgress(
      courseId,
      studentId,
      updatedEntry,
      Math.round(
        (normalized.completedScenes.length / Math.max(1, normalized.totalScenes)) * 100,
      ),
    );

    return apiSuccess({ data: { progress: savedProgress } });
  } catch (error) {
    log.error('Progress update failed:', error);
    return apiError(
      API_ERROR_CODES.INTERNAL_ERROR,
      500,
      'Failed to update progress',
      error instanceof Error ? error.message : String(error),
    );
  }
}
