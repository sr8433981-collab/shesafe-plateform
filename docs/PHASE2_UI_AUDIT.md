# SheSafe — Phase 2 UI / UX Audit

**Date:** 2026-10-08
**Scope:** every file under `frontend/` (2 HTML documents, 1 stylesheet, 1 service worker, 1 manifest, 16 ES modules) plus the client-facing half of the API surface.
**Baseline:** the state described in [`ARCHITECTURE_AUDIT.md`](ARCHITECTURE_AUDIT.md) remediation — Flask app factory, SQLite, signed sessions, CSRF, capability manifest, 160 pytest + 36 jsdom checks green.
**Method:** read every frontend file end to end, then verified each suspected defect with a throwaway jsdom probe that boots the real module graph against a live server. Findings marked **[verified]** were observed at runtime, not inferred. Findings marked **[read]** are provable by reading the cited lines.

> Audit-first rule honoured: **no product file was modified until this document was completed.**

---

## 0. Executive summary

The backend of this product is genuinely strong. The frontend is a competent collection of screens bolted onto a design system that nobody finished.

The single most important finding is not cosmetic:

> **[verified] A signed-out visitor is shown the authenticated dashboard, not the sign-in screen.**

`boot()` calls `showAuth()` and *then* `router.start()`. The router's `render()` iterates every `[data-view]` element and unhides `view-home`, which hides `view-auth` on the same pass. The existing smoke test misses it because its boot assertion is vacuous — it passes on `document.querySelector('#form-login button[type=submit]')`, which is `true` whether or not the login form is visible. So the first thing a judge sees at a cold load is an empty, unauthenticated dashboard shell with a live-looking SOS button and five navigation tabs.

Everything else in this document follows from the same root cause: **the UI was assembled screen-by-screen without a governing model of hierarchy, state, or vocabulary.**

### Findings summary

| Severity | Count | Theme |
| --- | --- | --- |
| **BLOCKER** | 6 | Auth gate bypassed at boot, SOS button lies, SOS is not press-and-hold, emergency banner is incomplete, no emergency persistence across views, one error state kills the guardian link |
| **HIGH** | 19 | No hierarchy on the dashboard, five status vocabularies, no way to reach 5 of 10 views, `HIGH` and `MODERATE` look identical, provenance text is unreadable, guardian has no timeline, moderation is three native prompts |
| **MEDIUM** | 22 | Dead elements, dead exports, 81 inline style objects, 11 gradients, 7 hard-coded hex values in JS, no dark mode, no offline state, no reconnect state, no loading states |
| **LOW** | 14 | Emoji iconography, breadcrumb-only back nav, over-narrow line lengths, redundant capability list, copy that duplicates the server manifest |

### Score

| Dimension | Now | Why |
| --- | --- | --- |
| First impression | 3 / 10 | Unauthenticated dashboard, card grid, no focal point |
| Information hierarchy | 3 / 10 | 8 equal-weight cards; SOS competes with helplines |
| Emergency UX | 4 / 10 | Honest server, dishonest button label, incomplete active surface |
| SOS interaction design | 4 / 10 | Tap only, no hold, unused marquee countdown |
| Safety intelligence UI | 5 / 10 | Explainable, but presents *risk* as the hero number against the brief |
| Route intelligence UI | 4 / 10 | Raw lat/lng inputs, no comparison, no deltas |
| Guardian console | 4 / 10 | No timeline, no journey status, dies on one network blip |
| Journey Guard | 5 / 10 | Works; no trusted-contact selection; dead ternary in the card class |
| Contact management | 4 / 10 | Add/remove only — no edit, no pause, self-attested verification |
| Community safety | 4 / 10 | Correct states, three chained native prompts to moderate |
| Visual consistency | 4 / 10 | 5 vocabularies, 81 inline styles, emoji as icons |
| Accessibility | 5 / 10 | Good bones (landmarks, skip link, focus ring) undermined by 10px text, colour-only band encoding, no desktop nav |
| State coverage | 3 / 10 | No offline, no reconnecting, 5 dead render targets, 9 unused API methods |
| **Overall** | **4.0 / 10** | Honest backend, ungoverned frontend |

---

## 1. BLOCKER findings

### B-01 · The auth gate is bypassed at boot — a signed-out visitor sees the dashboard **[verified]**

`app.js:showAuth()` (l.276) unhides `#view-auth` and hides every other `[data-view]`. It is called from `boot()` at l.79, and `router.start()` runs at l.84. `router.render()` (l.71–74) then does:

