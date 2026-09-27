import { boundedFetch } from './bounded-fetch';
import { drainLearningWrites, enqueueLearningWrite } from './learning-outbox';
import { browserRandomUUID } from './random-uuid';

export async function flushAiInteractionEvents(scope: string): Promise<void> {
  await drainLearningWrites<Record<string, unknown>>(`ai-interactions:${scope}`, async (event) => {
    const body = JSON.stringify(event);
    const response = await boundedFetch('/api/ai-collaboration/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-OpenPBL-Role': 'student' },
      body,
      keepalive: new TextEncoder().encode(body).byteLength < 60_000,
    });
    if (!response.ok) throw new Error('协作过程记录尚未同步，恢复连接后将重试。');
  });
}

export function queueAiInteractionEvent(scope: string, event: Record<string, unknown>): void {
  const requestId = browserRandomUUID();
  enqueueLearningWrite(`ai-interactions:${scope}`, { ...event, createdAt: new Date().toISOString(), requestId }, requestId);
}
