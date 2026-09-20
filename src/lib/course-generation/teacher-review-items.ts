import { createHash } from "node:crypto";

import type { TeacherReviewItem } from "@/lib/course-quality-review/types";
import type { SceneOutline } from "@/lib/openmaic/types/generation";
import type { Scene } from "@/lib/openmaic/types/stage";

function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/\s+/g, " ").trim();
}

function stableReviewId(kind: TeacherReviewItem["kind"], content: string): string {
  return `teacher-review-${kind}-${createHash("sha256").update(content).digest("hex").slice(0, 12)}`;
}

function normalizedKey(item: TeacherReviewItem): string {
  return `${item.kind}:${item.content.replace(/\s+/g, " ").trim().toLocaleLowerCase()}`;
}

export function mergeTeacherReviewItems(items: readonly TeacherReviewItem[]): TeacherReviewItem[] {
  const merged = new Map<string, TeacherReviewItem>();
  for (const item of items) {
    if (!item.content.trim() || !item.teachingPurpose.trim() || item.provenance === "course-source") continue;
    const key = normalizedKey(item);
    const previous = merged.get(key);
    merged.set(key, previous ? {
      ...previous,
      sectionId: previous.sectionId ?? item.sectionId,
      outlineId: previous.outlineId ?? item.outlineId,
      sceneId: previous.sceneId ?? item.sceneId,
      elementId: previous.elementId ?? item.elementId,
      narrationSegmentId: previous.narrationSegmentId ?? item.narrationSegmentId,
      source: previous.source ?? item.source,
      values: [...new Map([...(previous.values ?? []), ...(item.values ?? [])]
        .map((value) => [`${value.label ?? ""}:${value.value}:${value.unit ?? ""}`, value])).values()],
      comparisonObjects: [...new Set([...(previous.comparisonObjects ?? []), ...(item.comparisonObjects ?? [])])],
    } : { ...item, id: item.id || stableReviewId(item.kind, item.content) });
  }
  return [...merged.values()];
}

function numericClaims(text: string): string[] {
  return [...new Set(text.match(/(?:\d+(?:\.\d+)?\s*%|\d+(?:\.\d+)?\s*(?:倍|个百分点|人|次|分钟|秒|小时))/g) ?? [])]
    .filter((claim) => !/^\d+\s*(?:分钟|秒|小时)$/.test(claim));
}

function numericValue(claim: string): NonNullable<TeacherReviewItem["values"]>[number] {
  const match = claim.match(/^(\d+(?:\.\d+)?)\s*(%|倍|个百分点|人|次|分钟|秒|小时)?$/);
  return match ? { value: match[1]!, ...(match[2] ? { unit: match[2] } : {}) } : { value: claim };
}

function chartReviewValues(value: unknown): NonNullable<TeacherReviewItem["values"]> {
  const result: NonNullable<TeacherReviewItem["values"]> = [];
  const visit = (candidate: unknown, label?: string) => {
    if (result.length >= 100) return;
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      result.push({ value: String(candidate), ...(label ? { label } : {}) });
    } else if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, label ? `${label}[${index + 1}]` : String(index + 1)));
    } else if (candidate && typeof candidate === "object") {
      Object.entries(candidate as Record<string, unknown>).forEach(([key, item]) => visit(item, key));
    }
  };
  visit(value);
  return result;
}

/**
 * Backstop for concrete numbers added by the slide or narration model after
 * blueprint planning. It is deliberately non-blocking and teacher-private.
 */
export function collectGeneratedTeacherReviewItems(input: {
  outlines: readonly SceneOutline[];
  scenes: readonly Scene[];
}): TeacherReviewItem[] {
  const outlineById = new Map(input.outlines.map((outline) => [outline.id, outline]));
  const planned = input.outlines.flatMap((outline) => outline.teachingBrief?.reviewItems ?? []);
  const discovered: TeacherReviewItem[] = [];

  for (const scene of input.scenes) {
    const outline = outlineById.get(scene.outlineId ?? "");
    const evidenceText = (outline?.teachingBrief?.evidence ?? []).map((item) => item.quote).join(" ");
    const knownText = (outline?.teachingBrief?.reviewItems ?? []).map((item) => item.content).join(" ");
    const inspect = (text: string, location: Pick<TeacherReviewItem, "elementId" | "narrationSegmentId"> = {}) => {
      for (const claim of numericClaims(text)) {
        if (evidenceText.includes(claim) || knownText.includes(claim)) continue;
        discovered.push({
          id: stableReviewId("illustrative-data", `${scene.id}:${claim}`),
          kind: "illustrative-data",
          provenance: "unverified",
          content: `页面或讲稿中使用了具体数值“${claim}”，当前生成依据中没有找到对应来源。`,
          teachingPurpose: `用于《${scene.title}》中的直观说明、比较或计算。`,
          values: [numericValue(claim)],
          comparisonObjects: [scene.title],
          sectionId: outline?.lectureSectionId ?? outline?.parentActivityId,
          outlineId: outline?.id,
          sceneId: scene.id,
          ...location,
        });
      }
    };

    if (scene.content.type === "slide") {
      for (const element of scene.content.canvas.elements) {
        const record = element as unknown as Record<string, unknown>;
        if (element.type === "text" && typeof record.content === "string") {
          inspect(plainText(record.content), { elementId: element.id });
        }
        if (element.type === "chart") {
          const data = record.data;
          const serialized = JSON.stringify(data);
          if (/\d/.test(serialized) && !knownText.includes(serialized) && !evidenceText.includes(serialized)) {
            const values = chartReviewValues(data);
            const chartData = data && typeof data === "object" && !Array.isArray(data)
              ? data as Record<string, unknown> : {};
            const comparisonObjects = [...new Set([
              ...(Array.isArray(chartData.labels) ? chartData.labels : []),
              ...(Array.isArray(chartData.legends) ? chartData.legends : []),
            ].flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : []))];
            discovered.push({
              id: stableReviewId("illustrative-data", `${scene.id}:${element.id}:${serialized}`),
              kind: "illustrative-data",
              provenance: "unverified",
              content: `《${scene.title}》中的图表包含生成数值：${serialized.slice(0, 500)}。`,
              teachingPurpose: "用图表帮助学生直观比较数量、比例或趋势。",
              ...(values.length ? { values } : {}),
              ...(comparisonObjects.length ? { comparisonObjects } : {}),
              sectionId: outline?.lectureSectionId ?? outline?.parentActivityId,
              outlineId: outline?.id,
              sceneId: scene.id,
              elementId: element.id,
            });
          }
        }
      }
    }
    for (const action of scene.actions ?? []) {
      if (action.type === "speech" && action.text.trim()) {
        inspect(action.text, { narrationSegmentId: action.id });
      }
    }
  }
  return mergeTeacherReviewItems([...planned, ...discovered]);
}

export function teacherReviewSummary(items: readonly TeacherReviewItem[]): string {
  if (!items.length) return "本次生成未发现需要额外确认的构造数据、构造案例或来源待核实主张。";
  const lines = items.map((item, index) => {
    const location = item.outlineId ? `（页面：${item.outlineId}）` : "";
    const source = item.source ? ` 已有来源线索：${item.source}` : " 当前资料未提供可核对出处。";
    return `${index + 1}. ${item.content}${location}${source}`;
  });
  return `本次课程有 ${items.length} 项内容建议授课前确认：\n${lines.join("\n")}`;
}
