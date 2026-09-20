/**
 * Generation Types - Two-Stage Content Generation System
 *
 * Stage 1: User requirements + documents → Scene Outlines (per-page)
 * Stage 2: Scene Outlines → Full Scenes (slide/quiz/interactive/pbl with actions)
 */

import type { ActionType } from './action';
import type { MediaGenerationRequest } from '@openmaic/lib/media/types';
import type { TtsTimingPlan } from '@openmaic/lib/audio/tts-timing';

// ==================== PDF Image Types ====================

/**
 * Image extracted from PDF with metadata
 */
export interface PdfImage {
  id: string; // e.g., "img_1", "img_2"
  src: string; // base64 data URL (empty when stored in IndexedDB)
  pageNumber: number; // Page number in PDF
  description?: string; // Optional description for AI context
  storageId?: string; // Reference to IndexedDB (session_xxx_img_1)
  width?: number; // Image width (px or normalized)
  height?: number; // Image height (px or normalized)
}

/**
 * Image mapping for post-processing: image_id → base64 URL
 */
export type ImageMapping = Record<string, string>;

// ==================== Stage 1 Input ====================

export interface UploadedDocument {
  id: string;
  name: string; // Original filename
  type: 'pdf' | 'docx' | 'pptx' | 'txt' | 'md' | 'image' | 'other';
  size: number; // Bytes
  uploadedAt: Date;
  contentSummary?: string; // Placeholder for parsing
  extractedTopics?: string[]; // Placeholder for parsing
  pageCount?: number;
  storageRef?: string;
}

/**
 * Simplified user requirements for course generation
 * All details (topic, duration, style, etc.) should be included in the requirement text
 */
export interface UserRequirements {
  /** Private source evidence used only during authoring, never a runtime instruction. */
  teachingSourceContext?: string;
  requirement: string; // Single free-form text for all user input
  userNickname?: string; // Student nickname for personalization
  userBio?: string; // Student background for personalization
  /**
   * Course-planning strategy shared by streaming, background, legacy, and new-system generation.
   * Standard mode chooses interactions only when they materially improve learning;
   * deep-interaction mode asks the planner for an interactive-first lesson.
   */
  generationMode?: CourseGenerationMode;
  /** @deprecated Compatibility alias for imported OpenMAIC requests. */
  interactiveMode?: boolean;
  /** Shared learner-readiness and knowledge-boundary contract for every generation stage. */
  teachingConstraints?: import('@openmaic/lib/pedagogy/teaching-constraints').TeachingConstraints;
  webSearch?: boolean; // Enable web search for richer context
  taskEngineMode?: boolean; // Enable vocational task-engine generation path
  /** Structured profile for the personal-project PBL classroom template. */
  pblProfile?: import("@/lib/pbl-course-config").PblCourseConfig;
  /** Structured ordinary-activity teacher support requirements. */
  pblTeachingActivities?: PblTeachingActivityRequirement[];
  /** Full first-level activity catalog, including student AI-learning activities. */
  pblActivityCatalog?: PblActivityCatalogEntry[];
  /** Confirmed knowledge catalog used to keep second-level coverage deterministic. */
  knowledgePoints?: Array<{ id: string; name?: string; level?: string }>;
  /** Natural-speed TTS facts available before semantic page planning. */
  ttsTimingContext?: {
    providerId: string;
    modelId: string;
    voiceId: string;
    cjkCharsPerMinute: number;
    latinWordsPerMinute: number;
    calibrated: boolean;
  };
}

export type CourseGenerationMode = 'standard' | 'deep-interaction';
export type AssessmentMode = 'adaptive' | 'constructed-response';

// ==================== Stage 1 Output: Scene Outlines (Simplified) ====================

/**
 * Widget outline configuration for interactive scenes
 * Unified for both normal and ultra modes
 */
export interface WidgetOutline {
  // Common field
  concept?: string;

