import type { SceneOutline } from "@/lib/openmaic/types/generation";

export const REVIEW_SOURCE_LIMIT = 60000;

/** Select relevant complete chunks, keep confirmed facts first, and disclose all omissions. */
export function selectReviewSource(source: string, outlines: readonly SceneOutline[], limit = REVIEW_SOURCE_LIMIT): {
  text: string; totalChars: number; selectedChars: number; partial: boolean;
} {
  if (source.length <= limit) return { text: source, totalChars: source.length, selectedChars: source.length, partial: false };
  const tokens = [...new Set(outlines.flatMap((outline) => [outline.title, ...(outline.keyPoints ?? []),
    ...(outline.teachingBrief?.evidence?.map((item) => item.quote) ?? [])]).flatMap((text) => text.split(/[\s，。；：、,.!?！？:;()（）]+/)).filter((text) => text.length >= 2))];
  const prefix = Math.min(8000, Math.floor(limit / 3));
  const chunks: Array<{ start: number; text: string; score: number }> = [];
  for (let start = prefix; start < source.length; start += 1800) {
    const text = source.slice(start, start + 1800);
    chunks.push({ start, text, score: tokens.reduce((sum, token) => sum + (text.includes(token) ? Math.min(token.length, 12) : 0), 0) });
  }
  let used = prefix;
  const selected = [{ start: 0, text: source.slice(0, prefix), score: Number.MAX_SAFE_INTEGER }];
  for (const chunk of chunks.sort((a, b) => b.score - a.score || a.start - b.start)) {
    if (used + chunk.text.length > limit) continue;
    selected.push(chunk); used += chunk.text.length;
  }
  return { text: selected.sort((a, b) => a.start - b.start).map((chunk) => `[原文位置 ${chunk.start + 1}–${chunk.start + chunk.text.length}]\n${chunk.text}`).join("\n\n"), totalChars: source.length, selectedChars: used, partial: true };
}
