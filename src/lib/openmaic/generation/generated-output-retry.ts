import { withGenerationRetry, type GenerationRetryEvent } from './generation-retry';

const INVALID_GENERATED_OUTPUT = 'invalid-generated-output';

type InvalidGeneratedOutputError = Error & {
  generationFailureKind: typeof INVALID_GENERATED_OUTPUT;
  isRetryable: true;
};

export function invalidGeneratedOutput(error: unknown, context: string): InvalidGeneratedOutputError {
  const detail = error instanceof Error ? error.message : String(error);
  // Do not attach the source error as `cause`: the generic transport retry
  // classifier intentionally lets a nested provider error override broad
  // retry flags. This marker is already the authoritative classification for
  // a completed but unusable response.
  return Object.assign(new Error(`${context}: ${detail}`), {
    generationFailureKind: 'invalid-generated-output' as const,
    isRetryable: true as const,
  });
}

export function isInvalidGeneratedOutput(error: unknown): error is InvalidGeneratedOutputError {
  return Boolean(error && typeof error === 'object'
    && 'generationFailureKind' in error
    && error.generationFailureKind === INVALID_GENERATED_OUTPUT);
}

/**
 * Retry only when a completed model response cannot become a usable artifact.
 * Semantic quality is deliberately outside this policy and belongs to the
 * teacher checkpoint after each generated stage.
 */
export function withGeneratedOutputRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    label: string;
    signal?: AbortSignal;
    maxRetries?: number;
    onRetry?: (event: GenerationRetryEvent) => Promise<void> | void;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<T> {
  return withGenerationRetry(operation, {
    ...options,
    shouldRetryError: isInvalidGeneratedOutput,
  });
}
