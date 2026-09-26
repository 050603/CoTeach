"use client";

import { StudentExperimentAssessment } from "@/components/platform/student-experiment-assessment";
import Link from "next/link";
import { studentExperimentHref } from "@/lib/platform/experiment-entry";
import type { Course } from "@/lib/session/types";

export function ExperimentPosttestStudentView({ course }: { course: Course }) {
  if (course.platformContext) return <div className="mx-auto max-w-5xl px-3 py-8 sm:px-5">
    <section className="rounded-2xl border border-[var(--pbl-student-border)] bg-white p-6 shadow-sm sm:p-8">
      <p className="text-xs font-bold tracking-wider text-[var(--pbl-student)]">课堂第 5 阶段</p>
      <h2 className="mt-3 text-2xl font-bold text-[var(--pbl-text-strong)]">完成课堂后测</h2>
      <p className="mt-3 text-sm leading-7 text-[var(--pbl-text-muted)]">在独立答题页面阅读题目并作答。你的进度会自动保存，提交后可以返回查看。</p>
      <Link className="mt-6 inline-flex min-h-11 items-center justify-center rounded-lg bg-[var(--pbl-student)] px-6 text-sm font-bold text-white" href={studentExperimentHref(course.platformContext.activityId, course.id, "posttest")}>进入后测页面</Link>
    </section>
  </div>;
  return <div className="mx-auto max-w-7xl px-3 pb-8 sm:px-5">
    <StudentExperimentAssessment instanceId={course.id} key={course.id} phase="posttest" />
  </div>;
}
