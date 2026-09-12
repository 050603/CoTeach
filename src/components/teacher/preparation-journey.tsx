"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import {
  PREPARATION_FLOW_STEPS,
  resolvePreparationStepStates,
  type PreparationStepKey,
} from "@/lib/teacher/preparation-flow";
import { cn } from "@/lib/utils";

export function PreparationJourney({
  backHref,
  completedKeys,
  currentKey,
  onSelect,
}: {
  backHref: string;
  completedKeys: readonly PreparationStepKey[];
  currentKey: PreparationStepKey;
  onSelect: (key: PreparationStepKey) => void;
}) {
  const states = resolvePreparationStepStates({ completedKeys, currentKey });
  const currentIndex = PREPARATION_FLOW_STEPS.findIndex((step) => step.key === currentKey);
  const current = PREPARATION_FLOW_STEPS[currentIndex] ?? PREPARATION_FLOW_STEPS[0];

  return (
    <section
      aria-label="课程备课流程"
      className="relative mb-6 overflow-hidden rounded-[18px] border border-stone-200 bg-[radial-gradient(circle_at_12%_0%,rgba(180,83,9,0.10),transparent_28%),linear-gradient(135deg,#fffdf8_0%,#ffffff_48%,#f4f8f6_100%)] shadow-[0_18px_50px_rgba(71,55,35,0.07)]"
    >
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-stone-200/80 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-start gap-3">
          <Link
            aria-label="返回课程列表"
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-stone-300 bg-white/90 text-stone-600 shadow-sm transition hover:-translate-x-0.5 hover:border-amber-800 hover:text-amber-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-700 focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none"
            href={backHref}
          >
            <ArrowLeft size={18} />
          </Link>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-amber-800">
              课程设计 · {current.phase}
            </p>
            <h2 className="font-editorial mt-1 text-xl font-semibold text-stone-950">
              {current.label}
            </h2>
          </div>
        </div>
        <div className="rounded-full border border-stone-200 bg-white/80 px-3 py-1.5 text-xs font-semibold tabular-nums text-stone-600">
          步骤 {currentIndex + 1} / {PREPARATION_FLOW_STEPS.length}
        </div>
      </div>

      <label className="block px-5 py-4 text-sm font-semibold text-stone-700 lg:hidden">
        切换备课步骤
        <select
          className="mt-2 min-h-11 w-full min-w-0 rounded-[6px] border border-stone-300 bg-white px-3 text-sm"
          onChange={(event) => onSelect(event.target.value as PreparationStepKey)}
          value={currentKey}
        >
          {PREPARATION_FLOW_STEPS.map((step, index) => <option key={step.key} value={step.key}>{index + 1}. {step.label}{states[index] === "complete" ? "（已完成）" : ""}</option>)}
        </select>
      </label>

      <div className="hidden overflow-x-auto px-4 py-4 sm:px-6 lg:block">
        <ol className="grid min-w-[1060px] grid-cols-7">
          {PREPARATION_FLOW_STEPS.map((step, index) => {
            const state = states[index];
            const isCurrent = state === "current";
            const isComplete = state === "complete";

            return (
              <li className="relative min-w-0" key={step.key}>
                {index < PREPARATION_FLOW_STEPS.length - 1 ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute left-[calc(50%+18px)] right-[calc(-50%+18px)] top-[18px] h-px transition-colors duration-300 motion-reduce:transition-none",
                      isComplete ? "bg-emerald-500/70" : "bg-stone-300",
                    )}
                  />
                ) : null}
                <button
                  aria-current={isCurrent ? "step" : undefined}
                  className="group relative flex w-full flex-col items-center px-2 text-center outline-none"
                  onClick={() => onSelect(step.key)}
                  type="button"
                >
                  <span
                    className={cn(
                      "relative z-10 grid h-9 w-9 place-items-center rounded-full border text-xs font-black tabular-nums shadow-[0_0_0_5px_rgba(255,255,255,0.94)] transition duration-200 group-hover:-translate-y-0.5 group-focus-visible:ring-2 group-focus-visible:ring-amber-700 group-focus-visible:ring-offset-2 motion-reduce:transform-none motion-reduce:transition-none",
                      isCurrent &&
                        "scale-110 border-amber-950 bg-amber-950 text-white shadow-[0_0_0_6px_rgba(254,243,199,0.95)]",
                      isComplete &&
                        "border-emerald-600 bg-emerald-600 text-white",
                      !isCurrent &&
                        !isComplete &&
                        "border-stone-300 bg-white text-stone-500 group-hover:border-amber-700 group-hover:text-amber-800",
                    )}
                  >
                    {isComplete ? <Check size={15} strokeWidth={3} /> : index + 1}
                  </span>
                  <span
                    className={cn(
                      "mt-3 text-[10px] font-bold uppercase tracking-[0.16em]",
                      isCurrent
                        ? "text-amber-800"
                        : isComplete
                          ? "text-emerald-700"
                          : "text-stone-400",
                    )}
                  >
                    {step.phase}
                  </span>
                  <span
                    className={cn(
                      "mt-1 text-xs font-bold",
                      isCurrent ? "text-stone-950" : "text-stone-600",
                    )}
                  >
                    {step.shortLabel}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-stone-200/80 bg-white/55 px-5 py-3 text-xs text-stone-600 sm:px-6">
        <span>
          <b className="text-stone-800">承接：</b>
          {current.upstream}
        </span>
        <ArrowRight className="hidden text-stone-300 sm:block" size={14} />
        <span>
          <b className="text-stone-800">本步产出：</b>
          {current.output}
        </span>
      </div>
    </section>
  );
}
