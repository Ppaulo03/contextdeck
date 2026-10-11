'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseChatUrl } = require('../src/main/chat/conversation-identity');
const rc = require('../src/main/chat/runtime-contract');
const { createState, reduce } = require('../src/main/chat/state-model');
const { ID, chatUrl, projectUrl } = require('./helpers/bindings-world');

// ---- conversation identity ------------------------------------------------------------------------------

test('identity: a normal conversation is identified by its id and the URL is normalized', () => {
  const r = parseChatUrl(`https://chatgpt.com/c/${ID(1)}?model=gpt-x#frag`);
  assert.deepEqual(r, { ok: true, kind: 'conversation', conversationKey: `c:${ID(1)}`, conversationId: ID(1), project: null, url: chatUrl(1) });
  assert.equal(parseChatUrl(`  https://chatgpt.com/c/${ID(1)}/  `).url, chatUrl(1), 'surrounding blanks and a trailing slash are tolerated');
  assert.equal(parseChatUrl(`https://chatgpt.com/c/${ID(1).toUpperCase()}`).conversationKey, `c:${ID(1)}`, 'ids are case-folded');
});

test('identity: a Project conversation keeps its route but shares the identity of the plain URL (duplicate detection)', () => {
  const p = parseChatUrl(projectUrl(2));
  assert.equal(p.ok, true);
  assert.equal(p.kind, 'project-conversation');
  assert.equal(p.project, 'g-p-abc123-demo');
  assert.equal(p.url, projectUrl(2), 'the project route is not discarded');
  assert.equal(p.conversationKey, parseChatUrl(chatUrl(2)).conversationKey, 'same conversation, same key');
});

test('identity: pages without a durable id are pending, never identified (new chat, project home)', () => {
  for (const url of ['https://chatgpt.com/', 'https://chatgpt.com', 'https://chatgpt.com/?temporary-chat=true', 'https://chatgpt.com/g/g-p-abc123-demo', 'https://chatgpt.com/g/g-p-abc123-demo/project']) {
    const r = parseChatUrl(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.reason, 'identity-pending', url);
    assert.match(r.message, /identidade persistente/);
  }
});

test('identity: invalid, foreign, insecure and non-conversation addresses are refused with a reason', () => {
  const cases = [
    [undefined, 'invalid-url'], [null, 'invalid-url'], [42, 'invalid-url'], ['', 'invalid-url'], ['   ', 'invalid-url'], ['not a url', 'invalid-url'],
    ['http://chatgpt.com/c/' + ID(1), 'insecure-protocol'], ['javascript:alert(1)', 'insecure-protocol'], ['file:///C:/x', 'insecure-protocol'],
    ['https://evil.example/c/' + ID(1), 'foreign-host'], ['https://chatgpt.com.evil.example/c/' + ID(1), 'foreign-host'], ['https://www.chatgpt.com/c/' + ID(1), 'foreign-host'],
    ['https://user:pw@chatgpt.com/c/' + ID(1), 'invalid-url'], ['https://chatgpt.com:8443/c/' + ID(1), 'invalid-url'],
    ['https://chatgpt.com/c/%2e%2e%2f' + ID(1), 'invalid-url'], ['https://chatgpt.com/c/' + ID(1) + '%2fx', 'invalid-url'],    ['https://chatgpt.com/c/not-a-uuid', 'not-a-conversation'], ['https://chatgpt.com/c/' + ID(1) + '/extra', 'not-a-conversation'],
    ['https://chatgpt.com/share/' + ID(1), 'not-a-conversation'], ['https://chatgpt.com/g/bad project/c/' + ID(1), 'not-a-conversation'],
    ['https://chatgpt.com/\n/c/' + ID(1), 'invalid-url'], ['https://chatgpt.com/c/' + ID(1) + '?' + 'a'.repeat(3000), 'invalid-url']
  ];
  for (const [url, reason] of cases) {
    const r = parseChatUrl(url);
    assert.equal(r.ok, false, String(url));
    assert.equal(r.reason, reason, String(url));
  }
});

test('identity: the diagnostic hashes of the I3P observer are not an identity source (the parser only reads the URL)', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/main/chat/conversation-identity.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /require\(|hash|createHash|crypto|executeJavaScript|getTitle/);
});

test('identity: in-page navigation is just another URL (the identity follows the address, not the page load)', () => {
  const a = parseChatUrl(chatUrl(1));
  const b = parseChatUrl(chatUrl(2));
  assert.notEqual(a.conversationKey, b.conversationKey);
  assert.equal(parseChatUrl('https://chatgpt.com/').reason, 'identity-pending', 'a new chat is pending until it receives its id');
  assert.equal(parseChatUrl(chatUrl(1) + '?x=1').conversationKey, a.conversationKey, 'a query string does not change the identity');
});

