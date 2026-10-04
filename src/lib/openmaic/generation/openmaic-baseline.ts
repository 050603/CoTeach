import {
  buildOutlinePrompt as buildOpenMaicOutlinePrompt,
  generateSceneOutlinesFromRequirements as generateOpenMaicSceneOutlines,
  generateSceneActions as generateOpenMaicSceneActions,
  generateSceneContent as generateOpenMaicSceneContent,
  type AgentInfo as OpenMaicAgentInfo,
  type GeneratedSlideContent as OpenMaicSlideContent,
  type ImageMapping as OpenMaicImageMapping,
  type OutlineGenerationOptions as OpenMaicOutlineGenerationOptions,
  type PdfImage as OpenMaicPdfImage,
  type SceneOutline as OpenMaicSceneOutline,
  type UserRequirements as OpenMaicUserRequirements,
  type TextMeasure,
  type SceneContentFailure,
} from '@openmaic/generation';
import type { Action } from '@openmaic/lib/types/action';
import type {
  GeneratedInteractiveContent,
  GeneratedSlideContent,
  ImageMapping,
  PdfImage,
  SceneOutline,
  UserRequirements,
} from '@openmaic/lib/types/generation';
import type {
  AICallFn,
  AgentInfo,
  GenerationResult,
  SceneGenerationContext,
} from './pipeline-types';
import {
  applyPlannedTeachingToolActions,
  normalizeTeachingToolPlan,
} from './teaching-tool-plan';
import { normalizeWhiteboardActionLifecycle } from './whiteboard-action-lifecycle';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';
import { formatOpenMaicWebsiteReferenceProfile } from './course-visual-theme';
import { withTeachingEnhancement } from './teaching-enhancement';
import { calibrateGeneratedVisualCues } from './semantic-visual-cues';
import { adoptedPageAuthoringContent } from './adopted-page-content';
import { formatSlidePresentationTypography, slideTypography } from './slide-presentation-typography';
import { formatLecturePresentationReference } from './lecture-presentation-reference';
import { nativeAuthoringEnvelopeContract, normalizeNativeAuthoringEnvelope } from './native-authoring-envelope';
import { buildNativeTextPlacementPlan, expandNativeTextPlacements, formatNativeTextPlacementPlan, formatNativeTextRelationCaption } from './native-text-placement';
import type { SemanticPageCapacityAssessment } from './semantic-page-capacity';
import { buildAuthoringSourceCatalog, pageOriginalTeachingSources, type SourceGroundingKnowledgePoint } from './source-grounding';
import type { TeachingAuthoringKnowledgePoint } from './first-pass-authoring';
import type { CourseEvidenceSnapshot } from '@/lib/textbook/course-evidence-types';
import type { FigureSequenceContract } from '@/lib/textbook/course-visual-binding';
import { applyClassroomSlideContentPolicy, CLASSROOM_SLIDE_CONTENT_POLICY } from './classroom-slide-content-policy';
import { generateRestoredSlideContent } from './restored-slide-authoring';

export const OPENMAIC_GENERATION_BASELINE = {
  release: 'v1.0.3',
  releaseCommit: 'e693e11a81644f84c258df73dbda378643520a62',
  package: '@openmaic/generation',
  version: '0.3.7',
  planningMethod: 'classic-one-click',
  referenceProfileVersion: 'openmaic-v1.0.2-export-blue-editorial-v3-semantic-fit',
  promptHashes: {
    requirementsSystem: '344c33e57f72ee86056c12d072c337f609838eab209517a05cc9b57a90b02e32',
    requirementsUser: 'f04381208fe2837b806a910579b43f0433e8e2d6bee5654b03ac5ded0530e16e',
    slideContentSystem: 'd55f5967f839d1b072eadd674814d09565f57cac1e3bc2453738aa66042a5a6f',
    slideContentUser: '6e4fd25ae1428a8d6f45000caa73f6b661044a5f12a6dbdd55fede10802ff77d',
    upstreamSlideActionsSystem: '219e8da1eb3c854dbe6ee6fdedda1936e0092fff6c8984b9277c5c6cef2443b6',
    slideActionsSystem: 'b1fd18bcaeea294fa204bab84dc16c81946d0c7a0abb2408b4a44eaa8007f058',
    slideActionsUser: '71a95329793ba0fae6030b6b9eb562bed62e9460bd26c2fcbd92d7c53f549512',
  },
} as const;

