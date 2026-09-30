/** Verification-only SDK observer. It never changes model/request/retry settings. */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { generateText, streamText } from "ai";
import type { CourseGenerationCallUsage } from "../src/lib/course-generation/llm-concurrency";
import { writeJsonAtomic } from "../tools/course-quality-lab/storage";

let directory: string | undefined;
let sequence = 0;
export type VerificationCallUsage = CourseGenerationCallUsage & {
  logicalCallId: string;
  authoringStage?: string;
  outlineId?: string;
  inputSha256: string;
  textCharacters: number;
  reasoningCharacters: number;
  providerRejectedBeforeOutput: boolean;
};
const usageRecords: VerificationCallUsage[] = [];
const authoring = new AsyncLocalStorage<{ authoringStage: string; outlineId: string }>();
const starts: Array<Record<string, unknown>> = [];
let saves: Promise<void> = Promise.resolve();

export function setVerificationInstrumentationDirectory(value: string): void {
  directory = value;
}

export function verificationUsageRecords(): VerificationCallUsage[] {
  return [...usageRecords];
}

/** Observer context only: preserves the original generator, including baseline repairs. */
export function withVerificationAuthoringStage<T>(
  authoringStage: string,
  outlineId: string,
  operation: () => T,
): T {
  return authoring.run({ authoringStage, outlineId }, operation);
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeUsage(value: unknown) {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const input = raw.inputTokens && typeof raw.inputTokens === "object" ? raw.inputTokens as Record<string, unknown> : {};
  const output = raw.outputTokens && typeof raw.outputTokens === "object" ? raw.outputTokens as Record<string, unknown> : {};
  const inputDetails = raw.inputTokenDetails as Record<string, unknown> | undefined;
  const outputDetails = raw.outputTokenDetails as Record<string, unknown> | undefined;
  return {
    inputTokens: finite(input.total) ?? finite(raw.inputTokens) ?? finite(raw.promptTokens),
    outputTokens: finite(output.total) ?? finite(raw.outputTokens) ?? finite(raw.completionTokens),
    cacheReadTokens: finite(input.cacheRead) ?? finite(inputDetails?.cacheReadTokens) ?? finite(raw.cachedInputTokens),
    cacheWriteTokens: finite(input.cacheWrite) ?? finite(inputDetails?.cacheWriteTokens),
    reasoningTokens: finite(output.reasoning) ?? finite(outputDetails?.reasoningTokens) ?? finite(raw.reasoningTokens),
    totalTokens: finite(raw.totalTokens),
  };
}

function refusalBeforeOutput(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as Record<string, unknown>;
  return [429, 503].includes(Number(record.statusCode ?? record.status));
}

function instrumentModel(model: unknown, source: string) {
  if (!model || typeof model !== "object") throw new Error("成本重放需要已解析的正式模型对象");
  const target = model as Record<string, unknown>;
  let attempt = 0;
  const logicalCallId = randomUUID();
  return new Proxy(target, {
    get(object, property, receiver) {
      const original = Reflect.get(object, property, receiver);
      if ((property !== "doGenerate" && property !== "doStream") || typeof original !== "function") return original;
      return async (params: Record<string, unknown>) => {
        if (!directory) throw new Error("成本记录目录尚未初始化");
        const folder = directory;
        const callSequence = ++sequence;
        const callId = randomUUID();
        const callAttempt = ++attempt;
        const serializedPrompt = JSON.stringify(params.prompt ?? []);
        const inputCharacters = serializedPrompt.length;
        const base = { callId, source, logicalCallId, ...authoring.getStore(),
          inputSha256: createHash("sha256").update(serializedPrompt).digest("hex"), modelId: String(object.modelId ?? "unknown"),
          provider: String(object.provider ?? "unknown"), attempt: callAttempt, transportRetry: callAttempt > 1 };
        starts.push({ ...base, sequence: callSequence, at: new Date().toISOString(), inputCharacters,
          maxOutputTokens: params.maxOutputTokens, providerOptions: params.providerOptions });
        saves = saves.then(() => writeJsonAtomic(path.join(folder, "provider-attempts.json"), starts));
        await saves;
        let text = "", reasoningCharacters = 0;
        let reported: unknown;
        let finishReason: unknown;
        let recorded = false;
        const record = async (outcome: CourseGenerationCallUsage["outcome"], error?: unknown) => {
          if (recorded) return;
          recorded = true;
          const usage = normalizeUsage(reported);
          const knownTotal = usage.totalTokens ?? (usage.inputTokens !== undefined && usage.outputTokens !== undefined
            ? usage.inputTokens + usage.outputTokens : undefined);
          const rejected = text.length === 0 && reasoningCharacters === 0 && refusalBeforeOutput(error);
          const event: VerificationCallUsage = {
            ...base, ...usage, outcome, textCharacters: text.length, reasoningCharacters,
            providerRejectedBeforeOutput: rejected,
            totalTokens: knownTotal ?? (rejected ? 0 : Math.ceil((inputCharacters + text.length + reasoningCharacters) / 2.5)),
            usageSource: knownTotal !== undefined ? "provider" : "estimated",
          };
          usageRecords.push(event);
          saves = saves.then(async () => {
            await fs.mkdir(folder, { recursive: true });
            await fs.writeFile(path.join(folder, `provider-${String(callSequence).padStart(3, "0")}-response.txt`), text, { mode: 0o600 });
            await writeJsonAtomic(path.join(folder, "provider-usage.json"), usageRecords);
          });
          await saves;
        };
        try {
          const result = await Reflect.apply(original, object, [params]) as Record<string, unknown>;
          if (property === "doGenerate") {
            text = Array.isArray(result.content) ? result.content.filter((part) => part.type === "text")
              .map((part) => part.text).join("") : String(result.text ?? "");
            reasoningCharacters = Array.isArray(result.content) ? result.content.filter((part) => part.type === "reasoning")
              .reduce((sum, part) => sum + String(part.text ?? "").length, 0) : 0;
            reported = result.usage;
            finishReason = typeof result.finishReason === "object" && result.finishReason
              ? (result.finishReason as { unified?: unknown }).unified : result.finishReason;
            await record(["length", "content-filter", "error"].includes(String(finishReason)) ? "failed" : "response");
            return result;
          }
          const reader = (result.stream as ReadableStream<Record<string, unknown>>).getReader();
          const observed = new ReadableStream<Record<string, unknown>>({
            async pull(controller) {
              try {
                const next = await reader.read();
                if (next.done) {
                  await record(finishReason ? "response" : "failed");
                  controller.close();
                  return;
                }
                const part = next.value;
                if (part.type === "text-delta") text += String(part.delta ?? part.text ?? "");
                if (part.type === "reasoning-delta") reasoningCharacters += String(part.delta ?? part.text ?? "").length;
                if (part.type === "finish") {
                  reported = part.usage;
                  finishReason = typeof part.finishReason === "object" && part.finishReason
                    ? (part.finishReason as { unified?: unknown }).unified : part.finishReason;
                  await record(["length", "content-filter", "error"].includes(String(finishReason)) ? "failed" : "response");
                }
                if (part.type === "error") await record("failed", part.error);
                controller.enqueue(part);
              } catch (error) {
                await record("failed", error);
                controller.error(error);
              }
            },
            async cancel(reason) {
              await record("aborted", reason);
              await reader.cancel(reason);
            },
          });
          return { ...result, stream: observed };
        } catch (error) {
          await record("failed", error);
          throw error;
        }
      };
    },
  });
}

export function instrumentedGenerateText(params: Parameters<typeof generateText>[0], source = "unknown") {
  return generateText({ ...params, model: instrumentModel(params.model, source) as typeof params.model });
}

export function instrumentedStreamText(params: Parameters<typeof streamText>[0], source = "unknown") {
  return streamText({ ...params, model: instrumentModel(params.model, source) as typeof params.model });
}