  // Type-specific fields
  keyVariables?: string[]; // simulation
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system'; // diagram
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp'; // code
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action'; // game
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom'; // visualization3d
  objects?: string[]; // visualization3d
  interactions?: string[]; // visualization3d
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom'; // procedural-skill
  task?: string; // procedural-skill - task to perform
  tools?: string[]; // procedural-skill - tools or materials involved
  steps?: string[]; // procedural-skill - ordered procedure steps
  successCriteria?: string[]; // procedural-skill - checks for completion
  errorConsequences?: string[]; // procedural-skill - consequences for unsafe or incorrect actions
  challenge?: string; // game - description of what player does
  playerControls?: string[]; // game - what player controls
  nodeCount?: number; // diagram - approximate node count
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>; // diagram - authoritative nodes when supplied by the planner
  challengeType?: string; // code - type of coding challenge
}

export type SceneResourceType =
  | 'ppt'
  | 'interactive-demo'
  | 'code-interactive'
  | 'script'
  | 'worksheet'
  | 'rubric'
  | 'project-brief';

/** The kind of second-level resource detail generated under a first-level activity. */
export type PblDetailKind =
  | 'teacher-introduction'
  | 'knowledge-explanation'
  | 'interactive-practice'
  | 'project-scaffold'
  | 'project-practice'
  | 'showcase-coaching'
  | 'reflection-transfer'
  | 'other';

/** Whether a detail may receive generated narration. Teacher resources never do. */
export type PblTtsPolicy = 'none' | 'target-duration';

export type PblTeachingActivityRequirement = {
  activityId: string;
  stageKey: string;
  title: string;
  durationMin: number;
  teachingGoal: string;
  teacherRole: string;
  platformRole: string;
  aiRole: string;
  studentActivity: string;
  openMaicUse: 'none' | 'student-ai-learning';
  resourceTypes: SceneResourceType[];
  requirement: string;
};

export type TeachingToolKind =
  | 'whiteboard'
  | 'spotlight'
  | 'laser-pointer'
  | 'interactive-widget';

/**
 * Page-level teaching-tool intent produced during lesson planning.
 *
 * This is deliberately semantic rather than coordinate based: teachers can
 * review when/why a tool will appear before generation, while the action
 * generator remains responsible for turning the intent into executable
 * whiteboard, canvas, or widget actions.
 */
export type TeachingToolPlanItem = {
  id?: string;
  tool: TeachingToolKind;
  /** Spoken-content cue that should immediately precede the tool action. */
  trigger: string;
  /** Learning benefit provided by the tool on this page. */
  purpose: string;
  /** Exact notes, labels, formulae, steps, or relationships to make visible. */
  content: string[];
  /** Confirmed plans are contractual; generation may not silently omit them. */
  required?: boolean;
};

/** First-level activity catalog used to validate second-level parent links. */
export type PblActivityCatalogEntry = {
  activityId: string;
  stageKey: string;
  title: string;
  durationMin: number;
  knowledgePointIds: string[];
};

/**
 * Exact course-wide tokens selected once by the page planner.
 *
 * Page composition remains owned by OpenMAIC. These tokens only prevent the
 * independent generate_scene calls from inventing a different background,
 * palette, and typography for every slide.
 */
export type CourseVisualTheme = {
  schemaVersion: 1;
  name: string;
  background: string;
  surface: string;
  primary: string;
  secondary: string;
  accent: string;
  text: string;
  mutedText: string;
  motif: string;
  editorialStyle: string;
};

/**
 * Simplified scene outline
 * Gives AI more freedom, only requiring intent description and key points
 */
