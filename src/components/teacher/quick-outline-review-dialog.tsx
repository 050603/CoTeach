"use client";

import { Check, Minimize2 } from "lucide-react";
import { motion } from "motion/react";
import { useMemo, useState } from "react";
import { OutlinesEditor } from "@/components/openmaic/generation/outlines-editor";
import { I18nProvider } from "@/lib/openmaic/hooks/use-i18n";
import { countBlockingOutlines, validateOutline } from "@/lib/openmaic/edit/content-validation";
import type { SceneOutline } from "@/lib/openmaic/types/generation";

export function QuickOutlineReviewDialog({
  initialOutlines,
  testMode = false,
  onClose,
  onConfirm,
}: {
  initialOutlines: SceneOutline[];
  testMode?: boolean;
  onClose: () => void;
  onConfirm: (outlines: SceneOutline[], testSectionId?: string) => Promise<void>;
}) {
  const [outlines, setOutlines] = useState(initialOutlines);
  const [selectedSectionId, setSelectedSectionId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const blockingCount = countBlockingOutlines(outlines);
  const sectionSummaries = useMemo(() => {
    const groups = new Map<string, SceneOutline[]>();
    for (const outline of outlines) {
      const key = outline.lectureSectionId || outline.parentActivityId || outline.activityId || "course";
      groups.set(key, [...(groups.get(key) ?? []), outline]);
    }
    return [...groups.entries()].map(([id, pages]) => {
      const teaching = pages.filter((page) => page.type !== "quiz");
      const criteria = pages.find((page) => page.teachingBrief?.understandingCriteria)
        ?.teachingBrief?.understandingCriteria;
      return {
        id,
        title: pages[0]?.lectureSectionTitle || pages[0]?.title || "知识小节",
        pageCount: pages.length,
        selectable: pages.every((page) => page.lectureSectionId?.trim() === id)
          && pages.some((page) => page.type === "quiz")
          && teaching.length > 0
          && pages.every((page) => (page.targetDurationSec ?? page.estimatedDuration ?? 0) > 0),
        minutes: Math.max(1, Math.round(pages.reduce((sum, page) => sum + (page.targetDurationSec ?? page.estimatedDuration ?? 0), 0) / 60)),
        mainline: teaching.flatMap((page) => page.teachingBrief?.teachingPlan?.newContent ? [page.teachingBrief.teachingPlan.newContent] : []),
        reasoning: teaching.flatMap((page) => page.teachingBrief?.teachingPlan?.reasoningSteps ?? []),
        examples: [...new Set(teaching.flatMap((page) => page.teachingBrief?.examples ?? []))],
        criteria,
      };
    });
  }, [outlines]);

  async function confirm() {
    if (saving || outlines.length === 0 || blockingCount > 0) return;
    if (testMode && !sectionSummaries.some((section) => section.id === selectedSectionId && section.selectable)) {
      setError("请先选择一个包含讲授页面和节末检测的完整知识小节。");
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      if (testMode) await onConfirm(outlines, selectedSectionId);
      else await onConfirm(outlines);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法保存大纲，请稍后重试。");
    } finally {
      setSaving(false);
    }
  }

  function jumpToFirstInvalidOutline() {
    const first = outlines.find((outline) => validateOutline(outline).length > 0);
    if (first) document.getElementById(`outline-scene-${first.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  return (
    <motion.div animate={{ opacity: 1 }} className="fixed inset-0 z-[90] bg-stone-950/45 p-3 backdrop-blur-sm sm:p-6" exit={{ opacity: 0 }} initial={{ opacity: 0 }} role="dialog" aria-modal="true" aria-label="审阅课程页面大纲">
      <motion.div className="mx-auto flex h-full max-w-[1180px] flex-col overflow-hidden rounded-[18px] border border-white/70 bg-[#f8f7f3] shadow-[0_32px_90px_rgba(28,25,23,.28)]" layoutId="quick-course-outline-surface" transition={{ type: "spring", stiffness: 155, damping: 24, mass: .9 }}>
        <header className="flex items-center justify-between gap-4 border-b border-stone-200 bg-white px-5 py-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[.14em] text-blue-700">快速生成已暂停</p>
            <h2 className="mt-1 font-editorial text-xl font-semibold text-stone-950">课程详细大纲</h2>
            <p className="mt-1 text-xs text-stone-500">{testMode
              ? "请在完整大纲中选择最关心的一个知识小节；确认后仅生成这一小节供预览。"
              : "保存后，后续课堂资源将严格按照这里确认的页面、互动与教师资源继续生成。"}</p>
          </div>
          <button className="grid size-9 shrink-0 place-items-center rounded-full border border-stone-200 bg-white text-stone-500 transition hover:border-stone-400 hover:text-stone-900 disabled:opacity-50" disabled={saving} onClick={onClose} type="button" aria-label="缩小并返回快速生成卡片">
            <Minimize2 size={16} />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6" data-testid="outline-review-scroll-area">
          <section className="mb-5 space-y-3" aria-label="小节知识主线与理解标准">
            <div>
              <h3 className="text-sm font-semibold text-stone-950">{testMode ? "选择要测试的知识小节" : "先审阅整节讲授内容"}</h3>
              <p className="mt-1 text-xs text-stone-500">{testMode
                ? "完整课程大纲保留在下方；本次仅生成所选小节的讲授、互动和检测页面。"
                : "这里确认的是核心解释、推理与理解标准；下面再展开页面分工。"}</p>
            </div>
            {sectionSummaries.map((section) => (
              <article className={`rounded-xl border bg-white p-4 shadow-sm ${testMode && selectedSectionId === section.id ? "border-blue-500 ring-2 ring-blue-100" : "border-stone-200"}`} key={section.id}>
                <div className="flex items-center justify-between gap-3">
                  {testMode ? (
                    <label className="flex cursor-pointer items-center gap-3 font-semibold text-stone-900">
                      <input
                        checked={selectedSectionId === section.id}
                        className="size-4 accent-blue-700"
                        disabled={!section.selectable || saving}
                        name="test-section"
                        onChange={() => { setSelectedSectionId(section.id); setError(undefined); }}
                        type="radio"
                        value={section.id}
                      />
                      {section.title}
                    </label>
                  ) : <h4 className="font-semibold text-stone-900">{section.title}</h4>}
                  <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">约 {section.minutes} 分钟</span>
                </div>
                {testMode ? <p className="mt-1 text-xs text-stone-500">{section.pageCount} 页{section.selectable ? "，包含讲授与节末检测" : "，缺少小节归属、讲授、节末检测或页面时长，暂不可选择"}</p> : null}
                <div className="mt-3 grid gap-3 lg:grid-cols-2">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500">知识主线与关键解释</p>
                    <ul className="mt-1.5 space-y-1 text-sm leading-6 text-stone-700">
                      {section.mainline.map((item, index) => <li key={`${section.id}-main-${index}`}>{item}</li>)}
                    </ul>
                  </div>
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-wide text-stone-500">怎样算理解</p>
                    <ul className="mt-1.5 space-y-1 text-sm leading-6 text-stone-700">
                      {(section.criteria?.goals ?? []).map((item, index) => <li key={`${section.id}-goal-${index}`}>{item}</li>)}
                      {(section.criteria?.answerEssentials ?? []).map((item, index) => <li key={`${section.id}-answer-${index}`}>回答要点：{item}</li>)}
                    </ul>
                  </div>
                </div>
                {section.reasoning.length || section.examples.length ? (
                  <details className="mt-3 rounded-lg bg-stone-50 px-3 py-2 text-sm text-stone-700">
                    <summary className="cursor-pointer font-semibold text-stone-800">查看推理连接、例子与边界</summary>
                    {section.reasoning.map((item, index) => <p className="mt-2 leading-6" key={`${section.id}-reason-${index}`}>{item}</p>)}
                    {section.examples.map((item, index) => <p className="mt-2 leading-6" key={`${section.id}-example-${index}`}>例子：{item}</p>)}
                    {(section.criteria?.misconceptions ?? []).map((item, index) => <p className="mt-2 leading-6" key={`${section.id}-misconception-${index}`}>典型误解：{item}</p>)}
                  </details>
                ) : null}
              </article>
            ))}
          </section>
          <I18nProvider>
            <OutlinesEditor
              alwaysReview
              bare
              distinguishAudience
              hideFooter
              hideHeader
              isLoading={saving}
              naturalFlow
              onBack={onClose}
              onChange={setOutlines}
              onConfirm={() => void confirm()}
              outlines={outlines}
              scriptWorkspace
            />
          </I18nProvider>
        </div>
        <footer className="shrink-0 border-t border-stone-200 bg-white px-4 py-3 sm:px-6" aria-label="大纲确认操作">
          {error ? <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{error}</p> : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-stone-500">
              {blockingCount > 0 ? (
                <button className="font-semibold text-amber-700 underline underline-offset-2" onClick={jumpToFirstInvalidOutline} type="button">
                  {blockingCount} 个页面缺少标题，点击定位
                </button>
              ) : `${outlines.length} 个页面可确认`}
            </div>
            <button
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[var(--pbl-teacher)] px-5 text-sm font-semibold text-white transition hover:bg-[var(--pbl-teacher-hover)] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={saving || outlines.length === 0 || blockingCount > 0}
              onClick={() => void confirm()}
              type="button"
            >
              <Check size={16} />
              {saving ? "正在保存并继续生成…" : testMode ? "生成所选小节" : "确认大纲并继续生成"}
            </button>
          </div>
        </footer>
      </motion.div>
    </motion.div>
  );
}
