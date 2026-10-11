'use strict';

const nodeFs = require('node:fs');
const path = require('node:path');
const chatModel = require('./model');

// File persistence of the chat bindings (own file `chat-bindings.json`, see docs/decisions/0002-chat-bindings.md).
//
// Why a file of its own and not ui-state.json: ui-state is a bag of disposable preferences that is rewritten
// whole by a sanitizer that drops what it does not know and falls back to defaults on any error. Bindings are
// user-authored data: they need an atomic write, a schema version that can move independently, and a corruption
// policy that never discards anything silently. ui-state.json is not touched by this module.
//
// Load outcomes (`status`):
//   missing      no file: empty data, first save creates it
//   ok           loaded (possibly migrated; the pre-migration file is copied to <file>.bak-v<n> first)
//   recovered    unreadable/invalid JSON or wrong top-level shape: the original is MOVED to
//                <file>.corrupt-<timestamp> (kept for the user) and the store starts empty
//   unsupported  written by a newer ContextDeck (schema > ours): kept byte-for-byte, store is READ-ONLY
//   unreadable   the file exists but cannot be read (permissions, locked): READ-ONLY, never overwritten
// In every read-only status `save` refuses, so an older build cannot clobber data it does not understand.

const WRITABLE = new Set(['missing', 'ok', 'recovered']);

// `model` ({ emptyData, sanitizeData, migrate }) lets the project bindings reuse these file policies with their own schema.
function createBindingsStore({ file, fs = nodeFs, now = () => Date.now(), model = chatModel }) {
  const { emptyData, sanitizeData, migrate } = model;
  let status = 'missing';
  let notice = null;
  let data = emptyData();

  function preserveCorrupt(reason) {
    const backup = `${file}.corrupt-${now()}`;
    try { fs.renameSync(file, backup); } catch {
      // The original could not be moved: leave it alone and stay read-only rather than overwrite it.
      status = 'unreadable';
      notice = { code: 'corrupt_not_preserved', message: `Arquivo de vinculos invalido (${reason}) e nao foi possivel preserva-lo.`, file };
      return false;
    }
    status = 'recovered';
    notice = { code: 'corrupt_preserved', message: `Arquivo de vinculos invalido (${reason}). Uma copia foi preservada.`, backup };
    return true;
  }

  function load() {
    status = 'missing';
    notice = null;
    data = emptyData();
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (error) {
      if (error && error.code === 'ENOENT') return info();
      status = 'unreadable';
      notice = { code: 'read_failed', message: 'Nao foi possivel ler o arquivo de vinculos; ele nao sera alterado.', detail: error && error.code };
      return info();
    }
    let doc;
    try { doc = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { preserveCorrupt('JSON invalido'); return info(); }
    const migrated = migrate(doc);
    if (migrated.status === 'future') {
      status = 'unsupported';
      notice = { code: 'future_schema', message: `Os vinculos foram gravados por uma versao mais nova (schema ${migrated.schema}). Somente leitura.`, schema: migrated.schema };
      return info();
    }
    if (migrated.status === 'invalid') { preserveCorrupt(migrated.reason || 'estrutura invalida'); return info(); }
    if (migrated.migratedFrom !== null) {
      try { fs.copyFileSync(file, `${file}.bak-v${migrated.migratedFrom}`); } catch {
        status = 'unreadable';
        notice = { code: 'backup_failed', message: 'Nao foi possivel criar a copia antes da migracao; o arquivo nao foi alterado.' };
        return info();
      }
    }
    const { data: clean, rejected } = sanitizeData(migrated.doc, now());
    data = clean;
    status = 'ok';
    if (rejected > 0) notice = { code: 'entries_quarantined', message: `${rejected} vinculo(s) invalido(s) foram separados (quarentena) e preservados no arquivo.`, count: rejected };
    return info();
  }

  const info = () => ({ status, notice, writable: WRITABLE.has(status) });

  // Atomic replace: write a sibling temp file, then rename over the target. A failure at any step leaves the
  // previous file intact and throws; the caller keeps its in-memory state unchanged.
  function writeAtomic(next) {
    const dir = path.dirname(file);
    const tmp = `${file}.tmp-${process.pid}-${now()}`;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
      fs.renameSync(tmp, file);
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
      throw error;
    }
  }

  function save(next) {
    if (!WRITABLE.has(status)) {
      const e = new Error('Os vinculos estao em modo somente leitura.');
      e.code = 'store_readonly';
      throw e;
    }
    writeAtomic(next);
    data = next;
    if (status === 'missing') status = 'ok';   // 'recovered' and its notice stay visible until the next load
  }

  load();
  return {
    load,
    save,
    get: () => data,
    info,
    file
  };
}

module.exports = { createBindingsStore };
