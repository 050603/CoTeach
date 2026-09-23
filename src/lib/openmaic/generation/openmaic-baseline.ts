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
import { enforceNarrationContinuity } from './narration-continuity';
import {
  applyPlannedTeachingToolActions,
  normalizeTeachingToolPlan,
} from './teaching-tool-plan';
import { normalizeWhiteboardActionLifecycle } from './whiteboard-action-lifecycle';
import { normalizeWhiteboardActionLayout } from './whiteboard-layout';
import { formatOpenMaicWebsiteReferenceProfile } from './course-visual-theme';
import { withTeachingEnhancement } from './teaching-enhancement';
import { calibrateGeneratedVisualCues } from './semantic-visual-cues';

export const OPENMAIC_GENERATION_BASELINE = {
  release: 'v1.0.3',
  releaseCommit: 'e693e11a81644f84c258df73dbda378643520a62',
  package: '@openmaic/generation',
  version: '0.3.7',
  planningMethod: 'classic-one-click',
  referenceProfileVersion: 'openmaic-v1.0.2-export-blue-editorial-v3-semantic-fit',
  promptHashes: {
    requirementsSystem: '9c32d03f0ee824aeca8514d7e332cac18d58f1983b2ae8c94f7fc67d2887bb3c',
    requirementsUser: 'd2ccf25101ce1f161d7eab2c2cc9b896702e01c3dbb378e69b53d1b6a6bc0188',
    slideContentSystem: 'a721801549bb40f3ae49a7e3890c767b29d0f24033902c46adb31ed7f34cc6de',
    slideContentUser: '933706ff5efa04a63abe5627636ac348d7a0f74c28d1eef2b68ff2034ef705ab',
    upstreamSlideActionsSystem: '219e8da1eb3c854dbe6ee6fdedda1936e0092fff6c8984b9277c5c6cef2443b6',
    slideActionsSystem: 'dab3ca7bce6c96c3bb6542e601c1fdbcd9e6a663a0c58ffd7ffb2dff7e5a65b4',
    slideActionsUser: '71a95329793ba0fae6030b6b9eb562bed62e9460bd26c2fcbd92d7c53f549512',
  },
} as const;

/**
 * CoTeach keeps the v1.0.3 one-click semantic boundary: the official outline's
 * description/keyPoints are passed to the official page generator, while
 * orchestration metadata stays outside the prompt. The first-pass outline
 * contract now authors content-topic page titles and visual intent, while the
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
  /** First-draft components compile into editable native slide elements. */
  componentAuthoring?: boolean;
  textMeasure?: TextMeasure;
  assignedImages?: PdfImage[];
  imageMapping?: Record<string, string>;
  visionEnabled?: boolean;
  generatedMediaMapping?: Record<string, string>;
  agents?: AgentInfo[];
  languageDirective?: string;
  allowProceduralSkill?: boolean;
  editDirective?: string;
  baselineContent?: GeneratedSlideContent;
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
    `${system}\n\n${formatOpenMaicWebsiteReferenceProfile()}`,
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
  if (outline.type !== 'slide' && outline.type !== 'interactive') {
    throw new Error(`OpenMAIC baseline content adapter does not own ${outline.type} scenes`);
  }
  const referenceAiCall = outline.type === 'slide' && options.websiteReferenceContext
    ? withWebsiteReferenceProfile(aiCall, options.websiteReferenceContext)
    : aiCall;
  const contentAiCall = withTeachingEnhancement(referenceAiCall, outline, 'content');
  const generated = await generateOpenMaicSceneContent(
    adaptOutlineToOpenMaicBaseline(outline),
    contentAiCall,
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
      textMeasure: options.textMeasure,
    },
  );
  if (!generated) return null;
  if (outline.type === 'slide' && 'elements' in generated) {
    return generated as GeneratedSlideContent;
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
      // Course authoring has a bounded generated-output retry around this
      // adapter. Do not let the package's compatibility summary disguise an
      // unparseable action response as a successful formal lesson page.
      requireStructuredOutput: true,
    },
  );
  const finalized = enforceNarrationContinuity(
    normalizeWhiteboardActionLifecycle(
      normalizeWhiteboardActionLayout(
        applyPlannedTeachingToolActions(outline, actions as Action[]),
      ),
    ),
    options.ctx,
  );
  return calibrateGeneratedVisualCues({
    outline,
    elements: content.elements,
    actions: finalized,
  });
}
