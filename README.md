# 🛡️ SheSafe — Personal Safety & Emergency Response Platform

> **A production-shaped safety platform: a deterministic SOS engine, live location sharing with expiring
> revocable links, an explainable safety-scoring engine, safe routing, and a demo mode that labels every
> simulated thing it does.**

---

## 30-second summary for judges

| | |
| --- | --- |
| **Problem** | In a real emergency, a woman needs to alert someone *and* give them her location — in seconds, without fumbling. |
| **Why it matters** | SheSafe's core flow is optimised for one thumb and three seconds of panic. |
| **How it works** | Deterministic SOS lifecycle → anchor GPS fix → contact alerts on their configured channels → expiring live-tracking link → safe stand-down. |
| **What's unique** | A **Safety Intelligence** layer that scores risk with weighted, auditable rules and shows its own weights, confidence and provenance. |
| **Why it's credible** | 196 automated tests. Every integration reports `real` / `simulated` / `unavailable` from a server-side capability manifest. **SheSafe never claims to have contacted police.** |

> **In an emergency, call 112.** SheSafe does not dispatch emergency services. The Call 112 button opens your phone's dialler — *you* place the call.

---

## Quick start

Requires **Python 3.10+**. Nothing else. There are no runtime npm dependencies.

```bash
# macOS / Linux
./run.sh

# Windows
run.bat

# or manually
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements.txt
python3 backend/wsgi.py
```

Open **http://localhost:5000**.

First run creates the database and a demo account:

| Field | Value |
| --- | --- |
| Email | `demo@shesafe.local` |
| Password | `shesafe-demo` |

Or create your own account — it takes about twenty seconds.

### Demo mode

```bash
SHESAFE_DEMO_MODE=1 python3 backend/wsgi.py
```

Adds a persistent `DEMO MODE` ribbon and lets nearby places fall back to a clearly-labelled synthetic dataset so a
presentation never dead-ends without internet. **Every simulated surface is badged `SIMULATED`.** When the flag is
off, `/api/demo/*` returns 404 — you cannot reach demo mode by accident.

### Tests

