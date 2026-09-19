import { classifyPipelineError, PipelineError } from "./errors";
import { fingerprint, moduleInputFingerprint } from "./fingerprint";
import type {
  ArtifactReference,
  PipelineModuleDefinition,
  PipelineProgressEvent,
  PipelineRunOptions,
  PipelineRunResult,
  PipelineStorageAdapter,
  StoredModelResponse,
  VersionedArtifact,
} from "./types";

function artifactReference(artifact: VersionedArtifact): ArtifactReference {
  return {
    artifactId: artifact.artifactId,
    moduleId: artifact.moduleId,
    moduleVersion: artifact.moduleVersion,
    artifactFingerprint: artifact.artifactFingerprint,
  };
}

function assertValidGraph(modules: readonly PipelineModuleDefinition<unknown, unknown>[]): void {
  const byId = new Map(modules.map((definition) => [definition.id, definition]));
  if (byId.size !== modules.length) throw new Error("Pipeline module ids must be unique");
  for (const definition of modules) {
    for (const dependency of definition.dependencies) {
      if (!byId.has(dependency)) {
        throw new Error(`Module ${definition.id} depends on missing module ${dependency}`);
      }
      if (dependency === definition.id) throw new Error(`Module ${definition.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`Pipeline dependency cycle includes ${id}`);
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of byId.keys()) visit(id);
}

async function report(
  options: PipelineRunOptions,
  definition: PipelineModuleDefinition<unknown, unknown>,
  state: PipelineProgressEvent["state"],
  fields: Pick<PipelineProgressEvent, "elapsedMs" | "errorKind" | "message"> = {},
): Promise<void> {
  if (!options.progress) return;
  await options.progress.report({
    runId: options.runId,
    moduleId: definition.id,
    moduleVersion: definition.version,
    state,
    at: (options.now?.() ?? new Date()).toISOString(),
    ...fields,
  });
}

/**
 * A small dependency scheduler used by both the real V5 pipeline and replay
 * tests. Independent ready modules start together; this is what allows slide
 * and narration generation to share one plan without waiting for each other.
 */
export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
  assertValidGraph(options.modules);
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 4));
  const pending = new Map(options.modules.map((module) => [module.id, module]));
  const artifacts = new Map<string, VersionedArtifact>();
  const running = new Map<string, Promise<void>>();
  const executionOrder: string[] = [];
  const reusedModules: string[] = [];
  const now = options.now ?? (() => new Date());
  let firstError: unknown;

  const start = (definition: PipelineModuleDefinition<unknown, unknown>): void => {
    pending.delete(definition.id);
    const task = (async () => {
      const startedAt = Date.now();
      await report(options, definition, "running");
      try {
        if (options.signal?.aborted) {
          throw new DOMException("Pipeline run cancelled", "AbortError");
        }
        const prepared = definition.prepare({
          runId: options.runId,
          rootInput: options.rootInput,
          artifacts,
        });
        const inputFingerprint = moduleInputFingerprint({
          moduleId: definition.id,
          moduleVersion: definition.version,
          value: prepared.value,
          dependencyInputs: prepared.dependencyInputs,
          modelIdentity: prepared.modelIdentity ?? options.model?.identity,
        });
        const cached = await options.storage.readArtifact(
          definition.id,
          definition.version,
          inputFingerprint,
        );
        if (cached) {
          artifacts.set(definition.id, cached);
          reusedModules.push(definition.id);
          await report(options, definition, "reused", { elapsedMs: Date.now() - startedAt });
          return;
        }

        const value = await definition.execute(prepared.value, {
          runId: options.runId,
          moduleId: definition.id,
          moduleVersion: definition.version,
          rootInput: options.rootInput,
          artifacts,
          storage: options.storage,
          model: options.model,
          signal: options.signal,
          now,
        });
        const artifactFingerprint = fingerprint(value);
        const artifact: VersionedArtifact = {
          artifactId: `${definition.id}:${definition.version}:${artifactFingerprint}`,
          moduleId: definition.id,
          moduleVersion: definition.version,
          artifactFingerprint,
          inputFingerprint,
          runId: options.runId,
          createdAt: now().toISOString(),
          dependencies: definition.dependencies.map((dependency) => {
            const artifact = artifacts.get(dependency);
            if (!artifact) throw new Error(`Dependency ${dependency} disappeared during ${definition.id}`);
            return artifactReference(artifact);
          }),
          value,
        };
        // Persist before publishing completion so a cancelled outer run can
        // reuse every successful module rather than repeat its model request.
        await options.storage.writeArtifact(artifact);
        artifacts.set(definition.id, artifact);
        executionOrder.push(definition.id);
        await report(options, definition, "completed", { elapsedMs: Date.now() - startedAt });
      } catch (error) {
        const classified = classifyPipelineError(error, "transport", definition.id);
        firstError ??= classified;
        await report(options, definition, "failed", {
          elapsedMs: Date.now() - startedAt,
          errorKind: classified.kind,
          message: classified.message,
        });
        throw classified;
      }
    })();
    running.set(definition.id, task);
    void task.then(
      () => running.delete(definition.id),
      () => running.delete(definition.id),
    );
  };

  for (const definition of options.modules) await report(options, definition, "queued");

  while (pending.size > 0 || running.size > 0) {
    if (!firstError) {
      const ready = [...pending.values()].filter((definition) =>
        definition.dependencies.every((dependency) => artifacts.has(dependency)),
      );
      while (ready.length > 0 && running.size < concurrency) {
        start(ready.shift() as PipelineModuleDefinition<unknown, unknown>);
      }
    }

    if (running.size === 0) {
      if (firstError) throw firstError;
      throw new Error(`Pipeline stalled with pending modules: ${[...pending.keys()].join(", ")}`);
    }
    try {
      await Promise.race(running.values());
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError) throw firstError;

  return {
    runId: options.runId,
    artifacts,
    executionOrder,
    reusedModules,
  };
}

/** In-memory adapter for deterministic tests and fixed-data replays. */
export class MemoryPipelineStorage implements PipelineStorageAdapter {
  private readonly artifacts = new Map<string, VersionedArtifact>();
  readonly modelResponses: StoredModelResponse[] = [];

  private key(moduleId: string, moduleVersion: string, inputFingerprint: string): string {
    return `${moduleId}\u0000${moduleVersion}\u0000${inputFingerprint}`;
  }

  async readArtifact<T>(
    moduleId: string,
    moduleVersion: string,
    inputFingerprint: string,
  ): Promise<VersionedArtifact<T> | undefined> {
    return this.artifacts.get(this.key(moduleId, moduleVersion, inputFingerprint)) as
      | VersionedArtifact<T>
      | undefined;
  }

  async writeArtifact<T>(artifact: VersionedArtifact<T>): Promise<void> {
    this.artifacts.set(
      this.key(artifact.moduleId, artifact.moduleVersion, artifact.inputFingerprint),
      artifact,
    );
  }

  async writeModelResponse(response: StoredModelResponse): Promise<void> {
    this.modelResponses.push(structuredClone(response));
  }

  artifactCount(): number {
    return this.artifacts.size;
  }
}

export { PipelineError };