```js
for (const view of $$('[data-view]')) {
  const active = view.id === viewId;   // view-home
  view.hidden = !active;               // → view-auth.hidden = true
}
```

Observed at runtime with no session cookie:

```
#view-auth hidden=true    #view-home hidden=false
tab bar visible = true    #btn-sos present = true
```

Consequences:
* The landing page is never what a judge, a user or a screenshot sees.
* Every "unauthenticated" guard in the app is cosmetic — `router.onBeforeNavigate` only redirects *away from* private routes once a route change happens; it does not control what is rendered on first paint.
* The tab bar and SOS button are exposed to anonymous users.

`tests/frontend/smoke.mjs:259` masks it:
```js
const booted = await waitFor(() => !document.getElementById('view-auth').hidden
  || document.querySelector('#form-login button[type=submit]'));
```
The second clause is unconditionally true because the form exists in the DOM regardless of visibility.

**Fix:** the auth view must not be part of the router's `[data-view]` set. It becomes a separate, mutually exclusive surface controlled by session state, and the router must refuse to render any authenticated view while `authenticated === false`. The smoke assertion must become `!view-auth.hidden && view-home.hidden`.

---

### B-02 · The SOS button's label promises an action it does not perform **[read]**

`app.js:185–188`:
```js
$('#btn-sos')?.addEventListener('click', () => {
  if (store.get().sosPhase === 'COUNTDOWN') void sos.cancelBeforeActivation();
  else void sos.arm('button');
});
```

`app.js:322–328` relabels the button during an active incident:
```js
sosButton.querySelector('.sos-button__label').textContent = active ? 'STOP' : 'SOS';
sosButton.querySelector('.sos-button__sub').textContent   = active ? 'Stand down' : 'Tap once';
sosButton.setAttribute('aria-label', active ? 'Stand down the emergency' : 'Start an emergency SOS');
```

But `sos.arm()` (sos.js:51) opens with:
```js
if (isEmergencyOpen()) {
  toast('An emergency is already open. Use the emergency screen to stand it down.', 'warning');
  return null;
}
```

So a person in an emergency who reads "STOP / Stand down", taps it, and gets a toast saying the opposite. In a panic this is the single most damaging interaction in the product. **The label must describe what the control does, or the control must do what the label says.**

---

### B-03 · SOS has no press-and-hold, and its marquee countdown is never used **[read + verified]**

The brief requires `READY → PRESS & HOLD / TAP → COUNTDOWN → CANCEL → ACTIVE`. The implementation offers tap only. A single mis-tap in a pocket starts a 10-second timer that notifies real people; press-and-hold is the standard mitigation and costs ~40 lines.

Separately, `.countdown` (app.css:418) is designed with `clamp(3rem, 16vw, 5rem)` and `tabular-nums` — a marquee countdown number — and it is **never used in the SOS flow**. It appears exactly once, for Journey Guard (`journey.js:77`). The SOS countdown is a text badge reading `Cancelling in 7s` (`app.js:343`). The emergency's most emotionally loaded number is the smallest element on the screen, while Journey Guard's timer gets the marquee treatment.

---

### B-04 · The active-emergency surface omits the states the brief requires **[read]**

The brief specifies, during an active emergency: **SOS ACTIVE · Incident ID · Location · GPS accuracy · Last updated · Location sharing: ACTIVE · Trusted contacts: NOTIFIED / SIMULATED / FAILED · Emergency services: AVAILABLE / UNAVAILABLE · Call 112 · Stand Down.**

`app.js:358–409` renders: a heading, a `Ref SS-XXXXXX` badge, one line of coordinates with accuracy and relative time, three aggregate counters (`Delivered` / `Simulated` / `Unavailable`), the server's `statement` string, Call 112, Escalate, Stand down, and a collapsed `<details>` timeline.

Missing, verified by absence:

| Required | Present |
| --- | --- |
| `SOS ACTIVE` as the primary label | yes (`Emergency active`) |
| Incident reference | yes |
| Coordinates / accuracy / last updated | yes |
| **Location sharing: ACTIVE** | **no** |
| **Per-contact NOTIFIED / SIMULATED / FAILED** | **no** — only aggregate counters, and `incident.notifications[]` is fetched but never rendered |
| **Emergency services: AVAILABLE / UNAVAILABLE** | **no** |
| Call 112 / Stand Down | yes |

The API already returns everything needed (`serialize_incident` populates `notifications[]` with `channel`, `provider`, `status`, `detail`, `at`). The UI simply does not show it.

---

### B-05 · An active emergency is invisible on every other screen **[read]**

