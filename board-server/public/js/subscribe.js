// Subscribe/manage panel controller (TECH §10–§13, DESIGN §3–§5): the ONLY
// module in the public bundle that ever issues a POST — five same-origin
// routes, credentials ride in POST bodies only (never URLs, never storage
// APIs, never logs) and are cleared on success. Panel structure and wiring
// formalize the approved mockup (docs/pipeline/subscriptions/MOCKUP.html);
// openPanel/closePanel/tray/picker idioms are adapted from that script.
// Pure transport/validation/routing exports live up top so plain-Node tests
// cover them without a DOM; everything below the IS_DOM guard is browser-only.

import { $, esc } from './util.js';
import { pickerHTML, planIndex, SUB_COPY, subCopy, tgConfirmPreview, tgDigestPreview } from './render.js';

// ---------- pure, node-testable contract (TECH §fe-api / §fe-validate) -------

// Client format gates — a courtesy only; the server's confirmation send is the
// authority (PRD D3). Relaxed per TECH §13: bot ids have crossed 10 digits and
// the 35-char secret length is observed, not documented.
export const TOKEN_RE = /^\d{8,12}:[A-Za-z0-9_-]{30,}$/;
export const CHAT_RE = /^-?\d+$/; // the leading minus is real — group ids are negative

// Outlives the server's own 10 s Telegram abort — the client can never quit
// first and claim "nothing was saved" after a stored success.
export const API_TIMEOUT_MS = 12_000;

