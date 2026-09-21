import { createHash } from "node:crypto";
import type { ParsedTextbookBlock, ParsedTextbookSection, TextbookRetrievalChunk } from "./types";

export function normalizeTextbookText(value: string): string {
  return value.normalize("NFKC").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/\s+/g, " ").trim();
}

export function normalizeConceptName(value: string): string {
  return normalizeTextbookText(value).toLocaleLowerCase("zh-CN").replace(/[\s，。！？、；：,.!?;:'“”‘’()（）【】\[\]《》<>—_-]+/g, "");
}

/**
 * PostgreSQL `simple` tokenization does not segment Chinese. Emit CJK bigrams
 * plus ordinary latin/number terms so a GIN tsvector can index both reliably.
 */
export function chineseSearchTokens(value: string): string[] {
  const normalized = normalizeTextbookText(value).toLocaleLowerCase("zh-CN");
  const tokens = new Set<string>();
  for (const term of normalized.match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g) ?? []) tokens.add(term);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) ?? []) {
    const chars = Array.from(run);
    if (chars.length === 1) tokens.add(chars[0]);
    for (let index = 0; index < chars.length - 1; index++) tokens.add(chars[index] + chars[index + 1]);
  }
  return [...tokens];
}

export function textbookSearchTokenText(value: string): string {
  return chineseSearchTokens(value).join(" ");
}

function splitLongText(value: string, maximum: number): string[] {
  if (value.length <= maximum) return [value];
  const sentences = value.split(/(?<=[。！？!?；;])\s*/u).filter(Boolean);
  const parts: string[] = [];
  let current = "";
  for (const sentence of sentences.length ? sentences : [value]) {
    if (sentence.length > maximum) {
      if (current) parts.push(current);
      current = "";
      for (let start = 0; start < sentence.length; start += maximum) parts.push(sentence.slice(start, start + maximum));
    } else if (current && current.length + sentence.length > maximum) {
      parts.push(current);
      current = sentence;
    } else current += sentence;
  }
  if (current) parts.push(current);
  return parts;
}

export function buildRetrievalChunks(
  blocks: ParsedTextbookBlock[],
  sections: ParsedTextbookSection[],
  options: { targetCharacters?: number; maximumCharacters?: number } = {},
): TextbookRetrievalChunk[] {
  const target = options.targetCharacters ?? 1_000;
  const maximum = Math.max(target, options.maximumCharacters ?? 1_200);
  const sectionTitles = new Map(sections.map((section) => [section.key, section.path]));
  const chunks: TextbookRetrievalChunk[] = [];
  let current: { sectionKey: string | null; contents: string[]; keys: string[]; position: number } | null = null;
  const flush = () => {
    if (!current?.contents.length) return;
    const content = current.contents.join("\n");
    const position = current.position;
    chunks.push({
      key: `chunk-${position}-${createHash("sha256").update(content).digest("hex").slice(0, 12)}`,
      sectionKey: current.sectionKey,
      sourceBlockKeys: current.keys,
      kind: "SOURCE_BLOCK",
      title: current.sectionKey ? sectionTitles.get(current.sectionKey) ?? null : null,
      content,
      searchTokens: textbookSearchTokenText(`${sectionTitles.get(current.sectionKey ?? "") ?? ""} ${content}`),
      position,
    });
    current = null;
  };
  for (const block of blocks) {
    if (!block.content || block.metadata.isDirectory === true) continue;
    if (block.type === "TITLE" || block.type === "HEADING") { flush(); continue; }
    for (const part of splitLongText(block.content, maximum)) {
      if (current && (current.sectionKey !== block.sectionKey || current.contents.join("\n").length + part.length > maximum)) flush();
      current ??= { sectionKey: block.sectionKey, contents: [], keys: [], position: block.position };
      current.contents.push(part);
      current.keys.push(block.key);
      if (current.contents.join("\n").length >= target) flush();
    }
  }
  flush();
  return chunks;
}
