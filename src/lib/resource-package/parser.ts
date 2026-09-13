import { z } from "zod";
import { readBoundedZip, ResourcePackageError, type ArchiveEntry } from "./archive";
import { emptyResourcePackageDraft, RESOURCE_PACKAGE_STAGE_KEYS, type ResourcePackageDraft, type ResourcePackageRole, type ResourcePackageSource } from "./types";

export { ResourcePackageError } from "./archive";
export const RESOURCE_PACKAGE_ROLES: ResourcePackageRole[] = ["knowledge", "lessonPlan", "launchPresentation"];
export const resourcePackageSelectionsSchema = z.object({ knowledge: z.string().max(1024).optional(), lessonPlan: z.string().max(1024).optional(), launchPresentation: z.string().max(1024).optional() }).strict();
export type ResourcePackageSelections = z.infer<typeof resourcePackageSelectionsSchema>;
const sourceSchema = z.object({ documentRole: z.enum(["knowledge", "lessonPlan", "launchPresentation"]), locator: z.string().max(500), quote: z.string().max(16000), archivePath: z.string().max(1024).optional() });
const stageSchema = z.object({ key: z.enum(RESOURCE_PACKAGE_STAGE_KEYS), title: z.string().max(200), durationMin: z.number().int().positive().max(10000).nullable(), requirements: z.string().max(16000), outputs: z.string().max(8000), teacherActions: z.string().max(16000), aiActions: z.string().max(16000), checkpoints: z.array(z.string().max(4000)).max(100).optional(), observationPoints: z.array(z.string().max(4000)).max(100).optional() });
export const resourcePackageDraftSchema = z.object({
  courseName: z.string().max(300), subject: z.string().max(200), grade: z.string().max(300), drivingQuestion: z.string().max(4000),
  learningObjectives: z.array(z.string().max(4000)).max(100), expectedOutcome: z.string().max(8000), learnerContext: z.string().max(8000),
  lessonCount: z.number().int().positive().max(1000).nullable(), minutesPerLesson: z.number().int().positive().max(10000).nullable(), totalMinutes: z.number().int().positive().max(50000).nullable(),
  knowledgePoints: z.array(z.object({ id: z.string().max(200).optional(), name: z.string().max(400), description: z.string().max(8000), subPoints: z.array(z.string().max(8000)).max(100), source: sourceSchema.optional(), children: z.array(z.object({ id: z.string().max(200), name: z.string().max(400), description: z.string().max(8000), source: sourceSchema.optional() })).max(100).optional() })).max(200),
  stages: z.array(stageSchema).length(5), evaluationCriteria: z.string().max(16000), reflectionQuestions: z.array(z.string().max(4000)).max(100),
  parsingVersion: z.literal(2).optional(), originalEvaluationSources: z.string().max(8000).optional(), sourceEvidence: z.record(z.string(), z.array(sourceSchema)).optional(),
  finalDeliverables: z.array(z.object({ id: z.string().max(200), name: z.string().max(400), format: z.string().max(100), requirements: z.string().max(8000), required: z.boolean() })).max(50).optional(),
  evaluationRubric: z.object({ id: z.string().max(200), version: z.number().int().positive(), dimensions: z.array(z.object({ id: z.string().max(200), name: z.string().max(400), weight: z.number().min(0).max(100), description: z.string().max(8000) })).max(50), sourceWeights: z.object({ teacher: z.number().min(0).max(100), ai: z.number().min(0).max(100) }), confirmedAt: z.string().optional() }).optional(),
  reflectionQuestionSet: z.object({ id: z.string().max(200), version: z.number().int().positive(), questions: z.array(z.object({ id: z.string().max(200), prompt: z.string().max(4000), required: z.boolean() })).max(100) }).optional(),
}).strict();

