"use client";

import { useState } from "react";
import { Copy, Plus, Trash2 } from "lucide-react";
import { clientUUID } from "@/lib/uuid";
import { groupExperimentQuestions, type ExperimentConfig, type ExperimentQuestion, type ExperimentQuestionGroup } from "@/lib/platform/experiment";
export type { ExperimentConfig, ExperimentQuestion } from "@/lib/platform/experiment";

type Bank = "sharedQuestions" | "pretest" | "posttest";

const bankNames: Record<Bank, string> = { sharedQuestions: "共用", pretest: "前测", posttest: "后测" };
const questionTypes: Array<{ value: ExperimentQuestion["type"]; label: string }> = [
  { value: "single-choice", label: "单选题" },
  { value: "multiple-choice", label: "多选题" },
  { value: "true-false", label: "判断题" },
  { value: "short-answer", label: "简答题" },
  { value: "scale", label: "量表题" },
];
const categories: Array<{ value: NonNullable<ExperimentQuestion["category"]>; label: string }> = [
  { value: "knowledge", label: "知识理解" },
  { value: "micro-design", label: "微设计能力" },
  { value: "confidence", label: "学习信心" },
  { value: "collaboration", label: "协作体验" },
  { value: "other", label: "其他" },
];
const field = "min-h-10 w-full rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 py-2 text-sm";
const smallButton = "inline-flex min-h-9 items-center justify-center gap-1.5 rounded-[6px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] px-3 text-xs font-medium text-[var(--pbl-text-strong)] disabled:opacity-50";

function createQuestion(type: ExperimentQuestion["type"] = "single-choice"): ExperimentQuestion {
  if (type === "short-answer") return { id: clientUUID(), type, prompt: "", category: "micro-design" };
  if (type === "scale") return { id: clientUUID(), type, prompt: "", scale: { min: 1, max: 5 } };
  if (type === "true-false") return { id: clientUUID(), type, prompt: "" };
  return { id: clientUUID(), type, prompt: "", category: "knowledge", options: ["", ""] };
}

export function validateExperiment(config: ExperimentConfig): string | null {
  if (!config.enabled) return null;
  const shared = config.sharedQuestions ?? [];
  if (!shared.length && !config.scenarioPair && !config.pretest.length) return "请至少添加一道前测题目";
  if (!shared.length && !config.scenarioPair && !config.posttest.length) return "请至少添加一道后测题目";
  for (const bank of ["sharedQuestions", "pretest", "posttest"] as const) {
    const name = bankNames[bank];
    const questions = config[bank] ?? [];
    if (questions.length > 30) return `${name}最多设置 30 道题目`;
  }
  const labelledQuestions = [
    ...shared.map((question, index) => ({ question, label: `共用第 ${index + 1} 题` })),
    ...config.pretest.map((question, index) => ({ question, label: `前测第 ${index + 1} 题` })),
    ...config.posttest.map((question, index) => ({ question, label: `后测第 ${index + 1} 题` })),
    ...(config.scenarioPair ? [
      { question: config.scenarioPair.a, label: "情境 A" },
      { question: config.scenarioPair.b, label: "情境 B" },
    ] : []),
  ];
  if (new Set(labelledQuestions.map(({ question }) => question.id)).size !== labelledQuestions.length) return "题目编号不能重复";
  const groups = new Map<string, ExperimentQuestionGroup>();
  for (const { question, label } of labelledQuestions) {
      if (question.group) {
        if (!question.group.title.trim()) return `请填写${label}所属题组的标题`;
        const previous = groups.get(question.group.id);
        if (previous && (previous.title !== question.group.title || (previous.instruction ?? "") !== (question.group.instruction ?? ""))) return "同一题组的标题和作答说明必须一致";
        groups.set(question.group.id, question.group);
      }
      if (!question.prompt.trim()) return `请填写${label}的题干`;
      if (question.type === "single-choice" || question.type === "multiple-choice") {
        const options = question.options?.map((option) => option.trim()) ?? [];
        if (options.length < 2 || options.some((option) => !option)) return `请为${label}填写至少两个选项`;
        if (options.length > 8) return `${label}最多设置 8 个选项`;
        if (new Set(options).size !== options.length) return `${label}的选项不能重复`;
        if (question.type === "single-choice" && question.correctAnswer &&
          (typeof question.correctAnswer !== "string" || !options.includes(question.correctAnswer.trim()))) {
          return `请检查${label}的参考答案`;
        }
        if (question.type === "multiple-choice" && question.correctAnswer &&
          (!Array.isArray(question.correctAnswer) ||
            question.correctAnswer.some((answer) => !options.includes(answer.trim())))) {
          return `请检查${label}的参考答案`;
        }
      }
      if (question.type === "true-false" && question.correctAnswer && question.correctAnswer !== "true" && question.correctAnswer !== "false") {
        return `请检查${label}的参考答案`;
      }
      if (question.type === "scale" && (!question.scale || !Number.isInteger(question.scale.min) || !Number.isInteger(question.scale.max) || question.scale.min < 0 || question.scale.min > 9 || question.scale.max < 1 || question.scale.max > 10 || question.scale.min >= question.scale.max)) {
        return `请为${label}设置有效的量表范围（0–10）`;
      }
  }
  if (config.scenarioPair && (config.scenarioPair.a.type !== "short-answer" || config.scenarioPair.b.type !== "short-answer")) return "A/B 情境题必须为简答题";
  return null;
}

