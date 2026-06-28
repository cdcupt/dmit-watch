// Pure-logic regression tests for the panel frontend (beta findings M1/L1/L2).
// These modules are DOM-free at import time, so the pure helpers are exercised in
// plain Node (no jsdom): render's card markup, the authoritative in-stock gate the
// alarm handler uses, and the blind-banner family label.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pcardHTML } from '../public/js/render.js';
import { famLabel } from '../public/js/util.js';
import * as store from '../public/js/store.js';

const plan = (over) => ({ id: 'p', name: 'PLAN', price: '$5', ...over });

// ---- L1: a status we don't know must never assert "Out of Stock" -----------

test('pcardHTML: IN renders the IN STOCK pill', () => {
  const html = pcardHTML(plan({ status: 'in', deepLink: 'https://x/cart.php' }));
  assert.match(html, /instockpill">IN STOCK/);
  assert.doesNotMatch(html, /Out of Stock/);
});

test('pcardHTML: OUT renders the definite "Out of Stock" pill', () => {
  const html = pcardHTML(plan({ status: 'out' }));
  assert.match(html, /class="oos">Out of Stock/);
});

test('pcardHTML: UNKNOWN renders a neutral pill, never "Out of Stock"', () => {
  const html = pcardHTML(plan({ status: 'unknown' }));
  assert.match(html, /class="unk">Unknown/);
  assert.doesNotMatch(html, /Out of Stock/);
  assert.doesNotMatch(html, /IN STOCK/);
});

test('pcardHTML: CHECKING renders a neutral pill, never "Out of Stock"', () => {
  const html = pcardHTML(plan({ status: 'checking' }));
  assert.match(html, /class="unk">Unknown/);
  assert.doesNotMatch(html, /Out of Stock/);
});

// ---- M1: the alarm banner is authoritative (gated on confirmed IN) ----------

test('store.isPlanIn: true only when the snapshot confirms status:"in"', () => {
  store.setSnapshot({
    datacenters: [
      {
        loc: 'lax',
        generations: [
          {
            key: 'lax/an5',
            plans: [
              { id: 'in-plan', status: 'in' },
              { id: 'err-plan', status: 'unknown' }, // a read-error plan
              { id: 'out-plan', status: 'out' },
            ],
          },
        ],
      },
    ],
  });

  assert.equal(store.isPlanIn('in-plan'), true);
  // The exact Lens-B case: an alert arriving for a plan that is actually a
  // read-error must NOT be treated as in stock → banner is dropped.
  assert.equal(store.isPlanIn('err-plan'), false);
  assert.equal(store.isPlanIn('out-plan'), false);
  assert.equal(store.isPlanIn('ghost'), false); // unknown id
  assert.equal(store.planById('in-plan')?.status, 'in');
  assert.equal(store.planById('ghost'), null);
});

// ---- L2: blind-watcher banner names the actual datacenter·family ------------

test('famLabel: family key becomes a "DC·FAMILY" label', () => {
  assert.equal(famLabel('lax/as3'), 'LAX·AS3');
  assert.equal(famLabel('tyo/an5'), 'TYO·AN5');
  assert.equal(famLabel(''), '');
  assert.equal(famLabel(undefined), '');
});
