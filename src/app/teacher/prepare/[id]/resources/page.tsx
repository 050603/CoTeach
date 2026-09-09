"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, Sparkles } from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { WizardStepper } from "@/components/wizard-stepper";
import { Pill } from "@/components/ui";
import { useSession, useCourse, useHydrated } from "@/lib/session/store";
import { TeacherResourceViewer } from "@/components/openmaic-bridge/teacher-resource-viewer";

const STEPS = [
  { key: "verify", label: "备课阶段" },
  { key: "generate", label: "生成课程" },
  { key: "preview", label: "预览发布" },
];

export default function TeacherResourcesPage() {
  const params = useParams<{ id: string }>();
  const { user } = useSession();
  const course = useCourse(params?.id);
  const hydrated = useHydrated();

  if (!hydrated) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中…</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell role="teacher" userName={user.name} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">
          未找到课程。
          <Link className="mt-4 text-blue-700 hover:underline" href="/teacher/templates">
            返回课程列表
          </Link>
        </div>
      </DashboardShell>
    );
  }

  const teacherClassroomId = course.teacherClassroomId ?? course.content.teacherClassroomId;
  const teacherResources = course.content.teacherResources;

  // 无教师资源：提示教师先生成课程
  if (!teacherClassroomId) {
    return (
      <DashboardShell
        role="teacher"
        userName={user.name}
        variant="bare"
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
        headerSlot={
          <div className="ml-4">
            <WizardStepper current={2} steps={STEPS} />
          </div>
        }
      >
        <div className="mb-5 flex items-center gap-3">
          <Link
            className="grid h-9 w-9 place-items-center rounded-[6px] border border-stone-200 bg-white text-stone-500 hover:bg-stone-50"
            href={`/teacher/prepare/${course.id}/preview`}
          >
            <ArrowLeft size={17} />
          </Link>
          <div>
            <h1 className="text-[28px] font-bold">教师授课资源</h1>
          </div>
        </div>

        <div className="rounded-[12px] border border-dashed border-stone-200 bg-stone-50 p-10 text-center">
          <Sparkles className="mx-auto mb-3 text-stone-300" size={32} />
          <p className="text-sm text-stone-600">
            暂无教师授课资源。
          </p>
          <p className="mt-1 text-xs text-stone-400">
            完成 AI 课程生成后，系统会按授课大纲拆分各阶段的 PPT、互动演示和讲稿。
          </p>
          <Link
            className="mt-5 inline-flex h-10 items-center gap-1.5 rounded-[6px] bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700"
            href={`/teacher/prepare/${course.id}/generate`}
          >
            去生成课程
          </Link>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      role="teacher"
      userName={user.name}
      variant="bare"
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
      headerSlot={
        <div className="ml-4 flex items-center gap-2">
          <WizardStepper current={2} steps={STEPS} />
          <Pill tone="blue">教师资源</Pill>
        </div>
      }
    >
      <TeacherResourceViewer
        teacherClassroomId={teacherClassroomId}
        teacherResources={teacherResources}
        courseName={course.name}
        backHref={`/teacher/prepare/${course.id}/preview`}
      />
    </DashboardShell>
  );
}
