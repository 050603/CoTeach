// Read-only report. Input: JSON application logs, or `journalctl -o json` lines.
// Example: journalctl --user -u openpbl.service --since today -o json | node scripts/report-classroom-ai-usage.mjs
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const input = process.argv[2] ? createReadStream(process.argv[2]) : process.stdin;
const groups = new Map();
const seen = new Set();
for await (const line of createInterface({ input, crlfDelay: Infinity })) {
  let item;
  try {
    item = JSON.parse(line);
    if (typeof item.MESSAGE === 'string') item = JSON.parse(item.MESSAGE);
  } catch { continue; }
  if (!['classroom-ai-usage', 'classroom-ai-cache'].includes(item?.event)) continue;
  const key = String(item.feature || 'unknown');
  const group = groups.get(key) ?? { feature: key, calls: 0, failed: 0, aborted: 0,
    usageUnknownCalls: 0, inputTokensKnown: 0, outputTokensKnown: 0, cacheReadTokensKnown: 0,
    knownInputCalls: 0, knownOutputCalls: 0, resultHits: 0, resultMisses: 0, joinedRequests: 0 };
  groups.set(key, group);
  if (item.event === 'classroom-ai-cache') {
    if (item.outcome === 'hit') group.resultHits++;
    if (item.outcome === 'miss') group.resultMisses++;
    if (item.outcome === 'joined') group.joinedRequests++;
    continue;
  }
  if (typeof item.callId === 'string') {
    if (seen.has(item.callId)) continue;
    seen.add(item.callId);
  }
  group.calls++;
  if (item.outcome === 'failed') group.failed++;
  if (item.outcome === 'aborted') group.aborted++;
  if (item.usageSource === 'unknown') group.usageUnknownCalls++;
  for (const [field, target, coverage] of [
    ['inputTokens', 'inputTokensKnown', 'knownInputCalls'],
    ['outputTokens', 'outputTokensKnown', 'knownOutputCalls'],
    ['cacheReadTokens', 'cacheReadTokensKnown', null],
  ]) {
    if (typeof item[field] === 'number' && Number.isFinite(item[field]) && item[field] >= 0) {
      group[target] += item[field];
      if (coverage) group[coverage]++;
    }
  }
}
process.stdout.write(JSON.stringify({
  kind: 'classroom-ai-usage',
  note: '仅汇总日志中实际可见的模型调用及供应商用量；缺失用量不是零费用。SDK内部传输重试与货币费用需供应商账单核对。',
  features: [...groups.values()],
}, null, 2) + '\n');
