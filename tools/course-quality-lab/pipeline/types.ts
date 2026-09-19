import type { Action } from "@openmaic/lib/types/action";
import type { GeneratedSlideContent } from "@openmaic/lib/types/generation";

export type PipelineModuleId = string;

export type PipelineErrorKind =
  | "transport"
  | "parse"
  | "structure"
  | "quality"
  | "cancelled";

export type PipelineIssueSeverity = "warning" | "blocking";

export interface ArtifactReference {
  artifactId: string;
  moduleId: PipelineModuleId;
  moduleVersion: string;
  artifactFingerprint: string;
}

export interface VersionedArtifact<T = unknown> extends ArtifactReference {
  runId: string;
  inputFingerprint: string;
  createdAt: string;
  dependencies: ArtifactReference[];
  value: T;
}

export interface PipelineIssue {
  id: string;
  category: string;
  severity: PipelineIssueSeverity;
  ownerModule: PipelineModuleId;
  artifact: ArtifactReference;
  target: {
    type: "artifact" | "page" | "element" | "segment" | "semantic-unit" | "action";
    id: string;
  };
  evidence: string;
  repair: string;
  detectedAt: string;
}

export interface ModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens: number;
  source: "provider" | "estimated" | "unknown";
}

export interface ModelRequest {
  requestId: string;
  moduleId: PipelineModuleId;
  system: string;
  user: string;
  model?: string;
  images?: string[];
  metadata?: Record<string, unknown>;
}

export interface ModelResponse {
  requestId: string;
  text: string;
  model?: string;
  usage?: ModelUsage;
  providerRequestId?: string;
  receivedAt?: string;
}

export interface StoredModelResponse extends ModelResponse {
  runId: string;
  moduleId: PipelineModuleId;
  receivedAt: string;
}

export interface ModelAdapter {
  readonly identity: Readonly<Record<string, unknown>>;
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export interface PipelineStorageAdapter {
  readArtifact<T>(
    moduleId: PipelineModuleId,
    moduleVersion: string,
    inputFingerprint: string,
  ): Promise<VersionedArtifact<T> | undefined>;
  writeArtifact<T>(artifact: VersionedArtifact<T>): Promise<void>;
  writeModelResponse(response: StoredModelResponse): Promise<void>;
}

export type PipelineProgressState =
  | "queued"
  | "running"
  | "reused"
  | "completed"
  | "failed";

export interface PipelineProgressEvent {
  runId: string;
  moduleId: PipelineModuleId;
  moduleVersion: string;
  state: PipelineProgressState;
  at: string;
  elapsedMs?: number;
  errorKind?: PipelineErrorKind;
  message?: string;
}

export interface PipelineProgressAdapter {
  report(event: PipelineProgressEvent): Promise<void> | void;
}

export interface ModuleInputContext {
  runId: string;
  rootInput: unknown;
  artifacts: ReadonlyMap<PipelineModuleId, VersionedArtifact>;
}

/**
 * dependencyInputs contains only the dependency slices actually read by the
 * module. It is deliberately separate from dependency metadata so cache keys
 * do not become invalid merely because an unrelated field changed upstream.
 */
export interface PreparedModuleInput<T = unknown> {
  value: T;
  dependencyInputs?: Readonly<Record<string, unknown>>;
  modelIdentity?: Readonly<Record<string, unknown>>;
}

export interface ModuleExecutionContext {
  runId: string;
  moduleId: PipelineModuleId;
  moduleVersion: string;
  rootInput: unknown;
  artifacts: ReadonlyMap<PipelineModuleId, VersionedArtifact>;
  storage: PipelineStorageAdapter;
  model?: ModelAdapter;
  signal?: AbortSignal;
  now(): Date;
}

export interface PipelineModuleDefinition<TInput = unknown, TOutput = unknown> {
  id: PipelineModuleId;
  version: string;
  dependencies: readonly PipelineModuleId[];
  prepare(context: ModuleInputContext): PreparedModuleInput<TInput>;
  execute(input: TInput, context: ModuleExecutionContext): Promise<TOutput>;
}

export interface PipelineRunOptions {
  runId: string;
  rootInput: unknown;
  modules: readonly PipelineModuleDefinition<unknown, unknown>[];
  storage: PipelineStorageAdapter;
  model?: ModelAdapter;
  progress?: PipelineProgressAdapter;
  concurrency?: number;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface PipelineRunResult {
  runId: string;
  artifacts: ReadonlyMap<PipelineModuleId, VersionedArtifact>;
  executionOrder: string[];
  reusedModules: string[];
}

export type SemanticUnitKind =
  | "knowledge"
  | "case"
  | "visible-relationship"
  | "narration-step"
  | "assessment"
  | "evidence";

export type ActionSupport = "none" | "helpful" | "essential";

export interface SemanticTeachingUnit {
  id: string;
  kind: SemanticUnitKind;
  text: string;
  actionSupport: ActionSupport;
}

export interface SemanticTeachingPage {
  id: string;
  page: number;
  purpose: string;
  priorKnowledge: string;
  units: SemanticTeachingUnit[];
  targetDurationSec?: number;
}

export interface SemanticTeachingPlan {
  version: 1;
  courseId: string;
  pages: SemanticTeachingPage[];
}

export interface SlideElementBinding {
  semanticId: string;
  elementIds: string[];
}

export interface SlideModuleOutput {
  pageId: string;
  content: GeneratedSlideContent;
  bindings: SlideElementBinding[];
}

export interface NarrationAnchor {
  id: string;
  semanticId: string;
  quote: string;
  occurrence?: number;
}

export interface NarrationSegment {
  id: string;
  pageId: string;
  text: string;
  semanticIds: string[];
  anchors?: NarrationAnchor[];
}

export interface NarrationModuleOutput {
  pageId: string;
  segments: NarrationSegment[];
}

export interface ActionModuleOutput {
  pageId: string;
  actions: Action[];
}
