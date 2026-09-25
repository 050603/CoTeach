export class ProactiveReviewCapacityError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Proactive document review capacity is currently full');
    this.name = 'ProactiveReviewCapacityError';
    this.retryAfterMs = retryAfterMs;
  }
}

type ProactiveReviewCapacity = {
  run<T>(operation: () => Promise<T>): Promise<T>;
  snapshot(): { active: number; limit: number };
};

export function createProactiveReviewCapacity(
  rawLimit: number,
  retryAfterMs = 30_000,
): ProactiveReviewCapacity {
  const limit = Math.max(1, Math.floor(rawLimit));
  let active = 0;
  return {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (active >= limit) throw new ProactiveReviewCapacityError(retryAfterMs);
      active += 1;
      try {
        return await operation();
      } finally {
        active -= 1;
      }
    },
    snapshot: () => ({ active, limit }),
  };
}

function resolveProactiveReviewConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number.parseInt(env.PROACTIVE_REVIEW_LLM_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(configured) || configured <= 0) return 2;
  return Math.min(20, Math.max(1, configured));
}

declare global {
  var __openPblProactiveReviewCapacity: ProactiveReviewCapacity | undefined;
}

const capacity = globalThis.__openPblProactiveReviewCapacity
  ?? createProactiveReviewCapacity(resolveProactiveReviewConcurrency());
globalThis.__openPblProactiveReviewCapacity = capacity;

export function withProactiveReviewCapacity<T>(operation: () => Promise<T>): Promise<T> {
  return capacity.run(operation);
}