/**
 * CoTeach keeps the v1.0.3 one-click semantic boundary: the official outline's
 * description/keyPoints are passed to the official page generator, while
 * orchestration metadata stays outside the prompt. The first-pass outline
 * contract preserves learner-facing title styles and visual intent, while the
 * slide-content prompt preserves the supplied title and chooses native
 * representations from the teaching need. Production may opt into the
 * measured website reference profile, but never a page template, geometry
 * budget, timing appendix, or generated theme plan.
 */
function clean(value: string | undefined): string {
  return value?.trim() ?? '';
}

/** Keep the upstream semantic outline unchanged in shape and strip only
 * CoTeach-only orchestration metadata. Pedagogical evidence remains available
 * to quiz/review code, but is deliberately not expanded into the upstream
 * slide prompt: doing that changed its information density and visual choices.
 */
export function adaptOutlineToOpenMaicBaseline(outline: SceneOutline): OpenMaicSceneOutline {
  return {
    id: outline.id,
    type: outline.type,
    title: outline.title,
    description: outline.description ?? '',
    keyPoints: [...(outline.keyPoints ?? [])],
    teachingObjective: outline.teachingObjective,
    estimatedDuration: outline.estimatedDuration,
    order: outline.order,
    languageNote: outline.languageNote,
    visualIntent: outline.visualIntent ? {
      ...outline.visualIntent,
      resourceRefs: outline.visualIntent.resourceRefs?.map((reference) => ({ ...reference })),
    } : undefined,
    suggestedImageIds: outline.suggestedImageIds ? [...outline.suggestedImageIds] : undefined,
    mediaGenerations: outline.mediaGenerations?.map((item) => ({
      type: item.type,
      prompt: item.prompt,
      elementId: item.elementId,
      aspectRatio: item.aspectRatio,
      style: item.style,
    })),
    interactiveConfig: outline.interactiveConfig
      ? { ...outline.interactiveConfig }
      : undefined,
    widgetType: outline.widgetType,
    widgetOutline: outline.widgetOutline ? { ...outline.widgetOutline } : undefined,
  };
}

/** Compatibility alias retained for offline comparisons. */
export function adaptOutlineToOpenMaicWorkbenchContent(
  outline: SceneOutline,
): OpenMaicSceneOutline {
  return adaptOutlineToOpenMaicBaseline(outline);
}

function adaptRequirementsToOpenMaicBaseline(
  requirements: UserRequirements,
): OpenMaicUserRequirements {
  return {
    requirement: requirements.requirement,
    userNickname: requirements.userNickname,
    userBio: requirements.userBio,
    webSearch: requirements.webSearch,
    interactiveMode: requirements.interactiveMode,
    taskEngineMode: requirements.taskEngineMode,
  };
}

export type OpenMaicBaselineOutlineContext = {
  pdfText?: string;
  pdfImages?: PdfImage[];
  visionEnabled?: boolean;
  imageMapping?: ImageMapping;
  imageGenerationEnabled?: boolean;
  videoGenerationEnabled?: boolean;
  researchContext?: string;
  teacherContext?: string;
};

/** Only specialized PBL/task-engine planners stay on CoTeach-owned prompts. */
export function shouldUseOpenMaicBaselineOutlines(
  requirements: Pick<UserRequirements, 'pblProfile' | 'taskEngineMode'>,
  taskEngineMode = requirements.taskEngineMode === true,
): boolean {
  return requirements.pblProfile?.generationTemplate !== 'pbl-six-stage'
    && !taskEngineMode;
}

/** Build the exact upstream one-click outline prompt from CoTeach inputs. */
export function buildOpenMaicBaselineOutlinePrompt(
  requirements: UserRequirements,
  context: OpenMaicBaselineOutlineContext = {},
): { system: string; user: string } {
  return buildOpenMaicOutlinePrompt(
    adaptRequirementsToOpenMaicBaseline(requirements),
    {
      pdfText: context.pdfText,
      pdfImages: context.pdfImages as OpenMaicPdfImage[] | undefined,
      visionEnabled: context.visionEnabled,
      imageMapping: context.imageMapping as OpenMaicImageMapping | undefined,
      imageGenerationEnabled: context.imageGenerationEnabled,
      videoGenerationEnabled: context.videoGenerationEnabled,
      researchContext: context.researchContext,
      teacherContext: context.teacherContext,
    },
  );
}

