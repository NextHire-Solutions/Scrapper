# Agent Scraper — Standard Operating Procedure (SOP)

**System:** Broker Staffer Agent Scraper & Enrichment Platform
**Repo:** `brokerstaffer/Scrapper` (GitHub)
**Runtime:** Node.js ≥ 18 · Express · Playwright
**Last updated:** 2026-08-08

> This document explains **what the system does, how it works, what it connects to, how to run/operate it, its costs, and its security rules.** It is the single reference for anyone operating or handing off the scraper.

---

## 1. What it is (one-paragraph summary)

The platform collects real-estate **agent production data** from three sources — **Courted**, **Zillow**, and **Realtor.com** — normalizes it, de-duplicates it by identity, and writes it into a central **Supabase `agents` database** (~773k agents and growing). It runs as a hosted web service with a browser dashboard for on-demand searches/imports, **plus automated background jobs** that keep the data fresh and alert on changes. It also computes each agent's **role title** (Team Leader / Managing Broker) and keeps it correct on every sweep.

---

## 2. Architecture at a glance

```
                        ┌──────────────────────────────────────────┐
   Operator (browser)   │   AGENT-SEARCH SERVICE  (Railway)         │
        │  dashboard     │   Express app  ·  web/server/index.js     │
        └───────────────►│                                          │
                         │  Engines:                                │
   Courted.io ◄──Cognito─┤   • courted.js   (Courted API sweep)     │
   (private API)         │   • zillow.js    (Playwright + unblocker)│
                         │   • realtor.js   (Playwright + unblocker)│
   Zillow / Realtor ◄────┤   • enrich.js    (Import Profile URLs)   │
   (via Bright Data)     │   • mls-scan / mls-monitor / refresh     │
                         │                                          │
                         └───────────┬──────────────────────────────┘
                                     │ POST /api/ingest/agents
                                     ▼
                         ┌──────────────────────────────┐
                         │  BROKER STAFFER DB APP        │  (separate Railway service)
                         │  remap + dedupe (license →    │
                         │  email → phone) + upsert       │
                         └───────────┬───────────────────┘
                                     ▼
                         ┌──────────────────────────────┐
                         │  SUPABASE  ·  `agents` table  │  (~773k rows)
                         └──────────────────────────────┘

   Slack  ◄── MLS-monitor alerts (added / removed MLS, login failures)
```

**Two separate deployed services:**
1. **`agent-search`** — this repo. The scraper + dashboard + automations.
2. **Broker Staffer DB app** (`web-production-34f4a.up.railway.app`) — owns Supabase, receives scraped rows at `/api/ingest/agents`, remaps each source's native columns, and merges/upserts by identity. **The scraper never writes to Supabase directly for agent data** — it posts to this webhook (additive/upsert, no duplicates).

---

## 3. Data sources & how each is scraped

### 3.1 Courted (primary source)
- **Method:** signs in via **AWS Cognito** (the same auth the Courted website uses — pure HTTP, no browser), then reads Courted's **private JSON API** `api.courted.io/api/mls/broker/agent_search/`, paging with `limit`/`offset`.
- **NEVER uses Courted's "Export to CSV" button.** It reads the same live data the UI table is built from, directly and at scale.
- **Fields:** ~70 per agent — contact info, office, full LTM/YTD production, buy/list-side splits, GCI, predictions, likelihood-to-move, license, tenure, most-transacted area, and (with enrichment) mobile phone, office address, role/team flags, AI agent type.
- **Auth tokens** last ~1 hour and **auto-refresh mid-run** so long sweeps don't drop.
- **Accounts:** the client's **8 Courted logins**, stored as env vars (`COURTED_EMAIL` / `COURTED_EMAIL_2` … `_20` + matching passwords). Each account sees a different set of MLSs:

  | Account | MLSs | Searchable agents |
  |---|---|---|
  | eddy@brokerstaffer.com | 34 | 855,840 |
  | teambyrd@gmail.com | 15 | 491,099 |
  | brandon@chucktownhomes.com | 9 | 230,010 |
  | jeffcook@jeffcookrealestate.com | 6 | 52,513 |
  | stephen@serhant.com | 5 | 144,847 |
  | jenniferaragon@keyes.com | 5 | 186,087 |
  | dusty@youneedresults.com | 2 | 148,750 |
  | elias@fastagents.com | 1 | 13,648 |

  *(Counts are per-account searchable universe from the last MLS-monitor scan; the same agent appears in multiple MLSs/accounts and is deduped on ingest.)*

