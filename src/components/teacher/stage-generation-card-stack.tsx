"use client";

import {
  BookOpenCheck,
  BrainCircuit,
  Check,
  ClipboardCheck,
  FileText,
  GitBranch,
  Layers3,
  Route,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

export type StageGenerationKind =
  | "knowledgeGraph"
  | "teachingOutline"
  | "lessonOutline"
  | "evaluationPlan"
  | "sceneOutlines"
  | "adaptiveLearning"
  | "quickCourse"
  | "generic";

type CardDefinition = {
  id: string;
  eyebrow: string;
  title: string;
  detail: string;
  Icon: typeof Sparkles;
  accent: "blue" | "orange" | "violet" | "green";
  items: string[];
};

export type StageGenerationCardData = {
  id: string;
  eyebrow: string;
  title: string;
  detail: string;
  items: string[];
  accent?: CardDefinition["accent"];
};

const TASK_CARDS: Record<StageGenerationKind, CardDefinition[]> = {
  knowledgeGraph: [
    card("course", "课程语境", "理解主题与学习目标", "提取教师要求与认知边界", FileText, "orange", ["课程范围", "学生基础", "目标层级"]),
    card("concepts", "知识节点", "识别核心概念", "区分基础、核心、应用与拓展", BrainCircuit, "blue", ["核心概念", "关键事实", "应用条件"]),
    card("relations", "知识关联", "建立概念之间的关系", "连接前置、支撑和迁移关系", GitBranch, "violet", ["前置关系", "支撑关系", "迁移关系"]),
    card("review", "覆盖检查", "检查知识结构完整性", "确认目标均有知识节点支撑", ShieldCheck, "green", ["层级清楚", "关联有效", "目标覆盖"]),
  ],
  teachingOutline: [
    card("constraints", "课程约束", "读取课时与阶段要求", "锁定总时长和六阶段边界", FileText, "orange", ["总课时", "阶段边界", "学生画像"]),
    card("mainline", "项目主线", "组织真实问题与成果", "让活动围绕同一驱动问题推进", Layers3, "blue", ["真实情境", "驱动问题", "最终成果"]),
    card("modules", "阶段编排", "生成六阶段课程架构", "明确教师、AI 与学生的任务", GitBranch, "violet", ["项目启动", "知识建构", "成果评价"]),
    card("timing", "时间校验", "检查阶段时长守恒", "避免课堂内容超出可用课时", ShieldCheck, "green", ["总时长一致", "活动可实施", "节奏合理"]),
  ],
  lessonOutline: [
    card("alignment", "架构对齐", "读取课程模块与知识点", "确认每个课堂页面的教学位置", GitBranch, "orange", ["模块位置", "知识目标", "活动角色"]),
    card("pages", "页面规划", "拆分课堂内容页面", "将模块转化为可讲授的页面序列", BookOpenCheck, "blue", ["页面标题", "讲授重点", "目标时长"]),
    card("resources", "资源编排", "安排讲稿与互动资源", "为不同活动选择合适的资源形式", Layers3, "violet", ["教师讲稿", "互动组件", "学习任务"]),
    card("coverage", "脚本检查", "检查知识与阶段覆盖", "避免遗漏、重复和页面错位", ShieldCheck, "green", ["知识覆盖", "阶段完整", "页面可编辑"]),
  ],
  sceneOutlines: [
    card("read", "课程架构", "读取六阶段与教师要求", "准备主课脚本生成上下文", FileText, "orange", ["阶段结构", "教师风格", "互动开关"]),
    card("outline", "页面序列", "规划第一批课堂页面", "首个页面就绪后转入页面内流式生成", BookOpenCheck, "blue", ["页面顺序", "内容类型", "目标时长"]),
    card("script", "讲授脚本", "撰写讲授与互动内容", "逐页生成并自动保存", Layers3, "violet", ["讲授要点", "互动安排", "资源需求"]),
    card("review", "内容复核", "检查知识点和模块对应", "完成后生成可编辑主课脚本", ShieldCheck, "green", ["知识关联", "模块对应", "内容完整"]),
  ],
  evaluationPlan: [
    card("goals", "评价依据", "读取目标与项目成果", "识别需要被观察的学习表现", FileText, "orange", ["知识目标", "成果要求", "过程证据"]),
    card("dimensions", "评价维度", "建立清晰的成功标准", "让每个维度可观察、可解释", ClipboardCheck, "blue", ["维度名称", "权重比例", "表现描述"]),
    card("roles", "评价分工", "分配教师与 AI 的职责", "重要判断保留教师最终确认", Layers3, "violet", ["教师评价", "AI 建议", "学生自评"]),
    card("weights", "方案检查", "校验权重与证据对应", "确保评分结构完整且可执行", ShieldCheck, "green", ["权重合计", "证据充分", "责任清楚"]),
  ],
  adaptiveLearning: [
    card("main", "主课分析", "读取主课与知识图谱", "识别核心知识、互动与达标证据", FileText, "orange", ["主课页面", "知识节点", "主课达标测"]),
    card("gaps", "学习分叉", "识别可能的先修缺口", "只为影响新课理解的知识安排回顾", BrainCircuit, "blue", ["先修知识", "典型误解", "前测问题"]),
    card("paths", "路径编排", "安排新的例题与应用", "在合适位置插入不重复主课的资源", Route, "violet", ["插入位置", "触发条件", "新增价值"]),
    card("audit", "重叠检查", "检查分支与主课的差异", "避免重复定义、例题和结论", ShieldCheck, "green", ["避免重复", "路径完整", "教师可审核"]),
  ],
  quickCourse: [
    card("base", "课程定位", "整理课程基础信息", "分析教师输入和课程边界", FileText, "orange", ["课程主题", "学习对象", "课时范围"]),
    card("knowledge", "目标与知识", "建立目标和知识图谱", "形成后续课程设计的内容骨架", BrainCircuit, "blue", ["学习目标", "知识节点", "概念关系"]),
    card("design", "课程设计", "生成成果、评价与阶段架构", "保持任务、评价和课堂活动一致", GitBranch, "violet", ["项目成果", "评价标准", "六阶段架构"]),
    card("lesson", "课堂内容", "生成主课与个性化路径", "完成后执行全课程质量复核", BookOpenCheck, "green", ["主课脚本", "学习分支", "质量复核"]),
  ],
  generic: [
    card("context", "任务理解", "读取生成要求", "整理教师提供的课程上下文", FileText, "orange", ["输入内容", "生成约束", "课程数据"]),
    card("draft", "内容生成", "组织课程设计内容", "形成结构化且可编辑的结果", Sparkles, "blue", ["分析", "生成", "结构化"]),
    card("align", "一致性检查", "对齐已有课程数据", "避免覆盖教师已经确认的内容", Route, "violet", ["字段对应", "内容衔接", "数据保存"]),
    card("quality", "质量检查", "检查输出完整性", "确认结果可以进入下一阶段", Check, "green", ["结构完整", "语言准确", "结果可用"]),
  ],
};

function card(
  id: string,
  eyebrow: string,
  title: string,
  detail: string,
  Icon: CardDefinition["Icon"],
  accent: CardDefinition["accent"],
  items: string[],
): CardDefinition {
  return { id, eyebrow, title, detail, Icon, accent, items };
}

export function StageGenerationCardStack({
  kind,
  running = true,
  className,
  cards: liveCards,
  actionLabel,
  onAction,
}: {
  kind: StageGenerationKind;
  running?: boolean;
  className?: string;
  cards?: StageGenerationCardData[];
  actionLabel?: string;
  onAction?: () => void;
}) {
  const fallbackCards = TASK_CARDS[kind];
  const cards = useMemo<CardDefinition[]>(() => {
    if (!liveCards?.length) return fallbackCards;
    const unique = Array.from(
      new Map(liveCards.map((item) => [item.id, item])).values(),
    );
    return unique.slice(0, 4).map((item, index) => ({
      ...item,
      Icon: fallbackCards[index % fallbackCards.length].Icon,
      accent: item.accent ?? fallbackCards[index % fallbackCards.length].accent,
      items: item.items.filter(Boolean).slice(0, 3),
    }));
  }, [fallbackCards, liveCards]);
  const [stack, setStack] = useState(() => cards.map((item) => item.id));
  const reducedMotion = useReducedMotion();
  const cardIds = cards.map((item) => item.id).join("|");

  useEffect(() => {
    const nextIds = cardIds ? cardIds.split("|") : [];
    queueMicrotask(() => setStack(nextIds));
  }, [cardIds]);

  useEffect(() => {
    if (!running || reducedMotion) return;
    const timer = window.setInterval(() => {
      setStack((current) => {
        const next = [...current];
        const top = next.pop();
        return top ? [top, ...next] : current;
      });
    }, 5_600);
    return () => window.clearInterval(timer);
  }, [reducedMotion, running]);

  const cardById = useMemo(() => new Map(cards.map((item) => [item.id, item])), [cards]);

  return (
    <div className={cn("relative mx-auto h-[300px] w-full max-w-[430px]", className)}>
      <div className="stage-card-glow absolute left-1/2 top-1/2 h-40 w-64 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse,rgba(59,130,246,.20),rgba(249,115,22,.08)_52%,transparent_72%)] blur-2xl" />
      <div className="absolute left-1/2 top-1/2 h-[214px] w-[310px] -translate-x-1/2 -translate-y-1/2 [perspective:1000px]">
        {stack.map((id, index) => {
          const page = cardById.get(id);
          if (!page) return null;
          const depth = stack.length - index - 1;
          const active = index === stack.length - 1;
          return (
            <motion.article
              animate={{
                opacity: 1 - depth * 0.12,
                rotateZ: depth * -2.1,
                rotateX: depth * 1.2,
                scale: 1 - depth * 0.052,
                x: depth * 9,
                y: depth * -9,
                z: depth * -30,
              }}
              className="absolute inset-0 overflow-hidden rounded-[14px] border border-stone-200 bg-white shadow-[0_20px_48px_rgba(41,37,36,.18)] [backface-visibility:hidden] [transform-style:preserve-3d]"
              initial={false}
              key={id}
              transition={reducedMotion ? { duration: 0 } : { type: "spring", stiffness: 240, damping: 23, mass: 0.85 }}
            >
              <GenerationCard
                actionLabel={active ? actionLabel : undefined}
                active={active && running && !reducedMotion}
                card={page}
                onAction={active ? onAction : undefined}
              />
            </motion.article>
          );
        })}
      </div>
      <style>{`
        .stage-card-scan {
          position: absolute; inset: -45% 0 auto; z-index: 20; height: 42%; pointer-events: none;
          background: linear-gradient(to bottom, transparent, rgba(96,165,250,.10), rgba(29,78,216,.20), transparent);
          transform: skewY(-3deg); animation: stage-card-scan 3.6s cubic-bezier(.45,.05,.55,.95) infinite;
        }
        @keyframes stage-card-scan { 0% { top:-46%; opacity:0 } 16% { opacity:1 } 78% { opacity:.9 } 100% { top:112%; opacity:0 } }
        @media (prefers-reduced-motion: reduce) { .stage-card-scan { animation:none } }
      `}</style>
    </div>
  );
}

function GenerationCard({
  card,
  active,
  actionLabel,
  onAction,
}: {
  card: CardDefinition;
  active: boolean;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const { Icon } = card;
  return (
    <div className="relative h-full p-4">
      {active ? <span aria-hidden className="stage-card-scan" /> : null}
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className={cn(
            "text-[9px] font-black uppercase tracking-[0.18em]",
            card.accent === "orange" && "text-orange-700",
            card.accent === "blue" && "text-blue-700",
            card.accent === "violet" && "text-violet-700",
            card.accent === "green" && "text-emerald-700",
          )}>{card.eyebrow}</p>
          <h3 className="mt-1.5 text-[15px] font-bold text-stone-900">{card.title}</h3>
          <p className="mt-1 text-[10px] leading-4 text-stone-500">{card.detail}</p>
        </div>
        <span className={cn(
          "grid size-8 shrink-0 place-items-center rounded-[8px]",
          card.accent === "orange" && "bg-orange-50 text-orange-700",
          card.accent === "blue" && "bg-blue-50 text-blue-700",
          card.accent === "violet" && "bg-violet-50 text-violet-700",
          card.accent === "green" && "bg-emerald-50 text-emerald-700",
        )}><Icon size={16} /></span>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-2 border-t border-stone-100 pt-3">
        {card.items.map((item, index) => (
          <div className="rounded-[7px] bg-stone-50 px-2 py-2 text-center" key={item}>
            <span className="mx-auto grid size-4 place-items-center rounded-full bg-white text-[8px] font-black text-stone-500 shadow-sm">{index + 1}</span>
            <p className="mt-1.5 text-[9px] font-semibold text-stone-600">{item}</p>
          </div>
        ))}
      </div>
      {actionLabel && onAction ? (
        <button
          className="absolute bottom-2.5 left-4 z-30 inline-flex h-7 items-center rounded-full border border-blue-200 bg-blue-50 px-3 text-[9px] font-black tracking-[.08em] text-blue-700 shadow-sm transition hover:border-blue-400 hover:bg-white"
          onClick={onAction}
          type="button"
        >
          {actionLabel}
        </button>
      ) : null}
      <span className="absolute bottom-2.5 right-3 text-[8px] font-semibold tracking-[0.1em] text-stone-300">COTEACH · AI DESIGN</span>
    </div>
  );
}
