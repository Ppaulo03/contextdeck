'use strict';

const net = require('node:net');

// Read-only client for Herdr's local socket API (protocol verified against Herdr 0.9.3 / protocol 22).
//
// Transport on Windows: a named pipe at \\.\pipe\<socket_path> where <socket_path> is the value
// reported by `herdr session list --json` (the .sock file on disk is only a descriptor).
// Framing: one JSON document per line. Request {id, method, params}; reply {id, result} or
// {id, error: {code, message}}. After `events.subscribe` the same connection streams
// {event, data} lines. See docs/validation/m01-i1.md for the captured exchanges.
//
// Only an explicit allowlist of read methods can be sent, so this module can never mutate a session.
const READ_ONLY_METHODS = Object.freeze(['ping', 'session.snapshot', 'workspace.list', 'workspace.get']);

// Subscriptions that signal workspace, tab or pane topology/focus changes. The stream is used as a
// *signal* to re-read authoritative state: events carry no sequence number and no client id.
const SUBSCRIPTION_TYPES = Object.freeze([
  'workspace.created', 'workspace.updated', 'workspace.metadata_updated', 'workspace.renamed',
  'workspace.moved', 'workspace.reordered', 'workspace.closed', 'workspace.focused',
  'tab.created', 'tab.closed', 'tab.focused', 'tab.renamed', 'tab.moved',
  'pane.created', 'pane.closed', 'pane.updated', 'pane.focused', 'pane.moved'
]);

const MAX_LINE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5000;

class HerdrApiError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'HerdrApiError';
    this.code = code;
    this.details = details;
  }
}

function pipeAddress(socketPath, platform = process.platform) {
  return platform === 'win32' ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

function createApiClient({ socketPath, connect = net.connect, platform = process.platform, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof socketPath !== 'string' || !socketPath) throw new TypeError('socketPath is required');
  const address = pipeAddress(socketPath, platform);
  const open = new Set();
  let sequence = 0;
  let closed = false;

  function track(socket) {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    socket.on('error', () => {}); // Errors are reported through the owning promise/callback.
    return socket;
  }

  // Splits the stream into JSON lines; reports malformed or oversized input instead of throwing.
  function lineReader(onLine, onProblem) {
    let buffer = '';
    return (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE_BYTES) return onProblem(new HerdrApiError('response_too_large', 'Herdr response exceeded the size limit'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { return onProblem(new HerdrApiError('invalid_json', 'Herdr sent a line that is not valid JSON')); }
        onLine(message);
      }
    };
  }

  function fromSocketError(error) {
    return new HerdrApiError('connection_failed', `Cannot reach Herdr (${error.code || error.message})`, { cause: error.code });
  }

  function request(method, params = {}) {
    if (closed) return Promise.reject(new HerdrApiError('client_closed', 'API client is closed'));
    if (!READ_ONLY_METHODS.includes(method)) {
      return Promise.reject(new HerdrApiError('method_not_allowed', `Method "${method}" is not allowed: this client is read-only`));
    }
    return new Promise((resolve, reject) => {
      const id = `cd-${++sequence}`;
      const socket = track(connect(address));
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };
      const timer = setTimeout(() => finish(reject, new HerdrApiError('timeout', `Herdr did not answer "${method}" within ${timeoutMs} ms`)), timeoutMs);
      const read = lineReader((message) => {
        if (message.id !== id) return;
        if (message.error) finish(reject, new HerdrApiError(String(message.error.code || 'error'), String(message.error.message || 'Herdr returned an error')));
        else finish(resolve, message.result);
      }, (problem) => finish(reject, problem));
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
      socket.on('data', read);
      socket.on('error', (error) => finish(reject, fromSocketError(error)));
      socket.on('close', () => finish(reject, new HerdrApiError('closed', 'Herdr closed the connection before answering')));
    });
  }

  // Opens a dedicated connection, subscribes and resolves once Herdr acknowledged. Afterwards
  // `onEvent({event, data})` receives the stream and `onClose(error|null)` fires exactly once.
  function subscribe(types, { onEvent, onClose } = {}) {
    if (closed) return Promise.reject(new HerdrApiError('client_closed', 'API client is closed'));
    const unknown = types.filter((type) => !SUBSCRIPTION_TYPES.includes(type));
    if (!types.length || unknown.length) {
      return Promise.reject(new HerdrApiError('subscription_not_allowed', `Subscription not allowed: ${unknown.join(', ') || '(none)'}`));
    }
    return new Promise((resolve, reject) => {
      const id = `cd-${++sequence}`;
      const socket = track(connect(address));
      let started = false;
      let ended = false;
      const end = (error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        socket.destroy();
        if (started) onClose?.(error || null); else reject(error || new HerdrApiError('closed', 'Herdr closed the connection before acknowledging the subscription'));
      };
      const timer = setTimeout(() => end(new HerdrApiError('timeout', `Herdr did not acknowledge the subscription within ${timeoutMs} ms`)), timeoutMs);
      const read = lineReader((message) => {
        if (!started) {
          if (message.id !== id) return;
          if (message.error) return end(new HerdrApiError(String(message.error.code || 'error'), String(message.error.message || 'subscription refused')));
          started = true;
          clearTimeout(timer);
          resolve({ close: () => { if (!ended) { ended = true; socket.destroy(); } } });
          return;
        }
        if (typeof message.event === 'string') onEvent?.({ event: message.event, data: message.data });
      }, end);
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(`${JSON.stringify({ id, method: 'events.subscribe', params: { subscriptions: types.map((type) => ({ type })) } })}\n`));
      socket.on('data', read);
      socket.on('error', (error) => end(fromSocketError(error)));
      socket.on('close', () => end(null));
    });
  }

  function close() {
    closed = true;
    for (const socket of open) socket.destroy();
    open.clear();
  }

  return { request, subscribe, close, openConnections: () => open.size, address };
}

module.exports = { createApiClient, HerdrApiError, pipeAddress, READ_ONLY_METHODS, SUBSCRIPTION_TYPES };