- **Deep-offset wall:** Courted's API refuses very deep offsets. The sweep uses **band segmentation** (`courted/src/segments.js`, `SEGMENT_MAX ≈ 90,000`) — it splits each account into volume/state bands each under the wall and pages each from offset 0.
- **Pacing:** strictly serial, jittered delays (`COURTED_DELAY_MS`, default 350–500 ms), lean queries (only the needed fields). Deliberately gentle so an account never looks like a scraper / never gets rate-limited.

### 3.2 Zillow & Realtor.com (secondary sources)
- **Method:** headless **Playwright**, routed through a **web-unblocker** (Bright Data or ZenRows) to fetch profile pages, then parsed into the same schema.
- **Requires** an unblocker key (`BRIGHTDATA_API_TOKEN` or `ZENROWS_API_KEY`); without one, Zillow/Realtor are disabled.
- Slower than Courted (minutes vs seconds) and **metered** (see Costs).

---

## 4. Core functionalities

### 4.1 Live Agent Search (dashboard)
`POST /api/search` starts a job; the browser subscribes to `GET /api/search/:id/stream` (Server-Sent Events) and sees `record` / `progress` / `source_done` / `complete` events. Courted rows appear in seconds; Zillow/Realtor fill in as they scrape. Each source is **exportable to CSV** with the full field set (`/api/search/:id/export?source=…`).

### 4.2 Whole-account / MLS-select sweeps
- **Whole account:** unfiltered sweep of every MLS an account can see (`courtedAllAgents`).
- **MLS-select:** server-side `mls_id=<CODE>` filter — sweep only chosen MLS(s) of an account.
- Rows stream to the dashboard **and** flush to the DB webhook in batches (`COURTED_FLUSH_SIZE`).

### 4.3 Role-title tagging (Team Leader / Managing Broker)
Courted's role classification is only exposed via its `at_type_includes` filter. After each sweep the engine pages the **team-leader** and **managing-broker** filters (`courted/src/roles.js`), builds a `courted_id → title` map, and PATCHes the `title` column on matching DB rows. Titles: `Team Leader`, `Managing Broker`, or `Managing Broker, Team Leader` (both); everyone else stays `Salesperson`. **Paged per-MLS to the true end** so no MLS is skipped. Title-only, additive.

### 4.4 Add / update a Courted account (self-service)
`POST /api/courted/account` — validates the login against Courted **first**, then saves the credentials into the next free `COURTED_EMAIL_n` slot on Railway (via the Railway API). Railway then redeploys to load the new account. Updating an existing account's password works the same way (validate → write → redeploy).

### 4.5 MLS detection & list
`POST /api/courted/mls-list` / `mls-scan` — logs into an account and enumerates the MLSs it can access, with an exact agent count per MLS. Read-only.

### 4.6 F1 — Import Profile URLs (enrichment)
`POST /api/enrich` — accepts a **shared Google Sheet link**, a **pasted CSV**, or a raw `urls[]` list of Zillow/Realtor profile URLs. For each: cross-checks against the `agents` table **by identity first** (email / phone / license), **skips agents already present**, scrapes only the genuinely-new ones, and forwards them to the ingest webhook. **Additive only** — existing rows are never modified. `/api/enrich/resolve` previews counts + estimated cost without scraping.

---

## 5. Automated background jobs

| Job | Toggle | Cadence | What it does | Alerts |
|---|---|---|---|---|
| **MLS Monitor ("Option B")** | `MLS_MONITOR_ENABLED=1` | every `MLS_MONITOR_INTERVAL_HOURS` | Scans every account's MLS list, diffs vs the saved baseline (`mls_monitor_state`), flags MLSs **added / removed** (and login failures). | **Slack** (`SLACK_BOT_TOKEN` + `SLACK_CHANNEL_ID`) |
| **15-day Refresh** | `REFRESH_ENABLED=1` | one account every `REFRESH_WINDOW_DAYS/8` ≈ 1.9 days | Re-scrapes the account that has gone longest without a refresh, so every account (and every agent it sees) is re-pulled within `REFRESH_WINDOW_DAYS` (default **15**). **Accumulates** (adds/updates, never deletes). Also re-tags titles. | Slack on **failure only** |