export function prepareExperiment(config: ExperimentConfig): ExperimentConfig {
  const prepareQuestion = (question: ExperimentQuestion): ExperimentQuestion => {
    const prepared: ExperimentQuestion = { id: question.id, type: question.type, prompt: question.prompt.trim(), ...(question.category ? { category: question.category } : {}), ...(question.group ? { group: { id: question.group.id, title: question.group.title.trim(), ...(question.group.instruction?.trim() ? { instruction: question.group.instruction.trim() } : {}) } } : {}) };
    if (question.type === "single-choice" || question.type === "multiple-choice") {
      prepared.options = question.options?.map((option) => option.trim()) ?? [];
      const answer = Array.isArray(question.correctAnswer)
        ? question.correctAnswer.map((answer) => answer.trim())
        : question.correctAnswer?.trim();
      if (Array.isArray(answer) ? answer.length > 0 : Boolean(answer)) prepared.correctAnswer = answer;
    } else if (question.type === "true-false") {
      if (question.correctAnswer) prepared.correctAnswer = question.correctAnswer;
    } else if (question.type === "scale") {
      prepared.scale = question.scale ? {
        min: question.scale.min,
        max: question.scale.max,
        ...(question.scale.minLabel?.trim() ? { minLabel: question.scale.minLabel.trim() } : {}),
        ...(question.scale.maxLabel?.trim() ? { maxLabel: question.scale.maxLabel.trim() } : {}),
      } : undefined;
    } else if (typeof question.correctAnswer === "string" && question.correctAnswer.trim()) {
      prepared.correctAnswer = question.correctAnswer.trim();
    }
    return prepared;
  };
  return {
    enabled: config.enabled,
    pretest: config.pretest.map(prepareQuestion),
    posttest: config.posttest.map(prepareQuestion),
    sharedQuestions: (config.sharedQuestions ?? []).map(prepareQuestion),
    ...(config.scenarioPair ? { scenarioPair: { a: prepareQuestion(config.scenarioPair.a), b: prepareQuestion(config.scenarioPair.b) } } : {}),
    randomizeQuestionOrder: config.randomizeQuestionOrder ?? true,
    randomizeOptionOrder: config.randomizeOptionOrder ?? true,
  };
}

