# SheSafe — Hackathon Readiness Report

**Date:** 2026-10-08
**Version:** 2.0.0
**Baseline audited:** commit `ad3bf51` ("initial commit")
**Audit:** [`ARCHITECTURE_AUDIT.md`](ARCHITECTURE_AUDIT.md)

---

## 1. Current score

| Dimension | Before | After | Notes |
| --- | --- | --- | --- |
| SOS reliability & lifecycle | 2 / 10 | 9 / 10 | Deterministic server-side state machine, duplicate suppression, idempotent stand-down, full audit trail |
| Honesty of communication | 0 / 10 | 10 / 10 | Fabricated dispatch claims removed; capability manifest is the single source of truth |
| Authentication & authorisation | 0 / 10 | 9 / 10 | PBKDF2, signed sessions, CSRF, owner-scoped queries, rate limits. RBAC is the remaining gap |
| Privacy & data protection | 1 / 10 | 9 / 10 | Consent-gated throttled location, hashed expiring share tokens, coarsened logs, retention policy |
| Data layer | 2 / 10 | 9 / 10 | SQLite with schema, FKs, indexes, WAL, migrations, transactions |
| Safety Intelligence | 0 / 10 | 8 / 10 | Explainable rule engine with provenance and confidence. No trained model, by design |
| Live location | 3 / 10 | 9 / 10 | Real `watchPosition`, accuracy filtering, trails scoped to incidents, revocable links |
| Journey guard | 3 / 10 | 8 / 10 | Server-authoritative escalation ladder; honest about the background-monitoring limit |
| Community safety | 3 / 10 | 7 / 10 | Moderation states, dedupe guard, honesty labels. Moderation permission model is demo-grade |
| UI / UX | 4 / 10 | 8 / 10 | Mobile-first PWA, semantic HTML, a11y, calm/urgent visual language, honest empty/error states |
| Accessibility | 2 / 10 | 8 / 10 | Landmarks, focus management, live regions, no zoom suppression, 48 px targets |
| Observability | 1 / 10 | 8 / 10 | Structured JSON logs, request ids, durable audit table, privacy scrubbing |
| Testing | 0 / 10 | 9 / 10 | 160 pytest + 36 browser-contract checks |
| **Overall** | **~1.8 / 10** | **~8.6 / 10** | |

---

## 2. Major strengths

1. **Nothing about an emergency is fabricated.** The old build hardcoded
   `"112 / PCR Unit 07 Mobilized"` and told users police had been dispatched. There is no police integration, so the
   product now says so on every screen, and a test asserts the banned strings never appear in an API response.
2. **The SOS flow is genuinely deterministic.** One `POST` produces the incident, the anchor fix, the share link and
   the notification attempts — or an explicit error. No AI, no external API, no async job can delay or break it.
3. **Duplicate suppression.** A double tap or a retried request returns the existing incident and alerts nobody twice.
   This was a real double-notification risk in the old code.
4. **The safety score is auditable on screen.** Every feature shows its weight, points, plain-English reason and
   provenance. A judge can check the arithmetic live.
5. **Honest confidence.** Confidence is derived from *data coverage*, not model skill, and the UI says
   "Very low confidence — do not rely on this alone" when the inputs are thin. Confidence 0.09 is a feature.
6. **Real data, no fabrication.** OSRM gives genuine road geometry; OpenStreetMap gives genuine places. When Overpass
   is down, we show official helplines and a map-search link rather than inventing businesses — the single worst
   behaviour in the original build.
7. **Real security.** 12 CRITICAL and 14 HIGH findings closed, each with a regression test.
8. **Server-authoritative state.** A page refresh mid-emergency does not lose the incident; the lifecycle is
   re-evaluated on read.

---

## 3. Implemented features

### Core emergency
- [x] `IDLE → ARMING → COUNTDOWN → ACTIVE → ESCALATING → RESOLVED / CANCELLED` state machine
- [x] 10-second cancellation window with visible countdown
- [x] High-accuracy GPS acquisition with accuracy reporting; degrades honestly when a fix is unavailable
- [x] Human-readable incident reference (`SS-7GQ4KD`) plus an unguessable internal id
- [x] GPS accuracy, timestamp and last-seen displayed throughout
- [x] Durable incident timeline with actor and timestamp per transition
- [x] Duplicate suppression and idempotent stand-down
- [x] Server-authoritative state that survives a refresh
- [x] Direct `tel:112` action with an explicit note that SheSafe does not dispatch

