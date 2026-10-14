'use strict';

// What is read from the ChatGPT page, and nothing else. The probes run in an ISOLATED world: they see the DOM
// but not the page's JavaScript, expose no channel to the page, and return only booleans, counts and short
// control attributes. They never return, log or store message text. The draft check reads the length of the
// composer locally to answer "empty or not"; the text itself is discarded inside the probe.
//
// The UI is not a contract. The composer is therefore located in tiers, from specific to structural, and the
// tier that matched is reported (`via`) so a failure can be diagnosed instead of guessed:
//   candidate   a known selector (textarea[data-octane-input], #prompt-textarea, ...)
//   structural  the last visible editable element (textarea / contenteditable / role=textbox) inside a <form>
//               that also holds a submit control
//   lone        the only visible editable element of the document
//   shadow      the same search inside open shadow roots
// The send/stop control is read from the composer's own form, not from a single selector. First live result:
// the candidate selectors found on the logged-OUT page matched nothing on the logged-in page, which is why
// the structural tiers exist (see docs/validation/m01-i3p.md).
const CANDIDATES = Object.freeze({
  composer: ['textarea[data-octane-input]', '[data-octane-input][contenteditable]', 'textarea[name="prompt"]', '#prompt-textarea', '[data-testid="prompt-textarea"]'],
  submit: ['[data-composer-submit]', '[data-testid="send-button"]', '[data-testid="stop-button"]'],
  stop: ['[data-testid="stop-button"]'],
  turnActions: ['[data-testid="copy-turn-action-button"]', '[data-testid="good-response-turn-action-button"]'],
  error: ['[role="alert"]']
});
const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
const SUBMIT_IN_FORM = 'button[type="submit"], [data-composer-submit], [data-testid="send-button"], [data-testid="stop-button"]';
const STOP_LABEL = '^(stop|parar|interromper|detener|arr[eê]ter|stopp)';
const STOP_VALUE = '^(stop|stopping|streaming|generating|responding)$';
// Signals beyond the composer's form (M01-I3B-2R). While a document / canvas / tool is being produced the stop control can
// live outside the composer's form (or the form can be replaced), so reading only the form reports "no stop" while the
// response goes on. Two extra, passive signals, each reported separately with its own reliability:
//   stopWide  a visible control anywhere on the page whose accessible label starts like a stop label (or whose test id says
//             stop), outside the controls already read; labels about voice/sharing/recording are excluded.
//   busy      a visible element flagged aria-busy / streaming.
// Neither can START a response (only the strong signal does); they only keep a response that was observed from being declared
// over (see state-model.js).
const WIDE_CONTROLS = 'button, [role="button"]';
const WIDE_LIMIT = 600;
const STOP_NOISE = '(voice|voz|voix|share|sharing|compartilh|partag|record|gravar|gravando|dictat|ditad|screen|tela|audio|\u00e1udio|call|chamada|ouvi|listen|leitura|read|speak|fala|camera|c\u00e2mera)';
// Live (trace): a class token such as "AdaptiveStreaming-<hash>" exists on the page exactly while an answer is being streamed.
const BUSY_SELECTOR = '[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"], [class*="Streaming"], [class*="streaming"]';
const BUSY_LIMIT = 200;
const WORLD_ID = 1001;
const SHADOW_SCAN_LIMIT = 5000;

// Shared by both probes: tiered composer lookup. Returns { composer, via }.
const FIND_COMPOSER = `
  const first = (list) => { for (const s of list) { const e = document.querySelector(s); if (e) return e; } return null; };
  const visible = (e) => !!e && !e.hidden && e.getClientRects().length > 0;
  const findComposer = () => {
    const known = first(C.composer);
    if (known) return { composer: known, via: 'candidate' };
    const editable = [...document.querySelectorAll(${JSON.stringify(EDITABLE)})].filter(visible);
    let inForm = null;
    for (const e of editable) {
      const form = e.closest ? e.closest('form') : null;
      if (form && form.querySelector(${JSON.stringify(SUBMIT_IN_FORM)})) inForm = e;   // the composer is the last one: edit boxes of earlier messages come before it
    }
    if (inForm) return { composer: inForm, via: 'structural' };
    if (editable.length === 1) return { composer: editable[0], via: 'lone' };
    let scanned = 0;
    for (const host of document.querySelectorAll('*')) {
      if (++scanned > ${SHADOW_SCAN_LIMIT}) break;
      const root = host.shadowRoot;
      if (!root) continue;
      const e = [...root.querySelectorAll(${JSON.stringify(EDITABLE)})].filter(visible).pop();
      if (e) return { composer: e, via: 'shadow' };
    }
    return { composer: null, via: null };
  };`;