export interface SceneOutline {
  teachingBrief?: import("@/lib/course-quality-review/types").TeachingBrief;
  /**
   * One concise course-level art direction chosen during page planning.
   *
   * This is CoTeach orchestration metadata, not learner-facing copy. The thin
   * OpenMAIC adapter carries it into slide content and media generation only;
   * action/narration generation deliberately never sees it.
   */
  courseVisualDirection?: string;
  /** Machine-checkable companion to courseVisualDirection. */
  courseVisualTheme?: CourseVisualTheme;
  visualPlan?: import("@openmaic/lib/generation/slide-visual-plan").SlideVisualPlan;
  spatialBudget?: import("@openmaic/lib/generation/slide-spatial-types").SlideSpatialBudget;
  /** Original confirmed page when spatial preparation splits it. */
  spatialParentId?: string;
  /** Parent scope is evidence; each split page only renders its own region content. */
  spatialSourceContext?: { description: string; teachingObjective?: string; coreMessage: string };
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl';
  title: string;
  description: string; // 1-2 sentences describing the purpose
  keyPoints: string[]; // 3-5 core key points
  teachingObjective?: string;
  estimatedDuration?: number; // seconds
  order: number;
  /** Explicit PBL phase metadata; never infer this from array position. */
  stageKey?: string;
  stageLabel?: string;
  audience?: "student" | "teacher";
  generationPurpose?:
    | "knowledge-teaching"
    | "teacher-resource"
    | "facilitation-scaffold"
    | "companion-guidance";
  companionIds?: string[];
  companionPrompt?: string;
  /** Teaching-outline activity represented by this scene, when applicable. */
  activityId?: string;
  /** First-level activity that owns this second-level detail. */
  parentActivityId?: string;
  /** Stable lecture section used by the section manifest and learning evidence. */
  lectureSectionId?: string;
  lectureSectionTitle?: string;
  /** Semantic role of the detail inside its parent activity. */
  detailKind?: PblDetailKind;
  /** Explicit references to the confirmed course knowledge-point IDs. */
  knowledgePointIds?: string[];
  /** Stable blueprint units taught or assessed by this scene. */
  teachingUnitIds?: string[];
  assessmentUnitIds?: string[];
  assessmentUnitMap?: Array<{ unitId: string; knowledgePointIds: string[] }>;
  /** Ordered, atomic checks compiled from the teaching blueprint. */
  assessmentTargets?: Array<{
    unitId: string;
    knowledgePointId: string;
    unitTitle: string;
    learningOutcome: string;
  }>;
  /** Target narration/content duration for this detail, in seconds. */
  targetDurationSec?: number;
  /**
   * Blueprint-owned activity decomposition. The classroom timing adapter must
   * preserve these totals instead of inferring a second, conflicting split.
   */
  plannedTiming?: {
    narrationSec: number;
    learnerActivitySec: number;
    transitionSec: number;
    role: 'teaching' | 'assessment';
  };
  /** 1-based page segment position when one detail is expanded into multiple pages. */
  segmentIndex?: number;
  /** Total page segments generated for the same parent detail. */
  segmentCount?: number;
  /** Short semantic cue used to keep sibling pages complementary. */
  segmentRole?: string;
  /** Stable group key shared by page segments derived from one detail. */
  segmentGroupId?: string;
  /** Explicit TTS policy; target-duration is only used for student knowledge scenes. */
  ttsPolicy?: PblTtsPolicy;
  /** Model-specific narration budget used by generation and playback verification. */
  timingPlan?: TtsTimingPlan;
  /** Overall teaching-stage acceptance; page/paragraph allocations remain advisory. */
  teachingStageTiming?: import("@openmaic/lib/server/teaching-stage-timing-plan").TeachingStageTimingBudget;
  /** Embedded resources continue a parent lesson and never own greetings/farewells. */
  narrationMode?: 'standalone-course' | 'embedded-segment';
  /** Teacher-reviewable intent for whiteboard/canvas/widget use on this page. */
  teachingToolPlan?: TeachingToolPlanItem[];
  /** Requested output form; the generator must preserve it for PBL scenes. */
  resourceTypes?: SceneResourceType[];
  outcomePart?: 'artifact' | 'presentation' | 'reflection';
  languageNote?: string; // LLM-inferred language note for this scene
  // Suggested image IDs (from PDF-extracted images)
  suggestedImageIds?: string[]; // e.g., ["img_1", "img_3"]
  // AI-generated media requests (when PDF images are insufficient)
  mediaGenerations?: MediaGenerationRequest[]; // e.g., [{ type: 'image', prompt: '...', elementId: 'gen_img_1' }]
  // Quiz-specific config
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'matching' | 'short_answer' | 'true_false' | 'fill_blank' | 'scenario_task')[];
    coveragePolicy?: 'each-target' | 'section-synthesis';
    /** Minimum explanation-style responses required by the adopted understanding standard. */
    minShortAnswerQuestions?: number;
    /** Maximum explanation-style responses. `fill_blank` is not counted. */
    maxShortAnswerQuestions?: number;
  };
  /**
   * @deprecated Use widgetType + widgetOutline instead
   * Legacy interactive config - kept for backward compatibility only
   */
  interactiveConfig?: {
    conceptName: string;
    conceptOverview: string;
    designIdea: string;
    subject?: string;
  };
  // PBL-specific config
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    /** Opt into role-play scenario planning on top of the standard PBL v2 structure. */
    scenarioRoleplay?: boolean;
    /** Optional scenario brief used only when scenarioRoleplay is true. */
    scenarioBrief?: string;
  };
  // Widget fields (required for type === 'interactive' in unified mode)
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}

