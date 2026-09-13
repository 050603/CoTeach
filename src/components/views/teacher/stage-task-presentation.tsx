import type { Course } from "@/lib/session/types";
import { getCourseStageRequirements } from "@/lib/resource-package/course-requirements";

/** Use only the current stage's authored task; teacher-only notes stay private. */
export function StageTaskPresentation({ course }: { course: Course }) {
  const stage = course.stages?.[course.currentStageIndex];
  const requirements = getCourseStageRequirements(course, stage?.key ?? "");
  const sections = (course.content?.teachingOutline ?? []).filter((section) => section.stageKey === stage?.key);
  return (
    <section aria-label="当前阶段任务" className="teacher-presentation-task rounded-2xl border border-stone-200 bg-white p-6 text-stone-900">
      <h2 className="text-[clamp(28px,3vw,48px)] font-bold">{stage?.label ?? "当前阶段"}</h2>
      {requirements ? <div className="mt-5 space-y-4 text-[clamp(20px,2vw,28px)] leading-relaxed">
        <p className="whitespace-pre-wrap">{requirements.requirements}</p>
        {requirements.outputs ? <p className="whitespace-pre-wrap">交付要求：{requirements.outputs}</p> : null}
        {requirements.evaluationCriteria ? <p className="whitespace-pre-wrap">评价标准：{requirements.evaluationCriteria}</p> : null}
        {stage?.key === "reflection" ? requirements.reflectionQuestions.map((item, index) => <p key={index}>{item}</p>) : null}
      </div> : stage?.description ? <p className="mt-5 whitespace-pre-wrap text-[clamp(20px,2vw,28px)] leading-relaxed">{stage.description}</p> : null}
      {!requirements ? sections.map((section) => <article className="mt-6 space-y-3" key={section.id}>
        <h3 className="text-2xl font-bold">{section.title}</h3>
        {section.teachingGoal ? <p className="whitespace-pre-wrap text-xl leading-relaxed">学习目标：{section.teachingGoal}</p> : null}
        {section.studentActivity ? <p className="whitespace-pre-wrap text-xl leading-relaxed">任务与交付：{section.studentActivity}</p> : null}
      </article>) : null}
      {!requirements && !stage?.description && !sections.length ? <p className="mt-5 text-xl text-stone-600">本阶段暂无任务或展示资料。</p> : null}
    </section>
  );
}
