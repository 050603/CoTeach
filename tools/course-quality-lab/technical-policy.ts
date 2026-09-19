import { MAX_COURSE_STAGE_MODEL_REQUESTS } from '@openmaic/lib/generation/course-generation-policy';

export const LAB_TECHNICAL_POLICY = {
  version: "technical-generation-v1",
  maxModelRequestsPerStage: MAX_COURSE_STAGE_MODEL_REQUESTS,
  modelIdleTimeoutMs: 300_000,
  modelMaxDurationMs: 600_000,
  maxTtsCallsPerSegment: 2,
  maxLocalStageAttempts: 2,
} as const;
