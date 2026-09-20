import { loadSnippet } from '@openmaic/lib/prompts';
import type { GeneratedSlideContent, SceneOutline, UserRequirements } from '@openmaic/lib/types/generation';
import { formatTeachingConstraintsForPrompt } from '@openmaic/lib/pedagogy/teaching-constraints';
import type { AICallFn, SceneGenerationContext } from './pipeline-types';
import { parseJsonResponse } from './json-repair';
import { hasCurrentTeachingBrief } from './teaching-enhancement';
import { compileActionBindings, type ActionCompilationResult, type VisualActionCue } from './action-bindings';
import type { NarrationModuleOutput, SlideElementBinding } from './action-binding-types';

export const TEACHING_NARRATION_VERSION = 'section-continuous-narration-v11-case-evidence';

export interface TeachingSectionNarrationOutput {
  sectionId: string;
  pages: NarrationModuleOutput[];
}

/** Keep explicit whiteboard/widget/video playback contracts on their native path. */
export function canUseIndependentTeachingNarration(outline: SceneOutline): boolean {
  return outline.type === 'slide'
    && outline.audience !== 'teacher'
    && outline.generationPurpose === 'knowledge-teaching'
    && hasCurrentTeachingBrief(outline)
    && !outline.teachingToolPlan?.some((item) => item.required !== false
      && item.tool !== 'spotlight' && item.tool !== 'laser-pointer')
    && !outline.mediaGenerations?.some((request) => request.type === 'video')
    && !(outline.timingPlan?.videoSec && outline.timingPlan.videoSec > 0);
}

export function buildTeachingNarrationSemantics(outline: SceneOutline) {
  return {
    teaching: { id: `${outline.id}:teaching`, text: outline.teachingBrief?.teachingPlan?.newContent ?? outline.teachingObjective ?? outline.description },
    visible: (outline.teachingBrief?.teachingPlan?.visibleContent ?? []).map((text, index) => ({
      id: `${outline.id}:visible-${index + 1}`, text,
    })),
  };
}

/** Add shared semantic requirements without replacing the baseline slide prompt. */
export function withTeachingSlideGuidance(
  aiCall: AICallFn, outline: SceneOutline, onRawResponse?: (response: string) => void,
): AICallFn {
  const { visible } = buildTeachingNarrationSemantics(outline);
  const caseUse = outline.teachingBrief?.pageTask?.caseUse;
  const caseEvidence = caseUse && caseUse !== 'independent'
    ? outline.teachingBrief?.sharedContext?.caseFacts ?? []
    : [];
  return async (system, prompt, images) => {
    const response = await aiCall([
    system,
    'Shared teaching semantics: preserve these visible statements and their meaning in the slide. The adopted design owns knowledge correctness and boundaries. Do not turn a judging aid into a definition, omit required comparison material, or imply a unique one-to-one hierarchy with an unexplained tree. When this page judges or compares a case, make a compact goal → teacher/student actions → observed or explicitly intended result fragment visible before the verdict; a list of category conclusions is not a substitute for the case evidence. Choose layout from the knowledge relationship; use connectors or aligned groups when the supplied content describes a transformation, dependency, causal path, or goal-action-result chain. Do not default to three columns, a card wall, A/B/C labels, or an activity worksheet. Use each supplied semantic ID as the ID of the text element carrying that statement when the schema permits. Before returning the same first draft, check that every required semantic statement is inside the canvas, readable at the baseline minimum font size, and not covered by titles, subtitles, decorations, or other teaching elements. Shorten optional subtitle and decorative copy before compressing, clipping, or dropping required teaching material. Keep all baseline visual/layout requirements. IDs are backstage metadata, never learner-visible labels. Do not add narration or visual actions to this response.',
  ].join('\n'), `${prompt}\n\nShared visible teaching requirements:\n${JSON.stringify(visible)}${caseEvidence.length ? `\n\nCase evidence required for this page (preserve its meaning; combine it into a compact goal-action-result fragment before any case verdict):\n${JSON.stringify(caseEvidence)}` : ''}`, images);
    onRawResponse?.(response);
    return response;
  };
}

