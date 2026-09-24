export const MAX_TRANSIENT_INFRASTRUCTURE_RECOVERIES = 3;

type RecoverableRequest = {
  courseId: string;
  teacherBrief: string;
  transientRecoveryCount?: number;
  [key: string]: unknown;
};

export type CourseDesignFailureKind =
  | "recoverable-generation"
  | "transient-infrastructure"
  | "terminal-quality"
  | "fatal-infrastructure";

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? "");
}

function isInvalidGeneratedOutput(error: unknown): boolean {
  return Boolean(error && typeof error === "object"
    && "generationFailureKind" in error
    && error.generationFailureKind === "invalid-generated-output");
}

const TRANSIENT_INFRASTRUCTURE_ERROR = /(?:ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|调用超时|请求超时|fetch failed|network|网络|socket hang up|429|rate.?limit|database (?:is )?(?:temporarily )?unavailable|P1001|P1002|P2024)/i;
const FATAL_INFRASTRUCTURE_ERROR = /(?:quota|API.?key|unauthori[sz]ed|forbidden|invalid credential|401|403|P20(?:00|01|02|03|10|11|12|21|22))/i;
const RECOVERABLE_GENERATION_ERROR = /(?:代理无法生成结构完整的数据|无法通过独立审校|未通过(?:独立)?(?:审校|质量门|校验)|未能补齐必要结构|未返回可保存的数据|Failed to parse scene outlines response|无法解析.*JSON|生成的数据结构不完整)/i;
const EXHAUSTED_LOCAL_REPAIR = /(?:目标与知识结构无法通过独立审校|课程入口学习包无法通过发布校验|编辑 Agent 无法完成审校修订|教学蓝图(?:缺少可用结构| JSON 无法解析)|必用教材原图.*没有可绑定的首次知识讲解页)/i;
const FATAL_CONFIG_MESSAGE = "AI 服务配置或访问权限异常，快速生成已停止；请检查模型服务密钥、额度和访问权限后重试。";
const INTERRUPTED_STREAM_MESSAGE = "AI 模型服务的流式连接中断，快速生成已安全停止；已完成的课程设计阶段均已保留，可直接重试。";

export function classifyCourseDesignFailure(error: unknown): CourseDesignFailureKind {
  const chain = errorChain(error);
  if (chain.some(isInvalidGeneratedOutput)) {
    return "terminal-quality";
  }
  if (chain.some((item) => FATAL_INFRASTRUCTURE_ERROR.test(messageOf(item)))) {
    return "fatal-infrastructure";
  }
  if (chain.some((item) => TRANSIENT_INFRASTRUCTURE_ERROR.test(messageOf(item)))) {
    return "transient-infrastructure";
  }
  if (chain.some((item) => EXHAUSTED_LOCAL_REPAIR.test(messageOf(item)))) {
    return "terminal-quality";
  }
  if (chain.some((item) => item instanceof SyntaxError)) {
    return "recoverable-generation";
  }
  return chain.some((item) => RECOVERABLE_GENERATION_ERROR.test(messageOf(item)))
    ? "recoverable-generation"
    : "fatal-infrastructure";
}

export function createTransientInfrastructureRecoveryRequest<T extends RecoverableRequest>(
  request: T,
  error: unknown,
): T | null {
  if (classifyCourseDesignFailure(error) !== "transient-infrastructure") return null;
  const recoveryCount = request.transientRecoveryCount ?? 0;
  if (recoveryCount >= MAX_TRANSIENT_INFRASTRUCTURE_RECOVERIES) return null;
  return {
    ...request,
    transientRecoveryCount: recoveryCount + 1,
  };
}

export function transientInfrastructureRetryDelayMs(recoveryCount: number): number {
  const boundedCount = Math.max(1, Math.min(MAX_TRANSIENT_INFRASTRUCTURE_RECOVERIES, recoveryCount));
  return [15_000, 45_000, 120_000][boundedCount - 1] ?? 120_000;
}

export function createManagedRecoveryRequest<T extends RecoverableRequest>(
  request: T,
  error: unknown,
): T | null {
  // Kept as a compatibility export for older callers and persisted tasks.
  // Completed course artifacts are never fed back into an automatic whole-job
  // rewrite. Invalid output is retried only inside its originating stage.
  void request;
  void error;
  return null;
}

export function formatFatalCourseDesignError(error: unknown): string {
  const chain = errorChain(error);
  const chainMessages = chain.map(messageOf).filter(Boolean);
  const messages = chainMessages.join(" ");
  if (chainMessages.includes(FATAL_CONFIG_MESSAGE)) return FATAL_CONFIG_MESSAGE;
  if (chainMessages.includes(INTERRUPTED_STREAM_MESSAGE)) return INTERRUPTED_STREAM_MESSAGE;
  if (chain.some(isInvalidGeneratedOutput)) {
    const detail = [...chainMessages].reverse().find(Boolean) ?? "本阶段输出结构不完整";
    return `当前课程阶段连续返回无法保存的结构，生成已停止且不会整项重跑；此前已经完成的内容仍会保留。具体原因：${detail.slice(0, 1_000)}`;
  }
  if (FATAL_INFRASTRUCTURE_ERROR.test(messages)) {
    return FATAL_CONFIG_MESSAGE;
  }
  if (TRANSIENT_INFRASTRUCTURE_ERROR.test(messages)) {
    return "网络或 AI 模型服务连接在多轮自动恢复后仍不可用，快速生成已安全停止；已完成的课程设计阶段均已保留，可在服务恢复后直接重试。";
  }
  if (chainMessages.some((message) => /^terminated$/i.test(message.trim())
    || /other side closed|UND_ERR_SOCKET/i.test(message))) {
    return INTERRUPTED_STREAM_MESSAGE;
  }
  if (EXHAUSTED_LOCAL_REPAIR.test(messages)) {
    const detail = [...chainMessages].reverse().find((message) => EXHAUSTED_LOCAL_REPAIR.test(message));
    const marker = "具体原因：";
    const unwrappedDetail = detail?.includes(marker)
      ? detail.slice(detail.lastIndexOf(marker) + marker.length)
      : detail;
    return `当前课程阶段未返回可保存的完整结构，生成已停止且不会整项重跑；此前已经完成的内容仍会保留。具体原因：${(unwrappedDetail || "本阶段输出结构不完整").slice(0, 1_000)}`;
  }
  return "快速生成遇到无法继续的系统错误，已安全停止；已完成的课程设计内容仍会保留，请稍后重试。";
}
