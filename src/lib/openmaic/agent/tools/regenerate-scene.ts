/**
 * `regenerate_scene` agent tool
 *
 * Regenerates a slide's native visual composition. Knowledge-teaching slides
 * keep saved narration/audio and rebind only visual addresses; other slides
 * retain the existing content-and-actions behavior.
 * Content generation stays isolated from StageStore writes. Knowledge-teaching
 * redraw uses the restored native adapter; legacy slide types retain the two
 * content/actions steps.
 *
 * Trust boundary (carries the v0 rule): the model supplies only `sceneId` +
 * `instruction`. The slide's current content/outline come from the trusted
 * client-injected `SceneContext` (`getSceneContext`) and are fed as the edit
 * baseline — the agent model cannot supply a replacement scene payload.
 *
 * slide-only this release: non-slide scenes get a typed refusal and nothing is
 * generated.
 *
 * Returns `{ sceneId, content, actions }` in `details`; the client reads
 * `tool_execution_end`, snapshots the pre-state, and applies content+actions.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { generateSceneContent, generateSceneActions } from '@openmaic/lib/generation/scene-generator';
import { buildNarrationContext } from '@openmaic/lib/generation/narration-continuity';
import type { Action } from '@openmaic/lib/types/action';
import type { GeneratedSlideContent, PdfImage, ImageMapping } from '@openmaic/lib/types/generation';
import type { SceneContent } from '@openmaic/lib/types/stage';
import type { RegenerateActionsDeps, SceneContext } from './regenerate-scene-actions';
import { withTeachingEnhancement } from '@openmaic/lib/generation/teaching-enhancement';
import { generateOpenMaicBaselineContent } from '@openmaic/lib/generation/openmaic-baseline';
import { usesRestoredSlideAuthoring } from '@openmaic/lib/generation/restored-slide-authoring';
import { measureAuthoredSlideText } from '@openmaic/lib/generation/slide-spatial-measurement';
import { rebindSlideVisualActions } from './rebind-slide-visual-actions';
import type { SlideVisualPatch } from './slide-visual-patch';
import {
  canUseIndependentTeachingNarration,
  compileTeachingNarrationActions,
  generateTeachingSectionNarration,
  restoreTeachingSemanticElementIds,
  withTeachingSlideGuidance,
} from '@openmaic/lib/generation/teaching-narration';

// ── Runtime SlideContent → generation GeneratedSlideContent (edit baseline) ──
// The client sends runtime `SceneContent` ({ type:'slide', canvas: Slide }); the
// generator's edit baseline wants the generation shape ({ elements, background }).
function slideBaseline(content: SceneContent): GeneratedSlideContent | undefined {
  if (content.type !== 'slide') return undefined;
  return {
    elements: content.canvas.elements ?? [],
    background: content.canvas.background,
    theme: content.canvas.theme,
    displayItems: content.canvas.displayItems,
    contentBindings: content.canvas.contentBindings,
    presentationProjection: content.canvas.presentationProjection,
    qualityDiagnostics: (content.canvas as { qualityDiagnostics?: string[] }).qualityDiagnostics,
  } satisfies GeneratedSlideContent;
}

// ── Existing media → generator RESOURCES (assignedImages + imageMapping) ──────
// Root-cause fix: instead of trying to PRESERVE existing images across the
// round-trip (impossible — `generateSlideContent` re-mints every element id), we
// FEED existing images to the generator as resources, the same channel
// course-generation uses. Each real image src is registered as `img_N` in
// `imageMapping` and described (NOT base64) in `assignedImages`; the baseline
// handed to the prompt carries the small id-ref instead of the payload. The
// model references images by id; `resolveImageIds` (scene-generator) resolves
// `img_N` back to the real src. No base64 in the prompt, no reliance on echo.

/** True when a src is a real image payload (data: URL or http(s) URL). */
function isRealImageSrc(src: unknown): src is string {
  if (typeof src !== 'string') return false;
  return src.startsWith('data:') || src.startsWith('http://') || src.startsWith('https://') || src.startsWith('/');
}

