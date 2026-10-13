'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { unsentSource, normalizeUnsent } = require('../src/main/chat/state-detector');

test('unsent-state probe scopes attachment and upload indicators to the composer and never reads file data', () => {
  const source = unsentSource();
  assert.match(source, /composer\.closest\('form'\)/);
  assert.match(source, /form\.querySelectorAll\('input\[type="file"\]'\)/);
  assert.match(source, /input\.files\.length > 0/);
  assert.match(source, /attachment-chip|file-upload-progress|role="progressbar"/);
  assert.match(source, /return 'unknown'/);
  assert.doesNotMatch(source, /\.name\b|\.textContent|\.value\b|FileReader|arrayBuffer/);
});

test('unrecognized, unavailable, or failed probe results stay unknown', () => {
  assert.equal(normalizeUnsent('present'), 'present');
  assert.equal(normalizeUnsent('empty'), 'empty');
  for (const value of [null, undefined, false, 'pending', {}, '']) assert.equal(normalizeUnsent(value), 'unknown');
});
