import { PipelineError } from "./errors";
import { runPipeline } from "./scheduler";
import type {
  PipelineErrorKind,
  PipelineModuleDefinition,
  PipelineRunResult,
  PipelineStorageAdapter,
  VersionedArtifact,
} from "./types";

export interface LongCourseReplayPage {
  id: string;
  title: string;
  visibleRelationship: string;
  narration: string;
}

export interface LongCourseReplayFixture {
  id: string;
  pages: LongCourseReplayPage[];
}

export interface ReplayFault {
  moduleId: string;
  attempt: number;
  kind: PipelineErrorKind;
  message?: string;
}

export interface ReplayTelemetry {
  starts: string[];
  completions: string[];
  attempts: ReadonlyMap<string, number>;
  maxActive: number;
}

type ReplayArtifact = VersionedArtifact<Record<string, unknown>>;

function artifactValue(
  artifacts: ReadonlyMap<string, VersionedArtifact>,
  moduleId: string,
): Record<string, unknown> {
  const artifact = artifacts.get(moduleId) as ReplayArtifact | undefined;
  if (!artifact) throw new Error(`Replay dependency ${moduleId} is missing`);
  return artifact.value;
}

class ReplayRuntime {
  private readonly attemptsByModule = new Map<string, number>();
  private active = 0;
  maxActive = 0;
  readonly starts: string[] = [];
  readonly completions: string[] = [];

  constructor(private readonly faults: readonly ReplayFault[]) {}

  async execute<T>(moduleId: string, factory: () => T): Promise<T> {
    const attempt = (this.attemptsByModule.get(moduleId) ?? 0) + 1;
    this.attemptsByModule.set(moduleId, attempt);
    this.starts.push(moduleId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      // Yield once so deterministic replay can prove independent modules were
      // in flight together without using wall-clock sleeps.
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      const fault = this.faults.find((candidate) =>
        candidate.moduleId === moduleId && candidate.attempt === attempt,
      );
      if (fault) {
        throw new PipelineError(
          fault.kind,
          fault.message ?? `Injected ${fault.kind} fault in ${moduleId}`,
          { moduleId },
        );
      }
      const value = factory();
      this.completions.push(moduleId);
      return value;
    } finally {
      this.active -= 1;
    }
  }

  telemetry(): ReplayTelemetry {
    return {
      starts: [...this.starts],
      completions: [...this.completions],
      attempts: new Map(this.attemptsByModule),
      maxActive: this.maxActive,
    };
  }
}

function replayModule<I, O>(
  definition: PipelineModuleDefinition<I, O>,
): PipelineModuleDefinition<unknown, unknown> {
  return definition as PipelineModuleDefinition<unknown, unknown>;
}

export function createLongCourseReplayFixture(pageCount = 36): LongCourseReplayFixture {
  if (!Number.isInteger(pageCount) || pageCount < 1) throw new Error("Replay page count must be positive");
  return {
    id: `fixed-long-course-${pageCount}`,
    pages: Array.from({ length: pageCount }, (_, index) => {
      const page = index + 1;
      return {
        id: `page-${String(page).padStart(3, "0")}`,
        title: `固定课程第 ${page} 页`,
        visibleRelationship: `概念 ${page} 通过证据 ${page} 支持结论 ${page}`,
        narration: `先观察证据 ${page}，再解释它怎样支持概念 ${page}，最后说明结论 ${page} 的适用边界。`,
      };
    }),
  };
}

