import type { AICallFn } from '@openmaic/lib/generation/pipeline-types';
import type { SceneOutline } from '@openmaic/lib/types/generation';
import type { MediaGenerationRequest } from '@openmaic/lib/media/types';
import { parseJsonResponse } from '@openmaic/lib/generation/json-repair';
import { uniquifyMediaElementIds } from '@openmaic/lib/generation/scene-builder';

type PlannedMediaItem = {
  outlineId?: string;
  type?: 'image' | 'video';
  prompt?: string;
  aspectRatio?: MediaGenerationRequest['aspectRatio'];
  style?: string;
};

const RATIOS = new Set<MediaGenerationRequest['aspectRatio']>(['16:9', '4:3', '1:1', '9:16']);

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
  let videoCount = 0;
  const maxImages = Math.max(1, Math.ceil(slideIds.size / 3));
  const maxVideos = Math.min(2, Math.max(1, Math.floor(slideIds.size / 8)));
  const byOutline = new Map<string, MediaGenerationRequest[]>();
  const usedOutlineIds = new Set(
    outlines
      .filter((outline) => (outline.mediaGenerations ?? []).some((item) =>
        item.type === 'image' ? options.imageEnabled : options.videoEnabled,
      ))
      .map((outline) => outline.id),
  );

  for (const raw of payload) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as PlannedMediaItem;
    const outlineId = item.outlineId?.trim();
    const prompt = item.prompt?.trim();
    if (!outlineId || !slideIds.has(outlineId) || usedOutlineIds.has(outlineId) || !prompt || prompt.length < 12) continue;
    if (item.type === 'image') {
      if (!options.imageEnabled || imageCount >= maxImages) continue;
      imageCount += 1;
    } else if (item.type === 'video') {
      if (!options.videoEnabled || videoCount >= maxVideos) continue;
      videoCount += 1;
    } else {
      continue;
    }
    const media: MediaGenerationRequest = {
      type: item.type,
      prompt,
      elementId: item.type === 'image' ? `planned_img_${imageCount}` : `planned_vid_${videoCount}`,
      aspectRatio: RATIOS.has(item.aspectRatio) ? item.aspectRatio : '16:9',
      ...(item.style?.trim() ? { style: item.style.trim() } : {}),
    };
    byOutline.set(outlineId, [media]);
    usedOutlineIds.add(outlineId);
  }

  return uniquifyMediaElementIds(outlines.map((outline) => {
    const planned = byOutline.get(outline.id) ?? [];
    const existing = (outline.mediaGenerations ?? []).filter((item) =>
      item.type === 'image' ? options.imageEnabled : options.videoEnabled,
    );
    const mediaGenerations = [...existing, ...planned].slice(0, 1);
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
    knowledgePointIds: outline.knowledgePointIds,
  }));
  if (candidates.length === 0) return [...outlines];
  const system = `You are a conservative instructional media planner. Decide whether a static generated image or a short generated video materially improves understanding. Permission to use a capability does not mean every page needs media. Never add decorative filler. Every requested asset must carry an explicit instructional purpose and remain accurate to the confirmed course content. Video is only justified when motion or temporal change is essential. Return JSON only.`;
  const user = `Available capabilities: image=${options.imageEnabled}, video=${options.videoEnabled}.

Choose media only for these existing slide IDs. Do not create, reorder, delete, or rename slides. Use at most one request per slide, images on no more than roughly one third of slides, and at most two videos for the entire course. Prompts must stay within the listed knowledge and grade scope, use 16:9 unless another ratio is pedagogically necessary, and request Chinese labels when text is needed. For comparisons, processes, or other factual diagrams, enumerate the exact labels, ordering, and relationships in the prompt and explicitly forbid invented facts. Never request a dense table or matrix with many text cells from an image model; keep exact tables as native editable slide content and use at most a sparse relationship illustration as supporting media. Do not make generated raster text the sole carrier of essential teaching content; the slide's editable text remains authoritative.

Slides:
${JSON.stringify(candidates)}

Optional verified research context:
${options.researchContext || 'None'}

Return {"media":[{"outlineId":"existing-id","type":"image|video","prompt":"specific generation prompt","aspectRatio":"16:9","style":"optional"}]}. Return an empty media array when no generated asset is necessary.`;
  const response = await aiCall(system, user);
  const parsed = parseJsonResponse<unknown>(response);
  return applyMediaPlanToOutlines(outlines, parsed, options);
}
