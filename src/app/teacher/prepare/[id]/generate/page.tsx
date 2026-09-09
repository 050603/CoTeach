"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";

/**
 * The current preparation flow generates the classroom directly from the
 * verification page. Keep this route only as a compatibility redirect for old
 * bookmarks; the retired standalone generation UI is intentionally gone.
 */
export default function GenerateCourseRedirectPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();
  const { user } = useSession();

  useEffect(() => {
    if (hydrated && course?.id) {
      router.replace(`/teacher/prepare/${course.id}/verify`);
    }
  }, [course?.id, hydrated, router]);

  return (
    <DashboardShell role="teacher" userName={user.name} variant="bare">
      <div className="grid place-items-center py-20 text-stone-500">
        {hydrated && !course ? (
          <>
            未找到课程。
            <Link className="mt-4 text-blue-700 hover:underline" href="/teacher/templates">
              返回课程列表
            </Link>
          </>
        ) : "正在返回备课页面…"}
      </div>
    </DashboardShell>
  );
}