`#emergency-banner` (index.html:128) exists **only inside `#view-home`**. Navigating to Safety, Journey, Places or History during an active emergency shows no indicator at all: no bar, no badge, no colour change. The tab bar has no emergency state. The document title does not change.

A person who pressed SOS, then tapped a tab to check something, is now looking at a calm, white, reassuring screen with no sign that an incident is open. For a safety product this is a critical failure — the calm/urgent language is currently coupled to a scroll position rather than to application state.

---

### B-06 · One network blip permanently kills the guardian link **[read]**

`track.js:41–55`:
```js
try { … render(payload); }
catch (error) { stopPolling(); renderError(error); }
```

Any error — a 500, a timeout, a dropped Wi-Fi frame, a suspended phone — calls `stopPolling()`. The page then shows a hard "Tracking unavailable" state forever. A guardian whose friend is in danger loses the live view because of a single transient failure. The brief explicitly asks for reconnect behaviour.

The same class of bug exists app-wide: `api.js` raises `ApiError` with `offline: true` on a network failure, and **no view anywhere renders a persistent offline state** — `showServerDown` (app.js:87) only fires at boot.

---

## 2. HIGH findings

### 2.1 The dashboard has no hierarchy

`index.html:122–219` renders **eight cards** in three separate grids:

1. Trusted contacts · 2. Live location · 3. Journey guard · 4. Quick actions
5. Emergency helplines · 6. What this build can really do
plus the SOS hero and a page heading.

Every one of them is the same `.card` with the same `--shadow-1`, the same 24px padding and the same `h3.card__title`. The result is a wall. The brief's required order — SOS, safety status, Journey Guard, live location, contacts, safe places, intelligence — is not represented; the dashboard is a navigation grid.

Specific problems:
* **Nothing shows the safety score.** The single most differentiated number in the product is only visible after navigating to `#/intelligence`.
* **"Quick actions" (index.html:187–200)** is six navigation links that duplicate the tab bar and add a seventh destination. Pure navigation noise.
* **"What this build can really do"** renders 11 rows of technical capability text (app.js:792) on the *dashboard*, below the fold, where nobody reads it. The same list already belongs on `#/security`.
* **"Emergency helplines"** renders 8 rows (app.js:769) on the dashboard. In an emergency a user needs 112 within one thumb, not a scrollable list — and 112 is already a dedicated button 300px above it.
* **Emergency split across two regions.** `#emergency-banner` (l.128) sits *above* `.sos-hero` (l.130), so during an emergency the user reads the active-incident banner and is then immediately pushed back into the "SOS / Tap once" hero. The emergency and the ready state are interleaved.

### 2.2 Five different status vocabularies for one idea **[verified]**

| File | Constant | Purpose |
| --- | --- | --- |
| `app.js:815` | `MODE_CLASS` / `MODE_GLYPH` | real / simulated / unavailable / partial |
| `intelligence.js:13` | `BAND_CLASS` | LOW / MODERATE / HIGH / CRITICAL |
| `reports.js:10` | `STATE_BADGE` | COMMUNITY_REPORTED / UNDER_REVIEW / … |
| `journey.js:16` | `STATE_META` | ON_JOURNEY / CHECK_IN_REQUIRED / … |
| `track.js:23` | `STATE_META` | ARMING / COUNTDOWN / ACTIVE / … |

Five tables, five class vocabularies, five label spellings for the same visual grammar. `journey.js:62` even declares `class: 'card' + (… ? '' : '')` — a ternary whose branches are identical, i.e. a card variant that was designed and never implemented.

### 2.3 Five of ten views are unreachable from anywhere but the dashboard **[verified]**

Routes: `home, sharing, intelligence, route, places, journey, reports, assist, history, security`.
Tab bar: `home, sharing, intelligence, journey, places` (verified: `home,sharing,intelligence,journey,places`).

`route`, `reports`, `assist`, `history`, `security` are linked **only** from the dashboard's "Quick actions" card. On every non-dashboard view the only way back is a `← Dashboard` breadcrumb. There is no desktop navigation at all: `.tabbar { display: none }` above 900px (app.css:236) with no replacement.

For a desktop judge on a projector, this means: dashboard → click → back to dashboard → click → back. It reads as a prototype with no shell.

### 2.4 `HIGH` and `MODERATE` risk are visually identical **[verified]**

```js
// intelligence.js:13
const BAND_CLASS = { LOW: 'badge--safe', MODERATE: 'badge--warn', HIGH: 'badge--warn', CRITICAL: 'badge--danger' };
```

