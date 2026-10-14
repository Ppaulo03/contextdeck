'use strict';

// Durable identity of a ChatGPT conversation, derived from its URL only (M01-I3A). Never from titles, DOM
// or message content, and never from the diagnostic hashes of the I3P observer.
//
// Shapes accepted as a conversation (https://chatgpt.com, no credentials, default port):
//   /c/<uuid>                      normal conversation
//   /g/<project>/c/<uuid>          conversation inside a Project (or a GPT); <project> looks like g-p-<id>-<slug>
// Both resolve to the same conversationKey `c:<uuid>`: the id is the identity, the project segment is a route
// to it, so the same conversation reached by either URL is detected as a duplicate.
// Pages without a durable id yet ("/", a project's home) are `identity-pending`: they cannot be bound until
// they acquire one. Everything else is `not-a-conversation`.
// Query string and fragment are dropped (they carry UI state such as ?model= or ?temporary-chat=, not identity).
//
// Status of the project-URL shape: modelled from the public URL scheme; not yet validated against a logged-in
// Project (see docs/validation/m01-i3a.md). A shape that does not match is refused, never guessed.

const HOST = 'chatgpt.com';
const MAX_URL_LENGTH = 2048;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROJECT_RE = /^g-[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

const MESSAGES = Object.freeze({
  'invalid-url': 'A URL informada nao e valida.',
  'insecure-protocol': 'Somente URLs https sao aceitas.',
  'foreign-host': 'Somente conversas de chatgpt.com podem ser vinculadas.',
  'identity-pending': 'Esta pagina ainda nao tem uma identidade persistente. Envie a primeira mensagem (ou abra uma conversa existente) e tente de novo.',
  'not-a-conversation': 'Esta URL nao e a de uma conversa do ChatGPT.'
});

const fail = (reason, kind) => ({ ok: false, reason, kind, message: MESSAGES[reason] });

function parseChatUrl(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > MAX_URL_LENGTH || CONTROL_RE.test(input)) return fail('invalid-url', 'unknown');
  let u;
  try { u = new URL(input.trim()); } catch { return fail('invalid-url', 'unknown'); }
  if (u.protocol !== 'https:') return fail('insecure-protocol', 'unknown');
  if (u.hostname !== HOST) return fail('foreign-host', 'other');
  if (u.username || u.password || u.port) return fail('invalid-url', 'unknown');
  if (/%2f|%5c|\\/i.test(u.pathname)) return fail('invalid-url', 'unknown');
  const parts = u.pathname.split('/').filter(Boolean);
  const pending = () => fail('identity-pending', 'new');

  if (parts.length === 0) return pending();
  if (parts.length === 2 && parts[0] === 'c' && UUID_RE.test(parts[1])) {
    const id = parts[1].toLowerCase();
    return { ok: true, kind: 'conversation', conversationKey: `c:${id}`, conversationId: id, project: null, url: `https://${HOST}/c/${id}` };
  }
  if (parts.length === 4 && parts[0] === 'g' && PROJECT_RE.test(parts[1]) && parts[2] === 'c' && UUID_RE.test(parts[3])) {
    const id = parts[3].toLowerCase();
    return { ok: true, kind: 'project-conversation', conversationKey: `c:${id}`, conversationId: id, project: parts[1], url: `https://${HOST}/g/${parts[1]}/c/${id}` };
  }
  if (parts[0] === 'g' && PROJECT_RE.test(parts[1] || '') && (parts.length === 2 || (parts.length === 3 && parts[2] === 'project'))) return pending();
  return fail('not-a-conversation', 'other');
}

module.exports = { parseChatUrl, CHAT_HOST: HOST, MESSAGES };
