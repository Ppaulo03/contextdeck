'use strict';

const AUTH_HOSTS = new Set([
  'chatgpt.com',
  'auth.openai.com',
  'accounts.google.com',
  'login.microsoftonline.com',
  'appleid.apple.com'
]);

function isHttps(url) {
  try { return new URL(url).protocol === 'https:'; } catch { return false; }
}

function isAllowedMainNavigation(url) {
  if (!isHttps(url)) return false;
  try { return AUTH_HOSTS.has(new URL(url).hostname); } catch { return false; }
}

function isAllowedAuthPopup(url) {
  if (!isHttps(url)) return false;
  try { return AUTH_HOSTS.has(new URL(url).hostname) && new URL(url).hostname !== 'chatgpt.com'; } catch { return false; }
}

function safeNavigationOrigin(url) {
  try { return new URL(url).origin.slice(0, 255); } catch { return 'invalid'; }
}

module.exports = { AUTH_HOSTS, isHttps, isAllowedMainNavigation, isAllowedAuthPopup, safeNavigationOrigin };