export function ExperimentQuestionBuilder({ value, onChange }: {
  value: ExperimentConfig;
  onChange: (next: ExperimentConfig) => void;
}) {
  const [section, setSection] = useState<Bank | "scenario" | "randomization">("sharedQuestions");
  function updateQuestions(bank: Bank, next: ExperimentQuestion[]) {
    onChange({ ...value, [bank]: next });
  }

  function updateQuestion(bank: Bank, index: number, next: ExperimentQuestion) {
    updateQuestions(bank, value[bank].map((question, position) => position === index ? next : question));
  }

  function updateGroup(bank: Bank, groupId: string, patch: Partial<ExperimentQuestionGroup>) {
    updateQuestions(bank, value[bank].map((question) => question.group?.id === groupId
      ? { ...question, group: { ...question.group, ...patch } }
      : question));
  }

  function addGroupQuestion(bank: Bank, group: ExperimentQuestionGroup) {
    const questions = value[bank];
    const last = questions.findLastIndex((question) => question.group?.id === group.id);
    const next = createQuestion("scale");
    updateQuestions(bank, [...questions.slice(0, last + 1), { ...next, group: { ...group } }, ...questions.slice(last + 1)]);
  }

  function renderBank(bank: Bank) {
    const name = bankNames[bank];
    const questions = value[bank] ?? [];
    const sections = groupExperimentQuestions(questions);
    const groups = sections.flatMap((section) => section.group ? [section.group] : []);
    const orderedQuestions = sections.flatMap((section) => section.questions);
    const description = bank === "sharedQuestions"
      ? "同一题会出现在前测和后测，便于比较同一知识点。"
      : bank === "pretest" ? "仅在课前出现，检查学生进入课堂前的状态。" : "仅在课后出现，检查课堂后的变化。";
    return (
      <section key={bank} aria-label={`${name}题目`} className="space-y-3 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h4 className="text-sm font-semibold text-[var(--pbl-text-strong)]">{bank === "sharedQuestions" ? "共用题（前后测共用）" : `${name}专属题`}</h4>
            <p className="mt-1 text-xs text-[var(--pbl-text-muted)]">{description}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={smallButton} disabled={questions.length > 28} onClick={() => {
              const group = { id: clientUUID(), title: "", instruction: "" };
              updateQuestions(bank, [...questions, { ...createQuestion("scale"), group }, { ...createQuestion("scale"), group: { ...group } }]);
            }}><Plus size={14} />添加量表题组</button>
            <button type="button" className={smallButton} disabled={questions.length >= 30} onClick={() => updateQuestions(bank, [...questions, createQuestion()])}>
              <Plus size={14} />添加{name}题目
            </button>
          </div>
        </div>
        <p className="text-xs leading-5 text-[var(--pbl-text-muted)]">题组可设置统一标题和作答说明。新增题组会生成两道量表题，也可将已有题目加入题组。</p>
        {questions.length === 0 ? <p className="rounded-[6px] border border-dashed border-[var(--pbl-border)] p-4 text-center text-xs text-[var(--pbl-text-muted)]">还没有{name}题目</p> : null}
        {sections.map((section, sectionIndex) => <div key={section.group ? `group-${section.group.id}` : `question-${section.questions[0].id}`} className={section.group ? "space-y-3 rounded-[10px] border border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] p-3" : ""}>
          {section.group ? <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-semibold text-[var(--pbl-teacher)]">题组 · {section.questions.length} 题</p><button type="button" className={smallButton} onClick={() => updateQuestions(bank, questions.map((question) => question.group?.id === section.group?.id ? { ...question, group: undefined } : question))}>取消题组</button></div>
            <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]"><span>题组大标题 <small>必填</small></span><input aria-label={`${name}题组 ${sectionIndex + 1} 标题`} className={field} maxLength={120} value={section.group.title} onChange={(event) => updateGroup(bank, section.group!.id, { title: event.target.value })} placeholder="例如：任务信心" /></label>
            <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]"><span>统一作答说明 <small>可选</small></span><textarea aria-label={`${name}题组 ${sectionIndex + 1} 作答说明`} className={`${field} min-h-20`} maxLength={1000} value={section.group.instruction ?? ""} onChange={(event) => updateGroup(bank, section.group!.id, { instruction: event.target.value })} placeholder="例如：请根据目前的真实感受，选择最符合自己的一项。" /></label>
            <button type="button" className={smallButton} disabled={questions.length >= 30} onClick={() => addGroupQuestion(bank, section.group!)}><Plus size={14} />在题组中添加量表题</button>
          </div> : null}
          {section.questions.map((question) => {
          const index = questions.findIndex((item) => item.id === question.id);
          const label = `${name}第 ${orderedQuestions.findIndex((item) => item.id === question.id) + 1} 题`;
          const options = question.options ?? [];
          return (
            <fieldset key={question.id} className="space-y-3 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3">
              <legend className="text-xs font-semibold text-[var(--pbl-text-strong)]">{label}</legend>
              <div className="flex justify-end gap-2">
                <button type="button" aria-label={`复制${label}`} className={smallButton} disabled={questions.length >= 30} onClick={() => updateQuestions(bank, [...questions.slice(0, index + 1), { ...question, id: clientUUID(), options: question.options ? [...question.options] : undefined, correctAnswer: Array.isArray(question.correctAnswer) ? [...question.correctAnswer] : question.correctAnswer, scale: question.scale ? { ...question.scale } : undefined }, ...questions.slice(index + 1)])}>
                  <Copy size={14} />复制
                </button>
                <button type="button" aria-label={`删除${label}`} className={`${smallButton} text-red-600`} onClick={() => updateQuestions(bank, questions.filter((_, position) => position !== index))}>
                  <Trash2 size={14} />删除
                </button>
              </div>
              <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
                <span>题型</span>
                <select aria-label={`${label}题型`} className={field} value={question.type} onChange={(event) => {
                  const type = event.target.value as ExperimentQuestion["type"];
                  updateQuestion(bank, index, {
                    id: question.id,
                    type,
                    prompt: question.prompt,
                    ...(question.category ? { category: question.category } : {}),
                    ...(question.group ? { group: question.group } : {}),
                    ...(type === "single-choice" || type === "multiple-choice" ? { options: ["", ""] } : type === "scale" ? { scale: { min: 1, max: 5 } } : {}),
                  });
                }}>
                  {questionTypes.map((type) => <option key={type.value} value={type.value}>{type.label}</option>)}
                </select>
              </label>
              <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
                <span>研究维度 <small>可选</small></span>
                <select aria-label={`${label}研究维度`} className={field} value={question.category ?? ""} onChange={(event) => updateQuestion(bank, index, { ...question, category: event.target.value ? event.target.value as ExperimentQuestion["category"] : undefined })}>
                  <option value="">未分类</option>
                  {categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
                </select>
              </label>
              <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
                <span>所属题组 <small>可选</small></span>
                <select aria-label={`${label}所属题组`} className={field} value={question.group?.id ?? ""} onChange={(event) => updateQuestion(bank, index, { ...question, group: event.target.value ? { ...groups.find((group) => group.id === event.target.value)! } : undefined })}>
                  <option value="">独立显示</option>
                  {groups.map((group) => <option key={group.id} value={group.id}>{group.title || "未命名题组"}</option>)}
                </select>
              </label>
              <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
                <span>题干 <small>必填</small></span>
                <textarea aria-label={`${label}题干`} className={`${field} min-h-20`} maxLength={2000} value={question.prompt} onChange={(event) => updateQuestion(bank, index, { ...question, prompt: event.target.value })} placeholder="输入学生看到的问题" />
              </label>
              {(question.type === "single-choice" || question.type === "multiple-choice") ? (
                <div className="space-y-2">
                  <p className="text-xs text-[var(--pbl-text-muted)]">选项 <small>参考答案可选；不设置时只记录学生选择，不计分</small></p>
                  {options.map((option, optionIndex) => {
                    const selected = question.type === "multiple-choice"
                      ? Array.isArray(question.correctAnswer) && question.correctAnswer.includes(option) && Boolean(option.trim())
                      : question.correctAnswer === option && Boolean(option.trim());
                    return (
                      <div key={optionIndex} className="flex items-center gap-2">
                        <input
                          type={question.type === "multiple-choice" ? "checkbox" : "radio"}
                          name={question.type === "single-choice" ? `${question.id}-answer` : undefined}
                          aria-label={`${label}选项 ${optionIndex + 1} 设为正确答案`}
                          checked={selected}
                          disabled={!option.trim()}
                          onChange={() => updateQuestion(bank, index, {
                            ...question,
                            correctAnswer: question.type === "multiple-choice"
                              ? selected ? (Array.isArray(question.correctAnswer) ? question.correctAnswer.filter((answer) => answer !== option) : [])
                                : [...(Array.isArray(question.correctAnswer) ? question.correctAnswer : []), option]
                              : option,
                          })}
                        />
                        <input aria-label={`${label}选项 ${optionIndex + 1}`} className={field} maxLength={300} value={option} onChange={(event) => {
                          const nextOption = event.target.value;
                          const nextOptions = options.map((item, position) => position === optionIndex ? nextOption : item);
                          const nextAnswer = Array.isArray(question.correctAnswer)
                            ? question.correctAnswer.map((answer) => answer === option ? nextOption : answer)
                            : question.correctAnswer === option && option ? nextOption : question.correctAnswer;
                          updateQuestion(bank, index, { ...question, options: nextOptions, correctAnswer: nextAnswer });
                        }} placeholder={`选项 ${optionIndex + 1}`} />
                        <button type="button" aria-label={`删除${label}选项 ${optionIndex + 1}`} disabled={options.length <= 2} className={`${smallButton} shrink-0 px-2`} onClick={() => updateQuestion(bank, index, {
                          ...question,
                          options: options.filter((_, position) => position !== optionIndex),
                          correctAnswer: Array.isArray(question.correctAnswer)
                            ? question.correctAnswer.filter((answer) => answer !== option)
                            : question.correctAnswer === option ? "" : question.correctAnswer,
                        })}><Trash2 size={14} /></button>
                      </div>
                    );
                  })}
                  <button type="button" className={smallButton} disabled={options.length >= 8} onClick={() => updateQuestion(bank, index, { ...question, options: [...options, ""] })}><Plus size={14} />添加选项</button>
                  {question.correctAnswer && (Array.isArray(question.correctAnswer) ? question.correctAnswer.length > 0 : true) ? <button type="button" className={smallButton} onClick={() => updateQuestion(bank, index, { ...question, correctAnswer: undefined })}>清除参考答案</button> : null}
                </div>
              ) : null}
              {question.type === "true-false" ? (
                <div className="space-y-2 text-xs text-[var(--pbl-text-muted)]">
                  <p>参考答案（可选；不设置时只记录作答）</p>
                  <div className="flex gap-5">
                    {[["true", "正确"], ["false", "错误"]].map(([answer, text]) => (
                      <label key={answer} className="flex items-center gap-1.5">
                        <input type="radio" name={`${question.id}-answer`} aria-label={`${label}正确答案：${text}`} checked={question.correctAnswer === answer} onChange={() => updateQuestion(bank, index, { ...question, correctAnswer: answer })} />{text}
                      </label>
                    ))}
                  </div>
                  {question.correctAnswer ? <button type="button" className={smallButton} onClick={() => updateQuestion(bank, index, { ...question, correctAnswer: undefined })}>清除参考答案</button> : null}
                </div>
              ) : null}
              {question.type === "short-answer" ? (
                <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
                  <span>参考答案 <small>可选，用于教师查看</small></span>
                  <textarea aria-label={`${label}参考答案`} className={`${field} min-h-16`} maxLength={2000} value={typeof question.correctAnswer === "string" ? question.correctAnswer : ""} onChange={(event) => updateQuestion(bank, index, { ...question, correctAnswer: event.target.value })} />
                </label>
              ) : null}
              {question.type === "scale" ? (
                <div className="space-y-3">
                  <p className="text-xs text-[var(--pbl-text-muted)]">量表范围 <small>整数，最大不超过 10</small></p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]"><span>最小值</span><input type="number" min={0} max={9} step={1} aria-label={`${label}最小值`} className={field} value={question.scale?.min ?? 1} onChange={(event) => updateQuestion(bank, index, { ...question, scale: { ...question.scale, min: Number(event.target.value), max: question.scale?.max ?? 5 } })} /></label>
                    <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]"><span>最大值</span><input type="number" min={1} max={10} step={1} aria-label={`${label}最大值`} className={field} value={question.scale?.max ?? 5} onChange={(event) => updateQuestion(bank, index, { ...question, scale: { ...question.scale, min: question.scale?.min ?? 1, max: Number(event.target.value) } })} /></label>
                    <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]"><span>最小值含义</span><input aria-label={`${label}最小值含义`} className={field} maxLength={100} value={question.scale?.minLabel ?? ""} onChange={(event) => updateQuestion(bank, index, { ...question, scale: { min: question.scale?.min ?? 1, max: question.scale?.max ?? 5, ...question.scale, minLabel: event.target.value } })} placeholder="例如：完全没有信心" /></label>
                    <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]"><span>最大值含义</span><input aria-label={`${label}最大值含义`} className={field} maxLength={100} value={question.scale?.maxLabel ?? ""} onChange={(event) => updateQuestion(bank, index, { ...question, scale: { min: question.scale?.min ?? 1, max: question.scale?.max ?? 5, ...question.scale, maxLabel: event.target.value } })} placeholder="例如：非常有信心" /></label>
                  </div>
                </div>
              ) : null}
            </fieldset>
          );
          })}
        </div>)}
      </section>
    );
  }

  function renderScenarioQuestion(side: "a" | "b") {
    const question = value.scenarioPair?.[side];
    if (!question) return null;
    const label = `情境 ${side.toUpperCase()}`;
    const update = (next: ExperimentQuestion) => onChange({ ...value, scenarioPair: { ...value.scenarioPair!, [side]: next } });
    return (
      <fieldset key={side} className="space-y-3 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-surface)] p-3">
        <legend className="text-xs font-semibold text-[var(--pbl-text-strong)]">{label} · 简答题</legend>
        <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
          <span>研究维度 <small>可选</small></span>
          <select aria-label={`${label}研究维度`} className={field} value={question.category ?? ""} onChange={(event) => update({ ...question, category: event.target.value ? event.target.value as ExperimentQuestion["category"] : undefined })}>
            <option value="">未分类</option>
            {categories.map((category) => <option key={category.value} value={category.value}>{category.label}</option>)}
          </select>
        </label>
        <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
          <span>情境题干 <small>必填</small></span>
          <textarea aria-label={`${label}题干`} className={`${field} min-h-20`} maxLength={2000} value={question.prompt} onChange={(event) => update({ ...question, prompt: event.target.value })} placeholder="描述情境并提出开放问题" />
        </label>
        <label className="block space-y-1 text-xs text-[var(--pbl-text-muted)]">
          <span>参考答案 <small>可选，用于教师查看</small></span>
          <textarea aria-label={`${label}参考答案`} className={`${field} min-h-16`} maxLength={2000} value={typeof question.correctAnswer === "string" ? question.correctAnswer : ""} onChange={(event) => update({ ...question, correctAnswer: event.target.value })} />
        </label>
      </fieldset>
    );
  }

  return (
    <section className="space-y-4">
      <div><h2 className="text-lg font-semibold">实验模式</h2><p className="mt-1 text-sm text-[var(--pbl-text-muted)]">按题组设置前后测。共用题会在两次测验中出现，专属题只出现一次。</p></div>
      <label className="flex cursor-pointer items-start gap-3 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4">
        <input type="checkbox" role="switch" aria-label="开启实验模式" className="mt-0.5 size-4" checked={value.enabled} onChange={(event) => onChange({ ...value, enabled: event.target.checked })} />
        <span className="space-y-1"><strong className="block text-sm text-[var(--pbl-text-strong)]">开启实验模式</strong><small className="block text-xs text-[var(--pbl-text-muted)]">学生进入课堂前完成前测，学完课堂后完成后测。</small></span>
      </label>
      {value.enabled ? <div className="mt-4 space-y-4">
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="实验题组">
          {([
            ["sharedQuestions", `共用题 ${value.sharedQuestions.length}`],
            ["pretest", `前测专属 ${value.pretest.length}`],
            ["posttest", `后测专属 ${value.posttest.length}`],
            ["scenario", `A/B 情境 ${value.scenarioPair ? 2 : 0}`],
            ["randomization", "随机设置"],
          ] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={section === key} onClick={() => setSection(key)} className={`${smallButton} ${section === key ? "border-[var(--pbl-teacher)] bg-[var(--pbl-teacher-soft)] text-[var(--pbl-teacher)]" : ""}`}>{label}</button>)}
        </div>
        {section === "sharedQuestions" || section === "pretest" || section === "posttest" ? renderBank(section) : null}
        {section === "scenario" ? <section aria-label="A/B 情境题" className="space-y-3 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4">
          <div><h4 className="text-sm font-semibold text-[var(--pbl-text-strong)]">A/B 情境题</h4><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">可选。为同一能力设计两道不同的简答题，学生前后测各看到一个情境，顺序对调。</p></div>
          <label className="flex items-center gap-2 text-xs text-[var(--pbl-text-strong)]"><input type="checkbox" role="switch" aria-label="启用 A/B 情境题" checked={Boolean(value.scenarioPair)} onChange={(event) => onChange({ ...value, scenarioPair: event.target.checked ? { a: createQuestion("short-answer"), b: createQuestion("short-answer") } : undefined })} />启用 A/B 情境题</label>
          {value.scenarioPair ? <div className="grid gap-3 sm:grid-cols-2">{renderScenarioQuestion("a")}{renderScenarioQuestion("b")}</div> : null}
        </section> : null}
        {section === "randomization" ? <section aria-label="题目随机化" className="space-y-3 rounded-[8px] border border-[var(--pbl-border)] bg-[var(--pbl-bg)] p-4">
          <div><h4 className="text-sm font-semibold text-[var(--pbl-text-strong)]">题目随机化</h4><p className="mt-1 text-xs text-[var(--pbl-text-muted)]">默认开启，减少题目位置对作答的影响。同组题目会保持在一起，组内题序也会随机。</p></div>
          <label className="flex items-center gap-2 text-xs text-[var(--pbl-text-strong)]"><input type="checkbox" role="switch" aria-label="随机排列题目" checked={value.randomizeQuestionOrder ?? true} onChange={(event) => onChange({ ...value, randomizeQuestionOrder: event.target.checked })} />随机排列题目</label>
          <label className="flex items-center gap-2 text-xs text-[var(--pbl-text-strong)]"><input type="checkbox" role="switch" aria-label="随机排列选项" checked={value.randomizeOptionOrder ?? true} onChange={(event) => onChange({ ...value, randomizeOptionOrder: event.target.checked })} />随机排列选项</label>
        </section> : null}
      </div> : null}
    </section>
  );
}
