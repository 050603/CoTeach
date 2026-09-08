"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  Clock3,
  FilePenLine,
  Hourglass,
  LogIn,
  MonitorUp,
  X,
} from "lucide-react";
import { DashboardShell } from "@/components/dashboard-shell";
import { Pill, PrimaryButton } from "@/components/ui";
import { useCourse, useHydrated, useSession } from "@/lib/session/store";
import { StudentProjectedTeacherResource } from "@/components/openmaic-bridge/teacher-stage-resources";
import { StudentStageView } from "@/components/views/student/stage-dispatcher";
import { useRealtimeSync } from "@/hooks/use-realtime-sync";
import { useCoursePresence } from "@/hooks/use-course-presence";
import { StudentResourceProjection } from "@/components/classroom/simple-stage-resources";
import { StageEmptyState } from "@/components/classroom/classroom-ui";
import { StudentClassroomHeaderStatus } from "@/components/classroom/student-classroom-header-status";
import { normalizePblCourseConfig, type MakeArtifactMode } from "@/lib/pbl-course-config";

export default function StudentClassroomPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const course = useCourse(params?.id);
  useRealtimeSync(params?.id);
  const hydrated = useHydrated();
  const { user, studentName, joinedCourseId } = useSession();
  const presence = useCoursePresence({
    courseId: course?.id,
    role: "student",
    enabled: course?.status === "teaching" && course.id === joinedCourseId,
    heartbeat: true,
  });
  const [optionalProjectionOpen, setOptionalProjectionOpen] = useState(false);
  const activeStageKey = course?.stages[course.currentStageIndex]?.key;
  const makeArtifactMode = normalizePblCourseConfig(course?.pblConfig).makeArtifactMode;

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.speechSynthesis?.cancel();
  }, [activeStageKey]);

  useEffect(() => {
    if (!hydrated) return;
    if (joinedCourseId && joinedCourseId !== params?.id) router.replace("/student");
  }, [hydrated, joinedCourseId, params?.id, router]);

  useEffect(() => {
    if (
      !hydrated
      || course?.status !== "teaching"
      || course.stages[course.currentStageIndex]?.view !== "ai-collaboration"
    ) return;
    router.replace(`/student/ai-collaboration/${course.id}`);
  }, [course, hydrated, makeArtifactMode, router]);

  const displayName = studentName || (user.name && user.name !== "教师" ? user.name : "学生");

  if (!hydrated) {
    return (
      <DashboardShell role="student" userName={displayName} variant="bare">
        <div className="grid place-items-center py-20 text-stone-500">加载中...</div>
      </DashboardShell>
    );
  }

  if (!course) {
    return (
      <DashboardShell role="student" userName={displayName} variant="bare">
        <div className="mx-auto mt-20 max-w-md text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[var(--pbl-danger-soft)] text-[var(--pbl-danger)]">
            <LogIn size={26} />
          </div>
          <h1 className="mt-4 text-2xl font-bold">未找到课堂</h1>
          <p className="mt-2 text-sm text-stone-500">该课堂不存在，或已被教师移除。</p>
          <PrimaryButton className="mt-6 h-11 px-6" onClick={() => router.replace("/student")}>
            返回学生端
          </PrimaryButton>
        </div>
      </DashboardShell>
    );
  }

  const currentStage = course.stages[course.currentStageIndex];
  const total = course.stages.length;
  const isTeaching = course.status === "teaching";
  const onlineCount = course.students.filter((student) =>
    presence.onlineStudentIds.has(student.id)
  ).length;
  const projectedResource =
    course.uiState?.teacherResourceProjection?.stageKey === currentStage?.key
      ? course.uiState.teacherResourceProjection
      : null;
  const forcedProjection = projectedResource && projectedResource.mode !== "optional" ? projectedResource : null;
  const optionalProjection = projectedResource?.mode === "optional" ? projectedResource : null;
  const uploadedProjection =
    course.uiState?.resourceProjection?.stageKey === currentStage?.key
      ? course.uiState.resourceProjection
      : null;
  const uploadedProjectionResource = uploadedProjection
    ? course.resources?.find((resource) => resource.id === uploadedProjection.resourceId)
    : undefined;

  if (isTeaching && currentStage?.view === "ai-collaboration") {
    return (
      <DashboardShell
        role="student"
        userName={displayName}
        variant="bare"
        currentCourse={{ id: course.id, name: course.name, status: course.status }}
        currentStage={{ index: course.currentStageIndex, total, label: currentStage.label }}
        hideCourseSwitcher
      >
        <div className="grid min-h-72 place-items-center text-sm text-stone-500">
          <span className="inline-flex items-center gap-2">正在进入项目实践协作工作台…</span>
        </div>
      </DashboardShell>
    );
  }

  return (
    <DashboardShell
      role="student"
      userName={displayName}
      variant="bare"
      wide={currentStage?.key === "ai-learning"}
      viewportLocked={isTeaching && activeStageKey === "ai-learning"}
      hideCourseSwitcher
      currentCourse={{ id: course.id, name: course.name, status: course.status }}
      currentStage={currentStage ? { index: course.currentStageIndex, total, label: currentStage.label } : undefined}
      currentTask={currentStage?.description}
      leadRole={currentStage?.key === "ai-learning" ? "AI" : currentStage?.key === "showcase" ? "教师" : "学生"}
      headerSlot={
        isTeaching && currentStage ? (
          <StudentClassroomHeaderStatus
            currentIndex={course.currentStageIndex}
            onlineCount={onlineCount}
            stageLabel={currentStage.label}
            total={total}
          />
        ) : (
          <Pill tone={isTeaching ? "green" : "orange"} className="hidden md:inline-flex">
            {isTeaching ? "课堂同步中" : "等待教师开始"}
          </Pill>
        )
      }
    >
      {course.status === "finished" ? (
        <FinishedState course={course} />
      ) : !isTeaching ? (
        <WaitingState status={course.status} />
      ) : currentStage ? (
        <>
          <div className={activeStageKey === "ai-learning" ? "flex h-full min-h-0 flex-col gap-3" : "space-y-3"}>
              {forcedProjection ? <StudentProjectedTeacherResource projection={forcedProjection} /> : null}
              {optionalProjection ? (
                <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--pbl-teacher-border)] bg-[var(--pbl-teacher-soft)]/80">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                    <div className="flex items-center gap-3"><span className="grid h-9 w-9 place-items-center rounded-full bg-white text-[var(--pbl-teacher)]"><MonitorUp size={18} /></span><div><p className="font-bold text-stone-900">教师正在投屏：{optionalProjection.title}</p><p className="text-xs text-[var(--pbl-teacher)]">你可以继续当前任务，也可以打开只读实时演示。</p></div></div>
                    <PrimaryButton onClick={() => setOptionalProjectionOpen((value) => !value)} type="button" variant="outline">{optionalProjectionOpen ? <><X size={15} />收起投屏</> : <><MonitorUp size={15} />查看投屏</>}</PrimaryButton>
                  </div>
                  {optionalProjectionOpen ? <div className="border-t border-[var(--pbl-teacher-border)] bg-white p-3"><StudentProjectedTeacherResource projection={optionalProjection} /></div> : null}
                </div>
              ) : null}
              {activeStageKey === "proposal" || activeStageKey === "make" ? (
                <AiCollaborationExperimentEntry
                  artifactMode={activeStageKey === "make" ? makeArtifactMode : "document"}
                  onOpen={activeStageKey === "make" && makeArtifactMode === "other"
                    ? undefined
                    : () => router.push(`/student/ai-collaboration/${course.id}${activeStageKey === "make" && (makeArtifactMode === "python" || makeArtifactMode === "c") ? `?artifact=${makeArtifactMode}` : ""}`)}
                />
              ) : null}
              <section className={activeStageKey === "ai-learning"
                ? "min-h-0 flex-1 overflow-hidden rounded-[var(--radius-lg)] border border-blue-100 bg-[linear-gradient(180deg,#f8fbff_0%,#ffffff_42%)] shadow-[0_16px_42px_rgba(30,64,175,0.08)]"
                : "overflow-hidden rounded-[var(--radius-lg)]"}>
                <StudentStageView
                  course={course}
                  view={currentStage.view}
                />
              </section>
          </div>
        </>
      ) : null}
      {uploadedProjectionResource ? (
        <StudentResourceProjection
          course={course}
          projection={uploadedProjection!}
          resource={uploadedProjectionResource}
        />
      ) : null}
    </DashboardShell>
  );
}

