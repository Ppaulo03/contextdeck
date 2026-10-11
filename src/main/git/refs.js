'use strict';

const git = require('./core');

const COMMIT_COUNT = 30;
const REF_LIMIT = 500;
const BASE_CANDIDATES = [
  { kind: 'local', label: 'dev' },
  { kind: 'remote', label: 'origin/dev' },
  { kind: 'local', label: 'main' },
  { kind: 'remote', label: 'origin/main' }
];

const SMALL = { maxBytes: 4 * 1024 * 1024 };

// Lists refs of one kind. Annotated tags are peeled; refs that do not end in a commit are skipped.
// `value` is what later commands receive: the full refname (unambiguous even when a branch and
// a tag share a name), or the commit hash when the name has characters isSafeRef() does not accept.
// `label` always keeps the original spelling.
async function listRefs(root, namespace, kind, sort) {
  const args = ['for-each-ref', `--count=${REF_LIMIT + 1}`, ...(sort ? [`--sort=${sort}`] : []),
    '--format=%(refname)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)', namespace];
  const result = await git.runGit(root, args, SMALL);
  if (result.code !== 0) return { items: [], truncated: false };
  const items = [];
  for (const line of result.stdout.toString('utf8').split('\n')) {
    if (!line) continue;
    const [full, type, objectName, peeledType, peeledName] = line.split('\t');
    const sha = type === 'tag' ? (peeledType === 'commit' ? peeledName : undefined) : (type === 'commit' ? objectName : undefined);
    if (!sha || !full.startsWith(namespace)) continue;
    const label = full.slice(namespace.length);
    if (kind === 'remote' && label.endsWith('/HEAD')) continue; // origin/HEAD is only a pointer.
    items.push({ kind, label, value: git.isSafeRef(full) ? full : sha, sha, short: sha.slice(0, 7) });
  }
  return { items: items.slice(0, REF_LIMIT), truncated: items.length > REF_LIMIT };
}

async function recentCommits(root) {
  const result = await git.runGit(root, ['log', `-n${COMMIT_COUNT}`, '--no-color', '--format=%H%x09%h%x09%cs%x09%an%x09%D%x09%s', 'HEAD', '--'], SMALL);
  if (result.code !== 0) return [];
  return result.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
    const [sha, short, date, author, decoration, ...subject] = line.split('\t');
    return { kind: 'commit', label: short, value: sha, sha, short, date, author, decoration, subject: subject.join('\t').slice(0, 200) };
  });
}

// Everything the pickers need, read-only and local (no fetch): remote refs are whatever the
// repository already knows.
async function discoverRefs(root) {
  const [heads, remotes, tags, headResult, branchResult] = await Promise.all([
    listRefs(root, 'refs/heads/', 'local'),
    listRefs(root, 'refs/remotes/', 'remote'),
    listRefs(root, 'refs/tags/', 'tag', '-creatordate'),
    git.runGit(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { maxBytes: 4096 }),
    git.runGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { maxBytes: 4096 })
  ]);
  const headSha = headResult.code === 0 ? headResult.stdout.toString('utf8').trim() : undefined;
  const branch = branchResult.code === 0 ? branchResult.stdout.toString('utf8').trim() : undefined;
  const commits = headSha ? await recentCommits(root) : [];
  for (const item of heads.items) item.current = item.label === branch;
  return {
    head: { hasCommits: Boolean(headSha), sha: headSha, short: headSha && headSha.slice(0, 7), branch, detached: Boolean(headSha) && !branch },
    local: heads.items,
    remote: remotes.items,
    tags: tags.items,
    commits,
    truncated: heads.truncated || remotes.truncated || tags.truncated
  };
}

// Finds the discovered option a stored value refers to: exact value first, then a unique label
// (this also upgrades short names saved by older versions, e.g. "dev").
function findOption(refs, value) {
  const all = [...refs.local, ...refs.remote, ...refs.tags, ...refs.commits];
  const exact = all.find((o) => o.value === value);
  if (exact) return exact;
  const byLabel = all.filter((o) => o.kind !== 'commit' && o.label === value);
  return byLabel.length === 1 ? byLabel[0] : undefined;
}

// First preferred base that exists in this repository, or undefined (never HEAD).
function pickDefaultBase(refs) {
  for (const candidate of BASE_CANDIDATES) {
    const list = candidate.kind === 'local' ? refs.local : refs.remote;
    const found = list.find((o) => o.label === candidate.label);
    if (found) return found;
  }
  return undefined;
}

const shortName = (value) => String(value).replace(/^refs\/(heads|remotes|tags)\//, '');

// Turns a stored value into a picker selection after re-validating it against this repository.
async function describeSelection(root, refs, value, source) {
  const commit = await git.resolveCommit(root, value);
  if (!commit.ok) return undefined;
  const option = findOption(refs, value);
  const info = await git.describeCommit(root, commit.sha);
  return {
    value: option ? option.value : value,
    label: option ? option.label : value,
    kind: option ? option.kind : (value === 'HEAD' ? 'head' : 'manual'),
    short: info.short,
    subject: info.subject,
    source
  };
}

// Selection for a repository: saved preference if it still resolves, else (for the base) the
// first preferred candidate, else nothing. The base never falls back to HEAD silently; the
// revision defaults to HEAD. Stored values from another repository simply fail to resolve here.
async function resolveSelection(root, refs, prefs) {
  const out = { base: null, baseMessage: undefined, revision: null, revisionMessage: undefined };

  if (prefs.baseRef) {
    out.base = (await describeSelection(root, refs, prefs.baseRef, 'saved')) || null;
    if (!out.base) out.baseMessage = `Base salva "${shortName(prefs.baseRef)}" nao existe mais neste repositorio; selecione outra.`;
  }
  if (!out.base) {
    const candidate = pickDefaultBase(refs);
    if (candidate) {
      out.base = (await describeSelection(root, refs, candidate.value, 'auto')) || null;
      if (out.base) out.baseMessage = out.baseMessage ? `${out.baseMessage} Usando "${candidate.label}".` : undefined;
    }
    if (!out.base && !out.baseMessage) out.baseMessage = 'Nenhuma base padrao (dev, origin/dev, main, origin/main) encontrada; selecione uma.';
  }

  if (!refs.head.hasCommits) {
    out.revisionMessage = 'Repositorio sem commits.';
    return out;
  }
  if (prefs.revision) {
    out.revision = (await describeSelection(root, refs, prefs.revision, 'saved')) || null;
    if (!out.revision) out.revisionMessage = `Revisao salva "${prefs.revision}" nao existe mais; usando HEAD.`;
  }
  if (!out.revision) out.revision = (await describeSelection(root, refs, 'HEAD', 'default')) || null;
  return out;
}

module.exports = { discoverRefs, findOption, pickDefaultBase, describeSelection, resolveSelection, COMMIT_COUNT, BASE_CANDIDATES };