/** Structural checks only. Never rewrite the teacher's generated words. */
export function normalizeTeachingNarration(value: unknown, outline: SceneOutline): NarrationModuleOutput {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  if (root?.pageId !== undefined && root.pageId !== outline.id) throw new Error('讲稿与课件页面编号不一致');
  const nested = root?.response && typeof root.response === 'object' && !Array.isArray(root.response)
    ? root.response as Record<string, unknown> : undefined;
  const raw = root?.segments ?? nested?.segments;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('教学讲稿没有返回有效段落');
  const semantics = buildTeachingNarrationSemantics(outline);
  const knownIds = new Set([semantics.teaching.id, ...semantics.visible.map((item) => item.id)]);
  return {
    pageId: outline.id,
    segments: raw.map((item, index) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`讲稿第 ${index + 1} 段格式无效`);
      const segment = item as Record<string, unknown>;
      if (typeof segment.text !== 'string' || !segment.text.trim()) throw new Error(`讲稿第 ${index + 1} 段缺少正文`);
      if (!Array.isArray(segment.semanticIds) || segment.semanticIds.length === 0
        || segment.semanticIds.some((id) => typeof id !== 'string' || !knownIds.has(id))) {
        throw new Error(`讲稿第 ${index + 1} 段引用了缺失或未知教学语义编号`);
      }
      return {
        id: `${outline.id}:speech-${index + 1}`,
        pageId: outline.id,
        text: segment.text,
        semanticIds: [...new Set(segment.semanticIds as string[])],
      };
    }),
  };
}

/** A section response is complete only when every requested page appears exactly once. */
export function normalizeTeachingSectionNarration(
  value: unknown,
  sectionId: string,
  outlines: readonly SceneOutline[],
): TeachingSectionNarrationOutput {
  const root = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
  const rawPages = root?.pages;
  if (!Array.isArray(rawPages)) throw new Error('整节讲稿缺少 pages 数组');
  const expected = new Map(outlines.map((outline) => [outline.id, outline]));
  const result = new Map<string, NarrationModuleOutput>();
  for (const rawPage of rawPages) {
    if (!rawPage || typeof rawPage !== 'object' || Array.isArray(rawPage)) {
      throw new Error('整节讲稿包含无效页面结果');
    }
    const pageId = (rawPage as Record<string, unknown>).pageId;
    if (typeof pageId !== 'string' || !expected.has(pageId)) throw new Error(`整节讲稿包含未知页面：${String(pageId)}`);
    if (result.has(pageId)) throw new Error(`整节讲稿重复返回页面：${pageId}`);
    result.set(pageId, normalizeTeachingNarration(rawPage, expected.get(pageId)!));
  }
  const missing = outlines.filter((outline) => !result.has(outline.id));
  if (missing.length) throw new Error(`整节讲稿缺少页面：${missing.map((outline) => outline.title).join('、')}`);
  return { sectionId, pages: outlines.map((outline) => result.get(outline.id)!) };
}

function actualSlideForNarration(content: GeneratedSlideContent) {
  return {
    elements: content.elements.map((element) => {
      const record = element as unknown as Record<string, unknown>;
      return {
        id: element.id,
        type: element.type,
        content: typeof record.content === 'string' ? plainText(record.content) : undefined,
        text: typeof record.text === 'string' ? plainText(record.text) : undefined,
        alt: typeof record.alt === 'string' ? record.alt : undefined,
      };
    }),
  };
}

/**
 * Write one continuous explanation after the section's actual slides exist,
 * then split the authored result by page for the existing playback pipeline.
 */
