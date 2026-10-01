"use client";

import type { TeachingBlueprint } from "@/lib/session/types";

function DetailText({ label, value }: { label: string; value?: string }) {
  if (!value?.trim()) return null;
  return <div><dt className="text-xs font-semibold text-stone-500">{label}</dt><dd className="mt-1 whitespace-pre-wrap text-sm leading-7 text-stone-800">{value}</dd></div>;
}

function DetailList({ label, items }: { label: string; items?: string[] }) {
  if (!items?.length) return null;
  return <div><dt className="text-xs font-semibold text-stone-500">{label}</dt><dd><ul className="mt-1 list-disc space-y-1 pl-5 text-sm leading-7 text-stone-800">{items.map((item, index) => <li className="whitespace-pre-wrap" key={index}>{item}</li>)}</ul></dd></div>;
}

export function TeachingBlueprintDetails({ blueprint }: { blueprint: TeachingBlueprint | null | undefined }) {
  if (!blueprint?.sections.length) {
    return <p className="py-8 text-center text-sm text-stone-500">教学蓝图尚未生成。已有页面安排可在“页面大纲”中查看。</p>;
  }

  return (
    <div className="space-y-6" aria-label="教学蓝图详情">
      <p className="text-sm text-stone-600">
        {blueprint.sections.length} 个知识小节 · {blueprint.sections.reduce((sum, section) => sum + section.pages.length, 0)} 个讲授与互动页面 · 约 {Math.round(blueprint.budget.totalDurationSec / 60)} 分钟
      </p>
      {blueprint.sections.map((section, sectionIndex) => (
        <section className="rounded-[10px] border border-stone-200 bg-white p-4 sm:p-5" key={section.id}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-stone-200 pb-4">
            <div>
              <h3 className="text-base font-semibold text-stone-950">{sectionIndex + 1}. {section.title}</h3>
              <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-stone-600">{section.learningObjective}</p>
            </div>
            <p className="text-xs leading-6 text-stone-500">讲授 {Math.round(section.teachingDurationSec / 60)} 分钟 · 活动 {Math.round(section.learnerActivityDurationSec / 60)} 分钟 · 检测 {Math.round(section.assessmentDurationSec / 60)} 分钟</p>
          </div>
          <dl className="mt-4 grid gap-4 sm:grid-cols-2">
            <DetailText label="学习目的" value={section.sharedContext?.learningPurpose} />
            <DetailList label="案例事实" items={section.sharedContext?.caseFacts} />
            <DetailList label="概念边界" items={section.sharedContext?.conceptBoundaries} />
            <DetailList label="检测重点" items={section.assessmentFocus} />
            <DetailList label="理解目标" items={section.understandingCriteria?.goals} />
            <DetailList label="回答要点" items={section.understandingCriteria?.answerEssentials} />
            <DetailList label="典型误解" items={section.understandingCriteria?.misconceptions} />
          </dl>
          <h4 className="mt-6 text-sm font-semibold text-stone-950">讲授单元</h4>
          <div className="mt-3 space-y-3">
            {section.units.map((unit, unitIndex) => (
              <details className="rounded-[8px] border border-stone-200 px-4 py-3" key={unit.id} open={unitIndex === 0}>
                <summary className="cursor-pointer text-sm font-semibold text-stone-900">{unit.title}</summary>
                <dl className="mt-4 space-y-4">
                  <DetailText label="学习成果" value={unit.learningOutcome} />
                  <DetailText label="核心解释" value={unit.explanation} />
                  <DetailText label="机制与推理" value={unit.mechanism} />
                  <DetailText label="示例" value={unit.workedExample} />
                  <DetailList label="适用条件与边界" items={unit.conditions} />
                  <DetailList label="常见误解" items={unit.misconceptions} />
                  <DetailList label="具体讲授内容" items={unit.explanationNodes?.map((node) => node.content)} />
                  <DetailList label="资料依据" items={unit.evidenceQuotes} />
                </dl>
              </details>
            ))}
          </div>
          <h4 className="mt-6 text-sm font-semibold text-stone-950">页面分工</h4>
          <ol className="mt-3 space-y-3">
            {section.pages.map((page, pageIndex) => (
              <li className="rounded-[8px] border border-stone-200 px-4 py-3" key={page.id}>
                <h5 className="text-sm font-semibold text-stone-900">{pageIndex + 1}. {page.title}<span className="ml-2 text-xs font-normal text-stone-500">{page.type === "interactive" ? "互动页" : "讲授页"}</span></h5>
                <dl className="mt-3 space-y-3">
                  <DetailText label="页面说明" value={page.description} />
                  <DetailText label="教学目标" value={page.teachingObjective} />
                  <DetailList label="页面要点" items={page.keyPoints} />
                  <DetailList label="承担的讲授单元" items={section.units.filter((unit) => page.unitIds.includes(unit.id)).map((unit) => unit.title)} />
                </dl>
              </li>
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}
