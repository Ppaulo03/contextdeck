'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPtyEnv } = require('../src/pty-env');

test('strips HERDR_* variables (any case) and keeps the rest', () => {
  const env = buildPtyEnv({
    PATH: 'C:\\bin', HERDR_ENV: '1', HERDR_SOCKET_PATH: 'x', herdr_pane_id: 'w1:p1', Path2: 'keep', GONE: undefined
  });
  assert.deepEqual(Object.keys(env).sort(), ['COLORTERM', 'PATH', 'Path2', 'TERM']);
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.COLORTERM, 'truecolor');
});
