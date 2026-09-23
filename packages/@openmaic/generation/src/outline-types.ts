import type { WidgetType } from '@openmaic/dsl';

export type { WidgetType } from '@openmaic/dsl';

/** Image extracted from a source document with metadata used by outline prompts. */
export interface PdfImage {
  id: string;
  src: string;
  pageNumber: number;
  description?: string;
  storageId?: string;
  width?: number;
  height?: number;
  originalId?: string;
  sourceDocumentId?: string;
  sourceDocumentName?: string;
  sourceDocumentOrder?: number;
  visionPriority?: number;
  /** How strongly the textbook image is related to the knowledge being taught. */
  textbookRelation?: 'direct' | 'candidate';
  /** Knowledge points this image provides evidence for. */
  knowledgePointIds?: string[];
  /** Source-evidence records that selected this image. */
  evidenceItemIds?: string[];
  /** Human-readable source title shown to the planning model. */
  sourceTitle?: string;
  /** A direct source image that must be used on its first full teaching page. */
  required?: boolean;
  /** Why the image is related to the knowledge point. */
  relationReason?: string;
}

export type ImageMapping = Record<string, string>;

/** Free-form requirements accepted by outline generation. */
export interface UserRequirements {
  requirement: string;
  userNickname?: string;
  userBio?: string;
  webSearch?: boolean;
  interactiveMode?: boolean;
  taskEngineMode?: boolean;
}

export interface WidgetOutline {
  concept?: string;
  keyVariables?: string[];
  diagramType?: 'flowchart' | 'mindmap' | 'hierarchy' | 'system';
  language?: 'python' | 'javascript' | 'typescript' | 'java' | 'cpp';
  gameType?: 'quiz' | 'puzzle' | 'strategy' | 'card' | 'action';
  visualizationType?: 'molecular' | 'solar' | 'anatomy' | 'geometry' | 'physics' | 'custom';
  objects?: string[];
  interactions?: string[];
  procedureType?: 'repair' | 'assembly' | 'inspection' | 'operation' | 'custom';
  task?: string;
  tools?: string[];
  steps?: string[];
  successCriteria?: string[];
  errorConsequences?: string[];
  challenge?: string;
  playerControls?: string[];
  nodeCount?: number;
  nodes?: Array<{
    id: string;
    label: string;
    parentId?: string;
    icon?: string;
    details?: string;
  }>;
  challengeType?: string;
}

export interface MediaGenerationRequest {
  type: 'image' | 'video';
  prompt: string;
  elementId: string;
  aspectRatio?: '16:9' | '4:3' | '1:1' | '9:16';
  style?: string;
}

export type VisualRepresentation =
  | 'text'
  | 'source-image'
  | 'generated-image'
  | 'native-diagram'
  | 'native-chart'
  | 'table'
  | 'video'
  | 'mixed';

export interface VisualResourceReference {
  /** Stable source or generated-media ID shared by planning, layout, and recovery. */
  resourceId: string;
  kind: 'source-image' | 'generated-image' | 'generated-video';
  /** Required resources must appear in the generated page; omission fails the page generation. */
  required: boolean;
  /** Pedagogical reason for spending or reusing this resource. */
  reason: string;
  /** The concrete feature or contrast learners should inspect in this resource. */
  observationGoal?: string;
}

/** A semantic relationship selected during instructional planning. Geometry is added at slide authoring time. */
export interface DiagramPlan {
  topology: 'sequence' | 'cycle';
  /** Reading order; a cycle also closes from the last node to the first. */
  nodes: Array<{ id: string; label: string }>;
  /** Directed relationships. Adjacent edges may be omitted and are then inferred. */
  edges?: Array<{ from: string; to: string; label?: string }>;
  /** Explains the whole diagram; it is never a step or an edge. */
  annotation?: string;
}

export interface SceneVisualIntent {
  /** What learners should be able to observe directly on this page. */
  observationGoal: string;
  /** Native visual form chosen for the teaching need. */
  representation: VisualRepresentation;
  /** Stable resource bindings. Generated resources can be reused across scenes by ID. */
  resourceRefs?: VisualResourceReference[];
  /** Optional structure for a diagram made from editable native elements. */
  diagram?: DiagramPlan;
  /** Short rationale for why this representation is worth its cost. */
  rationale?: string;
}

/** A generation-ready description of one course scene. */
export interface SceneOutline {
  id: string;
  type: 'slide' | 'quiz' | 'interactive' | 'pbl';
  title: string;
  description: string;
  keyPoints: string[];
  teachingObjective?: string;
  estimatedDuration?: number;
  order: number;
  languageNote?: string;
  visualIntent?: SceneVisualIntent;
  suggestedImageIds?: string[];
  mediaGenerations?: MediaGenerationRequest[];
  quizConfig?: {
    questionCount: number;
    difficulty: 'easy' | 'medium' | 'hard';
    questionTypes: ('single' | 'multiple' | 'text')[];
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
  pblConfig?: {
    projectTopic: string;
    projectDescription: string;
    targetSkills: string[];
    issueCount?: number;
    scenarioRoleplay?: boolean;
    scenarioBrief?: string;
  };
  widgetType?: WidgetType;
  widgetOutline?: WidgetOutline;
}