/** Generate the course outline through the pinned upstream one-click package. */
export async function generateOpenMaicBaselineOutlines(
  requirements: UserRequirements,
  pdfText: string | undefined,
  pdfImages: PdfImage[] | undefined,
  aiCall: AICallFn,
  options: Omit<OpenMaicBaselineOutlineContext, 'pdfText' | 'pdfImages'> = {},
): Promise<GenerationResult<{
  languageDirective: string;
  courseTitle?: string;
  outlines: SceneOutline[];
}>> {
  const result = await generateOpenMaicSceneOutlines(
    adaptRequirementsToOpenMaicBaseline(requirements),
    pdfText,
    pdfImages as OpenMaicPdfImage[] | undefined,
    aiCall,
    options as OpenMaicOutlineGenerationOptions,
  );
  if (!result.success || !result.data) {
    return { success: false, error: result.error };
  }
  return {
    success: true,
    data: {
      languageDirective: result.data.languageDirective,
      courseTitle: result.data.courseTitle,
      outlines: result.data.outlines.map((outline) => ({
        ...outline,
        ...(outline.quizConfig
          ? {
              quizConfig: {
                ...outline.quizConfig,
                questionTypes: outline.quizConfig.questionTypes.map((type) =>
                  type === 'text' ? 'short_answer' as const : type,
                ),
              },
            }
          : {}),
      })) as SceneOutline[],
    },
  };
}

export interface BaselineContentOptions {
  /** CoTeach-only, single-call native lecture composition. Legacy callers opt out by omission. */
  visualProjection?: boolean;
  /** An isolated redraw may retain an existing usable draft if no improvement fits. */
  visualBaseline?: GeneratedSlideContent;
  /** First-draft components compile into editable native slide elements. */
  componentAuthoring?: boolean;
  slideAuthoring?: 'native' | 'flow';
  textMeasure?: TextMeasure;
  pageCapacityAssessment?: SemanticPageCapacityAssessment;
  onFailure?: (failure: SceneContentFailure) => void;
  assignedImages?: PdfImage[];
  imageMapping?: Record<string, string>;
  visionEnabled?: boolean;
  generatedMediaMapping?: Record<string, string>;
  agents?: AgentInfo[];
  languageDirective?: string;
  allowProceduralSkill?: boolean;
  editDirective?: string;
  baselineContent?: GeneratedSlideContent;
  sourceEvidence?: CourseEvidenceSnapshot;
  sourceKnowledgePoints?: readonly SourceGroundingKnowledgePoint[];
  teachingAuthoringKnowledge?: readonly TeachingAuthoringKnowledgePoint[];
  sourceSequenceContracts?: readonly FigureSequenceContract[];
  /** Shared semantic deck context used only by CoTeach production. Omitting it
   * keeps the package prompt byte-identical for upstream parity tools. */
  websiteReferenceContext?: {
    courseTitle?: string;
    slideTitles: string[];
  };
}

function withWebsiteReferenceProfile(
  aiCall: AICallFn,
  context: NonNullable<BaselineContentOptions['websiteReferenceContext']>,
): AICallFn {
  const courseTitle = clean(context.courseTitle);
  const slideTitles = context.slideTitles.map(clean).filter(Boolean);
  const deckContext = [
    courseTitle ? `Course title: ${courseTitle}` : '',
    slideTitles.length
      ? `Planned lecture-page titles, in course order: ${slideTitles.join(' | ')}`
      : '',
    'Use the list only to understand this page\'s role and avoid a repetitive deck. Do not render the list, page numbers, section metadata, timings, IDs, or quiz mechanics on the slide.',
  ].filter(Boolean).join('\n');
  return (system, user, images) => aiCall(
    `${system}\n\n${formatOpenMaicWebsiteReferenceProfile()}\n\n${CLASSROOM_SLIDE_CONTENT_POLICY}`,
    `${user}\n\n## Course deck context\n${deckContext}`,
    images,
  );
}

