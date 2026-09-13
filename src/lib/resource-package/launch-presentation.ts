import pptxgen from "pptxgenjs";
import type { ResourcePackageDraft } from "./types";
import { RESOURCE_PACKAGE_STAGE_LABELS } from "./types";
import path from 'node:path';
import sharp from 'sharp';
import { readBoundedZip } from './archive';
import { adaptClassroomInstruction, readPresentationEvidence } from './compatibility';

export type ClassroomPresentationPage = { title: string; subtitle?: string; items: { heading: string; text: string; url?: string }[]; image?: string; notes?: string; layout: "focus" | "sequence" | "outline" | "rubric" };
const lines = (text: string) => text.split(/[\n；;]/).map((item) => item.trim()).filter(Boolean);

/** Shared server writer: fixed, readable geometry and full-canvas composition, with adapted teaching notes. */
export async function writeClassroomPresentation(pages: ClassroomPresentationPage[], title: string): Promise<Buffer> {
  const presentation = new pptxgen(); presentation.layout = "LAYOUT_WIDE"; presentation.title = title;
  presentation.author = "美杰课堂"; presentation.subject = "教师确认的课堂启动资源";
  presentation.theme = { headFontFace: "Noto Sans SC", bodyFontFace: "Noto Sans SC" };
  for (const [index, page] of pages.entries()) {
    const slide = presentation.addSlide(); slide.background = { color: "F5F3EC" };
    const dark = "163B3C"; const muted = "526866";
    slide.addShape(presentation.ShapeType.rect, { x: 0.6, y: 0.5, w: 0.08, h: 0.5, fill: { color: "AE6A43" }, line: { color: "AE6A43" } });
    slide.addText(page.title, { x: 0.9, y: 0.47, w: 11.55, h: 0.65, fontSize: 27, bold: true, color: dark, margin: 0, breakLine: false });
    if (page.subtitle) slide.addText(page.subtitle, { x: 0.9, y: 1.22, w: 11.6, h: 0.6, fontSize: 13.5, color: muted, margin: 0 });
    const bodyTop = page.subtitle ? 2 : 1.7;
    if (page.image) {
      const metadata = await sharp(Buffer.from(page.image.split('base64,')[1], 'base64')).metadata();
      const scale = Math.min(7.2 / (metadata.width || 1), 4.5 / (metadata.height || 1));
      const w = (metadata.width || 1) * scale, h = (metadata.height || 1) * scale;
      slide.addImage({ data: page.image, x: 0.9 + (7.2 - w) / 2, y: 2 + (4.5 - h) / 2, w, h });
      slide.addText(page.items.map((item) => `${item.heading}\n${item.text}`).join('\n\n'), { x: 8.55, y: 2.1, w: 3.8, h: 4.2, fontSize: 19, color: dark, margin: 0, valign: 'middle' });
    } else if (page.layout === "focus" && page.items.length <= 2) {
      const lead = page.items[0];
      if (lead) { slide.addText(lead.heading, { x: 1.2, y: 2.1, w: 10.9, h: 0.6, fontSize: 18, bold: true, color: muted, align: "center", margin: 0 }); slide.addText(lead.text, { x: 1.2, y: 2.85, w: 10.9, h: 2.2, fontSize: lead.text.length > 110 ? 23 : 29, bold: true, color: dark, align: "center", valign: "middle", margin: 0.05 }); }
      if (page.items[1]) slide.addText(`${page.items[1].heading}  ${page.items[1].text}`, { x: 1.4, y: 5.65, w: 10.5, h: 0.75, fontSize: 16, color: muted, align: "center", margin: 0 });
    } else {
      const items = page.items; const rowHeight = Math.min(1.03, 4.65 / Math.max(items.length, 1));
      const yStart = bodyTop + Math.max(0, (4.65 - items.length * rowHeight) / 2);
      items.forEach((item, itemIndex) => {
        const y = yStart + itemIndex * rowHeight;
        slide.addText(page.layout === "sequence" ? `${String(itemIndex + 1).padStart(2, "0")}` : "—", { x: 0.95, y: y + 0.08, w: 0.55, h: 0.4, fontSize: 17, bold: true, color: "AE6A43", margin: 0 });
        slide.addText(item.heading, { x: 1.7, y: y + 0.03, w: 3.0, h: Math.min(0.65, rowHeight - 0.08), fontSize: 17, bold: true, color: dark, margin: 0, valign: "middle" });
        slide.addText(item.text, { x: 4.9, y, w: 7.35, h: rowHeight - 0.08, fontSize: item.text.length > 90 ? 13.5 : 16, color: muted, margin: 0, valign: "middle", ...(item.url ? { hyperlink: { url: item.url } } : {}) });
        if (itemIndex < items.length - 1) slide.addShape(presentation.ShapeType.line, { x: 1.7, y: y + rowHeight - 0.02, w: 10.5, h: 0, line: { color: "D8DEDA", width: 0.6 } });
      });
    }
    slide.addText(`${title}  ·  ${index + 1} / ${pages.length}`, { x: 0.9, y: 7.0, w: 11.55, h: 0.2, fontSize: 9, color: muted, margin: 0 });
    slide.addNotes(page.notes ?? [page.title, page.subtitle, ...page.items.map((item) => `${item.heading}：${item.text}`)].filter(Boolean).join("\n"));
  }
  return Buffer.from(await presentation.write({ outputType: "nodebuffer" }) as Uint8Array);
}