### Live location
- [x] `watchPosition` gated behind explicit consent
- [x] Throttled (8 s), move-filtered (5 m), accuracy-filtered (≤200 m) transmission
- [x] 256-bit share tokens, **SHA-256 hashed at rest**, scoped, expiring, revocable
- [x] No user id in any share URL
- [x] Movement trail only while an incident is open; `includeTrail=false` supported
- [x] Stale-position detection with an explicit "not currently sending location" state
- [x] Guardian page showing position, accuracy, last update, incident status, trail and Call / Call 112
- [x] Masked phone number for guardians
- [x] One-tap revocation of one link or all links
- [x] SMS / WhatsApp / copy-link hand-off — labelled as user-initiated, never as sent by SheSafe

### Safety intelligence
- [x] Six weighted features summing to 100, each with reason and provenance
- [x] Bands LOW / MODERATE / HIGH / CRITICAL with correct boundaries (unit-tested)
- [x] Confidence from data coverage, with a plain-language label
- [x] Neutral priors for missing data + a caveat for each
- [x] Protective features (nearby help *reduces* risk) — a logic bug found and fixed during the rebuild
- [x] Community reports down-weighted by moderation state
- [x] `/safety-intelligence` screen with feature weighting, drivers, protective factors, caveats and provenance
- [x] `/api/intelligence/explain` publishes the engine's own description and limitations

### Safety navigation
- [x] Real OSRM road geometry with genuine alternatives
- [x] Every alternative safety-scored at 9 sample points along the corridor
- [x] FASTEST / SAFEST / BALANCED labels with the reasoning shown
- [x] Clear disclaimer that "safest" is a modelled estimate
- [x] Honest offline fallback (geometric corridors, labelled SIMULATED)

### Safe places
- [x] Real OpenStreetMap data mapped to seven safety categories
- [x] Distance, walking ETA, drive ETA, opening hours where tagged
- [x] `provenance` on every record; `verification: crowdsourced`
- [x] Navigate and call actions
- [x] Circuit breaker + server-side cache so a dead provider cannot make the app feel broken
- [x] Demo Mode synthetic dataset, badged `SIMULATED` on every record
- [x] Never invents a facility; falls back to official helplines

### Emergency contacts
- [x] name, relationship, phone, channels, primary, verified, active
- [x] Per-channel notification preferences
- [x] Self-confirmation with an explicit note that SheSafe cannot verify phone ownership
- [x] Owner-scoped CRUD; IDOR tested
- [x] Primary-contact uniqueness per account
- [x] Inactive contacts excluded from alerting

### Journey guard
- [x] `ON_JOURNEY → CHECK_IN_REQUIRED → WARNING → EMERGENCY` + `ARRIVED` / `CANCELLED`
- [x] Grace period before escalation
- [x] Escalation creates a **real SOS incident** with contact alerting
- [x] State machine re-evaluated on read, so a closed tab does not lose the escalation
- [x] Explicit disclosure that background monitoring is not possible in a browser

### Community safety
- [x] `COMMUNITY_REPORTED → UNDER_REVIEW → VERIFIED | DISMISSED | RESOLVED`
- [x] No code path lets a user submission become verified automatically
- [x] Verification requires confidence ≥ 0.5 **and** a moderator note
- [x] Anonymous option genuinely nulls the author id
- [x] One "helpful" signal per user, idempotent
- [x] Submission rate limit and state legend shown to users

### AI (used sparingly, deliberately)
- [x] Transparent keyword + heuristic incident classifier with unit tests
- [x] Category, severity, confidence, matched keywords, recommended actions
- [x] Optional LLM layer behind a provider interface, **disabled by default**
- [x] LLM failure, timeout or malformed output falls back to the deterministic baseline
- [x] Output validated against an allowlist; banned "help is on the way"-style claims cause rejection
- [x] **AI is structurally incapable of triggering or gating SOS** — no SOS code path imports the AI module
- [x] Factual incident summary generated from stored fields only (no generative claims)

### Voice SOS
- [x] Opt-in, explicit wake phrase, strict matching
- [x] Starts the **same** cancel countdown — never dispatches on its own
- [x] Shows the transcript so the user can see what was heard
- [x] Capability detection; hidden with an explanation where unsupported

