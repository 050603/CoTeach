import { recordedStructuredResponse, type StructuredModelAttempt } from './recorded-structured-response';

/** Structural presence only: semantic enum/evidence decisions belong to the strict policy. */
export function missingPositiveReviewFields(value: Record<string, unknown>): string[] {
  if (value.shouldComment !== true) return [];
  return [
    ...['severity', 'issueType', 'quotedText', 'evidenceSource', 'evidenceQuote', 'impact', 'comment']
      .filter(key => typeof value[key] !== 'string' || !(value[key] as string).trim()),
    ...(typeof value.needsInterventionNow !== 'boolean' ? ['needsInterventionNow'] : []),
  ];
}

/** Only a positive proposal missing required fields gets one recorded repair. */
export async function singleReviewResponse(input: {
  generate: (repairInstruction?: string) => Promise<string>;
  parse: (raw: string) => unknown;
  record: (attempt: StructuredModelAttempt) => Promise<void>;
  signal: AbortSignal;
}): Promise<Record<string, unknown>> {
  let missing: string[] = [];
  return recordedStructuredResponse({
    signal: input.signal, parse: input.parse, record: input.record, maxCalls: 2,
    valid: value => {
      missing = missingPositiveReviewFields(value);
      return typeof value.shouldComment === 'boolean' && missing.length === 0;
    },
    generate: attempt => {
      if (attempt === 1) return input.generate();
      if (!missing.length) throw new Error('AI_REVIEW_INVALID_STRUCTURE');
      return input.generate(`上一条正向批注缺少或错误填写必需字段：${missing.join('、')}。请重新核对原文，只返回完整严格 JSON。evidenceSource 必须明确为 document 或 course，evidenceQuote 必须逐字来自对应依据，不能编造或自动假定来源。保留原有介入和证据边界；无法确认需要介入时返回 {"shouldComment":false,"comment":""}。`);
    },
  });
}
