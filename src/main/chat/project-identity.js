'use strict';

const { parseChatUrl, CHAT_HOST } = require('./conversation-identity');

// Identity of a ChatGPT Project, from its URL only (M01-I3B-3). Never from a title, the DOM or message content.
//
// STATUS OF THE SHAPE - read before relying on it: the routes below are NOT validated against a logged-in account
// (docs/validation/m01-i3b-3.md lists what was and was not observed). They are a strict hypothesis, and the product keeps
// the whole Projects feature off (CONTEXTDECK_PROJECTS) until a person records the real routes. Nothing here guesses:
// a URL that does not match exactly is refused, it is never "close enough".
//
// Hypothesised shapes (https://chatgpt.com, no credentials, default port):
//   /g/g-p-<32 hex>[-<slug>]/project      the Project's home page
//   /g/g-p-<32 hex>[-<slug>]              the same page without the suffix
//   /g/g-p-<32 hex>[-<slug>]/c/<uuid>     a conversation inside the Project (what a new chat becomes after its first message)
// The identity is the 32-hex id; the slug (derived from the Project's name) is a label that may change on rename, so it is
// never part of the identity. Because ids are hex they contain no hyphen, which is what makes the id/slug split exact.
// A segment whose id is not exactly 32 hex digits is refused rather than split by guess.

const ID_RE = /^g-p-([0-9a-f]{32})(?:-([A-Za-z0-9][A-Za-z0-9-]{0,127}))?$/;
const MESSAGES = Object.freeze({
  'not-a-project': 'Esta URL nao e a de um Project do ChatGPT reconhecido.',
  'foreign-host': 'Somente Projects de chatgpt.com podem ser vinculados.',
  'invalid-url': 'A URL informada nao e valida.',
  'insecure-protocol': 'Somente URLs https sao aceitas.'
});
const fail = (reason) => ({ ok: false, reason, message: MESSAGES[reason] });

const projectUrl = (segment) => `https://${CHAT_HOST}/g/${segment}/project`;

function splitSegment(segment) {
  const m = ID_RE.exec(segment || '');
  return m ? { projectId: `g-p-${m[1]}`, slug: m[2] || '' } : null;
}

function parseProjectUrl(input) {
  // Conversation inside a Project: the existing parser validates host/protocol/uuid and hands back the route segment.
  const conv = parseChatUrl(input);
  if (conv.ok) {
    if (conv.kind !== 'project-conversation') return fail('not-a-project');
    const id = splitSegment(conv.project);
    return id ? { ok: true, source: 'project-conversation', projectId: id.projectId, slug: id.slug, segment: conv.project, url: projectUrl(conv.project) } : fail('not-a-project');
  }
  if (conv.reason === 'invalid-url' || conv.reason === 'insecure-protocol' || conv.reason === 'foreign-host') return fail(conv.reason);
  // identity-pending / not-a-conversation: only the Project home shapes can still be a Project.
  let u;
  try { u = new URL(String(input).trim()); } catch { return fail('invalid-url'); }
  const parts = u.pathname.split('/').filter(Boolean);
  const home = parts[0] === 'g' && (parts.length === 2 || (parts.length === 3 && parts[2] === 'project'));
  const id = home ? splitSegment(parts[1]) : null;
  return id ? { ok: true, source: 'project-page', projectId: id.projectId, slug: id.slug, segment: parts[1], url: projectUrl(parts[1]) } : fail('not-a-project');
}

// A label proposed from the slug, only as a default the user can edit (never an identity).
const labelFromSlug = (slug) => (slug ? slug.replace(/-+/g, ' ').trim() : '');
// The Project home has no slug (observed), and the name is never read from the page: without a name typed by the user the label is
// a short form of the id, so it is never shown as "sem nome".
const fallbackLabel = (projectId) => `Project ${String(projectId).replace(/^g-p-/, '').slice(0, 6)}`;

module.exports = { parseProjectUrl, labelFromSlug, fallbackLabel, ID_RE };