`MODERATE: 'badge--warn', HIGH: 'badge--warn'` — confirmed. A `HIGH` risk band, which the brief says must be "informative, noticeable, actionable", renders in exactly the same amber pill as `MODERATE`. This is both a comprehension failure and a WCAG 1.4.1 (use of colour) failure.

### 2.5 The honesty payload is the smallest text in the application **[verified]**

`rem` values below `0.75rem` present in `app.css`:

```
0.62  .risk-scale (band boundary labels)
0.65  .timeline__dot
0.66  .tabbar__link label
0.68  .feature-row__provenance, .metric__label, .placePopup tag
0.70  .badge (all status pills)
0.72  .field__error
0.74  .tiny
```

`0.62rem` ≈ 9.9px and `0.68rem` ≈ 10.9px. The **provenance strings, the risk band boundaries and the confidence labels** — the entire explainability payload — are the smallest text on screen, below the 12px practical floor and far below the WCAG 2.5.8 target-size expectations for dense data. `--step--1` clamps to a 12.5px floor, which sets the low bar for everything.

### 2.6 The guardian page is not an emergency-response console

`track.html` + `track.js` render: a name, coordinates, a status badge, four metrics, a notice, a map and three buttons. The brief requires **USER · STATUS · CURRENT LOCATION · LAST UPDATED · GPS ACCURACY · INCIDENT TIME · JOURNEY STATUS** and a five-step timeline.

Present: name, status, location, last update, accuracy.
Absent: **journey status**, **incident duration/elapsed time**, **the timeline**, **per-contact alert status**, an explicit "who is this person to me" context line, and any indication that the page is polling (a guardian cannot tell a frozen page from a live one).

Also: `$('#status-badge')` (`track.js:69`) changes outside any live region, so a screen-reader user is never told the state became `Emergency active`.

### 2.7 Moderation is three chained native dialogs

`reports.js:101–106`:
```js
const note = window.prompt(`Moderating: "${report.title}"\nAdd a note…`);
if (note === null) return;
const nextState = window.confirm('Is this report VERIFIED?\n\nOK = VERIFIED\nCancel = move to UNDER_REVIEW');
const confidence = nextState ? window.prompt('Confidence 0.5-1.0 …', '0.7') : '0.3';
```

Three blocking, unstyled, OS-rendered dialogs in sequence. The state machine is encoded in which button the user presses on a `confirm`. There is no list of valid transitions, no preview of the outcome, no undo. Verified inventory of native dialogs in the UI: **9 call sites** — `places.js:191,203` (`alert`), `contacts.js:109`, `journey.js:161`, `reports.js:103` (`confirm`), `sharing.js:61,65`, `reports.js:101,105` (`prompt`).

### 2.8 Route planning asks for raw coordinates

`index.html:309–312` prefills `From (latitude, longitude)` with `28.63280, 77.21970` and `To` with `28.65010, 77.24120` — hardcoded Delhi coordinates. There is no address search, no map picker, no "recent destinations". A judge asked to try it types numbers, or presses the button and pretends. On a parse failure they get `window.alert('Enter both points as "latitude, longitude", …')` (places.js:203) — an OS dialog in the middle of a designed flow.

### 2.9 Safety Intelligence presents the inverse of what the brief asks for

The brief's canonical output is:
```
Safety Score   78 / 100
Risk level     HIGH
Confidence     71%
Contributing factors: Incident density +22, Late-night travel +18, …
```

`intelligence.js:63–69` renders:
```
{ riskScore }  / 100 risk        [ safety { safetyScore } ]   ← 3rem, inline style
```

The hero number is **risk**, and safety is demoted to a small badge. The engine computes both (`safetyScore = 100 - riskScore`), so this is a pure presentation choice — and it is the wrong one for a person deciding whether to walk somewhere. Contributing factors are in a **separate card below the fold** rather than adjacent to the score, and there is no signed `+22 / −10` contribution display; only `points / weight`.

### 2.10 There is no "Why this score?" interaction

`intelligence.js` has two `<details>` elements — "Data provenance" (l.135) and the engine card. There is no single plain-language explanation a non-technical person can read in one sentence. The brief asks for exactly this.

### 2.11 Journey Guard has no trusted-contact step

The brief's flow is `START JOURNEY → destination → expected arrival → trusted contact → active`. The backend schema has `journeys.contact_id REFERENCES contacts(id)` (db.py:149) and `POST /api/journeys` accepts it, but `journey.js:135–139` sends only `origin`, `destination`, `expectedMinutes`. **The feature is missing from the form entirely**, so the one person most likely to help is never attached to the journey record.

