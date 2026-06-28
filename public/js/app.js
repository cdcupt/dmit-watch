// Panel bootstrap: pull the REST snapshot, render the wall, then live on the SSE
// stream. The panel owns presentation + alarm UX only; the server is the single
// source of truth for stock and edges.

import { $, $$, famLabel } from './util.js';
import * as store from './store.js';
import * as api from './api.js';
import * as render from './render.js';
import * as alarm from './alarm.js';
import { connectSse } from './sse.js';

let activeView = 'panel';
let healthTimer = null;
let lastEventAt = Date.now();

// Stale-data treatment: once the SSE link has been down longer than this, make it
// visually obvious the panel is frozen (banner + dimmed grid). Cleared the instant
// the stream is live again and the snapshot has resynced.
const STALE_AFTER_MS = 5000;
let staleTimer = null;

// ---------- view switching ----------
async function loadHealth() {
  try {
    render.renderHealth(await api.fetchHealth());
  } catch {
    /* transient; the next tick retries */
  }
}

function setView(name) {
  activeView = name;
  $$('.tabs [role=tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === name)));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  if (name === 'panel') render.renderPanel(false);
  if (name === 'history') render.renderHistory();
  if (name === 'watchlist') render.renderWatchlist(onRemove);
  if (name === 'health') {
    loadHealth();
    healthTimer = setInterval(loadHealth, 5000);
  }
}

async function onRemove(familyKey) {
  try {
    await api.removeFamily(familyKey); // server broadcasts a fresh snapshot
    render.renderWatchlist(onRemove);
  } catch (err) {
    console.warn('[panel] remove failed:', err.message);
  }
}

// ---------- live state ----------
function renderActive() {
  render.renderPanel(false);
  if (activeView === 'history') render.renderHistory();
  if (activeView === 'watchlist') render.renderWatchlist(onRemove);
}

function syncAlarmBanner() {
  const stillAlarming = store.allPlans().some((p) => p.alarm && p.status === 'in');
  if (!stillAlarming && alarm.bannerShown()) alarm.stopAlarm();
}

// ---------- connection / stale treatment ----------
function clearStale() {
  if (staleTimer) {
    clearTimeout(staleTimer);
    staleTimer = null;
  }
  $('#staleBanner').classList.remove('show');
  $('#app').classList.remove('stale');
}

function onConnState(state) {
  render.renderConnLamp(state);
  if (state === 'live') {
    clearStale(); // resync runs via onReconnect; drop the stale UI immediately
    return;
  }
  // connecting / reconnecting: arm the stale treatment if the drop persists. The
  // lamp already shows amber; only after the threshold do we banner + dim.
  if (!staleTimer && !$('#app').classList.contains('stale')) {
    staleTimer = setTimeout(() => {
      staleTimer = null;
      $('#staleBanner').classList.add('show');
      $('#app').classList.add('stale');
    }, STALE_AFTER_MS);
  }
}

const sseHandlers = {
  snapshot(snap) {
    store.setSnapshot(snap);
    render.renderWatcherLamp();
    renderActive();
    syncAlarmBanner();
  },
  plan(delta) {
    if (store.applyPlan(delta)) {
      render.renderPanel(true);
      syncAlarmBanner();
    }
  },
  alert(a) {
    // Authoritative banner: the server sends the `plan` delta before the `alert`,
    // so our state already reflects this plan. Ring/show ONLY if our own data
    // confirms it is actually IN — never claim a plan is in stock the data doesn't
    // confirm (the on-screen analogue of detection's never-false-IN). An alert for
    // a plan that is not confirmed IN (e.g. a read-error) is dropped.
    if (store.isPlanIn(a.id)) alarm.fire(a);
  },
  watcher(w) {
    store.applyWatcher(w);
    render.renderWatcherLamp();
    if (w.blind === true) {
      const group = famLabel(w.family) || 'that group';
      alarm.showBlind(`Watcher may be blind for ${group}${w.reasons?.length ? ' — ' + w.reasons.join(', ') : ''}. Stock detection is paused for ${group} until it recovers.`);
    }
    if (w.blind === false) alarm.clearBlind();
    if (activeView === 'health') loadHealth();
  },
  history(row) {
    store.prependHistory(row);
    if (activeView === 'history') render.renderHistory();
  },
  async onReconnect() {
    // The stream re-opened after a drop: re-fetch a full snapshot (we may have
    // missed deltas during the gap) and replace the store, so the panel catches
    // up rather than trusting possibly-stale local state.
    try {
      const [state, hist] = await Promise.all([api.fetchState(), api.fetchHistory()]);
      store.setSnapshot(state);
      store.setHistory(hist.transitions ?? []);
      lastEventAt = Date.now();
      render.renderWatcherLamp();
      renderActive();
      syncAlarmBanner();
    } catch {
      /* will retry on next event */
    }
  },
};

// ---------- boot ----------
async function boot() {
  try {
    const [state, hist] = await Promise.all([api.fetchState(), api.fetchHistory()]);
    store.setSnapshot(state);
    store.setHistory(hist.transitions ?? []);
  } catch (err) {
    console.error('[panel] initial load failed:', err.message);
  }
  render.renderWatcherLamp();
  render.renderPanel(false);

  // tabs
  $$('.tabs [role=tab]').forEach((b) => (b.onclick = () => setView(b.dataset.view)));

  // mute / silence
  $('#muteBtn').onclick = () => {
    const m = alarm.toggleMute();
    $('#muteBtn').setAttribute('aria-pressed', String(m));
    $('#muteLabel').textContent = m ? '🔕 muted' : '🔔 sound on';
  };
  $('#muteBtn').setAttribute('aria-pressed', String(alarm.isMuted()));
  $('#muteLabel').textContent = alarm.isMuted() ? '🔕 muted' : '🔔 sound on';

  $('#silenceBtn').onclick = async () => {
    alarm.stopAlarm();
    const alarming = store.allPlans().filter((p) => p.alarm && p.status === 'in');
    await Promise.allSettled(alarming.map((p) => api.silence(p.id)));
  };

  // arm audio + notifications on first interaction
  document.addEventListener('pointerdown', alarm.arm, { once: true });

  // SSE — wrap each named handler so any traffic bumps the "refresh Ns" lamp.
  const wrapped = { onReconnect: sseHandlers.onReconnect };
  for (const k of ['snapshot', 'plan', 'alert', 'watcher', 'history']) {
    const fn = sseHandlers[k];
    wrapped[k] = (d) => {
      lastEventAt = Date.now();
      fn(d);
    };
  }
  connectSse({
    ...wrapped,
    onState: onConnState, // drives the header lamp + stale treatment
  });

  // Freshness + header lamps. Run once on boot so uptime/refresh show a real value
  // immediately instead of the "—" placeholder for the first ~1s, then every 1s.
  const tick = () => {
    render.tickFreshness();
    $('#lastRefresh').textContent = `${Math.round((Date.now() - lastEventAt) / 1000)}s`;
  };
  tick();
  setInterval(tick, 1000);
}

boot();
