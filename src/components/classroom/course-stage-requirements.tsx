import type { Course } from "@/lib/session/types";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";

/** Resource-package requirements shared by classroom views without changing submission flows. */
export function CourseStageRequirements({ course, stageKey, teacher = false, expanded = false }: {
  course: Course; stageKey: string; teacher?: boolean; expanded?: boolean;
}) {
  const value = getCourseStageRequirements(course, stageKey);
  if (!value) return null;
  return <details aria-label="教案阶段要求" className="my-3 rounded-[10px] border border-stone-200 bg-white px-4 py-2 text-stone-800" open={expanded || undefined}>
    <summary className="min-h-11 cursor-pointer py-2 font-semibold">{value.title} · 教案要求 · {value.durationMin} 分钟</summary>
    <div className="space-y-3 border-t border-stone-100 py-3 text-sm leading-7">
      {value.requirements ? <p className="whitespace-pre-wrap">任务与活动：{value.requirements}</p> : null}
      {value.outputs ? <p className="whitespace-pre-wrap">交付要求：{value.outputs}</p> : null}
      {value.aiActions ? <p className="whitespace-pre-wrap">AI 伙伴支持：{value.aiActions}</p> : null}
      {teacher && value.teacherActions ? <p className="whitespace-pre-wrap">教师指导：{value.teacherActions}</p> : null}
      {value.evaluationCriteria ? <p className="whitespace-pre-wrap">评价标准：{value.evaluationCriteria}</p> : null}
      {stageKey === "reflection" && value.reflectionQuestions.length ? <div><p className="font-medium">反思参考要点</p><ul className="list-disc space-y-1 pl-5">{value.reflectionQuestions.filter(Boolean).map((item, index) => <li className="whitespace-pre-wrap" key={index}>{item}</li>)}</ul><p className="text-stone-500">根据下方课程反思题目，结合自己的学习经历完成提交。</p></div> : null}
      <p className="text-stone-500">与 AI 虚拟伙伴协作，提交自己的作品与学习证据。</p>
    </div>
  </details>;
}
