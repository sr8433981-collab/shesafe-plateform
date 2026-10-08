# SheSafe — Architecture & Security Audit

**Auditor:** Lead architecture review (pre-remediation)
**Repository:** `sr8433981-collab/women_safety`
**Commit audited:** `ad3bf51` ("initial commit")
**Date:** 2026-10-08
**Scope:** `backend/` (`app.py`, `server.js`, `data/db.json`), `frontend/` (`index.html`, `track.html`, `css/style.css`, `js/*.js`), `package.json`, `backend/requirements.txt`, `run.bat`, `README.md`

> Audit-first rule honoured: **no code was modified until this document was completed.**

---

## 0. Executive summary

SheSafe is a competent single-page prototype with a genuinely good *surface*: an SOS button, live GPS streaming via `watchPosition`, an emergency-contact directory, community alerts, and a journey timer. Underneath, however, it is a **demo, not a system**.

The three things that matter most for a safety product are — **is the alert real, is the data private, and does it work when the network is broken**. In the audited code:

| Question | Audited answer |
| --- | --- |
| Is the emergency dispatch real? | **No.** The string `"112 / PCR Unit 07 Mobilized"` is hardcoded. No SMS, WhatsApp, push or police integration exists. |
| Is authentication real? | **No.** Passwords are plaintext, tokens are the literal string `token_shesafe_<userId>`, and any request containing `sweta` logs you in as user #1. |
| Are emergency contacts private? | **No.** `GET /api/contacts` returns *every user in the database*, including phone numbers, with no authentication and no ownership filter. |
| Are the "safe places" real? | **Mostly not.** If a seed facility is >30 km away the server **silently invents a new coordinate near the user** and presents it as a real place with a real-looking phone number. |
| Is the live-tracking link private? | **No.** It is `?user=usr_sweta_01` — a guessable, permanent, non-expiring, non-revocable URL with no token. |
| Does it survive an offline network? | **Partially**, and dangerously. `api.js` catches *any* error — including a legitimate `401` — and silently falls back to `localStorage` while reporting `success: true`. |

The single most damaging class of defect is **fabricated dispatch**. The UI asserts to a frightened user *"🚨 EMERGENCY ALERT DISPATCHED: Police Control Room and all Emergency Contacts notified"* when nothing was dispatched. In a real deployment this is not a UX bug; it is a safety failure and a potential liability.

### Findings summary

| Severity | Count | Theme |
| --- | --- | --- |
| **CRITICAL** | 12 | Fabricated dispatch, no auth, plaintext passwords, public PII endpoints, IDOR, fabrication of facility data |
| **HIGH** | 14 | Session forgery, XSS, predictable share URLs, path traversal, no rate limiting, duplicate backend, no tests |
| **MEDIUM** | 17 | No database, no validation, no observability, no a11y, missing app lifecycle, hardcoded PII |
| **LOW** | 13 | Duplicated code, dead CSS, emoji-only iconography, README drift, Windows-only launcher |

---

## 1. Current architecture

```
browser (frontend/index.html — one 988-line HTML file, 6 <section> "views")
  ├── js/main.js      view router (class toggling), drawer, modals, toasts
  ├── js/auth.js      login/signup/localStorage session
  ├── js/api.js       fetch wrapper + 190-line localStorage "offline" reimplementation of the API
  ├── js/sos.js       Web Audio siren + fake 4-step dispatch animation
  ├── js/map.js       Leaflet, watchPosition, reverse geocoding (Nominatim), share link
  └── js/features.js  helplines, contacts, check-in, journey timer, community feed
            │  fetch (no credentials, no auth header, no CSRF)
            ▼
backend/server.js  (Node, 598 lines, ZERO dependencies, hand-rolled http server)
backend/app.py     (Flask, 391 lines, hand-rolled routes)
            ▼
backend/data/db.json  (single JSON file, rewritten in full on every write)
```

### 1.1 Key architectural facts

