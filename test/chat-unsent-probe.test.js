'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { unsentSource, normalizeUnsent, probeSource, sanitizeUnsentTrace } = require('../src/main/chat/state-detector');

function runUnsentFixture({ composer = true, hasForm = true, fileLengths = [], progressbars = [], olderMessageFiles = [] } = {}) {
  const button = {};
  const inputs = fileLengths.map((length) => ({ files: { length } }));
  const form = {
    querySelector: () => button,
    querySelectorAll: (selector) => selector === 'input[type="file"]' ? inputs : selector === '[role="progressbar"]' ? progressbars : []
  };
  const editable = { hidden: false, getClientRects: () => [1], closest: (selector) => selector === 'form' && hasForm ? form : null };
  const document = {
    querySelector: () => null,
    querySelectorAll: (selector) => selector === '*' ? [] : selector.startsWith('textarea,') ? (composer ? [editable] : []) : selector === 'input[type="file"]' ? olderMessageFiles : []
  };
  // Attachments in older turns are intentionally outside the composer form and do not contribute.
  return vm.runInNewContext(unsentSource(), { document });
}

test('unsent-state probe recognizes only positive structural evidence and never treats absence as empty', () => {
  const source = unsentSource();
  assert.match(source, /input\.files && input\.files\.length > 0/);
  assert.match(source, /\[role="progressbar"\]/);
  assert.match(source, /: 'unknown'\);/);
  assert.doesNotMatch(source, /return 'empty'|attachment-chip|file-upload-progress|\.name\b|\.textContent|\.value\b|FileReader|arrayBuffer/);
  assert.match(source, /findComposer\(\)/, 'composer lookup uses the shared structural locator');
});

test('structural fixtures keep absent, empty file input, and older-message attachments inconclusive', () => {
  assert.equal(runUnsentFixture(), 'unknown', 'a visually empty composer is not proof of empty unsent state');
  assert.equal(runUnsentFixture({ fileLengths: [0], olderMessageFiles: [{ files: { length: 1 } }] }), 'unknown');
  assert.equal(runUnsentFixture({ composer: false, olderMessageFiles: [{ files: { length: 1 } }] }), 'unknown');
  assert.equal(runUnsentFixture({ hasForm: false }), 'unknown', 'an editor without a proven composer form remains inconclusive');
});

test('a populated file input or upload progressbar within the composer form proves pending work', () => {
  assert.equal(runUnsentFixture({ fileLengths: [1] }), 'present');
  assert.equal(runUnsentFixture({ progressbars: [{ hidden: false, getClientRects: () => [1] }] }), 'present');
});

test('composer trace source exposes only structural counts and a boolean draft state', () => {
  const source = probeSource({ composerTrace: true });
  assert.match(source, /out\.unsentTrace/);
  assert.match(source, /populatedFileInputCount/);
  assert.match(source, /progressbarCount/);
  assert.doesNotMatch(source, /input\.name|file\.name|\.files\[\d+\]|FileReader|arrayBuffer/);
});

test('composer trace sanitizer drops private and URL-like data and accepts only known states', () => {
  const evidence = sanitizeUnsentTrace({
    composerState: 'found', composerVia: 'structural', draftState: 'present', unsentState: 'empty', reason: 'absence-unverified',
    visibleEditableCount: 3, otherEditableCount: 2, formPresent: true, formButtonCount: 4, fileInputCount: 1, populatedFileInputCount: 0, progressbarCount: 0,
    draft: 'secret draft', fileName: 'private.pdf', url: 'https://chatgpt.com/c/private?token=secret'
  }, true);
  assert.deepEqual(evidence, {
    composerState: 'found', composerVia: 'structural', draftState: 'present', unsentState: 'empty', reason: 'absence-unverified',
    visibleEditableCount: 3, otherEditableCount: 2, formPresent: true, formButtonCount: 4, fileInputCount: 1, populatedFileInputCount: 0, progressbarCount: 0, uploadState: 'unknown', viewVisible: true
  });
  assert.doesNotMatch(JSON.stringify(evidence), /secret|private\.pdf|https?:/);
  assert.equal(sanitizeUnsentTrace({ composerState: 'surprise', unsentState: 'surprise', reason: 'secret', composerVia: 'other' }).unsentState, 'unknown');
});

test('unrecognized, unavailable, or failed probe results stay unknown', () => {
  assert.equal(normalizeUnsent('present'), 'present');
  assert.equal(normalizeUnsent('empty'), 'empty');
  for (const value of [null, undefined, false, 'pending', {}, '']) assert.equal(normalizeUnsent(value), 'unknown');
});
