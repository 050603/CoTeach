import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import sharp from "sharp";
import { prisma } from "@/lib/db/client";

const DATA_DIR = process.env.UPLOAD_DIR?.trim() || path.resolve(".openpbl-data", "uploads");
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const SAFE_TAGS = new Set([
  "p", "br", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "strong", "em", "u", "s", "mark", "sup", "sub", "code", "pre", "a", "figure", "figcaption", "img", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "ul", "ol", "li", "hr", "div", "span",
]);
const SAFE_ATTRS = new Set(["href", "target", "rel", "src", "alt", "title", "colspan", "rowspan", "class", "style", "data-list-style"]);
const BLOCKED_TAGS = /<\s*(script|iframe|object|embed|style|link|meta|base|form|input|button|svg)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;

export class ProjectDocumentArchiveError extends Error {
  constructor(
    public readonly code: "EXTERNAL_IMAGE" | "MISSING_IMAGE" | "IMAGE_TOO_LARGE" | "INVALID_DOCUMENT" | "DOCX_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "ProjectDocumentArchiveError";
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function safeStyle(value: string): string {
  if (/expression|url\s*\(|javascript:|behavior|binding/i.test(value)) return "";
  return value
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => /^(?:color|background-color|font-size|font-family|font-weight|font-style|text-decoration|text-align|line-height|margin-left|padding-left)\s*:/i.test(declaration))
    .join(";");
}

function sanitizeHtml(html: string): string {
  const withoutBlocked = html.replace(BLOCKED_TAGS, "");
  return withoutBlocked.replace(/<\s*(\/?)\s*([a-z0-9_-]+)([^>]*)>/gi, (full, slash: string, rawTag: string, rawAttrs: string) => {
    const tag = rawTag.toLowerCase();
    if (!SAFE_TAGS.has(tag)) return "";
    if (slash) return `</${tag}>`;
    const attrs: string[] = [];
    rawAttrs.replace(/([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g, (_match: string, rawName: string, doubleValue?: string, singleValue?: string, bareValue?: string) => {
      const name = rawName.toLowerCase();
      if (!SAFE_ATTRS.has(name)) return "";
      const value = doubleValue ?? singleValue ?? bareValue ?? "";
      if (name.startsWith("data-") && name !== "data-list-style") return "";
      if ((name === "href" || name === "src") && !/^(?:https?:|mailto:|\/|data:image\/(?:png|jpe?g|gif);base64,)/i.test(value)) return "";
      if (name === "style") {
        const style = safeStyle(value);
        if (style) attrs.push(`style="${escapeAttribute(style)}"`);
        return "";
      }
      attrs.push(`${name}="${escapeAttribute(value)}"`);
      return "";
    });
    return attrs.length ? `<${tag} ${attrs.join(" ")}>` : `<${tag}>`;
  });
}

function extractUploadId(value: string): string | null {
  try {
    const url = new URL(value, "http://openpbl.local");
    const match = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]{36})$/i);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function imageAsDataUri(input: {
  src: string;
  courseId: string;
  studentId: string;
}): Promise<{ dataUri: string; uploadId?: string }> {
  const uploadId = extractUploadId(input.src);
  let bytes: Buffer;
  let mimeType = "image/png";
  if (uploadId) {
    const participation = await prisma.classroomParticipation.findFirst({ where: { instanceId: input.courseId, enrollment: { userId: input.studentId } }, include: { enrollment: true } });
    const file = participation ? await prisma.fileAsset.findFirst({
      where: { id: uploadId, offeringId: participation.enrollment.offeringId, deletedAt: null },
      include: { uploadedBy: { select: { role: true } } },
    }) : null;
    if (!file || (file.uploadedBy.role.toLowerCase() === "student" && file.uploadedById !== input.studentId)) {
      throw new ProjectDocumentArchiveError("MISSING_IMAGE", "文档中有图片已失效或无权访问，请重新上传后再提交。" );
    }
    if (path.basename(file.storageKey) !== file.storageKey) {
      throw new ProjectDocumentArchiveError("MISSING_IMAGE", "文档图片路径无效，请重新上传后再提交。" );
    }
    try {
      bytes = await readFile(path.join(DATA_DIR, file.storageKey));
    } catch {
      throw new ProjectDocumentArchiveError("MISSING_IMAGE", "文档图片文件已丢失，请重新上传后再提交。");
    }
    mimeType = file.mimeType;
  } else if (/^data:image\/(png|jpe?g|gif);base64,/i.test(input.src)) {
    const [, encoded] = input.src.split(",", 2);
    bytes = Buffer.from(encoded, "base64");
    mimeType = input.src.slice(5, input.src.indexOf(";"));
  } else {
    throw new ProjectDocumentArchiveError("EXTERNAL_IMAGE", "Word 归档不允许引用外部图片，请先把图片上传到文档中。" );
  }
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new ProjectDocumentArchiveError("IMAGE_TOO_LARGE", "文档图片过大，请压缩后重新上传。" );
  }
  try {
    if (mimeType === "image/webp" || mimeType === "image/gif") {
      bytes = await sharp(bytes, { animated: false }).png().toBuffer();
      mimeType = "image/png";
    }
    if (!["image/png", "image/jpeg", "image/gif"].includes(mimeType)) {
      bytes = await sharp(bytes, { animated: false }).png().toBuffer();
      mimeType = "image/png";
    }
  } catch {
    throw new ProjectDocumentArchiveError("INVALID_DOCUMENT", "文档中的图片无法读取，请重新上传后再提交。");
  }
  return { dataUri: `data:${mimeType};base64,${bytes.toString("base64")}`, uploadId: uploadId ?? undefined };
}

export async function prepareProjectDocumentHtml(input: {
  html: string;
  courseId: string;
  studentId: string;
}): Promise<{ html: string; uploadIds: string[]; imageCount: number }> {
  const source = input.html.trim();
  if (!source) throw new ProjectDocumentArchiveError("INVALID_DOCUMENT", "文档为空，暂时不能提交。" );
  const uploadIds: string[] = [];
  let imageCount = 0;
  const withEmbeddedImages = await (async () => {
    const imagePattern = /<img\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi;
    let output = "";
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = imagePattern.exec(source))) {
      output += source.slice(cursor, match.index);
      const src = match[1] ?? match[2] ?? match[3] ?? "";
      const embedded = await imageAsDataUri({ src, courseId: input.courseId, studentId: input.studentId });
      output += match[0].replace(src, embedded.dataUri);
      if (embedded.uploadId) uploadIds.push(embedded.uploadId);
      imageCount += 1;
      cursor = match.index + match[0].length;
    }
    return output + source.slice(cursor);
  })();
  const html = sanitizeHtml(withEmbeddedImages);
  if (!html.replace(/<[^>]*>/g, "").trim() && imageCount === 0) {
    throw new ProjectDocumentArchiveError("INVALID_DOCUMENT", "文档没有可提交的内容。" );
  }
  return { html, uploadIds: [...new Set(uploadIds)], imageCount };
}