1. **Two complete backends, byte-for-byte duplicates.** `server.js` and `app.py` implement the *same* 12 endpoints with the *same* logic and the *same* bugs. Every fix must be written twice and will inevitably diverge. They are also inconsistent (`app.py` imports `math` inside a function; `server.js` puts `global.liveLocations` behind an `if`; `server.js` has a `/api/auth/profile` route that `app.py` lacks).
2. **`package.json` lists `express` and `cors` as dependencies but `server.js` never `require`s them.** The declared dependencies are dead weight; `node_modules/` is installed but unused. `npm start` works only because it happens to need nothing.
3. **No database.** All persistence is `json.load` → mutate → `json.dump` of the entire file, on the event loop, with no locking. Two concurrent SOS triggers will lose one write. There are no indexes, no foreign keys, no migrations, and no transactions.
4. **No middleware stack at all.** No error handler, no request logging, no auth middleware, no rate limiting, no validation layer, no security headers, no CORS allowlist.
5. **The frontend is not a component system.** Views are `<section>`s toggled with `.active`; every list is an `innerHTML` string template; state lives in module-level mutable singletons (`SheSafeSOS.isActive`, `SheSafeMap.userCoord`).

### 1.2 API contract as audited

| Method | Path | Auth | Validation | Notes |
| --- | --- | --- | --- | --- |
| GET | `/api/health` | none | n/a | ok |
| POST | `/api/auth/login` | n/a | none | plaintext compare; substring name match; demo bypass |
| POST | `/api/auth/signup` | n/a | presence only | no password strength, no email format, ID from `timestamp` |
| PUT | `/api/auth/profile` | **none** | none | Node only; mass-assignment over `body` |
| GET | `/api/emergency-numbers` | none | n/a | static |
| GET | `/api/contacts` | none | n/a | **returns all users' contacts** |
| POST | `/api/contacts` | none | presence only | trusts `body.userId`; sets `isPrimary=false` on *every* contact globally |
| DELETE | `/api/contacts/<id>` | none | n/a | deletes any contact by id |
| POST | `/api/location/update` | none | none | accepts any `userId`; unbounded payload |
| GET | `/api/location/live[/<userId>]` | none | n/a | unauthenticated precise location, any user |
| GET | `/api/safe-zones?lat&lng` | none | `float()` only | **fabricates coordinates** |
| POST | `/api/sos/trigger` | none | none | hardcoded dispatch text; ID collision risk |
| POST | `/api/sos/cancel` | none | none | cancels *all* active SOS globally; no idempotency |
| GET/POST | `/api/checkins` | none | none | trusts `userId` |
| GET/POST | `/api/community-alerts` | none | none | trusts everything; `verified` hardcoded `false` but frontend badge reads it |
| GET/POST | `/api/incidents` | none | none | trusts everything |

### 1.3 SOS lifecycle as audited

```
press SOS ──► setTimeout(400ms)  "emergency alert prepared"    ✓ (UI only)
           ──► setTimeout(900ms)  "current location captured"  ✓ (real GPS if permitted)
           ──► setTimeout(1500ms) "emergency contacts notified"✓ (NOTHING SENT)
           ──► setTimeout(2100ms) "help request initiated"     ✓ (NO POLICE CONTACT)
```

There is **no lifecycle**. There is no `ARMING`, no cancel-countdown, no escalation, no incident ID, no state machine, no duplicate prevention, no audit trail, and no distinction between "sent" and "recorded". The checklist is a timed animation that is *guaranteed* to show four green ticks regardless of network state.

### 1.4 Location & live sharing as audited