- **MLS Monitor UI** (dashboard card): after saving a baseline and re-scanning, an MLS **removed** from an account shows in **red**, a **newly available** MLS shows in **green**.
- **Refresh progress** is stored per account in `refresh_state` (`last_refreshed_at`, `last_status`).

---

## 6. Where the data lives (Supabase)

Central table: **`agents`** (~773k rows). Key columns used by the scraper/reconciler:
`preferred_email`, `enriched_email`, `preferred_phone` (E.164 `+1…`), `license_number`, `title`, `full_name`, `office_name`, `source_ids` (jsonb — e.g. `source_ids.courted.agent_id`).

Supporting tables (see `web/server/schema.sql`):
- `agent_mls` — the many-to-many store of which MLS(s) each agent belongs to.
- `mls` — MLS registry (code, name, state, agent counts).
- `mls_monitor_state` — per-account last-seen MLS list (baseline for the monitor).
- `refresh_state` — per-account last-refresh timestamp/status.
- (`courted_agents`, `zillow_agents`, `realtor_agents` — legacy per-source raw tables.)

**De-duplication:** the DB app merges agents across sources by **license → email → phone**, so re-scraping a market updates the same agent instead of duplicating.

---

## 7. Hosting & deployment

- **Host:** Railway, service **`agent-search`**. Built from `web/Dockerfile` (`COPY . .`), start command `node web/server/index.js`.
- **Repo:** `github.com/brokerstaffer/Scrapper` (push requires the `Outreachify` GitHub account).
- **Deploys are MANUAL — Railway does NOT auto-deploy on push.** Ship with:
  ```bash
  railway up --service agent-search --ci      # needs RAILWAY_TOKEN in env
  ```
- The **add-account** flow writes new Courted creds via the Railway API (`RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID`), which triggers a redeploy.
- **Local run:** `node web/server/index.js` → `http://localhost:3000` (needs the env vars below; only account 1 lives in local `web/.env`, the full set lives in Railway).

---

## 8. Connections summary (what it talks to)

| Connection | Purpose | Auth / config |
|---|---|---|
| **Courted.io** (Cognito + `api.courted.io`) | primary agent data | 8 account logins (`COURTED_EMAIL*` / `COURTED_PASSWORD*`) |
| **Bright Data / ZenRows** | unblocker for Zillow/Realtor | `BRIGHTDATA_API_TOKEN` or `ZENROWS_API_KEY` |
| **Broker Staffer DB app** (`/api/ingest/agents`) | writes agents to Supabase (remap + dedupe) | `INGEST_TOKEN` (bsk_… key), `INGEST_URL` |
| **Supabase** | the `agents` database (read-side: title PATCH, monitor/refresh state) | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Railway API** | save new Courted accounts + redeploy | `RAILWAY_API_TOKEN` + project/service/env IDs |
| **Slack** | MLS-monitor & refresh alerts | `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID` |
| **Google Sheets** | import source for F1 enrichment | shared "Anyone with the link" |

---

## 9. Costs

| Item | Cost model | Notes |
|---|---|---|
| **Courted scraping** | **$0 marginal** | Reads Courted's own API — no per-request charge. The only cost is the client's **8 Courted.io account subscriptions** (billed by Courted, not us). |
| **Zillow / Realtor scraping + F1 enrichment** | **~$1.50 per 1,000 profile requests** (Bright Data ≈ **$0.0015 / agent**) | The only metered scraping cost. The dashboard shows an estimate before you run (`estCostUsd`). Courted uses none of this. |
| **Railway hosting** | usage-based (container CPU/RAM) | Two services: `agent-search` (this) + the DB app. See the Railway billing dashboard. |
| **Supabase** | plan/usage-based | Database storage + API. See the Supabase billing dashboard. |
| **Slack** | free | Standard bot token. |

**Rule of thumb:** keeping the Courted pipeline (the bulk of the data) fresh is essentially free; only Zillow/Realtor top-ups and enrichment consume paid Bright Data credits.

---

## 10. Operating runbook (common tasks)

