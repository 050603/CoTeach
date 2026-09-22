"use client";

import { Globe2, WifiOff } from "lucide-react";
import { normalizePblCourseConfig } from "@/lib/pbl-course-config";
import type { Course } from "@/lib/session/types";
import { useSession } from "@/lib/session/store";

export function PracticeAiSettings({ course }: { course: Course }) {
  const { updateCourse } = useSession();
  const config = normalizePblCourseConfig(course.pblConfig);
  const enabled = config.practiceWebSearchEnabled;
  const Icon = enabled ? Globe2 : WifiOff;

  return (
    <button
      aria-pressed={enabled}
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 text-xs font-semibold text-stone-700 shadow-sm transition hover:border-blue-300 hover:text-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
      onClick={() => updateCourse(course.id, {
        pblConfig: normalizePblCourseConfig({
          ...course.pblConfig,
          practiceWebSearchEnabled: !enabled,
        }),
      })}
      title={enabled
        ? "项目实践阶段：教材不足时允许 AI 联网补充"
        : "项目实践阶段：只使用教材和课程内材料"}
      type="button"
    >
      <Icon className={enabled ? "text-emerald-700" : "text-stone-400"} size={14} />
      <span className="hidden text-stone-400 sm:inline">AI 联网</span>
      <span>{enabled ? "教材不足时" : "已关闭"}</span>
    </button>
  );
}
