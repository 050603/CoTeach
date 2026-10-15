export interface SseEvent {
  event: string;
  data: string;
}

/** Incremental SSE framing, including comments and CR/LF split across chunks. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';
  let data: string[] = [];

  const drain = (final: boolean): SseEvent[] => {
    const events: SseEvent[] = [];
    const line = (value: string) => {
      if (value === '') {
        if (data.length) events.push({ event: event || 'message', data: data.join('\n') });
        event = '';
        data = [];
        return;
      }
      if (value.startsWith(':')) return;
      const colon = value.indexOf(':');
      const field = colon < 0 ? value : value.slice(0, colon);
      const content = colon < 0 ? '' : value.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = content;
      if (field === 'data') data.push(content);
    };
    for (;;) {
      const end = buffer.search(/[\r\n]/);
      if (end < 0 || (!final && buffer[end] === '\r' && end === buffer.length - 1)) break;
      const size = buffer[end] === '\r' && buffer[end + 1] === '\n' ? 2 : 1;
      line(buffer.slice(0, end));
      buffer = buffer.slice(end + size);
    }
    if (final) {
      if (buffer) line(buffer);
      buffer = '';
      line('');
    }
    return events;
  };

  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    for (;;) {
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      const { value, done } = await reader.read();
      if (signal.aborted) throw new DOMException('The operation was aborted.', 'AbortError');
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      for (const frame of drain(done)) yield frame;
      if (done) return;
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
