import { clientUUID } from "@/lib/uuid";
import { ExperimentConfigSchema, type ExperimentConfig, type ExperimentQuestion } from "./experiment";

/** Copy these seven columns from a spreadsheet, including the header if available. */
export const EXPERIMENT_BULK_HEADER = "题型\t题干\t选项或量表范围\t参考答案（可空）\t研究维度（可空）\t题组标题（可空）\t统一作答说明（可空）";
export const EXPERIMENT_BULK_EXAMPLE = [
  EXPERIMENT_BULK_HEADER,
  "单选题\t这节课最想解决什么问题？\t理解概念|完成作品|和同学交流\t\t学习信心",
  "多选题\t哪些方法适合验证想法？\t访谈|原型测试|猜测\tA|B\t知识理解",
  "量表题\t我有信心完成任务\t1-5|完全没有信心|非常有信心\t\t学习信心\t任务信心\t请根据当前的真实感受，选择最符合自己的一项。",
  "量表题\t我能完成设计任务\t1-5|完全没有信心|非常有信心\t\t学习信心\t任务信心",
].join("\n");

export type ExperimentBulkParseResult =
  | { ok: true; questions: ExperimentQuestion[]; errors: [] }
  | { ok: false; questions: []; errors: string[] };

type TsvRow = { line: number; cells: string[] };

