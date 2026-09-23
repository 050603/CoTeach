import { z } from "zod";
import { readBoundedZip, ResourcePackageError, type ArchiveEntry } from "./archive";
import { emptyResourcePackageDraft, inferResourcePackageShowcasePlan, RESOURCE_PACKAGE_STAGE_KEYS, type HandoffDocumentMetadata, type ResourcePackageDraft, type ResourcePackageHandoffMetadata, type ResourcePackagePlanningIssue, type ResourcePackageRole, type ResourcePackageSource } from "./types";

export { ResourcePackageError } from "./archive";
export const RESOURCE_PACKAGE_ROLES: ResourcePackageRole[] = ["knowledge", "lessonPlan", "launchPresentation"];
export const resourcePackageSelectionsSchema = z.object({ knowledge: z.string().max(1024).optional(), lessonPlan: z.string().max(1024).optional(), launchPresentation: z.string().max(1024).optional() }).strict();
export type ResourcePackageSelections = z.infer<typeof resourcePackageSelectionsSchema>;
const sourceSchema = z.object({ documentRole: z.enum(["knowledge", "lessonPlan", "launchPresentation"]), locator: z.string().max(500), quote: z.string().max(16000), archivePath: z.string().max(1024).optional() });
const stageSchema = z.object({ key: z.enum(RESOURCE_PACKAGE_STAGE_KEYS), title: z.string().max(200), durationMin: z.number().int().positive().max(10000).nullable(), requirements: z.string().max(16000), outputs: z.string().max(8000), teacherActions: z.string().max(16000), aiActions: z.string().max(16000), checkpoints: z.array(z.string().max(4000)).max(100).optional(), observationPoints: z.array(z.string().max(4000)).max(100).optional() });
export const resourcePackageDraftSchema = z.object({
  courseName: z.string().max(300), subject: z.string().max(200), grade: z.string().max(300), drivingQuestion: z.string().max(4000), projectTask: z.string().max(8000).optional(),
  learningObjectives: z.array(z.string().max(4000)).max(100), expectedOutcome: z.string().max(8000), learnerContext: z.string().max(8000),
  lessonCount: z.number().int().positive().max(1000).nullable(), minutesPerLesson: z.number().int().positive().max(10000).nullable(), totalMinutes: z.number().int().positive().max(50000).nullable(),
  knowledgePoints: z.array(z.object({ id: z.string().max(200).optional(), name: z.string().max(400), description: z.string().max(8000), subPoints: z.array(z.string().max(8000)).max(100), source: sourceSchema.optional(),
    evidenceStatus: z.enum(["SUPPORTED", "PARTIAL", "UNSUPPORTED"]).optional(), evidenceGap: z.string().max(8000).optional(), taskAssociation: z.string().max(8000).optional(), sources: z.array(z.string().max(1000)).max(100).optional(),
    children: z.array(z.object({ id: z.string().max(200), name: z.string().max(400), description: z.string().max(8000), taskAssociation: z.string().max(8000).optional(), sources: z.array(z.string().max(1000)).max(100).optional(), source: sourceSchema.optional() })).max(100).optional() })).max(200),
  stages: z.array(stageSchema).length(5), evaluationCriteria: z.string().max(16000), reflectionQuestions: z.array(z.string().max(4000)).max(100),
  parsingVersion: z.literal(2).optional(), originalEvaluationSources: z.string().max(8000).optional(), sourceEvidence: z.record(z.string(), z.array(sourceSchema)).optional(),
  finalDeliverables: z.array(z.object({ id: z.string().max(200), name: z.string().max(400), format: z.string().max(100), requirements: z.string().max(8000), required: z.boolean() })).max(50).optional(),
  evaluationRubric: z.object({ id: z.string().max(200), version: z.number().int().positive(), dimensions: z.array(z.object({ id: z.string().max(200), name: z.string().max(400), weight: z.number().min(0).max(100), description: z.string().max(8000) })).max(50), sourceWeights: z.object({ teacher: z.number().min(0).max(100), ai: z.number().min(0).max(100) }), confirmedAt: z.string().optional() }).optional(),
  reflectionQuestionSet: z.object({ id: z.string().max(200), version: z.number().int().positive(), questions: z.array(z.object({ id: z.string().max(200), prompt: z.string().max(4000), required: z.boolean() })).max(100) }).optional(),
  preClassPreparation: z.array(z.string().max(4000)).max(100).optional(), organizationRequirements: z.array(z.string().max(4000)).max(100).optional(), aiUsagePolicy: z.string().max(8000).optional(),
  teachingHighlights: z.array(z.string().max(8000)).max(100).optional(), teachingDifficulties: z.array(z.string().max(8000)).max(100).optional(), facilitatorReference: z.array(z.string().max(8000)).max(100).optional(),
  showcasePlan: z.object({ presenterCount: z.number().int().positive().max(500).optional(), presentationSec: z.number().int().min(0).max(3600).optional(), discussionSec: z.number().int().min(0).max(1800).optional(), transitionSec: z.number().int().min(0).max(600).optional() }).strict().optional(),
  knowledgeEvidenceSummary: z.object({ overallStatus: z.enum(["SUPPORTED", "PARTIAL", "UNSUPPORTED"]), gaps: z.array(z.string().max(8000)).max(100) }).optional(),
}).strict();