// Conservative lifecycle proof. A selected file or visible progress bar inside the selected composer form proves
// pending work. Empty file inputs, absent forms and an apparently quiet composer do not prove absence: ChatGPT can
// clear the input after upload and may render staged attachments outside the editable element.
const UNSENT_SCAN = `
  const form = composer && composer.closest ? composer.closest('form') : null;
  let populatedFileInputs = 0;
  let progressbars = 0;
  if (form) {
    for (const input of form.querySelectorAll('input[type="file"]')) if (input.files && input.files.length > 0) populatedFileInputs += 1;
    progressbars = [...form.querySelectorAll('[role="progressbar"]')].filter(visible).length;
  }
  const unsentState = !composer || !form ? 'unknown' : (populatedFileInputs > 0 || progressbars > 0 ? 'present' : 'unknown');`;
// Authenticated discovery captures bounded structural relations only: never text, attribute values,
// URLs, file names or file data. Ancestor counts help compare the same surface before/after user actions.
const COMPOSER_STRUCTURE_TRACE = `
  const tagName = (e) => e && e.tagName ? String(e.tagName).toLowerCase().slice(0, 16) : 'unknown';
  const roleName = (e) => ['textbox','button','listitem','group','progressbar','toolbar','presentation','img'].includes(e && e.getAttribute ? e.getAttribute('role') : '') ? e.getAttribute('role') : 'other';
  const count = (root, selector) => { try { return root && root.querySelectorAll ? root.querySelectorAll(selector).length : 0; } catch { return 0; } };
  const scopeMetrics = (root) => ({
    buttons: count(root, 'button'), roleButtons: count(root, '[role="button"]'), images: count(root, 'img, [role="img"]'),
    fileInputs: count(root, 'input[type="file"]'), progressbars: count(root, '[role="progressbar"]'), busyNodes: count(root, '[aria-busy="true"]'),
    testIdNodes: count(root, '[data-testid]'), labeledNodes: count(root, '[aria-label]'), listItems: count(root, '[role="listitem"]'),
    attachmentAttrNodes: count(root, '[data-attachment], [data-file-id], [data-upload-state]'), submitControls: count(root, ${JSON.stringify(SUBMIT_IN_FORM)})
  });
  const editableNodes = [...document.querySelectorAll(${JSON.stringify(EDITABLE)})];
  const visibleEditableNodes = editableNodes.filter(visible);
  const eligibleForms = [...document.querySelectorAll('form')].filter((f) => visibleEditableNodes.some((e) => e.closest && e.closest('form') === f) && f.querySelector(${JSON.stringify(SUBMIT_IN_FORM)})).length;
  const editableStructure = editableNodes.slice(0, 8).map((e, index) => {
    const ancestry = []; let node = e;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) ancestry.push({ depth, tag: tagName(node), role: roleName(node), visible: visible(node), ...scopeMetrics(node) });
    const ownForm = e.closest ? e.closest('form') : null;
    return { index, tag: tagName(e), role: roleName(e), visible: visible(e), contentEditable: e.getAttribute && e.getAttribute('contenteditable') === 'true', inForm: !!ownForm,
      formHasSubmit: !!(ownForm && ownForm.querySelector(${JSON.stringify(SUBMIT_IN_FORM)})), ancestry };
  });
  const candidateHits = Object.fromEntries(Object.entries(C).map(([key, selectors]) => [key, selectors.map((selector) => count(document, selector))]));
  const fileNodes = [...document.querySelectorAll('input[type="file"]')];
  const fileInputEvidence = { total: document.querySelectorAll('input[type="file"]').length,
    visible: fileNodes.filter(visible).length,
    populated: fileNodes.filter((input) => input.files && input.files.length > 0).length,
    inComposerForm: form ? count(form, 'input[type="file"]') : 0 };
  const documentEvidence = { formCount: document.querySelectorAll('form').length, eligibleFormCount: eligibleForms,
    visibleEditableCount: visibleEditableNodes.length, totalEditableCount: editableNodes.length,
    visibleProgressbars: [...document.querySelectorAll('[role="progressbar"]')].filter(visible).length,
    visibleBusyNodes: [...document.querySelectorAll('[aria-busy="true"]')].filter(visible).length };
`;
const COMPOSER_NEIGHBORHOOD_TRACE = `
  const neighborhoodSelector = 'input[type="file"], [role="progressbar"], [aria-busy="true"], [role="listitem"], img, button, [role="button"], [data-testid], [data-attachment], [data-file-id], [data-upload-state], [aria-label], [title]';
  const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
  const semanticSignals = (e) => {
    const values = ['data-testid', 'aria-label', 'title'].map((name) => e.getAttribute ? e.getAttribute(name) : '');
    const attachment = !!(e.hasAttribute && (e.hasAttribute('data-attachment') || e.hasAttribute('data-file-id'))) || values.some((value) => matches(value, /(attach|file|upload|document)/i));
    const upload = !!(e.hasAttribute && e.hasAttribute('data-upload-state')) || values.some((value) => matches(value, /(upload|progress|processing)/i));
    const remove = values.some((value) => matches(value, /(remove|delete|clear|detach)/i));
    const role = e.getAttribute ? e.getAttribute('role') : '';
    return [
      ...(e.matches && e.matches('input[type="file"]') ? ['file-input'] : []),
      ...(role === 'progressbar' ? ['progressbar'] : []),
      ...(e.getAttribute && e.getAttribute('aria-busy') === 'true' ? ['busy'] : []),
      ...(attachment ? ['attachment-hint'] : []), ...(upload ? ['upload-hint'] : []), ...(remove ? ['remove-hint'] : []),
      ...(role === 'listitem' ? ['list-item'] : []), ...(e.tagName === 'IMG' || role === 'img' ? ['image'] : []),
      ...((e.tagName === 'BUTTON' || role === 'button') && (attachment || upload || remove) ? ['labeled-button'] : [])
    ];
  };
  const messageBoundary = (e) => e && e.closest ? e.closest('article, [data-message-author-role], [data-testid*="conversation-turn"], [data-testid*="message"]') : null;
  const visibleCandidates = visibleEditableNodes.slice(0, 8);
  const targets = composer
    ? [{ node: composer, editableIndex: visibleCandidates.indexOf(composer), selected: true }]
    : visibleCandidates.map((node, editableIndex) => ({ node, editableIndex, selected: false }));
  const candidates = new Map();
  for (const target of targets) {
    const targetForm = target.node.closest ? target.node.closest('form') : null;
    const targetBoundary = messageBoundary(target.node);
    const roots = [];
    if (targetForm) roots.push({ node: targetForm, depth: 0 });
    let parent = target.node.parentElement;
    for (let depth = 1; parent && depth <= 3; depth += 1, parent = parent.parentElement) roots.push({ node: parent, depth });
    for (const root of roots) {
      const pending = [{ node: root.node, depth: 0 }];
      let visited = 0;
      while (pending.length && visited < 48) {
        const current = pending.pop();
        const node = current.node;
        visited += 1;
        if (node !== target.node && node.matches && node.matches(neighborhoodSelector)) {
          const signals = semanticSignals(node);
          if (signals.length) {
            const inTargetForm = !!(targetForm && targetForm.contains && targetForm.contains(node));
            const scope = target.selected && inTargetForm ? 'composer-form' : inTargetForm ? 'candidate-form' : 'editable-parent';
            const priority = inTargetForm ? 0 : root.depth;
            const sharedForm = !target.selected && inTargetForm && visibleCandidates.filter((editable) => editable.closest && editable.closest('form') === targetForm).length > 1;
            const existing = candidates.get(node);
            if (existing && !target.selected && existing.evidence.editableIndex !== target.editableIndex) existing.evidence.editableIndex = null;
            if (!existing || existing.priority > priority) {
              const boundary = messageBoundary(node);
              const messageRelation = targetBoundary && boundary ? (targetBoundary === boundary ? 'same' : 'different')
                : targetBoundary ? 'composer-marked' : boundary ? 'candidate-marked' : 'unmarked';
              candidates.set(node, { priority, evidence: {
                editableIndex: sharedForm || (existing && existing.evidence.editableIndex === null) ? null : target.editableIndex,
                selectedComposer: target.selected, scope, depth: current.depth,
                tag: tagName(node), role: roleName(node), visible: visible(node), signals, inComposerForm: target.selected && inTargetForm,
                sameMessageBoundary: targetBoundary && boundary ? targetBoundary === boundary : null, messageRelation
              } });
            }
          }
        }
        if (current.depth >= 4) continue;
        const children = node.children ? [...node.children].slice(0, 12) : [];
        for (let index = children.length - 1; index >= 0; index -= 1) pending.push({ node: children[index], depth: current.depth + 1 });
      }
    }
  }
  const attachmentCandidates = [...candidates.values()].sort((a, b) => a.priority - b.priority).slice(0, 16).map(({ evidence }) => evidence);
`;
const unsentSource = () => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  ${FIND_COMPOSER}
  const { composer } = findComposer();
  ${UNSENT_SCAN}
  return unsentState;
})()`;
const normalizeUnsent = (value) => value === 'present' || value === 'empty' ? value : 'unknown';
const sanitizeUnsentTrace = (raw, viewVisible = false) => {
  if (!raw || typeof raw !== 'object') return null;
  // This probe has no validated absence surface; even an unexpected raw "empty" is not trusted in diagnostics.
  const state = raw.unsentState === 'present' ? 'present' : 'unknown';
  const composerState = ['found', 'absent', 'ambiguous', 'unknown'].includes(raw.composerState) ? raw.composerState : 'unknown';
  const draftState = ['present', 'empty', 'unknown'].includes(raw.draftState) ? raw.draftState : 'unknown';
  const reason = ['file-selected', 'upload-progress', 'absence-unverified', 'composer-not-found', 'composer-form-missing'].includes(raw.reason) ? raw.reason : 'absence-unverified';
  const locatorReason = ['found', 'multiple-editables-no-selected-form', 'multiple-editables-no-submit-form', 'no-visible-editable'].includes(raw.locatorReason) ? raw.locatorReason : 'unknown';
  const metricKeys = ['buttons', 'roleButtons', 'images', 'fileInputs', 'progressbars', 'busyNodes', 'testIdNodes', 'labeledNodes', 'listItems', 'attachmentAttrNodes', 'submitControls'];
  const counts = (value, keys) => Object.fromEntries(keys.map((key) => [key, safeInt(value && value[key])]));
  const editableStructure = safeList(raw.editableStructure, 8, (e) => ({
    index: safeInt(e && e.index), tag: ['textarea', 'input', 'div', 'span'].includes(e && e.tag) ? e.tag : 'other',
    role: ['textbox', 'button', 'listitem', 'group', 'progressbar', 'toolbar', 'presentation', 'img'].includes(e && e.role) ? e.role : 'other',
    visible: !!(e && e.visible), contentEditable: !!(e && e.contentEditable), inForm: !!(e && e.inForm), formHasSubmit: !!(e && e.formHasSubmit),
    ancestry: safeList(e && e.ancestry, 5, (scope) => ({ depth: safeInt(scope && scope.depth),
      tag: ['form', 'div', 'section', 'main', 'article', 'button', 'span', 'textarea', 'input'].includes(scope && scope.tag) ? scope.tag : 'other',
      role: ['textbox', 'button', 'listitem', 'group', 'progressbar', 'toolbar', 'presentation', 'img'].includes(scope && scope.role) ? scope.role : 'other',
      visible: !!(scope && scope.visible), ...counts(scope, metricKeys) }))
  }));
  const candidateHits = {};
  if (raw.candidateHits && typeof raw.candidateHits === 'object') for (const key of Object.keys(CANDIDATES)) candidateHits[key] = safeList(raw.candidateHits[key], 8, safeInt);
  const fileInputEvidence = counts(raw.fileInputEvidence, ['total', 'visible', 'populated', 'inComposerForm']);
  const documentEvidence = counts(raw.documentEvidence, ['formCount', 'eligibleFormCount', 'visibleEditableCount', 'totalEditableCount', 'visibleProgressbars', 'visibleBusyNodes']);
  const attachmentCandidates = safeList(raw.attachmentCandidates, 16, (candidate) => ({
    editableIndex: Number.isInteger(candidate && candidate.editableIndex) && candidate.editableIndex >= 0 ? safeInt(candidate.editableIndex) : null,
    selectedComposer: candidate && candidate.selectedComposer === true,
    scope: ['composer-form', 'candidate-form', 'editable-parent'].includes(candidate && candidate.scope) ? candidate.scope : 'unknown',
    depth: safeInt(candidate && candidate.depth),
    tag: ['form', 'div', 'section', 'main', 'article', 'button', 'span', 'img', 'li', 'input'].includes(candidate && candidate.tag) ? candidate.tag : 'other',
    role: ['textbox', 'button', 'listitem', 'group', 'progressbar', 'toolbar', 'presentation', 'img'].includes(candidate && candidate.role) ? candidate.role : 'other',
    visible: !!(candidate && candidate.visible),
    signals: safeList(candidate && candidate.signals, 8, (signal) => ['file-input', 'progressbar', 'busy', 'attachment-hint', 'upload-hint', 'remove-hint', 'list-item', 'image', 'labeled-button'].includes(signal) ? signal : null).filter(Boolean),
    inComposerForm: !!(candidate && candidate.inComposerForm),
    sameMessageBoundary: typeof (candidate && candidate.sameMessageBoundary) === 'boolean' ? candidate.sameMessageBoundary : null,
    messageRelation: ['same', 'different', 'candidate-marked', 'composer-marked', 'unmarked'].includes(candidate && candidate.messageRelation) ? candidate.messageRelation : 'unknown'
  })).filter((candidate) => candidate.signals.length > 0);
  const uploadState = raw.progressbarCount > 0 ? 'present' : 'unknown';
  return {
    composerState, composerVia: VIA.has(raw.composerVia) ? raw.composerVia : null, locatorReason, draftState, unsentState: state, reason,
    visibleEditableCount: safeInt(raw.visibleEditableCount), otherEditableCount: safeInt(raw.otherEditableCount), formPresent: raw.formPresent === true,
    formButtonCount: safeInt(raw.formButtonCount), fileInputCount: safeInt(raw.fileInputCount),
    populatedFileInputCount: safeInt(raw.populatedFileInputCount), progressbarCount: safeInt(raw.progressbarCount),
    uploadState, editableStructure, candidateHits, fileInputEvidence, documentEvidence, attachmentCandidates,
    viewVisible: Boolean(viewVisible)
  };
};

// The send/stop control(s): the known ones plus every button of the composer's own form.
const FIND_CONTROLS = `
  const controls = (composer) => {
    const out = [];
    for (const s of C.submit) { const e = document.querySelector(s); if (e && !out.includes(e)) out.push(e); }
    const form = composer && composer.closest ? composer.closest('form') : null;
    if (form) for (const b of [...form.querySelectorAll('button')].slice(0, 20)) if (!out.includes(b)) out.push(b);
    return out;
  };
  const stopLike = (b) => {
    const label = b.getAttribute('aria-label') || '';
    if (new RegExp(${JSON.stringify(STOP_LABEL)}, 'i').test(label)) return true;
    if (/stop/i.test(b.getAttribute('data-testid') || '')) return true;
    for (const a of b.attributes) if (!/-label$/.test(a.name) && new RegExp(${JSON.stringify(STOP_VALUE)}, 'i').test(a.value)) return true;
    return false;
  };`;

// `diagnostic` additionally returns how the composer was found and the state signature of the form's buttons
// (attribute names, short values; labels only for submit-like or test-id controls): UI chrome, not content.
const probeSource = ({ diagnostic = false, composerTrace = false } = {}) => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  ${FIND_COMPOSER}
  ${FIND_CONTROLS}
  const any = (list) => first(list) !== null;
  const { composer, via } = findComposer();
  const buttons = controls(composer);
  let stop = any(C.stop) || buttons.some(stopLike);
  // A stop-like control OUTSIDE the ones read above (only looked for when the strong signal is absent).
  let wideHit = null;
  if (!stop) {
    const known = new Set(buttons);
    const noise = new RegExp(${JSON.stringify(STOP_NOISE)}, 'i');
    let seen = 0;
    for (const b of document.querySelectorAll(${JSON.stringify(WIDE_CONTROLS)})) {
      if (++seen > ${WIDE_LIMIT}) break;
      if (known.has(b)) continue;
      const label = b.getAttribute('aria-label') || '';
      const testid = b.getAttribute('data-testid') || '';
      const byLabel = new RegExp(${JSON.stringify(STOP_LABEL)}, 'i').test(label) && !noise.test(label);
      const byTestId = /stop/i.test(testid) && !noise.test(testid);
      if ((byLabel || byTestId) && visible(b)) { wideHit = { label, testid, by: byLabel ? 'label' : 'testid' }; break; }
    }
  }
  // Seen live (M01-I3B-2R trace): the current page removes the composer form while it answers and shows a visible control
  // labelled "Parar" OUTSIDE it. A visible control with a stop LABEL anywhere is therefore the stop control (test-id-only matches
  // stay the weaker stopWide).
  if (!stop && wideHit !== null && wideHit.by === 'label') stop = true;
  const busyList = [...document.querySelectorAll(${JSON.stringify(BUSY_SELECTOR)})].slice(0, ${BUSY_LIMIT}).filter(visible);
  const out = {
    composer: composer ? true : (document.body ? false : null),
    // Live (trace): the composer is often an editable <div> with no <form> around it, so it cannot be told apart from the
    // document editors; any visible editable surface says the page is up and drawn (used only to confirm an ending).
    surface: document.body ? [...document.querySelectorAll(${JSON.stringify(EDITABLE)})].slice(0, 30).some(visible) : null,
    stop,
    stopWide: wideHit !== null,
    busy: busyList.length > 0,
    turnActions: any(C.turnActions),
    error: [...document.querySelectorAll(C.error[0])].some(visible),
    interrupted: null,
    draft: composer ? ((composer.value !== undefined ? composer.value : composer.textContent) || '').trim().length > 0 : null
  };
  ${composerTrace ? `${UNSENT_SCAN}
  ${COMPOSER_STRUCTURE_TRACE}
  ${COMPOSER_NEIGHBORHOOD_TRACE}
  const visibleEditableCount = [...document.querySelectorAll(${JSON.stringify(EDITABLE)})].filter(visible).length;
  out.unsentTrace = {
    composerState: composer ? 'found' : (visibleEditableCount ? 'ambiguous' : 'absent'), composerVia: via,
    locatorReason: composer ? 'found' : visibleEditableCount ? (eligibleForms ? 'multiple-editables-no-selected-form' : 'multiple-editables-no-submit-form') : 'no-visible-editable',
    draftState: composer ? (out.draft === true ? 'present' : out.draft === false ? 'empty' : 'unknown') : 'unknown',
    unsentState,
    reason: !composer ? 'composer-not-found' : !form ? 'composer-form-missing' : populatedFileInputs ? 'file-selected' : progressbars ? 'upload-progress' : 'absence-unverified',
    visibleEditableCount, otherEditableCount: Math.max(0, visibleEditableCount - (composer && visible(composer) ? 1 : 0)), formPresent: !!form, formButtonCount: form ? form.querySelectorAll('button').length : 0,
    fileInputCount: form ? form.querySelectorAll('input[type="file"]').length : 0,
    populatedFileInputCount: populatedFileInputs, progressbarCount: progressbars,
    editableStructure, candidateHits, fileInputEvidence, documentEvidence, attachmentCandidates
  };` : ''}
  ${diagnostic ? `out.via = via;
  out.wide = wideHit ? { by: wideHit.by, label: wideHit.label.length <= 40 ? wideHit.label : '', testid: wideHit.testid.length <= 40 ? wideHit.testid : '' } : null;
  out.busyCount = busyList.length;
  const sig = (b) => {
    const named = b.type === 'submit' || b.hasAttribute('data-testid') || [...b.attributes].some((a) => /^data-composer/.test(a.name));
    const label = b.getAttribute('aria-label') || '';
    return { type: b.type || '', testid: b.getAttribute('data-testid') || '', label: named && label.length <= 40 ? label : '', attrs: [...b.attributes].filter((a) => !/^(class|style|id)$/.test(a.name)).map((a) => a.name + (named && a.value.length <= 24 ? '=' + a.value : '')).sort().slice(0, 24) };
  };
  out.controls = buttons.slice(0, 8).map(sig);
  // The composer form itself carries state attributes on the live page (data-announcement-*, data-logged-out, ...):
  // its attribute values are UI chrome and are logged whenever they change.
  const diagnosticForm = composer && composer.closest ? composer.closest('form') : null;
  out.form = diagnosticForm ? [...diagnosticForm.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => a.name + (a.value.length <= 40 ? '=' + a.value : '')).sort().slice(0, 30) : [];` : ''}
  return out;
})()`;

