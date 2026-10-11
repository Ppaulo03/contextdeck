// Workspace selector in the top bar (M01-I2). It renders the state computed in the main process and
// reports the user's choices; it never decides anything about Herdr itself.
//
// Rule: updating the dropdown from state must not send workspace.focus. Setting `select.value` from
// code does not fire a `change` event, and the handler additionally ignores changes made while
// the UI is applying state, so only a real user choice reaches `herdrSelectWorkspace`.
export function initWorkspaceSelector({ dock, setNotice }) {
  const select = document.getElementById('ws-select');
  const modeButton = document.getElementById('ws-mode');
  const busy = document.getElementById('ws-busy');
  let state = null;
  let applying = false;
  let signature = '';

  const label = (o) => `${o.id} · ${o.label || '(sem nome)'}`;

  function placeholderText(sel) {
    if (!sel || sel.connection !== 'connected') return sel && sel.connection === 'connecting' ? 'Conectando ao Herdr…' : 'Herdr desconectado';
    if (sel.unavailableId) return `${sel.unavailableId} indisponível — escolha outro`;
    return 'Selecione um workspace';
  }

  function render() {
    const sel = state && state.selection;
    const options = sel ? sel.options : [];
    const connected = Boolean(sel && sel.connection === 'connected');
    const sig = JSON.stringify([connected, sel && sel.connection, options.map((o) => [o.id, o.label]), sel && sel.unavailableId]);
    applying = true;
    if (sig !== signature) {
      signature = sig;
      select.textContent = '';
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.disabled = true;
      placeholder.textContent = placeholderText(sel);
      select.append(placeholder);
      // The id is always shown, so workspaces with the same name stay distinguishable.
      for (const o of options) {
        const option = document.createElement('option');
        option.value = o.id;
        option.textContent = label(o);
        select.append(option);
      }
    }
    const wanted = sel && sel.selected ? sel.selected.workspaceId : '';
    if (select.value !== wanted) select.value = wanted;
    applying = false;

    const pending = Boolean(sel && sel.pending);
    select.disabled = !(sel && sel.canSelect);
    select.setAttribute('aria-busy', String(pending));
    busy.hidden = !pending;
    const auto = !sel || sel.mode === 'auto';
    modeButton.textContent = auto ? 'Auto' : 'Manual';
    modeButton.setAttribute('aria-pressed', String(auto));
    modeButton.disabled = !sel;
    const observed = sel && sel.observedId ? `Foco atual do Herdr: ${sel.observedId}. ` : '';
    modeButton.title = auto
      ? 'Automático: acompanha o último foco do Herdr (estimativa: com mais de um cliente conectado pode divergir). Clique para alternar para manual.'
      : 'Manual: mudanças de foco no Herdr não alteram esta escolha. Clique para acompanhar o foco do Herdr.';
    select.title = `${observed}${sel && sel.selected ? `Selecionado via ${{ dock: 'ContextDeck', herdr: 'foco do Herdr', recovery: 'recuperação' }[sel.selected.origin] || sel.selected.origin}.` : ''}`.trim();
  }

  select.addEventListener('change', async () => {
    if (applying || !state || !select.value) return;
    const workspaceId = select.value;
    const result = await dock.herdrSelectWorkspace({ session: state.session, workspaceId });
    if (!result || !result.ok) {
      if (!result || !result.stale) setNotice(`Workspace: ${result && result.error ? result.error.message : 'falha ao trocar'}`);
      render(); // put the dropdown back in line with the real state
    }
  });

  modeButton.addEventListener('click', async () => {
    if (!state || !state.selection) return;
    const next = state.selection.mode === 'auto' ? 'manual' : 'auto';
    const result = await dock.herdrSetSyncMode({ mode: next });
    if (!result || !result.ok) setNotice('Não foi possível alterar o modo de sincronização.');
  });

  dock.onHerdrState((next) => { state = next; render(); });
  void dock.herdrState().then((initial) => { if (initial) { state = initial; render(); } });
  render();
}
