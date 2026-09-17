import { describe, expect, it } from 'vitest';
import { wrapResponseWithReasoning } from './reasoning-sse';

describe('reasoning SSE normalization', () => {
  it('turns a bare provider stream failure into an OpenAI-compatible error event', async () => {
    const response = new Response(
      'data: {"code":"InternalError","message":"Receive batching backend response failed!","request_id":"request-123"}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
    const body = await wrapResponseWithReasoning(response).text();
    expect(body).toContain('"error"');
    expect(body).toContain('"code":"InternalError"');
    expect(body).toContain('request_id=request-123');
    expect(body).not.toContain('"choices"');
  });
});
