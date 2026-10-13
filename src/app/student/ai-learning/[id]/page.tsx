'use client';

import { Suspense } from 'react';
import { useParams, useSearchParams } from 'next/navigation';
import { AdaptiveAiLearningRuntime } from '@/components/views/student/adaptive-ai-learning-runtime';
import { useCourse, useHydrated, useSession } from '@/lib/session/store';
import { useRealtimeSync } from '@/hooks/use-realtime-sync';

function LoadingShell() {
  return (
    <div className="grid h-screen place-items-center bg-white text-stone-500">
      <div className="text-center">
        <div className="mx-auto mb-3 h-7 w-7 animate-spin rounded-full border-2 border-stone-300 border-t-blue-600" />
        <p className="text-sm">正在准备学习环境...</p>
      </div>
    </div>
  );
}

function AiLearningPlayer() {
  const params = useParams<{ id: string }>();
  const searchParams = useSearchParams();
  const session = useSession();

  const classroomId = params?.id;
  const courseId = searchParams.get('courseId') || undefined;
  const course = useCourse(courseId);
  useRealtimeSync(courseId);
  const hydrated = useHydrated();
  const studentId = session.studentId;
  const studentName = session.studentName ?? session.user.name;
  const backHref = courseId ? `/student/classroom/${courseId}` : '/student';

  if (!classroomId || !courseId) {
    return (
      <div className="grid h-screen place-items-center bg-white text-stone-500">
        <p className="text-sm">缺少课堂或课程 ID 参数，请从课程空间重新进入</p>
      </div>
    );
  }

  if (!hydrated) return <LoadingShell />;

  if (!course) {
    return (
      <div className="grid h-screen place-items-center bg-white text-stone-500">
        <p className="text-sm">未找到课程，请从课程空间重新进入</p>
      </div>
    );
  }

  if (!studentId) {
    return (
      <div className="grid h-screen place-items-center bg-white text-stone-500">
        <p className="text-sm">学生身份未初始化，请重新进入课堂</p>
      </div>
    );
  }

  return (
    <AdaptiveAiLearningRuntime
      course={course}
      classroomId={classroomId}
      studentId={studentId}
      studentName={studentName}
      backHref={backHref}
      variant="fullscreen"
    />
  );
}

export default function StudentAiLearningPage() {
  // useSearchParams 需要在 Suspense 边界内使用，否则生产构建会失败
  return (
    <Suspense fallback={<LoadingShell />}>
      <AiLearningPlayer />
    </Suspense>
  );
}