/**
 * Walk the baseline's image elements and lift their real srcs into resources:
 * - register each real src as `img_N` in `imageMapping`,
 * - describe it (by id, not base64) in `assignedImages`,
 * - rewrite the baseline element's `src` to the small `img_N` id-ref.
 * Already-id-ref image elements are mapped through if we know the src (we don't,
 * so they're left as-is — `resolveImageIds` will drop unmapped ones, matching
 * existing behavior). Non-image elements (incl. video/audio) are untouched.
 * Pure: returns a new baseline + resources, does not mutate inputs.
 */
export function buildImageResources(baseline: GeneratedSlideContent): {
  baseline: GeneratedSlideContent;
  assignedImages: PdfImage[];
  imageMapping: ImageMapping;
} {
  const assignedImages: PdfImage[] = [];
  const imageMapping: ImageMapping = {};
  const reservedIds = new Set(baseline.contentBindings?.filter((binding) => binding.sourceContentId.startsWith('image:'))
    .map((binding) => binding.sourceContentId.slice('image:'.length)));
  let n = 0;

  const elements = baseline.elements.map((el) => {
    if (!el || el.type !== 'image') return el;
    const src = (el as { src?: unknown }).src;
    if (isRealImageSrc(src)) {
      // Preserve saved evidence identity when present; coordinates/element IDs
      // are not a source identity. The alias is only a transport resource key.
      const sources = [...new Set(baseline.contentBindings?.filter((binding) => binding.elementId === el.id
        && binding.sourceContentId.startsWith('image:') && !binding.sourceContentId.endsWith(':caption'))
        .map((binding) => binding.sourceContentId.slice('image:'.length)))];
      let imgId = sources.length === 1 ? sources[0] : undefined;
      if (!imgId) {
        do { imgId = `img_${++n}`; } while (reservedIds.has(imgId));
      }
      if (imageMapping[imgId] && imageMapping[imgId] !== src) {
        throw new Error(`Conflicting saved image identity ${imgId}`);
      }
      const existing = imageMapping[imgId];
      imageMapping[imgId] = src;
      if (!existing) assignedImages.push({
        id: imgId,
        src,
        pageNumber: 0,
        width: (el as { width?: number }).width,
        height: (el as { height?: number }).height,
        description: 'Existing slide image',
        required: true,
      });
      return { ...el, src: imgId };
    }
    // Already an id-ref (or otherwise non-real src): keep as-is.
    return el;
  });

  return {
    baseline: { ...baseline, elements },
    assignedImages,
    imageMapping,
  };
}

/**
 * True when a slide-level background is a real image background (DSL
 * `SlideBackground` with `type === 'image'` and a real `image.src`). Used to
 * narrow-refuse image-background slides: the pipeline can't resolve background
 * image ids through the resource channel (only element images flow there).
 */
function isImageBackground(background: GeneratedSlideContent['background']): boolean {
  return background?.type === 'image' && isRealImageSrc(background.image?.src);
}

// ── Params (trust boundary: only id + instruction; content comes from deps) ──

export const RegenerateSceneParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the slide to regenerate. Use the id of the current scene shown in the system prompt.',
  }),
  instruction: Type.Optional(
    Type.String({
      description:
        "The user's instruction for how to change the slide, in natural language " +
        '(e.g. "condense to 3 bullet points", "add a real-world example", "make the title punchier"). ' +
        'Do NOT include slide content here — the current slide is loaded automatically as the baseline.',
    }),
  ),
});

export type RegenerateSceneParams = Static<typeof RegenerateSceneParams>;

// ── Details returned to the client ───────────────────────────────────────────

