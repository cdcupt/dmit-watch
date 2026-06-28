// Restock alarm UX: WebAudio beep loop + flashing banner + browser Notification.
// Reacts ONLY to the server's `alert` event (never a status the panel inferred).
// Mute = client-only sound preference (localStorage); Silence is a server call
// owned by app.js (it clears the shared alarm flag).

import { $ } from './util.js';

const MUTE_KEY = 'dmit.muted';
let actx = null;
let timer = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';

export const isMuted = () => muted;

/** Unlock audio + ask for Notification permission on a user gesture. */
export function arm() {
  try {
    if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
    if (actx && actx.state === 'suspended') actx.resume();
  } catch {
    /* no audio available */
  }
  try {
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
  } catch {
    /* ignore */
  }
}

function beep() {
  if (!actx || muted) return;
  const o = actx.createOscillator();
  const g = actx.createGain();
  const t = actx.currentTime;
  o.type = 'square';
  o.frequency.setValueAtTime(880, t);
  o.frequency.setValueAtTime(660, t + 0.12);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.32);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + 0.34);
}

function startSound() {
  if (muted) return;
  stopSound();
  beep();
  timer = setInterval(beep, 900);
}
function stopSound() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export const bannerShown = () => $('#banner').classList.contains('show');

function notify(a) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const body = [a.city, a.cpu, a.price ? a.price + '/mo' : ''].filter(Boolean).join(' · ');
    new Notification('IN STOCK — ' + a.name, { body: body || 'buy now', tag: a.id });
  } catch {
    /* ignore */
  }
}

/** Fire the full alarm for an `alert` payload {id,name,deepLink,city,cpu,price}. */
export function fire(a) {
  $('#bannerTitle').textContent = 'IN STOCK — ' + a.name;
  $('#bannerSub').textContent =
    [a.city, a.cpu, a.price ? a.price + '/mo' : '', 'detected just now', 'Telegram sent'].filter(Boolean).join(' · ');
  $('#bannerBuy').href = a.deepLink || '#';
  $('#banner').classList.add('show');
  startSound();
  notify(a);
}

/** Stop sound + hide banner (used by Silence and when the last alarm clears). */
export function stopAlarm() {
  stopSound();
  $('#banner').classList.remove('show');
}

/** Toggle the client mute preference; returns the new muted state. */
export function toggleMute() {
  muted = !muted;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  if (muted) stopSound();
  else if (bannerShown()) startSound();
  return muted;
}

export function showBlind(text) {
  $('#blindText').textContent = text;
  $('#blindBanner').classList.add('show');
}
export function clearBlind() {
  $('#blindBanner').classList.remove('show');
}