### 2.12 Emergency contacts cannot be edited or paused

`PATCH /api/contacts/<id>` exists and is fully implemented (`contacts.py:62`), accepting `channels`, `isPrimary`, `active`, `verified`, `name`, `phone`, `relationship`. The frontend never calls it. Consequences:
* A contact whose number changed cannot be corrected.
* A contact who is travelling or unreachable cannot be paused (`active: false`) — the field is rendered (`contacts.js:73` → "Paused") but unreachable.
* Primary contact can only be set at creation time.

### 2.13 "Confirmed" is self-attested and reads as verified

`contacts.js:70` renders `Confirmed` in a green `badge--safe` after `POST /contacts/<id>/verify`, which only writes `verified = 1`. The API's own note — *"Self-confirmed. SheSafe cannot independently verify phone ownership."* — appears in a transient toast and is then forgotten. A green "Confirmed" pill in a safety product is a claim. It must be labelled for what it is.

### 2.14 The route comparison does not exist

`places.js:250–312` renders one card per route with a big safety number and a "Why" list. There is no side-by-side comparison, no `+6 min` delta against the fastest option, no statement of the trade-off in one line. The brief's example — *"Adds 6 minutes but passes through areas with better safety infrastructure and lower incident density"* — has no home in the current UI. The backend returns `whySafer[]`; the UI prints it as an undifferentiated bullet list under a heading literally called "Why".

### 2.15 No persistent offline or reconnecting state

`ApiError` carries `offline` and `isRateLimited`. Nothing renders them. Consequences: a user whose connection drops mid-SOS sees a toast that disappears and then a dashboard that silently stops updating.

---

## 3. MEDIUM findings

### Dead elements — rendered by nobody **[verified]**

| Element | Problem |
| --- | --- |
| `#location-telemetry` (index.html:238) | Never populated. The sharing view's whole telemetry panel is blank; `app.js` renders `#location-summary` instead. |
| `#engine-info` (index.html:292) | Never populated. `intelligence.loadEngineInfo()` is exported and **called from nowhere** — the view loader is `intelligence.renderAssessment` only (app.js:40). The card renders permanently empty, so the engine's own limitations are never shown. |
| `#demo-login-box` (index.html:86) | Never populated. Demo Mode has no entry point. |
| `#header-status` → `#header-location-badge` | Replaced wholesale in `enterApp()`, then only updated by `renderLocationToggle()`. |
| `#contacts-count` | Shows a bare number with no unit. |

### Dead exports **[verified]**

`dom.js`: `icon`, `formatDistance`, `clear` — never called.
`api.js`: `health`, `get`, `patch`, `delete`, `postCheckIn`, `journeys`, `sosLifecycle`, `demoStatus`, `demoScript`, `demoReset`, `pingLocation`, `latestLocation` — never called by any module.
`app.js:914`: `export { announce, ApiError }` — imported by nothing.
`store.js:85`: `actions.markBusy` / `actions.isBusy` — never called.
`helpers.py:29`: `bearer_route` — never applied.

The `demoStatus` / `demoScript` / `demoReset` cluster matters most: **the backend already implements a 10-step demo script and it is entirely invisible to the UI.**

### Duplicated logic **[verified]**

| Duplication | Locations |
| --- | --- |
| `metric()` defined 3× | `app.js:539`, `places.js:314`, `track.js:196` |
| Load → skeleton → result-or-`errorState`, hand-rolled 8× | every module |
| Timeline rendering | only in `app.js:394`; needed by History and Guardian |
| Countdown formatting | `journey.js:188` (`MM:SS`) vs `app.js:343` (`7s` badge) |
| Map + marker + layer bookkeeping | `app.js:653–664` (properties monkey-patched onto the Leaflet map object as `__pin` / `__circle`), `places.js:state`, `track.js` module globals |
| User marker icon | `mapkit.userIcon()` exists; `track.js:161` re-implements it inline |
| Confirm-before-destructive-action | `contacts.js:109`, `journey.js:161`, `reports.js:103` — three different native flows |

### Visual inconsistency

