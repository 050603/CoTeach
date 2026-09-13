"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import {
  Beaker,
  Check,
  FileText,
  Lightbulb,
  MessageSquareMore,
  Presentation,
} from "lucide-react";
import { cn } from "@/lib/utils";

// Card-stack motion is adapted from React Bits' Stack component.
// React Bits is licensed for use inside applications under MIT + Commons Clause.
const COURSE_PAGES = [
  {
    id: "launch",
    eyebrow: "项目启动",
    title: "从真实问题出发",
    Icon: Lightbulb,
    accent: "orange",
    body: (
      <div className="space-y-2.5">
        <div className="h-2 w-4/5 rounded-full bg-orange-200/80" />
        <div className="h-2 w-3/5 rounded-full bg-stone-200" />
        <div className="mt-3 rounded-[7px] border border-orange-100 bg-orange-50 px-2.5 py-2 text-[9px] leading-4 text-orange-900">
          我们如何用证据提出一个可实施的解决方案？
        </div>
      </div>
    ),
  },
  {
    id: "knowledge",
    eyebrow: "知识建构",
    title: "核心概念与证据",
    Icon: Beaker,
    accent: "blue",
    body: (
      <div className="grid grid-cols-[1fr_72px] items-end gap-3">
        <div className="space-y-2">
          {["概念理解", "证据分析", "迁移应用"].map((item, index) => (
            <div className="flex items-center gap-2" key={item}>
              <span className="grid size-4 place-items-center rounded-full bg-blue-50 text-[8px] font-black text-blue-700">{index + 1}</span>
              <span className="text-[9px] font-semibold text-stone-600">{item}</span>
            </div>
          ))}
        </div>
        <div className="flex h-16 items-end gap-1.5 rounded-[7px] bg-blue-50/70 px-2 pb-2">
          {[35, 57, 78, 92].map((height) => <span className="flex-1 rounded-t-sm bg-blue-500/75" key={height} style={{ height: `${height}%` }} />)}
        </div>
      </div>
    ),
  },
  {
    id: "activity",
    eyebrow: "互动活动",
    title: "让学生真正参与",
    Icon: MessageSquareMore,
    accent: "violet",
    body: (
      <div className="grid grid-cols-2 gap-2">
        {["观察与判断", "讨论与修订"].map((item, index) => (
          <div className="rounded-[7px] border border-violet-100 bg-violet-50/70 p-2" key={item}>
            <span className="grid size-5 place-items-center rounded-[5px] bg-violet-600 text-[9px] font-black text-white">{index + 1}</span>
            <p className="mt-2 text-[9px] font-bold text-violet-950">{item}</p>
            <div className="mt-1.5 h-1.5 w-4/5 rounded-full bg-violet-200" />
          </div>
        ))}
      </div>
    ),
  },
  {
    id: "assessment",
    eyebrow: "评价反馈",
    title: "形成可见的学习证据",
    Icon: FileText,
    accent: "green",
    body: (
      <div className="space-y-2">
        {["目标与任务一致", "过程证据完整", "成果可以复核"].map((item) => (
          <div className="flex items-center gap-2 rounded-[6px] bg-emerald-50/70 px-2 py-1.5" key={item}>
            <span className="grid size-4 place-items-center rounded-full bg-emerald-600 text-white"><Check size={9} strokeWidth={3} /></span>
            <span className="text-[9px] font-semibold text-emerald-950">{item}</span>
          </div>
        ))}
      </div>
    ),
  },
] as const;

