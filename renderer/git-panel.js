// Footer panel with the Git tools. All git work happens in the main process behind fixed IPC
// channels. The renderer only renders what main discovered and sends back the repository it was
// looking at (`repoRoot`) plus the chosen ref; main re-validates both before running anything.
//
// The picker list lives inside the footer (not in a floating popover) because the ChatGPT view
// is a native view that would hide any DOM overlay; the footer reports its height to main, so
// opening the list simply makes the footer taller instead of covering the page.
const BADGES = { head: 'HEAD', commit: 'commit', local: 'local', remote: 'remota', tag: 'tag', manual: 'manual' };
const MAX_RENDERED = 150;

export function initGitPanel({ dock, setNotice }) {
  const $ = (id) => document.getElementById(id);
  const footer = $('footer');
  const repoLabel = $('git-repo');
  const pickButton = $('git-pick');
  const refreshButton = $('git-refresh');
  const diffButton = $('git-diff');
  const showButton = $('git-show');
  const zipButton = $('git-zip');
  const deleteButton = $('git-zip-delete');
  const hint = $('git-hint');
  const panel = $('picker-panel');
  const search = $('picker-search');
  const list = $('picker-list');
  const revResolved = $('rev-resolved');
  const triggers = { base: $('base-btn'), revision: $('rev-btn') };

  let status = { configured: false };
  let data; // { root, refs, selection } from the last successful refresh
  let selected = { base: null, revision: null };
  let messages = { base: '', revision: '', repo: '' };
  let busy = false;
  let armTimer;
  let open; // { which, entries, active }

  const optionKey = (which) => (which === 'base' ? 'baseRef' : 'revision');

  // ---- rendering of the compact controls --------------------------------------------------

  function describe(sel, which) {
    if (!sel) return which === 'base' ? 'selecione a base…' : 'selecione…';
    if (sel.kind === 'head') {
      const head = data?.refs.head;
      return head?.branch ? `HEAD (${head.branch})` : 'HEAD (detached)';
    }
    return sel.kind === 'commit' ? sel.short : sel.label;
  }

  function renderTriggers() {
    for (const which of ['base', 'revision']) {
      const button = triggers[which];
      const sel = selected[which];
      button.textContent = describe(sel, which);
      button.disabled = busy || !data;
      button.classList.toggle('invalid', Boolean(data) && !sel);
      button.title = sel ? `${BADGES[sel.kind] || ''} ${sel.value}\n${sel.short} ${sel.subject || ''}`.trim() : (messages[which] || '');
    }
    const rev = selected.revision;
    revResolved.textContent = rev ? `→ ${rev.short}` : '';
    revResolved.title = rev ? `${rev.short} ${rev.subject}` : '';
    const text = [messages.repo, messages.base, messages.revision].filter(Boolean).join(' · ');
    hint.textContent = text;
    hint.hidden = !text;
  }

  function disarm() {
    clearTimeout(armTimer);
    deleteButton.classList.remove('armed');
    deleteButton.textContent = 'Excluir ZIP';
  }

  function render() {
    repoLabel.textContent = status.configured ? `Git: ${status.name}${status.suggested ? ' (sugerido)' : ''}` : 'Git: nao configurado';
    repoLabel.title = status.configured ? status.root : (status.error || '');
    repoLabel.classList.toggle('unset', !status.configured);
    const ready = status.configured && Boolean(data);
    diffButton.disabled = busy || !ready || !selected.base;
    showButton.disabled = busy || !ready || !selected.revision;
    zipButton.disabled = busy || !ready || !selected.revision;
    diffButton.title = selected.base ? `git diff ${selected.base.short} (${describe(selected.base, 'base')}; somente arquivos rastreados)` : 'Selecione uma base valida';
    showButton.title = selected.revision ? `git show ${selected.revision.short}` : 'Selecione uma revisao valida';
    zipButton.title = selected.revision ? `git archive ${selected.revision.short} ${selected.revision.subject} → ZIP copiado como arquivo` : 'Selecione uma revisao valida';
    pickButton.disabled = busy;
    refreshButton.disabled = busy || !status.configured;
    deleteButton.disabled = busy || !status.zip;
    deleteButton.title = status.zip ? `Excluir ${status.zip.name} (${status.zip.sizeText})` : 'Nenhum ZIP gerado por esta aplicacao';
    if (!status.zip) disarm();
    renderTriggers();
  }

  // ---- data -------------------------------------------------------------------------------

  async function refresh() {
    closePicker();
    status = (await dock.gitStatus()) || { configured: false };
    data = undefined;
    selected = { base: null, revision: null };
    messages = { base: '', revision: '', repo: '' };
    if (status.configured) {
      const result = await dock.gitRefs();
      if (result?.ok) {
        data = result;
        selected = { base: result.selection.base, revision: result.selection.revision };
        messages.base = result.selection.baseMessage || '';
        messages.revision = result.selection.revisionMessage || '';
        if (result.refs.truncated) messages.repo = 'Lista de referencias truncada (500 por tipo); use a busca ou referencia manual.';
      } else {
        messages.repo = result?.error || 'Falha ao ler referencias.';
      }
    } else if (status.error) {
      messages.repo = status.error;
    }
    render();
  }

  async function run(task) {
    busy = true;
    disarm();
    closePicker();
    render();
    setNotice('Executando Git...');
    let result;
    try { result = await task(); } catch (error) { result = { ok: false, error: error?.message || String(error) }; }
    busy = false;
    if (!result?.cancelled) setNotice(result?.ok ? result.message : `Erro: ${result?.error || 'falha desconhecida'}`);
    await refresh();
  }

  const args = (which) => ({ repoRoot: data.root, [optionKey(which)]: selected[which].value });

  // ---- picker -----------------------------------------------------------------------------

  function groupedOptions(which) {
    const refs = data.refs;
    const groups = [];
    if (which === 'revision') {
      if (refs.head.hasCommits) groups.push(['HEAD', [{ kind: 'head', label: 'HEAD', value: 'HEAD', short: refs.head.short, subject: refs.commits[0]?.subject || '', detail: refs.head.branch ? `branch ${refs.head.branch}` : 'detached' }]]);
      groups.push([`Commits recentes (${refs.commits.length})`, refs.commits.map((c) => ({ ...c, detail: `${c.subject} · ${c.date} · ${c.author}` }))]);
    }
    groups.push(['Branches locais', refs.local.map((o) => ({ ...o, detail: `${o.short}${o.current ? ' · atual' : ''}` }))]);
    groups.push(['Branches remotas', refs.remote.map((o) => ({ ...o, detail: o.short }))]);
    groups.push(['Tags', refs.tags.map((o) => ({ ...o, detail: o.short }))]);
    return groups;
  }

  function matches(option, query) {
    if (!query) return true;
    const hay = `${option.label} ${option.short || ''} ${option.sha || ''} ${option.subject || ''} ${option.author || ''} ${option.decoration || ''}`.toLowerCase();
    return query.toLowerCase().split(/\s+/).every((part) => hay.includes(part));
  }

  function buildEntries(which, query) {
    const entries = [];
    let rendered = 0;
    let hidden = 0;
    const all = groupedOptions(which);
    for (const [title, options] of all) {
      const found = options.filter((o) => matches(o, query));
      if (!found.length) continue;
      entries.push({ group: title });
      for (const option of found) {
        if (rendered >= MAX_RENDERED) { hidden++; continue; }
        entries.push({ option });
        rendered++;
      }
    }
    if (hidden) entries.push({ note: `… mais ${hidden} resultados; refine a busca.` });
    const text = query.trim();
    const exact = all.some(([, options]) => options.some((o) => o.label === text || o.value === text));
    if (text && !exact) entries.push({ option: { kind: 'manual', label: text, value: text, detail: 'referencia manual (sera validada)' } });
    if (!entries.some((e) => e.option)) entries.unshift({ note: 'Nenhuma referencia encontrada.' });
    return entries;
  }

  function renderList() {
    list.textContent = '';
    const current = selected[open.which];
    open.entries.forEach((entry, index) => {
      const li = document.createElement('li');
      if (entry.group || entry.note) {
        li.className = entry.group ? 'group' : 'empty';
        li.setAttribute('role', 'presentation');
        li.textContent = entry.group || entry.note;
      } else {
        const { option } = entry;
        li.id = `picker-opt-${index}`;
        li.setAttribute('role', 'option');
        const isCurrent = current && current.value === option.value;
        li.setAttribute('aria-selected', String(Boolean(isCurrent)));
        li.className = `${isCurrent ? 'selected ' : ''}${index === open.active ? 'active' : ''}`.trim();
        const badge = document.createElement('span');
        badge.className = `badge ${option.kind}`;
        badge.textContent = BADGES[option.kind];
        const label = document.createElement('span');
        label.className = 'olabel';
        label.textContent = option.label;
        const detail = document.createElement('span');
        detail.className = 'odetail';
        detail.textContent = option.detail || '';
        li.append(badge, label, detail);
        li.addEventListener('mousedown', (event) => { event.preventDefault(); void choose(index); });
      }
      list.appendChild(li);
    });
    const activeEl = list.querySelector('li.active');
    search.setAttribute('aria-activedescendant', activeEl ? activeEl.id : '');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest' });
  }

  const firstOption = (entries, from, step) => {
    for (let i = from; i >= 0 && i < entries.length; i += step) if (entries[i].option) return i;
    return -1;
  };

  function openPicker(which) {
    if (!data || busy) return;
    if (open?.which === which) return closePicker(true);
    const entries = buildEntries(which, '');
    open = { which, entries, active: Math.max(0, firstOption(entries, 0, 1)) };
    const idx = entries.findIndex((e) => e.option && selected[which] && e.option.value === selected[which].value);
    if (idx >= 0) open.active = idx;
    search.value = '';
    panel.hidden = false;
    for (const [name, button] of Object.entries(triggers)) button.setAttribute('aria-expanded', String(name === which));
    renderList();
    search.focus();
  }

  function closePicker(focusTrigger = false) {
    if (!open) return;
    const { which } = open;
    open = undefined;
    panel.hidden = true;
    for (const button of Object.values(triggers)) button.setAttribute('aria-expanded', 'false');
    if (focusTrigger) triggers[which].focus();
  }

  async function choose(index) {
    const entry = open?.entries[index];
    if (!entry?.option) return;
    const { which } = open;
    const result = await dock.gitSetRefs({ repoRoot: data.root, [optionKey(which)]: entry.option.value });
    if (!result?.ok) {
      messages[which] = result?.error || 'Referencia invalida.';
      if (result?.stale) return void (await refresh());
      renderTriggers(); // Keep the picker open so another ref can be typed.
      return;
    }
    messages[which] = '';
    selected[which] = result[which === 'base' ? 'base' : 'revision'];
    closePicker(true);
    render();
  }

  search.addEventListener('input', () => {
    open.entries = buildEntries(open.which, search.value);
    open.active = Math.max(0, firstOption(open.entries, 0, 1));
    renderList();
  });
  search.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const next = firstOption(open.entries, open.active + step, step);
      if (next >= 0) { open.active = next; renderList(); }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      void choose(open.active);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closePicker(true);
    }
  });
  for (const [which, button] of Object.entries(triggers)) {
    button.addEventListener('click', () => openPicker(which));
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowDown') { event.preventDefault(); openPicker(which); }
    });
  }
  document.addEventListener('mousedown', (event) => {
    if (open && !panel.contains(event.target) && !Object.values(triggers).includes(event.target)) closePicker();
  });

  // ---- actions ----------------------------------------------------------------------------

  pickButton.addEventListener('click', () => void run(() => dock.gitPickRepo()));
  refreshButton.addEventListener('click', () => void run(async () => ({ ok: true, message: 'Referencias atualizadas (sem fetch).' })));
  diffButton.addEventListener('click', () => void run(() => dock.gitCopyDiff(args('base'))));
  showButton.addEventListener('click', () => void run(() => dock.gitCopyShow(args('revision'))));
  zipButton.addEventListener('click', () => void run(() => dock.gitMakeZip(args('revision'))));

  // Two-step confirmation instead of a dialog; only the ZIP generated last by this app can be removed.
  deleteButton.addEventListener('click', () => {
    if (!status.zip) return;
    if (!deleteButton.classList.contains('armed')) {
      deleteButton.classList.add('armed');
      deleteButton.textContent = 'Confirmar exclusao?';
      setNotice(`Excluir ${status.zip.name}? Mantenha o arquivo ate concluir a colagem/anexo. Clique de novo para confirmar.`);
      armTimer = setTimeout(disarm, 6000);
      return;
    }
    void run(() => dock.gitDeleteZip());
  });

  // Refs change from the terminal (commits, branches); pick them up when the window regains focus.
  let lastFocusRefresh = 0;
  window.addEventListener('focus', () => {
    if (busy || open || Date.now() - lastFocusRefresh < 3000) return;
    lastFocusRefresh = Date.now();
    void refresh();
  });

  new ResizeObserver(() => void dock.reportLayout({ footerHeight: footer.offsetHeight })).observe(footer);

  void (async () => {
    await refresh();
    if (!status.configured) setNotice(status.error || 'Repositorio nao configurado.');
  })();
}