export async function buildProjectDocumentDocx(input: {
  html: string;
  courseId: string;
  studentId: string;
  title: string;
}): Promise<{ bytes: Buffer; sourceHtml: string; uploadIds: string[]; imageCount: number; sha256: string }> {
  const prepared = await prepareProjectDocumentHtml(input);
  // Keep the browser-oriented docx converter out of module initialization so
  // server routes and pure archive validation remain importable in test/edge
  // tooling that does not provide virtual-dom's Node export map.
  const { htmlToDocxBlob } = await import("@platejs/docx-io");
  const blob = await htmlToDocxBlob(prepared.html, {
    title: input.title,
    creator: "CoTeach",
    description: "项目实践最终成果",
    allowRemoteImages: false,
    orientation: "portrait",
  });
  const bytes = Buffer.from(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(bytes).catch(() => null);
  if (!zip || !zip.file("word/document.xml")) {
    throw new ProjectDocumentArchiveError("DOCX_INVALID", "Word 文件生成失败，请稍后重试。" );
  }
  const mediaCount = Object.entries(zip.files).filter(([name, entry]) =>
    name.startsWith("word/media/") && !entry.dir
  ).length;
  if (mediaCount < prepared.imageCount) {
    throw new ProjectDocumentArchiveError("DOCX_INVALID", "Word 文件未完整包含文档图片，请重新提交。" );
  }
  return {
    bytes,
    sourceHtml: prepared.html,
    uploadIds: prepared.uploadIds,
    imageCount: prepared.imageCount,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
