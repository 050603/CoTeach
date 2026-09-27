import { createHash } from "node:crypto";
import JSZip from "jszip";
import { htmlToDocxBlob } from "@platejs/docx-io";

export type DocumentConversionInput = { html: string; title: string; imageCount: number };
export type DocumentConversionOutput = { bytes: Uint8Array; sha256: string };
export async function convertDocument(input: DocumentConversionInput): Promise<DocumentConversionOutput> {
  const blob = await htmlToDocxBlob(input.html, {
    title: input.title, creator: "CoTeach", description: "项目实践最终成果", allowRemoteImages: false, orientation: "portrait",
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const zip = await JSZip.loadAsync(bytes).catch(() => null);
  if (!zip || !zip.file("word/document.xml")) throw Object.assign(new Error("Word 文件生成失败，请稍后重试。"), { code: "DOCX_INVALID" });
  const mediaCount = Object.entries(zip.files).filter(([name, entry]) => name.startsWith("word/media/") && !entry.dir).length;
  if (mediaCount < input.imageCount) throw Object.assign(new Error("Word 文件未完整包含文档图片，请重新提交。"), { code: "DOCX_INVALID" });
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
