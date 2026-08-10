// engines/enrich.js — F1 "Import Profile URLs" job runner.
//
// Takes resolved Zillow / Realtor rows and, one agent at a time (bounded
// concurrency), cross-checks each against the DB BEFORE scraping, scrapes only
// the not-present ones, re-checks the scraped result, and forwards genuinely-new
// agents to the existing ingest webhook. Self-contained job with a tiny
// in-memory registry (its own /api/enrich endpoints).
//
// Per-agent flow (additive-only — existing rows are never modified):
//   reconcile(dataset) → already in DB?      → SKIP (no scrape, untouched)
//   scrape not-present → blocked?            → 'blocked'
//                      → parse → dead?       → 'dead'
//                      → isAlreadyPresent()? → SKIP (found via scraped email/phone)
//                      → else queue as NEW   → ingest webhook (batched)

import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';

import { fetchUnblocked, activeProvider } from '../unblocker.js';
import { parseProfile } from '../profile-parser.js';
import { reconcile, isAlreadyPresent, tagSourceUrls } from '../reconcile.js';
import { ingestRows, ingestEnabled } from '../ingest.js';

const FLUSH_AT = 100; // send new agents to the ingest webhook in batches of this

const jobs = new Map();

export function getEnrich(id) {
    return jobs.get(id);
}

/** Signal a running enrich job to stop; workers wind down at the next item. */
export function stopEnrich(id) {
    const job = jobs.get(id);
    if (job && job.status === 'running') { job.aborted = true; return true; }
    return false;
}

/**
 * Start an enrich run over a resolved row list.
 * @param {{url:string, source:string, email?:string, phone?:string, name?:string}[]} items
 * @param {{ concurrency?:number, detected?:object }} opts
 * @returns {object} the job (also retrievable via getEnrich(id))
 */
export function startEnrich(items, opts = {}) {
    const id = randomUUID();
    const job = {
        id,
        status: 'running',            // running | done | stopped | error
        aborted: false,
        createdAt: Date.now(),
        concurrency: Math.min(Math.max(1, opts.concurrency || 4), 8),
        detected: opts.detected || {},
        total: items.length,
        done: 0,
        counts: { alive: 0, dead: 0, blocked: 0, error: 0, new: 0, enriched: 0, skipped: 0 },
        rows: [],                     // { url, source, status, message?, row? }
        pending: { zillow: [], realtor: [] },  // scraped-new rows awaiting ingest
        flushing: { zillow: false, realtor: false },
        ingested: 0,                  // rows the webhook confirmed inserted/updated
        tagged: 0,                    // new agents stamped with source_url (profile link)
        writeMode: ingestEnabled() ? 'live' : 'dry', // 'dry' = parse only, no write
        message: '',
    };
    jobs.set(id, job);
    // Evict old jobs (keep last ~20) to bound memory.
    if (jobs.size > 20) {
        const oldest = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
        if (oldest) jobs.delete(oldest.id);
    }
    run(job, items).catch((err) => {
        job.status = 'error';
        job.message = err.message;
    });
    return job;
}

async function run(job, items) {
    if (!activeProvider()) {
        job.status = 'error';
        job.message = 'No unblocker configured (set BRIGHTDATA_API_TOKEN in web/.env).';
        return;
    }

    // Cross-check FIRST: skip agents already in the DB — no scrape is spent on
    // them. reconcile() never throws (degrades to "scrape all" on a DB hiccup).
    const rec = await reconcile(items);
    const queue = rec.toScrape;
    job.total = queue.length;                 // work = only the not-present agents
    job.presentSkipped = rec.skipped.length;
    job.counts.skipped += rec.skipped.length;
    if (rec.error) job.message = `Cross-check degraded (scraping all): ${rec.error}`;
    if (job.writeMode === 'dry' && !job.message) {
        job.message = 'Dry run — new agents are parsed but NOT written (INGEST_TOKEN not set).';
    }
    // Surface already-in-DB rows in the results table (skipped, untouched).
    for (const it of rec.skipped) {
        job.rows.push({
            url: it.url, source: it.source, status: 'skipped',
            row: { Name: it.name, Email: it.email, Phone: it.phone },
        });
    }
    // A skipped match still carries a profile URL the existing row may lack —
    // stamp it into the row's EMPTY source_url (fill-only, additive) so the
    // agent also surfaces under the app's Zillow/Realtor source tab. Detached
    // + best-effort: tagging never delays or fails the scrape.
    if (ingestEnabled() && rec.skipped.length) {
        const urlCol = (s) => (s === 'realtor' ? 'Realtor Profile URL' : 'Zillow Profile URL');
        const pseudo = rec.skipped.map((it) => ({
            [urlCol(it.source)]: it.url, Email: it.email, Phone: it.phone,
        }));
        tagSourceUrls(pseudo).then((n) => { job.tagged += n; }).catch(() => {});
    }

    if (!queue.length) { job.status = 'done'; return; }

    const browser = await chromium.launch({ headless: true });
    let idx = 0;
    const worker = async () => {
        while (idx < queue.length) {
            if (job.aborted) return;
            const item = queue[idx]; idx += 1;
            await processOne(job, item, browser);
            job.done += 1;
        }
    };
    try {
        await Promise.all(Array.from({ length: job.concurrency }, worker));
    } finally {
        await flushAll(job).catch((err) => { job.message = `Final ingest failed: ${err.message}`; });
        await browser.close().catch(() => {});
        job.status = job.aborted ? 'stopped' : 'done';
    }
}

