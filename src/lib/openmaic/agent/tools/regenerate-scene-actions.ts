/**
 * `regenerate_scene_actions` agent tool
 *
 * Re-generates a scene's playback `actions` to match its (edited) content by
 * reusing the same server-side pipeline as the canonical scene-actions route.
 *
 * The tool's `execute` runs inside the agent loop and has no access to the
 * request's resolved model, so the LLM call capability is injected via a
 * factory (`makeRegenerateSceneActionsTool`) — the route will supply `deps.aiCall`
 * built from the already-resolved model.
 *
 * Scene/stage context (outline, allOutlines, content, stageId) is injected via
 * `deps.getSceneContext` — sourced from the client's `useStageStore` and sent in
 * the POST body — so the model never needs to fabricate these large structures.
 * The model only needs to supply the `sceneId` (or rely on the active scene).
 *
 * The tool returns the regenerated actions in `details`; a later client task
 * reads `tool_execution_end` and applies the actions to the scene in the store.
 */

import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
  generateSceneActions,
  type SceneGenerationContext,
  type AgentInfo,
} from '@openmaic/lib/generation/generation-pipeline';
import type { Action, SpeechAction } from '@openmaic/lib/types/action';
import type {
  SceneOutline,
  GeneratedSlideContent,
  GeneratedQuizContent,
  GeneratedInteractiveContent,
  GeneratedPBLContent,
} from '@openmaic/lib/types/generation';
import type { SceneContent } from '@openmaic/lib/types/stage';
import type { LlmStage } from '@openmaic/lib/server/model-routes';
import { whiteboardBlocks } from '@openmaic/lib/edit/whiteboard-blocks';
import { parseActionsFromStructuredOutput } from '@openmaic/lib/generation/action-parser';
import { calibrateGeneratedVisualCues } from '@openmaic/lib/generation/semantic-visual-cues';
import { withTeachingEnhancement } from '@openmaic/lib/generation/teaching-enhancement';

// ── Scene context shape (client-sourced, injected via deps) ──────────────────

export interface SceneContext {
  /** The SceneOutline for the target scene. */
  outline: SceneOutline;
  /** All scene outlines in the stage, in order (for cross-scene context). */
  allOutlines: SceneOutline[];
  /** The current scene content. */
  content: SceneContent;
  /** Current playback actions, including teacher-authored whiteboard segments. */
  actions?: Action[];
  /** Actual narration for sibling pages in this section, in classroom order. */
  sectionNarrations?: Array<{
    sceneId: string;
    outlineId: string;
    title: string;
    current: boolean;
    speeches: Array<{ id: string; text: string }>;
  }>;
  /** The stage id that owns this scene. */
  stageId: string;
  /** Optional agent info for multi-agent stages. */
  agents?: AgentInfo[];
  /** Optional language directive forwarded to the generator. */
  languageDirective?: string;
  /**
   * Runtime errors the interactive iframe reported for this scene (captured by
   * the error shim, see lib/utils/iframe.ts). Surfaced to the model by
   * read_scene_content so it can diagnose a blank/broken page from the real
   * error instead of guessing.
   */
  runtimeErrors?: string[];
}

// ── Deps injection interface ─────────────────────────────────────────────────

export interface RegenerateActionsDeps {
  /**
   * Server-side LLM text call, resolving the model PER GENERATION STAGE.
   *
   * Each tool is a self-contained generation black box: it names the stage it is
   * generating for (e.g. `scene-content:interactive`, `scene-content:slide`,
   * `scene-actions`) and the route resolves that stage's model via MODEL_ROUTES
   * — independent of the `maic-agent` model driving the agent conversation. The
   * agent only decides WHICH tool to call; the tool owns its model.
   *
   * `signal` is the tool's abort signal (from `execute`): when the user cancels
   * the turn, the in-flight generation call is aborted so it stops promptly
   * instead of running to completion in the background.
   */
  aiCall: (
    stage: LlmStage,
    systemPrompt: string,
    userPrompt: string,
    signal?: AbortSignal,
  ) => Promise<string>;

  /**
   * Returns the trusted scene/stage context for a given scene id.
   * This is populated from the client POST body (useStageStore state) so the
   * model never has to fabricate outlines or content.
   */
  getSceneContext: (sceneId: string) => SceneContext | undefined;
}

