import { createHash } from "node:crypto";
import path from "node:path";
import { readBoundedZip, ResourcePackageError } from "./archive";
import { adaptPersonalProjectText, RESOURCE_PACKAGE_STAGE_LABELS, type CourseResourcePackage, type ResourcePackageConflict, type ResourcePackageDraft, type ResourcePackageSource } from "./types";

export function stablePackageSignature(value: unknown): string {
  const ordered = (item: unknown): unknown => Array.isArray(item) ? item.map(ordered) : item && typeof item === "object"
    ? Object.fromEntries(Object.entries(item).filter(([, entry]) => entry !== undefined).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, ordered(entry)])) : item;
  return createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex");
}
export function packageDraftSignature(draft: ResourcePackageDraft): string { return stablePackageSignature(draft); }
export function readPresentationEvidence(bytes: Buffer): ResourcePackageSource[] {
  const entries = readBoundedZip(bytes);
  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  const presentation = byName.get("ppt/presentation.xml")?.read().toString("utf8") ?? "";
  const relationships = byName.get("ppt/_rels/presentation.xml.rels")?.read().toString("utf8") ?? "";
  const attribute = (xml: string, name: string) => xml.match(new RegExp(`(?:^|\\s)${name}=["']([^"']+)["']`))?.[1];
  const paths = new Map([...relationships.matchAll(/<Relationship\b[^>]*>/g)].flatMap((match) => {
    const id = attribute(match[0], "Id"); const target = attribute(match[0], "Target");
    return id && target && attribute(match[0], "TargetMode") !== "External" ? [[id, path.posix.normalize(target.startsWith("/") ? target.slice(1) : path.posix.join("ppt", target))] as const] : [];
  }));
  const slideIds = [...presentation.matchAll(/<(?:p:)?sldId\b[^>]*>/g)].map((match) => attribute(match[0], "r:id")).filter((id): id is string => Boolean(id));
  const ordered = slideIds.length ? slideIds.map((id) => {
    const entry = byName.get(paths.get(id) ?? "");
    if (!entry || !/^ppt\/slides\/[^/]+\.xml$/.test(entry.name)) throw new ResourcePackageError("PPT页序关系已损坏，请重新导出课件。", "RESOURCE_PACKAGE_INVALID_PPTX", 422);
    return entry;
  }) : entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)).sort((a, b) => Number(a.name.match(/slide(\d+)/)?.[1]) - Number(b.name.match(/slide(\d+)/)?.[1]));
  return ordered.map((entry, index) => ({ documentRole: "launchPresentation", locator: `第${index + 1}页`, archivePath: entry.name, quote: [...entry.read().toString("utf8").matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map((match) => match[1].replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">" )).join("\n") }));
}
export function inspectPackageCompatibility(lessonText: string, presentationEvidence: ResourcePackageSource[]): { conflicts: ResourcePackageConflict[]; conflictVersion: string } {
  const lesson = lessonText.split("\n").filter(Boolean).map((quote, index): ResourcePackageSource => ({ documentRole: "lessonPlan", locator: `第${index + 1}段/表格行`, quote }));
  // Only inspect classroom directions from the lesson/PPT. Knowledge descriptions of collaborative learning are not scheduling instructions.
  const evidence = [...lesson, ...presentationEvidence];
  const organization = evidence.filter((item) => item.quote.split(/[。；;\n]/).some((sentence) => {
    const directions = sentence.replace(/AI\s*(?:虚拟)?小组|个人与\s*AI\s*伙伴/g, "AI协作空间");
    return /组建小组|组织小组|分组名单|(?:学生|全班).{0,12}分(?:成|为).{0,10}组|[\d一二三四五六七八九十]+人一组|团队组建|每组(?:约|必须|全员|展示|\s*\d)|每组.*(?:分钟|学生|人)|各组|全组|所有小组|组员姓名|分配组员|小组(?:共同讨论|成员分工|分工是否)/.test(directions);
  }));
  const evaluation = evidence.filter((item) => /(?:同伴互评|小组自评|学生自评|自评|互评).{0,15}[（(]?\s*\d+\s*[%％]|(?:\d+\s*[%％]).{0,10}(?:互评|自评)/.test(item.quote));
  const conflicts: ResourcePackageConflict[] = [];
  if (organization.length) conflicts.push({ id: "classroom-organization", kind: "organization", summary: "资源包安排了真人小组或按组汇报", reason: "本课堂每位学生拥有独立的 AI 虚拟小组，提交个人作品；现场汇报由教师选择部分学生，不能把每组汇报分钟直接改成每人分钟。", suggestion: "统一改为学生与 AI 伙伴协作；全员提交个人作品，教师选取部分作品在原成果展示总预算内汇报。保留整课和五阶段分钟数。", evidence: organization });
  if (evaluation.length) conflicts.push({ id: "evaluation-sources", kind: "evaluation", summary: "资源包评价来源包含同伴互评或小组自评计分", reason: "系统正式成绩来源为教师与 AI；同伴意见可用于讨论和改进，不作为第三种计分来源。", suggestion: "保留资源包评价维度与维度权重，评分来源调整为教师60%与AI40%，教师可在确认页修改这两个比例。", evidence: evaluation });
  return { conflicts, conflictVersion: createHash("sha256").update(JSON.stringify(conflicts)).digest("hex").slice(0, 20) };
}

export function adaptClassroomInstruction(text: string): string {
  return adaptPersonalProjectText(text
    .replace(/(?:将(?:全班|学生))?分为\s*[\d一二三四五六七八九十]+\s*(?:个)?(?:小)?组/g, "每位学生建立个人 AI 协作空间")
    .replace(/团队组建|组建团队/g, "建立个人 AI 协作空间")
    .replace(/[^。；;\n]*(?:互评|自评)[^。；;\n]*\d+\s*[%％][^。；;\n]*/g, "正式评分采用确认的教师与 AI 来源比例及课程量规，反馈用于作品改进")
    .replace(/[^。；;\n]*(?:每组|各组|小组|全组)[^。；;\n]*\d+(?:\.\d+)?\s*分钟[^。；;\n]*/g, "教师选取部分学生现场汇报，汇报、交流和衔接共同使用本阶段总时间，由教师控制队列与节奏")
    .replace(/所有小组依次上台/g, "所有学生提交个人作品，教师选取部分学生现场汇报")
    .replace(/每组(?:必须)?全员上台或指定代表配合讲解/g, "入选学生独立汇报，其他学生参与讨论")
    .replace(/观察小组分工是否均衡，是否存在边缘化成员/g, "观察学生是否独立完成核心决策，是否有效使用 AI 伙伴支持")
    .replace(/小组成员分工明确/g, "学生独立完成任务并明确 AI 伙伴职责")
    .replace(/同伴互评|学生互评|小组自评|学生自评/g, "师生反馈")
    .replace(/你们/g, "你")
    .replace(/分配组员负责的/g, "自行规划并借助 AI 伙伴支持的")
    .replace(/小组改进清单/g, "个人改进清单"));
}

/** Explicitly called only after authorization bound to the source revision and conflict version. */
export function adaptResourcePackageDraft(draft: ResourcePackageDraft): { draft: ResourcePackageDraft; changes: string[] } {
  const adapted: ResourcePackageDraft = { ...draft,
    learningObjectives: draft.learningObjectives.map(adaptClassroomInstruction), expectedOutcome: adaptClassroomInstruction(draft.expectedOutcome),
    stages: draft.stages.map((stage) => ({ ...stage, title: RESOURCE_PACKAGE_STAGE_LABELS[stage.key], requirements: adaptClassroomInstruction(stage.requirements), outputs: adaptClassroomInstruction(stage.outputs), teacherActions: adaptClassroomInstruction(stage.teacherActions), aiActions: adaptClassroomInstruction(stage.aiActions), checkpoints: stage.checkpoints?.map(adaptClassroomInstruction), observationPoints: stage.observationPoints?.map(adaptClassroomInstruction) })),
    finalDeliverables: draft.finalDeliverables?.map((item) => ({ ...item, name: adaptClassroomInstruction(item.name), requirements: adaptClassroomInstruction(item.requirements) })),
    reflectionQuestions: draft.reflectionQuestions.map(adaptClassroomInstruction),
    reflectionQuestionSet: draft.reflectionQuestionSet ? { ...draft.reflectionQuestionSet, questions: draft.reflectionQuestionSet.questions.map((item) => ({ ...item, prompt: adaptClassroomInstruction(item.prompt) })) } : undefined,
    evaluationRubric: draft.evaluationRubric ? { ...draft.evaluationRubric, dimensions: draft.evaluationRubric.dimensions.map((item) => ({ ...item, description: adaptClassroomInstruction(item.description) })) } : undefined,
  };
  if (adapted.evaluationRubric) adapted.evaluationCriteria = `正式评分来源：教师${adapted.evaluationRubric.sourceWeights.teacher}%、AI${adapted.evaluationRubric.sourceWeights.ai}%。\n${adapted.evaluationRubric.dimensions.map((item) => `${item.name} ${item.weight}%：${item.description}`).join("\n")}\n师生讨论意见用于作品改进，不额外计入成绩。`;
  const make = adapted.stages.find((stage) => stage.key === "make");
  if (make && /终稿/.test([...(make.checkpoints ?? []), ...(adapted.finalDeliverables ?? []).map((item) => item.requirements)].join("\n"))
    && /初稿/.test(make.outputs) && !/终稿/.test(make.outputs)) make.outputs = make.outputs.replace(/初稿/g, "初稿（按课次检查点继续修订并交付终稿）");
  const showcase = adapted.stages.find((stage) => stage.key === "showcase");
  if (showcase) { showcase.requirements = `所有学生提交个人作品；教师选取部分学生在${showcase.durationMin}分钟总预算内现场汇报，其余学生参与提问和讨论。\n${showcase.requirements.replace(/^所有学生提交个人作品；教师选取部分学生在\d+分钟总预算内现场汇报，其余学生参与提问和讨论。\n/, "")}`; showcase.outputs = "每位学生的个人作品与汇报材料；入选学生完成现场汇报，记录师生反馈。"; }
  return { draft: adapted, changes: ["真人小组安排改为每位学生与自己的 AI 伙伴协作，学生承担最终决策。", "所有学生提交个人作品；教师选取部分学生现场汇报，保持原阶段总时间。", "保留知识内容、评价维度和维度权重；评分来源使用确认页的教师/AI比例。", "统一更新阶段任务、观察介入、检查点、最终交付和反思题，并生成适配后的启动课件。"] };
}
export function resourcePackageFeedback(resourcePackage: CourseResourcePackage): string {
  return ["# 教学资源包对接反馈", `资源包：${resourcePackage.source.fileName}`, `来源版本：${resourcePackage.revision}`, `问题清单版本：${resourcePackage.conflictVersion ?? ""}`, "", ...(resourcePackage.conflicts ?? []).flatMap((issue) => [`## ${issue.summary}`, issue.reason, `建议：${issue.suggestion}`, ...issue.evidence.map((item) => `- ${item.documentRole} ${item.locator}：${item.quote}`), ""])].join("\n");
}