* `watchPosition({enableHighAccuracy:true})` runs **continuously from page load, before login**, whether or not the user has enabled sharing (`isSharingLive` defaults to `true`).
* Every position update is pushed to `POST /api/location/update` **and** written to `localStorage`, with no throttling, no move threshold and no de-duplication — i.e. precise location is stored and transmitted continuously by default.
* Reverse geocoding calls `nominatim.openstreetmap.org` on **every single GPS fix** with no debounce and no caching. Nominatim's usage policy forbids heavy use; this will get the app IP-blocked during a live demo.
* `routeTrail.push(...)` grows **without bound** for the life of the page.
* Share URL is `track.html?user=<userId>` — predictable, permanent, non-revocable.
* `track.html` polls `/api/location/live/<userId>` every 3 s and falls back to a **hardcoded default location (Connaught Place) if the user has no data**, presented to the guardian as the live position with "LIVE STREAM ACTIVE" in the header. A guardian could act on a fabricated position.
* Battery is read from `navigator.getBattery()` and broadcast to contacts — but on desktop it is simply `95` (hardcoded).

### 1.5 Offline behaviour as audited

`api.js:202` wraps every call in `try/catch` and, on **any** throw — including an HTTP `401`, `403`, `422`, `429` or `500` — calls `localFallback()`:

```js
const response = await fetch(...);
if (response.ok) return await response.json();
const errData = await response.json().catch(() => null);
throw new Error(errData?.message || `HTTP error ${response.status}`);
} catch (err) { return localFallback(endpoint, method, body); }
```

Consequences:
* An expired/invalid credential produces a **successful local login as `store.users[0]`**.
* A rate-limited or server-erroring `POST /sos/trigger` silently returns a canned *"SOS Alert dispatched"* string.
* `localFallback('/sos/trigger')` **does not persist anything**, so SOS records are lost during a network blip.
* `localFallback` reproduces the same endpoint logic in the browser, i.e. **two divergent implementations of the business rules**, one of which is client-editable by the end user.

This "offline mode" is not resilience — it is a silent failure mode that lies about success.

### 1.6 What is REAL (worth preserving)

Credit where due; these are genuine and should survive the refactor:

1. `navigator.geolocation.watchPosition` with `enableHighAccuracy` — real GPS streaming (`map.js:128`).
2. Web Audio siren — a real, dependency-free `sawtooth` + LFO siren (`sos.js:53`).
3. `navigator.vibrate` / `navigator.getBattery` — real device telemetry.
4. Leaflet + OSM raster tiles — real map.
5. Nominatim reverse geocoding — real, if misused (no debounce/cache/policy compliance).
6. `tel:` / `sms:` / `wa.me` deep links — real user-side actions that the browser *can* perform.
7. Haversine distance maths — correct in both backends.
8. Official Indian helpline directory (112/181/100/108/101/1091/1098/1930) — real, publicly-published numbers.
9. The 4-view information architecture (Auth → Dashboard → Detail views + Guardian tracking page) — sound.

---

## 2. Findings

### CRITICAL