* **81 inline `style: { … }` objects** across the 8 JS modules, bypassing the design system entirely.
* **7 hard-coded hex colours in JS** — `#e11d48`, `#2563eb`, `#bfdbfe`, `#be123c` in `app.js:660–661`, `places.js:167–168`, `track.js:169`.
* **11 gradient declarations** in one stylesheet: `.sos-hero`, `.brand__mark`, `.sos-button`, `.call-112`, `.sos-active`, `.risk` (4-stop), `.skeleton` (shimmer), `.select` chevrons (2), `.badge--simulated` (hatch), `.demo-ribbon` (hatch).
* **Two different "simulated" treatments**: `badge--simulated` is a 6px amber hatch; `.demo-ribbon` is a 10px brown hatch. One concept, two visuals.
* **Brand is also danger.** `--brand-600` is simultaneously: the SOS button, `btn--brand`, `btn--danger`, the Call 112 button, the active-emergency banner and the `Primary` contact badge. The primary action and the emergency action are the same colour, so the SOS button has no colour of its own.
* **No dark mode**, despite `<meta name="color-scheme" content="light dark">` (index.html:6, track.html:6). Verified: zero `prefers-color-scheme` blocks. On a platform in dark mode, UA-rendered form controls and scrollbars go dark against a white page.
* **Emoji as iconography**: `🛡️ 👤 👁 🎤 🔇 🔊 🆘 📍 📊 ⏱️ 🏠 📞 🚨 📋 📱 💬 ⚠️ ✓ ✕ ◐ ⚗ ★ ＋ 👮 🏥 💊 🏠 🌸 💡`. Rendering, weight and colour differ on every OS, so the UI is visually inconsistent by construction. Several are decorative inside controls that also carry text; several are the *only* affordance.

### Mobile layout

* `.sos-button` is `aspect-ratio: 1; max-width: 320px` (app.css:380–392) inside a hero with `var(--sp-5)` padding. On a 360px viewport it is ~280px tall, so **Call 112 and the honesty note fall below the fold**. The two most important controls in the product are not simultaneously visible on the most common Android width.
* **The tab bar covers the footer.** `.tabbar` is `position: sticky; bottom: 0` (app.css:216) and is the *last* child of `.shell`; `.app-footer` is second-to-last. The sticky bar therefore overlays the footer permanently on mobile.
* `.grid--2` is `minmax(280px, 1fr)` with `var(--sp-4)` gutters inside `.wrap`'s 16px padding — a 280px floor plus 32px of gutter leaves a 1-column layout only below ~312px.
* `.card` uses `var(--sp-5)` (24px) padding at every width; on a 320px screen that leaves 224px of content.
* `.toasts` is offset `calc(var(--tap) + var(--sp-4))` = 64px from the bottom in both documents, but `track.html` has no tab bar, so guardian toasts float 64px above nothing.
* `.modal__panel` is a bottom sheet with no drag handle and no safe-area inset (`padding-bottom: env(safe-area-inset-bottom)` is absent), so on an iPhone the submit button sits under the home indicator.

### Missing states

| State | Where it is needed | Present |
| --- | --- | --- |
| Offline | everywhere | no |
| Reconnecting | guardian | no (and it gives up — B-06) |
| Loading | `#helpline-list`, `#journey-history`, `#shares-list`, `#share-actions`, `#capability-list`, `#header-status` | no (`app.js:780` renders the bare string `"Helplines unavailable."` with no retry and no `role="alert"`) |
| Error | `#location-telemetry`, `#capability-list` | no |
| Empty | `#capability-list` | no |
| No contacts | contacts | yes (`contacts.js:37`) |
| No incidents | history | yes |
| No reports | reports | yes |
| Permission denied | location | yes |
| No fix yet | SOS | partial — "No position captured yet", but no guidance |

---

## 4. LOW findings

