# AGENTS.local.md — project-dock-m00

Electron (Windows) + xterm.js + node-pty (cliente Herdr) + ChatGPT Web numa WebContentsView. Só M00 (I1–I3); sem gerenciador multi-projeto.

## Comandos
- `npm install` · `npm start` (build do renderer + electron) · `npm run check` (sintaxe + node:test + bundle).

## Aprendizados acumulados
- **Não usar `electron-rebuild`**: node-pty 1.1.0 é N-API e traz prebuilds win32; o rebuild falha sem Python/VS (`GetCommitHash.bat` do winpty) e é desnecessário.
- **`HERDR_*` vaza do shell pai**: se o app é iniciado de dentro de um pane do Herdr, o filho recusa com "nested herdr is disabled" e `HERDR_SOCKET_PATH` apontaria para o servidor externo. `src/pty-env.js` remove todas as `HERDR_*`.
- **Matar o cliente PTY não derruba o servidor Herdr**: `herdr --session <nome>` é só o cliente; servidores/agentes sobrevivem (verificado). A sessão `default` do usuário nunca deve ser tocada pelos testes.
- **Testes gráficos em sessão ociosa/oculta**: `document.visibilityState` fica `hidden` por oclusão do Windows e `capturePage()` trava. Em harness, usar `--disable-features=CalculateNativeWinOcclusion`. `PrintWindow` externo retorna janela preta; captura de tela cheia expõe conteúdo pessoal — não usar.
- **`sendInputEvent` não dispara `before-input-event`**: Ctrl+Tab precisa de teclado real para ser validado (a fiação pode ser testada com `webContents.emit('before-input-event', ...)`). Dentro de um input do renderer, `sendInputEvent`/`insertText` funcionam.
- **Ctrl+Tab com flicker**: `before-input-event` dispara para keyDown, auto-repeat *e* keyUp (com Ctrl ainda pressionado). Só o keyDown com `isAutoRepeat === false` alterna (`src/shortcuts.js`); repetições são engolidas (preventDefault) para não vazar Tab ao terminal. O handler existe nos dois webContents.
- **WebContentsView cobre o DOM**: popovers/menus do renderer ficam escondidos sob o chat; controles precisam estar fora dos bounds do chat. O rodapé mede a própria altura e avisa o main (`dock:layout`, limite 420px) para recalcular os bounds; o picker de refs abre *dentro* do rodapé por isso.
- **Git somente leitura**: `GIT_OPTIONAL_LOCKS=0` evita que `git diff` reescreva o índice; refs são validadas por regex e resolvidas para SHA antes de qualquer comando; ZIPs ficam em `userData/artifacts` e só nomes gerados (`dock-*.zip`) naquela pasta podem ser excluídos.
- **Refs do Git (I3)**: o `value` de cada opção é o refname completo (`refs/heads/x`, `refs/tags/x`) para não confundir branch e tag homônimas; nomes com caracteres fora de `isSafeRef` usam o SHA como value e mantêm o label original. Prefs ficam em `ui-state.git.repos[<root em minúsculas>]`; arquivos do I2 (baseRef/revision globais) migram para o `repoDir`. O main revalida repo + ref a cada ação (`src/git-context.js`); o renderer envia `repoRoot` e o main recusa se o repo ativo mudou.
- **Clipboard de arquivo no Windows**: `Clipboard.SetFileDropList` num PowerShell `-STA` persiste após o processo sair (verificado lendo de outro processo). O caminho vai por variável de ambiente, nunca interpolado.
- **Harness**: `electron.clipboard.readText()` no main não refletiu o conteúdo no teste; verificar o clipboard por um PowerShell externo (e lembrar do `\r\n` no `trim`).
- `capturePage()` do renderer principal não inclui a `WebContentsView`; capturar o `webContents` do chat separadamente.
- **Edição de arquivos pelo PowerShell 5.1 corrompe UTF-8**: `Get-Content` sem `-Encoding UTF8` lê como ANSI (mojibake) e `Set-Content -Encoding utf8` grava BOM; crases em strings entre aspas duplas viram caracteres de controle (`` `v ``, `` `r ``). Editar com a ferramenta Edit/Write ou usar .NET com `UTF8Encoding($false)`.