export async function generateTeachingSectionNarration(input: {
  sectionId: string;
  pages: ReadonlyArray<{ outline: SceneOutline; content: GeneratedSlideContent }>;
  requirements: UserRequirements;
  courseTitle?: string;
  languageDirective?: string;
  courseProgression?: readonly SceneOutline[];
  aiCall: AICallFn;
}): Promise<TeachingSectionNarrationOutput> {
  if (!input.pages.length) throw new Error('整节讲稿生成缺少页面');
  for (const page of input.pages) {
    if (!page.outline.teachingBrief?.teachingPlan) throw new Error(`页面“${page.outline.title}”缺少已采用的实质教学设计`);
  }
  const outlines = input.pages.map((page) => page.outline);
  const sharedCriteria = outlines.find((outline) => outline.teachingBrief?.understandingCriteria)
    ?.teachingBrief?.understandingCriteria;
  const system = [
    'Write one continuous classroom micro-lecture for the complete section, then return it as page-scoped segments. Return only valid JSON.',
    loadSnippet('adaptive-narration-policy'),
    loadSnippet('teaching-accuracy-policy'),
    'The adopted teaching design is the authority for knowledge, concept boundaries, stable example facts, core reasoning and understanding criteria. The actual slide is the authority only for what is visible and what can be pointed to. Never preserve a slide error or delete a required explanation merely to make words agree with the slide.',
    'Complete the explanation of the core concepts and their relationships before spending words on case continuity or transitions. Unpack unfamiliar terms inside a definition, state how the relationship works and why it supports a teaching choice, and never substitute a definition plus an example plus a classification verdict for that explanation.',
    'Advance one argument across pages. State each new concept or relation where its page owns that contribution. On later pages use only the shortest needed bridge; do not restart, redefine everything, repeat the same case introduction, or add a separate opening and recap to every page.',
    'Use actual slide content for concrete visual references. Name the referent in speech. If a required visible item is absent or conflicts with the adopted design, do not invent that it is visible and do not silently weaken the explanation. Keep the correct explanation self-contained so the resource gap can be reported separately.',
    'Do not invent core claims, change concept boundaries, replace stable case facts, or turn a heuristic into a definition. Do not read internal field names, diagnostics, evidence status, review notes, learner profiles, or authoring instructions aloud.',
    'Keep the named concept set stable across the section. Treat goals, conditions, actions and results as related variables unless the adopted source defines them as peer concepts. A condition held constant in one comparison is not generally forbidden to change; say that this comparison keeps it fixed. Give positive reasons for classifications instead of relying on missing sequence, a list of steps, headings or keywords.',
    'Examples are optional and serve understanding. Project tasks do not become knowledge goals. Interaction questions are optional. Do not force a definition-example-counterexample routine, a three-column classification, or repeated A/B/C labels.',
    'Give the reasoning needed for the predeclared understanding criteria. When a judgment depends on a case, first make its goal, actions, and observed or intended result explicit, and distinguish observed results from predictions or expectations. The final quiz is authored later and must not be previewed with answers. Do not lower the learning standard because a slide is terse.',
    'On the first page that introduces a case, establish the case as an understandable object before classifying any of its sentences: state the case lesson’s subject learning goal, what the teacher and learners actually do, and the observed or explicitly intended result. If the actual slide omitted one of these supplied facts, keep the spoken explanation self-contained instead of jumping straight to layer labels. On later case pages, restate only the facts needed for the current comparison.',
    'Before returning this same first draft, silently trace each claimed relationship from premise through intermediate connection to conclusion. Confirm that a concept described as a concretization names what the principle becomes in activity functions and dependencies; that relative stability names both what stays stable and what may vary; and that a method example explains how the concrete interaction supports the goal. If a case-dependent judgment lacks its goal, action, or observed/intended result in the supplied design, do not invent it or rely on it. Correct the draft before returning and do not output the check.',
    'Each requested teaching page must appear exactly once. Keep the requested pageId. Each segment must use only that page’s supplied semantic IDs. Segment boundaries are playback units and may follow natural explanation paragraphs.',
    'Respect the section position in the complete course. A test-generation scope does not make this the end of the course. Do not add a course farewell unless the progression says this is the final teaching responsibility.',
    input.languageDirective ?? '',
  ].join('\n');
  const prompt = JSON.stringify({
    course: input.courseTitle,
    requirement: input.requirements.requirement,
    learners: input.requirements.teachingConstraints
      ? formatTeachingConstraintsForPrompt(input.requirements.teachingConstraints) : undefined,
    sectionId: input.sectionId,
    understandingCriteria: sharedCriteria,
    pages: input.pages.map(({ outline, content }, index) => ({
      order: index,
      pageId: outline.id,
      title: outline.title,
      objective: outline.teachingObjective,
      sharedContext: outline.teachingBrief?.sharedContext,
      learningTask: outline.teachingBrief?.pageTask,
      teachingPlan: outline.teachingBrief?.teachingPlan,
      explanation: outline.teachingBrief?.explanation,
      examples: outline.teachingBrief?.examples,
      conditions: outline.teachingBrief?.conditions,
      actualSlide: actualSlideForNarration(content),
      targetDurationSec: outline.targetDurationSec,
      timingPlan: outline.timingPlan,
      semanticUnits: buildTeachingNarrationSemantics(outline),
    })),
    courseProgression: input.courseProgression?.map((outline) => ({
      id: outline.id,
      sectionId: outline.lectureSectionId ?? outline.parentActivityId,
      title: outline.title,
      purpose: outline.teachingBrief?.teachingPlan?.purpose,
      newContent: outline.teachingBrief?.teachingPlan?.newContent,
      takeaway: outline.teachingBrief?.teachingPlan?.takeaway,
    })),
    requiredOutputShape: {
      pages: input.pages.map(({ outline }) => ({
        pageId: outline.id,
        segments: [{ text: 'Direct classroom speech', semanticIds: [buildTeachingNarrationSemantics(outline).teaching.id] }],
      })),
    },
  });
  const response = await input.aiCall(system, prompt);
  try {
    return normalizeTeachingSectionNarration(parseJsonResponse(response), input.sectionId, outlines);
  } catch (error) {
    const corrected = await input.aiCall(system, `${prompt}\n\nTechnical JSON/schema correction only. Preserve every valid spoken sentence. Return every requested page exactly once and correct only serialization, page IDs, and semantic references.\n${JSON.stringify({
      structureError: error instanceof Error ? error.message : String(error), invalidResponse: response,
    })}`);
    return normalizeTeachingSectionNarration(parseJsonResponse(corrected), input.sectionId, outlines);
  }
}