function AiCollaborationExperimentEntry({
  onOpen,
  artifactMode,
}: {
  onOpen?: () => void;
  artifactMode: MakeArtifactMode;
}) {
  const isOther = artifactMode === "other";
  const isCode = artifactMode === "python" || artifactMode === "c";
  const modeLabel = artifactMode === "python" ? "Python 代码" : artifactMode === "c" ? "C 语言代码" : isOther ? "其他成果" : "文档成果";
  return (
    <section className="classroom-stage flex flex-col gap-4 rounded-[var(--radius-lg)] border border-[var(--pbl-student-border)] bg-white p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between sm:p-5">
      <div className="flex min-w-0 items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-[var(--pbl-ai)] text-white shadow-sm">
          <FilePenLine size={21} />
        </span>
        <div>
          <p className="text-[11px] font-bold uppercase tracking-[.14em] text-[var(--pbl-student)]">教师已设置 · {modeLabel}</p>
          <h2 className="mt-1 text-base font-bold text-stone-950">{isOther ? "在本机制作作品，AI 组员继续提供支持" : isCode ? "边编写代码，边和 AI 小组成员协作" : "边写项目文档，边和 AI 小组成员协作"}</h2>
          <p className="mt-1 text-sm leading-6 text-stone-600">{isOther ? "可以用 AI 查资料、探讨问题和构建思路；完成后在当前任务区上传作品文件。" : `讨论、检查和整理都围绕正在编辑的${isCode ? "代码项目" : "文档"}进行；实际修改仍由你确认。`}</p>
        </div>
      </div>
      {onOpen ? <PrimaryButton className="h-11 shrink-0 px-5" onClick={onOpen} type="button">
        <FilePenLine size={16} />进入 AI 协作
      </PrimaryButton> : <span className="rounded-full bg-emerald-50 px-3 py-1.5 text-xs font-bold text-emerald-700">AI 组员已在当前工作台</span>}
    </section>
  );
}

function WaitingState({ status }: { status: string }) {
  const message = status === "ready" ? "教师尚未开始授课，请稍候。" : "课堂尚未开放，请稍候。";
  return <StageEmptyState description={message} icon={Hourglass} title="课堂暂未开始" tone="warning" />;
}

function FinishedState({ course }: { course: { name: string } }) {
  return <StageEmptyState description={`《${course.name}》已结束授课。你可以留在这里回看作品、评价证据和反思记录。`} icon={Clock3} title="课堂已结束" tone="neutral" />;
}