| # | Finding | Location | Impact |
| --- | --- | --- | --- |
| C-01 | **Fabricated police dispatch.** `"policeHelpline": "112 / PCR Unit 07 Mobilized"` is a hardcoded string; no API, SMS or integration of any kind exists. | `server.js:430`, `app.py:285` | A user in real danger is told police were dispatched. Legal + ethical failure. |
| C-02 | **Fabricated contact notification.** `"smsDispatchedTo": [...]` is populated from the local DB with zero delivery. | `server.js:431`, `app.py:286` | Contacts never learn of the emergency. |
| C-03 | **Fabricated success to the user.** `"🚨 EMERGENCY ALERT DISPATCHED: Police Control Room and all Emergency Contacts notified"`. | `server.js:442`, `app.py:295`, `sos.js:184` | Direct, explicit lie in the UI. |
| C-04 | **Plaintext passwords** stored in a committed JSON file. | `db.json:8`, `server.js:125`, `app.py:46` | Full account compromise on any repo/host leak. |
| C-05 | **No authentication on any endpoint.** Every route is public. | `server.js` (all), `app.py` (all) | Anyone can trigger/cancel SOS, read/write contacts, read live location. |
| C-06 | **IDOR / mass data disclosure.** `GET /api/contacts` returns contacts of *all* users; `POST` trusts `body.userId`; `DELETE /api/contacts/<id>` deletes any contact. | `server.js:231-269`, `app.py:130-167` | Leaks third-party phone numbers; deletes other users' guardians. |
| C-07 | **Unauthenticated live-location read.** `/api/location/live/<userId>` returns precise coordinates to anyone who can guess an ID. | `server.js:304`, `app.py:191` | Stalking-enabling surveillance of a victim. |
| C-08 | **Fabricated "nearby" businesses.** If a seed POI is >30 km from the user the server invents coordinates `user ± 0.0075°` and keeps the fake name/phone. | `server.js:351-366`, `app.py:231-241` | In a real emergency a user is sent to a pharmacy that does not exist. |
| C-09 | **Guardian view fabricates a live position.** When no data exists, `track.html` renders a hardcoded Connaught Place coordinate under a "LIVE STREAM ACTIVE" header. | `track.html:314-323` | A guardian dispatches responders to the wrong place. |
| C-10 | **Authentication bypass by substring.** `identifier in u['name'].lower()` plus `'sweta' in identifier or identifier == 'demo'` → any login string containing `sweta`, with **any or no password**, returns user #1. | `server.js:124-137`, `app.py:46-64` | Complete authentication bypass, unauthenticated. |
| C-11 | **`api.js` converts auth failures into successes.** 401/403/5xx fall through to `localFallback`, which returns `success: true`. | `api.js:217-224`, `231-243` | Client-side authentication is meaningless; fails open on every error. |
| C-12 | **Hardcoded personal data of real individuals committed to Git.** Real-looking names and Indian mobile numbers (three 10-digit numbers beginning `+91 9…`, masked here) in `db.json`, and again in the browser bundle `api.js:26-56`. | `db.json:5,50,73`, `api.js:16,32,39,46` | PII exposure; also violates rule 9 of the project brief. |

### HIGH

