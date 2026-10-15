"use client";

import { ChevronRight } from "lucide-react";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";
import type { Course } from "@/lib/session/types";
import { CollaborationDialog } from "./collaboration-dialog";

export function CollaborationProjectDetails({ course, stageKey, projectTitle, projectGoal, label = "选题方向" }: {
  course: Course;
  stageKey: string;
  projectTitle: string;
  projectGoal?: string;
  label?: string;
}) {
  const requirements = getCourseStageRequirements(course, stageKey);
  const stage = course.stages.find((item) => item.key === stageKey);
  const sections = [
    { title: "选题方向", content: projectTitle },
    { title: "课程驱动问题", content: requirements?.drivingQuestion !== projectTitle ? requirements?.drivingQuestion : undefined },
    { title: "项目目标", content: projectGoal },
    { title: "项目任务", content: requirements?.projectTask },
    { title: "任务与活动", content: requirements?.requirements || stage?.description },
    { title: "交付要求", content: requirements?.outputs },
    { title: "阶段检查点", content: requirements?.checkpoints.join("\n") },
    { title: "最终交付物", content: requirements?.finalDeliverables.map((item) =>
      `${item.name}（${item.format}，${item.required ? "必交" : "选交"}）\n${item.requirements}`).join("\n\n") },
    { title: "AI 伙伴支持", content: requirements?.aiActions },
    { title: "AI 使用要求", content: requirements?.aiUsagePolicy },
  ].filter((section) => section.content?.trim());

  return (
    <h1 className="min-w-0 flex-[1_1_12rem]">
      <CollaborationDialog
        title="选题方向与要求"
        trigger={
          <button
            aria-label="查看完整选题方向与要求"
            className="group flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--pbl-student)]"
            type="button"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-[10px] font-medium leading-none text-stone-500">{label}</span>
              <span className="mt-1 block truncate text-base font-bold leading-tight text-stone-950 group-hover:text-[var(--pbl-student)] sm:text-lg">{projectTitle}</span>
            </span>
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-[var(--pbl-student)]">
              查看要求<ChevronRight aria-hidden="true" size={14} />
            </span>
          </button>
        }
      >
        <dl className="space-y-5 text-sm leading-7">
          {sections.map((section) => (
            <div key={section.title}>
              <dt className="font-semibold text-[var(--pbl-text-strong)]">{section.title}</dt>
              <dd className="mt-1 whitespace-pre-wrap text-[var(--pbl-text-muted)]">{section.content}</dd>
            </div>
          ))}
        </dl>
      </CollaborationDialog>
    </h1>
  );
}
