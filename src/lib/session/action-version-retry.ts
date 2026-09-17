export class SessionActionRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly currentVersion?: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "SessionActionRequestError";
  }
}

export async function retryVersionConflict<T>(
  send: (expectedVersion: number | undefined) => Promise<T>,
  initialVersion: number | undefined,
  maxAttempts = 5,
): Promise<T> {
  let expectedVersion = initialVersion;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await send(expectedVersion);
    } catch (error) {
      const canRetryVersion =
        error instanceof SessionActionRequestError &&
        ((error.status === 409 && error.code === "VERSION_CONFLICT") ||
          (error.status === 428 && error.code === "EXPECTED_VERSION_REQUIRED")) &&
        Number.isSafeInteger(error.currentVersion);
      // Every application-level 400 has a structured code such as
      // INVALID_ACTION or COURSE_MISMATCH. The generic fallback means an edge
      // or interrupted response supplied no readable JSON body. Retrying the
      // same idempotent requestId is safe and prevents a transient transport
      // failure from leaving the UI permanently in "保存失败".
      const canRetryUnstructured400 =
        error instanceof SessionActionRequestError &&
        error.status === 400 &&
        error.code === "SESSION_ACTION_FAILED_400";
      const canRetryTransientResponse =
        error instanceof SessionActionRequestError &&
        (
          error.status === 408
          || (error.status === 409 && error.code === "REQUEST_IN_PROGRESS")
          || error.status === 425
          || error.status === 429
          || error.status >= 500
        );
      const canRetryTransport = error instanceof TypeError;
      if (
        (!canRetryVersion
          && !canRetryUnstructured400
          && !canRetryTransientResponse
          && !canRetryTransport)
        || attempt >= maxAttempts
      ) {
        throw error;
      }
      if (canRetryVersion) expectedVersion = error.currentVersion;
      // All course actions carry the same requestId across attempts, so
      // retrying transport/server contention is idempotent.
      await new Promise((resolve) => setTimeout(resolve, attempt * 80));
    }
  }
  throw new Error("SESSION_ACTION_RETRY_EXHAUSTED");
}