/** Retry-After header → integer seconds; absent/unparseable → 60. */
export function parseRetryAfter(h) {
  const n = Number.parseInt(String(h ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

/**
 * Humanized countdown remainder for the rate banners (round-2 beta finding):
 * 45 → "45s", 185 → "3m 05s", 3410 → "56m 50s", 3661 → "1h 01m 01s".
 * Clamped at "0s" — the ticking banner never counts negative.
 */
export function fmtRetry(sec) {
  const s = Math.max(0, Math.floor(sec));
  if (s < 60) return `${s}s`;
  const pad = (n) => String(n).padStart(2, '0');
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${pad(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${pad(m % 60)}m ${pad(s % 60)}s`;
}

/**
 * 1 Hz banner projection: (deadline, now) → the ticking banner text, or
 * {expired:true} at/after the deadline — the SAME instant updateTray's
 * `deadlines[key] > now` gate reopens the submit primary, so "banner clears"
 * and "button re-enables" can never disagree.
 */
export function rateState(deadlineMs, nowMs) {
  const left = Math.ceil((deadlineMs - nowMs) / 1000);
  if (left <= 0) return { expired: true, text: null };
  return { expired: false, text: subCopy('errRate', { t: fmtRetry(left) }) };
}

/** The one POST transport — → {status, reason, retryAfter, body}, NEVER throws. */
export async function api(path, body, fetchFn = globalThis.fetch) {
  try {
    const res = await fetchFn(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* empty/invalid body is fine */
    }
    return {
      status: res.status,
      reason: data?.reason ?? null,
      retryAfter: parseRetryAfter(res.headers.get('retry-after')),
      body: data,
    };
  } catch {
    return { status: 0, reason: null, retryAfter: null, body: null }; // network / timeout
  }
}

/**
 * Status-only routing: the complete error-code → UI map (TECH §fe-api — tests
 * pin every row). Status 0, every unrecognized status ≥ 400 and unknown 422
 * reasons all fall back to the errServer path — forward-compatible by default.
 */
export function routeOutcome(call, { status, reason } = {}) {
  const rate = { ui: 'banner', copy: 'errRate', countdown: true };
  const server = { ui: 'banner', copy: 'errServer' };
  if (call === 'subscribe') {
    if (status === 200) return { ui: 'success' };
    if (status === 422 && reason === 'token_rejected') return { ui: 'field', field: 'token', copy: 'errTokenRejected' };
    if (status === 422 && reason === 'chat_not_found') return { ui: 'field', field: 'chat', copy: 'errChatNotFound' };
    if (status === 429) return reason === 'cap' ? { ui: 'banner', copy: 'errCap' } : rate;
    return server;
  }
  if (call === 'chatid') {
    if (status === 200) return { ui: 'fill', copy: 'chatFound' };
    if (status === 422 && reason === 'token_rejected') return { ui: 'field', field: 'token', copy: 'errTokenRejected' };
    if (status === 422 && reason === 'no_chat') return { ui: 'status', copy: 'errDiscover' };
    if (status === 429) return { ui: 'status', copy: 'errRate', countdown: true };
    return { ui: 'status', copy: 'errServer' };
  }
  if (call === 'lookup') {
    if (status === 200) return { ui: 'loaded' };
    if (status === 404) return { ui: 'notFound' };
    if (status === 429) return rate;
    return server;
  }
  if (call === 'update') {
    if (status === 200) return { ui: 'done', copy: 'mgUpdated' };
    if (status === 404) return { ui: 'notFound' }; // row vanished mid-edit → back to IDLE
    if (status === 422 && reason === 'token_rejected') return { ui: 'banner', copy: 'errTokenRejected' };
    if (status === 422 && reason === 'chat_not_found') return { ui: 'banner', copy: 'errChatNotFound' };
    if (status === 429) return rate;
    return server;
  }
  if (call === 'delete') {
    if (status === 200 || status === 404) return { ui: 'done', copy: 'mgGone' }; // idempotent unsubscribe
    if (status === 429) return rate;
    return server;
  }
  return server;
}

/**
 * Manage-load render model (beta F44): the summary always speaks the SAVED
 * count; rows are ready only once a real snapshot exists — ready:false renders
 * a brief loading state that the first-snapshot hook completes. `checked` is
 * the saved ids VERBATIM: the round-2 regression filtered them through a
 * planMap built before any snapshot (empty), which unchecked every row while
 * the summary still said "You watch N plans".
 */
export function manageLoadModel(ids, snap) {
  const n = ids.length;
  return {
    ready: Boolean(snap?.state),
    checked: new Set(ids),
    summary: `You watch ${n} plan${n === 1 ? '' : 's'}. Edit the list, or clear everything to unsubscribe.`,
  };
}

/**
 * Update-safety invariant (beta F44, defense in depth): an Update submits
 * (visibly-checked ids) ∪ (saved ids that never RENDERED as a checkable row).
 * A plan the subscriber was never shown — picker still loading, plan vanished
 * from the board — can never be dropped silently; only an explicit uncheck of
 * a rendered row (or Unsubscribe-all) removes a saved plan.
 */
export function updateDraft(checkedIds, renderedIds, savedPlanIds) {
  const rendered = new Set(renderedIds);
  const out = [...checkedIds];
  const seen = new Set(checkedIds);
  for (const id of savedPlanIds ?? []) {
    if (!rendered.has(id) && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

// ---------- browser-only panel controller ------------------------------------

const IS_DOM = typeof document !== 'undefined' && typeof window !== 'undefined';

// Busy-state lines (transitions announced via the one #subStatus region).
const DISCOVER_BUSY = 'Asking Telegram who started your bot…';
const LOOKUP_BUSY = 'Looking up your subscription…';
const UPDATE_BUSY = 'Updating your subscription…';
const REMOVE_BUSY = 'Removing your subscription…';
const WARMING_PICK = 'The board is still warming up — plan picking opens with the first snapshot.';
const MG_PICK_LOADING = 'Loading the plan list — your saved plans will show up checked in a moment.';

// Draft memory is module state only — closing hides, never resets (DESIGN §4).
let getLatest = () => null;
let firstSnapshot = null; // board.js's one-shot hook (null if the board failed)
const draft = new Set(); // subscribe-tab selection, survives close/reopen
let planMap = new Map(); // id → display record, rebuilt from getLatest() per open
let savedIds = null; // planIds from the last successful lookup (manage session)
let activeTab = 'subscribe';
let step = 1; // subscribe tab: 1 = picking, 2 = credentials
let subPhase = 'form'; // 'form' | 'success'
let mgPhase = 'idle'; // 'idle' | 'loaded' | 'done'
let busy = false; // one request in flight, ever
let escDeferred = false; // Esc during flight is honored after settle
let invoker = null;
const deadlines = { sub: 0, chat: 0, mg: 0 }; // rate-limit deadlines (epoch ms)
const bannerRate = { sub: false, mg: false }; // banner currently counting down
let rateTimer = null; // 1 Hz, runs only while a countdown is visible
let srDebounce = null;
let addChipTimer = null; // bell-add confirmation chip, copychip-style timeout
const ADD_CHIP_MS = 4000;

async function boot() {
  try {
    ({ getLatest, firstSnapshot } = await import('./board.js'));
  } catch {
    /* board bootstrap failed — manage tab still works without a snapshot */
  }
  wire();
  // Entry C: /?manage=1 — checked once at module boot; no secrets ride the URL.
  if (new URLSearchParams(location.search).get('manage') === '1') openPanel({ tab: 'manage' });
  // Deep-link timing (beta F44): a panel opened before the first snapshot has
  // no plan data — complete its pickers the moment the snapshot lands. This is
  // board.js's one-shot promise settled inline by its boot fetch (~1 s); no
  // polling here, and a no-op when the panel is closed or already populated.
  firstSnapshot?.().then(onSnapshotReady);
}

// ---------- small helpers ----------
const isMobile = () => window.matchMedia('(max-width:719px)').matches;
const tokenOk = (v) => TOKEN_RE.test(v.trim());
const chatOk = (v) => CHAT_RE.test(v.trim());
const pickedIds = (root) => [...root.querySelectorAll('.pick:checked')].map((c) => c.dataset.planId);
const renderedIds = (root) => [...root.querySelectorAll('.pick')].map((c) => c.dataset.planId);
// The only id set an Update may ever submit (beta F44) — visible checks plus
// every saved plan that never rendered as a row (loading picker, vanished plan).
const mgDraft = () => updateDraft(pickedIds($('#mgPicker')), renderedIds($('#mgPicker')), savedIds);

function setStatus(msg, tone) {
  const el = $('#subStatus');
  el.textContent = msg;
  el.className = 'status-line' + (tone ? ' ' + tone : '');
}

function fieldErr(wrapSel, on, msg) {
  const w = $(wrapSel);
  w.classList.toggle('err', on);
  const input = w.querySelector('input');
  input.setAttribute('aria-invalid', on ? 'true' : 'false');
  if (on && msg) w.querySelector('.field-err').textContent = msg;
}

function syncFindChat() {
  $('#findChat').disabled = busy || deadlines.chat > Date.now() || !tokenOk($('#fldToken').value);
}

function setBusy(b) {
  busy = b;
  const sels = activeTab === 'subscribe' ? ['#fldToken', '#fldChat'] : ['#mgToken', '#mgChat'];
  for (const sel of sels) $(sel).disabled = b;
  syncFindChat();
  updateTray();
}

function settleEsc() {
  if (escDeferred) {
    escDeferred = false;
    closePanel();
  }
}

// Bell-add confirmation (beta finding 2): a bell click that lands in an
// in-progress session names what it just added near the tray — the resumed
// step may not show the new checkmark. Shown/hidden on the copychip timeout
// idiom; role="status" on the chip announces it politely; textContent only.
function showAddChip(name) {
  const el = $('#addChip');
  el.hidden = false;
  el.textContent = subCopy('bellAdded', { name });
  clearTimeout(addChipTimer);
  addChipTimer = setTimeout(() => {
    el.hidden = true;
  }, ADD_CHIP_MS);
}

function hideAddChip() {
  clearTimeout(addChipTimer);
  $('#addChip').hidden = true;
}

// ---------- picker ----------
function wireStopProp(root) {
  // A select-all click must never toggle its accordion (DESIGN §10).
  root.querySelectorAll('.pick-all, .pick-all-w').forEach((el) =>
    el.addEventListener('click', (e) => e.stopPropagation()),
  );
}

function syncPickAll(root) {
  root.querySelectorAll('.pick-all').forEach((a) => {
    const cbs = [...root.querySelectorAll(`.pick[data-loc="${a.dataset.loc}"]`)];
    const n = cbs.filter((c) => c.checked).length;
    a.checked = n === cbs.length && n > 0;
    a.indeterminate = n > 0 && n < cbs.length;
  });
}

function announceCount(n) {
  clearTimeout(srDebounce);
  srDebounce = setTimeout(() => {
    $('#pickCountSr').textContent = `${n} plan${n === 1 ? '' : 's'} selected`;
  }, 800);
}

function rebuildPicker(preselectId = null) {
  const snap = getLatest();
  const box = $('#planPicker');
  if (!snap?.state) {
    planMap = new Map();
    box.innerHTML = `<div class="empty">${WARMING_PICK}</div>`;
    return;
  }
  planMap = planIndex(snap.state);
  for (const id of [...draft]) if (!planMap.has(id)) draft.delete(id); // vanished ids drop silently
  const pre = preselectId != null ? planMap.get(String(preselectId)) : null;
  box.innerHTML = pickerHTML(snap.state, draft, isMobile() ? (pre?.loc ?? null) : true);
  wireStopProp(box);
  syncPickAll(box);
  if (pre) {
    const cb = box.querySelector(`.pick[data-plan-id="${CSS.escape(String(preselectId))}"]`);
    const dcEl = cb?.closest('.pick-dc');
    if (dcEl) dcEl.open = true; // forced open, mobile included
    if (cb) requestAnimationFrame(() => cb.closest('.pick-row')?.scrollIntoView({ block: 'nearest' }));
  }
}

// ---------- dialog lifecycle ----------
export function openPanel({ tab = 'subscribe', preselect = null } = {}) {
  invoker = document.activeElement;
  $('#subOverlay').hidden = false;
  $('#subPanel').hidden = false;
  document.body.style.overflow = 'hidden';
  const shell = $('#pageShell');
  shell.setAttribute('inert', '');
  shell.setAttribute('aria-hidden', 'true'); // belt-and-braces for pre-inert engines
  if (subPhase === 'success') resetToStep1(); // next open resumes at step 1, selection intact
  const preId = preselect != null ? String(preselect) : null;
  // A fresh session (empty draft) keeps the round-2 behavior byte-identical:
  // step 1 opens with the plan checked, no chip. Only an ADD to an existing
  // selection confirms itself — whatever step the session resumes on.
  const addsToSession = preId != null && draft.size > 0 && !draft.has(preId);
  if (preId != null) draft.add(preId);
  rebuildPicker(preselect);
  restoreRates();
  selectTab(tab);
  if (addsToSession && planMap.has(preId)) showAddChip(planMap.get(preId).name);
  $(tab === 'manage' ? '#tabManage' : '#tabSubscribe').focus();
}

export function closePanel() {
  $('#subOverlay').hidden = true;
  $('#subPanel').hidden = true;
  document.body.style.overflow = '';
  const shell = $('#pageShell');
  shell.removeAttribute('inert');
  shell.removeAttribute('aria-hidden');
  stopRateTicker(); // deadlines persist; the countdown re-renders on reopen
  hideAddChip(); // a stale add-chip never greets the next open
  if (invoker?.isConnected) invoker.focus();
  else document.body.focus?.();
}

function requestClose() {
  if (busy) {
    escDeferred = true; // bounded by the 12 s client timeout — never stuck open
    return;
  }
  closePanel();
}

function selectTab(tab) {
  activeTab = tab;
  const sub = tab === 'subscribe';
  $('#tabSubscribe').setAttribute('aria-selected', String(sub));
  $('#tabManage').setAttribute('aria-selected', String(!sub));
  $('#tabSubscribe').tabIndex = sub ? 0 : -1;
  $('#tabManage').tabIndex = sub ? -1 : 0;
  $('#paneSubscribe').hidden = !sub;
  $('#paneManage').hidden = sub;
  setStatus('', '');
  updateTray();
}

const focusables = () =>
  [...$('#subPanel').querySelectorAll('button,input,a[href],summary,[tabindex="0"]')].filter(
    (el) => !el.disabled && el.offsetParent !== null,
  );

// ---------- tray: one visible primary per state (TECH §fe-panel table) -------
const TRAY_BTNS = ['#toStep2', '#subSubmit', '#subDone', '#mgLoad', '#mgUpdate', '#mgUnsub', '#mgClose'];

function updateTray() {
  const nowMs = Date.now();
  const vis = {};
  let count = null;
  let hint = '';
  if (activeTab === 'subscribe') {
    if (subPhase === 'success') vis['#subDone'] = false;
    else if (step === 1) {
      const n = draft.size;
      count = `${n} selected`;
      hint = n ? '' : SUB_COPY.pickNone;
      vis['#toStep2'] = n === 0 || !planMap.size || busy;
    } else {
      count = `${draft.size} selected`;
      vis['#backTo1'] = false;
      const gated = deadlines.sub > nowMs;
      vis['#subSubmit'] =
        draft.size === 0 || busy || gated || !tokenOk($('#fldToken').value) || !chatOk($('#fldChat').value);
      $('#subSubmit').textContent = busy ? SUB_COPY.sending : SUB_COPY.submitLabel;
    }
  } else if (mgPhase === 'done') vis['#mgClose'] = false;
  else if (mgPhase === 'idle') {
    vis['#mgLoad'] = busy || deadlines.mg > nowMs || !tokenOk($('#mgToken').value) || !chatOk($('#mgChat').value);
  } else {
    // Safe draft count (beta F44): while the picker is still loading, the
    // saved plans count as selected — the tray offers Update (a preserving
    // no-op), never the Unsubscribe path, when zero rows have rendered.
    const n = mgDraft().length;
    count = `${n} selected`;
    const gated = busy || deadlines.mg > nowMs;
    if (n === 0) {
      hint = 'deselecting all = unsubscribe';
      vis['#mgUnsub'] = gated;
    } else vis['#mgUpdate'] = gated;
  }
  for (const sel of [...TRAY_BTNS, '#backTo1']) {
    const el = $(sel);
    el.hidden = !(sel in vis);
    el.disabled = vis[sel] === true;
  }
  const c = $('#pickCount');
  c.hidden = count == null;
  c.textContent = count ?? '';
  c.classList.toggle('zero', count?.startsWith('0 ') ?? false);
  const h = $('#pickHint');
  h.hidden = !hint;
  h.textContent = hint;
}

// ---------- rate-limit countdowns (deadline-based, survive close/reopen) -----
function bannerEl(key) {
  return $(key === 'sub' ? '#subBanner' : '#mgBanner');
}

function hideBanner(key) {
  bannerEl(key).hidden = true;
  bannerRate[key] = false;
}

function showBanner(key, copyKey, retrySec) {
  const el = bannerEl(key);
  if (retrySec != null) {
    deadlines[key] = Date.now() + retrySec * 1000;
    bannerRate[key] = true;
    el.textContent = rateState(deadlines[key], Date.now()).text;
    startRateTicker();
  } else {
    bannerRate[key] = false;
    el.textContent = SUB_COPY[copyKey];
  }
  el.hidden = false;
}

function restoreRates() {
  const nowMs = Date.now();
  for (const key of ['sub', 'mg']) {
    if (deadlines[key] > nowMs) {
      bannerRate[key] = true;
      const el = bannerEl(key);
      el.textContent = rateState(deadlines[key], nowMs).text;
      el.hidden = false;
      startRateTicker();
    }
  }
  if (deadlines.chat > nowMs) startRateTicker();
  syncFindChat();
}

function startRateTicker() {
  if (!rateTimer) rateTimer = setInterval(rateTick, 1000);
}

function stopRateTicker() {
  clearInterval(rateTimer);
  rateTimer = null;
}

function rateTick() {
  const nowMs = Date.now();
  let active = false;
  for (const key of ['sub', 'mg']) {
    if (!bannerRate[key]) continue;
    const st = rateState(deadlines[key], nowMs);
    if (!st.expired) {
      bannerEl(key).textContent = st.text;
      active = true;
    } else {
      hideBanner(key); // deadline reached: the banner clears…
      updateTray(); // …and the deadline gate reopens the primary, form untouched
    }
  }
  if (deadlines.chat > nowMs) active = true;
  else if ($('#findChat').disabled) syncFindChat(); // re-enable at the deadline
  if (!active) stopRateTicker();
}

// ---------- subscribe flow ----------
function showStep(n) {
  step = n;
  $('#step1').hidden = n !== 1;
  $('#step2').hidden = n !== 2;
  $('#subSuccess').hidden = true;
  updateTray();
  if (n === 2) $('#fldToken').focus();
}

function resetToStep1() {
  subPhase = 'form';
  hideBanner('sub');
  setStatus('', '');
  showStep(1);
}

async function doSubscribe() {
  if (busy) return;
  const token = $('#fldToken').value.trim();
  const chatId = $('#fldChat').value.trim();
  const planIds = [...draft];
  hideBanner('sub');
  setBusy(true);
  setStatus(SUB_COPY.sending, 'busy');
  const res = await api('/api/subscribe', { token, chatId, planIds });
  setBusy(false);
  const out = routeOutcome('subscribe', res);
  if (out.ui === 'success') {
    showSuccess(Array.isArray(res.body?.plans) ? res.body.plans : planIds, res.body?.merged === true);
  } else if (out.ui === 'field') {
    setStatus('', '');
    const [wrap, input] = out.field === 'token' ? ['#fTok', '#fldToken'] : ['#fChat', '#fldChat'];
    fieldErr(wrap, true, SUB_COPY[out.copy]);
    $(input).focus();
  } else {
    setStatus('', '');
    showBanner('sub', out.copy, out.countdown ? (res.retryAfter ?? 60) : null);
  }
  updateTray();
  settleEsc();
}

function showSuccess(ids, merged) {
  subPhase = 'success';
  $('#step2').hidden = true;
  $('#subSuccess').hidden = false;
  const recs = ids.map((id) => planMap.get(id)).filter(Boolean);
  $('#okBody').textContent = merged ? subCopy('mergedBody', { n: ids.length }) : SUB_COPY.successBody;
  $('#okList').innerHTML = recs.map((p) => `<li>• ${esc(p.name)} — ${esc(p.city)}</li>`).join('');
  const cadenceMs = (Number($('#subPanel').dataset.cadMin) || 5) * 60_000;
  $('#okBubble').innerHTML = tgConfirmPreview(recs, { merged, cadenceMs });
  $('#okDigestBubble').innerHTML = tgDigestPreview(recs, { cadenceMs });
  // Credentials cleared on success, never persisted; selection kept.
  $('#fldToken').value = '';
  $('#fldChat').value = '';
  fieldErr('#fTok', false);
  fieldErr('#fChat', false);
  syncFindChat();
  setStatus(merged ? 'Subscription updated.' : 'Subscribed — confirmation sent to your Telegram.', 'good');
  updateTray();
}

async function doFindChat() {
  if (busy) return;
  const token = $('#fldToken').value.trim();
  setBusy(true);
  setStatus(DISCOVER_BUSY, 'busy');
  const res = await api('/api/chatid', { token });
  setBusy(false);
  const out = routeOutcome('chatid', res);
  if (out.ui === 'fill' && res.body?.chatId != null) {
    $('#fldChat').value = String(res.body.chatId); // verbatim string — int64-safe, never Number()
    fieldErr('#fChat', false);
    setStatus(SUB_COPY.chatFound, 'good');
  } else if (out.ui === 'field') {
    setStatus('', '');
    fieldErr('#fTok', true, SUB_COPY[out.copy]);
    $('#fldToken').focus();
  } else if (out.countdown) {
    // Announced once (never per-second — live-region chatter); #findChat is
    // gated until the deadline, the submit path stays untouched.
    const s = res.retryAfter ?? 60;
    deadlines.chat = Date.now() + s * 1000;
    startRateTicker();
    setStatus(subCopy('errRate', { t: fmtRetry(s) }), 'bad');
  } else {
    setStatus(SUB_COPY[out.copy], 'bad');
  }
  syncFindChat();
  updateTray();
  settleEsc();
}

// ---------- manage flow ----------
function showMgPhase(phase) {
  mgPhase = phase;
  $('#mgAuth').hidden = phase !== 'idle';
  $('#mgLoaded').hidden = phase !== 'loaded';
  $('#mgDoneCard').hidden = phase !== 'done';
  if (phase !== 'loaded') $('#mgConfirm').hidden = true;
  updateTray();
}

async function doLookup() {
  if (busy) return;
  const token = $('#mgToken').value.trim();
  const chatId = $('#mgChat').value.trim();
  $('#mgNotFound').hidden = true;
  hideBanner('mg');
  // Anti-oracle: client-side bad format renders the SAME uniform copy as a
  // server 404 — indistinguishable, and it never reaches the network.
  if (!TOKEN_RE.test(token) || !CHAT_RE.test(chatId)) {
    $('#mgNotFound').hidden = false;
    return;
  }
  setBusy(true);
  setStatus(LOOKUP_BUSY, 'busy');
  const res = await api('/api/subscription/lookup', { token, chatId });
  setBusy(false);
  setStatus('', '');
  const out = routeOutcome('lookup', res);
  if (out.ui === 'loaded') showLoaded(Array.isArray(res.body?.planIds) ? res.body.planIds : []);
  else if (out.ui === 'notFound') $('#mgNotFound').hidden = false;
  else showBanner('mg', out.copy, out.countdown ? (res.retryAfter ?? 60) : null);
  updateTray();
  settleEsc();
}

function showLoaded(ids) {
  savedIds = [...ids]; // the session's saved set — mgDraft unions it back in
  const snap = getLatest();
  const m = manageLoadModel(savedIds, snap); // checked = saved ids VERBATIM (F44)
  $('#mgSummary').textContent = m.summary;
  if (m.ready) {
    if (!planMap.size) planMap = planIndex(snap.state); // panel opened pre-snapshot
    const box = $('#mgPicker');
    box.innerHTML = pickerHTML(snap.state, m.checked, isMobile() ? null : true);
    wireStopProp(box);
    syncPickAll(box);
  } else {
    // Brief loading state — onSnapshotReady re-runs showLoaded with the same
    // savedIds once the first snapshot lands, filling the pre-checked rows.
    $('#mgPicker').innerHTML = `<div class="empty">${MG_PICK_LOADING}</div>`;
  }
  showMgPhase('loaded');
}

// First-snapshot completion (beta F44): a panel opened before any snapshot —
// the ?manage=1 deep link at module boot — rendered its pickers from nothing.
// When board.js applies the first snapshot, fill the plan index, replace the
// warming/loading placeholders, and pre-check the manage rows from savedIds.
function onSnapshotReady() {
  if ($('#subPanel').hidden) return; // a closed panel rebuilds at next open
  if (!planMap.size) rebuildPicker(); // subscribe picker leaves its warming state
  if (mgPhase === 'loaded' && savedIds) showLoaded(savedIds); // manage-load completes
  updateTray();
}

function clearMgCreds() {
  $('#mgToken').value = '';
  $('#mgChat').value = '';
  fieldErr('#mTok', false);
  fieldErr('#mChat', false);
}

function showMgDone(msg) {
  $('#mgDoneMsg').textContent = msg;
  clearMgCreds();
  showMgPhase('done');
  setStatus(msg, 'good');
}

async function doUpdate() {
  if (busy) return;
  const ids = mgDraft(); // never narrower than the saved-but-unrendered set (F44)
  if (!ids.length) return; // n = 0 is the unsubscribe path — the client turns 0 into delete
  const token = $('#mgToken').value.trim();
  const chatId = $('#mgChat').value.trim();
  hideBanner('mg');
  setBusy(true);
  setStatus(UPDATE_BUSY, 'busy');
  const res = await api('/api/subscription/update', { token, chatId, planIds: ids });
  setBusy(false);
  setStatus('', '');
  const out = routeOutcome('update', res);
  if (out.ui === 'done') {
    showMgDone(subCopy('mgUpdated', { n: (Array.isArray(res.body?.plans) ? res.body.plans : ids).length }));
  } else if (out.ui === 'notFound') {
    showMgPhase('idle'); // row vanished mid-edit
    $('#mgNotFound').hidden = false;
  } else {
    showBanner('mg', out.copy, out.countdown ? (res.retryAfter ?? 60) : null); // 422 stays LOADED
  }
  updateTray();
  settleEsc();
}

async function doDelete() {
  if (busy) return;
  const token = $('#mgToken').value.trim();
  const chatId = $('#mgChat').value.trim();
  hideBanner('mg');
  setBusy(true);
  setStatus(REMOVE_BUSY, 'busy');
  const res = await api('/api/subscription/delete', { token, chatId });
  setBusy(false);
  setStatus('', '');
  const out = routeOutcome('delete', res);
  if (out.ui === 'done') showMgDone(SUB_COPY.mgGone); // 200 and 404 alike — goal state reached
  else showBanner('mg', out.copy, out.countdown ? (res.retryAfter ?? 60) : null);
  updateTray();
  settleEsc();
}

// ---------- one-time wiring ----------
function wire() {
  const panel = $('#subPanel');

  // Entry A — static CTA in .stats (paint() only writes named spans).
  $('#alertsCta').addEventListener('click', () => openPanel({ tab: 'subscribe' }));
  // Entry B — bells are re-created by every repaint, so delegate on #board.
  $('#board').addEventListener('click', (e) => {
    const bell = e.target.closest('.notify');
    if (bell) openPanel({ tab: 'subscribe', preselect: bell.dataset.planId });
  });

  // Tabs — WAI-ARIA pattern with roving tabindex and arrow keys.
  $('#tabSubscribe').addEventListener('click', () => selectTab('subscribe'));
  $('#tabManage').addEventListener('click', () => selectTab('manage'));
  const tabs = [$('#tabSubscribe'), $('#tabManage')];
  tabs.forEach((t, i) =>
    t.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const o = tabs[1 - i];
        o.focus();
        o.click();
      }
    }),
  );

  // Dialog lifecycle: trap, Esc (deferred while busy), overlay, ✕.
  $('#subClose').addEventListener('click', requestClose);
  $('#subOverlay').addEventListener('click', requestClose);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      requestClose();
      return;
    }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      last.focus();
      e.preventDefault();
    } else if (!e.shiftKey && document.activeElement === last) {
      first.focus();
      e.preventDefault();
    }
  });

  // Pickers — containers are static, so one change listener each survives rebuilds.
  $('#planPicker').addEventListener('change', (e) => {
    const box = $('#planPicker');
    if (e.target.classList.contains('pick-all')) {
      box.querySelectorAll(`.pick[data-loc="${CSS.escape(e.target.dataset.loc)}"]`).forEach((cb) => {
        cb.checked = e.target.checked;
      });
    }
    draft.clear();
    for (const id of pickedIds(box)) draft.add(id);
    syncPickAll(box);
    announceCount(draft.size);
    updateTray();
  });
  $('#mgPicker').addEventListener('change', (e) => {
    const box = $('#mgPicker');
    if (e.target.classList.contains('pick-all')) {
      box.querySelectorAll(`.pick[data-loc="${CSS.escape(e.target.dataset.loc)}"]`).forEach((cb) => {
        cb.checked = e.target.checked;
      });
    }
    syncPickAll(box);
    announceCount(pickedIds(box).length);
    updateTray();
  });

  // Fields — blur shows format errors, input clears them (never on blur).
  $('#fldToken').addEventListener('blur', () => {
    const v = $('#fldToken').value.trim();
    fieldErr('#fTok', v !== '' && !TOKEN_RE.test(v), SUB_COPY.errTokenFormat);
  });
  $('#fldToken').addEventListener('input', () => {
    fieldErr('#fTok', false);
    syncFindChat();
    updateTray();
  });
  $('#fldChat').addEventListener('blur', () => {
    const v = $('#fldChat').value.trim();
    fieldErr('#fChat', v !== '' && !CHAT_RE.test(v), SUB_COPY.errChatFormat);
  });
  $('#fldChat').addEventListener('input', () => {
    fieldErr('#fChat', false);
    updateTray();
  });
  $('#mgToken').addEventListener('blur', () => {
    const v = $('#mgToken').value.trim();
    fieldErr('#mTok', v !== '' && !TOKEN_RE.test(v), SUB_COPY.errTokenFormat);
  });
  $('#mgChat').addEventListener('blur', () => {
    const v = $('#mgChat').value.trim();
    fieldErr('#mChat', v !== '' && !CHAT_RE.test(v), SUB_COPY.errChatFormat);
  });
  for (const sel of ['#mgToken', '#mgChat'])
    $(sel).addEventListener('input', () => {
      fieldErr('#mTok', false);
      fieldErr('#mChat', false);
      $('#mgNotFound').hidden = true;
      updateTray();
    });

  // Forms: Enter submits via the handler — native navigation never fires, so
  // CSP form-action 'none' and connect-src 'self' ship byte-identical.
  $('#subForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (subPhase === 'form' && step === 2 && !$('#subSubmit').disabled) doSubscribe();
  });
  $('#mgForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (mgPhase === 'idle' && !busy) doLookup(); // bad format lands on the uniform not-found
  });
  for (const sel of ['#fldToken', '#fldChat'])
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#subForm').requestSubmit();
      }
    });
  for (const sel of ['#mgToken', '#mgChat'])
    $(sel).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        $('#mgForm').requestSubmit();
      }
    });

  // Tray actions — exactly one visible primary per state.
  $('#toStep2').addEventListener('click', () => showStep(2));
  $('#backTo1').addEventListener('click', () => showStep(1)); // selection kept
  $('#subSubmit').addEventListener('click', doSubscribe);
  $('#subDone').addEventListener('click', () => {
    closePanel();
    resetToStep1();
  });
  $('#findChat').addEventListener('click', doFindChat);
  $('#mgLoad').addEventListener('click', doLookup);
  $('#mgUpdate').addEventListener('click', doUpdate);
  $('#mgUnsub').addEventListener('click', () => {
    $('#mgConfirm').hidden = false;
    $('#mgConfirmYes').focus();
  });
  $('#mgConfirmYes').addEventListener('click', () => {
    $('#mgConfirm').hidden = true;
    doDelete();
  });
  $('#mgConfirmNo').addEventListener('click', () => {
    $('#mgConfirm').hidden = true;
  });
  $('#mgClose').addEventListener('click', () => {
    closePanel();
    showMgPhase('idle');
    $('#mgNotFound').hidden = true;
  });

  // Copy-chip: mono command + Copy button, "Copied ✓" for 1.5 s.
  panel.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-copy]');
    if (!chip) return;
    navigator.clipboard?.writeText(chip.dataset.copy);
    const old = chip.textContent;
    chip.textContent = 'Copied ✓';
    setTimeout(() => {
      chip.textContent = old;
    }, 1500);
  });

  updateTray();
}

if (IS_DOM) boot();