// ── Content shape conversion ─────────────────────────────────────────────────
//
// The client sends `scene.content` (runtime `SceneContent` DSL) but
// `generateSceneActions` expects the generation-time types:
//   GeneratedSlideContent    { elements, background?, remark? }
//   GeneratedQuizContent     { questions }
//   GeneratedInteractiveContent { html, ... }
//   GeneratedPBLContent      { projectConfig }
//
// The ONLY mismatch is `SlideContent` (runtime) vs `GeneratedSlideContent`:
//   SlideContent  = { type: 'slide', canvas: Slide }  — elements at canvas.elements
//   GeneratedSlide = { elements, background?, remark? } — elements at top level
//
// `generateSceneActions` checks `'elements' in content` for the slide branch.
// If we pass SlideContent directly, that check is FALSE → falls through → returns [].
//
// For quiz/interactive/pbl the runtime shapes already have the discriminant field
// at the top level ('questions', 'html', 'projectConfig'), so they pass through as-is.

function toGenerationContent(
  content: SceneContent,
):
  | GeneratedSlideContent
  | GeneratedQuizContent
  | GeneratedInteractiveContent
  | GeneratedPBLContent {
  if (content.type === 'slide') {
    // Convert SlideContent → GeneratedSlideContent
    return {
      elements: content.canvas.elements ?? [],
      background: content.canvas.background,
      // remark is not stored in the runtime canvas; omit it
    } satisfies GeneratedSlideContent;
  }
  // quiz, interactive, pbl runtime shapes already satisfy the generation type
  return content as GeneratedQuizContent | GeneratedInteractiveContent | GeneratedPBLContent;
}

// ── Typebox parameter schema ─────────────────────────────────────────────────
// Minimal: the model only needs to identify WHICH scene to regenerate.
// All heavy context (outline, allOutlines, content, stageId) comes from deps.

export const RegenerateSceneActionsParams = Type.Object({
  sceneId: Type.String({
    description:
      'The id of the scene whose actions should be regenerated. ' +
      'Use the id of the current scene shown in the system prompt.',
  }),
  instruction: Type.Optional(Type.String({
    maxLength: 12000,
    description: 'The teacher’s actual requested changes to the narration, including language, tone, length and which lines to keep. Always forward the user’s request. Existing whiteboard segments and non-speech cues are preserved; use edit_whiteboard for narration inside a whiteboard.',
  })),
  previousSpeeches: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Speech texts from the previous scene for cross-scene coherence.',
    }),
  ),
  userProfile: Type.Optional(
    Type.String({ description: 'Free-text user profile for personalised narration.' }),
  ),
});

export type RegenerateSceneActionsParams = Static<typeof RegenerateSceneActionsParams>;

// ── Details shape returned to the client ────────────────────────────────────

export interface RegenerateSceneActionsDetails {
  sceneId: string;
  actions: Action[];
  narrationPatch?: NarrationPatch;
}

