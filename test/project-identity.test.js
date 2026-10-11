'use strict';

// Project URL parser. The URLs are SYNTHETIC (shape taken from the hypothesis in project-identity.js), not observed ones:
// see docs/validation/m01-i3b-3.md for what has and has not been seen on a real account.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseProjectUrl, labelFromSlug } = require('../src/main/chat/project-identity');

const ID = '0123456789abcdef0123456789abcdef';
const UUID = '11111111-2222-4333-8444-555555555555';

test('Project home, with and without the /project suffix and a slug; the id is the stable part', () => {
  const a = parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}-bicho/project`);
  assert.deepEqual([a.ok, a.projectId, a.slug, a.source], [true, `g-p-${ID}`, 'bicho', 'project-page']);
  assert.equal(a.url, `https://chatgpt.com/g/g-p-${ID}-bicho/project`);
  const b = parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}`);
  assert.deepEqual([b.ok, b.projectId, b.slug], [true, `g-p-${ID}`, '']);
  assert.equal(b.url, `https://chatgpt.com/g/g-p-${ID}/project`);
});

test('a renamed Project (other slug, same id) has the same identity; hyphens of the slug never leak into the id', () => {
  const a = parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}-old-name/project`);
  const b = parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}-brand-new-name-2/project?model=x#frag`);
  assert.equal(a.projectId, b.projectId);
  assert.notEqual(a.slug, b.slug);
  assert.equal(b.slug, 'brand-new-name-2');
  assert.equal(labelFromSlug(b.slug), 'brand new name 2');
});

test('a conversation inside a Project yields the Project, and says it came from a conversation', () => {
  const r = parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}-bicho/c/${UUID}`);
  assert.deepEqual([r.ok, r.projectId, r.source], [true, `g-p-${ID}`, 'project-conversation']);
  assert.equal(r.url, `https://chatgpt.com/g/g-p-${ID}-bicho/project`);
});

test('a plain conversation, the home page and other pages are not Projects', () => {
  for (const url of [`https://chatgpt.com/c/${UUID}`, 'https://chatgpt.com/', 'https://chatgpt.com/g/g-p-', 'https://chatgpt.com/gpts', 'https://chatgpt.com/g/g-abc123/project']) {
    const r = parseProjectUrl(url);
    assert.equal(r.ok, false, url);
    assert.equal(r.reason, 'not-a-project', url);
  }
});

test('ids that are not exactly 32 hex digits are refused, not split by guess', () => {
  for (const id of ['g-p-abc123-demo', `g-p-${ID}0`, `g-p-${ID.slice(1)}`, `g-p-${ID.toUpperCase()}`, 'g-p-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz']) {
    assert.equal(parseProjectUrl(`https://chatgpt.com/g/${id}/project`).ok, false, id);
  }
});

test('foreign hosts, lookalikes, schemes, credentials, ports, encoded separators and junk are refused', () => {
  const seg = `g-p-${ID}-x`;
  const cases = [
    [`https://evil.example/g/${seg}/project`, 'foreign-host'], [`https://chatgpt.com.evil.example/g/${seg}/project`, 'foreign-host'],
    [`https://www.chatgpt.com/g/${seg}/project`, 'foreign-host'], [`http://chatgpt.com/g/${seg}/project`, 'insecure-protocol'],
    [`https://user:pw@chatgpt.com/g/${seg}/project`, 'invalid-url'], [`https://chatgpt.com:8443/g/${seg}/project`, 'invalid-url'],
    [`https://chatgpt.com/g/${seg}%2Fproject`, 'invalid-url'], [`javascript:alert(1)//g-p-${ID}`, 'insecure-protocol'],
    ['', 'invalid-url'], [null, 'invalid-url'], [{ toString: () => `https://chatgpt.com/g/${seg}/project` }, 'invalid-url'], ['x'.repeat(3000), 'invalid-url']
  ];
  for (const [url, reason] of cases) {
    const r = parseProjectUrl(url);
    assert.equal(r.ok, false, String(url).slice(0, 60));
    assert.equal(r.reason, reason, String(url).slice(0, 60));
  }
});

test('extra path parts after the home page are not a Project page', () => {
  assert.equal(parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}-x/project/files`).ok, false);
  assert.equal(parseProjectUrl(`https://chatgpt.com/g/g-p-${ID}-x/settings`).ok, false);
});
