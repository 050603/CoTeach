/** Await a real subscription ACK, disposing failed sockets before any retry. */
export function subscribeCapacitySocket(socket, { courseId, address, timeoutMs, onMessage = () => {} }) {
  return new Promise((resolve, reject) => {
    let settled = false, subscribed = false;
    const fail = (message, retryable = false) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const error = message instanceof Error ? message : new Error(message);
      error.retryable = retryable;
      socket.terminate(); reject(error);
    };
    const timer = setTimeout(() => fail('WebSocket subscribe timeout', true), timeoutMs);
    // Keep an error handler after settlement/termination: ws may emit a late
    // transport error while disposing a failed opening handshake.
    socket.on('error', error => fail(error, /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE)$/.test(error.code ?? '') || /timed out/i.test(error.message)));
    socket.on('unexpected-response', (_request, response) => {
      response.resume();
      fail(`WebSocket upgrade HTTP ${response.statusCode}`, response.statusCode >= 500);
    });
    socket.once('close', code => fail(`WebSocket closed before subscription (${code})`, [1001, 1006, 1011].includes(code)));
    socket.once('open', () => {
      const peer = socket._socket?.remoteAddress?.replace(/^::ffff:/, '');
      if (peer !== address) { fail(`WebSocket used unexpected address: ${peer}`); return; }
      socket.send(JSON.stringify({ type: 'subscribe', courseId }));
    });
    socket.on('message', data => {
      let message; try { message = JSON.parse(data.toString()); } catch { return; }
      if (!settled && message.type === 'error') { fail(`WebSocket subscription ${message.code}`, message.code === 'SERVICE_UNAVAILABLE'); return; }
      if (!settled && message.type === 'subscribed' && message.courseId === courseId) { settled = true; subscribed = true; clearTimeout(timer); resolve(); }
      if (subscribed && message.type !== 'error') onMessage(message);
    });
  });
}
