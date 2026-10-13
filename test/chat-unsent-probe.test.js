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
  assert.match(source, /editableStructure/);
  assert.match(source, /candidateHits/);
  assert.match(source, /fileInputEvidence/);
  assert.match(source, /multiple-editables-no-submit-form/);
  assert.doesNotMatch(source, /innerHTML|outerHTML|input\.name|file\.name|\.files\[\d+\]|FileReader|arrayBuffer/);
});

test('composer trace sanitizer drops private and URL-like data and accepts only known states', () => {
  const evidence = sanitizeUnsentTrace({
    composerState: 'found', composerVia: 'structural', draftState: 'present', unsentState: 'unknown', reason: 'absence-unverified',
    visibleEditableCount: 3, otherEditableCount: 2, formPresent: true, formButtonCount: 4, fileInputCount: 1, populatedFileInputCount: 0, progressbarCount: 0,
    locatorReason: 'found',
    editableStructure: [{ index: 0, tag: 'div', role: 'textbox', visible: true, contentEditable: true, inForm: false, formHasSubmit: false,
      ancestry: [{ depth: 0, tag: 'div', role: 'textbox', visible: true, buttons: 1, roleButtons: 2, images: 1, fileInputs: 4, progressbars: 0, busyNodes: 0, testIdNodes: 3, labeledNodes: 2, listItems: 1, attachmentAttrNodes: 0 }] }],
    candidateHits: { composer: [0, 0, 0, 0, 0], submit: [0, 1, 0], privateKey: ['secret'] },
    fileInputEvidence: { total: 4, visible: 1, populated: 0, inComposerForm: 4 },
    documentEvidence: { formCount: 2, eligibleFormCount: 0, visibleEditableCount: 6, totalEditableCount: 6, visibleProgressbars: 0, visibleBusyNodes: 1 },
    draft: 'secret draft', fileName: 'private.pdf', url: 'https://chatgpt.com/c/private?token=secret'
  }, true);
  assert.deepEqual(evidence, {
    composerState: 'found', composerVia: 'structural', locatorReason: 'found', draftState: 'present', unsentState: 'unknown', reason: 'absence-unverified',
    visibleEditableCount: 3, otherEditableCount: 2, formPresent: true, formButtonCount: 4, fileInputCount: 1, populatedFileInputCount: 0, progressbarCount: 0, uploadState: 'unknown',
    editableStructure: [{ index: 0, tag: 'div', role: 'textbox', visible: true, contentEditable: true, inForm: false, formHasSubmit: false,
      ancestry: [{ depth: 0, tag: 'div', role: 'textbox', visible: true, buttons: 1, roleButtons: 2, images: 1, fileInputs: 4, progressbars: 0, busyNodes: 0, testIdNodes: 3, labeledNodes: 2, listItems: 1, attachmentAttrNodes: 0 }] }],
    candidateHits: { composer: [0, 0, 0, 0, 0], submit: [0, 1, 0], stop: [], turnActions: [], error: [] },
    fileInputEvidence: { total: 4, visible: 1, populated: 0, inComposerForm: 4 },
    documentEvidence: { formCount: 2, eligibleFormCount: 0, visibleEditableCount: 6, totalEditableCount: 6, visibleProgressbars: 0, visibleBusyNodes: 1 },
    viewVisible: true
  });
  assert.doesNotMatch(JSON.stringify(evidence), /secret|private\.pdf|https?:/);
  assert.equal(sanitizeUnsentTrace({ composerState: 'surprise', unsentState: 'surprise', reason: 'secret', composerVia: 'other' }).unsentState, 'unknown');
  assert.equal(sanitizeUnsentTrace({ composerState: 'found', unsentState: 'empty' }).unsentState, 'unknown', 'schema-2 cannot claim empty from unvalidated evidence');
});

test('structural attachment candidates and absent upload indicators never produce an empty unsent result', () => {
  const evidence = sanitizeUnsentTrace({ composerState: 'ambiguous', locatorReason: 'multiple-editables-no-submit-form', draftState: 'unknown', unsentState: 'unknown',
    editableStructure: [{ index: 0, tag: 'div', role: 'textbox', visible: true, ancestry: [{ depth: 1, tag: 'section', role: 'other', images: 2, buttons: 3, fileInputs: 1, testIdNodes: 4, attachmentAttrNodes: 0 }] }],
    fileInputEvidence: { total: 2, visible: 1, populated: 0, inComposerForm: 0 }, documentEvidence: { visibleProgressbars: 0 } });
  assert.equal(evidence.unsentState, 'unknown');
  assert.equal(evidence.uploadState, 'unknown');
  assert.equal(evidence.locatorReason, 'multiple-editables-no-submit-form');
  assert.equal(evidence.editableStructure[0].ancestry[0].images, 2);
  assert.equal(evidence.fileInputEvidence.populated, 0);
});

test('unrecognized, unavailable, or failed probe results stay unknown', () => {
  assert.equal(normalizeUnsent('present'), 'present');
  assert.equal(normalizeUnsent('empty'), 'empty');
  for (const value of [null, undefined, false, 'pending', {}, '']) assert.equal(normalizeUnsent(value), 'unknown');
});
