/** Page organization restored from the archived native authoring boundary.
 * This contract describes complete learning tasks, never a page-count quota,
 * text-box schema, course topic or replacement for the current teaching order. */
export const PPT_PAGE_PLANNING_CONTRACT = {
  planningVersion: 'native-page-planning-4615-v3',
  groupingRule: '每个页面承担一个学生能说清的主要认知任务，并有清晰的视觉焦点；同一认知任务可以承载多个连续口播段落和多个紧密相关教学单元。先完整组织本次认识，再决定页面边界：概念含义及必要解释、成立条件、相关案例观察和对应比较能共同帮助理解时放在同页。解释节点、自然段、术语、原则、要素或步骤不是各占一页的指令；不把同一认识拆成只有一个短句、孤立标签、纯过渡或重复总结的微页面。',
  focusRule: '视觉焦点指学生正在理解的对象、机制或关系，不是素材的类型。图示切换到照片、概念切换到辅助案例，或者“是什么—举例—说明用途—补充特征”的角色标签，本身都不证明主要认知任务发生变化。同一核心认识下的定义、必要条件、相关案例与补充特征优先完整共页；图示与辅助图片可以共同服务一个焦点。不因素材看起来不同、出现多个素材或未测量的“争抢空间/视觉焦点”猜测就预先拆页。只有真正独立的操作/分析任务、所理解的对象/关系实质改变，或实际可读容量计量确实过载时另页。',
  caseRule: '辅助案例优先嵌入相关知识页；案例的故事、观察图片、判定依据和解释共同服务一个认识时整体组织，完整故事、原因与条件由实际 owned example 节点支持讲稿。完整真实流程连同必要就近说明保持整体观察，保留全部节点、分支、循环和独立流程各自的真实顺序。主要认知任务或观察焦点发生实质变化、有独立操作或分析任务时在自然理解转折处另页；同一小节本身不能作为把所有知识强压一页的理由。',
  capacityRule: '图片、图示和实际展示的核心要点共同占用空间；完整讲稿与解释节点不产生逐项上屏义务。先按本页认识组织文字、表格、图片与图示，再以实际渲染字体计量可读容量；实际无法可读地容纳时才有界调整分页。保存的 --capacity 子页、旧分页名称或过去版面的过载诊断，均不证明恢复后的组合也过载；未取得本次实际容量测量时，不得自称“实际无法容纳”或用猜测的容量拒绝完整认识组合，应先尝试准确核心要点与完整局部流程共同展示。展示项和来源引用不规定文本框数量、坐标、等宽栏目或固定构图，不为适配版面删除应教内容、必要图片或真实关系。',
  displayRule: 'PPT 展示文字准确提炼本页认识的核心含义、必要条件、判断差别和观察依据；来源与讲稿保持完整，不等于所有解释细节都要上屏。不要把完整解释节点、整段教材或连续讲稿直接复制成 presentationItems 后再以过长为由拆页。完整流程保留所有真实节点与关系，用准确简明的标签和必要就近说明；详细原因、故事与逐步解释继续由已有讲稿承载。标题在 title 中表达，展示项不必再重复标题，也不强制每个角色各占一个元素；不按字数、条目数或页数配额删事实。',
  timingRule: '时长只作参考，口播较长不自动产生新页；口播长度、节点数量、字符数、固定分钟数及页数预算不决定页面边界，不以等待、加速、删减必要解释或重复讲解凑时长。',
  ownershipRule: '分页只重新归属完整连续讲授段落，不改写、遗漏、重复或打乱正文；保持当前确认的小节与知识顺序、教材证据、知识覆盖、案例、必要媒体、讲稿和题目。一个页面可以组合多个紧密相关 unit，也可以承载多个节点；一个 unit 可以跨需要不同认识的多个页面，页面职责不按最小节点机械切分。',
} as const;

export const PPT_PAGE_PLANNING_GUIDANCE = [
  PPT_PAGE_PLANNING_CONTRACT.groupingRule,
  PPT_PAGE_PLANNING_CONTRACT.focusRule,
  PPT_PAGE_PLANNING_CONTRACT.caseRule,
  PPT_PAGE_PLANNING_CONTRACT.capacityRule,
  PPT_PAGE_PLANNING_CONTRACT.displayRule,
  PPT_PAGE_PLANNING_CONTRACT.timingRule,
  PPT_PAGE_PLANNING_CONTRACT.ownershipRule,
].join('\n');