### Privacy & security
- [x] PBKDF2-SHA256 (600k) password hashing
- [x] Signed `HttpOnly` `SameSite` session cookies; user re-read per request
- [x] CSRF double-submit on every write; origin guard
- [x] Owner-scoped queries everywhere
- [x] Rate limits: auth, SOS, location, write, read, external
- [x] Strict CSP with zero inline scripts; `nosniff`; `DENY` framing; referrer policy; permissions policy
- [x] 64 KB body cap; validation layer on every write; parameterised SQL only
- [x] Structured JSON logging with request ids
- [x] Durable audit log; coordinates coarsened to ~110 m before any write
- [x] No secrets in the repository; `.env.example` documents every variable; production requires an explicit secret
- [x] No `innerHTML` anywhere in the client data path

---

## 4. Real vs simulated

Read live from `GET /api/capabilities`. The UI renders from this and hardcodes nothing.

| Capability | Mode | Evidence |
| --- | --- | --- |
| SOS emergency flow | **REAL** | Server-authoritative, audited, no external dependency |
| Incident timeline & history | **REAL** | Durable `incident_events` table |
| Live location | **REAL** | `navigator.geolocation`, expiring revocable links |
| Share tokens | **REAL** | 256-bit, hashed at rest, tested for expiry/revocation |
| Road routing | **REAL** | OSRM public engine, verified live |
| Nearby places | **REAL** | OpenStreetMap Overpass (`crowdsourced`, not official) |
| Risk scoring | **REAL (rule-based)** | `RULE_BASED_V1`; explicitly not a trained model |
| Journey guard state machine | **REAL** | Server-authoritative |
| Authentication & sessions | **REAL** | Hashed passwords, signed cookies, CSRF, rate limits |
| Audit trail | **REAL** | Persistent table, privacy-scrubbed |
| **Police / ambulance dispatch** | **UNAVAILABLE** | Not implemented. The UI says so. Call 112 is a dialler action. |
| **Contact notifications** | **SIMULATED** without credentials | Recorded as SIMULATED in the UI and in the database. Twilio / MSG91 / FCM adapters activate when configured. |
| **AI incident guidance** | **SIMULATED** without credentials | Rule-based classifier is the default; an LLM can be configured but is advisory only |
| **Voice SOS** | **PARTIAL** | Requires `SpeechRecognition` + permission; always needs confirmation |
| **Web push** | **PARTIAL** | Requires a service worker and a configured FCM key |
| **Demo places dataset** | **SIMULATED** | Only in Demo Mode, badged on every record |

### Notification provider status vocabulary

| Status | Meaning |
| --- | --- |
| `sent` | A real provider returned success |
| `simulated` | No provider configured; recorded locally, labelled in the UI |
| `failed` | A provider was configured and rejected/errored |
| `unavailable` | No provider exists for this channel (e.g. the server cannot place a call) |
| `skipped` | The recipient opted out of this channel |

---

## 5. Security status

| Audit finding | Status | Regression test |
| --- | --- | --- |
| C-01/02/03 Fabricated police and contact dispatch | **FIXED** | `test_activate_returns_no_claim_of_police_dispatch`, `test_notification_status_is_simulated_without_credentials` |
| C-04 Plaintext passwords | **FIXED** | `test_signup_hashes_password_and_returns_user` |
| C-05 No authentication anywhere | **FIXED** | `test_protected_endpoints_require_authentication` |
| C-06 IDOR on contacts | **FIXED** | `test_contacts_are_owner_scoped`, `test_cannot_update_or_delete_another_users_contact` |
| C-07 Unauthenticated live location read | **FIXED** | `test_guardian_view_rejects_predicted_user_id_url` |
| C-08 Fabricated "nearby" businesses | **FIXED** | `test_places_endpoint_never_invents_data_when_provider_off` |
| C-09 Guardian view fabricates a position | **FIXED** | `test_stale_location_is_flagged` |
| C-10 Auth bypass by name substring | **FIXED** | `test_no_name_substring_auth_bypass`, `test_demo_bypass_is_absent` |
| C-11 API converts auth failures into successes | **FIXED** | jsdom: `sign-in` contract checks; no localStorage fallback exists |
| C-12 Real PII committed | **FIXED** | `backend/data/db.json` deleted, scrubbed from all of git history with `git-filter-repo`, `.gitignore` excludes the database, seed data uses reserved fiction numbers |
| H-01 Forgeable tokens | **FIXED** | `test_forged_session_cookie_rejected`, `test_tampered_signed_cookie_rejected` |
| H-02/H-03 Stored + DOM XSS | **FIXED** | `test_markup_is_rejected_at_validation`; zero `innerHTML` in the data path |
| H-04 Predictable share URLs | **FIXED** | `test_share_link_uses_high_entropy_token_and_no_user_id`, `test_only_token_hash_is_stored` |
| H-05 Path traversal | **FIXED** | allowlisted suffixes + containment check; verified `../backend/wsgi.py` → 404 |
| H-06 No rate limiting | **FIXED** | `test_rate_limit_blocks_after_threshold` |
| H-07 CORS `*` with credentials | **FIXED** | `test_cors_does_not_echo_untrusted_origin` |
| H-08 No security headers | **FIXED** | `test_security_headers_present` |
| H-09 Whole-file DB rewrite | **FIXED** | SQLite transactions with WAL |
| H-10 ID collisions from `Date.now()` | **FIXED** | UUID-based ids |
| H-11 Unbounded request bodies | **FIXED** | 64 KB cap; `test_oversized_body_rejected` |
| H-12 Continuous location by default | **FIXED** | consent gate, throttle, move + accuracy filters |
| H-13 Two divergent backends | **FIXED** | `server.cjs` is a deprecation shim |
| H-14 No tests | **FIXED** | 196 automated checks |

