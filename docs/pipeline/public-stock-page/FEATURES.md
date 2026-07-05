# Feature checklist — public VPS stock page (beta coverage worklist)

Live surface: https://vps-stock.daichenlab.com (read-only). Derived from PRD G1–G7 +
the built page/API. Every row gets an explicit PASS / FAIL / BLOCKED verdict in the
beta pass — no silent skips.

## Page — content & hierarchy
- F01 Page loads over HTTPS with valid cert; title "VPS Stock Watch — live availability across watched providers"
- F02 Header: "VPS · Stock Watch" + multi-provider subtitle ("Live availability across watched VPS providers · read-only board") — no DMIT-only framing anywhere
- F03 Freshness pill: "updated Xs ago", ticks every second, green when fresh (≤2 min)
- F04 Stats strip: "N in stock" hero pill + waiting + watched counts consistent with the card wall
- F05 Per-datacenter counts in the stats strip (LAX · HKG · TYO · HNL)
- F06 Datacenter jump chips scroll/anchor to their sections
- F07 How-it-works explainer line under the stats strip
- F08 IN STOCK NOW hero section first, green cards, one card per IN plan
- F09 IN card: plan name, Popular chip when flagged, price + period, "in stock · <age>"
- F10 Buy now button opens the provider's cart deep link in a new tab (spot-check ≥3 links incl. one qq.pw plan when in stock; else verify href)
- F11 WAITING FOR RESTOCK wall grouped datacenter → generation, with generation chips (AS3/AN4/AN5/VDS + CPU line)
- F12 Provider badges are data-driven: DMIT sections vs qq.pw · WHMCS section (Honolulu)
- F13 OUT card: quiet style, "out of stock · <duration>" footer only when known
- F14 UNKNOWN/CHECKING renders as neutral grey "Checking…" — never red/alarming (find one or verify via demo mode)
- F15 Specs row appears only when the snapshot carries real spec fields (no placeholder pseudo-content anywhere)
- F16 Footer: how-it-works, "Not affiliated with any listed provider", open-source repo link (working)

## Freshness & data flow
- F17 Data auto-refreshes (~30 s) without a page reload (watch the pill reset / counts change)
- F18 Stale (>5 min): sticky "data may be stale — watcher offline" banner + dimmed board (evidence: orchestrator's live proof screenshots; verify banner ABSENT when fresh)
- F19 Aging tier (2–5 min): pill turns amber (verify via tier logic/demo if not naturally observable)
- F20 Tab hidden → polling pauses; visible → immediate refetch (observable via network or pill behavior)
- F21 Page state matches the API: counts/statuses on the page equal GET /api/state's counts
- F22 ?demo=1 renders labeled sample data ("demo data" chip) and does not affect the normal page

## Public API & security surface
- F23 GET /api/state: 200 JSON {v, pushedAt, receivedAt, now, state}, Cache-Control: no-store
- F24 GET /healthz: {ok, receivedAt, ageMs}
- F25 POST /api/push without token → 401 (with garbage token → 401); page keeps serving
- F26 Mutating panel endpoints absent: POST /api/silence, /api/watchlist/remove, /api/state all rejected (404 or 405 — never executed; router checks method before existence since round 2)
- F27 No alarm/audio/notification behavior anywhere: no sound, no Notification permission prompt, no alarm banner UI
- F28 Unknown paths → 404; path traversal attempts (e.g. /../server.js, /js/../../etc/passwd) → 404, never file contents

## Responsive & a11y
- F29 320 px: no horizontal overflow, cards single-column, header/pill legible
- F30 390 px: no horizontal overflow, 2-column card wall
- F31 1440 px: layout matches approved design (hero grid, wall grid)
- F32 Keyboard: tab reaches jump chips + buy links with visible focus
- F33 prefers-reduced-motion: no FLIP/motion animations

## Watcher/back-end behaviors visible from outside
- F34 Freshness recovers after watcher restart (receivedAt advances again — orchestrator's proof covers the transition; verify current freshness live)
- F35 Snapshot survives board-server restart (BLOCKED for testers — no server access; orchestrator/QA evidence stands)

## Round 2 — Telegram subscriptions + 5-minute cadence (2026-07-05)
- F36 Subscribe entry: "🔔 Get restock alerts" pill in the stats strip opens the panel
- F37 Per-card "🔔 Notify me" on OUT/Checking cards opens the panel with that plan preselected (IN cards have no bell)
- F38 Panel step 1: plan picker grouped by datacenter with tri-state select-all + live "N selected" count
- F39 Panel step 2: BotFather instructions with copyable commands; "press Start" called out; token + chat id fields
- F40 Inline validation: malformed token / non-numeric chat id show actionable errors on blur
- F41 "Find my chat id" helper works (or fails with the actionable "press Start first" state)
- F42 Subscribe success pane: "check your Telegram" + rendered preview of the confirmation card (real card arrives — verify with a real disposable token if provided, else BLOCKED)
- F43 Errors map to actions: Telegram-rejected token → 422 copy; rate limit → 429 countdown; server error → safe-retry copy
- F44 Manage tab: token + chat id → current plans pre-checked; update sends 🔄 receipt; unsubscribe silent; unknown pair → uniform "no subscription found"
- F45 ?manage=1 deep link opens the panel on the manage tab
- F46 Panel a11y: focus trapped, Esc closes, background inert, status region announces state changes
- F47 Panel responsive: drawer ≥720px, full-screen sheet below; zero overflow at 320/390 with panel open
- F48 Page copy reflects 5-min cadence everywhere ("about every 5 minutes" — no "~60 s" remnants)
- F49 Freshness ladder recalibrated: green well past 5 min of quiet; stale banner only at genuinely dead watcher (>20 min)
- F50 /api/state envelope carries cadenceSec: 300
- F51 Subscription API abuse checks: rate limits answer 429 + Retry-After; oversized bodies 413; malformed 400; unknown lookup 404 (uniform); no token value ever echoed
- F52 Read-only board behavior unchanged: alarm/audio/notifications still absent; Buy links still work
- F53 Digest card on live restock — BLOCKED live (cannot force a restock); QA's local E2E + real-token proof stand as evidence
