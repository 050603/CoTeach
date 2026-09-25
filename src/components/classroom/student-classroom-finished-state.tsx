import { Clock3 } from "lucide-react";
import Link from "next/link";
import { StageEmptyState } from "@/components/classroom/classroom-ui";

export function StudentClassroomFinishedState({ course }: {
  course: { name: string; platformContext?: { activityId: string } };
}) {
  return <StageEmptyState
    action={course.platformContext?.activityId ? <Link
      className="inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--pbl-student)] px-5 text-sm font-semibold text-white"
      href={`/student/activities/${encodeURIComponent(course.platformContext.activityId)}`}
    >返回课堂活动完成后测</Link> : undefined}
    description={`《${course.name}》已结束授课。你可以留在这里回看作品和评价证据，也可以返回课堂活动完成后测。`}
    icon={Clock3}
    title="课堂已结束"
    tone="neutral"
  />;
}