### Residual risks (honest list)

1. **Moderation is open to any signed-in user.** Acceptable for a demo, wrong for production. A `moderator` role is
   the obvious next step; the API response says so.
2. **In-process rate limiter.** Correct for a single instance; a multi-instance deployment needs Redis or the edge.
3. **No email/phone verification.** Anyone can sign up with someone else's number. Documented on the contact
   verification response.
4. **In-memory `:memory:` SQLite** is shared-cache; fine for dev and tests, not for production scale. Production
   should point `SHESAFE_DB` at a file.
5. **Overpass is a volunteer-run public service.** Unreliable by nature; handled with mirrors, a cache, a circuit
   breaker and an honest fallback.
6. **No per-field encryption at rest.** Share tokens are hashed; the rest is plaintext in a local SQLite file.
7. **No CSP nonce for the two CDN origins.** Leaflet and Google Fonts are allow-listed rather than self-hosted.

---

## 6. Testing status

```
$ npm run test          # 160 passed
$ npm run test:frontend # 36 passed
$ npm run test:all      # 196 passed
```

Coverage of the mandated list:

| Required test | Where |
| --- | --- |
| signup / login | `test_auth.py` |
| authorisation | `test_auth.py` (`test_protected_endpoints_require_authentication`) |
| SOS creation | `test_sos.py` |
| SOS cancellation | `test_sos.py` |
| duplicate SOS prevention | `test_sos.py` (`test_duplicate_sos_is_suppressed`, `test_duplicate_activate_does_not_double_alert`) |
| invalid location | `test_sos.py`, `test_location.py` |
| expired share token | `test_location.py` (`test_expired_token_rejected`) |
| unauthorised live-location access | `test_location.py` (3 tests) |
| emergency-contact CRUD | `test_contacts.py` |
| incident submission | `test_journeys_reports.py` |
| journey escalation | `test_journeys_reports.py` |
| API validation | `test_api_and_e2e.py` |
| **E2E: LOGIN → DASHBOARD → SOS → LOCATION → ALERT → LIVE TRACKING → CANCEL** | `test_end_to_end_login_dashboard_sos_location_alert_tracking_cancel` |
| Browser contract for the same journey | `tests/frontend/smoke.mjs` |

Notable: the browser-contract test found four real defects during development — a `LocationManager` getter/setter
collision, missing `data-view` attributes that left the router unable to show any view, a stale-route read in the view
loader, and a boot-error handler that wiped the app shell.

---

## 7. Judge demo flow — 4 minutes

**Before the demo**

```bash
SHESAFE_DEMO_MODE=1 python3 backend/wsgi.py
```

Open two browser windows. Demo ribbon visible. Sign in as `demo@shesafe.local` / `shesafe-demo`.
Grant location permission when prompted.

### Script