```bash
pip install -r backend/requirements-dev.txt
npm install                 # only for the frontend contract test (jsdom)

npm run test                # 160 API / security / intelligence tests
npm run test:frontend       # 36 browser-contract checks (jsdom, real server)
npm run test:all            # both
```

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  PWA (vanilla ES modules, no framework, no build step)                    │
│                                                                          │
│  index.html ─ app.js ─┬─ core/   api · store · router · location ·        │
│  track.html ─ track.js┤          mapkit · dom · feedback                 │
│                       └─ modules/ sos · sharing · intelligence ·          │
│                                 places · journey · contacts ·            │
│                                 reports · voice                           │
│  service worker: app shell only — never caches /api/*                     │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │  fetch + JSON, CSRF double-submit header
                               │  (no token in localStorage, no innerHTML)
┌──────────────────────────────▼───────────────────────────────────────────┐
│  Flask application factory (backend/app)                                │
│                                                                          │
│   security ── PBKDF2 passwords · signed session cookies · CSRF ·         │
│               rate limits · origin guard · security headers             │
│   errors   ── single JSON envelope, safe messages, request ids           │
│   logging  ── structured JSON stdout + durable audit_log table           │
│   repo     ── all SQL, owner-scoped, parameterised only                  │
│   notifications ── provider registry; statuses are sent/simulated/       │
│                    failed/unavailable/skipped. Never invented.           │
│   intelligence ─┬─ scoring   weighted, explainable, rule-based          │
│                 ├─ routing   OSRM road geometry + safety scoring        │
│                 ├─ places    OpenStreetMap Overpass, real provenance     │
│                 ├─ classifiers deterministic keyword/heuristic baseline │
│                 └─ llm       optional, advisory, can never gate SOS      │
└──────────────────────────────┬───────────────────────────────────────────┘
                               ▼
              SQLite (WAL, foreign keys, indexes, migrations)
              single portable file · zero external services
```

### Why these choices

| Decision | Rationale |
| --- | --- |
| **Flask kept, no framework migration** | The stack already worked. Rewriting into a SPA framework for a hackathon would have consumed the entire time budget and added risk without adding safety. |
| **SQLite, not PostgreSQL** | The brief asked for a *real relational database*. SQLite gives normalised schema, foreign keys, indexes, transactions and migrations in one portable file with zero credentials. The repository layer is SQL-portable, so Postgres is a config change later. |
| **One backend, not two** | `server.js` and `app.py` were byte-for-byte duplicates that had already drifted. `server.cjs` is now a deprecation shim that delegates. |
| **OSRM + Overpass** | Real road geometry and real places with no API keys, no vendor and no fabricated businesses. |
| **No bundled "safe places" list** | A stale or wrong facility in an emergency is worse than an empty list. If Overpass is unreachable we show official helplines and a link to a live map search — never invented data. |
| **Rule-based scoring, not ML** | There is no training data. A transparent weighted rule set that shows its arithmetic is more honest and more useful than a black box with a fabricated accuracy figure. |

---

## The SOS lifecycle

```
IDLE ──▶ ARMING ──▶ COUNTDOWN ──▶ ACTIVE ──▶ ESCALATING ──▶ RESOLVED
          │  (10s,    (capture    (notify     (explicit)
          │  cancel)  GPS +       contacts,             │
          └──────────▶ CANCELLED   mint link)             └──▶ CANCELLED
```

Guarantees, all enforced server-side and covered by tests:

* **Deterministic** — one POST produces the incident row, anchor fix, share token and notification attempts, or an
  explicit error. No AI, no external dependency in the request path.
* **Duplicate-suppressed** — a double tap or a retry returns the existing incident and alerts **nobody** again.
* **Idempotent stand-down** — cancelling before activation sends nothing; cancelling after activation is recorded as
  `CANCELLED` with a "stood down" message, so the record never understates what happened.
* **Auditable** — every transition is appended to `incident_events` with actor and timestamp.
* **Honest** — there is no police integration, so there is no claim of one.

---

## Safety Intelligence

```
Safety Score = w₁·time-of-day + w₂·incident-density + w₃·infrastructure
             + w₄·community-reports + w₅·route-characteristics + w₆·isolation
             (weights sum to 100; riskScore 0-100, higher = more risk)
```

| Band | Range |
| --- | --- |
| LOW | 0–30 |
| MODERATE | 31–60 |
| HIGH | 61–80 |
| CRITICAL | 81–100 |

Every feature reports its raw value, weight, points, plain-English reason and **provenance**. Confidence comes from
*data coverage*, not from model skill, and the UI always states that this is a rule set with no accuracy measurement.

Design choices worth calling out:

* **A nearby police station *lowers* the risk score.** The infrastructure feature is protective, so
  `risk = 1 − helpfulness`.
* **"No data" is not "safe".** Missing incident history, missing place data and missing isolation data each apply an
  explicit neutral prior with a caveat attached.
* **Community reports are down-weighted by moderation state** — an unverified report contributes at most 45%, and can
  never be presented as fact.
* **Lighting is not scored.** No street-lighting or CCTV dataset is available, so the engine says so rather than
  guessing.

---

## Privacy & security

| Protection | Implementation |
| --- | --- |
| Passwords | PBKDF2-SHA256 (600k iterations), constant-time comparison |
| Sessions | Signed cookie, `HttpOnly`, `SameSite=Lax`; user row re-read per request so revocation is immediate |
| CSRF | Double-submit token on every state-changing request |
| Authorisation | Every query is owner-scoped in the repository layer — this is where the old IDOR bugs died |
| Share links | 256-bit random tokens, **SHA-256 hashed at rest**, scoped, expiring, revocable, no user id in the URL |
| Location | Off until consent; throttled (8 s / 5 m); accuracy-filtered; only linked to an incident while one is open |
| Rate limiting | Sliding window per IP per bucket: auth, SOS, location, write, read, external |
| Headers | CSP (no inline scripts anywhere), `nosniff`, `DENY` framing, strict referrer, permissions policy |
| Errors | One envelope; internals logged with a request id, never returned |
| Logging | Structured JSON; coordinates coarsened to ~110 m before any log write |
| Input | Validation layer on every write; parameterised SQL only; no `innerHTML` anywhere in the client |

### What SheSafe deliberately does **not** do

* No police, ambulance or government integration — and no pretence of one.
* No background monitoring. GPS and journey timers need the page open; we say so on-screen.
* No fabricated ML accuracy, no fake statistics, no invented businesses.
* No claim that an SMS was sent unless a provider confirmed it.

---

## Real vs simulated

`GET /api/capabilities` is the single source of truth; the UI renders from it and never hardcodes a claim.

| Capability | Mode | Notes |
| --- | --- | --- |
| SOS emergency flow | **real** | Server-authoritative, audited, dependency-free |
| Police dispatch | **unavailable** | Not implemented. Use Call 112. |
| Contact notifications | **simulated** (no credentials) | Twilio / MSG91 / FCM adapters activate automatically when configured; otherwise every attempt is recorded as SIMULATED and labelled |
| Live location | **real** | GPS via `watchPosition`, expiring revocable links |
| Risk scoring | **real** | `RULE_BASED_V1`, explainable |
| Road routing | **real** | OSRM (falls back to clearly-labelled geometric corridors offline) |
| Nearby places | **real** | OpenStreetMap Overpass, cached, with honest provenance |
| Journey guard | **real** | Server state machine; timers need the page open |
| Voice SOS | **partial** | Needs `SpeechRecognition` + permission; always requires a confirmation tap |
| AI incident guidance | **simulated** | Rule-based classifier by default; an LLM can be configured but is advisory only |

---

## Project layout

```
├── backend/
│   ├── app/
│   │   ├── __init__.py        app factory, middleware, SPA serving
│   │   ├── config.py          env-driven configuration
│   │   ├── db.py              SQLite schema, migrations, connection handling
│   │   ├── repo.py            all SQL, owner-scoped
│   │   ├── security.py        hashing, sessions, CSRF, rate limits, headers
│   │   ├── errors.py          single error envelope
│   │   ├── logging_utils.py   structured logs + audit trail (privacy-scrubbed)
│   │   ├── validation.py      input validation
│   │   ├── geo.py             haversine, bearings, ETA, local hour
│   │   ├── seed.py            synthetic demo data (no real people or businesses)
│   │   ├── notifications/     provider registry + honest delivery statuses
│   │   ├── intelligence/      scoring · routing · places · classifiers · llm
│   │   └── api/               auth · sos · contacts · location · intelligence
│   │                         journeys · reports · meta · demo
│   ├── tests/                 160 pytest tests
│   ├── wsgi.py                entrypoint
│   ├── server.cjs             deprecated launcher (delegates to Flask)
│   └── requirements.txt       Flask only
├── frontend/
│   ├── index.html             app shell (semantic, CSP-clean)
│   ├── track.html             guardian tracking page
│   ├── css/app.css            design tokens + components
│   ├── js/core/               api · store · router · location · mapkit · dom · feedback
│   ├── js/modules/            sos · sharing · intelligence · places · journey
│   │                         contacts · reports · voice
│   ├── sw.js                  app-shell-only service worker
│   ├── manifest.webmanifest   PWA manifest with shortcuts
│   └── icons/
├── tests/frontend/smoke.mjs   36 browser-contract checks against a live server
└── docs/
    ├── ARCHITECTURE_AUDIT.md  pre-remediation audit (CRITICAL/HIGH/MEDIUM/LOW)
    └── HACKATHON_READINESS.md readiness report + judge demo script
```

---

## API reference

All responses are `{"ok": true, ...}` or `{"ok": false, "error": {"code", "message"}, "request_id"}`.

| Method | Endpoint | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/api/health` | — | Liveness, version, demo flag, row counts |
| `GET` | `/api/capabilities` | — | Real / simulated / unavailable manifest |
| `GET` | `/api/helplines` | — | Official national helplines |
| `GET` | `/api/auth/session` | — | Session probe (always 200) |
| `POST` | `/api/auth/login` · `/signup` · `/logout` | — / ✓ | Authentication |
| `PATCH` | `/api/auth/profile` | ✓ | Profile & preferences (whitelisted fields) |
| `GET` | `/api/sos/lifecycle` | ✓ | Lifecycle states and guarantees |
| `POST` | `/api/sos/arm` | ✓ | Open an incident (countdown window) |
| `POST` | `/api/sos/activate` | ✓ | Capture GPS, alert contacts, mint share link |
| `POST` | `/api/sos/escalate` · `/resolve` · `/cancel` | ✓ | Close the incident |
| `GET` | `/api/sos/active` · `/incidents` · `/incidents/<id>` | ✓ | Current + historical incidents |
| `GET` `POST` | `/api/contacts` | ✓ | Emergency contacts (owner-scoped) |
| `PATCH` `DELETE` | `/api/contacts/<id>` · `/verify` | ✓ | Edit, remove, self-confirm |
| `POST` | `/api/location/ping` | ✓ | Authenticated telemetry sample |
| `GET` | `/api/location/latest` | ✓ | Own last known position |
| `POST` | `/api/location/share/start` · `/revoke` | ✓ | Mint / revoke expiring links |
| `GET` | `/api/location/share/active` | ✓ | Share-link status |
| `GET` | `/api/track/<token>` | token | Guardian view |
| `GET` | `/api/intelligence/assess` · `/explain` | ✓ | Risk score, engine description |
| `GET` | `/api/intelligence/places` | ✓ | Nearby safe places (real provenance) |
| `POST` | `/api/intelligence/routes` | ✓ | Candidate routes, safety-scored |
| `POST` | `/api/intelligence/incident-assist` | ✓ | Classification + guidance (advisory) |
| `GET` `POST` | `/api/journeys` | ✓ | Journey guard list / start |
| `POST` | `/api/journeys/<id>/checkin` · `/cancel` · `/escalate` | ✓ | Journey lifecycle |
| `GET` `POST` | `/api/checkins` | ✓ | "I'm safe" check-ins |
| `GET` `POST` | `/api/reports` | ✓ | Community reports |
| `POST` | `/api/reports/<id>/helpful` · `/moderate` | ✓ | Signals and moderation |
| `GET` | `/api/meta/audit` | ✓ | Recent security events (coordinates scrubbed) |
| `GET` | `/api/demo/status` · `/script` · `POST /reset` | — / ✓ | Demo mode (404 when disabled) |

---

## Configuration

Copy `.env.example` to `.env` for the full list. Everything has a safe development default. The only value that is
**required** in production is `SHESAFE_SECRET_KEY` — the app refuses to start without it, rather than falling back to
a guessable key.

Optional integrations (`SHESAFE_SMS_PROVIDER`, `SHESAFE_AI_PROVIDER`, …) activate only when credentials exist; until
then the capability manifest reports them honestly.

---

## Testing

```
160 pytest tests
├── auth         hashing, no name-substring bypass, session forgery, CSRF,
│                origin guard, cookie flags, mass-assignment, enumeration
├── sos          lifecycle, duplicate suppression, notification honesty,
│                invalid coordinates, owner scoping, audit trail
├── location     token entropy, hashed-at-rest storage, expiry, revocation,
│                unauthorised access, precision filtering, trail scoping
├── contacts     CRUD, channel whitelist, primary uniqueness, IDOR isolation
├── intelligence band boundaries, weight sum, protective features, prior values,
│                unverified down-weighting, explainability, provenance,
│                no-accuracy-claim assertions
├── journeys     escalation ladder, grace periods, escalation → SOS
├── reports      moderation states, verification gating, anonymity, votes
└── api + e2e    rate limiting, error envelope, SQL-injection inertness,
                 size limits, capability manifest, and the mandated
                 LOGIN → DASHBOARD → SOS → LOCATION → ALERT →
                 LIVE TRACKING → CANCEL journey

36 jsdom contract checks
└── boot, auth guard, sign-in, dashboard, contacts, SOS countdown → activation
    → honest notification counts → stand-down, history, location consent,
    safety intelligence explainability, accessibility, CSP cleanliness
```

---

## Documentation

* [`docs/ARCHITECTURE_AUDIT.md`](docs/ARCHITECTURE_AUDIT.md) — the pre-remediation audit: 12 CRITICAL, 14 HIGH,
  17 MEDIUM, 13 LOW findings, with locations and remediation contracts.
* [`docs/HACKATHON_READINESS.md`](docs/HACKATHON_READINESS.md) — readiness score, judge demo script, real vs
  simulated inventory, remaining limitations.

---

## Licence

MIT. Built with care, because the users are real people.

**If you or someone you know is in danger, call 112 (or your local emergency number). SheSafe does not contact
emergency services for you.**