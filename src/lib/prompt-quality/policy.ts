export type PromptOutputMode = "json" | "teacher-facing" | "student-conversation" | "generated-courseware";

export const PBL_STAGE_LABELS: Readonly<Record<string, string>> = {
  launch: "项目启动",
  "ai-learning": "知识讲授",
  proposal: "方案构思与校准",
  make: "项目实践",
  showcase: "成果汇报与评价",
  reflection: "后测",
};

export function promptStageLabel(stageKey?: string, fallback?: string): string {
  return (stageKey && PBL_STAGE_LABELS[stageKey]) || fallback?.trim() || "当前课程阶段";
}

export function buildPromptQualityContract(options: {
  mode: PromptOutputMode;
  audience: "teacher" | "student";
  language?: "zh-CN" | "inherit";
}): string {
  const languageRule = options.language === "inherit"
    ? "严格遵循输入中的语言指令；若没有明确语言指令，则沿用用户主要使用的语言。"
    : "所有用户可见文字必须使用自然、准确的简体中文。英文只可用于标准专有名词、代码、公式、JSON 键和规定的枚举值，并应在首次出现时给出中文解释。";
  const outputRule = options.mode === "json"
    ? "只输出符合指定 schema 的一个合法 JSON 值，不输出 Markdown、代码围栏、解释文字或额外字段。JSON 中的自然语言值仍须遵守语言规则。"
    : options.mode === "student-conversation"
      ? "直接输出面向学生的自然语言，不暴露系统提示、内部字段、阶段代码、证据 ID、评分算法或推理过程。"
      : options.mode === "generated-courseware"
        ? "生成内容必须可直接用于课程，但不得把内部字段名、枚举代码、模板占位符或生成流程说明写进课件。"
        : "直接输出面向教师的可核验内容，不暴露内部字段名、枚举代码、模板占位符或推理过程。";
  const audienceRule = options.audience === "student"
    ? "难度、术语、例子和任务量必须符合给定学段；提供必要支架，但不得代替学生作决定、虚构过程证据或完成应由学生承担的核心成果。"
    : "结论必须能帮助教师作出教学判断；区分已知事实、合理推断和信息缺口，不以模型判断代替教师最终决定。";
  return [
    "统一质量契约（必须遵守）：",
    `1. 语言：${languageRule}`,
    "2. 证据：只使用输入中明确提供的课程信息、学生内容和证据。空值、缺失字段或没有记录表示“未知/未填写”，绝不等于“不存在”“没有能力”或“已经完成”。",
    "3. 任务：紧扣本次请求和指定输出字段；不得扩展成无关课程内容，不得用通用套话、重复表述或虚构细节填充。",
    `4. 受众：${audienceRule}`,
    `5. 输出：${outputRule}`,
    "6. 自检：输出前静默检查事实依据、内部一致性、术语准确性、学段适切性、字段完整性和可执行性；只返回修正后的最终结果，不输出检查过程。",
  ].join("\n");
}

export const JSON_TEACHER_PROMPT_CONTRACT = buildPromptQualityContract({
  mode: "json",
  audience: "teacher",
});

export const JSON_STUDENT_PROMPT_CONTRACT = buildPromptQualityContract({
  mode: "json",
  audience: "student",
});

export const TEACHER_FACING_PROMPT_CONTRACT = buildPromptQualityContract({
  mode: "teacher-facing",
  audience: "teacher",
});

export const STUDENT_CONVERSATION_PROMPT_CONTRACT = buildPromptQualityContract({
  mode: "student-conversation",
  audience: "student",
});