export function identifyResourcePackage(entries: ArchiveEntry[], selections: ResourcePackageSelections = {}) {
  const usable = entries.filter((entry) => !entry.name.startsWith("__MACOSX/") && !entry.name.split("/").pop()?.startsWith("~$"));
  const candidates: Partial<Record<ResourcePackageRole, string[]>> = {};
  const selected: Partial<Record<ResourcePackageRole, ArchiveEntry>> = {};
  const markdown = usable.filter((entry) => /\.md$/i.test(entry.name)).map((entry) => ({ entry, document: readMarkdown(entry.read(), entry.name) }));
  if (!markdown.length && usable.some((entry) => /\.docx$/i.test(entry.name))) {
    throw new ResourcePackageError("上游交接格式已更新：请上传包含知识点 Markdown、教案 Markdown 和项目启动 PPTX 的 ZIP；不再接受新的 DOCX 交接包。", "RESOURCE_PACKAGE_LEGACY_FORMAT", 422);
  }
  const pools: Record<ResourcePackageRole, ArchiveEntry[]> = {
    knowledge: markdown.filter(({ document }) => document.metadata.resourceType === "KNOWLEDGE").map(({ entry }) => entry),
    lessonPlan: markdown.filter(({ document }) => document.metadata.resourceType === "LESSON_PLAN").map(({ entry }) => entry),
    launchPresentation: usable.filter((entry) => /\.pptx$/i.test(entry.name)),
  };
  const preferred: Record<ResourcePackageRole, RegExp> = {
    knowledge: /知识点|知识文档|知识清单|knowledge/i,
    lessonPlan: /完整教案|教案|教学设计|lesson.?plan/i,
    launchPresentation: /项目启动|项目导入|启动|launch|kick.?off/i,
  };
  for (const role of RESOURCE_PACKAGE_ROLES) {
    const pool = pools[role];
    const matches = pool.filter((entry) => preferred[role].test(entry.name.split("/").pop()!));
    const list = pool;
    candidates[role] = [...matches, ...pool.filter((entry) => !matches.includes(entry))].map((entry) => entry.name);
    if (!list.length) throw new ResourcePackageError(`资源包缺少${{ knowledge: "resourceType 为 KNOWLEDGE 的知识点 Markdown", lessonPlan: "resourceType 为 LESSON_PLAN 的教案 Markdown", launchPresentation: "项目启动 PPTX" }[role]}文件。`, "RESOURCE_PACKAGE_MISSING_FILE", 422);
    if (selections[role]) {
      const match = list.find((entry) => entry.name === selections[role]);
      if (!match) throw new ResourcePackageError("选择的资源文件不在当前候选列表中。");
      selected[role] = match;
    } else if (matches.length === 1) selected[role] = matches[0];
    else if (list.length === 1) selected[role] = list[0];
  }
  if (selected.knowledge?.name === selected.lessonPlan?.name) throw new ResourcePackageError("知识点文档和教案应为两个不同的 Markdown 文件。", "RESOURCE_PACKAGE_MISSING_FILE", 422);
  return { candidates, selected, needsSelection: RESOURCE_PACKAGE_ROLES.some((role) => !selected[role]) };
}

