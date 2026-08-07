// roles.js — derive each agent's role title from Courted's server-side
// `at_type_includes` filter. That filter is the ONLY place Courted exposes the
// team-leader / managing-broker classification without a per-agent detail
// fetch, so it lets a plain (enrichment-off) sweep still learn each agent's
// role. Shared by the one-time backfill (courted/backfill-titles.mjs is a
// standalone twin) and the live engine's post-sweep title stamp so future
// sweeps keep `title` correct instead of defaulting everyone to Salesperson.

import { buildSearchQuery, fetchSearchPage } from './api.js';
import { DEFAULT_STATUSES, sleep } from './constants.js';
import { detectAccountMls } from './mls.js';

const PAGE = 500;                 // API honors up to 500/page → ~10× fewer requests
// We only need courted_mls_id, so strip the heavy contact/annotate work: fewer,
// lighter requests = smaller footprint (deliberately gentle, never flagged).
const LEAN = {
    include_broker_company_prospect_data: 'false',
    annotate_mutual_connection_info: 'false',
    annotate_watchlists_in: 'false',
    annotate_last_re_activity_date: 'false',
};

// Page one role filter (at_type_includes=<value>) STRICTLY SERIAL with a polite
// jittered delay between pages — slow on purpose so an account never looks like
// a burst/scraper and never gets rate-limited.
async function collectIds(session, value, { delayMs = 500, log, extraParams = {} } = {}) {
    const ids = new Set();
    let offset = 0;
    let total = null;
    for (;;) {
        const q = buildSearchQuery({
            limit: PAGE, offset, statuses: DEFAULT_STATUSES, includeContactInfo: false,
            // extraParams (e.g. { mls_id }) scopes the role paging to one MLS so a
            // single-MLS sweep doesn't page the whole account's leaders/brokers.
            extraParams: { ...LEAN, ...extraParams, at_type_includes: value },
        });
        let d;
        try {
            d = await fetchSearchPage(session, q);
        } catch (e) {
            // Paging one past the last page returns 400 "offset exceeds total
            // results" — that's simply the end of the list, not an error.
            if (/exceeds total/i.test(e.message)) break;
            // Otherwise retry once after a longer pause before giving up on this
            // list (a transient blip shouldn't abandon the rest of the pages).
            await sleep(3000);
            try {
                d = await fetchSearchPage(session, q);
            } catch (e2) {
                if (/exceeds total/i.test(e2.message)) break;
                if (log) log.warning?.(`  role "${value}" page@${offset}: ${e2.message}`);
                break;
            }
        }
        if (total === null) total = Number.isFinite(d.count) ? d.count : 0;
        const rows = d.results || [];
        rows.forEach((r) => r.courted_mls_id && ids.add(r.courted_mls_id));
        offset += PAGE;
        if (log) log.debug?.(`  role "${value}": ${ids.size}/${total}`);
        // Stop ONLY at the true end of the list. The old check also bailed on the
        // first short page (rows.length < PAGE), which quit mid-list and skipped
        // whole MLSs on big accounts — the root cause of missing titles.
        if (rows.length === 0 || offset >= total) break;
        await sleep(delayMs + Math.floor(Math.random() * 300));
    }
    return ids;
}

/**
 * Build a `courted_mls_id → title` map for one logged-in account. ONLY team
 * leaders and managing brokers get a title; someone who is both gets a single
 * comma-joined value ("Managing Broker, Team Leader") that a "contains" filter
 * finds under either role. Everyone else is absent from the map (they keep
 * their existing "Salesperson"). The join key equals the stored
 * source_ids.courted.agent_id.
 * @returns {Promise<Map<string,string>>}
 */
export async function collectRoleTitleMap(session, opts = {}) {
    const extraParams = opts.extraParams || {};
    // Already scoped to one MLS → its leader/broker list is small and pages fully.
    if (extraParams.mls_id) return collectScoped(session, opts);
    // Whole account: the account-wide role list mixes every MLS and is far too
    // large to page reliably. Enumerate the account's MLS codes and tag EACH one
    // scoped by mls_id — every per-MLS list is small enough to page to the end,
    // so no MLS gets skipped.
    const { mls } = await detectAccountMls(session, { thorough: true });
    const map = new Map();
    for (const m of mls) {
        const sub = await collectScoped(session, { ...opts, extraParams: { ...extraParams, mls_id: m.code } });
        for (const [id, title] of sub) map.set(id, title);
        await sleep(1500);
    }
    return map;
}

// Tag the leaders/brokers visible under the given opts (scoped by opts.extraParams).
async function collectScoped(session, opts = {}) {
    const tl = await collectIds(session, 'at_team_leader', opts);
    await sleep(1500);
    const mb = await collectIds(session, 'at_manager_managing_broker', opts);
    const map = new Map();
    for (const id of new Set([...tl, ...mb])) {
        const parts = [];
        if (mb.has(id)) parts.push('Managing Broker');
        if (tl.has(id)) parts.push('Team Leader');
        map.set(id, parts.join(', '));
    }
    return map;
}