export function buildAdaptedLaunchPages(draft: ResourcePackageDraft, sourcePptx?: Buffer): ClassroomPresentationPage[] {
  const rubric = draft.evaluationRubric;
  const stage = (key: string) => draft.stages.find((item) => item.key === key)!;
  const defaults: ClassroomPresentationPage[] = [
    { title: draft.courseName, subtitle: `${draft.grade} · ${draft.totalMinutes}分钟 · 个人与 AI 伙伴协作`, layout: "focus", items: [{ heading: "项目学习驱动问题", text: draft.drivingQuestion }] },
    { title: "学习目标与成功标准", layout: "outline", items: draft.learningObjectives.map((text, index) => ({ heading: `目标 ${index + 1}`, text })) },
    { title: "五阶段学习路线", subtitle: `总计${draft.totalMinutes}分钟；各环节保持教案确认时长`, layout: "sequence", items: draft.stages.map((item) => ({ heading: `${RESOURCE_PACKAGE_STAGE_LABELS[item.key]} · ${item.durationMin}分钟`, text: item.outputs })) },
    { title: "每个人拥有自己的 AI 虚拟小组", layout: "focus", items: [{ heading: "学生作出决定，AI 提供支持", text: "每位学生独立完成核心任务，借助 AI 伙伴梳理、质询和改进；所有学生提交个人作品。" }, { heading: "过程证据", text: "记录 AI 建议、采纳或修改的理由，最终内容由学生核对。" }] },
    { title: "知识讲授：为项目建立依据", subtitle: `${stage("ai-learning").durationMin}分钟，讲解、互动、检测与讲评共同使用这一预算`, layout: "outline", items: draft.knowledgePoints.map((group) => ({ heading: group.name, text: group.description || (group.children ?? []).map((child) => child.name).join("、") })) },
    { title: "项目实践与课次检查点", subtitle: `${stage("make").durationMin}分钟，把理论用于个人项目`, layout: "sequence", items: (stage("make").checkpoints?.length ? stage("make").checkpoints! : lines(stage("make").requirements)).map((text, index) => ({ heading: `检查点 ${index + 1}`, text })) },
    { title: "最终交付：提交完整的个人作品", layout: "outline", items: (draft.finalDeliverables ?? []).map((item) => ({ heading: item.name, text: item.requirements })) },
    { title: "成果展示：全员提交，教师选取现场汇报", subtitle: `汇报、讨论与衔接共${stage("showcase").durationMin}分钟，教师控制现场队列与节奏`, layout: "sequence", items: [{ heading: "所有学生", text: "提交个人作品与汇报材料，清楚说明关键决策及 AI 协作过程。" }, { heading: "入选学生", text: "阐述理论依据、活动亮点和作品证据，回答听众的问题。" }, { heading: "其他学生", text: "根据评价维度提出具体问题与改进意见。" }] },
    { title: "评价：依据作品证据与过程记录", subtitle: `正式评分来源：教师${rubric?.sourceWeights.teacher ?? 60}% · AI${rubric?.sourceWeights.ai ?? 40}%`, layout: "rubric", items: rubric?.dimensions.map((item) => ({ heading: `${item.name} · ${item.weight}%`, text: item.description })) ?? [] },
    { title: "反思：说明你的判断与下一次改进", subtitle: `${stage("reflection").durationMin}分钟，完成个人反思`, layout: "outline", items: (draft.reflectionQuestionSet?.questions ?? draft.reflectionQuestions.map((prompt) => ({ prompt }))).map((question, index) => ({ heading: `反思 ${index + 1}`, text: question.prompt })) },
  ];
  if (!sourcePptx) return defaults;
  const evidence = readPresentationEvidence(sourcePptx);
  const archive = readBoundedZip(sourcePptx);
  return evidence.map((page, index) => {
    const text = page.quote;
    let chosen: ClassroomPresentationPage;
    if (index === 0) chosen = { ...defaults[0], notes: text };
    else if (/情境导入/.test(text)) chosen = { title: '情境导入', layout: 'focus', items: [{ heading: '观察与思考', text: adaptClassroomInstruction(text.split('情境导入')[1]?.split('人工智能教育导论')[0]?.replace(/\n/g, '').trim() || draft.drivingQuestion) }] };
    else if (/驱动问题/.test(text)) chosen = { title: '项目学习驱动问题', layout: 'focus', items: [{ heading: '以这个问题贯穿项目', text: draft.drivingQuestion }] };
    else if (/五阶段|阶段与时间/.test(text)) chosen = defaults[2];
    else if (/项目[：:]做什么/.test(text)) chosen = { title: '个人项目：做什么', layout: 'outline', items: [
      ...extractSourceItems(text, ['项目任务', '成果形式', '必要要求']),
      { heading: '协作方式', text: '每位学生与自己的 AI 伙伴协作，独立提交作品。' },
    ] };
    else if (/怎样合作推进|合作与推进/.test(text)) chosen = { title: '个人与 AI 伙伴：怎样推进项目', layout: 'sequence', items: extractSourceItems(text, ['确定方向', '搭建框架', '细化内容与AI辅助', '完成可视化']) };
    else if (/成果展示/.test(text)) chosen = { ...defaults[7], items: [...defaults[7].items.slice(0, 2), ...extractSourceItems(text, ['展示要求']).filter((item) => !/全员上台|指定代表/.test(item.text))] };
    else if (/评价标准|评价维度/.test(text)) chosen = defaults[8];
    else if (/下一步/.test(text)) chosen = { title: '下一步：与 AI 讲师学习', layout: 'focus', items: [{ heading: `${stage('ai-learning').durationMin} 分钟知识讲授`, text: '理解项目所需的核心知识，完成互动与检测，再把学习所得用于个人课程设计。' }] };
    else {
      const content = text.split('\n').filter((line) => line.trim() && !/^项目式学习|^人工智能教育导论$|^\d+\s*\/\s*\d+$|^打开资源/.test(line));
      chosen = { title: adaptClassroomInstruction(content.shift() ?? `项目启动 ${index + 1}`), layout: 'outline', items: content.map((line) => ({ heading: '', text: adaptClassroomInstruction(line) })) };
    }
    const slidePath = page.archivePath ?? `ppt/slides/slide${index + 1}.xml`;
    const xml = archive.find((entry) => entry.name === slidePath)?.read().toString('utf8') ?? '';
    const rels = archive.find((entry) => entry.name === `${path.posix.dirname(slidePath)}/_rels/${path.posix.basename(slidePath)}.rels`)?.read().toString('utf8') ?? '';
    if (/相关资源/.test(text)) {
      const links = [...rels.matchAll(/<Relationship\b[^>]+>/g)].map((match) => match[0])
        .filter((node) => node.includes('/hyperlink'))
        .map((node) => node.match(/Target="([^"]+)"/)?.[1]?.replace(/&amp;/g, '&'))
        .filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)));
      const entries = text.split('相关资源')[1]?.split('人工智能教育导论')[0]?.split('打开资源 ↗').filter((part) => part.trim()) ?? [];
      chosen = { title: '相关资源', subtitle: '资源包提供的参考资料；结合课堂任务核对其适用范围', layout: 'outline', items: entries.map((entry, i) => ({ heading: `参考资料 ${i + 1}`, text: entry.split('用于查阅')[0].replace(/\n/g, '').trim(), ...(links[i] ? { url: links[i] } : {}) })) };
    }
    const pics = [...xml.matchAll(/<p:pic\b[\s\S]*?<\/p:pic>/g)].map((match) => ({ id: match[0].match(/r:embed="([^"]+)"/)?.[1], area: Number(match[0].match(/<a:ext\s+cx="(\d+)"/)?.[1] ?? 0) * Number(match[0].match(/<a:ext\s+cx="\d+"\s+cy="(\d+)"/)?.[1] ?? 0) })).sort((a, b) => b.area - a.area);
    const pic = pics[0];
    if (pic?.id && /情境导入/.test(text)) {
      const relation = [...rels.matchAll(/<Relationship\b[^>]+>/g)].map((match) => match[0]).find((node) => node.includes(`Id="${pic.id}"`) && !node.includes('TargetMode="External"'));
      const target = relation?.match(/Target="([^"]+)"/)?.[1];
      const file = target ? archive.find((entry) => entry.name === path.posix.normalize(path.posix.join(path.posix.dirname(slidePath), target))) : undefined;
      if (file && /\.(png|jpe?g)$/i.test(file.name)) chosen.image = `image/${/\.png$/i.test(file.name) ? 'png' : 'jpeg'};base64,${file.read().toString('base64')}`;

    }
    return { ...chosen, notes: `授课内容（对应资源包${page.locator}）：\n${chosen.items.map((item) => `${item.heading}：${item.text}`).join('\n')}` };
  });
}

function extractSourceItems(text: string, headings: string[]): ClassroomPresentationPage['items'] {
  const result: ClassroomPresentationPage['items'] = [];
  let current: ClassroomPresentationPage['items'][number] | undefined;
  for (const line of text.split('\n')) {
    if (headings.includes(line)) { current = { heading: line, text: '' }; result.push(current); }
    else if (/^(组队建议|人工智能教育导论|\d+\s*\/\s*\d+)$/.test(line)) current = undefined;
    else if (current && !/^\d+$/.test(line)) current.text += line;
  }
  return result.map((item) => ({ ...item, text: adaptClassroomInstruction(item.text).replace(/[（(][^）)]*[.…]{1,3}$/, '') }));
}