// A CAPTCHA page, a blocked stub ("page too small"), or a transient fetch error
// are all one-off unblocker misses — a fresh attempt usually returns the real
// page. So fetch+parse retries up to ATTEMPTS before recording a failure, and
// the whole item runs under a hard watchdog so no single URL can hang the run.
const ATTEMPTS = 3;
const ITEM_TIMEOUT_MS = 6 * 60 * 1000;

async function processOne(job, item, browser) {
    let timer;
    const watchdog = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ITEM_TIMEOUT_MS);
    });
    const r = await Promise.race([processOneInner(job, item, browser), watchdog])
        .catch((err) => ({ error: err.message }));
    clearTimeout(timer);
    if (r && r.timedOut) {
        item._timedOut = true;   // the abandoned attempt must not also record a row
        job.counts.error += 1;
        job.rows.push({ url: item.url, source: item.source, status: 'error', message: `timed out after ${ITEM_TIMEOUT_MS / 60000}m` });
    } else if (r && r.error) {
        job.counts.error += 1;
        job.rows.push({ url: item.url, source: item.source, status: 'error', message: r.error });
    }
}

async function processOneInner(job, item, browser) {
    const { url, source } = item;
    let html = null;
    let parsed = null;
    let lastFail = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        if (job.aborted) return {};
        if (attempt > 1) await new Promise((res) => setTimeout(res, 3000 * (attempt - 1)));
        try {
            // Zillow profiles are JS-rendered; realtor server-renders __NEXT_DATA__.
            html = await fetchUnblocked(url, { render: source === 'zillow' });
        } catch (err) {
            lastFail = err.message;
            continue;
        }
        if (!html || html.length < 1500) {
            lastFail = `page too small (${html ? html.length : 0} bytes)`;
            continue;
        }
        try {
            parsed = await parseProfile({ url, html, browser });
            break;
        } catch (err) {
            // e.g. Zillow CAPTCHA — a transient unblocker miss, not a dead URL.
            parsed = null;
            lastFail = err.message;
        }
    }
    if (item._timedOut) return {};    // watchdog already recorded this URL
    if (!parsed) {
        const blocked = /page too small|CAPTCHA/i.test(lastFail);
        job.counts[blocked ? 'blocked' : 'error'] += 1;
        job.rows.push({ url, source, status: blocked ? 'blocked' : 'error', message: `${lastFail} — after ${ATTEMPTS} attempts` });
        return {};
    }

    if (!parsed.alive) {
        job.counts.dead += 1;
        job.rows.push({ url, source, status: 'dead' });
        return {};
    }
    job.counts.alive += 1;

    // Stage-2 cross-check: the scrape may reveal an email/phone the pre-filter
    // couldn't see. If it's already in the DB, skip — never modify an existing
    // agent. Otherwise queue this NEW agent for the ingest webhook.
    let present = false;
    try { present = await isAlreadyPresent(parsed.row); } catch { /* treat as new */ }
    if (item._timedOut) return {};    // watchdog fired during the DB check
    if (present) {
        job.counts.skipped += 1;
        job.rows.push({ url, source: parsed.source, status: 'skipped', row: parsed.row });
        // Same fill-only source_url stamp for a stage-2 skip (matched via the
        // scraped email/phone): the scraped row is already in native shape.
        if (ingestEnabled()) tagSourceUrls([parsed.row]).then((n) => { job.tagged += n; }).catch(() => {});
        return {};
    }

    job.counts.new += 1;
    job.pending[parsed.source].push(parsed.row);
    job.rows.push({ url, source: parsed.source, status: 'new', row: parsed.row });
    await maybeFlush(job, parsed.source, false);
}

// Send queued NEW agents to the existing ingest webhook (no-op unless
// INGEST_TOKEN is set). Batched; requeues on failure so nothing is lost.
async function maybeFlush(job, source, force) {
    const buf = job.pending[source];
    if (!buf || !buf.length) return;
    if (!force && buf.length < FLUSH_AT) return;
    if (job.flushing[source]) return;          // a flush is already in flight
    job.flushing[source] = true;
    const batch = buf.splice(0, buf.length);
    try {
        const r = await ingestRows(source, batch);
        job.ingested += (r.inserted || 0) + (r.updated || 0);
        // Stamp the just-inserted NEW agents with their profile link (additive:
        // fills source_url only where empty). Best-effort — swallowed so a tag
        // miss never requeues/re-ingests. No-op in dry runs (INGEST_TOKEN unset).
        if (ingestEnabled()) job.tagged += await tagSourceUrls(batch).catch(() => 0);
    } catch (err) {
        buf.unshift(...batch);                  // requeue — don't lose scraped rows
        job.message = `Ingest ${source} failed: ${err.message}`;
    } finally {
        job.flushing[source] = false;
    }
}

async function flushAll(job) {
    for (const source of ['zillow', 'realtor']) {
        while (job.flushing[source]) await new Promise((r) => setTimeout(r, 50));
        await maybeFlush(job, source, true);
    }
}