// ==================== Stage 3 Output: Generated Content ====================

import type { PPTElement, SlideBackground, SlideTheme } from '@openmaic/dsl';
import type { QuizQuestion } from './stage';

/**
 * AI-generated slide content
 */
export interface GeneratedSlideContent {
  elements: PPTElement[];
  background?: SlideBackground;
  theme?: SlideTheme;
  remark?: string;
}

/**
 * AI-generated quiz content
 */
export interface GeneratedQuizContent {
  questions: QuizQuestion[];
}

// ==================== PBL Generation Types ====================

import type { PBLProjectConfig } from '@openmaic/lib/pbl/types';
import type { PBLProjectV2 } from '@openmaic/lib/pbl/v2/types';

/**
 * AI-generated PBL content.
 *
 * PBL v2 generation returns a legacy-compatible `projectConfig` plus the full
 * v2 payload so existing storage/rendering paths can migrate incrementally.
 */
export interface GeneratedPBLContent {
  projectConfig: PBLProjectConfig;
  projectV2?: PBLProjectV2;
}

// ==================== Interactive Generation Types ====================

import type { WidgetConfig, WidgetType } from './widgets';

/**
 * Scientific model output from scientific modeling stage
 */
export interface ScientificModel {
  core_formulas: string[];
  mechanism: string[];
  constraints: string[];
  forbidden_errors: string[];
}

/**
 * AI-generated interactive content
 */
export interface GeneratedInteractiveContent {
  html: string;
  scientificModel?: ScientificModel;
  widgetType?: WidgetType;
  widgetConfig?: WidgetConfig;
}

// ==================== Legacy Types (for compatibility) ====================

export interface SuggestedSlideElement {
  type: 'text' | 'image' | 'shape' | 'chart' | 'latex' | 'line';
  purpose: 'title' | 'subtitle' | 'content' | 'example' | 'diagram' | 'formula' | 'highlight';
  contentHint: string;
  position?: 'top' | 'center' | 'bottom' | 'left' | 'right';
  chartType?: 'bar' | 'line' | 'pie' | 'radar';
  textOutline?: string[];
}

export interface SuggestedQuizQuestion {
  type: 'single' | 'multiple' | 'short_answer';
  questionOutline: string;
  suggestedOptions?: string[];
  targetConceptId?: string;
  difficulty: 'easy' | 'medium' | 'hard';
}

export interface SuggestedAction {
  type: ActionType;
  description: string;
  timing?: 'start' | 'middle' | 'end' | 'after-content';
}

// ==================== Generation Session ====================

export interface GenerationProgress {
  currentStage: 1 | 2 | 3;
  overallProgress: number; // 0-100
  stageProgress: number; // 0-100
  statusMessage: string;
  scenesGenerated: number;
  totalScenes: number;
  errors?: string[];
}

export interface GenerationSession {
  id: string;
  requirements: UserRequirements;
  sceneOutlines?: SceneOutline[];
  progress: GenerationProgress;
  startedAt: Date;
  completedAt?: Date;
  generatedStageId?: string;
}