export function createLongCourseReplayModules(
  fixture: LongCourseReplayFixture,
  runtime: ReplayRuntime,
): PipelineModuleDefinition<unknown, unknown>[] {
  const modules: PipelineModuleDefinition<unknown, unknown>[] = [];
  modules.push(replayModule({
    id: "plan",
    version: "replay-plan-v1",
    dependencies: [],
    prepare: ({ rootInput }) => ({ value: rootInput }),
    execute: (input) => runtime.execute("plan", () => input as Record<string, unknown>),
  }));

  for (const page of fixture.pages) {
    const slideId = `slide:${page.id}`;
    const narrationId = `narration:${page.id}`;
    const actionId = `actions:${page.id}`;
    const reviewId = `review:${page.id}`;
    const audioId = `audio:${page.id}`;
    modules.push(replayModule({
      id: slideId,
      version: "replay-slide-v1",
      dependencies: ["plan"],
      prepare: () => ({
        value: { pageId: page.id, title: page.title, relationship: page.visibleRelationship },
        dependencyInputs: { page: { id: page.id, relationship: page.visibleRelationship } },
      }),
      execute: (input) => runtime.execute(slideId, () => input as Record<string, unknown>),
    }));
    modules.push(replayModule({
      id: narrationId,
      version: "replay-narration-v1",
      dependencies: ["plan"],
      prepare: () => ({
        value: { pageId: page.id, narration: page.narration },
        dependencyInputs: { page: { id: page.id, narration: page.narration } },
      }),
      execute: (input) => runtime.execute(narrationId, () => input as Record<string, unknown>),
    }));
    modules.push(replayModule({
      id: actionId,
      version: "replay-actions-v1",
      dependencies: [slideId, narrationId],
      prepare: ({ artifacts }) => {
        const slide = artifactValue(artifacts, slideId);
        const narration = artifactValue(artifacts, narrationId);
        return { value: { pageId: page.id, slide, narration }, dependencyInputs: { slide, narration } };
      },
      execute: (input) => runtime.execute(actionId, () => ({
        pageId: page.id,
        cue: `${JSON.stringify(input)}:bound`,
      })),
    }));
    modules.push(replayModule({
      id: reviewId,
      version: "replay-review-v1",
      dependencies: [slideId, narrationId, actionId],
      prepare: ({ artifacts }) => ({
        value: {
          slide: artifactValue(artifacts, slideId),
          narration: artifactValue(artifacts, narrationId),
          actions: artifactValue(artifacts, actionId),
        },
      }),
      execute: () => runtime.execute(reviewId, () => ({ pageId: page.id, passed: true })),
    }));
    modules.push(replayModule({
      id: audioId,
      version: "replay-audio-v1",
      dependencies: [narrationId, reviewId],
      prepare: ({ artifacts }) => ({
        value: artifactValue(artifacts, narrationId),
        dependencyInputs: { narration: artifactValue(artifacts, narrationId) },
      }),
      execute: (input) => runtime.execute(audioId, () => ({ pageId: page.id, source: input })),
    }));
  }

  const narrationIds = fixture.pages.map((page) => `narration:${page.id}`);
  const reviewIds = fixture.pages.map((page) => `review:${page.id}`);
  modules.push(replayModule({
    id: "quiz",
    version: "replay-quiz-v1",
    dependencies: [...narrationIds, ...reviewIds],
    prepare: ({ artifacts }) => {
      const narration = narrationIds.map((id) => artifactValue(artifacts, id));
      return { value: narration, dependencyInputs: { narration } };
    },
    execute: (input) => runtime.execute("quiz", () => ({ questions: (input as unknown[]).length })),
  }));

  const slideIds = fixture.pages.map((page) => `slide:${page.id}`);
  const actionIds = fixture.pages.map((page) => `actions:${page.id}`);
  modules.push(replayModule({
    id: "export",
    version: "replay-export-v1",
    dependencies: [...slideIds, ...actionIds, "quiz"],
    prepare: ({ artifacts }) => ({
      value: {
        slides: slideIds.map((id) => artifactValue(artifacts, id)),
        actions: actionIds.map((id) => artifactValue(artifacts, id)),
        quiz: artifactValue(artifacts, "quiz"),
      },
    }),
    execute: (input) => runtime.execute("export", () => ({ bundle: input, complete: true })),
  }));
  return modules;
}

export async function runLongCourseReplay(options: {
  fixture?: LongCourseReplayFixture;
  faults?: readonly ReplayFault[];
  storage: PipelineStorageAdapter;
  runId?: string;
  concurrency?: number;
}): Promise<{ result: PipelineRunResult; telemetry: ReplayTelemetry }> {
  const fixture = options.fixture ?? createLongCourseReplayFixture();
  const runtime = new ReplayRuntime(options.faults ?? []);
  const result = await runPipeline({
    runId: options.runId ?? `replay:${fixture.id}`,
    rootInput: fixture,
    modules: createLongCourseReplayModules(fixture, runtime),
    storage: options.storage,
    concurrency: options.concurrency ?? 8,
  });
  return { result, telemetry: runtime.telemetry() };
}
