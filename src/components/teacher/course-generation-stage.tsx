"use client";

import { useMemo } from "react";
import {
  BookOpen,
  Check,
  Circle,
  FileText,
  Hourglass,
  Image as ImageIcon,
  LoaderCircle,
  MessageSquareMore,
  Mic2,
  Presentation,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  currentGenerationProgress,
  estimateCourseGenerationRemainingSeconds,
} from "@/lib/teacher/course-generation-progress";
import { CourseBuildAnimation } from "@/components/teacher/course-build-animation";

export type CourseGenerationProgressStep = {
  step: string;
  progress: number;
  message: string;
  ts: number;
};

type GenerationStatus = "loading" | "success" | "error";

type GenerationResultSummary = {
  scenesCount: number;
  studentSceneCount?: number;
  teacherSceneCount?: number;
  stage: { name: string };
  qualityReport?: {
    corrections: string[];
    warnings: string[];
  };
  teacherReviewItems?: Array<{ id: string }>;
  teacherReviewSummary?: string;
};

type Props = {
  status: GenerationStatus;
  steps: CourseGenerationProgressStep[];
  error: string | null;
  result: GenerationResultSummary | null;
  adaptiveBranchCount: number;
  elapsedSeconds?: number;
  estimatedTotalSeconds?: number;
  estimatedRemainingSeconds?: number | null;
};

const BASE_PHASES = [
  { label: "理解课程设计", detail: "读取目标、课时与五阶段安排", threshold: 8 },
  { label: "规划课堂结构", detail: "安排知识、活动与评价顺序", threshold: 28 },
  { label: "制作教学内容", detail: "生成课件、讲稿与互动内容", threshold: 54 },
  { label: "补充媒体素材", detail: "处理配图、语音与可选媒体", threshold: 82 },
  { label: "整理师生资源", detail: "区分学生内容与教师支架", threshold: 86 },
] as const;

const STEP_LABELS: Record<string, string> = {
  initializing: "正在读取课程设置",
  researching: "正在梳理课程资料",
  generating_outlines: "正在规划课堂结构",
  generating_scenes: "正在制作教学内容",
  generating_media: "正在补充配图与媒体",
  generating_tts: "正在合成讲解语音",
  persisting: "正在整理并保存课程",
  completed: "主课程内容已经就绪",
};

const STEP_DETAILS: Record<string, string> = {
  initializing: "系统正在确认课程目标、课时安排和生成选项。",
  researching: "系统正在围绕课程主题整理可用于教学的背景资料。",
  generating_outlines: "系统正在把已确认的大纲拆分为具体的课堂页面。",
  generating_scenes: "系统正在逐页制作课件、讲稿、活动和知识检查。",
  generating_media: "系统正在为适合视觉表达的页面准备媒体素材。",
  generating_tts: "系统正在为学生学习内容准备同步讲解语音。",
  persisting: "系统正在检查内容关系，并将结果安全写入课程。",
  completed: "课程主体已经生成，正在完成最后的整理工作。",
};

const CONTENT_STREAM = [
  { label: "课件", Icon: Presentation, threshold: 31 },
  { label: "讲稿", Icon: FileText, threshold: 43 },
  { label: "互动", Icon: MessageSquareMore, threshold: 58 },
  { label: "配图", Icon: ImageIcon, threshold: 72 },
  { label: "语音", Icon: Mic2, threshold: 82 },
] as const;