export interface NarrationPatch {
  before: SpeechAction[];
  speeches: SpeechAction[];
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function makeRegenerateSceneActionsTool(
  deps: RegenerateActionsDeps,
): AgentTool<typeof RegenerateSceneActionsParams, RegenerateSceneActionsDetails> {
  return {
    name: 'regenerate_scene_actions',
    label: 'Regenerate scene actions',
    description:
      'Rewrites a scene’s spoken narration according to the teacher’s instruction and current content. ' +
      'Supply sceneId and instruction containing the user’s actual request, including what must stay unchanged. ' +
      'Existing whiteboard segments (including their narration and images) and non-speech playback cues are preserved exactly. ' +
      'For narration or drawing inside a whiteboard, use edit_whiteboard. Scene data and the current script are loaded automatically.',
    parameters: RegenerateSceneActionsParams,

    execute: async (_toolCallId, params, signal) => {
      const { sceneId, instruction, previousSpeeches, userProfile } = params;

      // ── Resolve trusted scene context from deps (not from model args) ──
      const ctxData = deps.getSceneContext(sceneId);
      if (!ctxData) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: scene context not found for sceneId ${JSON.stringify(String(sceneId).slice(0, 200))}. Cannot regenerate actions.`,
            },
          ],
          details: { sceneId, actions: [] },
          isError: true,
        };
      }

      const { outline, allOutlines, content, stageId, agents, languageDirective, sectionNarrations } = ctxData;
      const originalActions = ctxData.actions;
      const boardIndexes = new Set(whiteboardBlocks(originalActions ?? []).flatMap((block) =>
        Array.from({ length: block.end - block.start + 1 }, (_item, index) => block.start + index),
      ));
      const editableSpeeches = originalActions?.filter((action, index) => action.type === 'speech' && !boardIndexes.has(index));
      if (originalActions?.length && !editableSpeeches?.length) {
        return {
          content: [{ type: 'text', text: '本页没有白板之外的讲稿。若要修改白板中的讲解，请读取该白板后使用 edit_whiteboard。' }],
          details: { sceneId, actions: [] }, isError: true,
        };
      }
      const withoutImageBytes = (value: string) => value.replace(/data:[^,\s"']*;base64,[A-Za-z0-9+/=]+/gi, '[embedded asset preserved by id]');
      const referenceActions = JSON.stringify(originalActions ?? [], (key, value) => {
        if (['audioId', 'audioUrl', 'audioInvalidated'].includes(key)) return undefined;
        return typeof value === 'string' && /^data:/i.test(value) ? '[embedded asset preserved by id]' : value;
      });
      const editInstructions = [
        '## Teacher narration edit (overrides generic whole-script generation instructions for this call)',
        instruction?.trim() ? `Teacher request: ${instruction.trim()}` : 'Teacher request: update the narration to fit the current page content, preserving unrequested wording and behavior.',
        'Use the current actions below as the reference. Preserve everything the teacher did not ask to change.',
        originalActions?.length
          ? `Only rewrite these OUTSIDE-WHITEBOARD speech ids: ${JSON.stringify(editableSpeeches?.map((action) => action.id))}. Return only the changed speech actions, keeping their original ids. Never return whiteboard actions, whiteboard narration, spotlight, laser, video, discussion or widget actions; these are retained from the original document. Do not return image sources or the embedded-asset marker.`
          : 'There is no existing narration to edit. Generate spoken narration only; do not add whiteboard or other playback actions.',
        originalActions?.length
          ? 'For this edit, return a JSON array using this exact narration format: [{"type":"action","name":"speech","action_id":"ORIGINAL_SPEECH_ID","params":{"text":"edited narration"}}]. Keep unchanged lines out of the response. For a whole-narration rewrite, include every editable speech id, without changing the number or position of speech slots.'
          : 'Return narration in the usual JSON array format: [{"type":"text","content":"narration"}].',
        sectionNarrations?.length
          ? `Actual narration for this complete section (read-only context; pages outside the target cannot be edited):\n${JSON.stringify(sectionNarrations)}`
          : '',
        `Current actions (reference only; binary assets omitted):\n${referenceActions}`,
      ].filter(Boolean).join('\n');

      // Suppress unused variable — stageId is part of the context contract and
      // may be needed by future tool logic (e.g. quota checks, audit logging).
      void stageId;

      // ── Build cross-scene context (mirrors route.ts logic) ─────────────
      const allTitles: string[] = allOutlines.map((o) => o.title);
      const pageIndex = allOutlines.findIndex((o) => o.id === outline.id);
      const actualPreviousSpeeches = (sectionNarrations ?? [])
        .slice(0, Math.max(0, (sectionNarrations ?? []).findIndex((item) => item.current)))
        .flatMap((item) => item.speeches.map((speech) => speech.text));
      const ctx: SceneGenerationContext = {
        pageIndex: (pageIndex >= 0 ? pageIndex : 0) + 1,
        totalPages: allOutlines.length,
        allTitles,
        previousSpeeches: actualPreviousSpeeches.length ? actualPreviousSpeeches : previousSpeeches ?? [],
      };

      // Wrap deps.aiCall to match AICallFn (adds optional images param). Actions
      // generation resolves the `scene-actions` stage model — the same route the
      // course-generation actions path uses — not the agent conversation model.
      let modelResponse: string | undefined;
      const aiCallFn = async (
        systemPrompt: string,
        userPrompt: string,
        _images?: Array<{ id: string; src: string }>,
      ): Promise<string> => {
        const narrationEditCall = modelResponse === undefined;
        const response = await deps.aiCall(
          'scene-actions',
          withoutImageBytes(narrationEditCall
            ? `${systemPrompt}\n\n${editInstructions}`
            : systemPrompt),
          withoutImageBytes(narrationEditCall
            ? `${userPrompt}\n\n${editInstructions}`
            : userPrompt),
          signal,
        );
        if (narrationEditCall) modelResponse = response;
        return response;
      };

      // ── Generate actions ───────────────────────────────────────────────
      // Convert the runtime SceneContent shape to the generation-time shape that
      // generateSceneActions expects.  The critical case is SlideContent:
      //   runtime:    { type: 'slide', canvas: Slide }   → elements at canvas.elements
      //   generation: { elements, background?, remark? } → elements at top level
      // Without this conversion the 'elements' in content check is FALSE and the
      // function returns [] immediately.
      const generationContent = toGenerationContent(content);

      const generatedActions = await generateSceneActions(outline, generationContent,
        withTeachingEnhancement(aiCallFn, outline, 'actions'), {
        ctx,
        agents,
        userProfile,
        languageDirective,
      });

      let actions = generatedActions;
      let narrationPatch: NarrationPatch | undefined;
      if (originalActions !== undefined) {
        // Use the model's id-addressed edits before generic generation merges
        // adjacent narration fragments or inserts lifecycle actions.
        const proposed = modelResponse === undefined ? [] : parseActionsFromStructuredOutput(modelResponse, outline.type);
        const editableById = new Map(editableSpeeches?.map((action) => [action.id, action]));
        const seen = new Set<string>();
        const valid = proposed.length > 0 && proposed.every((action) => {
          if (action.type !== 'speech' || !action.text.trim() || action.text.length > 30000 || seen.has(action.id)) return false;
          seen.add(action.id);
          return originalActions.length === 0 || editableById.has(action.id);
        });
        if (!valid) {
          return {
            content: [{ type: 'text', text: '讲稿修改未应用：生成结果缺少原讲稿 ID，或包含白板/其他动作。请只修改白板外的讲稿并保留原 ID 后重试。' }],
            details: { sceneId, actions: [] }, isError: true,
          };
        }
        const updatedById = new Map(proposed.map<[string, Action]>((action) => {
          const prior = editableById.get(action.id);
          const text = action.type === 'speech' ? action.text : '';
          if (prior?.type === 'speech' && prior.text === text) return [action.id, prior];
          const edited = prior?.type === 'speech' ? { ...prior, text, audioInvalidated: true } : { id: action.id, type: 'speech' as const, text, audioInvalidated: true };
          delete (edited as { audioId?: string }).audioId;
          delete (edited as { audioUrl?: string }).audioUrl;
          return [action.id, edited];
        }));
        actions = originalActions.length
          ? originalActions.map((action) => updatedById.get(action.id) ?? action)
          : [...updatedById.values()];
        if (originalActions.length) {
          narrationPatch = { before: [], speeches: [] };
          for (const [id, updated] of updatedById) {
            const before = editableById.get(id);
            if (before?.type === 'speech' && updated.type === 'speech') {
              narrationPatch.before.push(before);
              narrationPatch.speeches.push(updated);
            }
          }
        }
      }

      // Narration edits are merged back into the complete original timeline.
      // Revalidate the already-interleaved OpenMAIC cues locally; no second
      // model pass is allowed to rewrite or independently re-plan the script.
      if (outline.type === 'slide' && 'elements' in generationContent) {
        actions = calibrateGeneratedVisualCues({
          outline,
          elements: generationContent.elements,
          actions,
        });
      }

      if (actions.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text:
                `Warning: action generation produced no actions for scene "${outline.title}". ` +
                `The scene content may be empty or in an unexpected format. ` +
                `The existing actions have NOT been changed.`,
            },
          ],
          details: { sceneId, actions: [] },
          isError: true,
        };
      }

      ctxData.actions = actions;

      return {
        content: [
          {
            type: 'text',
            text: `Regenerated ${actions.length} actions for the scene.`,
          },
        ],
        details: { sceneId, actions, ...(narrationPatch ? { narrationPatch } : {}) },
      };
    },
  };
}