/** Generate a slide or generic widget through the pinned upstream package. */
export async function generateOpenMaicBaselineContent(
  outline: SceneOutline,
  aiCall: AICallFn,
  options: BaselineContentOptions = {},
): Promise<GeneratedSlideContent | GeneratedInteractiveContent | null> {
  const qualityDiagnostics: string[] = [];
  if (outline.type !== 'slide' && outline.type !== 'interactive') {
    throw new Error(`OpenMAIC baseline content adapter does not own ${outline.type} scenes`);
  }
  if (outline.type === 'slide' && options.slideAuthoring !== 'flow' && options.visualProjection !== false) {
    return generateRestoredSlideContent(outline, adaptOutlineToOpenMaicBaseline(outline), aiCall, options);
  }
  // Explicit historical replay retains its original saved contract. Production
  // defaults to the restored whole-page native design above.
  const authoringContent = options.componentAuthoring && !options.editDirective && !options.baselineContent
    ? adoptedPageAuthoringContent(outline) : undefined;
  const typography = outline.teachingBrief?.teachingPlan?.presentationTypography
    ? { ...slideTypography(outline),
        chartFontSize: options.pageCapacityAssessment?.selectedLayout?.bodyFontSize ?? slideTypography(outline).bodyFontSize,
      } : undefined;
  const textPlacementPlan = outline.type === 'slide' && options.slideAuthoring !== 'flow'
    && authoringContent?.length && options.textMeasure && !options.assignedImages?.length
    ? await buildNativeTextPlacementPlan(outline, authoringContent, {
        measure: options.textMeasure, capacity: options.pageCapacityAssessment,
      }) : undefined;
  // This optional finite candidate set does not prove that every native
  // composition is impossible. Keep legacy raw replay under its original gates;
  // the shared semantic capacity preflight owns pre-authoring overflow stops.
  const placementGuidance = textPlacementPlan ? formatNativeTextPlacementPlan(textPlacementPlan) : '';
  const pageDecisionAiCall: AICallFn = authoringContent?.length ? (system, user, images) => aiCall(
    `${system}\n${formatNativeTextRelationCaption(placementGuidance ? textPlacementPlan?.relationCaption : undefined)}`,
    `${user}\n\n## Current page first-draft decisions\nThe original-source and course context above do not expand this page’s adopted display responsibility. Put every required catalog point into supported contentRef/paragraphRefs display slots (or a placementRef if you choose one of the measured candidates), using exact IDs: ${JSON.stringify(authoringContent.filter((item) => item.required !== false).map((item) => item.id))}. Do not shorten or rewrite those points. Use the supplied playback-font text measurements for readable allocations. If a planned diagram exists, select one complete measured feasible width/height pair already supplied, preserving its entire nodes, edges and annotation; never mix dimensions from different candidates. Keep peer content regions separate. Return the existing native/component JSON contract in this first response.${placementGuidance && !textPlacementPlan?.flexibleComposition ? `\n\n## Required measured placement for this first response\nThe host selected default layout ${JSON.stringify(textPlacementPlan?.defaultCandidateId)} before this request. Use bare placementRef components for this default; omit layoutCandidateId unless you actively select another advertised candidate. In components, give every title and adopted point exactly one kind:textBox + placementRef. Omit contentRef/paragraphRefs, authored text, coordinates and typography on those selected components. The host compiler expands placementRef into canonical contentRef plus the full measured rectangle, so all catalog coverage remains mandatory. Keep native decoration in elements; do not duplicate the title/body as native text. This selected-placement grammar supersedes the general reference-slot/free-coordinate examples above.` : ''}\n${formatNativeTextRelationCaption(placementGuidance ? textPlacementPlan?.relationCaption : undefined)}`, images) : aiCall;
  const referenceAiCall = outline.type === 'slide' && options.websiteReferenceContext
    ? withWebsiteReferenceProfile(pageDecisionAiCall, options.websiteReferenceContext)
    : pageDecisionAiCall;
  const originalSources = pageOriginalTeachingSources(outline, options);
  const spoken = Boolean(outline.teachingBrief?.manuscript);
  const sourceCatalog = spoken ? undefined : buildAuthoringSourceCatalog(new Map([[outline.id, originalSources]]));
  const groundedAiCall: AICallFn = spoken ? (system, user, images) => referenceAiCall(system,
    `${user}\n\n## Original teaching sources for this page\n${JSON.stringify({ originalTeachingSources: originalSources,
      visualRelationship: outline.teachingBrief?.teachingPlan?.visualRelationship,
      learningTask: outline.teachingBrief?.pageTask })}\nThe lecture is already authored and supplied separately. Implement the adopted display points and planned visual relationships using the existing layout and media contract. Original passages determine factual meaning; the lecture determines what this page teaches. Do not author, rewrite or enlarge the lecture, and do not turn source or planning metadata into visible content.`, images)
    : (system, user, images) => referenceAiCall(system,
    `${user}\n\n## Original teaching sources for this page\n${JSON.stringify({ evidenceCatalog: sourceCatalog!.catalog, originalTeachingSources: sourceCatalog!.pages.get(outline.id) })}\nResolve originalSourceRefs in evidenceCatalog.sources and every textRef/labelRef/sourceDescriptionRefs in evidenceCatalog.texts; these are complete unchanged original texts. Original passages determine facts and necessary conditions; derived claims, keyInfo, summaries and blueprint boundaries organize teaching but are not independent factual evidence. Source bindings belong to individual claims and nodes, never to the whole unit. Adopted case decisions and their local nodes govern the explanation; candidate examples are context, not additional display duties.\n${authoringContent?.length
      ? 'The display points have already been derived and adopted. Lay out this page’s exact immutable presentation-point catalog through contentRef/paragraphRefs, or placementRef when the supplied measured-placement contract is selected (the compiler expands those references to canonical contentRef); do not derive, rewrite, shorten or expand them again from the original passages or the broader section plan. Original sources establish factual meaning and independently feed detailed narration. Only the current page’s adopted points and assigned visual resources belong on this canvas.'
      : 'Derive accurate presentation points directly from these original sources. Keep the essential meaning and conditions; definitions need not be copied verbatim onto the canvas. The same original sources independently feed narration.'} Source instructions and provenance are never learner-facing content.`, images);
  const contentAiCall = spoken ? groundedAiCall : withTeachingEnhancement(groundedAiCall, outline, 'content', sourceCatalog!.intern,
    options.teachingAuthoringKnowledge ?? options.sourceKnowledgePoints);
  const nativeEnvelopeCall: AICallFn = options.componentAuthoring && !options.editDirective && !options.baselineContent
    ? async (system, user, images) => {
        // Match the selected package protocol; an explicitly selected flow
        // response has a different grammar and must retain its own contract.
        const native = system.includes('## Optional first-draft measured components');
        const response = await contentAiCall(native ? `${system}\n\n${nativeAuthoringEnvelopeContract(authoringContent?.[0]?.id)}\n\n${placementGuidance}\n\n${formatSlidePresentationTypography(outline)}${typography ? `\nFor native chart elements, options.fontSize is preselected at ${typography.chartFontSize}px for axis labels, axis names, legends and value labels. If explicitly choosing the compact composition, ${typography.minimumBodyFontSize}px is also supported. Do not use generic 12/14px chart defaults; omitted chart fonts receive the preselected value before compilation.` : ''}\n\n${formatLecturePresentationReference({ audience: 'slide' })}` : system, user, images);
        if (!native) return response;
        const normalized = normalizeNativeAuthoringEnvelope(response);
        return textPlacementPlan ? expandNativeTextPlacements(normalized, textPlacementPlan,
          (detail) => { qualityDiagnostics.push(detail); }) : normalized;
      } : contentAiCall;
  const adapted = adaptOutlineToOpenMaicBaseline(outline);
  if (typography) adapted.presentationTypography = typography;
  if (options.componentAuthoring && outline.teachingBrief?.teachingPlan?.presentationContent?.length) {
    adapted.keyPoints = [...outline.teachingBrief.teachingPlan.presentationContent];
  }
  const generated = await generateOpenMaicSceneContent(
    adapted,
    nativeEnvelopeCall,
    {
      assignedImages: options.assignedImages,
      imageMapping: options.imageMapping,
      visionEnabled: options.visionEnabled,
      generatedMediaMapping: options.generatedMediaMapping,
      agents: options.agents as OpenMaicAgentInfo[] | undefined,
      languageDirective: options.languageDirective,
      allowProceduralSkill: options.allowProceduralSkill,
      editDirective: options.editDirective,
      baselineContent: options.baselineContent as OpenMaicSlideContent | undefined,
      componentAuthoring: options.componentAuthoring,
      slideAuthoring: options.slideAuthoring,
      textMeasure: options.textMeasure,
      authoringContent,
      onFailure: (failure) => options.onFailure?.(failure),
    },
  );
  if (!generated) return null;
  if (outline.type === 'slide' && 'elements' in generated) {
    return applyClassroomSlideContentPolicy({ ...generated, qualityDiagnostics: [...new Set([...(generated.qualityDiagnostics ?? []), ...qualityDiagnostics])] } as GeneratedSlideContent);
  }
  if (outline.type === 'interactive' && 'html' in generated) {
    return generated as GeneratedInteractiveContent;
  }
  return null;
}

function actionExtension(outline: SceneOutline): { system: string; user: string } {
  const timing = outline.timingPlan;
  const tools = normalizeTeachingToolPlan(outline.teachingToolPlan);
  const whiteboardRequired = tools.some((item) => item.tool === 'whiteboard');
  const whiteboardExtension = whiteboardRequired
    ? `\n\n## CoTeach whiteboard extension\nThe following action names are also valid inside the same action objects: wb_open {}, wb_draw_text {content,x,y,width,height,fontSize,color,elementId}, wb_draw_latex {latex,x,y,width,height,elementId}, wb_draw_shape {shape,x,y,width,height,fillColor,elementId,groupId}, wb_draw_line {startX,startY,endX,endY,width,points,elementId,groupId}, wb_draw_table {x,y,width,height,data}, wb_draw_chart {chartType,x,y,width,height,data}, wb_draw_code {language,code,x,y,width,height,elementId}, wb_clear {}, and wb_close {}. Open the board before drawing, interleave each reveal with teacher speech, keep every object inside a 1000 x 562.5 canvas, and close the board before returning to slide actions.`
    : '';
  const system = whiteboardExtension;
  const timingLines = timing
    ? [
        `- Natural-speed teacher narration target: about ${timing.targetDurationSec} seconds (${timing.minUnits}-${timing.maxUnits} ${timing.unit === 'latin-word' ? 'words' : 'Chinese/mixed text units'}).`,
        `- Reserved student activity: ${timing.studentActivitySec ?? 0} seconds; reserved page transition: ${timing.transitionSec ?? 0} seconds. Do not fill either interval with speech.`,
      ]
    : [];
  const toolLines = tools.map((item, index) =>
    `${index + 1}. ${item.tool}${item.required === false ? ' (optional)' : ' (required)'}; trigger=${item.trigger}; purpose=${item.purpose}; visible content=${item.content.join(' | ')}`,
  );
  const lectureLines = outline.generationPurpose === 'knowledge-teaching'
    ? [
        '- Use a continuous masterclass narration: state the page claim, explain its mechanism or evidence, then walk through the concrete case or boundary until the conclusion follows.',
        '- Use complete, natural sentences rather than captions that merely read the slide. Keep one primary teacher voice; an assistant may ask at most one genuinely useful question at an arc boundary.',
        '- Carry the argument forward from the previous page. Do not greet again, restart the lesson, add cheerleading, or end every page with a generic invitation to think.',
      ]
    : [];
  const actionLines = [...timingLines, ...lectureLines, ...toolLines];
  const user = actionLines.length
    ? `\n\n## CoTeach action-only constraints\n${actionLines.join('\n')}\nThese constraints affect narration and actions only. Do not reinterpret or redesign the slide.`
    : '';
  return { system, user };
}

/** Use the upstream action prompt, then apply CoTeach's deterministic runtime guards. */
export async function generateOpenMaicBaselineSlideActions(
  outline: SceneOutline,
  content: GeneratedSlideContent,
  aiCall: AICallFn,
  options: {
    ctx?: SceneGenerationContext;
    agents?: AgentInfo[];
    userProfile?: string;
    languageDirective?: string;
  } = {},
): Promise<Action[]> {
  const extension = actionExtension(outline);
  const extendedAiCall: AICallFn = (system, user, images) =>
    aiCall(`${system}${extension.system}`, `${user}${extension.user}`, images);
  const actionAiCall = withTeachingEnhancement(extendedAiCall, outline, 'actions');
  const actions = await generateOpenMaicSceneActions(
    adaptOutlineToOpenMaicBaseline(outline),
    content as OpenMaicSlideContent,
    actionAiCall,
    {
      ctx: options.ctx,
      agents: options.agents as OpenMaicAgentInfo[] | undefined,
      userProfile: options.userProfile,
      languageDirective: options.languageDirective,
      // Course authoring preserves an invalid first response and stops at this
      // adapter. Do not let the package's compatibility summary disguise an
      // unparseable action response as a successful formal lesson page.
      requireStructuredOutput: true,
    },
  );
  const finalized = normalizeWhiteboardActionLifecycle(
    normalizeWhiteboardActionLayout(
      applyPlannedTeachingToolActions(outline, actions as Action[]),
    ),
  );
  return calibrateGeneratedVisualCues({
    outline,
    elements: content.elements,
    actions: finalized,
  });
}