/** Legacy/special-resource fallback. Ordinary knowledge pages use the section generator above. */
export async function generateTeachingNarration(input: {
  outline: SceneOutline;
  requirements: UserRequirements;
  courseTitle?: string;
  languageDirective?: string;
  outlineContext?: SceneGenerationContext;
  courseProgression?: readonly SceneOutline[];
  aiCall: AICallFn;
}): Promise<NarrationModuleOutput> {
  const plan = input.outline.teachingBrief?.teachingPlan;
  if (!plan) throw new Error('独立讲稿生成需要已确认的教学计划');
  const semantics = buildTeachingNarrationSemantics(input.outline);
  const system = [
    'Write the classroom teacher’s actual spoken narration, read verbatim by TTS. Return only a JSON object with segments. Follow the requested course language.',
    loadSnippet('adaptive-narration-policy'),
    loadSnippet('teaching-accuracy-policy'),
    'The course-wide request is background, not a command to perform every lesson task on this page. Generate only the current page’s teaching responsibility. Other pages in progression define boundaries: do not execute their quizzes, reveal their answers, or introduce unplanned activities. End this page after its own explanation rather than adding a quiz or announcing another page’s full teaching.',
    'Use the shared teaching plan as the explanation responsibility. Complete only this page’s new contribution. When orientation is needed, explain the practical purpose naturally instead of reciting objectives. Establish the case actions, observations, or results before naming unfamiliar categories; do not compress several new concepts and their classifications into one dense passage. Do not read plan field names. Segment boundaries serve speech playback, not a fixed number of steps or paragraphs.',
    'For an introduce task with several unfamiliar categories, use the first segment for the practical purpose without listing the formal category names, then establish the concrete case actions in the next segment. Name and explain the categories only after the case is understood. Never open by listing all new category names with one-clause glosses.',
    'For a variant or independent learning task, make the first segment state the changed and preserved conditions and ask for the learner’s judgment or prediction without revealing it. The planned learner-thinking pause follows that segment. Explain the answer and its limits only in later segments. Do not repeat the previous page’s full explanation.',
    'Give primary concepts and likely misconceptions the needed depth; keep known background and transitions brief. Preserve precise terms, negation, necessary conditions and the evidence status. Not yet verified is different from false; a recommended method is not the only possible method.',
    'Use the class’s stated prior knowledge and familiar contexts. Do not invent individual learner histories, test results or responses. Do not recite the learner profile. Enter examples directly without announcing whether they are real or illustrative.',
    'Respect the lesson position: no repeated welcome on continuation pages, no premature course ending. Do not repeat neighboring pages’ explanations. A full explanation can span several speech segments; do not restate its conclusion after every segment.',
    'The narration is generated independently of the slide. Explain the content so it can be followed by hearing alone; do not invent slide layout, element IDs, pointer movements, animation, or say “look at this” when the referent is not named.',
    'Each segment has text and semanticIds. Use the supplied teaching semantic ID; optionally add a supplied visible semantic ID only when the segment discusses that exact visible statement. IDs are metadata and must never appear in spoken text. No visual cue is required per segment.',
    'Target duration and timing plan guide the amount of speech; preserve the core explanation, remove repeated premises and conclusions before secondary detail. Do not fill a quota with extra facts. Before returning this same first draft, silently read every sentence once and correct accidental missing or repeated words, homophone-like substitutions, and broken clauses. Do not output a review or request another drafting pass.',
    input.languageDirective ?? '',
  ].join('\n');
  const prompt = JSON.stringify({
    course: input.courseTitle,
    requirement: input.requirements.requirement,
    learners: input.requirements.teachingConstraints
      ? formatTeachingConstraintsForPrompt(input.requirements.teachingConstraints) : undefined,
    page: {
      title: input.outline.title,
      objective: input.outline.teachingObjective,
      sharedContext: input.outline.teachingBrief?.sharedContext,
      learningTask: input.outline.teachingBrief?.pageTask,
      teachingPlan: plan,
    },
    continuity: input.outlineContext,
    progression: input.courseProgression?.map((outline) => ({
      id: outline.id, type: outline.type, currentPage: outline.id === input.outline.id, title: outline.title, purpose: outline.teachingBrief?.teachingPlan?.purpose,
      newContent: outline.teachingBrief?.teachingPlan?.newContent,
      learningTask: outline.teachingBrief?.pageTask,
      sharedContext: outline.teachingBrief?.sharedContext,
      reasoningSteps: outline.teachingBrief?.teachingPlan?.reasoningSteps,
      takeaway: outline.teachingBrief?.teachingPlan?.takeaway,
    })),
    evidence: input.outline.teachingBrief?.evidence,
    examples: input.outline.teachingBrief?.examples,
    conditions: input.outline.teachingBrief?.conditions,
    targetDurationSec: input.outline.targetDurationSec,
    timingPlan: input.outline.timingPlan,
    semanticUnits: semantics,
    requiredOutputShape: { segments: [{ text: 'Direct classroom speech in the requested language', semanticIds: [semantics.teaching.id] }] },
  });
  const response = await input.aiCall(system, prompt);
  try {
    return normalizeTeachingNarration(parseJsonResponse(response), input.outline);
  } catch (error) {
    // Transport failures stay outside this boundary. Only invalid JSON/schema
    // receives one technical correction; valid prose is never rewritten.
    const corrected = await input.aiCall(system, `${prompt}\n\nTechnical JSON/schema correction only. Preserve every valid spoken sentence; do not polish, shorten, expand or re-evaluate teaching quality. Correct the serialization and semantic references using the supplied schema.\n${JSON.stringify({
      structureError: error instanceof Error ? error.message : String(error),
      invalidResponse: response,
    })}`);
    return normalizeTeachingNarration(parseJsonResponse(corrected), input.outline);
  }
}

