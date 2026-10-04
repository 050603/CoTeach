import type { KnowledgePoint } from '@/lib/session/types';

/** Archived blueprint page semantics inside the existing joint section call. */
export const PPT_PAGE_PLANNING_VERSION = 'joint-native-pages-4615-v1';
export const PPT_PAGE_PLANNING_CONTRACT = {
  planningVersion: PPT_PAGE_PLANNING_VERSION,
  referenceCommit: '4615a98d',
  authority: 'pages.description/keyPoints/visualRelationship',
  groupingRule: '知识点、讲授单元和 PPT 页面不是一一对应关系。先按定义—关系—机制—应用等真实知识联系，把可以共享解释主线、视觉关系或案例的多个知识点共同组织，也可以让一个页面组合多个紧密相关单元；只有认知任务或视觉焦点发生实质变化时才拆页。不得为了凑覆盖率机械制作“一个知识点一页”，也不得用一个概括名称吞掉各知识点应有的具体解释责任。',
  focusRule: '每页应有一个学生能说清的主要认知任务；同一页中可以有多个紧密相关的解释点，但应能共享一条解释主线、一个视觉关系或一个明确观察目标。紧密相关且能共用一个视觉焦点的定义与关系可同页；需要独立分析的例子、反例、操作或练习应拆页。独立分析任务才构成另页理由，辅助例子或素材种类变化不自动要求翻页。',
  displayRule: 'keyPoints 是本页实际展示的核心信息，不是讲稿摘要投影、栏目名称或写作任务。写清必要概念、条件、关系、判断依据和完整流程标签；案例故事、推理与口头过渡由连续讲稿承担。description 写本页实际展开的认识及前后进展，teachingObjective 写本页新增理解或技能；这三个字段各有职责，不互相复制全文。',
  visualRule: '按学生需要看清的关系选择文字、表格、图表、原生图示、观察图片或组合，不规定全课模板和比例。比较按共同维度组织；流程保持全部真实节点、分支、循环和独立流程各自顺序，不把并列内容强串成流程。素材是为了帮助理解，不能为装饰填空，也不能为减少页数取消必要观察图。',
  timingRule: 'teachingBudgetSec 是本节共享讲授预算。suggestedPageRange 是旧版按预算与内容工作量给出的规划参考，不是强制配额；每页应有足够时间完成实质解释。不得按术语或自然段数量机械分页，也不得凑指定页数、加速、漏讲或重复讲解凑时长。',
  ownershipRule: '严格沿用已确认的小节边界、知识归属和教学顺序。先独立组织本节页面，再在同一响应中直接依据原文写连续讲稿，将完整段落通过 segmentIds 归属到这些页面；一个页面可以承载多个连续段落。页面不是讲稿的事实来源，两者独立受实际采用原文约束。',
} as const;

export const PPT_PAGE_PLANNING_GUIDANCE = [
  PPT_PAGE_PLANNING_CONTRACT.groupingRule, PPT_PAGE_PLANNING_CONTRACT.focusRule,
  PPT_PAGE_PLANNING_CONTRACT.displayRule, PPT_PAGE_PLANNING_CONTRACT.visualRule,
  PPT_PAGE_PLANNING_CONTRACT.timingRule, PPT_PAGE_PLANNING_CONTRACT.ownershipRule,
].join('\n');

/** Extracted from 4615a98d's section planner without its course regrouping. */
export function archivedPageRange(teachingBudgetSec: number, points: readonly KnowledgePoint[]) {
  const budget = Math.max(1, teachingBudgetSec);
  const min = Math.max(1, Math.ceil(budget / 180));
  const contentPageNeed = Math.ceil(points.reduce((sum, point) => sum + 1.5
    + (point.level === 'core' ? 0.75 : point.level === 'application' ? 0.5 : 0.25)
    + (point.masteryBoundary?.trim() ? 0.5 : 0), 0));
  const max = Math.max(min, Math.min(Math.max(min, contentPageNeed), Math.max(min, Math.floor(budget / 45))));
  return { suggestedPageRange: [min, max], maxPages: Math.max(min, Math.floor(budget / 30)) };
}