export function identifyResourcePackage(entries: ArchiveEntry[], selections: ResourcePackageSelections = {}) {
  const usable = entries.filter((entry) => !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").pop()?.startsWith("~$"));
  const candidates: Partial<Record<ResourcePackageRole, string[]>> = {};
  const selected: Partial<Record<ResourcePackageRole, ArchiveEntry>> = {};
  const rules: Record<ResourcePackageRole, { extension: RegExp; preferred: RegExp }> = {
    knowledge: { extension: /\.docx$/i, preferred: /知识点|知识文档|知识清单|knowledge/i },
    lessonPlan: { extension: /\.docx$/i, preferred: /完整教案|教案|教学设计|lesson.?plan/i },
    launchPresentation: { extension: /\.pptx$/i, preferred: /项目启动|项目导入|启动|launch|kick.?off/i },
  };
  for (const role of RESOURCE_PACKAGE_ROLES) {
    const pool = usable.filter((entry) => rules[role].extension.test(entry.name));
    const matches = pool.filter((entry) => rules[role].preferred.test(entry.name.split("/").pop()!));
    const list = pool;
    candidates[role] = [...matches, ...pool.filter((entry) => !matches.includes(entry))].map((entry) => entry.name);
    if (!list.length) throw new ResourcePackageError(`资源包缺少${{ knowledge: "知识点 DOCX", lessonPlan: "完整教案 DOCX", launchPresentation: "项目启动 PPTX" }[role]}文件。`, "RESOURCE_PACKAGE_MISSING_FILE", 422);
    if (selections[role]) {
      const match = list.find((entry) => entry.name === selections[role]);
      if (!match) throw new ResourcePackageError("选择的资源文件不在当前候选列表中。");
      selected[role] = match;
    } else if (matches.length === 1) selected[role] = matches[0];
    else if (list.length === 1) selected[role] = list[0];
  }
  if (selected.knowledge?.name === selected.lessonPlan?.name) throw new ResourcePackageError("知识点文档和完整教案应为两个不同的 DOCX 文件。", "RESOURCE_PACKAGE_MISSING_FILE", 422);
  return { candidates, selected, needsSelection: RESOURCE_PACKAGE_ROLES.some((role) => !selected[role]) };
}

function xmlText(xml: string): string {
  return xml.replace(/<w:tab\b[^>]*\/?\s*>/g, "\t").replace(/<w:br\b[^>]*\/?\s*>/g, "\n").replace(/<[^>]*>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim();
}
export function readDocx(bytes: Buffer): { text: string; blocks: string[][] } {
  const entries = readBoundedZip(bytes);
  const document = entries.find((entry) => entry.name === "word/document.xml");
  if (!document || document.size > 4 * 1024 * 1024) throw new ResourcePackageError("Word 文档内容缺失或过大。", "INVALID_DOCX", 422);
  const xml = document.read().toString("utf8");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new ResourcePackageError("Word 文档含有不支持的 XML 声明。");
  const blocks = Array.from(xml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>|<w:p\b[\s\S]*?<\/w:p>/g), (match) => {
    if (match[0].startsWith("<w:tr")) return Array.from(match[0].matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g), (cell) => Array.from(cell[0].matchAll(/<w:p\b[\s\S]*?<\/w:p>/g), (p) => xmlText(p[0])).filter(Boolean).join("\n"));
    return [xmlText(match[0])];
  }).filter((block) => block.some(Boolean));
  return { text: blocks.map((block) => block.join("\t")).join("\n"), blocks };
}

function between(lines: string[], from: string, stops: string[]): string[] {
  const normalized = (line: string) => line.replace(/^[一二三四五六七八九十\d]+[、.．）)\s]+/, "").replace(/[：:]$/, "").trim();
  const start = lines.findIndex((line) => normalized(line) === from);
  if (start < 0) return [];
  let end = lines.findIndex((line, index) => index > start && stops.includes(normalized(line)));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end);
}
function metadata(blocks: string[][], labels: string[]): string {
  const lines = blocks.flat();
  for (const label of labels) {
    for (const row of blocks) {
      for (let index = 0; index < row.length - 1; index++) if (label === row[index].replace(/[：:]$/, "")) return row[index + 1];
    }
    const inline = lines.find((line) => line.startsWith(`${label}：`) || line.startsWith(`${label}:`));
    if (inline) return inline.slice(label.length + 1).trim();
  }
  return "";
}

