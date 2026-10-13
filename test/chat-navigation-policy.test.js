'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedMainNavigation, isAllowedAuthPopup, safeNavigationOrigin } = require('../src/main/chat-navigation-policy');

test('main-frame navigation allows ChatGPT and supported HTTPS login origins only', () => {
  for (const url of [
    'https://chatgpt.com/',
    'https://chatgpt.com/c/12345678-1234-4123-8123-123456789012',
    'https://chatgpt.com/g/project-name/c/12345678-1234-4123-8123-123456789012',
    'https://auth.openai.com/',
    'https://accounts.google.com/',
    'https://login.microsoftonline.com/',
    'https://appleid.apple.com/'
  ]) assert.equal(isAllowedMainNavigation(url), true, url);
  for (const url of [
    'https://example.com/',
    'http://chatgpt.com/',
    'javascript:alert(1)',
    'file:///C:/private.txt',
    'data:text/html,hello',
    'not a url'
  ]) assert.equal(isAllowedMainNavigation(url), false, url);
});

test('navigation diagnostics retain only the origin and discard paths, query parameters, fragments and credentials', () => {
  assert.equal(safeNavigationOrigin('https://user:password@auth.openai.com/oauth/callback?code=secret#token'), 'https://auth.openai.com');
  assert.equal(safeNavigationOrigin('not a URL'), 'invalid');
});

test('only HTTPS authentication providers are allowed as sandboxed popups', () => {
  for (const host of ['auth.openai.com', 'accounts.google.com', 'login.microsoftonline.com', 'appleid.apple.com']) {
    assert.equal(isAllowedAuthPopup(`https://${host}/`), true, host);
  }
  for (const url of ['https://example.com/', 'https://chatgpt.com/', 'http://accounts.google.com/', 'javascript:alert(1)', 'not a url']) {
    assert.equal(isAllowedAuthPopup(url), false, url);
  }
});