export function CourseBuildAnimation({
  running,
}: {
  running: boolean;
}) {
  const [stack, setStack] = useState(() => COURSE_PAGES.map((page) => page.id));
  const prefersReducedMotion = useReducedMotion();
  const shouldAnimate = running && !prefersReducedMotion;

  useEffect(() => {
    if (!shouldAnimate) return;
    const timer = window.setInterval(() => {
      setStack((current) => {
        const next = [...current];
        const top = next.pop();
        return top ? [top, ...next] : current;
      });
    }, 2_700);
    return () => window.clearInterval(timer);
  }, [shouldAnimate]);

  return (
    <div className="course-build-scene relative mx-auto h-[286px] w-full max-w-[410px]">
      <div aria-hidden className="course-build-glow" />
      <div aria-hidden className="course-build-stage-lines" />
      <div className="absolute left-1/2 top-1/2 h-[202px] w-[292px] -translate-x-1/2 -translate-y-1/2 [perspective:1000px]">
        {stack.map((pageId, index) => {
          const page = COURSE_PAGES.find((item) => item.id === pageId) ?? COURSE_PAGES[0];
          const depth = stack.length - index - 1;
          const isTop = index === stack.length - 1;
          return (
            <motion.div
              animate={{
                opacity: 1 - depth * 0.12,
                rotateZ: depth * -2.2,
                rotateX: depth * 1.4,
                scale: 1 - depth * 0.055,
                x: depth * 9,
                y: depth * -9,
                z: depth * -32,
              }}
              className={cn(
                "absolute inset-0 overflow-hidden rounded-[13px] border bg-white shadow-[0_18px_45px_rgba(41,37,36,0.17)] [backface-visibility:hidden] [transform-style:preserve-3d]",
                isTop ? "border-stone-200" : "border-stone-200/80",
              )}
              initial={false}
              key={page.id}
              transition={prefersReducedMotion ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 23, mass: 0.85 }}
            >
              <CoursePage page={page} active={isTop && shouldAnimate} />
            </motion.div>
          );
        })}
      </div>

      <div className="absolute bottom-0 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-white/90 bg-white/85 px-3 py-1.5 text-[10px] font-bold text-stone-600 shadow-[0_8px_24px_rgba(41,37,36,0.11)] backdrop-blur-sm">
        <Presentation className="text-[var(--pbl-teacher)]" size={12} />
        课堂内容持续生成中
        <span className={cn("size-1.5 rounded-full bg-[var(--pbl-teacher)]", shouldAnimate && "course-build-pulse")} />
      </div>
      <style>{`
        .course-build-scene { isolation: isolate; }
        .course-build-glow {
          position: absolute;
          left: 50%;
          top: 49%;
          width: 245px;
          height: 150px;
          transform: translate(-50%, -50%);
          border-radius: 999px;
          background: radial-gradient(ellipse, rgba(96,165,250,.2), rgba(251,146,60,.07) 52%, transparent 72%);
          filter: blur(18px);
          animation: course-build-breathe 4s ease-in-out infinite;
        }
        .course-build-stage-lines {
          position: absolute;
          inset: 30px 8px 12px;
          z-index: -1;
          background-image:
            linear-gradient(rgba(29,78,216,.09) 1px, transparent 1px),
            linear-gradient(90deg, rgba(29,78,216,.09) 1px, transparent 1px);
          background-size: 19px 19px;
          mask-image: radial-gradient(ellipse at center, black, transparent 73%);
          transform: perspective(420px) rotateX(62deg) translateY(45px) scale(1.15);
          transform-origin: center bottom;
        }
        .course-page-scan {
          position: absolute;
          inset: -45% 0 auto;
          z-index: 20;
          height: 42%;
          pointer-events: none;
          background: linear-gradient(to bottom, transparent, rgba(96,165,250,.11), rgba(29,78,216,.22), transparent);
          transform: skewY(-3deg);
          animation: course-page-scan 2.7s cubic-bezier(.45,.05,.55,.95) infinite;
        }
        .course-build-pulse { animation: course-build-pulse 1.5s ease-in-out infinite; }
        @keyframes course-page-scan {
          0% { top: -46%; opacity: 0; }
          16% { opacity: 1; }
          78% { opacity: .9; }
          100% { top: 112%; opacity: 0; }
        }
        @keyframes course-build-breathe {
          0%, 100% { opacity: .65; transform: translate(-50%, -50%) scale(.92); }
          50% { opacity: 1; transform: translate(-50%, -50%) scale(1.08); }
        }
        @keyframes course-build-pulse {
          0%, 100% { opacity: .45; box-shadow: 0 0 0 0 rgba(29,78,216,.24); }
          50% { opacity: 1; box-shadow: 0 0 0 5px rgba(29,78,216,0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .course-build-glow,
          .course-page-scan,
          .course-build-pulse { animation: none; }
        }
      `}</style>
    </div>
  );
}

function CoursePage({
  page,
  active,
}: {
  page: (typeof COURSE_PAGES)[number];
  active: boolean;
}) {
  const { Icon } = page;
  return (
    <div className="relative h-full p-3.5">
      {active ? <span aria-hidden className="course-page-scan" /> : null}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn(
            "text-[8px] font-black uppercase tracking-[0.18em]",
            page.accent === "orange" && "text-orange-700",
            page.accent === "blue" && "text-blue-700",
            page.accent === "violet" && "text-violet-700",
            page.accent === "green" && "text-emerald-700",
          )}>{page.eyebrow}</p>
          <h3 className="mt-1 text-[13px] font-bold text-stone-900">{page.title}</h3>
        </div>
        <span className={cn(
          "grid size-7 shrink-0 place-items-center rounded-[7px]",
          page.accent === "orange" && "bg-orange-50 text-orange-700",
          page.accent === "blue" && "bg-blue-50 text-blue-700",
          page.accent === "violet" && "bg-violet-50 text-violet-700",
          page.accent === "green" && "bg-emerald-50 text-emerald-700",
        )}><Icon size={14} /></span>
      </div>
      <div className="mt-3 border-t border-stone-100 pt-3">{page.body}</div>
      <span className="absolute bottom-2.5 right-3 text-[8px] font-semibold tabular-nums text-stone-300">COTEACH · {page.id.toUpperCase()}</span>
    </div>
  );
}
