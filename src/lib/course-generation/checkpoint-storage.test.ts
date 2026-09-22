import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  transaction: vi.fn(),
  lockJob: vi.fn(),
  findJob: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  prisma: {
    $transaction: mocks.transaction,
    generationCheckpoint: { upsert: mocks.upsert },
  },
}));

import { saveGenerationCheckpoint } from "./checkpoint-storage";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.transaction.mockImplementation((operation) => operation({
    $queryRaw: mocks.lockJob,
    generationJob: { findUnique: mocks.findJob },
    generationCheckpoint: { upsert: mocks.upsert },
  }));
  mocks.findJob.mockResolvedValue({
    status: "RUNNING",
    trace: { state: { executionId: "execution-current" } },
  });
});

describe("generation checkpoint execution ownership", () => {
  it("persists a checkpoint while the execution lease is still owned", async () => {
    await saveGenerationCheckpoint("job-1", "page:one", { ready: true }, {
      executionId: "execution-current",
    });

    expect(mocks.lockJob).toHaveBeenCalledOnce();
    expect(mocks.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { jobId_step: { jobId: "job-1", step: "page:one" } },
    }));
  });

  it("rejects a checkpoint from an expired execution", async () => {
    await expect(saveGenerationCheckpoint("job-1", "page:one", { stale: true }, {
      executionId: "execution-expired",
    })).rejects.toThrow("GENERATION_JOB_EXECUTION_LOST");

    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rejects a checkpoint after cancellation changed the job status", async () => {
    mocks.findJob.mockResolvedValue({
      status: "CANCELLING",
      trace: { state: { executionId: "execution-current" } },
    });

    await expect(saveGenerationCheckpoint("job-1", "page:one", { stale: true }, {
      executionId: "execution-current",
    })).rejects.toThrow("GENERATION_JOB_EXECUTION_LOST");
    expect(mocks.upsert).not.toHaveBeenCalled();
  });
});
