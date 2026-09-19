import {
  classifyPipelineError,
  parseFailure,
  qualityFailure,
  structureFailure,
} from "./errors";
import type {
  ModelAdapter,
  ModelRequest,
  ModelResponse,
  PipelineIssue,
  PipelineStorageAdapter,
} from "./types";

export interface PersistedModelCallOptions<T> {
  runId: string;
  moduleId: string;
  request: ModelRequest;
  model: ModelAdapter;
  storage: PipelineStorageAdapter;
  parse(response: ModelResponse): T;
  validate?(value: T): void;
  review?(value: T): readonly PipelineIssue[];
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * Persists a successful provider response before parsing or validating it.
 * This makes parse/structure repair possible without paying for another model
 * call and keeps transport/cancellation failures distinct from content faults.
 */
export async function persistedModelCall<T>(options: PersistedModelCallOptions<T>): Promise<T> {
  let response: ModelResponse;
  try {
    response = await options.model.generate(options.request, options.signal);
  } catch (error) {
    throw classifyPipelineError(error, "transport", options.moduleId);
  }

  await options.storage.writeModelResponse({
    ...response,
    runId: options.runId,
    moduleId: options.moduleId,
    receivedAt: response.receivedAt ?? (options.now?.() ?? new Date()).toISOString(),
  });

  let parsed: T;
  try {
    parsed = options.parse(response);
  } catch (error) {
    throw parseFailure(error, options.moduleId);
  }

  try {
    options.validate?.(parsed);
  } catch (error) {
    throw structureFailure(error, options.moduleId);
  }

  const issues = options.review?.(parsed) ?? [];
  if (issues.some((issue) => issue.severity === "blocking")) {
    throw qualityFailure("Model output did not pass the quality gate", issues, options.moduleId);
  }
  return parsed;
}

