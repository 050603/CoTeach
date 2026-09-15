import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { MediaGenerationRequest } from '@openmaic/lib/media/types';
import { parseJsonResponse } from '@openmaic/lib/generation/json-repair';
import { uniquifyMediaElementIds } from '@openmaic/lib/generation/scene-builder';

type PlannedMediaItem = {
  outlineId?: string;
  type?: 'image' | 'video';
  prompt?: string;
  /** Shared semantic key: repeated keys intentionally reuse one generated asset. */
  reuseKey?: string;
  aspectRatio?: MediaGenerationRequest['aspectRatio'];
  style?: string;
  duration?: number;
};

const RATIOS = new Set<MediaGenerationRequest['aspectRatio']>(['16:9', '4:3', '1:1', '9:16']);

function plannedMediaStyle(
  style: string | undefined,
  courseVisualDirection: string | undefined,
): string | undefined {
  const supplied = style?.trim();
  const direction = courseVisualDirection?.trim();
  if (supplied && direction && supplied.includes(direction)) return supplied;
  return [direction, supplied].filter(Boolean).join(' ') || undefined;
}

export function applyMediaPlanToOutlines(
  outlines: ReadonlyArray<SceneOutline>,
  rawPlan: unknown,
  options: { imageEnabled: boolean; videoEnabled: boolean },
): SceneOutline[] {
  const payload = Array.isArray(rawPlan)
    ? rawPlan
    : rawPlan && typeof rawPlan === 'object' && Array.isArray((rawPlan as { media?: unknown }).media)
      ? (rawPlan as { media: unknown[] }).media
      : [];
  const slideIds = new Set(outlines.filter((outline) => outline.type === 'slide').map((outline) => outline.id));
  let imageCount = 0;
  let videoCount = new Set(outlines.flatMap((outline) =>
    (outline.mediaGenerations ?? []).filter((item) => item.type === 'video').map((item) => item.elementId),
  )).size;
  const maxVideos = 2;
  const byOutline = new Map<string, MediaGenerationRequest[]>();
  const reusedMedia = new Map<string, MediaGenerationRequest>();

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as PlannedMediaItem;
    const outlineId = item.outlineId?.trim();
    const prompt = item.prompt?.trim();
    if (!outlineId || !slideIds.has(outlineId) || !prompt || prompt.length < 12) continue;
    const targetOutline = outlines.find((outline) => outline.id === outlineId);
    const existing = targetOutline?.mediaGenerations
      ?.filter((request) => request.type === 'image' ? options.imageEnabled : options.videoEnabled) ?? [];
    const planned = byOutline.get(outlineId) ?? [];
    if (existing.length + planned.length >= 2) continue;
    const reuseKey = `${item.type}:${item.reuseKey?.trim().toLocaleLowerCase() || prompt.toLocaleLowerCase()}`;
    const reused = reusedMedia.get(reuseKey);
    if (item.type === 'image') {
      if (!options.imageEnabled) continue;
      if (reused) {
        byOutline.set(outlineId, [...planned, reused]);
        continue;
      }
      imageCount += 1;
    } else if (item.type === 'video') {
      if (!options.videoEnabled) continue;
      if (reused) {
        byOutline.set(outlineId, [...planned, reused]);
        continue;
      }
      if (videoCount >= maxVideos) continue;
      videoCount += 1;
    } else {
      continue;
    }
    const media: MediaGenerationRequest = {
      type: item.type,
      prompt,
      elementId: item.type === 'image' ? `planned_img_${imageCount}` : `planned_vid_${videoCount}`,
      aspectRatio: RATIOS.has(item.aspectRatio) ? item.aspectRatio : '16:9',
      ...(item.type === 'video' && item.duration !== undefined ? { duration: item.duration } : {}),
      ...(plannedMediaStyle(item.style, targetOutline?.courseVisualDirection)
        ? { style: plannedMediaStyle(item.style, targetOutline?.courseVisualDirection) }
        : {}),
    };
    reusedMedia.set(reuseKey, media);
    byOutline.set(outlineId, [...planned, media]);
  }

  return uniquifyMediaElementIds(outlines.map((outline) => {
    const planned = byOutline.get(outline.id) ?? [];
    const existing = (outline.mediaGenerations ?? []).filter((item) =>
      item.type === 'image' ? options.imageEnabled : options.videoEnabled,
    ).map((item) => {
      const style = plannedMediaStyle(
        item.style,
        outline.courseVisualDirection,
      );
      return { ...item, ...(style ? { style } : {}) };
    });
    const mediaGenerations = [...existing, ...planned].slice(0, 2);
    return mediaGenerations.length ? { ...outline, mediaGenerations } : { ...outline, mediaGenerations: undefined };
  }));
}

export async function planMediaForConfirmedOutlines(
  outlines: ReadonlyArray<SceneOutline>,
  aiCall: AICallFn,
  options: {
    imageEnabled: boolean;
    videoEnabled: boolean;
    researchContext?: string;
  },
): Promise<SceneOutline[]> {
  if (!options.imageEnabled && !options.videoEnabled) return [...outlines];
  const candidates = outlines.filter((outline) => outline.type === 'slide').map((outline) => ({
    id: outline.id,
    title: outline.title,
    description: outline.description,
    keyPoints: outline.keyPoints,
    stageKey: outline.stageKey,
    audience: outline.audience,
    generationPurpose: outline.generationPurpose,
    courseVisualDirection: outline.courseVisualDirection,
    knowledgePointIds: outline.knowledgePointIds,
  }));
  if (candidates.length === 0) return [...outlines];
  const system = `You are an instructional media director optimizing learning quality. Decide whether static images or short videos materially improve understanding, without filling a quota. Permission to use a capability does not mean every page needs media. Prefer editable slide text, shapes, connectors, tables, charts, and formulas for abstract relationships, processes, comparisons, frameworks, and data. Request generated media only when visible appearance, spatial form, a real-world scene, or temporal motion is itself necessary evidence; a decorative metaphor is not enough. Every requested asset must carry an explicit instructional purpose and remain accurate to the confirmed course content. Video is only justified when motion or temporal change is essential. A courseVisualDirection already chosen by the page planner is authoritative; do not invent a second palette or art direction. Return JSON only.`;
  const user = `Available capabilities: image=${options.imageEnabled}, video=${options.videoEnabled}.

Choose media only for these existing slide IDs. Do not create, reorder, delete, or rename slides. Use at most two new media requests per slide and at most two videos for the entire course; there is no course-level image quota. Prefer verified source material when it already communicates the concept. Do not request generated media for a page merely because it contains a case: if the case can be explained by editable labels, relationships, or a small native diagram, return no media for that page. Prompts must stay within the listed knowledge and grade scope and use 16:9 unless another ratio is pedagogically necessary. Never request a dense table or matrix with many text cells from an image model; keep exact tables as native editable slide content. Do not make generated raster text the sole carrier of essential teaching content; the slide's editable text remains authoritative. If the same visual should recur across pages, give those entries the same concise reuseKey and the exact same prompt so it is generated once and reused. The application automatically prepends courseVisualDirection to the provider style; do not repeat it in style.

Slides:
${JSON.stringify(candidates)}

Optional verified research context:
${options.researchContext || 'None'}

Return {"media":[{"outlineId":"existing-id","type":"image|video","prompt":"specific generation prompt","aspectRatio":"16:9","style":"optional","reuseKey":"optional-shared-asset-key"}]}. Return an empty media array when no generated asset is necessary.`;
  const response = await aiCall(system, user);
  const parsed = parseJsonResponse<unknown>(response);
  return applyMediaPlanToOutlines(outlines, parsed, options);
}