const handoffMetadataSchema = z.object({
  handoffFormatVersion: z.literal(1), projectId: z.string().min(1).max(200), resourceType: z.enum(["KNOWLEDGE", "LESSON_PLAN"]),
  resourceVersion: z.number().int().positive(), packageId: z.string().min(1).max(200), presentationVersion: z.number().int().positive(),
}).strict();
export type MarkdownResourceDocument = { text: string; body: string; lines: string[]; blocks: string[][]; metadata: HandoffDocumentMetadata; archivePath?: string };

function parseFrontmatterScalar(value: string): string | number {
  const trimmed = value.trim();
  if (/^"[\s\S]*"$|^'[\s\S]*'$/.test(trimmed)) return trimmed.slice(1, -1);
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

export function readMarkdown(bytes: Buffer, archivePath?: string): MarkdownResourceDocument {
  if (bytes.length > 4 * 1024 * 1024) throw new ResourcePackageError("Markdown 文档内容过大。", "INVALID_MARKDOWN", 422);
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"); }
  catch { throw new ResourcePackageError("Markdown 文档必须使用 UTF-8 编码。", "INVALID_MARKDOWN", 422); }
  if (text.includes("\0")) throw new ResourcePackageError("Markdown 文档包含无效字符。", "INVALID_MARKDOWN", 422);
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatter) throw new ResourcePackageError("Markdown 文档缺少交接元数据 frontmatter。", "HANDOFF_METADATA_MISSING", 422);
  const raw: Record<string, string | number> = {};
  for (const line of frontmatter[1].split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*:\s*(.*?)\s*$/);
    if (!match) throw new ResourcePackageError(`Markdown 交接元数据格式无效：${line}`, "HANDOFF_METADATA_INVALID", 422);
    raw[match[1]] = parseFrontmatterScalar(match[2]);
  }
  const parsed = handoffMetadataSchema.safeParse(raw);
  if (!parsed.success) throw new ResourcePackageError("Markdown 交接元数据无效：仅支持 handoffFormatVersion 1，且项目、资源、交接包与演示版本字段必须完整。", "HANDOFF_METADATA_INVALID", 422);
  const body = text.slice(frontmatter[0].length);
  const lines = body.split("\n");
  return { text, body, lines, blocks: lines.filter((line) => line.trim()).map((line) => [line.trim()]), metadata: parsed.data, archivePath };
}

