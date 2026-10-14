'use strict';

// Concise lifecycle presentation. Detailed reason codes remain in main-process diagnostics; main owns all safety decisions.

const STATE_TEXT = {
  created: 'Carregando',
  restoring: 'Restaurando',
  active: 'Em uso',
  background: 'Em segundo plano',
  suspended: 'Suspensa · Não monitorada'
};

const REASON_TEXT = {
  'selected': 'É a conversa que você está vendo.',
  'initial-page': 'É a página inicial do aplicativo.',
  'temporary-page': 'Conversa temporária, sem vínculo: não há como recuperá-la com segurança.',
  'no-recoverable-identity': 'Ainda não tem identidade persistente: não pode ser recuperada.',
  'not-ready': 'A página não está pronta.',
  'navigating': 'A página está carregando ou navegando.',
  'identity-unconfirmed': 'A página não confirmou mostrar esta conversa.',
  'creating': 'Uma nova conversa ainda está sendo criada aqui.',
  'pending-decision': 'Há uma decisão pendente sobre esta conversa.',
  'conflict': 'Esta conversa pertence a outro workspace.',
  'duplicate': 'Outra página mostra a mesma conversa.',
  'workspace-switching': 'Uma troca de workspace está em andamento.',
  'binding-unavailable': 'O vínculo desta conversa não está disponível.',
  'recovery-url': 'O endereço de recuperação não é confiável.',
  'observation-unavailable': 'A conversa não está sendo observada: o estado dela é desconhecido.',
  'observation-stale': 'A leitura do estado está desatualizada.',
  'state-unknown': 'Não foi possível confirmar que a conversa está ociosa.',
  'uncertain': 'Uma resposta pode estar em andamento (o término não foi confirmado).',
  'responding': 'Está respondendo.',
  'draft': 'Há um rascunho não enviado.',
  'draft-unknown': 'Não foi possível verificar se há rascunho.',
  'attention': 'Há atividade para revisar.',
  'operation-in-progress': 'Outra operação está em andamento.',
  'unsent-content': 'Esta conversa possui um anexo ou upload pendente.',
  'unsent-unknown': 'Não foi possível confirmar que não há conteúdo não enviado.',
  'residual-unbound': 'Esta página não tem vínculo persistente para recuperação após reiniciar.',
  'destroy-unconfirmed': 'Não foi possível confirmar a liberação da página; ela continua sob gerenciamento.'
};

const SUSPEND_LABEL = 'Suspender conversa';
const SUSPEND_HELP = 'Libera a memória desta página após uma verificação. A conversa vinculada é recarregada quando você a abrir; anexos não enviados, rolagem e estado visual não são preservados.';
const SUSPENDED_HELP = 'Suspensa: a página foi liberada e não é monitorada. Não se sabe se está respondendo ou ociosa. Abra para restaurar.';
const UNAVAILABLE_HELP = 'Não foi possível verificar se é seguro suspender esta conversa.';

// `life` is { state, eligible, reasons } as main reports it, or null/undefined when the conversation has no page (never opened).
// A page that cannot be suspended is never offered a button; its row gets one concise status.
function lifeModel(life) {
  if (!life || typeof life !== 'object') return null;
  const codes = Array.isArray(life.reasons) ? life.reasons : [];
  if (life.state === 'suspended') return { state: 'suspended', stateText: STATE_TEXT.suspended, statusText: STATE_TEXT.suspended, canSuspend: false, help: SUSPENDED_HELP };
  const canSuspend = life.eligible === true && codes.length === 0;
  const statusText = codes.includes('responding') || codes.includes('uncertain') ? 'Respondendo'
    : codes.includes('draft') ? 'Rascunho pendente'
      : life.state === 'active' ? STATE_TEXT.active
        : life.state === 'created' || life.state === 'restoring' ? (STATE_TEXT[life.state] || 'Suspensão indisponível')
          : canSuspend ? STATE_TEXT[life.state] || 'Suspensão indisponível' : 'Suspensão indisponível';
  return {
    state: life.state,
    stateText: STATE_TEXT[life.state] || '',
    statusText,
    canSuspend,
    label: SUSPEND_LABEL,
    help: canSuspend ? SUSPEND_HELP : (statusText === 'Respondendo' || statusText === 'Rascunho pendente' ? '' : UNAVAILABLE_HELP)
  };
}

module.exports = { lifeModel, STATE_TEXT, REASON_TEXT, SUSPEND_LABEL, SUSPEND_HELP, SUSPENDED_HELP, UNAVAILABLE_HELP };
