/** A DevTools transport is `{ send(text), close(), onmessage, onclose }`; the client sets the two callbacks. */

/** Chrome's `--remote-debugging-pipe`: JSON texts, each ended by a NUL byte, written to fd 3 and read from fd 4. */
export function pipeTransport(writable, readable) {
  let pending = [];
  const transport = {
    onmessage: null,
    onclose: null,
    send: text => { writable.write(`${text}\0`); },
    close: () => { writable.destroy(); readable.destroy(); },
  };
  // A write to a pipe that Chrome has closed raises EPIPE; the client already sees the close.
  writable.on('error', () => {});
  readable.on('error', () => {});
  readable.on('data', chunk => {
    pending.push(chunk);
    if (chunk.indexOf(0) === -1) return;
    const all = Buffer.concat(pending);
    let start = 0;
    for (let end = all.indexOf(0); end !== -1; end = all.indexOf(0, start)) {
      const text = all.toString('utf8', start, end);
      start = end + 1;
      transport.onmessage?.(text);
    }
    pending = start < all.length ? [all.subarray(start)] : [];
  });
  readable.on('close', () => transport.onclose?.());
  return transport;
}

/** The port variant: a browser-level WebSocket from `DevToolsActivePort`, using the global `WebSocket` (Node 22.4+). */
export function webSocketTransport(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const transport = {
      onmessage: null,
      onclose: null,
      send: text => { socket.send(text); },
      close: () => { socket.close(); },
    };
    socket.addEventListener('message', event => transport.onmessage?.(String(event.data)));
    socket.addEventListener('close', () => transport.onclose?.());
    socket.addEventListener('open', () => resolve(transport), { once: true });
    socket.addEventListener('error', () => reject(new Error('devtools websocket failed')), { once: true });
  });
}

/**
 * `CdpClient = { send(method, params?, sessionId?), on(event, fn) }` over one transport. `on` hands the handler
 * `(params, sessionId)` and returns a function that removes it. Errors name the method, never the parameters.
 */
export function createCdpClient(transport, { timeoutMs }) {
  let nextId = 0;
  const pending = new Map();
  const handlers = new Map();
  let closed = false;

  transport.onmessage = text => {
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.id !== undefined) {
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
      else entry.resolve(message.result ?? {});
    } else if (message.method) {
      for (const fn of [...handlers.get(message.method) ?? []]) fn(message.params ?? {}, message.sessionId);
    }
  };
  transport.onclose = () => {
    closed = true;
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(new Error(`${entry.method}: devtools connection closed`));
    }
  };

  return {
    send(method, params, sessionId) {
      if (closed) return Promise.reject(new Error(`${method}: devtools connection closed`));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`${method}: devtools command timed out`));
        }, timeoutMs);
        pending.set(id, { method, resolve, reject, timer });
        try { transport.send(JSON.stringify({ id, method, params, sessionId })); }
        catch (error) {
          pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    },
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => { handlers.get(event).delete(fn); };
    },
  };
}