export function CourseGenerationStage({
  status,
  steps,
  error,
  result,
  adaptiveBranchCount,
  elapsedSeconds = 0,
  estimatedTotalSeconds = 15 * 60,
  estimatedRemainingSeconds,
}: Props) {
  const phases = useMemo(
    () => [
      ...BASE_PHASES,
      ...(adaptiveBranchCount > 0
        ? [{
            label: "准备分层学习资源",
            detail: `${adaptiveBranchCount} 个已确认分支与主课同步生成`,
            threshold: 98,
          }]
        : []),
      {
        label: "检查并保存",
        detail: "检查课程完整性并保存结果",
        threshold: 100,
      },
    ],
    [adaptiveBranchCount],
  );

  const latest = steps.at(-1);
  const failedSteps = steps.filter((step) => step.step.includes("失败"));
  const progress = currentGenerationProgress(
    steps.map((step) => step.progress),
    status === "success",
  );
  const currentUpdate = describeProgress(latest);
  const isQuiet = status === "loading" && latest !== undefined && elapsedSeconds > 45;
  const remainingTime = status === "loading"
    ? formatEstimatedRemainingTime(
        estimatedRemainingSeconds ?? estimateCourseGenerationRemainingSeconds({
          elapsedSeconds,
          estimatedTotalSeconds,
          progress,
        }),
      )
    : null;
  return (
    <section
      aria-live="polite"
      className="generation-paper relative overflow-hidden rounded-[18px] border border-[var(--pbl-border)] bg-white shadow-[0_20px_55px_rgba(74,58,42,0.09)]"
    >
      <div aria-hidden className="generation-paper-lines absolute inset-0 opacity-55" />
      <div aria-hidden className="generation-ambient generation-ambient-blue" />
      <div aria-hidden className="generation-ambient generation-ambient-amber" />

      <div className="relative">
        <div className="border-b border-[var(--pbl-border)] px-5 py-6 sm:px-7 sm:py-8">
          <div className="grid items-center gap-7 md:grid-cols-[minmax(340px,0.95fr)_minmax(280px,1.05fr)]">
            <CourseBuildAnimation running={status === "loading"} />

            <div className="min-w-0 rounded-[12px] border border-stone-200 bg-white/82 p-4 shadow-[0_8px_24px_rgba(87,74,58,0.055)] backdrop-blur-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2 pt-1 text-xs font-bold text-stone-500">
                  <BookOpen className="text-[var(--pbl-teacher)]" size={15} />
                  现在正在做
                </div>
                <div
                  aria-label={`生成进度 ${progress}%`}
                  aria-valuemax={100}
                  aria-valuemin={0}
                  aria-valuenow={progress}
                  className="shrink-0 rounded-[9px] border border-blue-100 bg-blue-50/70 px-2.5 py-1.5 text-right"
                  role="progressbar"
                >
                  <span className="font-editorial text-xl font-semibold leading-none tabular-nums text-stone-950">{progress}</span>
                  <span className="ml-0.5 text-[11px] font-bold text-[var(--pbl-teacher)]">%</span>
                  <span className="ml-1.5 text-[9px] font-bold text-stone-400">进度</span>
                </div>
              </div>
              <div key={`${status}-${currentUpdate.label}`} className="generation-task-enter mt-2 min-h-8 font-editorial text-xl font-semibold text-stone-950 sm:text-2xl">
                {status === "success"
                  ? "全部内容已检查并保存"
                  : status === "error"
                    ? "等待您重新尝试"
                    : currentUpdate.label}
              </div>
              <p key={`${status}-${currentUpdate.detail}`} className="generation-task-enter generation-task-enter-delay mt-2 min-h-12 text-sm leading-6 text-stone-600">
                {status === "success" && result
                  ? completionSummary(result)
                  : status === "error"
                    ? error ?? "请检查模型设置后重新生成。"
                    : currentUpdate.detail}
              </p>

              {status === "loading" ? (
                <div aria-label="正在生成的内容类型" className="mt-4 flex flex-wrap gap-2">
                  {CONTENT_STREAM.map(({ label, Icon, threshold }, index) => {
                    const complete = progress >= threshold;
                    const previousThreshold = index === 0 ? 0 : CONTENT_STREAM[index - 1].threshold;
                    const active = progress >= previousThreshold && progress < threshold;
                    return (
                      <span
                        className={cn(
                          "generation-content-chip inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-bold",
                          complete && "border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)] text-[var(--pbl-success)]",
                          active && "border-blue-200 bg-blue-50 text-[var(--pbl-teacher)]",
                          !complete && !active && "border-stone-200 bg-white text-stone-400",
                        )}
                        key={label}
                        style={{ animationDelay: `${index * 100}ms` }}
                      >
                        <Icon size={12} />
                        {label}
                        {complete ? <Check size={10} strokeWidth={3} /> : active ? <span className="generation-chip-dot" /> : null}
                      </span>
                    );
                  })}
                </div>
              ) : null}

              {status === "loading" ? (
                <div className="mt-4 flex items-center gap-2 border-t border-stone-100 pt-3 text-xs font-semibold text-stone-500">
                  <Hourglass className="text-[var(--pbl-accent)]" size={14} />
                  {remainingTime}
                </div>
              ) : null}
            </div>
          </div>
          {isQuiet ? (
            <p className="mt-5 text-center text-xs font-semibold text-stone-500">当前步骤内容较多，系统仍在继续处理。</p>
          ) : null}
        </div>

        <div className="bg-[var(--pbl-surface-soft)]/45 px-5 py-6 sm:px-7">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-bold text-stone-900">课程生成步骤</p>
            </div>
            <span className="rounded-full border border-stone-200 bg-white px-2.5 py-1 text-[11px] font-bold text-stone-500">
              {phases.filter((phase) => status === "success" || progress >= phase.threshold).length}/{phases.length} 已完成
            </span>
          </div>

          <ol className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {phases.map((phase, index) => {
              const previousThreshold = index === 0 ? 0 : phases[index - 1].threshold;
              const complete = status === "success" || progress >= phase.threshold;
              const active = status === "loading" && progress >= previousThreshold && progress < phase.threshold;
              return (
                <li
                  className={cn(
                    "relative grid min-h-[76px] grid-cols-[30px_minmax(0,1fr)] gap-3 overflow-hidden rounded-[10px] border bg-white px-3 py-3",
                    complete && "border-[var(--pbl-success-border)] bg-[var(--pbl-success-soft)]/55",
                    active && "generation-phase-active border-[var(--pbl-accent-border)] shadow-[0_8px_22px_rgba(194,65,12,0.08)]",
                    !complete && !active && "border-stone-200/80",
                  )}
                  key={phase.label}
                >
                  <span
                    className={cn(
                      "relative z-10 mt-0.5 grid h-7 w-7 place-items-center rounded-full border bg-white",
                      complete && "border-[var(--pbl-success)] bg-[var(--pbl-success)] text-white",
                      active && "generation-active-step border-[var(--pbl-accent)] bg-[var(--pbl-accent-soft)] text-[var(--pbl-accent)]",
                      !complete && !active && "border-stone-300 text-stone-300",
                    )}
                  >
                    {complete ? <Check size={13} strokeWidth={3} /> : active ? <LoaderCircle size={13} /> : <Circle fill="currentColor" size={6} />}
                  </span>
                  <span>
                    <span className={cn("block text-sm font-bold", !complete && !active ? "text-stone-400" : "text-stone-900")}>
                      {phase.label}
                    </span>
                    <span className={cn("mt-0.5 block text-[11px] leading-4", active ? "text-[var(--pbl-accent)]" : "text-stone-500")}>
                      {active ? `进行中 · ${phase.detail}` : phase.detail}
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <div className="relative border-t border-[var(--pbl-border)] bg-white px-5 py-4 sm:px-7">
        {steps.length > 0 ? (
          <details>
            <summary className="cursor-pointer text-xs font-bold text-stone-600 marker:text-stone-400">
              查看最近进展（{steps.length} 条）
            </summary>
            <ol className="mt-3 max-h-52 space-y-2 overflow-y-auto pr-2 text-xs">
              {steps.map((step, index) => {
                const update = describeProgress(step);
                return (
                  <li className="grid grid-cols-[42px_minmax(0,1fr)] gap-3 rounded-[8px] bg-[var(--pbl-surface-soft)] px-3 py-2.5" key={`${step.ts}-${index}`}>
                    <span className="font-bold tabular-nums text-[var(--pbl-teacher)]">{step.progress}%</span>
                    <span>
                      <span className="font-bold text-stone-800">{update.label}</span>
                      <span className="ml-2 text-stone-500">{update.detail}</span>
                    </span>
                  </li>
                );
              })}
            </ol>
          </details>
        ) : (
          <p className="text-xs text-stone-500">正在连接生成服务，收到进展后会显示在这里。</p>
        )}

        {status === "success" && result?.teacherReviewSummary ? (
          <details className="mt-4 rounded-[10px] border border-amber-200 bg-amber-50 px-4 py-3" open={Boolean(result.teacherReviewItems?.length)}>
            <summary className="cursor-pointer text-sm font-bold text-stone-800">
              授课前待确认信息{result.teacherReviewItems?.length ? `（${result.teacherReviewItems.length} 项）` : ""}
            </summary>
            <p className="mt-3 whitespace-pre-wrap text-xs leading-6 text-stone-600">{result.teacherReviewSummary}</p>
          </details>
        ) : null}

        {status === "success" && result?.qualityReport &&
        (result.qualityReport.corrections.length > 0 || result.qualityReport.warnings.length > 0) ? (
          <details className="mt-4 rounded-[10px] border border-[var(--pbl-warning-border)] bg-[var(--pbl-warning-soft)] px-4 py-3">
            <summary className="cursor-pointer text-sm font-bold text-stone-800">
              内容检查：已自动完善 {result.qualityReport.corrections.length} 项，另有 {result.qualityReport.warnings.length} 项建议复核
            </summary>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-xs leading-5 text-stone-600">
              {result.qualityReport.corrections.map((item) => <li key={`fix-${item}`}>已完善：{item}</li>)}
              {result.qualityReport.warnings.map((item) => <li key={`warn-${item}`}>建议复核：{item}</li>)}
            </ul>
          </details>
        ) : null}

        {failedSteps.length > 0 ? (
          <div className="mt-4 rounded-[10px] border border-[var(--pbl-danger-border)] bg-[var(--pbl-danger-soft)] px-4 py-3 text-sm text-[var(--pbl-danger)]">
            <div className="font-bold">{failedSteps.length} 项分层学习资源需要在发布前复核</div>
            <p className="mt-1 text-xs leading-5 text-stone-600">主课程已经保留；失败的分支不会临时出现在学生课堂中。</p>
          </div>
        ) : null}
      </div>

      <style>{`
        .generation-paper {
          background: radial-gradient(circle at 92% 4%, rgba(254, 215, 170, .32), transparent 24%), #fff;
        }
        .generation-paper-lines {
          background-image: linear-gradient(rgba(231, 229, 228, .42) 1px, transparent 1px);
          background-size: 100% 30px;
          mask-image: linear-gradient(to bottom, black, transparent 72%);
        }
        .generation-ambient {
          position: absolute;
          width: 280px;
          height: 280px;
          border-radius: 999px;
          filter: blur(70px);
          pointer-events: none;
          opacity: .11;
          animation: generation-drift 9s ease-in-out infinite alternate;
        }
        .generation-ambient-blue {
          left: -150px;
          top: 22%;
          background: #60a5fa;
        }
        .generation-ambient-amber {
          right: -150px;
          top: -110px;
          background: #fb923c;
          animation-delay: -4s;
          animation-direction: alternate-reverse;
        }
        .generation-task-enter {
          animation: generation-task-in 520ms cubic-bezier(.22,1,.36,1) both;
        }
        .generation-task-enter-delay { animation-delay: 70ms; }
        .generation-content-chip {
          animation: generation-chip-in 460ms cubic-bezier(.22,1,.36,1) both;
          transition: border-color 350ms ease, background-color 350ms ease, color 350ms ease, transform 350ms ease;
        }
        .generation-content-chip:hover { transform: translateY(-2px); }
        .generation-chip-dot {
          width: 5px;
          height: 5px;
          border-radius: 999px;
          background: currentColor;
          animation: generation-chip-pulse 1.15s ease-in-out infinite;
        }
        .generation-phase-active::after {
          content: "";
          position: absolute;
          left: -42%;
          top: 0;
          width: 42%;
          height: 2px;
          background: linear-gradient(90deg, transparent, var(--pbl-accent), transparent);
          animation: generation-phase-beam 2s ease-in-out infinite;
        }
        .generation-active-step { animation: generation-pulse 1.8s ease-in-out infinite; }
        .generation-active-step svg { animation: generation-spin 2s linear infinite; }
        @keyframes generation-spin { to { transform: rotate(360deg); } }
        @keyframes generation-drift {
          from { transform: translate3d(0, -10px, 0) scale(.9); opacity: .07; }
          to { transform: translate3d(38px, 28px, 0) scale(1.13); opacity: .15; }
        }
        @keyframes generation-task-in {
          from { opacity: 0; transform: translateY(9px); filter: blur(4px); }
          to { opacity: 1; transform: translateY(0); filter: blur(0); }
        }
        @keyframes generation-chip-in {
          from { opacity: 0; transform: translateY(7px) scale(.94); }
          to { opacity: 1; transform: translateY(0) scale(1); }
        }
        @keyframes generation-chip-pulse {
          0%, 100% { opacity: .35; transform: scale(.7); }
          50% { opacity: 1; transform: scale(1.25); box-shadow: 0 0 0 4px rgba(29,78,216,.08); }
        }
        @keyframes generation-phase-beam { to { left: 100%; } }
        @keyframes generation-pulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(194, 65, 12, .18); }
          50% { box-shadow: 0 0 0 7px rgba(194, 65, 12, 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .generation-active-step,
          .generation-active-step svg,
          .generation-ambient,
          .generation-task-enter,
          .generation-content-chip,
          .generation-chip-dot,
          .generation-phase-active::after { animation: none; }
        }
      `}</style>
    </section>
  );
}

function describeProgress(step?: CourseGenerationProgressStep): { label: string; detail: string } {
  if (!step) {
    return {
      label: "正在建立生成任务",
      detail: "系统正在连接生成服务，稍后会持续显示每一步的实际进展。",
    };
  }

  const label = STEP_LABELS[step.step] ?? (containsChinese(step.step) ? step.step : "正在处理课程内容");
  const localizedMessage = localizeProgressMessage(step.message);
  return {
    label,
    detail: localizedMessage ?? STEP_DETAILS[step.step] ?? "系统正在继续处理这一部分，请稍候。",
  };
}

function localizeProgressMessage(message: string): string | null {
  const trimmed = message.trim();
  if (!trimmed) return null;

  const sceneStart = trimmed.match(/^Generating scene\s+(\d+)\/(\d+):\s*(.+)$/i);
  if (sceneStart) return `正在制作第 ${sceneStart[1]}/${sceneStart[2]} 个课堂页面：${sceneStart[3]}`;
  const sceneDone = trimmed.match(/^Generated\s+(\d+)\/(\d+)\s+scenes?$/i);
  if (sceneDone) return `已经完成 ${sceneDone[1]}/${sceneDone[2]} 个课堂页面。`;
  const sceneRepair = trimmed.match(/^Repairing scene\s+(\d+)\/(\d+)\s+layout\s+\((\d+)\/1\):\s*(.+)$/i);
  if (sceneRepair) return `正在调整第 ${sceneRepair[1]}/${sceneRepair[2]} 个课堂页面的版式（本次仅修复一次）：${sceneRepair[4]}`;
  const outlineDone = trimmed.match(/^Generated\s+(\d+)\s+scene outlines?$/i);
  if (outlineDone) return `已经规划好 ${outlineDone[1]} 个课堂页面。`;

  const exactTranslations: Record<string, string> = {
    "Initializing classroom generation": "正在确认课程设置和生成选项。",
    "Researching topic": "正在围绕课程主题梳理教学资料。",
    "Generating scene outlines": "正在把课程大纲拆分为课堂页面。",
    "Persisting classroom content": "正在检查并保存全部课程内容。",
    "Classroom content ready; media continues in background": "课程主体已经就绪，媒体素材会继续完成处理。",
  };
  if (exactTranslations[trimmed]) return exactTranslations[trimmed];

  if (containsChinese(trimmed) && !hasLongEnglishPhrase(trimmed)) return trimmed;
  return null;
}

function containsChinese(value: string): boolean {
  return /[\u3400-\u9fff]/.test(value);
}

function hasLongEnglishPhrase(value: string): boolean {
  return /[a-z]{4,}(?:\s+[a-z]{3,}){2,}/i.test(value);
}

function completionSummary(result: GenerationResultSummary): string {
  const breakdown = [
    result.studentSceneCount !== undefined ? `${result.studentSceneCount} 个学生页面` : null,
    result.teacherSceneCount !== undefined ? `${result.teacherSceneCount} 份教师资源` : null,
  ].filter(Boolean);
  return `已完成 ${result.scenesCount} 个课堂场景${breakdown.length ? `，其中包括${breakdown.join("和")}` : ""}。`;
}

function formatEstimatedRemainingTime(remainingSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(remainingSeconds / 60));
  if (minutes <= 2) return "预计还需约 1–2 分钟";
  if (minutes < 10) {
    const lower = Math.max(2, Math.floor(minutes / 2) * 2);
    return `预计还需约 ${lower}–${lower + 2} 分钟`;
  }
  const lower = Math.max(10, Math.floor(minutes / 5) * 5);
  return `预计还需约 ${lower}–${lower + 5} 分钟`;
}
