// engines/courted.js — bridge the Courted scraper into a streaming job.
// Pure HTTP, fast: results land in seconds.
//
// Supports MULTIPLE Courted accounts. Each account can belong to a different
// brokerage/MLS, so it may see different agents. We run the search on every
// account and merge the results, de-duplicating the same agent across accounts
// (by Courted ID, else email / license / name+office).

import { runScrape } from '../../../courted/src/scraper.js';
import { login } from '../../../courted/src/auth.js';
import { buildSegments } from '../../../courted/src/segments.js';
import { emit, engineFinished } from '../jobs.js';
import { ingestRows, ingestEnabled } from '../ingest.js';
import { dbEnabled, stampCourtedTitles } from '../reconcile.js';
import { collectRoleTitleMap } from '../../../courted/src/roles.js';

// Flush to the DB app every N records during a long sweep (bounds memory + means
// a mid-run failure doesn't lose everything already scraped).
const FLUSH_SIZE = Number(process.env.COURTED_FLUSH_SIZE) || 1000;
// Max agents per band segment — kept under Courted's deep-pagination wall (~80–100k,
// varies per account). Each segment pages from offset 0, so it never goes deep.
const SEGMENT_MAX = Number(process.env.COURTED_SEGMENT_MAX) || 70000;

/**
 * Read every configured Courted account from the environment:
 *   COURTED_EMAIL    / COURTED_PASSWORD      (account 1)
 *   COURTED_EMAIL_2  / COURTED_PASSWORD_2    (account 2)
 *   …up to _20. De-duplicated by email.
 */
export function readCourtedAccounts() {
    const out = [];
    const seen = new Set();
    const add = (email, password) => {
        if (!email || !password) return;
        const key = email.trim().toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ email: email.trim(), password });
    };
    add(process.env.COURTED_EMAIL, process.env.COURTED_PASSWORD);
    for (let i = 2; i <= 20; i += 1) {
        add(process.env[`COURTED_EMAIL_${i}`], process.env[`COURTED_PASSWORD_${i}`]);
    }
    return out;
}

// A stable identity for an agent so the same person from two accounts collapses
// into one row.
function personKey(row) {
    const v = (k) => String(row[k] == null ? '' : row[k]).trim().toLowerCase();
    return v('Courted Agent ID') || v('Courted ID')
        || v('Email') || v('State License')
        || (v('Name') ? `${v('Name')}|${v('Office')}` : '');
}

