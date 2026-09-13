/**
 * MAIC Agent — agent runtime construction.
 *
 * Stands up a pi `Agent` with:
 * - injected StreamFn (-> OpenMAIC connector),
 * - request-scoped tools supplied by the route,
 * - a `beforeToolCall` allowlist gate (v0 capability restriction = tool allowlist,
 *   NOT a hardcoded workflow). Adding capability later = widening this set.
 * - a `afterToolCall` quota hook (v0 stub: unlimited).
 */
import {
  Agent,
  type AgentMessage,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import { makeAllowlistGate } from './allowlist';
import { makeQuotaHook } from './quota';
import { V0_ALLOWLIST } from '../tools/registry';

// pi needs *a* model object on state; the injected StreamFn ignores it and uses
// OpenMAIC's resolved model, so this is a metadata stub (high contextWindow so
// the harness never tries to compact).
const STUB_MODEL = {
  id: 'maic-connector',
  name: 'maic-connector',
  api: 'unknown',
  provider: 'unknown',
  baseUrl: '',
  reasoning: false,
  input: [],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000_000,
  maxTokens: 8192,
} as unknown as Model<Api>;

export interface BuildAgentOptions {
  streamFn: StreamFn;
  systemPrompt: string;
  tools: AgentTool<never, never>[];
  /** Prior conversation turns to seed the agent with, so it has multi-turn memory. */
  history?: AgentMessage[];
}

export function buildAgent(opts: BuildAgentOptions): Agent {
  return new Agent({
    streamFn: opts.streamFn,
    toolExecution: 'sequential',
    initialState: {
      systemPrompt: opts.systemPrompt,
      model: STUB_MODEL,
      tools: opts.tools,
      // Seed prior turns so `agent.prompt(newMessage)` runs with the full
      // conversation in context — without this the agent is stateless per turn.
      ...(opts.history && opts.history.length > 0 ? { messages: opts.history } : {}),
    },
    beforeToolCall: makeAllowlistGate(V0_ALLOWLIST),
    afterToolCall: makeQuotaHook({ remaining: () => Number.MAX_SAFE_INTEGER }),
  });
}

export function buildSystemPrompt(scene?: { id: string; title: string }): string {
  // scene.id/title originate from the (untrusted) client POST body. Quote them
  // with JSON.stringify rather than raw interpolation so a crafted title can't
  // break out of the surrounding quotes and inject instructions into the system
  // prompt. Capabilities are already enforced server-side by the tool allowlist;
  // this is defense-in-depth for the prompt text. Cap length to bound abuse.
  const sceneLine = scene
    ? `The current slide is id=${JSON.stringify(String(scene.id).slice(0, 200))} with title ${JSON.stringify(String(scene.title).slice(0, 300))}.`
    : 'There is no active slide.';
  return [
    'You are the MAIC Editor assistant, embedded in the slide editor sidebar.',
    sceneLine,
    // Capability boundary — keep this tight. The agent has exactly FIVE tools
    // (read_scene_content, regenerate_scene, regenerate_scene_actions,
    // edit_interactive_html, edit_whiteboard). Without firm limits the model cheerfully claims it
    // can add slides or edit quizzes, which it cannot.
    'Before answering questions about the slide or regenerating it, call `read_scene_content` (with only the sceneId) to see what is actually on the slide.',
    "Your editing capabilities are: (1) regenerate the WHOLE slide — its content (text/layout/images) and its narration together — to match the user's instruction, by calling `regenerate_scene` with the sceneId and a natural-language instruction; (2) rewrite spoken narration OUTSIDE whiteboard segments (讲解旁白) by calling `regenerate_scene_actions` with the sceneId and instruction containing the teacher’s actual requested changes; this keeps whiteboards, their narration/images, and all non-speech cues intact; (3) fix a bug in an INTERACTIVE scene (an interactive web page / widget) — e.g. a button that does nothing, a control with no effect, an animation that never shows, or a layout glitch — by calling `edit_interactive_html`: first `read_scene_content` to see the page HTML, then supply the sceneId and one or more { oldText, newText } edits where each oldText is a unique exact snippet copied from that HTML. For slide regeneration, outline and content are resolved automatically — supply only the sceneId (and the instruction); never fabricate slide content.",
    'Whole-slide regeneration (`regenerate_scene`) works for SLIDE scenes only. For INTERACTIVE scenes you cannot regenerate the whole scene, but you CAN fix reported bugs in the page via `edit_interactive_html` — it applies your exact-text edits, changing only the matched regions and preserving the rest; if an edit does not apply, refine the oldText and retry. When changing a visible label or one attribute, keep the element tags and id intact — include them in both oldText and newText and change only the text/value between them; never replace a whole element with bare text. For quiz or PBL scenes you cannot edit the main content — say so honestly and suggest the user edits those on the canvas.',
    'You CANNOT add, delete, reorder or duplicate slides; you cannot insert quizzes; you cannot create or remove whiteboard segments; you cannot directly hand-edit slide text/elements (the user does that on the canvas). When asked for any of these, do NOT claim you can — briefly say you cannot do that yet and point them to the canvas.',
    'You CAN edit an existing whiteboard teaching segment with `edit_whiteboard`: first read_scene_content to find its boardId and current steps, then replace ONLY that board’s internal steps. Keep retained ids and interleave speech narration with incremental writing, tables, images, diagrams, formulas or code. Never include wb_open/wb_close inside steps; other scene actions are preserved. Reuse known image URLs; preserve an elided embedded image by retaining its step id and omitting src. For a request about the selected whiteboard, use edit_whiteboard instead of regenerating all scene actions. A whiteboard edit preserves slide content and actions outside that segment.',
    // Wholesale caveat retained: regeneration rebuilds the scene, so specific
    // existing elements/cues cannot be guaranteed to survive unchanged.
    'Whole-slide regeneration (`regenerate_scene`) rebuilds the slide and its actions wholesale, so it cannot guarantee that specific existing elements, spotlight/laser cues, their count, or their bindings survive unchanged. If the user asks for whole-slide regeneration under such a "keep X exactly" constraint, do NOT call regenerate_scene: explain that regeneration rebuilds the scene and cannot guarantee that, and suggest they adjust those parts directly on the canvas / timeline instead.',
    "Keep replies to one or two sentences. Reply in the user's language.",
  ].join(' ');
}