function plainText(content: string): string {
  return content.replace(/<[^>]*>/g, '').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Exact semantic or text bindings only; unbound optional cues cannot change speech. */
export function compileTeachingNarrationActions(input: {
  outline: SceneOutline;
  content: GeneratedSlideContent;
  narration: NarrationModuleOutput;
}): ActionCompilationResult {
  // Check restored narration under the current semantic contract, too.
  const narration = normalizeTeachingNarration(input.narration, input.outline);
  if (input.narration.pageId !== input.outline.id) throw new Error('讲稿与课件页面编号不一致');
  const semantics = buildTeachingNarrationSemantics(input.outline);
  const bindings: SlideElementBinding[] = semantics.visible.flatMap((unit) => {
    const exactId = input.content.elements.find((element) => element.id === unit.id);
    if (exactId) return [{ semanticId: unit.id, elementIds: [exactId.id] }];
    const matches = input.content.elements.filter((element) => element.type === 'text'
      && plainText(unit.text).length > 0 && plainText(element.content).includes(plainText(unit.text)));
    return matches.length === 1 ? [{ semanticId: unit.id, elementIds: [matches[0].id] }] : [];
  });
  const cued = new Set<string>();
  const cues: VisualActionCue[] = narration.segments.flatMap((segment) => segment.semanticIds.flatMap((semanticId) => {
    if (semanticId === semantics.teaching.id || cued.has(semanticId)) return [];
    cued.add(semanticId);
    return [{ id: `${segment.id}:focus-${cued.size}`, type: 'spotlight' as const, semanticId,
      narrationSegmentId: segment.id, necessity: 'helpful' as const }];
  }));
  return compileActionBindings({ slide: { pageId: input.outline.id, content: input.content, bindings }, narration, cues });
}

const ELEMENT_IDENTITY_FIELDS = [
  'type', 'left', 'top', 'width', 'height', 'content', 'text', 'src', 'latex',
  'path', 'start', 'end', 'chartType', 'data',
] as const;

/** Restore only identities surviving the baseline parser exactly; never guess. */
export function restoreTeachingSemanticElementIds(
  content: GeneratedSlideContent,
  rawResponse: string,
  outline: SceneOutline,
): GeneratedSlideContent {
  let parsed: { elements?: unknown } | null;
  try { parsed = parseJsonResponse<{ elements?: unknown }>(rawResponse); }
  catch { return content; }
  if (!Array.isArray(parsed?.elements)) return content;
  const requiredIds = new Set(buildTeachingNarrationSemantics(outline).visible.map((item) => item.id));
  const rawElements = parsed.elements.filter((item): item is Record<string, unknown> => Boolean(
    item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && requiredIds.has(item.id),
  ));
  const proposals = rawElements.flatMap((raw) => {
    const semanticId = raw.id as string;
    if (rawElements.filter((item) => item.id === semanticId).length !== 1) return [];
    const fields = ELEMENT_IDENTITY_FIELDS.filter((field) => raw[field] !== undefined);
    if (fields.length < 5 || !fields.some((field) => !['type', 'left', 'top', 'width', 'height'].includes(field))) return [];
    const matches = content.elements.flatMap((element, index) => fields.every((field) => (
      JSON.stringify(raw[field]) === JSON.stringify((element as unknown as Record<string, unknown>)[field])
    )) ? [index] : []);
    if (matches.length !== 1) return [];
    if (content.elements.some((element, index) => element.id === semanticId && index !== matches[0])) return [];
    return [{ index: matches[0], semanticId }];
  });
  const unique = proposals.filter((proposal) => proposals.filter((other) => other.index === proposal.index).length === 1);
  if (!unique.length) return content;
  const ids = new Map(unique.map((item) => [item.index, item.semanticId]));
  return { ...content, elements: content.elements.map((element, index) => (
    ids.has(index) ? { ...element, id: ids.get(index)! } : element
  )) };
}
