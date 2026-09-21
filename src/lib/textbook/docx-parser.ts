import path from "node:path";
import { readBoundedZip, ResourcePackageError, type ArchiveEntry } from "@/lib/resource-package/archive";
import { TextbookError } from "./errors";
import { normalizeTextbookText } from "./text";
import type {
  ParsedTextbookBlock,
  ParsedTextbookDocument,
  ParsedTextbookFigure,
  ParsedTextbookSection,
  TextbookBlockType,
  TextbookSectionKind,
} from "./types";

export const TEXTBOOK_DOCX_LIMITS = {
  compressedBytes: 80 * 1024 * 1024,
  expandedBytes: 500 * 1024 * 1024,
  entryBytes: 128 * 1024 * 1024,
  entries: 4_096,
};

type StyleInfo = { name: string; outlineLevel: number | null; isToc: boolean };
type Relationship = { id: string; target: string; type: string };

const qname = (localName: string) => `(?:[A-Za-z_][\\w.-]*:)?${localName}`;
const opening = (localName: string) => new RegExp(`<${qname(localName)}\\b([^>]*)>`, "i");
const elements = (xml: string, localName: string): Array<{ xml: string; attributes: string; content: string }> => {
  const pattern = new RegExp(`<${qname(localName)}\\b([^>]*)>([\\s\\S]*?)<\\/${qname(localName)}\\s*>`, "gi");
  return Array.from(xml.matchAll(pattern), (match) => ({ xml: match[0], attributes: match[1], content: match[2] }));
};
const attribute = (value: string, localName: string): string | null => {
  const match = value.match(new RegExp(`(?:^|\\s)(?:[A-Za-z_][\\w.-]*:)?${localName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i"));
  return match?.[1] ?? match?.[2] ?? null;
};
const childAttribute = (xml: string, elementName: string, attributeName: string): string | null => {
  const match = xml.match(opening(elementName));
  return match ? attribute(match[1], attributeName) : null;
};

function decodeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function xmlText(xml: string): string {
  const tokenPattern = new RegExp(
    `<${qname("t")}\\b[^>]*>([\\s\\S]*?)<\\/${qname("t")}\\s*>|<${qname("tab")}\\b[^>]*/\\s*>|<${qname("(?:br|cr)")}\\b[^>]*/\\s*>`,
    "gi",
  );
  let result = "";
  for (const match of xml.matchAll(tokenPattern)) {
    if (match[1] !== undefined) result += decodeXml(match[1]);
    else if (/tab/i.test(match[0])) result += "\t";
    else result += "\n";
  }
  return normalizeTextbookText(result.replace(/\s*\n\s*/g, "\n").replace(/\s*\t\s*/g, "\t"));
}

function parseStyles(xml: string | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!xml) return styles;
  rejectUnsafeXml(xml);
  for (const style of elements(xml, "style")) {
    const id = attribute(style.attributes, "styleId");
    if (!id) continue;
    const name = childAttribute(style.content, "name", "val") ?? id;
    const outlineRaw = childAttribute(style.content, "outlineLvl", "val");
    const outlineLevel = outlineRaw !== null && /^\d+$/.test(outlineRaw) ? Number(outlineRaw) : null;
    styles.set(id, { name, outlineLevel, isToc: /^(?:toc|目录)\s*\d*$/i.test(name.trim()) });
  }
  return styles;
}

function parseRelationships(xml: string | undefined): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  if (!xml) return relationships;
  rejectUnsafeXml(xml);
  const pattern = new RegExp(`<${qname("Relationship")}\\b([^>]*)/\\s*>`, "gi");
  for (const match of xml.matchAll(pattern)) {
    const id = attribute(match[1], "Id");
    const target = attribute(match[1], "Target");
    const type = attribute(match[1], "Type");
    if (id && target && type) relationships.set(id, { id, target, type });
  }
  return relationships;
}

function rejectUnsafeXml(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new TextbookError("INVALID_DOCX_XML", "教材 Word 包含不支持的 XML 声明。", 422);
}

function readText(entries: Map<string, ArchiveEntry>, name: string, maximum = 16 * 1024 * 1024): string | undefined {
  const entry = entries.get(name);
  if (!entry) return undefined;
  if (entry.size > maximum) throw new TextbookError("DOCX_PART_TOO_LARGE", `教材 Word 内部文件 ${name} 过大。`, 422);
  const value = entry.read().toString("utf8");
  rejectUnsafeXml(value);
  return value;
}

function safeRelationshipTarget(target: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith("/") || target.includes("\\")) return null;
  const normalized = path.posix.normalize(path.posix.join("word", target));
  return normalized.startsWith("word/") && !normalized.includes("../") ? normalized : null;
}

function imageMimeType(name: string): string | null {
  switch (path.posix.extname(name).toLowerCase()) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".gif": return "image/gif";
    case ".webp": return "image/webp";
    case ".svg": return "image/svg+xml";
    case ".bmp": return "image/bmp";
    case ".tif":
    case ".tiff": return "image/tiff";
    case ".emf": return "image/emf";
    case ".wmf": return "image/wmf";
    default: return null;
  }
}

function paragraphImageIds(xml: string): string[] {
  const ids = new Set<string>();
  const pattern = new RegExp(`<${qname("(?:blip|imagedata)")}\\b([^>]*)`, "gi");
  for (const match of xml.matchAll(pattern)) {
    const id = attribute(match[1], "embed") ?? attribute(match[1], "id");
    if (id) ids.add(id);
  }
  return [...ids];
}

function paragraphExtent(xml: string): { width: number | null; height: number | null } {
  const match = xml.match(opening("extent"));
  if (!match) return { width: null, height: null };
  const cx = Number(attribute(match[1], "cx"));
  const cy = Number(attribute(match[1], "cy"));
  return {
    width: Number.isFinite(cx) && cx > 0 ? Math.round(cx / 9_525) : null,
    height: Number.isFinite(cy) && cy > 0 ? Math.round(cy / 9_525) : null,
  };
}

function inferSectionKind(level: number): TextbookSectionKind {
  if (level <= 0) return "CHAPTER";
  if (level === 1) return "SECTION";
  return "SUBSECTION";
}

function inferBlockType(text: string, headingLevel: number | null, styleName: string, hasNumbering: boolean): TextbookBlockType {
  if (headingLevel !== null) return headingLevel === 0 ? "TITLE" : "HEADING";
  if (/caption|题注/i.test(styleName) || /^图\s*\d+(?:[-—.．]\s*\d+)+/u.test(text)) return "CAPTION";
  return hasNumbering ? "LIST_ITEM" : "PARAGRAPH";
}

function coreProperty(xml: string | undefined, name: string): string {
  if (!xml) return "";
  const match = xml.match(new RegExp(`<${qname(name)}\\b[^>]*>([\\s\\S]*?)<\\/${qname(name)}\\s*>`, "i"));
  return match ? normalizeTextbookText(decodeXml(match[1].replace(/<[^>]+>/g, ""))) : "";
}

function parseTable(xml: string): string {
  return elements(xml, "tr").map((row) => elements(row.content, "tc").map((cell) => elements(cell.content, "p").map((paragraph) => xmlText(paragraph.xml)).filter(Boolean).join("\n")).join("\t")).filter(Boolean).join("\n");
}

/**
 * Deterministic DOCX parser. Element and attribute matching is by local name,
 * so producers may use prefixes other than Word's conventional `w`/`r`.
 */
export function parseTextbookDocx(bytes: Buffer): ParsedTextbookDocument {
  let archive: ArchiveEntry[];
  try {
    archive = readBoundedZip(bytes, TEXTBOOK_DOCX_LIMITS);
  } catch (error) {
    if (error instanceof ResourcePackageError) {
      throw new TextbookError("INVALID_TEXTBOOK_DOCX", error.message.replaceAll("资源包", "教材 Word"), error.status === 400 ? 422 : error.status);
    }
    throw error;
  }
  const entries = new Map(archive.map((entry) => [entry.name, entry]));
  const documentXml = readText(entries, "word/document.xml", 64 * 1024 * 1024);
  if (!documentXml) throw new TextbookError("INVALID_TEXTBOOK_DOCX", "教材 Word 缺少正文内容。", 422);
  const styles = parseStyles(readText(entries, "word/styles.xml"));
  const relationships = parseRelationships(readText(entries, "word/_rels/document.xml.rels"));
  const coreXml = readText(entries, "docProps/core.xml");
  const warnings: string[] = [];
  const sections: ParsedTextbookSection[] = [];
  const blocks: ParsedTextbookBlock[] = [];
  const figures: ParsedTextbookFigure[] = [];
  const sectionStack: ParsedTextbookSection[] = [];
  const sectionPaths = new Set<string>();
  let activeSection: ParsedTextbookSection | null = null;
  let position = 0;

  const ensureFrontMatter = (): ParsedTextbookSection => {
    const existing = sections.find((section) => section.key === "section-front-matter");
    if (existing) return existing;
    const section: ParsedTextbookSection = {
      key: "section-front-matter",
      parentKey: null,
      title: "前置内容",
      path: "前置内容",
      kind: "FRONT_MATTER",
      level: 0,
      position: 0,
    };
    sections.push(section);
    sectionPaths.add(section.path);
    return section;
  };

  const body = elements(documentXml, "body")[0]?.content ?? documentXml;
  const bodyElementPattern = new RegExp(
    `<${qname("p")}\\b[\\s\\S]*?<\\/${qname("p")}\\s*>|<${qname("tbl")}\\b[\\s\\S]*?<\\/${qname("tbl")}\\s*>`,
    "gi",
  );
  for (const match of body.matchAll(bodyElementPattern)) {
    const elementXml = match[0];
    const isTable = new RegExp(`^<${qname("tbl")}\\b`, "i").test(elementXml);
    const text = isTable ? parseTable(elementXml) : xmlText(elementXml);
    const styleId = isTable ? null : childAttribute(elementXml, "pStyle", "val");
    const style = styleId ? styles.get(styleId) : undefined;
    const directOutline = isTable ? null : childAttribute(elementXml, "outlineLvl", "val");
    const headingLevel = directOutline !== null && /^\d+$/.test(directOutline)
      ? Number(directOutline)
      : style?.outlineLevel ?? null;
    const isDirectory = Boolean(style?.isToc) || /PAGEREF\s+_Toc/i.test(elementXml);
    const numberingId = isTable ? null : childAttribute(elementXml, "numId", "val");
    const numberingLevel = isTable ? null : childAttribute(elementXml, "ilvl", "val");
    const hasNumbering = numberingId !== null;
    const type = isTable ? "TABLE" : inferBlockType(text, headingLevel, style?.name ?? "", hasNumbering);
    const blockKey = `block-${position}`;
    const imageIds = paragraphImageIds(elementXml);

    if (!isDirectory && (text || imageIds.length) && activeSection === null && headingLevel === null) activeSection = ensureFrontMatter();

    if (!isDirectory && text && headingLevel !== null && headingLevel >= 0 && headingLevel <= 8) {
      while (sectionStack.length && sectionStack[sectionStack.length - 1].level >= headingLevel) sectionStack.pop();
      const parent = sectionStack[sectionStack.length - 1] ?? null;
      const basePath = parent ? `${parent.path} / ${text}` : text;
      const sectionPath = sectionPaths.has(basePath) ? `${basePath} · ${position}` : basePath;
      const section: ParsedTextbookSection = {
        key: `section-${position}`,
        parentKey: parent?.key ?? null,
        title: text,
        path: sectionPath,
        kind: inferSectionKind(headingLevel),
        level: headingLevel,
        position,
      };
      sections.push(section);
      sectionPaths.add(sectionPath);
      sectionStack.push(section);
      activeSection = section;
    }

    if (text || imageIds.length) {
      const block: ParsedTextbookBlock = {
        key: blockKey,
        sectionKey: isDirectory ? null : activeSection?.key ?? null,
        type,
        position,
        content: text,
        metadata: {
          styleId,
          styleName: style?.name ?? null,
          outlineLevel: headingLevel,
          isDirectory,
          hasNumbering,
          numberingId,
          numberingLevel: numberingLevel !== null && /^\d+$/.test(numberingLevel) ? Number(numberingLevel) : null,
          imageRelationshipIds: imageIds,
        },
      };
      blocks.push(block);
    }

    const extent = paragraphExtent(elementXml);
    for (const relationshipId of imageIds) {
      const relationship = relationships.get(relationshipId);
      const archivePath = relationship && /\/image$/i.test(relationship.type) ? safeRelationshipTarget(relationship.target) : null;
      const entry = archivePath ? entries.get(archivePath) : undefined;
      const mimeType = archivePath ? imageMimeType(archivePath) : null;
      if (!relationship || !archivePath || !entry || !mimeType) {
        warnings.push(`图片 ${relationshipId} 无法读取或格式不受支持。`);
        continue;
      }
      figures.push({
        key: `figure-${figures.length}`,
        sectionKey: isDirectory ? null : activeSection?.key ?? null,
        sourceBlockKey: blockKey,
        relationshipId,
        archivePath,
        originalName: path.posix.basename(archivePath),
        mimeType,
        bytes: entry.read(),
        caption: "",
        position: figures.length,
        width: extent.width,
        height: extent.height,
      });
      if (!["image/png", "image/jpeg", "image/gif", "image/webp", "image/svg+xml"].includes(mimeType)) {
        warnings.push(`图片 ${relationshipId} 已保留原文件，但 ${mimeType} 暂无浏览器预览。`);
      }
    }
    position++;
  }

  for (const figure of figures) {
    const figureBlock = blocks.find((block) => block.key === figure.sourceBlockKey);
    const nearby = blocks.filter((block) => block.position > (figureBlock?.position ?? -1) && block.position <= (figureBlock?.position ?? -1) + 2);
    const caption = nearby.find((block) => block.type === "CAPTION" || /^图\s*\d+/u.test(block.content));
    if (caption) {
      figure.caption = caption.content;
      figure.sourceBlockKey = caption.key;
      figure.sectionKey = caption.sectionKey ?? figure.sectionKey;
    }
  }

  const title = coreProperty(coreXml, "title")
    || blocks.find((block) => block.type === "TITLE" && block.metadata.isDirectory !== true)?.content
    || "未命名教材";
  const visibleParagraphs = blocks.filter((block) => block.metadata.isDirectory !== true && block.content);
  const authorLine = visibleParagraphs.slice(0, 12).find((block) => /(?:著|编著|主编|编)$/u.test(block.content) && block.content.length < 100)?.content ?? "";
  const author = authorLine.replace(/\s*(?:著|编著|主编|编)\s*$/u, "").trim() || coreProperty(coreXml, "creator");
  if (!sections.length) warnings.push("正文没有可识别的大纲标题，内容已保留为未分节原文。 ");
  if (!figures.length && /<[^>]*(?:drawing|pict)\b/i.test(documentXml)) warnings.push("文档包含绘图对象，但没有可复用的内嵌图片。 ");
  return { title, author, sections, blocks, figures, warnings };
}
