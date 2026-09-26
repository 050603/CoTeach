import Link from "next/link";
import { notFound } from "next/navigation";
import { StudentShell } from "@/components/platform/student-shell";
import { StudentExperimentAssessment } from "@/components/platform/student-experiment-assessment";

export default async function StudentAssessmentPage({ params }: {
  params: Promise<{ activityId: string; instanceId: string; phase: string }>;
}) {
  const { activityId, instanceId, phase } = await params;
  if (phase !== "pretest" && phase !== "posttest") notFound();
  const activityHref = `/student/activities/${encodeURIComponent(activityId)}`;
  return <StudentShell focus>
    <div className="min-h-screen w-full px-4 py-5 sm:px-6 lg:px-8 xl:px-10">
      <nav aria-label="测验导航" className="flex min-h-11 items-center justify-between gap-4 border-b border-[var(--pbl-border)] pb-4">
        <Link className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm font-semibold text-[var(--pbl-student)] hover:bg-[var(--pbl-student-soft)]" href={activityHref}>← 返回课堂活动</Link>
        <span className="text-sm font-semibold text-[var(--pbl-text-muted)]">课堂{phase === "pretest" ? "前测" : "后测"}</span>
      </nav>
      <StudentExperimentAssessment instanceId={instanceId} layout="full" phase={phase} />
    </div>
  </StudentShell>;
}