/** Rules retain the document's explicit facts and missing/conflicting durations for teacher review. */
export function parseResourcePackageDraft(knowledge: ReturnType<typeof readDocx>, lesson: ReturnType<typeof readDocx>): ResourcePackageDraft {
  const draft = emptyResourcePackageDraft();
  draft.parsingVersion = 2;
  draft.sourceEvidence = {};
  const blocks = [...lesson.blocks, ...knowledge.blocks];
  const lines = lesson.blocks.flat();
  draft.courseName = metadata(blocks, ["课程名称", "项目名称"]) || lesson.blocks[0]?.[0] || "";
  draft.subject = metadata(blocks, ["课程", "学科"]);
  draft.grade = metadata(blocks, ["专业与年级", "教学对象", "年级", "学段"]);
  draft.drivingQuestion = metadata(blocks, ["驱动问题", "项目学习驱动问题", "学习驱动问题"]);
  const time = metadata(blocks, ["授课时间", "课时安排", "项目周期"]);
  const lessons = time.match(/(\d+)\s*(?:课时|课次|LESSON)/i);
  const perLesson = time.match(/每(?:课时|课次|节课)\s*(\d+)\s*分钟/);
  draft.lessonCount = lessons ? Number(lessons[1]) : null;
  draft.minutesPerLesson = perLesson ? Number(perLesson[1]) : null;
  const total = metadata(blocks, ["总时长", "总分钟数", "课程总时长"]).match(/(\d+)/);
  draft.totalMinutes = total ? Number(total[1]) : draft.lessonCount && draft.minutesPerLesson ? draft.lessonCount * draft.minutesPerLesson : null;
  draft.learningObjectives = between(lines, "教学目标", ["教学内容与职责", "教学内容", "教学重难点", "课前准备"]);
  if (!draft.learningObjectives.length) draft.learningObjectives = between(lines, "学习目标", ["教学内容与职责", "教学内容", "教学重难点", "课前准备"]);
  draft.learnerContext = between(lines, "学情分析", ["教学目标", "学习目标"]).join("\n");
  draft.evaluationCriteria = between(lines, "评价安排", ["学生反思题", "反思问题"]).join("\n");
  draft.reflectionQuestions = between(lines, "学生反思题", ["来源说明"]).map((line) => line.replace(/^\d+[.、]\s*/, ""));
  const heading = /^(?:\d+\s*[.、．]?\s+|\d+[.、．]\s*|[一二三四五六七八九十]+[、.．]\s*)(.+)$/;
  let current: ResourcePackageDraft["knowledgePoints"][number] | undefined;
  for (const row of knowledge.blocks) {
    if (row[0] === "来源说明") break;
    const match = row.length === 1 && row[0].match(heading);
    if (match) { current = { id: stablePackageId("group", match[1].trim()), name: match[1].trim(), description: "", subPoints: [], children: [], source: source("knowledge", knowledge.blocks.indexOf(row), row.join("\t")) }; draft.knowledgePoints.push(current); }
    else if (current && row.length > 1 && !["子知识点", "知识点"].includes(row[0])) {
      current.subPoints.push(`${row[0]}${row[1] ? `：${row[1]}` : ""}`);
      current.children!.push({ id: stablePackageId("knowledge", `${current.id}:${row[0]}`), name: row[0], description: row[1] || "", source: source("knowledge", knowledge.blocks.indexOf(row), row.join("\t")) });
    }
    else if (current && !current.description) current.description = row[0];
  }
  const process = ["五阶段教学过程", "教学过程", "五阶段教学安排"].map((heading) => between(lines, heading, ["小组项目推进", "项目推进", "全组成果展示安排", "评价安排"])).find((items) => items.length) ?? [];
  let stage: ResourcePackageDraft["stages"][number] | undefined;
  for (const line of process) {
    const match = line.match(/^([1-5])(?:\s*[.、．]\s*|\s+)(.+)$/);
    if (match) { stage = draft.stages[Number(match[1]) - 1]; stage.title = match[2]; continue; }
    if (!stage) continue;
    if (/^(时间与课次|时间|时长)[：:]/.test(line)) { const minutes = line.match(/(\d+)\s*分钟/); stage.durationMin = minutes ? Number(minutes[1]) : null; }
    else if (/^(教师行动|教师活动|教师指导)[：:]/.test(line)) stage.teacherActions = line.replace(/^[^：:]+[：:]\s*/, "");
    else if (/^(学生行动|学生活动|学习活动|任务与活动)[：:]/.test(line)) stage.requirements = line.replace(/^[^：:]+[：:]\s*/, "");
    else if (/^(AI职责|AI支持|AI伙伴支持)[：:]/i.test(line)) stage.aiActions = line.replace(/^[^：:]+[：:]\s*/, "");
    else if (/^(阶段产出|阶段成果|交付要求)[：:]/.test(line)) stage.outputs = line.replace(/^[^：:]+[：:]\s*/, "");
    else if (/^(观察与介入|观察要点|教师介入)[：:]/.test(line)) stage.observationPoints = line.replace(/^[^：:]+[：:]\s*/, "").split(/[；;]/).filter(Boolean);
    draft.sourceEvidence[`stages.${stage.key}`] = [...(draft.sourceEvidence[`stages.${stage.key}`] ?? []), source("lessonPlan", lines.indexOf(line), line)];
  }
  if (!draft.totalMinutes && draft.stages.every((stage) => stage.durationMin !== null)) draft.totalMinutes = draft.stages.reduce((total, stage) => total + stage.durationMin!, 0);
  draft.expectedOutcome = metadata(blocks, ["项目成果", "成果要求", "交付物"]) || draft.stages.find((stage) => stage.key === "make")?.outputs || "";
  const checkpoints = lines.filter((line) => /^第[一二三四五六七八九十\d]+课时[末中前后][：:]/.test(line));
  draft.stages.find((stage) => stage.key === "make")!.checkpoints = checkpoints;
  const evaluationRows = lesson.blocks.filter((row) => row.length >= 3 && /^\d+(?:\.\d+)?%$/.test(row[row.length - 1]));
  if (evaluationRows.length) draft.evaluationRubric = { id: stablePackageId("rubric", draft.courseName), version: 1, dimensions: evaluationRows.map((row) => ({ id: stablePackageId("dimension", row[0]), name: row[0], description: row[1], weight: Number.parseFloat(row[row.length - 1]) })), sourceWeights: { teacher: 60, ai: 40 } };
  if (!draft.evaluationRubric) {
    const dimensions = draft.evaluationCriteria.split(/[，,；;\n。]/).flatMap((text) => {
      const match = text.trim().match(/^(.+?)\s*[（(]?\s*(\d+(?:\.\d+)?)\s*[%％][）)]?$/);
      if (!match || /教师|同伴|自评|互评|AI/i.test(match[1])) return [];
      const name = match[1].replace(/[：:]$/, '').trim();
      return [{ id: stablePackageId('dimension', name), name, description: name, weight: Number(match[2]) }];
    });
    if (dimensions.length) draft.evaluationRubric = { id: stablePackageId('rubric', draft.courseName), version: 1, dimensions, sourceWeights: { teacher: 60, ai: 40 } };
  }
  draft.originalEvaluationSources = lines.find((line) => /(?:互评|自评|教师.*评分).*(?:%|％)/.test(line)) ?? "";
  if (draft.evaluationRubric && !/互评|自评/.test(draft.originalEvaluationSources)) {
    const teacher = draft.originalEvaluationSources.match(/教师[^%％\d]{0,16}(\d+(?:\.\d+)?)\s*[%％]/);
    const ai = draft.originalEvaluationSources.match(/AI[^%％\d]{0,16}(\d+(?:\.\d+)?)\s*[%％]/i);
    if (teacher && ai) draft.evaluationRubric.sourceWeights = { teacher: Number(teacher[1]), ai: Number(ai[1]) };
  }
  draft.reflectionQuestionSet = { id: stablePackageId("reflection", draft.courseName), version: 1, questions: draft.reflectionQuestions.map((prompt, index) => ({ id: stablePackageId("question", `${index}:${prompt}`), prompt, required: true })) };
  const deliverableText = [draft.expectedOutcome, ...checkpoints].join("\n");
  draft.finalDeliverables = [];
  if (/PPT|演示文稿/i.test(deliverableText)) draft.finalDeliverables.push({ id: "final-presentation", name: "个人项目演示文稿", format: "pptx", requirements: checkpoints.find((line) => /PPT终稿/.test(line)) ?? draft.expectedOutcome, required: true });
  if (/教案/.test(deliverableText)) draft.finalDeliverables.push({ id: "final-lesson-plan", name: "详细教案", format: "docx", requirements: "提交与项目演示文稿一致的详细教案文本。", required: true });
  if (!draft.finalDeliverables.length && draft.expectedOutcome) draft.finalDeliverables.push({ id: "final-artifact", name: "个人项目作品", format: "document", requirements: draft.expectedOutcome, required: true });
  const finalCheckpoint = checkpoints.find((line) => /终稿/.test(line));
  if (finalCheckpoint) draft.expectedOutcome = `${draft.expectedOutcome.replace(/初稿/g, '终稿')}\n${finalCheckpoint}`;
  for (const field of ["courseName", "grade", "drivingQuestion", "expectedOutcome", "originalEvaluationSources"] as const) {
    const value = draft[field];
    if (value) draft.sourceEvidence[field] = [source("lessonPlan", Math.max(0, lines.findIndex((line) => line.includes(value))), value)];
  }
  return normalizePackageStructure(draft);
}

export function stablePackageId(prefix: string, value: string): string {
  let hash = 2166136261;
  for (const character of value.normalize("NFC")) { hash ^= character.codePointAt(0)!; hash = Math.imul(hash, 16777619); }
  return `${prefix}-${(hash >>> 0).toString(36)}`;
}
function source(documentRole: ResourcePackageRole, index: number, quote: string): ResourcePackageSource { return { documentRole, locator: `第${index + 1}段/表格行`, quote }; }
/** Preserve editable IDs, separating teaching concepts from their explanations. */
export function normalizePackageStructure(draft: ResourcePackageDraft): ResourcePackageDraft {
  return { ...draft, knowledgePoints: draft.knowledgePoints.map((group) => ({ ...group, id: group.id ?? stablePackageId("group", group.name), children: group.children?.length ? group.children : group.subPoints.map((text) => {
    const separator = text.indexOf("："); const name = separator >= 0 ? text.slice(0, separator) : text;
    return { id: stablePackageId("knowledge", `${group.id ?? group.name}:${name}`), name, description: separator >= 0 ? text.slice(separator + 1) : "" };
  }) })) };
}