| # | Finding | Location |
| --- | --- | --- |
| H-01 | **Forged tokens.** `token = "token_shesafe_" + user.id` — derivable by anyone who knows the user id; never validated anywhere. | `server.js:136,149`, `app.py:53,121` |
| H-02 | **Stored XSS.** ~40 `innerHTML` templates interpolate server/user data unescaped (`api.js` and `features.js` are the worst: `${c.name}`, `${ca.title}`, `${ca.description}` into `innerHTML`). | `features.js:195-210`, `389-408`; `map.js:404-424` |
| H-03 | **DOM XSS via `onclick` interpolation.** `onclick="SheSafeFeatures.deleteContact('${c.id}')"` — a contact name containing `'` breaks out. | `features.js:202-206` |
| H-04 | **Predictable, permanent share URLs.** `track.html?user=usr_sweta_01`. No token, no expiry, no revocation. | `map.js:462` |
| H-05 | **Path traversal in the Flask static handler.** `os.path.join(FRONTEND_DIR, path)` with no containment check. (The Node version *does* normalise — inconsistency.) | `app.py:380-385` |
| H-06 | **No rate limiting anywhere.** Login, signup, SOS and location endpoints are trivially brute-forceable / abusable. | all backends |
| H-07 | **CORS `*` with credentials allowed by reflex.** `CORS(app)` and `'Access-Control-Allow-Origin': '*'`. | `app.py:17`, `server.js:82` |
| H-08 | **No security headers.** No CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`. | all |
| H-09 | **Whole-DB rewrite per write, no locking.** Concurrent writes lose data; a crash mid-`dump` corrupts `db.json` (already git-dirty). | `server.js:33-41`, `app.py:25-26` |
| H-10 | **ID collisions from `Date.now()`.** Two users signing up or two SOS in the same millisecond share an ID; `cancel_sos` mutates *every* matching SOS. | `server.js:146,169,282` |
| H-11 | **Unbounded request bodies.** `getRequestBody` accumulates `body += chunk` with no size cap → trivial memory-exhaustion DoS. | `server.js:44-49` |
| H-12 | **Continuous precise-location storage/transmission by default**, before login, with no throttle and no user opt-in. | `map.js:27,128,206` |
| H-13 | **Two divergent backends.** Every fix is duplicated; they already disagree. | `server.js` vs `app.py` |
| H-14 | **Zero tests.** No `test/`, no CI, no linting, no type checking. | repo |

### MEDIUM

| # | Finding |
| --- | --- |
| M-01 | No input validation layer; no schema; no length limits; no enum validation (`severity`, `status`, `type` are free text). |
| M-02 | No centralized error handling — raw `500`s, stack traces in dev, inconsistent `{success, message}` envelope, `PUT` in Flask route not supported while Node has it. |
| M-03 | No structured logging. `console.log`/`print` only; no request IDs; no audit trail for SOS or auth events. |
| M-04 | Journey timer has **no escalation states** — no "are you safe?" prompt wired to SOS, no warning phase, purely client-side `setInterval` that dies with the tab. `index.html:594` references an element ID (`btnImSafeCheckInTimer`) that has no handler binding. |
| M-05 | "Auto-alerts contacts if not checked in" (`index.html:344`) is **false** — nothing is sent. |
| M-06 | Location status pill says "GPS Active" (`index.html:49`) regardless of whether a fix ever succeeded. |
| M-07 | Settings modal is decorative: five checkboxes with no `id`, no persistence, no effect on anything (`index.html:938-972`). |
| M-08 | "Dispatch SMS with Map Pin" setting and siren toggles are not wired to real behaviour. |
| M-09 | **Accessibility:** `maximum-scale=1.0, user-scalable=no` disables pinch-zoom (WCAG 1.4.4 violation) on both pages; `<section>` "views" have no `aria-*`; modals have no `role="dialog"`, no focus trap, no `Esc`; the drawer has no focus management; nav is `<a href="#">` with no `href` semantics; live regions absent for SOS state; emoji used as the sole icon; colour-only severity encoding; `outline: none` globally removes focus rings. |
| M-10 | **No `<main>/<nav>/<header>` landmark discipline**, no skip link, no `aria-current`, no accessible names on icon buttons. |
| M-11 | `track.html` has ~175 lines of inline `<style>` and ~115 lines of inline `<script>` — blocks any strict CSP. |
| M-12 | `index.html` has 6+ inline `onclick` handlers — same problem. |
| M-13 | Community alerts badge logic is inverted relative to the label: `verified:false` renders "⚠️ Community Reported" (correct) but seeded alerts claim `verified: true` with no moderation path at all — anyone can post. |
| M-14 | No moderation, rate limiting, duplication detection or reporting on community posts. |
| M-15 | Nominatim called on **every** GPS fix (no debounce/cache) → violates OSM usage policy; will fail live. |
| M-16 | `routeTrail` grows unbounded; `accuracyCircle` never removed. |
| M-17 | No `.gitignore` — `node_modules/`, `.venv/` and a dirty `db.json` are all committable. |
| M-18 | No PWA, no service worker, no offline shell, no installability. |
| M-19 | No `/safety-intelligence`, no risk scoring, no route scoring, no explainability — the "intelligent" differentiator does not exist. |
| M-20 | `run.bat` is Windows-only; `README` documents three "Options" that are really one app plus a broken standalone mode. |

### LOW

| # | Finding |
| --- | --- |
| L-01 | `package.json` declares `express`/`cors` that are never imported (dead dependency; rule 11 violation). |
| L-02 | `backend/requirements.txt` pins `flask>=2.0.0` while the venv has 3.1.3 — unbounded upper bound. |
| L-03 | `app.py:247` computes IST as `utcnow().hour + 5.5`; `server.js:375` uses server-local time. Two different "night" answers. |
| L-04 | `app.py:252` sorts on `x.get('isOpen247', False)` — present in `db.json` but absent from the `api.js` seed, so behaviour differs offline vs online. |
| L-05 | Duplicated haversine implementation in 3 places (`app.py`, `server.js`, `api.js`). |
| L-06 | Duplicated haversine + route logic in `features.loadSafeZonesList` and `map.renderSafeZonesUI` write to the *same* `#safePlacesList` node — the dashboard view and the safe-zones view race. |
| L-07 | Dead CSS: large unused blocks plus a fully commented-out `.sos-countdown-*` section (a countdown was designed and never implemented). |
| L-08 | Emoji-only iconography with no `aria-hidden` and no text alternative. |
| L-09 | `toast.innerHTML` interpolates `message`, which contains user-controlled strings. |
| L-10 | `rememberMe` checkbox is read by nobody. |
| L-11 | `linkForgotPw` opens `alert()` revealing demo credentials. |
| L-12 | README claims "every single feature works 100% offline" — false (SOS/check-in are lost server-side; share links break; guardian view shows fake data). |
| L-13 | `db.json` carries 8 historical SOS records and 3 real user accounts into any fresh clone. |

