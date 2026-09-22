"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { DashboardShell } from "@/components/dashboard-shell";
import { FastCourseGenerator } from "@/components/teacher/fast-course-generator";
import { WizardStepper } from "@/components/wizard-stepper";
import { courseDetailedEditHref } from "@/lib/courses/preparation-navigation";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";

const STEPS = [
  { key: "generate", label: "一键生成" },
  { key: "design", label: "课程设计" },
  { key: "publish", label: "发布中心" },
];

export default function VerifyCoursePage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useSession();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();

  if (!hydrated) {
    return (
      <DashboardShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中…</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell backHref="/teacher/templates" backLabel="返回课程库" role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-[var(--pbl-teacher)] hover:underline" href="/teacher/templates">
            返回课程列表
          </Link>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      backHref="/teacher/templates"
      backLabel="返回课程库"
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
      headerSlot={
        <div className="ml-4 hidden min-w-0 lg:block">
          <WizardStepper current={0} steps={STEPS} />
        </div>
      }
    >
      <FastCourseGenerator
        course={course}
        onOpenDetailed={() => router.push(courseDetailedEditHref(course.id))}
        simplified
      />
    </DashboardShell>
  );
}