export async function runCourted(job) {
    const { locations, courtedMax, courtedEnrich, minSalesVolume, courtedAllAgents, courtedReverse } = job.params;
    const source = 'courted';
    // Full unfiltered sweep: pull every agent the account's MLS can see.
    const searchLocations = courtedAllAgents ? [] : locations;
    // Band pagination: on a full sweep, split each account by sales-volume range
    // so no query pages past Courted's deep-offset 504 wall. Defaults on for the
    // full sweep; set courtedBanded:false to force the old flat offset sweep.
    const useBands = courtedAllAgents && job.params.courtedBanded !== false;

    let accounts = readCourtedAccounts();
    // Optionally process accounts last-to-first (e.g. do the already-scraped
    // account 1 last so fresh accounts' new agents reach the DB sooner).
    if (courtedReverse) accounts.reverse();
    // Optionally resume from a later account (skip ones already fully captured),
    // applied AFTER the reverse so it matches the displayed 1..N run order.
    const skip = Math.max(0, Number(job.params.courtedSkipAccounts) || 0);
    if (skip > 0) accounts = accounts.slice(skip);
    // Optionally target specific accounts (email substrings) — e.g. re-run only
    // the accounts that came out incomplete. Idempotent upserts make this safe.
    const only = (Array.isArray(job.params.courtedOnly) ? job.params.courtedOnly : [])
        .map((s) => String(s).trim().toLowerCase()).filter(Boolean);
    if (only.length) accounts = accounts.filter((a) => only.some((o) => a.email.toLowerCase().includes(o)));
    // Optional per-account MLS scoping: when the user picks specific MLS(s) of a
    // multi-MLS account, run ONE server-side-filtered sweep per code
    // (mls_id=<CODE>). Empty/absent = the whole account (unchanged behavior).
    const mlsIds = (Array.isArray(job.params.courtedMlsIds) ? job.params.courtedMlsIds : [])
        .map((s) => String(s).trim()).filter(Boolean);
    if (!accounts.length) {
        emit(job, 'source_error', { source, message: 'Courted credentials not set (COURTED_EMAIL / COURTED_PASSWORD in web/.env).' });
        engineFinished(job);
        return;
    }

    const log = {
        info: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        warning: (m) => emit(job, 'progress', { source, status: 'running', message: m }),
        debug: () => {},
    };

    const seen = new Set();   // cross-account de-dupe
    const allCourtedIds = new Set(); // every courted_mls_id this run touched (for the title stamp)
    let firstSweepDone = false; // cool-off gate: skip the wait only before the very first sweep
    let pushed = 0;           // unique agents emitted
    let total = 0;            // sum of matched counts (rough, may double-count overlaps)
    const cap = courtedMax || 0;
    const reachedCap = () => cap > 0 && pushed >= cap;
    const errors = [];

    // Incremental DB-app flush. Buffer records and ship them every FLUSH_SIZE so
    // huge sweeps don't sit in memory and a mid-run crash keeps what was sent.
    const sendToDb = ingestEnabled();
    // After each account's sweep, stamp the real role title (Team Leader /
    // Managing Broker / both) on the agents it exposes — Courted's ingest can't
    // derive the role, so without this a plain sweep leaves everyone
    // "Salesperson". Needs the Supabase creds (dbEnabled); set
    // courtedStampTitles:false to skip. See courted/src/roles.js.
    const stampTitles = dbEnabled() && job.params.courtedStampTitles !== false;
    // Role titles are collected BEFORE each sweep (per-MLS scoped) so every row
    // can carry its role natively — Title plus the "Is Team Leader" /
    // "Is Managing Broker" checkboxes the DB app reads. The post-sweep DB stamp
    // then reuses this same map (no second collection).
    const roleTitles = new Map();   // courted_mls_id -> 'Team Leader' | 'Managing Broker' | both
    const roleMeta = new Map();     // courted_mls_id -> { id, email } fallback match keys
    let rolesReady = false;         // only stamp rows once a collection has succeeded
    let buffer = [];
    let sent = 0;
    const flush = async () => {
        if (!sendToDb || !buffer.length) return;
        const batch = buffer; buffer = [];
        try {
            const r = await ingestRows(source, batch);
            sent += r.received;
            emit(job, 'progress', { source, status: 'running', message: `Saved ${sent.toLocaleString()} to database…` });
        } catch (err) {
            // ingestRows already retried internally; if it STILL failed, don't drop
            // the rows — re-queue them so the next flush retries. Upserts are
            // idempotent, so a re-send is safe. This stalls scraping (backpressure)
            // until the DB app recovers rather than losing agents (a 502 previously
            // silently dropped 1,000 rows).
            buffer = batch.concat(buffer);
            log.warning(`DB save failed (${batch.length} rows) — re-queued for retry: ${err.message}`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    };

    // Shared page handlers — ONE instance reused across every account/MLS sweep so
    // the cross-account de-dupe (`seen`) and the DB flush buffer are shared.
    const shouldStop = () => job.aborted || reachedCap();
    const onRecord = async (row) => {
        if (reachedCap()) return;
        const cid = String(row['Courted Agent ID'] || '').trim();
        if (cid) allCourtedIds.add(cid); // record before dedupe so cross-account ids are all captured
        if (rolesReady && cid) {
            // Stamp the role onto the row itself so the ingest payload carries it
            // (per MLS): the app populates its checkbox fields from these columns.
            const rt = roleTitles.get(cid) || '';
            row.Title = rt || 'Salesperson';
            row['Is Team Leader'] = rt.includes('Team Leader') ? 'Yes' : 'No';
            row['Is Managing Broker'] = rt.includes('Managing Broker') ? 'Yes' : 'No';
        }
        const key = personKey(row);
        if (key && seen.has(key)) return; // already seen on another account/MLS
        if (key) seen.add(key);
        emit(job, 'record', { source, row });
        pushed += 1;
        if (sendToDb) {
            buffer.push(row);
            if (buffer.length >= FLUSH_SIZE) await flush(); // backpressure
        }
    };
    const onMeta = ({ total: t }) => {
        total += t || 0;
        emit(job, 'meta', { source, total });
    };

    // Run ONE sweep for one account, optionally scoped to a single MLS code via
    // the server-side `mls_id=<CODE>` filter (mlsCode=null → whole account).
    const runOneSweep = async (acc, tag, mlsCode) => {
        const extraParams = mlsCode ? { mls_id: mlsCode } : {};
        const scopeTag = mlsCode ? `${tag ? `${tag} · ` : ''}MLS ${mlsCode}` : tag;

        // Banded full sweep: log in once, plan volume/state segments (each under
        // the deep-offset wall) — scoped to the MLS when filtering — then hand
        // them to the scraper.
        let session = null;
        let segments = null;
        if (useBands) {
            emit(job, 'progress', { source, status: 'running', message: `Planning segments — ${scopeTag || 'account'}…` });
            session = await login(acc.email, acc.password);
            segments = await buildSegments(session, {
                safeMax: SEGMENT_MAX,
                log,
                delayMs: Number(process.env.COURTED_DELAY_MS) || 350,
                extraParams,
            });
            emit(job, 'progress', { source, status: 'running', message: `${segments.length} segments planned — ${scopeTag || 'scraping'}…` });
        }

        // Collect role titles FIRST (per-MLS scoped lists — small, page fully)
        // so the sweep's rows carry Title + the Is Team Leader / Is Managing
        // Broker checkboxes natively. A collection failure never blocks the
        // sweep — rows then keep the default title and the post-sweep stamp is
        // skipped for safety.
        if (stampTitles) {
            try {
                emit(job, 'progress', { source, status: 'running', message: `Collecting role titles — ${scopeTag || 'account'}…` });
                if (!session) session = await login(acc.email, acc.password);
                const m = await collectRoleTitleMap(session, { delayMs: Number(process.env.COURTED_DELAY_MS) || 500, log, extraParams });
                for (const [id, t] of m) roleTitles.set(id, t);
                if (m.meta) for (const [id, info] of m.meta) roleMeta.set(id, info);
                rolesReady = true;
                log.info(`Role titles collected — ${m.size.toLocaleString()} leaders/brokers (${scopeTag || 'account'}).`);
            } catch (e) {
                log.warning(`Role-title collection failed (${scopeTag || acc.email}) — rows keep default title: ${e.message}`);
            }
        }

        await runScrape(
            {
                email: acc.email,
                password: acc.password,
                session,                  // reuse login from segment planning (null → scraper logs in)
                segments,                 // null → flat offset sweep (non-banded)
                locations: searchLocations,
                extraParams,              // scopes location/flat sweeps to the MLS too
                maxRecords: 0,            // cap is enforced across accounts below
                maxRecordsPerLocation: 0,
                minSalesVolume: minSalesVolume || 0,
                enrichProfiles: Boolean(courtedEnrich),
                // Pace between page/profile requests — raise COURTED_DELAY_MS for
                // big full-account runs to stay well under any rate limit.
                delayMs: Number(process.env.COURTED_DELAY_MS) || 350,
            },
            { log, shouldStop, onRecord, onMeta },
        );

        // Post-sweep DB stamp: reuse the pre-collected role map (no second
        // collection) and PATCH `title` on the agents this sweep touched —
        // covers rows that predate this sweep's ingest. Best-effort; a tagging
        // hiccup never fails the sweep.
        if (stampTitles && rolesReady) {
            try {
                emit(job, 'progress', { source, status: 'running', message: `Tagging roles (Team Leader / Managing Broker) — ${scopeTag || 'account'}…` });
                const scoped = new Map();
                for (const [id, title] of roleTitles) if (allCourtedIds.has(id)) scoped.set(id, title);
                const n = await stampCourtedTitles(scoped, roleMeta);
                if (n) log.info(`Tagged ${n.toLocaleString()} role titles — ${scopeTag || 'account'}.`);
            } catch (e) {
                log.warning(`Role-title tagging skipped (${scopeTag || acc.email}): ${e.message}`);
            }
        }
    };

    try {
        for (let i = 0; i < accounts.length; i += 1) {
            if (job.aborted || reachedCap()) break;
            const acc = accounts[i];
            const tag = accounts.length > 1 ? `account ${i + 1}/${accounts.length} (${acc.email})` : '';
            emit(job, 'progress', { source, status: 'running', message: accounts.length > 1 ? `Signing in — ${tag}…` : 'Signing in…' });

            try {
                // Whole account = a single sweep with no MLS filter; otherwise one
                // server-side-filtered sweep per selected MLS code.
                const codes = mlsIds.length ? mlsIds : [null];
                for (const code of codes) {
                    if (job.aborted || reachedCap()) break;
                    // Cool off before planning any sweep except the very first of
                    // the run — planning right after a heavy scrape is when Courted
                    // returns garbage counts. Applies between accounts AND between
                    // an account's MLS codes.
                    if (useBands && firstSweepDone) await new Promise((r) => setTimeout(r, 20000));
                    firstSweepDone = true;
                    await runOneSweep(acc, tag, code);
                }
            } catch (err) {
                // One bad account shouldn't kill the whole source — log and move on.
                errors.push(`${acc.email}: ${err.message}`);
                log.warning(`Courted ${tag || acc.email} failed: ${err.message}`);
            }
            await flush(); // ship this account's remainder before the next account
        }
        await flush(); // final remainder
        // We streamed to the DB ourselves — tell the job layer not to bulk-send again.
        if (sendToDb) job.sources[source].selfIngested = true;

        const accLabel = accounts.length > 1 ? ` from ${accounts.length} accounts` : '';
        const dbLabel = sendToDb ? ` · ${sent.toLocaleString()} saved to DB` : '';
        const capped = cap > 0 && pushed >= cap;
        let message = capped
            ? `${pushed} of ${total.toLocaleString()} (capped at ${cap})${accLabel}${dbLabel}`
            : `${pushed} unique agents${accLabel}${dbLabel}`;
        if (errors.length && pushed === 0) {
            return emit(job, 'source_error', { source, message: `All Courted accounts failed — ${errors[0]}` });
        }
        if (errors.length) message += ` · ${errors.length} account(s) failed`;
        emit(job, 'source_done', { source, message });
    } catch (err) {
        emit(job, 'source_error', { source, message: err.message });
    } finally {
        engineFinished(job);
    }
}
