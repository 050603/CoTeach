import { describe, expect, it, vi } from 'vitest';
import { readSse } from './read-sse';

async function frames(chunks: Uint8Array[]) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const result = [];
  for await (const frame of readSse(body, new AbortController().signal)) result.push(frame);
  expect(body.locked).toBe(false);
  return result;
}

describe('AI editor SSE framing', () => {
  it('reads fragmented UTF-8, CRLF, comments, multiline data and a final unterminated frame', async () => {
    const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: message\r\ndata: {"type":\r\ndata: "中文"}\r\n\r\n: heartbeat\r\n\r\nevent: close\r\ndata: {}');
    expect(await frames(Array.from(bytes, (value) => new Uint8Array([value])))).toEqual([
      { event: 'message', data: '{"type":\n"中文"}' },
      { event: 'close', data: '{}' },
    ]);
  });

  it('supports LF and standalone CR line endings', async () => {
    expect(await frames([new TextEncoder().encode('data: one\n\ndata: two\r\r')])).toEqual([
      { event: 'message', data: 'one' },
      { event: 'message', data: 'two' },
    ]);
  });

  it('cancels a pending body read promptly when aborted', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const abort = new AbortController();
    const iterator = readSse(body, abort.signal);
    const pending = iterator.next();
    abort.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