// ---- runtime contract ------------------------------------------------------------------------------------

test('runtime contract: dimensions, outcome states and the provider interface are fixed', () => {
  assert.deepEqual(Object.values(rc.PageLifecycle), ['unloaded', 'loading', 'ready', 'error', 'destroyed']);
  assert.deepEqual(Object.values(rc.GenerationState), ['unknown', 'idle', 'responding', 'ended-unclassified', 'interrupted', 'completed', 'error']);
  assert.deepEqual(Object.values(rc.DraftState), ['unknown', 'empty', 'present']);
  assert.deepEqual(Object.values(rc.AttentionState), ['none', 'pending']);
  assert.deepEqual(rc.RUNTIME_PROVIDER_METHODS, ['getRuntime', 'subscribe']);
  const initial = rc.initialRuntime();
  assert.equal(initial.generation.value, 'unknown');
  assert.equal(initial.generation.source, 'none');
  assert.ok(Object.isFrozen(initial) && Object.isFrozen(initial.generation));
});

test('runtime contract: observations carry source, reliability and validity; stale ones read as unknown', () => {
  const o = rc.observation('responding', { source: 'dom-probe', reliability: 'observed', observedAt: 1000, validUntil: 2000 });
  assert.deepEqual(Object.keys(o).sort(), ['observedAt', 'reliability', 'source', 'validUntil', 'value']);
  assert.equal(rc.effectiveValue(o, 1500), 'responding');
  assert.equal(rc.effectiveValue(o, 2001), 'unknown');
  assert.equal(rc.effectiveValue(null, 1), 'unknown');
  assert.equal(rc.effectiveValue(rc.observation('ready', { validUntil: null }), 9e12), 'ready', 'no expiry: never stale');
});

test('runtime contract: the I3P observer state maps onto it; ended-unclassified is first-class and never becomes completed', () => {
  let s = createState();
  s = reduce(s, { type: 'page-loading' });
  s = reduce(s, { type: 'page-ready' });
  const idle = rc.fromObserverState(s, { now: 100, ttlMs: 50 });
  assert.equal(idle.page.value, 'ready');
  assert.equal(idle.page.source, 'navigation');
  assert.equal(idle.generation.value, 'unknown');
  assert.equal(idle.generation.reliability, 'unknown');
  // The observation time is the probe's, not the time the mapping ran: an old reading expires on its own.
  const old = rc.fromObserverState(s, { now: 100_000, ttlMs: 50, observedAt: 1000 });
  assert.equal(old.draft.observedAt, 1000);
  assert.equal(rc.effectiveValue(old.draft, 100_000), 'unknown');

  const base = (generation) => ({ ...s, generation, draft: { state: 'present', evidence: 'observed' }, attention: { pending: true } });
  const ended = rc.fromObserverState(base({ state: 'unknown', evidence: 'unknown', reason: 'ended-unclassified' }), { now: 100, ttlMs: 50 });
  assert.equal(ended.generation.value, 'ended-unclassified');
  assert.notEqual(ended.generation.value, 'completed');
  assert.equal(ended.draft.value, 'present');
  assert.equal(ended.draft.validUntil, 150);
  assert.equal(ended.attention.value, 'pending');

  const done = rc.fromObserverState(base({ state: 'completed', evidence: 'inferred', reason: 'stop-gone+turn-actions' }), { now: 100 });
  assert.equal(done.generation.value, 'completed');
  assert.equal(done.generation.reliability, 'inferred');
  // An outcome without any evidence is not trusted.
  for (const outcome of ['completed', 'interrupted', 'error']) {
    assert.equal(rc.fromObserverState(base({ state: outcome, evidence: 'unknown', reason: 'x' }), { now: 1 }).generation.value, 'unknown', outcome);
  }
  assert.equal(rc.fromObserverState(base({ state: 'bogus', evidence: 'observed', reason: 'x' }), { now: 1 }).generation.value, 'unknown');
});

test('runtime/persistence decoupling: the persistence layer never imports the runtime contract, the observer or the detector', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'src', 'main', 'chat-bindings');
  for (const file of fs.readdirSync(dir)) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(text, /runtime-contract|state-observer|state-detector|state-model|diagnostics|executeJavaScript/, file);
  }
  const runtime = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'chat', 'runtime-contract.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(runtime, /require\('(electron|node:fs|fs)'\)|chat-bindings/);
});