export function validateHandoffMetadata(knowledge: MarkdownResourceDocument, lessonPlan: MarkdownResourceDocument): ResourcePackageHandoffMetadata {
  if (knowledge.metadata.resourceType !== "KNOWLEDGE" || lessonPlan.metadata.resourceType !== "LESSON_PLAN") throw new ResourcePackageError("Markdown 的 resourceType 与资料用途不匹配。", "HANDOFF_METADATA_MISMATCH", 422);
  for (const field of ["handoffFormatVersion", "projectId", "packageId", "presentationVersion"] as const) {
    if (knowledge.metadata[field] !== lessonPlan.metadata[field]) throw new ResourcePackageError(`知识点与教案的 ${field} 不一致，请上游重新导出同一交接包。`, "HANDOFF_METADATA_MISMATCH", 422);
  }
  return { handoffFormatVersion: 1, projectId: knowledge.metadata.projectId, packageId: knowledge.metadata.packageId,
    presentationVersion: knowledge.metadata.presentationVersion, documents: { knowledge: knowledge.metadata, lessonPlan: lessonPlan.metadata } };
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
  draft.showcasePlan = inferResourcePackageShowcasePlan(draft.stages.find((item) => item.key === "showcase"));
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

function heading(line: string): { level: number; title: string } | null {
  const match = line.match(/^(#{1,6})\s+(.+?)\s*$/);
  return match ? { level: match[1].length, title: match[2].trim() } : null;
}
function sectionRange(lines: string[], title: string, level: number): { start: number; end: number } | null {
  const start = lines.findIndex((line) => { const value = heading(line); return value?.level === level && value.title === title; });
  if (start < 0) return null;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) { const value = heading(lines[index]); if (value && value.level <= level) { end = index; break; } }
  return { start, end };
}
function sectionBody(lines: string[], title: string, level: number): string[] {
  const range = sectionRange(lines, title, level);
  return range ? lines.slice(range.start + 1, range.end) : [];
}
function bulletText(line: string): string | null {
  const match = line.trim().match(/^[-*+]\s+(.+)$/);
  return match?.[1].trim() ?? null;
}
function listItems(lines: string[]): string[] { return lines.map(bulletText).filter((line): line is string => Boolean(line)); }
function sectionItems(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const value = line.trim();
    if (!value || heading(value)) return [];
    return [bulletText(value) ?? value.match(/^\d+[.、．)]\s*(.+)$/)?.[1]?.trim() ?? value];
  });
}
function fieldValue(lines: string[], labels: string[]): string {
  for (const line of lines) {
    const item = bulletText(line);
    if (!item) continue;
    for (const label of labels) {
      const match = item.match(new RegExp(`^${label}[：:]\\s*(.*)$`));
      if (match) return match[1].trim();
    }
  }
  return "";
}
function markdownSource(documentRole: ResourcePackageRole, document: MarkdownResourceDocument, lineIndex: number, quote?: string): ResourcePackageSource {
  return { documentRole, locator: `第${lineIndex + 1}行`, quote: quote ?? document.lines[lineIndex]?.trim() ?? "", ...(document.archivePath ? { archivePath: document.archivePath } : {}) };
}
function cleanSectionText(lines: string[]): string {
  return lines.filter((line) => line.trim() && !heading(line)).map((line) => bulletText(line) ?? line.trim()).join("\n");
}
function teachingRequirementSections(document: MarkdownResourceDocument, titles: string[]): { items: string[]; sources: ResourcePackageSource[] } {
  const acceptedTitles = new Set(titles);
  const items: string[] = [];
  const sources: ResourcePackageSource[] = [];
  for (let start = 0; start < document.lines.length; start++) {
    const sectionHeading = heading(document.lines[start]);
    if (!sectionHeading || !acceptedTitles.has(sectionHeading.title.replace(/[：:]$/, "").trim())) continue;
    let end = document.lines.length;
    for (let index = start + 1; index < document.lines.length; index++) {
      const nextHeading = heading(document.lines[index]);
      if (nextHeading && nextHeading.level <= sectionHeading.level) { end = index; break; }
    }
    for (let index = start + 1; index < end; index++) {
      const line = document.lines[index].trim();
      if (!line || heading(line)) continue;
      const item = bulletText(line) ?? line.match(/^\d+[.、]\s*(.+)$/)?.[1]?.trim() ?? line;
      if (!item || items.includes(item)) continue;
      items.push(item);
      sources.push(markdownSource("lessonPlan", document, index, line));
    }
  }
  return { items, sources };
}
const STAGE_ID_TO_KEY = { INTRODUCTION: "launch", AI_LEARNING: "ai-learning", PROJECT_WORK: "make", SHOWCASE: "showcase", REFLECTION: "reflection" } as const;