---

## 3. Technology & stack assessment

| Concern | Verdict |
| --- | --- |
| **Do not migrate for fashion.** | Agreed. Flask + vanilla JS + Leaflet + SQLite is a *better* fit than a SPA framework rewrite for a 4-hour demo, and migration risk would be catastrophic. **Stack is retained.** |
| **PostgreSQL/Supabase** | **Not practical here.** It would require a hosted account/credentials the team does not have, break the "runnable after every change" rule, and buy nothing for a local demo. Replaced with **SQLite (stdlib)**: relational schema, foreign keys, indexes, transactions, migrations, single-file portability — production-*style* behaviour without an external dependency. The repository layer is deliberately SQL-portable so Postgres is a config change later. |
| **Two backends** | Resolved. Flask becomes the single canonical API (it already has the richer dependency stack and is what the Python launcher prefers). `server.js` becomes an explicit, documented deprecation shim that delegates — no third implementation of business logic. |
| **New runtime dependencies** | **Zero.** `Flask` + stdlib only. `pytest` is added as a **dev-only** dependency for the test suite. Everything else (hashing via `werkzeug`, sessions via `itsdangerous`, SQLite via `sqlite3`) already ships with Flask/CPython. |

---

## 4. Remediation plan (this is the contract for Phases 2–18)

### P0 — Security + architecture + SOS reliability
1. Rebuild the backend as an **application-factory Flask package** with blueprints, a repository layer and a **SQLite** schema (users, contacts, sessions, incidents, sos_incidents, sos_events, location_samples, share_tokens, journeys, journey_events, community_reports, notification_attempts, audit_log, cached_pois).
2. **Passwords** → `werkzeug.security.generate_password_hash`; login by email/phone only (no substring match); generic error messages; per-account + per-IP rate limits.
3. **Sessions** → signed `HttpOnly`, `SameSite=Lax` cookie; all data endpoints require `login_required`; every query is owner-scoped → kills C-06/C-07.
4. **CSRF** double-submit token on all state-changing requests; **CORS** strict allowlist; **security headers** (CSP, HSTS, `nosniff`, `frame-ancestors`, `Referrer-Policy`); body-size cap; `debug=False`.
5. **Centralized error handling** with a single JSON envelope and safe, non-leaking messages.
6. **Structured JSON logging** + `request_id` propagation + a durable `audit_log` for auth/SOS/share/notification events; never log precise coordinates.
7. **SOS lifecycle**: `IDLE → ARMING → COUNTDOWN → ACTIVE → ESCALATING → RESOLVED | CANCELLED`, server-authoritative, duplicate-prevented, idempotent cancel, full event timeline, honest notification outcomes.

### P1 — Live location + contacts + notification abstraction
8. `watchPosition` gated on explicit consent + `enableHighAccuracy` with **throttling, move-threshold and accuracy filtering**; **ephemeral in-memory "last known"** instead of unbounded history; a bounded trail only when an incident is open.
9. **Share tokens**: `secrets.token_urlsafe(32)`, **SHA-256 at rest**, absolute expiry, explicit revocation, per-incident scope, no user id in the URL.
10. **Notification provider registry** (`sms`, `whatsapp`, `call`, `push`) with a `SimulatedProvider` that is *honestly labelled* and a real provider adapter (Twilio/MSG91/Firebase) that activates only when credentials exist. Every attempt is persisted with `status ∈ {sent, simulated, failed, unavailable}` — the UI renders those words.