function readTsvRows(input: string): { rows: TsvRow[]; error?: string } {
  const source = input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const rows: TsvRow[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;

  const addRow = () => {
    const complete = [...cells, cell].map((value) => value.trim());
    if (complete.some(Boolean)) rows.push({ line: rowLine, cells: complete });
    cells = [];
    cell = "";
  };

  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (char === '"') {
      if (quoted && source[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (quoted || cell === "") {
        quoted = !quoted;
      } else {
        cell += char;
      }
    } else if (char === "\t" && !quoted) {
      cells.push(cell);
      cell = "";
    } else if (char === "\n" && !quoted) {
      addRow();
      line++;
      rowLine = line;
    } else {
      cell += char;
      if (char === "\n") line++;
    }
  }
  if (quoted) return { rows: [], error: `第 ${rowLine} 行：引号未闭合` };
  addRow();
  return { rows };
}

function normalizeAlias(value: string) {
  return value.trim().toLowerCase().replace(/[\s_-]/g, "");
}

const typeAliases: Record<string, ExperimentQuestion["type"]> = {
  单选: "single-choice", 单选题: "single-choice", singlechoice: "single-choice", single: "single-choice",
  多选: "multiple-choice", 多选题: "multiple-choice", multiplechoice: "multiple-choice", multiple: "multiple-choice",
  判断: "true-false", 判断题: "true-false", truefalse: "true-false", boolean: "true-false",
  简答: "short-answer", 简答题: "short-answer", 情境: "short-answer", 情境题: "short-answer", shortanswer: "short-answer",
  量表: "scale", 量表题: "scale", 评分题: "scale", scale: "scale", likert: "scale",
};

const categoryAliases: Record<string, NonNullable<ExperimentQuestion["category"]>> = {
  知识: "knowledge", 知识题: "knowledge", 知识理解: "knowledge", knowledge: "knowledge",
  微设计: "micro-design", 微设计能力: "micro-design", 情境能力: "micro-design", microdesign: "micro-design",
  信心: "confidence", 任务信心: "confidence", 学习信心: "confidence", confidence: "confidence",
  协作: "collaboration", 协作体验: "collaboration", 协作能力: "collaboration", collaboration: "collaboration",
  其他: "other", other: "other",
};

function choiceAnswer(raw: string, options: string[]): string | null {
  const value = raw.trim();
  if (options.includes(value)) return value;
  if (/^[A-H]$/i.test(value)) return options[value.toUpperCase().charCodeAt(0) - 65] ?? null;
  if (/^[1-8]$/.test(value)) return options[Number(value) - 1] ?? null;
  return null;
}

function parseScale(raw: string): ExperimentQuestion["scale"] | null {
  if (!raw) return { min: 1, max: 5 };
  const [range, minLabel, maxLabel, ...extra] = raw.split("|").map((value) => value.trim());
  if (extra.length || minLabel?.length > 100 || maxLabel?.length > 100) return null;
  const match = /^(\d{1,2})\s*[-–~～至]\s*(\d{1,2})$/.exec(range);
  if (!match) return null;
  const min = Number(match[1]);
  const max = Number(match[2]);
  if (min < 0 || min > 9 || max < 1 || max > 10 || min >= max) return null;
  return { min, max, ...(minLabel ? { minLabel } : {}), ...(maxLabel ? { maxLabel } : {}) };
}

function parseQuestion(row: TsvRow, createId: () => string): { question?: ExperimentQuestion; errors: string[] } {
  const errors: string[] = [];
  if (row.cells.length > 7) errors.push("列数超过 7 列，请检查题干中的制表符");
  const [rawType = "", prompt = "", rawOptions = "", rawAnswer = "", rawCategory = ""] = row.cells;
  const type = typeAliases[normalizeAlias(rawType)];
  if (!type) errors.push(`不支持题型“${rawType || "空"}”`);
  if (!prompt) errors.push("题干不能为空");
  if (prompt.length > 2000) errors.push("题干不能超过 2000 字");
  const category = rawCategory ? categoryAliases[normalizeAlias(rawCategory)] : undefined;
  if (rawCategory && !category) errors.push(`不支持研究维度“${rawCategory}”`);
  if (!type || errors.length) return { errors };

  const question: ExperimentQuestion = { id: createId(), type, prompt, ...(category ? { category } : {}) };
  if (type === "single-choice" || type === "multiple-choice") {
    const options = rawOptions.split("|").map((option) => option.trim());
    if (options.length < 2 || options.length > 8 || options.some((option) => !option || option.length > 300)) {
      errors.push("选择题需填写 2–8 个非空选项，每项最多 300 字，并用 | 分隔");
    } else if (new Set(options).size !== options.length) {
      errors.push("选项不能重复");
    } else {
      question.options = options;
      if (rawAnswer) {
        const rawAnswers = type === "multiple-choice" ? rawAnswer.split(/[|,，、]/).map((value) => value.trim()) : [rawAnswer];
        const answers = rawAnswers.map((value) => choiceAnswer(value, options));
        if (answers.some((answer) => !answer) || new Set(answers).size !== answers.length) {
          errors.push("参考答案应填写选项原文或 A–H／1–8 编号，且不能重复");
        } else {
          question.correctAnswer = type === "multiple-choice" ? answers as string[] : answers[0] as string;
        }
      }
    }
  } else if (type === "true-false") {
    if (rawOptions && !["正确|错误", "对|错", "true|false"].includes(rawOptions.toLowerCase().replace(/\s/g, ""))) errors.push("判断题的选项列请留空");
    if (rawAnswer) {
      const normalized = normalizeAlias(rawAnswer);
      if (["正确", "对", "true", "1", "是"].includes(normalized)) question.correctAnswer = "true";
      else if (["错误", "错", "false", "0", "否"].includes(normalized)) question.correctAnswer = "false";
      else errors.push("判断题参考答案请填写正确／错误，或留空作为意见题");
    }
  } else if (type === "short-answer") {
    if (rawOptions) errors.push("简答题的选项列请留空");
    if (rawAnswer.length > 2000) errors.push("参考答案不能超过 2000 字");
    else if (rawAnswer) question.correctAnswer = rawAnswer;
  } else {
    const scale = parseScale(rawOptions);
    if (!scale) errors.push("量表范围应为 0–10 以内的“1-5”或“1-5|低端含义|高端含义”");
    else question.scale = scale;
    if (rawAnswer) errors.push("量表题没有标准答案，请留空参考答案列");
  }
  return { ...(errors.length ? {} : { question }), errors };
}

/** Import up to 30 questions into one assessment bank. No partial import occurs on errors. */
export function parseExperimentQuestionRows(input: string, createId: () => string = clientUUID): ExperimentBulkParseResult {
  const parsed = readTsvRows(input);
  if (parsed.error) return { ok: false, questions: [], errors: [parsed.error] };
  const rows = parsed.rows.filter((row, index) => index !== 0 || !["题型", "type"].includes(normalizeAlias(row.cells[0] ?? "")) || !["题干", "prompt"].includes(normalizeAlias(row.cells[1] ?? "")));
  if (!rows.length) return { ok: false, questions: [], errors: ["第 1 行：请粘贴至少一道题目"] };
  if (rows.length > 30) return { ok: false, questions: [], errors: [`第 ${rows[30].line} 行：每次最多导入 30 道题`] };
  const questions: ExperimentQuestion[] = [];
  const errors: string[] = [];
  const groupRows: Array<{ row: TsvRow; question: ExperimentQuestion; title: string; instruction: string }> = [];
  for (const row of rows) {
    const result = parseQuestion(row, createId);
    if (result.question) {
      questions.push(result.question);
      const title = row.cells[5]?.trim() ?? "";
      const instruction = row.cells[6]?.trim() ?? "";
      if (title || instruction) groupRows.push({ row, question: result.question, title, instruction });
    }
    errors.push(...result.errors.map((message) => `第 ${row.line} 行：${message}`));
  }
  const groups = new Map<string, { id: string; title: string; instruction: string }>();
  for (const item of groupRows) {
    if (!item.title) { errors.push(`第 ${item.row.line} 行：填写统一作答说明时也需填写题组标题`); continue; }
    if (item.title.length > 120) { errors.push(`第 ${item.row.line} 行：题组标题不能超过 120 字`); continue; }
    if (item.instruction.length > 1000) { errors.push(`第 ${item.row.line} 行：统一作答说明不能超过 1000 字`); continue; }
    const existing = groups.get(item.title);
    if (existing && existing.instruction && item.instruction && existing.instruction !== item.instruction) {
      errors.push(`第 ${item.row.line} 行：同一题组的作答说明必须一致`);
      continue;
    }
    if (existing) {
      if (item.instruction && !existing.instruction) existing.instruction = item.instruction;
    } else groups.set(item.title, { id: createId(), title: item.title, instruction: item.instruction });
  }
  for (const item of groupRows) {
    const group = groups.get(item.title);
    if (group) item.question.group = { id: group.id, title: group.title, ...(group.instruction ? { instruction: group.instruction } : {}) };
  }
  if (errors.length) return { ok: false, questions: [], errors };
  if (new Set(questions.map((question) => question.id)).size !== questions.length) {
    return { ok: false, questions: [], errors: ["导入失败：题目编号重复，请重试"] };
  }
  return { ok: true, questions, errors: [] };
}

const backupFormat = "coteach-experiment";
const backupVersion = 1;

export type ExperimentConfigImportResult =
  | { ok: true; config: ExperimentConfig; errors: [] }
  | { ok: false; config?: never; errors: string[] };

/** Includes answer keys, so this backup is intended for teacher use. */
export function exportExperimentConfigJson(config: ExperimentConfig): string {
  return JSON.stringify({ format: backupFormat, version: backupVersion, config: ExperimentConfigSchema.parse(config) }, null, 2);
}

/** Restore a teacher backup for another lesson with fresh question identifiers. */
export function importExperimentConfigJson(input: string, createId: () => string = clientUUID): ExperimentConfigImportResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input);
  } catch {
    return { ok: false, errors: ["配置文件不是有效的 JSON"] };
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) return { ok: false, errors: ["配置文件格式不正确"] };
  const backup = decoded as Record<string, unknown>;
  if (backup.format !== backupFormat || backup.version !== backupVersion) return { ok: false, errors: ["不支持的实验配置文件版本"] };
  const parsed = ExperimentConfigSchema.safeParse(backup.config);
  if (!parsed.success) return { ok: false, errors: ["实验配置内容无效，请检查题目和答案"] };
  const groupIds = new Map<string, string>();
  const remap = (question: ExperimentQuestion): ExperimentQuestion => {
    const id = createId();
    const group = question.group;
    if (group && !groupIds.has(group.id)) groupIds.set(group.id, createId());
    return { ...question, id, ...(group ? { group: { ...group, id: groupIds.get(group.id)! } } : {}) };
  };
  const config: ExperimentConfig = {
    ...parsed.data,
    sharedQuestions: parsed.data.sharedQuestions.map(remap),
    pretest: parsed.data.pretest.map(remap),
    posttest: parsed.data.posttest.map(remap),
    ...(parsed.data.scenarioPair ? { scenarioPair: { a: remap(parsed.data.scenarioPair.a), b: remap(parsed.data.scenarioPair.b) } } : {}),
  };
  const checked = ExperimentConfigSchema.safeParse(config);
  if (!checked.success) return { ok: false, errors: ["导入后的题目编号有重复，请重试"] };
  return { ok: true, config: checked.data, errors: [] };
}
