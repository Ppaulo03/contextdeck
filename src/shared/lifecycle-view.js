'use strict';

// Words for the view lifecycle (M01-I3C-1): what a conversation's page is doing with its resources and, when it cannot be released, WHY.
// Pure data and no DOM. The codes are the contract with src/main/chat-views/lifecycle.js (REASON); nothing here decides anything - main
// judges again, from fresh state and a fresh reading, when the user asks.

const STATE_TEXT = {
  created: 'Carregando',
  restoring: 'Restaurando',
  active: 'Em uso',
  background: 'Em segundo plano',
  suspended: 'Suspensa (não monitorada)'
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
  'operation-in-progress': 'Outra operação está em andamento.'
};

const SUSPEND_LABEL = 'Suspender conversa';
const SUSPEND_HELP = 'Libera a memória desta página. A conversa continua na lista e é recarregada quando você a abrir; rolagem e estado visual da página se perdem.';
const SUSPENDED_HELP = 'Suspensa: a página foi liberada e não é monitorada. Não se sabe se está respondendo ou ociosa. Abra para restaurar.';

// `life` is { state, eligible, reasons } as main reports it, or null/undefined when the conversation has no page (never opened).
// A page that cannot be suspended is never offered a button: it gets the reasons instead.
function lifeModel(life) {
  if (!life || typeof life !== 'object') return null;
  const reasons = (Array.isArray(life.reasons) ? life.reasons : []).map((r) => REASON_TEXT[r] || 'Não pode ser suspensa agora.');
  if (life.state === 'suspended') return { state: 'suspended', stateText: STATE_TEXT.suspended, canSuspend: false, reasons: [], help: SUSPENDED_HELP };
  const canSuspend = life.eligible === true && reasons.length === 0;
  return {
    state: life.state,
    stateText: STATE_TEXT[life.state] || '',
    canSuspend,
    label: SUSPEND_LABEL,
    reasons,
    help: canSuspend ? SUSPEND_HELP : `Não pode ser suspensa agora: ${reasons.join(' ')}`.trim()
  };
}

module.exports = { lifeModel, STATE_TEXT, REASON_TEXT, SUSPEND_LABEL, SUSPEND_HELP, SUSPENDED_HELP };
