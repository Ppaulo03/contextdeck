'use strict';

// M01-I3B-3 hardening: the routes OBSERVED by a person on a logged-in account, and the rule that identifying the Project is not
// proof that a conversation was created.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProjectUrl } = require('../src/main/chat/project-identity');
const { parseChatUrl } = require('../src/main/chat/conversation-identity');

// ---- observed on a real account (docs/validation/m01-i3b-3.md, "Observed routes") ----------------------------------------------
const ID = '6ac6503eb7e881919958af060b1297a5';
const HOME = `https://chatgpt.com/g/g-p-${ID}/project`;
const NEW_CHAT = `https://chatgpt.com/g/g-p-${ID}/project`;                                   // before the first message: identical to HOME
const CREATED = `https://chatgpt.com/g/g-p-${ID}-system-framework/c/6acbd981-c50c-83e9-b246-6c72298570e6`;
const OLD = `https://chatgpt.com/g/g-p-${ID}-system-framework/c/6ac6ed50-085c-83e9-a9cc-25be31a96299`;

test('observed: the Project home (no slug) is recognised and yields the 32-hex id', () => {
  const r = parseProjectUrl(HOME);
  assert.deepEqual([r.ok, r.projectId, r.slug, r.source, r.url], [true, `g-p-${ID}`, '', 'project-page', HOME]);
  assert.equal(parseProjectUrl(NEW_CHAT).projectId, `g-p-${ID}`);
});

test('observed: conversations inside the Project give the same Project id whatever the slug, and the UUID of any version', () => {
  for (const [url, uuid] of [[CREATED, '6acbd981-c50c-83e9-b246-6c72298570e6'], [OLD, '6ac6ed50-085c-83e9-a9cc-25be31a96299']]) {
    const p = parseProjectUrl(url);
    assert.deepEqual([p.ok, p.projectId, p.slug, p.source], [true, `g-p-${ID}`, 'system-framework', 'project-conversation'], url);
    const c = parseChatUrl(url);
    assert.deepEqual([c.ok, c.kind, c.conversationId, c.conversationKey], [true, 'project-conversation', uuid, `c:${uuid}`], url);
  }
  assert.equal(parseProjectUrl(HOME).projectId, parseProjectUrl(CREATED).projectId, 'same Project through different routes');
  assert.equal(parseProjectUrl(CREATED.replace('system-framework', 'another-slug-entirely')).projectId, `g-p-${ID}`, 'the slug text is not identity');
  assert.equal(parseChatUrl(OLD.replace('system-framework', 'zzz')).conversationKey, parseChatUrl(OLD).conversationKey);
});

test('observed: the new-chat URL cannot be told from the Project home, and a new and an old conversation cannot be told by URL', () => {
  assert.equal(NEW_CHAT, HOME);
  const shape = (u) => u.replace(/[0-9a-f]{8}-[0-9a-f-]{27}$/, '<uuid>');
  assert.equal(shape(CREATED), shape(OLD), 'the two conversation routes have exactly the same shape');
});

test('rejections stay strict with the real id: wrong length, other host, a conversation is not a Project page', () => {
  assert.equal(parseProjectUrl(`https://chatgpt.com/g/g-p-${ID.slice(1)}/project`).ok, false);
  assert.equal(parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}0/project`).ok, false);
  assert.equal(parseProjectUrl(`https://chatgpt.com.evil.example/g/g-p-${ID}/project`).ok, false);
  assert.equal(parseProjectUrl('https://chatgpt.com/c/6acbd981-c50c-83e9-b246-6c72298570e6').ok, false);
});

// Creation and association are covered by workspace-first.test.js: identifying the Project (here) is a separate question from
// deciding which workspace a conversation belongs to (there).