// One-shot structural snapshot for diagnosing a page we do not understand yet. Counts and control attributes
// only: no text content, no values, no attribute values from anything outside the composer's own form.
const structureSource = () => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  ${FIND_COMPOSER}
  const cut = (v) => String(v).slice(0, 40);
  const attrs = (e, valued) => [...e.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => cut(a.name) + (valued.has(a.name) && a.value.length <= 40 ? '=' + a.value : '')).slice(0, 30);
  const VALUED = new Set(['id', 'role', 'type', 'name', 'contenteditable', 'data-testid', 'enterkeyhint']);
  const editable = [...document.querySelectorAll(${JSON.stringify(EDITABLE)})];
  const { composer, via } = findComposer();
  const form = composer && composer.closest ? composer.closest('form') : null;
  let shadowHosts = 0, scanned = 0;
  for (const host of document.querySelectorAll('*')) { if (++scanned > ${SHADOW_SCAN_LIMIT}) break; if (host.shadowRoot) shadowHosts++; }
  return {
    readyState: document.readyState,
    hasBody: !!document.body,
    forms: document.querySelectorAll('form').length,
    iframes: document.querySelectorAll('iframe').length,
    shadowHosts,
    scannedElements: scanned,
    editable: editable.slice(0, 6).map((e) => ({ tag: e.tagName, visible: visible(e), inForm: !!(e.closest && e.closest('form')), attrs: attrs(e, VALUED), children: e.children.length })),
    composer: { found: !!composer, via, tag: composer ? composer.tagName : null, attrs: composer ? attrs(composer, VALUED) : [] },
    form: form ? {
      attrs: [...form.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => cut(a.name) + (a.value.length <= 40 ? '=' + a.value : '')).slice(0, 30),
      buttons: [...form.querySelectorAll('button')].slice(0, 12).map((b) => {
        const named = b.type === 'submit' || b.hasAttribute('data-testid') || [...b.attributes].some((a) => /^data-composer/.test(a.name));
        const label = b.getAttribute('aria-label') || '';
        return { type: b.type || '', testid: b.getAttribute('data-testid') || '', visible: visible(b), disabled: !!b.disabled, label: named && label.length <= 40 ? label : '', attrs: attrs(b, named ? new Set([...VALUED, 'aria-label', 'aria-disabled', 'data-state']) : VALUED) };
      })
    } : null,
    testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => cut(e.getAttribute('data-testid'))))].sort().slice(0, 60),
    known: Object.fromEntries(Object.entries(C).map(([k, list]) => [k, list.map((s) => document.querySelectorAll(s).length)]))
  };
})()`;

const SIGNAL_KEYS = ['composer', 'surface', 'stop', 'stopWide', 'busy', 'turnActions', 'error', 'interrupted', 'draft'];
const tri = (v) => (v === true ? true : v === false ? false : null);
const VIA = new Set(['candidate', 'structural', 'lone', 'shadow']);

// The page is untrusted: accept only the expected booleans, anything else is "not determinable".
function normalizeSignals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const signals = {};
  for (const key of SIGNAL_KEYS) signals[key] = tri(raw[key]);
  return signals;
}

const safeText = (v, max = 40) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '');
const safeList = (v, limit, map) => (Array.isArray(v) ? v.slice(0, limit).map(map) : []);
const safeInt = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e6, Math.trunc(v))) : 0);

// Re-builds a probe/structure result from scratch with bounded strings and lists, so whatever the page (or a
// bug) put there can only ever be short control metadata.
function sanitizeControls(list) {
  return safeList(list, 8, (c) => ({
    type: safeText(c && c.type, 16), testid: safeText(c && c.testid), label: safeText(c && c.label),
    attrs: safeList(c && c.attrs, 24, (a) => safeText(a, 70))
  }));
}

function sanitizeProbe(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const wide = raw.wide && typeof raw.wide === 'object' ? { by: raw.wide.by === 'label' || raw.wide.by === 'testid' ? raw.wide.by : null, label: safeText(raw.wide.label), testid: safeText(raw.wide.testid) } : null;
  return { via: VIA.has(raw.via) ? raw.via : null, controls: sanitizeControls(raw.controls), form: safeList(raw.form, 30, (a) => safeText(a, 70)), wide, busyCount: safeInt(raw.busyCount) };
}

function sanitizeStructure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const attrs = (a) => safeList(a, 30, (x) => safeText(x, 70));
  const form = raw.form && typeof raw.form === 'object' ? {
    attrs: attrs(raw.form.attrs),
    buttons: safeList(raw.form.buttons, 12, (b) => ({ type: safeText(b && b.type, 16), testid: safeText(b && b.testid), visible: b && b.visible === true, disabled: b && b.disabled === true, label: safeText(b && b.label), attrs: attrs(b && b.attrs) }))
  } : null;
  const known = {};
  if (raw.known && typeof raw.known === 'object') for (const key of Object.keys(CANDIDATES)) known[key] = safeList(raw.known[key], 8, safeInt);
  return {
    readyState: safeText(raw.readyState, 16), hasBody: raw.hasBody === true,
    forms: safeInt(raw.forms), iframes: safeInt(raw.iframes), shadowHosts: safeInt(raw.shadowHosts), scannedElements: safeInt(raw.scannedElements),
    editable: safeList(raw.editable, 6, (e) => ({ tag: safeText(e && e.tag, 16), visible: e && e.visible === true, inForm: e && e.inForm === true, attrs: attrs(e && e.attrs), children: safeInt(e && e.children) })),
    composer: { found: !!(raw.composer && raw.composer.found), via: raw.composer && VIA.has(raw.composer.via) ? raw.composer.via : null, tag: safeText(raw.composer && raw.composer.tag, 16), attrs: attrs(raw.composer && raw.composer.attrs) },
    form,
    testids: safeList(raw.testids, 60, (t) => safeText(t)),
    known
  };
}

module.exports = { FIND_COMPOSER, CANDIDATES, WORLD_ID, probeSource, structureSource, normalizeSignals, sanitizeProbe, sanitizeStructure, SIGNAL_KEYS, unsentSource, normalizeUnsent, sanitizeUnsentTrace };
