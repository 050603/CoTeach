import type { WebSocketServer } from 'ws';

type WebSocketLifecycle = {
  server: WebSocketServer | null;
  starting: Promise<WebSocketServer> | null;
  closing: Promise<void> | null;
  listening: boolean;
};
declare global {
  var __openPblWebSocketLifecycle: WebSocketLifecycle | undefined;
}
// Instrumentation and route entries can have distinct module factories. Their
// listener readiness must describe the same process-owned server.
export const webSocketLifecycle = globalThis.__openPblWebSocketLifecycle ??= {
  server: null, starting: null, closing: null, listening: false,
};

export function webSocketReadiness(): { ok: boolean; error?: string } {
  return webSocketLifecycle.listening && !webSocketLifecycle.closing && webSocketLifecycle.server?.address()
    ? { ok: true }
    : { ok: false, error: 'websocket_not_listening' };
}