- **Deploy a code change:** `railway up --service agent-search --ci` (then verify the service is back and a quick endpoint responds).
- **Add a Courted account:** dashboard → Add account (validates + saves + redeploys). Or `POST /api/courted/account`.
- **Fresh full re-scrape of one account:** dashboard whole-account sweep, or `POST /api/courted/refresh/run` for that email.
- **Force an MLS-monitor scan now:** `POST /api/courted/mls-monitor/run`.
- **Re-tag titles across accounts (repair):** `node --env-file=web/.env courted/backfill-titles.mjs --write` (or `--accounts=7`); pull the full account set from Railway (`railway run --service agent-search node courted/backfill-titles.mjs --write`). Additive, title-only. Dry-run is the default (omit `--write`).
- **Check refresh progress:** query the `refresh_state` table (`last_refreshed_at` per account).

---

## 11. Security & guardrails (MUST follow)

1. **Never use Courted's "Export to CSV"** — always the `agent_search` API.
2. **Never print or commit secrets** — Railway token, GitHub PAT, Supabase service-role key, Courted passwords, `bsk_`/`sbp_` ingest tokens. All live in env vars only.
3. **PII CSVs** (agent contact data) go to a location **outside the git repo** (e.g. `~/Downloads`), never committed.
4. **DB writes are additive-only** — upsert/merge or title-only PATCH; never delete or overwrite existing agent data destructively.
5. **Stay gentle on Courted** — serial paging, jittered delays, lean queries. "Slow but never flagged."
6. **Validate before persisting** — the add-account flow logs into Courted before saving any credential.

---

## 12. Key files (map)

```
web/server/
  index.js            Express app, routes, SSE, startup, env loader
  jobs.js             in-memory job registry + SSE pub/sub
  ingest.js           POST rows → DB app webhook (batched, throttled)
  reconcile.js        identity matching + stampCourtedTitles (title PATCH)
  refresh.js          15-day rolling re-scrape scheduler (refresh_state)
  mls-monitor.js      scheduled MLS add/remove scan + Slack alerts
  railway.js          save Courted creds via Railway API
  unblocker.js        Bright Data / ZenRows request wrapper
  schema.sql          Supabase tables
  engines/
    courted.js        Courted whole-account / MLS sweep + title tagging
    zillow.js         Zillow Playwright runner
    realtor.js        Realtor.com Playwright runner
    enrich.js         F1 Import Profile URLs
    mls-scan.js       MLS enumeration job

courted/
  src/auth.js         Cognito sign-in + token refresh
  src/api.js          typed agent_search API access
  src/constants.js    endpoints, statuses, pacing constants
  src/segments.js     band segmentation (stays under the deep-offset wall)
  src/scraper.js      the paging engine
  src/mls.js          detect an account's MLS list + per-MLS counts
  src/roles.js        role-title collection (at_type_includes, per-MLS)
  src/mapper.js       raw record → normalized columns
  backfill-titles.mjs one-time / re-runnable title repair tool
  export-mls-csv.mjs  one-off MLS CSV export tool

web/public/            dashboard (index.html, app.js, styles.css)
```

---

## 13. Environment variables (reference)

**Courted:** `COURTED_EMAIL`(_2…_20), `COURTED_PASSWORD`(_2…_20), `COURTED_DELAY_MS`, `COURTED_SEGMENT_MAX`, `COURTED_FLUSH_SIZE`, `COURTED_BASELINE_FLOOR`
**Unblocker (Zillow/Realtor):** `BRIGHTDATA_API_TOKEN` + `BRIGHTDATA_ZONE`, or `ZENROWS_API_KEY`; `UNBLOCKER_PROVIDER`, `UNBLOCKER_MAX_CONCURRENT`
**Ingest / DB:** `INGEST_TOKEN`, `INGEST_URL`, `INGEST_BATCH_SIZE`, `INGEST_BATCH_DELAY_MS`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
**Automations:** `MLS_MONITOR_ENABLED`, `MLS_MONITOR_INTERVAL_HOURS`, `REFRESH_ENABLED`, `REFRESH_WINDOW_DAYS`
**Slack:** `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_ID`
**Railway (add-account/deploy):** `RAILWAY_API_TOKEN`, `RAILWAY_PROJECT_ID`, `RAILWAY_SERVICE_ID`, `RAILWAY_ENVIRONMENT_ID`
**Misc:** `PORT`, `ADMIN_TOKEN`

> Values live only in Railway (production) and local `web/.env` (dev). Never document the values themselves.