### P2 — Safety intelligence + safe route + safe places
11. **Rule-based, explainable risk engine** (weighted features: time-of-day, incident density, safety-infrastructure proximity, community reports, route characteristics) → 0–100 with `LOW/MODERATE/HIGH/CRITICAL`, per-feature contributions, **confidence** based on data availability, and explicit `provenance`. Labelled "rule-based baseline, not a trained ML model."
12. **Safe Route** via the public **OSRM** routing API (real road geometry, duration, distance) with **alternative-route variants**, each safety-scored, then labelled fastest/safest/balanced. Offline geometric fallback, explicitly `SIMULATED`.
13. **Safe Places** via **OpenStreetMap Overpass** (real POIs, mirror fallback, server-side cache) mapped to safety categories, with honest distance/ETA computed from the user's real fix, and `verified: false` unless corroborated. Offline: official helplines + deep links, **never invented businesses**.

### P3 — Journey Guard + community reporting
14. Server-authoritative journey with `ON_JOURNEY → CHECK_IN_REQUIRED → WARNING → EMERGENCY`, grace periods, escalation, and a truthful statement that browser background monitoring is not available.
15. Community reports with `COMMUNITY_REPORTED → UNDER_REVIEW → VERIFIED | DISMISSED`, moderation queue, dedup/rate limits, and no path by which a user submission becomes "verified" automatically.

### P4 — AI + voice
16. **Incident classification / summarisation / guidance** behind a provider interface that is **disabled unless configured**, with a transparent **deterministic keyword+heuristic baseline** as the default so the feature always works offline. AI output is advisory, explicitly non-authoritative, and **structurally cannot gate SOS**.
17. **Voice SOS**: opt-in, explicit wake phrase, **always** requires a confirmation step, never silently dispatches, fully disable-able, degrades gracefully without `SpeechRecognition`.

### P5–P6 — UI/UX, PWA, a11y, tests, docs
18. Semantic HTML shell, hash router, ES modules, design-token CSS, accessible landmarks/focus/`aria-live`, **no `user-scalable=no`**, PWA manifest + service worker, loading/empty/error states, calm-when-safe / urgent-when-active visual language.
19. **Demo Mode**: server-flagged, every simulated surface badges `DEMO / SIMULATED`, plus a scripted 3–5 minute judge flow.
20. **Test suite** covering the full list in Phase 17, including an end-to-end `LOGIN → DASHBOARD → SOS → LOCATION → ALERT → LIVE TRACKING → CANCEL` flow.

---

## 5. Non-negotiable rules → how this audit enforces them

| Rule | Enforcement mechanism in the new system |
| --- | --- |
| 4. No fabricated notifications | `notifications.dispatch()` returns a **status** per recipient; `simulatedDispatch` field is **deleted**. UI text is generated from the status. |
| 5. No fabricated police integration | No such claim exists anywhere. The UI shows `tel:112` as a **user-initiated dial action** and states plainly that SheSafe does not dispatch. |
| 6. No fabricated ML accuracy | Scores are labelled `RULE_BASED_V1`; `confidence` is derived from **data coverage**, not model skill. No accuracy metric is printed. |
| 7. No fake statistics | Every number carries `source` + `provenance`; un-sourced numbers are omitted rather than invented. |
| 10. No claims browsers can't honour | Journey Guard states it needs the app open; live tracking states it stops when the tab closes; voice states it needs `SpeechRecognition` + permission. |
| 13. Clear Demo Mode | Server flag `DEMO_MODE`, surfaced in `/api/health`, rendered as a persistent `DEMO` ribbon. |

---

*Audit complete. Remediation begins in `docs/HACKATHON_READINESS.md`.*