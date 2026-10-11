'use strict';

const net = require('node:net');
const crypto = require('node:crypto');

// A fake Herdr API server on a real named pipe (Windows) speaking the captured wire protocol:
// newline-delimited JSON, {id, method, params} -> {id, result} | {id, error}.
// `handler(method, params, connection)` returns a result, throws {code,message} for an error envelope,
// or returns FakeHerdr.SILENT to never answer. Use `write(connection, obj)` for raw control.
const SILENT = Symbol('silent');

async function startFakeHerdr(handler) {
  const name = `contextdeck-test-${crypto.randomBytes(5).toString('hex')}`;
  const connections = new Set();
  const received = [];
  const subscribers = new Set();

  const server = net.createServer((socket) => {
    connections.add(socket);
    socket.setEncoding('utf8');
    socket.on('close', () => { connections.delete(socket); subscribers.delete(socket); });
    socket.on('error', () => {});
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let i;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        let request;
        try { request = JSON.parse(line); } catch { continue; }
        received.push(request);
        void (async () => {
          try {
            const result = await handler(request.method, request.params, socket);
            if (result === SILENT) return;
            if (request.method === 'events.subscribe') subscribers.add(socket);
            socket.write(`${JSON.stringify({ id: request.id, result })}\n`);
          } catch (error) {
            socket.write(`${JSON.stringify({ id: request.id, error: { code: error.code || 'error', message: error.message || 'failed' } })}\n`);
          }
        })();
      }
    });
  });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(`\\\\.\\pipe\\${name}`, resolve); });

  return {
    name,
    received,
    connectionCount: () => connections.size,
    subscriberCount: () => subscribers.size,
    publish: (event) => { for (const s of subscribers) s.write(`${JSON.stringify(event)}\n`); },
    writeRaw: (text) => { for (const s of connections) s.write(text); },
    dropConnections: () => { for (const s of [...connections]) s.destroy(); },
    async close() {
      for (const s of connections) s.destroy();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

module.exports = { startFakeHerdr, SILENT };