| # | Action | Say this |
| --- | --- | --- |
| 1 | **Sign in** (15 s) | "One click. Notice the session is a signed HttpOnly cookie, and CSRF is enforced on every write." |
| 2 | **Dashboard** (20 s) | "One thumb does the important thing. SOS is the largest target. Everything else is secondary." |
| 3 | **Press SOS** (45 s) | "Ten seconds to cancel — because a false alarm must cost nothing. Now it acquires GPS and reports *accuracy*." |
| 4 | **Read the alert card** (20 s) | "Look here: **Delivered 0 · Simulated 2 · Unavailable 1.** No credentials are configured, so we say SIMULATED, not *sent*. Our server can never place a phone call, so `call` is UNAVAILABLE." |
| 5 | **Open the live link** in window 2 (35 s) | "Guardian view. 256-bit token, hashed at rest, expires automatically. Revoke it and window 2 goes dark instantly." |
| 6 | **Stand down** (20 s) | "Resolve. The record keeps the full timeline: ARMING → COUNTDOWN → ACTIVE → RESOLVED." |
| 7 | **Safety intelligence** (40 s) | "Explainable risk. Six weighted features, each showing its points and where the data came from. Confidence is 9% because we have thin data — and we say so rather than pretending." |
| 8 | **Safe routes** (35 s) | "Real OSRM geometry, three alternatives, each safety-scored at nine points along the corridor. Fastest is 6.7 min; the alternative is longer." |
| 9 | **Journey guard** (30 s) | "Start a one-minute journey. Miss the check-in and it escalates into a *real* SOS incident." |
| 10 | **Privacy & security** (25 s) | "Location is off until consent, throttled and accuracy-filtered. Share tokens are hashed at rest. The audit log stores coordinates at 110 m precision — useless to a stalker." |
| 11 | **Close on the caveat** (15 s) | "We do not contact police. Call 112 opens your dialler. Anything else would be a lie." |

### Anticipated questions

| Question | Answer |
| --- | --- |
| "Is it connected to 112?" | No, and we don't claim it is. No Indian service offers a public API. The button dials on your device. |
| "How accurate is the risk score?" | We don't know, and we don't claim. It's a transparent weighted rule set with no training data. Here's the arithmetic. |
| "Does it work without internet?" | The dashboard, SOS button and helplines work — the service worker caches the shell and never caches API responses, because a stale SOS record is worse than an error. |
| "What's your tech stack?" | Flask + SQLite, zero runtime dependencies. Vanilla ES modules + Leaflet on the front, no build step. |
| "How is this different?" | It doesn't lie. Most demos of this genre show a fake dispatch screen; this one shows the delivery status of each alert and refuses to invent data when a provider is down. |

---

## 8. Security & privacy talking points for the pitch

1. **Location is off until you switch it on.** The audited build started `watchPosition` on page load, before login.
2. **The browser cannot help while you are asleep.** Journey Guard and live tracking say so on-screen instead of
   implying background monitoring.
3. **Share links are the attack surface**, so they are 256-bit, hashed, expiring and revocable — with a test that
   proves a guessed `?user=` URL is meaningless.
4. **Community reports are never facts.** They are labelled, down-weighted, and cannot reach `VERIFIED` without a
   human note and a confidence value.
5. **The audit log is privacy-safe by construction.** Coordinates are coarsened before the write, and a test asserts
   the precise value never appears.

---

## 9. Future improvements

**P0 — before any real deployment**
1. Moderator role and a real moderation queue (currently any signed-in user can moderate).
2. Email / phone ownership verification for contacts (confirmation code, not a self-checked box).
3. `SHESAFE_DB` on a managed volume + WAL backups; a migration path to Postgres.
4. Redis-backed rate limiting for multi-instance deployment.
5. Real notification credentials wired through the existing provider registry — this is a config change, not a
   code change.

**P1 — safety depth**
6. Journey Guard via **Web Push + a background sync**, so escalation can fire while the tab is closed. This is the
   single biggest real-world gap.
7. Native wrapper (Capacitor) so SOS can lock the screen and hold the microphone in the background.
8. Incident history export as a sealed record (useful for a police report or a lawyer).
9. Guardian accounts with a proper invitation flow, instead of an opaque link.

**P2 — intelligence**
10. Per-city historical incident data with a **published, documented** training pipeline and a real, measured
    accuracy figure — only once such a dataset legally and ethically exists.
11. Street-lighting and CCTV density from OpenStreetMap tags, currently absent and honestly reported as absent.
12. Learned routing that optimises for the modelled risk surface rather than a fixed rule set, keeping the
    explainability contract.

**P3 — reach**
13. Regional helplines beyond India (the numbers in `OFFICIAL_HELPLINES` are India-specific).
14. Offline-first SOS outbox with an on-device copy of emergency contacts and numbers.
15. Multi-language UI, starting with the languages of the user base.
16. Accessibility audit with real assistive technology and users, not just a checklist.

---

*SheSafe does not contact emergency services. In an emergency, call 112.*