1. Emoji icons lack `aria-hidden` in several controls (`index.html:485–489` tabbar has it; `index.html:37,82,148,149` do not need it but `#btn-siren-toggle`'s text is rebuilt as `"🔊 Siren on"` with no `aria-hidden` on the glyph — the screen reader announces "loud speaker").
2. Every non-dashboard view's only affordance is a `← Dashboard` breadcrumb.
3. `.page-head p` is capped at `62ch` and `.state p` at `44ch`, but body text elsewhere runs full width on desktop.
4. The capability list duplicates `/api/capabilities` prose that is already on `#/security`, and the `#/security` copy is hardcoded static text that will silently drift from the manifest.
5. `announce()` creates a `role="status" aria-live="polite"` region lazily (dom.js:105). During an emergency, state changes must be **assertive**.
6. `announce()` clears then re-sets the region after 40ms, which can drop a message in fast screen readers.
7. `#btn-assist` (AI guidance) is reachable from nowhere in the navigation. Correct decision (it is advisory), wrong implementation (dead-end).
8. `track.js:110` — `callLink.classList.add('btn--quiet')` is never removed, so the "Phone number hidden" state latches.
9. `.risk-scale` labels ("31 moderate", "61 high") imply boundaries that are off-by-one versus `scoring.BANDS` (`(31, 60, "MODERATE")`, `(61, 80, "HIGH")`) — they happen to agree, but the scale is hardcoded in CSS-adjacent JS and can drift.
10. `js/app.js` ships `#btn-voice-sos` and `#btn-siren-toggle` inside the SOS hero, competing with the SOS button for the same visual attention.
11. `store.js` keeps `busy` as a `Set` compared by reference, so `store.on('busy')` fires on every change and never coalesces.
12. `--violet-*` exists solely for `badge--violet` (used by `BALANCED` routes and `LLM` assist) — a decorative fifth hue.
13. `robots: noindex, nofollow` is set on `track.html` but not on `index.html`.
14. `.hero-points` renders four emoji + bold-lead + paragraph rows on the auth screen — the single largest element on the landing page is marketing copy, not the sign-in form.

---

## 5. What must NOT change

Explicitly protected by this audit:

| Preserve | Where |
| --- | --- |
| Flask application factory, blueprints, repo layer | `backend/app/__init__.py` |
| SQLite schema, WAL, FKs, indexes, migrations | `backend/app/db.py` |
| Hash router (no History API rewrite) | `frontend/js/core/router.js` |
| `el()` DOM builder — zero `innerHTML` in the data path | `frontend/js/core/dom.js` |
| Server-authoritative SOS state machine | `backend/app/api/sos.py` |
| Capability manifest as the single source of honesty labels | `backend/app/api/meta.py` |
| Notification provider registry + status vocabulary | `backend/app/notifications/__init__.py` |
| Explainable rule engine `RULE_BASED_V1` | `backend/app/intelligence/scoring.py` |
| Share tokens: 256-bit, SHA-256 at rest, expiring, revocable | `backend/app/api/location.py` |
| Owner-scoped queries, CSRF, origin guard, strict CSP, rate limits | `backend/app/security.py` |
| `RULE_BASED` no-ML stance; no accuracy figures anywhere | everywhere |
| Vanilla ES modules, no build step, no framework | `frontend/` |
| Leaflet + OSM + OSRM + Overpass | `frontend/js/core/mapkit.js` |

---

## 6. Remediation plan — the contract for Phase 2

### P0 — correctness before cosmetics

1. **Fix the auth gate.** Auth becomes a router-excluded surface. Add a regression test asserting `#view-auth` visible **and** `#view-home` hidden with no session, and repair the vacuous smoke assertion.
2. **Make the SOS button truthful.** Press-and-hold to arm (with an accessible keyboard/tap fallback), the active state labelled for what the control does, and the whole flow reachable without leaving the screen.
3. **Own the emergency at the shell level.** A persistent emergency bar outside `#view-home`, a tab-bar emergency state, and a document title that changes. The active incident becomes a first-class surface, not a card above the fold.
4. **Complete the active-emergency console.** Location sharing state, per-contact `NOTIFIED / SIMULATED / FAILED / UNAVAILABLE`, and `Emergency services: UNAVAILABLE` read from the capability manifest.
5. **Fix the guardian reconnect loop** with backoff, a visible `Reconnecting…` state, and a last-known-position banner that never fabricates.

### P1 — hierarchy and comprehension

6. Rebuild the dashboard to the brief's order with a real focal point: safety status as the hero readout, SOS as the single dominant action, and no card grid.
7. **Safety Intelligence**: safety score as the hero number, band with a distinct `HIGH` treatment, signed contributions (`+22` / `−10`) adjacent to the score, confidence with a plain-language label, data-coverage badge, and a one-sentence **"Why this score?"**.
8. **Safe Route Intelligence**: address-free but usable (map-pick + "use my position"), a FASTEST / BALANCED / SAFEST comparison with deltas, and an explicit *"Limited safety data available."* state when coverage is thin.
9. **Guardian console**: full telemetry block, incident elapsed time, journey status, and the five-step timeline.
10. **Journey Guard**: add the trusted-contact step, an escalation ladder, and the honest browser-limitation statement in the active state, not only in a collapsed `<details>`.
11. **Contacts**: edit, pause, primary reassignment, per-channel preference editing, and a verification flow labelled honestly (self-confirmed vs provider-confirmed).
12. **Community safety**: a real moderation sheet with explicit target states and a required note — replacing the three native prompts.

### P2 — coherence

13. One design system: tokens, one status vocabulary, one `metric()`, one `timeline()`, one `loadInto()` helper, a real icon set (inline SVG, `aria-hidden`, `currentColor`), no inline styles, no emoji-only controls.
14. All **81** inline style objects and **7** hex literals replaced with tokens.
15. Minimum text size raised to 12px; honesty payload (provenance, confidence, band boundaries) given dedicated readable styles.
16. Reduce gradients to where they carry meaning (the SOS button, the active emergency surface) and delete the rest.
17. Add `prefers-color-scheme: dark` tokens, or remove the `color-scheme` meta. Declaring support you do not have is worse than not declaring it.
18. Desktop navigation that replaces the tab bar above 900px.
19. Footer no longer occluded; modal sheets get a safe-area inset and a drag handle.

### P3 — states and resilience

20. Persistent offline bar with a plain statement of what still works (SOS button, helplines) and what does not (recording, alerting).
21. Loading skeletons for every list; `errorState` with retry for every failure; no bare text fallbacks.
22. Remove or wire the 5 dead elements and 13 dead exports. Wire the **existing** `GET /api/demo/script` into a Demo Mode panel.
23. Guardian and main app: exponential backoff, `Reconnecting…`, and never discard a last-known position silently.

### P4 — PWA and accessibility

24. Offline emergency information (helplines + 112) baked into the cached shell, with an explicit statement that SOS recording requires connectivity.
25. Full keyboard/focus/ARIA/contrast audit, asserted by tests: focus moves to Cancel on arm; emergency changes use an **assertive** live region; every icon-only control has an accessible name; every status pill has a text label, never colour alone.
26. Touch targets ≥ 44px verified in CSS and asserted in tests.

### P5 — production gaps

27. Contact verification state machine (`unverified → pending → self_confirmed → provider_confirmed`), provider-ready, honestly `SIMULATED` without credentials.
28. Retention + cleanup job: expired share tokens, stale location samples, closed emergency sessions, audit-log trimming.
29. Data export and account deletion with an explicit confirmation and an audit entry.
30. Moderator role with a real permission check on `POST /reports/<id>/moderate`, plus the demo-mode escape hatch clearly labelled.
31. Distributed rate-limit interface with the in-process implementation behind it.

### P6 — demonstration

32. A deterministic 4-minute Demo Mode scenario with a visible step guide, every simulated surface badged `SIMULATED`.
33. `docs/JUDGE_DEMO.md` with exact click-by-click instructions.

---

## 7. Acceptance criteria for Phase 2

Phase 2 is complete when **all** of the following are true and demonstrated:

| # | Criterion | Verified by |
| --- | --- | --- |
| 1 | A signed-out visitor sees the sign-in screen and nothing else | jsdom test |
| 2 | The SOS button's label always describes its action | jsdom test |
| 3 | SOS is armable by press-and-hold and by keyboard/tap | jsdom test |
| 4 | The countdown shows a marquee number and an immediate cancel | jsdom test |
| 5 | The active surface shows location, accuracy, last update, sharing state, per-contact status and `Emergency services` | jsdom test |
| 6 | An active emergency is visible from every view | jsdom test |
| 7 | A transient network error does not kill the guardian page | jsdom test |
| 8 | `HIGH` and `MODERATE` render differently | jsdom test |
| 9 | Safety Intelligence shows safety score, band, confidence, signed contributions and a plain-language explanation | jsdom test |
| 10 | Routes render FASTEST / BALANCED / SAFEST with deltas, or say "Limited safety data available." | jsdom test |
| 11 | Journey start captures a trusted contact | pytest |
| 12 | Contacts can be edited, paused and re-primaried | pytest + jsdom |
| 13 | Moderation requires a note and an explicit target state, with no native dialog | jsdom test |
| 14 | No `window.alert` / `confirm` / `prompt` remains in the client | grep assertion in tests |
| 15 | No `innerHTML` and no inline event handlers remain in the client | grep assertion in tests |
| 16 | Zero inline `style:` objects in the client module graph | grep assertion in tests |
| 17 | Zero hard-coded hex colours in the client module graph | grep assertion in tests |
| 18 | `metric()` is defined once | grep assertion in tests |
| 19 | No text below 12px in the stylesheet | grep assertion in tests |
| 20 | Every view is reachable from persistent navigation | jsdom test |
| 21 | An offline state is shown, not hidden | jsdom test |
| 22 | All 160 pytest + 36 jsdom checks still pass, plus the new ones | `npm run test:all` |

---

*Phase 2 audit complete. Remediation begins in the code, and is tracked against §6 and §7 of this document.*
