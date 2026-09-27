import { createHash } from 'node:crypto';
import { assessProactiveDocumentComment, type ProactiveDocumentEvidenceContext } from './document-comment-policy';
import type { StructuredModelAttempt } from './recorded-structured-response';

export type SingleReviewAttempt = StructuredModelAttempt & { policyReasonCodes?: string[] };

/** Structural presence only: semantic enum/evidence decisions belong to the strict policy. */
export function missingPositiveReviewFields(value: Record<string, unknown>): string[] {
  if (value.shouldComment !== true) return [];
  return [
    ...['severity', 'issueType', 'quotedText', 'evidenceSource', 'evidenceQuote', 'impact', 'comment']
      .filter(key => typeof value[key] !== 'string' || !(value[key] as string).trim()),
    ...(typeof value.needsInterventionNow !== 'boolean' ? ['needsInterventionNow'] : []),
  ];
}

/** One repair at most, under the caller's original deadline. Never edit model quotes locally. */
export async function singleReviewResponse(input: {
  generate: (repairInstruction?: string) => Promise<string>;
  parse: (raw: string) => unknown;
  record: (attempt: SingleReviewAttempt) => Promise<void>;
  signal: AbortSignal;
  evidenceContext: ProactiveDocumentEvidenceContext & { targetText: string };
}): Promise<Record<string, unknown>> {
  let repairInstruction: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    input.signal.throwIfAborted();
    const raw = await input.generate(repairInstruction);
    let parsed: Record<string, unknown> | undefined;
    let validation: SingleReviewAttempt['validation'] = 'invalid-json';
    let missing: string[] = [];
    try {
      const value = input.parse(raw);
      validation = 'invalid-schema';
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const record = value as Record<string, unknown>;
        missing = missingPositiveReviewFields(record);
        if (typeof record.shouldComment === 'boolean' && !missing.length) {
          parsed = record; validation = 'valid';
        }
      }
    } catch { /* The unmodified original is recorded even if its JSON is malformed. */ }
    const policyReasonCodes = parsed
      ? assessProactiveDocumentComment(parsed, input.evidenceContext).decision.reasonCodes : undefined;
    // Persistence is outside parsing's catch; a recording failure must stop generation.
    await input.record({ raw, sha256: createHash('sha256').update(raw).digest('hex'), attempt, validation,
      ...(policyReasonCodes ? { policyReasonCodes } : {}) });
    input.signal.throwIfAborted();
    const overlappingEvidence = policyReasonCodes?.length === 1 && policyReasonCodes[0] === 'EVIDENCE_NOT_INDEPENDENT';
    if (parsed && (!overlappingEvidence || attempt === 2)) return parsed;
    if (attempt === 2) throw new Error('AI_RESPONSE_INVALID_STRUCTURE');
    const problem = validation === 'invalid-json'
      ? '上一条回答不是可解析的 JSON。字符串内的双引号必须按 JSON 规则转义；为避免引号嵌套，可用中文引号「」。不要补写或猜测原文中未出现的内容。'
      : overlappingEvidence
        ? '上一条正向提议未通过 EVIDENCE_NOT_INDEPENDENT：quotedText 与 evidenceQuote 相互包含。重新从原文定位最小的被质疑断言，不要把支持判断的数值和依据一起包进 quotedText。evidenceQuote 引用另一处独立依据；两者可以来自同一段，但不能相互包含。不得改写、拼接或虚构引文来绕过校验。'
        : `上一条回答的必需字段缺少或类型错误：${missing.length ? missing.join('、') : 'shouldComment（布尔值）及完整对象结构'}。`;
    repairInstruction = `${problem} 请重新核对原文，只返回完整严格 JSON。evidenceSource 必须明确为 document 或 course，evidenceQuote 必须逐字来自对应依据，不能编造或自动假定来源。保留原有介入和证据边界；无法确认需要介入时返回 {"shouldComment":false,"comment":""}。`;
  }
  throw new Error('UNREACHABLE_SINGLE_REVIEW');
}