function parsePlanningIssues(lesson: MarkdownResourceDocument, draft: ResourcePackageDraft): ResourcePackagePlanningIssue[] {
  const issues: ResourcePackagePlanningIssue[] = [];
  const organization = draft.organizationRequirements?.join("\n") ?? "";
  const make = draft.stages.find((stage) => stage.key === "make");
  const makeRange = sectionRange(lesson.lines, lesson.lines.map(heading).find((item) => item?.level === 3 && /小组项目实践/.test(item.title))?.title ?? "", 3);
  if (make && /个人(?:独立)?完成|每人独立完成|独立思考为主/.test(organization) && /小组/.test(make.title)) {
    const index = lesson.lines.findIndex((line) => /^###\s+.*小组/.test(line));
    issues.push({ id: "organization-title-personal-work", kind: "organization", severity: "warning", requiresAcknowledgement: true,
      summary: "阶段标题写有“小组”，但课程明确要求个人完成", detail: "系统将按个人任务理解组织方式；阶段标题仍保留上游原文，需教师核对。",
      suggestion: "确认按个人独立完成继续，或修改阶段标题和活动安排。", evidence: [markdownSource("lessonPlan", lesson, Math.max(0, index)), ...lesson.lines.flatMap((line, lineIndex) => /个人(?:独立)?完成|每人独立完成|独立思考为主/.test(line) ? [markdownSource("lessonPlan", lesson, lineIndex)] : []).slice(0, 2)] });
  }
  if (make && makeRange && draft.minutesPerLesson) {
    const text = lesson.lines.slice(makeRange.start, makeRange.end).join("\n");
    const schedule = text.match(/第(\d+)课时剩余时间及第(\d+)课时前\s*(\d+)\s*分钟/);
    if (schedule) {
      const first = Number(schedule[1]), last = Number(schedule[2]), lastMinutes = Number(schedule[3]);
      const previousMinutes = draft.stages.slice(0, draft.stages.findIndex((stage) => stage.key === "make")).reduce((sum, stage) => sum + (stage.durationMin ?? 0), 0);
      const startsAtLessonBoundary = previousMinutes === (first - 1) * draft.minutesPerLesson;
      const describedMinutes = (last - first) * draft.minutesPerLesson + lastMinutes;
      if (startsAtLessonBoundary && make.durationMin !== describedMinutes) {
        const index = lesson.lines.findIndex((line) => line.includes(schedule[0]));
        const durationIndex = lesson.lines.findIndex((line, lineIndex) => lineIndex >= makeRange.start && lineIndex < makeRange.end && /时间与课次/.test(line));
        issues.push({ id: "make-duration-description-mismatch", kind: "duration", severity: "warning", requiresAcknowledgement: true,
          summary: "项目实践的阶段分钟数与正文课次描述不一致", detail: `阶段时间表为 ${make.durationMin} 分钟；按“${schedule[0]}”和每课时 ${draft.minutesPerLesson} 分钟计算为 ${describedMinutes} 分钟。系统不会自动改写。`,
          suggestion: "修正阶段分钟数或确认以五阶段时间表为准。", evidence: [markdownSource("lessonPlan", lesson, Math.max(0, durationIndex)), markdownSource("lessonPlan", lesson, Math.max(0, index))] });
      }
    }
  }
  for (const point of draft.knowledgePoints.filter((item) => item.evidenceStatus === "PARTIAL" || item.evidenceStatus === "UNSUPPORTED")) {
    issues.push({ id: `knowledge-evidence-${point.id ?? stablePackageId("group", point.name)}`, kind: "evidence", severity: "info", requiresAcknowledgement: false,
      summary: `${point.name}的证据状态为${point.evidenceStatus}`, detail: point.evidenceGap || "上游资料将该知识主题标记为尚未完全核对。",
      suggestion: "备课审校时保留此证据提示，不将相关内容标记为已验证。", evidence: point.source ? [point.source] : [] });
  }
  return issues;
}

export type MarkdownPackageParseResult = { draft: ResourcePackageDraft; handoff: ResourcePackageHandoffMetadata; planningIssues: ResourcePackagePlanningIssue[] };

/** Deterministic parser for the upstream handoffFormatVersion 1 Markdown contract. */
export function parseMarkdownResourcePackageDraft(knowledge: MarkdownResourceDocument, lesson: MarkdownResourceDocument): MarkdownPackageParseResult {
  const handoff = validateHandoffMetadata(knowledge, lesson);
  const draft = emptyResourcePackageDraft();
  draft.parsingVersion = 2;
  draft.sourceEvidence = {};
  const overview = sectionBody(lesson.lines, "本课概览", 2);
  const titleLine = lesson.lines.find((line) => /^#\s+/.test(line))?.replace(/^#\s+/, "").trim() ?? "";
  draft.courseName = titleLine.replace(/[：:]\s*(?:初步)?教案设计\s*$/, "");
  draft.subject = fieldValue(overview, ["课程", "学科"]);
  draft.grade = fieldValue(overview, ["授课对象", "教学对象", "专业与年级", "年级", "学段"]);
  draft.drivingQuestion = fieldValue(overview, ["驱动问题", "项目学习驱动问题"]);
  draft.projectTask = fieldValue(overview, ["项目任务"]) || undefined;
  const period = fieldValue(overview, ["授课时间"]) || fieldValue(overview, ["项目周期"]);
  const lessonCount = period.match(/(\d+)\s*(?:课时|节课|课次)/);
  const minutesPerLesson = period.match(/每(?:课时|节课|课次)\s*(\d+)\s*分钟/);
  draft.lessonCount = lessonCount ? Number(lessonCount[1]) : null;
  draft.minutesPerLesson = minutesPerLesson ? Number(minutesPerLesson[1]) : null;
  draft.totalMinutes = draft.lessonCount && draft.minutesPerLesson ? draft.lessonCount * draft.minutesPerLesson : null;
  draft.expectedOutcome = fieldValue(overview, ["成果形式", "项目成果", "成果要求"]);
  draft.learningObjectives = sectionItems(sectionBody(lesson.lines, "教学目标", 2));
  const preClassPreparation = sectionItems(sectionBody(lesson.lines, "课前准备", 2));
  if (preClassPreparation.length) draft.preClassPreparation = preClassPreparation;
  const completionMode = fieldValue(overview, ["完成方式", "学习方式", "组织方式"]);
  const organizationRequirements = [...new Set([
    ...sectionItems(sectionBody(lesson.lines, "组织安排", 2)),
    ...(completionMode ? [`完成方式：${completionMode}`] : []),
  ])];
  if (organizationRequirements.length) draft.organizationRequirements = organizationRequirements;
  draft.aiUsagePolicy = organizationRequirements.find((item) => /^AI使用原则[：:]/i.test(item))?.replace(/^AI使用原则[：:]\s*/i, "") ?? "";
  draft.learnerContext = cleanSectionText(sectionBody(lesson.lines, "学情参考", 2));
  const facilitatorReference = listItems(sectionBody(lesson.lines, "教师主持要点", 3));
  if (facilitatorReference.length) draft.facilitatorReference = facilitatorReference;
  const highlights = teachingRequirementSections(lesson, ["AI知识教学重点", "教学重点"]);
  const difficulties = teachingRequirementSections(lesson, ["AI知识理解难点", "教学难点"]);
  if (highlights.items.length) {
    draft.teachingHighlights = highlights.items;
    draft.sourceEvidence.teachingHighlights = highlights.sources;
  }
  if (difficulties.items.length) {
    draft.teachingDifficulties = difficulties.items;
    draft.sourceEvidence.teachingDifficulties = difficulties.sources;
  }

  const classroom = sectionRange(lesson.lines, "课堂实施", 2);
  if (classroom) {
    const stageStarts: number[] = [];
    for (let index = classroom.start + 1; index < classroom.end; index++) if (heading(lesson.lines[index])?.level === 3) stageStarts.push(index);
    for (let position = 0; position < stageStarts.length; position++) {
      const start = stageStarts[position], end = stageStarts[position + 1] ?? classroom.end;
      const stageLines = lesson.lines.slice(start, end);
      const upstreamId = fieldValue(stageLines, ["ID"]);
      const key = STAGE_ID_TO_KEY[upstreamId as keyof typeof STAGE_ID_TO_KEY];
      if (!key) continue;
      const stage = draft.stages.find((item) => item.key === key)!;
      stage.title = heading(lesson.lines[start])!.title.replace(/^\d+\s*[.、．)]?\s*/, "");
      const duration = fieldValue(stageLines, ["时间与课次", "时间", "时长"]).match(/(\d+)\s*分钟/);
      stage.durationMin = duration ? Number(duration[1]) : null;
      const subsection = (names: string[]) => {
        const relative = stageLines.findIndex((line) => {
          const value = heading(line);
          return value?.level === 4 && names.includes(value.title.replace(/[：:]$/, "").trim());
        });
        if (relative < 0) return [];
        let subsectionEnd = stageLines.length;
        for (let index = relative + 1; index < stageLines.length; index++) if ((heading(stageLines[index])?.level ?? 99) <= 4) { subsectionEnd = index; break; }
        return stageLines.slice(relative + 1, subsectionEnd);
      };
      const subsectionValues = (names: string[]) => {
        const values = sectionItems(subsection(names));
        const inline = fieldValue(stageLines, names);
        return values.length ? values : inline ? [inline] : [];
      };
      stage.teacherActions = subsectionValues(["教师行动", "教师活动", "教师指导"]).join("\n");
      stage.requirements = subsectionValues(["学生行动", "学生活动", "学习活动", "任务与活动"]).join("\n");
      stage.aiActions = subsectionValues(["AI职责", "AI 支持", "AI支持", "AI伙伴支持"]).join("\n");
      stage.outputs = subsectionValues(["阶段产出", "阶段成果", "交付要求"]).join("\n");
      const checkpoints = subsectionValues(["课次检查点", "检查点"]);
      const observationPoints = subsectionValues(["观察与介入", "观察要点", "教师介入"]);
      if (checkpoints.length) stage.checkpoints = checkpoints;
      if (observationPoints.length) stage.observationPoints = observationPoints;
      draft.sourceEvidence[`stages.${key}`] = [markdownSource("lessonPlan", lesson, start, lesson.lines.slice(start, end).join("\n").slice(0, 16000))];
    }
  }
  if (!draft.totalMinutes && draft.stages.every((stage) => stage.durationMin !== null)) draft.totalMinutes = draft.stages.reduce((sum, stage) => sum + stage.durationMin!, 0);
  const showcaseStage = draft.stages.find((item) => item.key === "showcase");
  const showcaseSection = cleanSectionText(sectionBody(lesson.lines, "成果展示", 2));
  draft.showcasePlan = inferResourcePackageShowcasePlan(showcaseStage && {
    ...showcaseStage, requirements: [showcaseStage.requirements, showcaseSection].filter(Boolean).join("\n"),
  });
  const showcaseRange = sectionRange(lesson.lines, "成果展示", 2);
  if (showcaseRange && draft.showcasePlan) {
    draft.sourceEvidence.showcasePlan = lesson.lines.flatMap((line, index) => index > showcaseRange.start && index < showcaseRange.end && line.trim() && !heading(line)
      ? [markdownSource("lessonPlan", lesson, index)] : []);
  }

  const learningRange = sectionRange(knowledge.lines, "学习范围", 2);
  if (learningRange) {
    const groups: number[] = [];
    for (let index = learningRange.start + 1; index < learningRange.end; index++) if (heading(knowledge.lines[index])?.level === 3) groups.push(index);
    for (let position = 0; position < groups.length; position++) {
      const start = groups[position], end = groups[position + 1] ?? learningRange.end;
      const groupLines = knowledge.lines.slice(start, end);
      const groupTitle = heading(knowledge.lines[start])!.title.replace(/^\d+\s*[.、．)]?\s*/, "");
      const id = fieldValue(groupLines, ["ID"]) || stablePackageId("group", groupTitle);
      const point: ResourcePackageDraft["knowledgePoints"][number] = { id, name: groupTitle, description: fieldValue(groupLines, ["范围"]), subPoints: [], children: [],
        evidenceStatus: (fieldValue(groupLines, ["证据状态"]) || "SUPPORTED") as "SUPPORTED" | "PARTIAL" | "UNSUPPORTED", evidenceGap: fieldValue(groupLines, ["证据缺口"]),
        source: markdownSource("knowledge", knowledge, start, knowledge.lines[start]) };
      const children: number[] = [];
      for (let index = start + 1; index < end; index++) if (heading(knowledge.lines[index])?.level === 4) children.push(index);
      for (let childPosition = 0; childPosition < children.length; childPosition++) {
        const childStart = children[childPosition], childEnd = children[childPosition + 1] ?? end;
        const childLines = knowledge.lines.slice(childStart, childEnd);
        const name = heading(knowledge.lines[childStart])!.title;
        const description = fieldValue(childLines, ["内容"]);
        const taskAssociation = fieldValue(childLines, ["任务关联"]);
        const sources = fieldValue(childLines, ["来源"]).split(/[、,，]/).map((item) => item.trim()).filter(Boolean);
        const child = { id: fieldValue(childLines, ["ID"]) || stablePackageId("knowledge", `${id}:${name}`), name, description, taskAssociation, sources,
          source: markdownSource("knowledge", knowledge, childStart, knowledge.lines.slice(childStart, childEnd).join("\n").slice(0, 16000)) };
        point.children!.push(child);
        point.subPoints.push(`${name}：${description}`);
      }
      point.sources = [...new Set(point.children!.flatMap((child) => child.sources ?? []))];
      draft.knowledgePoints.push(point);
    }
  }
  const evidenceSection = sectionBody(knowledge.lines, "证据状态", 2);
  const overallStatus = (fieldValue(evidenceSection, ["总体状态"]) || (draft.knowledgePoints.some((item) => item.evidenceStatus === "PARTIAL") ? "PARTIAL" : "SUPPORTED")) as "SUPPORTED" | "PARTIAL" | "UNSUPPORTED";
  draft.knowledgeEvidenceSummary = { overallStatus, gaps: listItems(evidenceSection).filter((item) => !/^总体状态[：:]/.test(item)) };

  const evaluationLines = sectionBody(lesson.lines, "评价安排", 2);
  draft.evaluationCriteria = cleanSectionText(evaluationLines);
  const dimensions = listItems(evaluationLines).flatMap((item) => {
    const match = item.match(/^(.+?)[（(](\d+(?:\.\d+)?)%[）)]\s*[：:]\s*(.+)$/);
    return match ? [{ id: stablePackageId("dimension", match[1]), name: match[1].trim(), weight: Number(match[2]), description: match[3].trim() }] : [];
  });
  if (dimensions.length) draft.evaluationRubric = { id: stablePackageId("rubric", draft.courseName), version: 1, dimensions, sourceWeights: { teacher: 60, ai: 40 } };
  draft.originalEvaluationSources = evaluationLines.map((line) => line.trim()).find((line) => /同伴互评|教师点评|AI评分|教师评分/.test(line));
  draft.reflectionQuestions = sectionItems(sectionBody(lesson.lines, "学生反思", 2));
  if (draft.reflectionQuestions.length) draft.reflectionQuestionSet = { id: stablePackageId("reflection", draft.courseName), version: 1,
    questions: draft.reflectionQuestions.map((prompt, index) => ({ id: stablePackageId("question", `${index}:${prompt}`), prompt, required: true })) };
  if (draft.expectedOutcome) draft.finalDeliverables = [{ id: "final-lesson-plan", name: draft.expectedOutcome.split(/[；;]/)[0].trim() || "初步教案文档", format: "document", requirements: draft.expectedOutcome, required: true }];
  for (const field of ["courseName", "grade", "drivingQuestion", "projectTask", "expectedOutcome"] as const) {
    const value = draft[field];
    if (!value) continue;
    const index = lesson.lines.findIndex((line) => line.includes(value));
    if (index >= 0) draft.sourceEvidence[field] = [markdownSource("lessonPlan", lesson, index)];
  }
  for (const [field, values] of [
    ["learningObjectives", draft.learningObjectives],
    ["preClassPreparation", draft.preClassPreparation ?? []],
    ["organizationRequirements", draft.organizationRequirements ?? []],
    ["facilitatorReference", draft.facilitatorReference ?? []],
  ] as const) {
    const evidence = values.flatMap((value) => {
      const normalized = value.replace(/^完成方式[：:]\s*/, "");
      const index = lesson.lines.findIndex((line) => line.includes(normalized));
      return index < 0 ? [] : [markdownSource("lessonPlan", lesson, index, lesson.lines[index].trim())];
    });
    if (evidence.length) draft.sourceEvidence[field] = evidence;
  }
  const learnerContextRange = sectionRange(lesson.lines, "学情参考", 2);
  if (learnerContextRange && draft.learnerContext) {
    draft.sourceEvidence.learnerContext = lesson.lines.flatMap((line, index) => index > learnerContextRange.start && index < learnerContextRange.end && line.trim() && !heading(line)
      ? [markdownSource("lessonPlan", lesson, index)] : []);
  }
  const normalized = normalizePackageStructure(draft);
  return { draft: normalized, handoff, planningIssues: parsePlanningIssues(lesson, normalized) };
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