export interface RegenerateSceneDetails {
  sceneId: string;
  content: GeneratedSlideContent | null;
  actions: Action[];
  visualPatch?: SlideVisualPatch;
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeRegenerateSceneTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof RegenerateSceneParams, RegenerateSceneDetails> {
  return {
    name: 'regenerate_scene',
    label: 'Regenerate slide',
    description:
      'Regenerates slide text/layout/images to match the user instruction. Knowledge-teaching slides preserve all saved narration, audio, whiteboards and other actions, rebinding only visual targets. ' +
      'Use regenerate_scene_actions separately when the teacher explicitly requests narration changes. Other slides retain content-and-narration regeneration. ' +
      'Only works on slide scenes. Supply the sceneId and a natural-language instruction; ' +
      'the current slide is loaded automatically as the editing baseline.',
    parameters: RegenerateSceneParams,

    execute: async (_toolCallId, params, signal) => {
      const { sceneId, instruction } = params;

      const ctxData: SceneContext | undefined = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}. Cannot regenerate the slide.`,
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      const { outline, allOutlines, content, stageId, agents, languageDirective } = ctxData;
      void stageId;

      // slide-only this release — refuse non-slide outlines AND any scene whose
      // injected content isn't a slide (guards against scene-type desync between
      // the outline and the actual content payload).
      if (outline.type !== 'slide' || content.type !== 'slide') {
        return {
          content: [
            {
              type: 'text',
              text:
                `Cannot regenerate this scene: regenerating the whole scene is only supported ` +
                `for slides yet (this scene is not a slide). Suggest the user edits it on the canvas.`,
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      // Narrow refusal (this release): whole-slide regeneration can't preserve a
      // video element or a slide-level image background through the resource
      // channel (only element images flow as resources, and background image ids
      // can't be resolved), so refuse rather than silently dropping them. Element
      // images are fine. (Audio is never a canvas element — narration audio lives
      // in the actions/speech layer — so there's nothing to gate there.)
      const slideElements = content.canvas.elements ?? [];
      const hasVideoElement = slideElements.some((el) => el?.type === 'video');
      const hasImageBackground = isImageBackground(content.canvas.background);
      const visualOnly = usesRestoredSlideAuthoring(outline);
      if (!visualOnly && (hasVideoElement || hasImageBackground)) {
        return {
          content: [
            {
              type: 'text',
              text:
                'This slide contains a video or an image background; whole-slide ' +
                "regeneration isn't supported for those yet — please edit it on the canvas.",
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }

      // Self-contained black box: slide content resolves the `scene-content:slide`
      // stage model and actions resolve `scene-actions` — the same routes the
      // course-generation path uses — independent of the agent conversation model.
      const contentAiCall = (
        systemPrompt: string,
        userPrompt: string,
        images?: Array<{ id: string; src: string }>,
      ): Promise<string> => deps.aiCall('scene-content:slide', systemPrompt, userPrompt, signal, images);
      const actionsAiCall = (
        systemPrompt: string,
        userPrompt: string,
        _images?: Array<{ id: string; src: string }>,
      ): Promise<string> => deps.aiCall('scene-actions', systemPrompt, userPrompt, signal);

      // ── Step 1: regenerate slide content in EDIT MODE ──────────────────────
      // Lift existing images into the generator's resource channel: the baseline
      // handed to the prompt carries small `img_N` id-refs (no base64), and
      // assignedImages/imageMapping let `resolveImageIds` rehydrate the real srcs.
      const slideBase = slideBaseline(content)!;
      const {
        baseline: editBaseline,
        assignedImages,
        imageMapping,
      } = buildImageResources(slideBase);

      if (visualOnly) {
        const visualPatch: SlideVisualPatch = {
          beforeContent: structuredClone(content), beforeActions: structuredClone(ctxData.actions ?? []),
        };
        const manuscriptRefs = outline.teachingBrief?.manuscript;
        const manuscript = ctxData.teachingManuscripts?.find((item) => item.sectionId === manuscriptRefs?.sectionId);
        const savedSpeech = visualPatch.beforeActions.filter((action) => action.type === 'speech')
          .map((action) => ({ id: action.id, text: action.text }));
        const generated = await generateOpenMaicBaselineContent(outline, (system, prompt, images) => contentAiCall(
          `${system}\n\nPPT-only redraw: preserve the current teaching responsibilities, original facts, all existing media identities and complete diagram relationships. Saved speech is context, not a display obligation. Do not author narration, questions, audio or media.`,
          `${prompt}\n\n## Saved narration context (unchanged)\n${JSON.stringify({
            currentSpeech: savedSpeech, sectionNarrations: ctxData.sectionNarrations,
            manuscript: manuscript ? { sectionId: manuscript.sectionId, segments: manuscript.segments.filter((segment) =>
              manuscriptRefs?.segmentIds.includes(segment.id)) } : undefined,
          })}`, images), {
          componentAuthoring: true, slideAuthoring: 'native', textMeasure: measureAuthoredSlideText,
          agents, languageDirective, editDirective: instruction, baselineContent: editBaseline,
          visualBaseline: slideBase, assignedImages, imageMapping, visionEnabled: true,
          sourceEvidence: ctxData.sourceEvidence, sourceKnowledgePoints: ctxData.sourceKnowledgePoints,
          teachingAuthoringKnowledge: ctxData.teachingAuthoringKnowledge,
          sourceSequenceContracts: ctxData.sourceSequenceContracts,
          websiteReferenceContext: { slideTitles: allOutlines.filter((page) => page.type === 'slide').map((page) => page.title) },
        });
        if (!generated || !('elements' in generated)) return {
          content: [{ type: 'text', text: `Slide content generation failed for "${outline.title}". The saved slide and narration have not been changed.` }],
          details: { sceneId, content: null, actions: [] }, isError: true,
        };
        if (deps.assertCurrentSources && !await deps.assertCurrentSources()) return {
          content: [{ type: 'text', text: 'The adopted course sources or manuscript changed during this PPT request. The saved slide and narration have not been changed; redraw using the current confirmed sources.' }],
          details: { sceneId, content: null, actions: [] }, isError: true,
        };
        // play_video is a saved synchronous action. Keep its address by giving
        // the same unique media object its saved ID, without changing the action
        // or the author's new geometry. Ambiguity retains the original draft.
        const videoAddressDiagnostics: string[] = [];
        let generatedSlide: GeneratedSlideContent = generated;
        let retainedDraft = generated.elements === slideBase.elements;
        for (const action of visualPatch.beforeActions) {
          if (action.type !== 'play_video') continue;
          const original = slideBase.elements.find((element) => element.id === action.elementId);
          if (original?.type !== 'video') continue;
          const matches = generatedSlide.elements.filter((element) => element.type === 'video'
            && element.src === original.src && element.mediaRef === original.mediaRef);
          if (matches.length !== 1 || generatedSlide.elements.some((element) => element.id === original.id && element !== matches[0])) {
            videoAddressDiagnostics.push(`PPT redraw video ${original.id}: no unique saved playback media target; retained the saved usable draft.`);
            continue;
          }
          const previousId = matches[0].id;
          generatedSlide = { ...generatedSlide, elements: generatedSlide.elements.map((element) => element === matches[0]
            ? { ...element, id: original.id } : element), contentBindings: generatedSlide.contentBindings?.map((binding) =>
              binding.elementId === previousId ? { ...binding, elementId: original.id } : binding) };
        }
        const missingMedia = slideBase.elements.filter((element) => element.type === 'image' || element.type === 'video')
          .filter((element) => !generatedSlide.elements.some((next) => (next.type === 'image' || next.type === 'video') && next.type === element.type
            && next.src === element.src && (element.type !== 'video' || next.type === 'video' && next.mediaRef === element.mediaRef)));
        const mediaDiagnostics = missingMedia.map((element) => `PPT redraw omitted saved media ${element.id}; retained the saved usable draft.`);
        retainedDraft ||= Boolean(missingMedia.length || videoAddressDiagnostics.length);
        let next: GeneratedSlideContent = missingMedia.length || videoAddressDiagnostics.length ? { ...slideBase,
          qualityDiagnostics: [...new Set([...(generatedSlide.qualityDiagnostics ?? []), ...mediaDiagnostics, ...videoAddressDiagnostics])] } : generatedSlide;
        // A source image used as the canvas background remains the same media.
        if (hasImageBackground) next = { ...next, background: slideBase.background };
        const rebound = rebindSlideVisualActions({ outline, before: slideBase, after: next, actions: visualPatch.beforeActions });
        const actions = rebound.essentialUnresolved ? visualPatch.beforeActions : rebound.actions;
        retainedDraft ||= rebound.essentialUnresolved;
        if (rebound.essentialUnresolved) next = { ...slideBase,
          qualityDiagnostics: [...new Set([...(next.qualityDiagnostics ?? []), ...rebound.diagnostics])] };
        else next = { ...next, qualityDiagnostics: [...new Set([...(next.qualityDiagnostics ?? []), ...rebound.diagnostics])] };
        const diagnoses = next.qualityDiagnostics?.length
          ? ` Quality diagnostics: ${next.qualityDiagnostics.join('; ')}` : '';
        return {
          content: [{ type: 'text', text: `${retainedDraft ? 'Retained the saved usable PPT after a redraw diagnosis' : 'Regenerated the PPT'} (${next.elements.length} elements); saved narration, audio and other teaching actions are preserved.${diagnoses}` }],
          details: { sceneId, content: next, actions, visualPatch },
        };
      }

      let rawSlideResponse = '';
      const teachingContentCall = withTeachingSlideGuidance(
        withTeachingEnhancement(contentAiCall, outline, 'content'),
        outline,
        (response) => { rawSlideResponse = response; },
      );
      const generatedContent = await generateSceneContent(outline, teachingContentCall, {
        agents,
        languageDirective,
        editDirective: instruction,
        baselineContent: editBaseline,
        assignedImages,
        imageMapping,
      });

      if (!generatedContent || !('elements' in generatedContent)) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Warning: slide content generation failed for "${outline.title}". ` +
                `The slide has NOT been changed.`,
            },
          ],
          details: { sceneId, content: null, actions: [] },
          isError: true,
        };
      }
      const newContent = restoreTeachingSemanticElementIds(generatedContent, rawSlideResponse, outline);

      // The generator returns solid/gradient backgrounds; image-background slides
      // were refused above, so the returned background is kept as-is.

      // ── Step 2: regenerate actions to match the new content ────────────────
      const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
      const ctx = buildNarrationContext(allOutlines, pageIndex >= 0 ? pageIndex : 0);

      let actions: Action[];
      if (canUseIndependentTeachingNarration(outline)) {
        const narration = await generateTeachingSectionNarration({
          sectionId: outline.lectureSectionId || outline.parentActivityId || outline.activityId || '__single_page__',
          pages: [{ outline, content: newContent }],
          requirements: { requirement: instruction?.trim() || outline.description },
          languageDirective,
          courseProgression: allOutlines,
          agents,
          aiCall: actionsAiCall,
        });
        const compiled = compileTeachingNarrationActions({
          outline,
          content: newContent,
          narration: narration.pages[0]!,
        });
        if (compiled.issues.some((issue) => issue.severity === 'blocking')) {
          return {
            content: [{ type: 'text', text: `The slide was not applied because its narration cues could not be bound to the regenerated visual objects: ${compiled.issues.map((issue) => issue.message).join('; ')}` }],
            details: { sceneId, content: null, actions: [] },
            isError: true,
          };
        }
        actions = compiled.actions;
      } else {
        actions = await generateSceneActions(
          outline,
          newContent,
          withTeachingEnhancement(actionsAiCall, outline, 'actions'),
          { ctx, agents, languageDirective },
        );
      }

      const text =
        actions.length > 0
          ? `Regenerated the slide content (${newContent.elements.length} elements) and ${actions.length} actions.`
          : `Regenerated the slide content (${newContent.elements.length} elements), but narration regeneration produced no actions — the existing narration is unchanged and may not match the new content.`;

      return {
        content: [{ type: 'text', text }],
        details: { sceneId, content: newContent, actions },
      };
    },
  };
}
