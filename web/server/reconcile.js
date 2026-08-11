// reconcile.js — F1 cross-check against the client's `agents` table.
//
// This is the ONLY file that touches the client's Supabase (project
// wiybrtexmohfaukadpmb). The target is the merged `agents` table (~773k rows):
//   full_name, license_number, preferred_email, preferred_phone (E.164 +1…),
//   office_name/brand, office_state … plus the app's own match_key/sources.
//
// ── Flow (dataset-first, additive-only) ────────────────────────────────────────
// The client's Zillow/Realtor datasets carry identifiers, so we cross-check
// BEFORE scraping and only scrape agents that aren't already in the DB:
//   reconcile(rows) → { toScrape[], skipped[] }
//     • skipped  = already in `agents` (matched by email/phone) → NEVER touched
//     • toScrape = not found → engine scrapes them → INSERT NEW only
// Per the standing rule "do not change existing columns or data", existing rows
// are read-only: no enrich-fill-empty, no source_url backfill onto them.
//
// ── Matching (read-only) ───────────────────────────────────────────────────────
// Skip an agent only on a STRONG identifier hit:
//   • email  → preferred_email OR enriched_email (normalized, case-insensitive)
//   • phone  → preferred_phone (last-10 digits; DB stores +1E.164)
// The dataset has no license column, so license/name aren't used to skip here
// (a wrong fuzzy match would wrongly drop a real new agent). Name is available
// for later review only. Chunked in.() queries scale with the dataset size, not
// the 773k-row table.
//
// ── Write path (chosen: the existing ingest webhook) ───────────────────────────
// New agents are written by the engine via ingest.js (the app's proven
// license→email→phone merge), so imports land identical to live scrapes. Before
// sending, the engine calls isAlreadyPresent() below — a SECOND (post-scrape)
// cross-check on the scraped email/phone — so an existing agent the pre-filter
// couldn't see is skipped, never merged into. Existing rows are never modified.

import { normalizeUrl } from './profile-parser.js';

/** True once the Supabase connection is configured (matches db.js convention). */
export function dbEnabled() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

// ── Identity normalizers ───────────────────────────────────────────────────────
export function normLicense(v) {
    return String(v || '').toUpperCase().replace(/[\s-]+/g, '').trim();
}
export function normPhone(v) {
    const d = String(v || '').replace(/\D+/g, '');
    return d.length >= 10 ? d.slice(-10) : '';
}
export function normEmail(v) {
    return String(v || '').trim().toLowerCase();
}

// Reject junk/placeholder identifiers so they never cause a false "already in DB"
// skip. The table holds 100+ rows of +10000000000, a handful of +11111111111,
// etc. — a dataset row carrying 000-000-0000 must NOT match those and get
// wrongly dropped (insert-new-only means a false skip loses a real agent).
export function validPhone10(d) {
    if (!/^\d{10}$/.test(d)) return false;
    if (/^(\d)\1{9}$/.test(d)) return false;      // all one digit
    return d[0] >= '2' && d[3] >= '2';            // NANP: area + exchange start 2-9
}
export function validEmail(e) {
    return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(e || '').trim());
}

// A license is a usable identifier only if it's a plausible number/alnum code
// (>=4 chars, not all zeros) — guards against blanks and junk like "0"/"N/A".
// Returned value is matched EXACTLY against license_number, which is the DB
// app's own dedup key ('lic:<number>'), so an exact hit means "already merged
// there". Returns '' when there's nothing safe to match on.
export function licenseKey(v) {
    const s = String(v || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{3,}$/.test(s)) return '';
    if (/^0+$/.test(s)) return '';
    return s;
}

// ── Supabase PostgREST read helper ─────────────────────────────────────────────
const CHUNK = 80;
const enc = encodeURIComponent;
function chunk(arr, n) {
    const out = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
}
async function sbGet(path) {
    const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(`${base}/rest/v1/${path}`, {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return res.json();
}
async function sbPatch(path, body) {
    const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(`${base}/rest/v1/${path}`, {
        method: 'PATCH',
        headers: {
            apikey: key,
            Authorization: `Bearer ${key}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal',
        },
        body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${(await res.text()).slice(0, 160)}`);
}

// Build phone-based match clauses for a scraped row. Uses BOTH the primary and
// mobile numbers and matches two ways: preferred_phone in E.164 (how the 773k
// existing rows store it) AND the app's own dedup key `phone:<10 digits>`, which
// is format-independent. The match_key form is what recognizes a license-less
// Realtor agent we already imported — Realtor gives no email/license and stores
// the phone in DISPLAY format `(334) 559-8450`, so an E.164-only check misses it.
function phoneKeys(row) {
    const clauses = [];
    const seen = new Set();
    for (const raw of [row.Phone, row['Mobile Phone']]) {
        const d = normPhone(raw);
        if (!validPhone10(d) || seen.has(d)) continue;
        seen.add(d);
        clauses.push(`preferred_phone.eq.${enc(`+1${d}`)}`);
        clauses.push(`match_key.eq.${enc(`phone:${d}`)}`);
    }
    return clauses;
}

/**
 * Look up which of these normalized rows already exist in `agents`.
 * @returns {Promise<Set<string>>} set of matched email/phone keys ("e:<email>" / "p:<10digits>")
 */
async function loadMatches(list) {
    const emails = [...new Set(list.map((x) => x._email).filter(Boolean))];
    const phones = [...new Set(list.map((x) => x._phoneE164).filter(Boolean))];
    const hits = new Set();

    for (const grp of chunk(emails, CHUNK)) {
        const inList = grp.map(enc).join(',');
        const rows = await sbGet(
            `agents?or=(preferred_email.in.(${inList}),enriched_email.in.(${inList}))&select=preferred_email,enriched_email`,
        );
        for (const r of rows) {
            if (r.preferred_email) hits.add(`e:${normEmail(r.preferred_email)}`);
            if (r.enriched_email) hits.add(`e:${normEmail(r.enriched_email)}`);
        }
    }
    for (const grp of chunk(phones, CHUNK)) {
        const rows = await sbGet(`agents?preferred_phone=in.(${grp.map(enc).join(',')})&select=preferred_phone`);
        for (const r of rows) hits.add(`p:${normPhone(r.preferred_phone)}`);
    }
    return hits;
}

/**
 * Cross-check imported rows against the DB. With no DB configured, everything is
 * queued to scrape. Never throws into the caller — a DB hiccup degrades to
 * "scrape all" rather than dropping the run.
 * @param {{url:string, source:string, email?:string, phone?:string}[]} items
 * @returns {Promise<{toScrape:object[], skipped:object[], counts:{present:number,absent:number}, db:boolean, error?:string}>}
 */
export async function reconcile(items) {
    const list = items.map((it) => {
        const p10raw = normPhone(it.phone);
        const p10 = validPhone10(p10raw) ? p10raw : '';        // drop junk phones
        const email = validEmail(it.email) ? normEmail(it.email) : '';
        return {
            ...it,
            urlKey: normalizeUrl(it.url),
            _email: email,
            _phone: p10,
            _phoneE164: p10 ? `+1${p10}` : '',
        };
    });

    if (!dbEnabled()) {
        return { toScrape: list, skipped: [], counts: { present: 0, absent: list.length }, db: false };
    }

    let hits;
    try {
        hits = await loadMatches(list);
    } catch (err) {
        // Degrade safely: scrape everything rather than lose the run.
        return { toScrape: list, skipped: [], counts: { present: 0, absent: list.length }, db: true, error: err.message };
    }

    const toScrape = [];
    const skipped = [];
    for (const it of list) {
        const present = (it._email && hits.has(`e:${it._email}`)) || (it._phone && hits.has(`p:${it._phone}`));
        (present ? skipped : toScrape).push(it);
    }
    return { toScrape, skipped, counts: { present: skipped.length, absent: toScrape.length }, db: true };
}

/**
 * Stage-2 (post-scrape) cross-check. A dataset row the pre-filter couldn't match
 * (no/blank email+phone in the dataset) often YIELDS an email/phone once scraped.
 * Re-check those against `agents` so an existing agent is still skipped rather
 * than sent to the webhook (which would merge into — i.e. modify — a live row).
 * Read-only; returns false on any hiccup so a genuinely-new agent is never
 * wrongly dropped. License IS used here as a strong key: the DB app dedups on
 * `lic:<number>`, so an exact license hit means re-sending this agent would MERGE
 * into that existing row — skipping is both correct AND protects the existing row.
 * (Realtor rows carry a license but usually no email, and their phone is stored
 * in display format, so email/phone alone would miss a re-import.)
 * @param {object} row a scraped native Zillow/Realtor row
 * @returns {Promise<boolean>} true if this agent already exists in the DB
 */
export async function isAlreadyPresent(row) {
    if (!dbEnabled() || !row) return false;
    const email = validEmail(row.Email) ? normEmail(row.Email) : '';
    const lic = licenseKey(row['License Number']);
    const ors = [];
    if (email) ors.push(`preferred_email.eq.${enc(email)}`, `enriched_email.eq.${enc(email)}`);
    if (lic) ors.push(`license_number.eq.${enc(lic)}`);
    ors.push(...phoneKeys(row));
    if (!ors.length) return false;
    try {
        const rows = await sbGet(`agents?or=(${ors.join(',')})&select=id&limit=1`);
        return rows.length > 0;
    } catch {
        return false;
    }
}

/**
 * Stamp just-inserted NEW agents with their source profile link.
 *
 * The write path (ingest webhook) doesn't map the profile URL into agents, so we
 * fill `source_url` ourselves right after the ingest confirms the rows. This is
 * purely ADDITIVE and only ever runs on agents we just created:
 *   • matches the agent by the same email/phone we sent (never by license/name)
 *   • the `source_url=is.null` filter means we ONLY fill an empty cell — a real
 *     link is never overwritten, and no other column is ever touched
 * Best-effort: a per-row failure is swallowed so a tag miss can never fail or
 * duplicate the import. Rows with neither a valid email nor phone are left
 * untagged (nothing safe to match on). Returns how many rows were stamped.
 * @param {object[]} rows native scraped rows already sent to the ingest webhook
 * @returns {Promise<number>}
 */
/**
 * Stamp the Courted role title (Team Leader / Managing Broker / both) onto
 * matching agents, keyed by Courted's courted_mls_id == stored
 * source_ids.courted.agent_id. Purely ADDITIVE and title-ONLY:
 *   • never touches any other column
 *   • idempotent — re-running sets the same value
 *   • agents absent from the map are left as-is (they keep "Salesperson")
 * This is how a plain (enrichment-off) Courted sweep keeps `title` correct
 * going forward — the app's ingest can't derive the role, so we write it here.
 * Best-effort: a per-chunk failure is swallowed so a title miss never fails or
 * duplicates a sweep. Returns how many ids were stamped.
 * @param {Map<string,string>|Iterable<[string,string]>} titleById
 * @returns {Promise<number>}
 */
export async function stampCourtedTitles(titleById) {
    if (!dbEnabled() || !titleById) return 0;
    // Group ids by title so each PATCH sets a single value.
    const byTitle = new Map();
    for (const [id, title] of titleById) {
        if (!id || !title) continue;
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push(String(id));
    }
    let stamped = 0;
    let failed = 0;
    for (const [title, ids] of byTitle) {
        for (const grp of chunk(ids, 100)) {
            // Retry each chunk a few times — a silently dropped chunk leaves a
            // pocket of agents untitled (how AGSMLS lost 186 of its leaders).
            let ok = false;
            for (let t = 0; t < 4 && !ok; t += 1) {
                if (t) await new Promise((r) => setTimeout(r, 1500 * t));
                try {
                    await sbPatch(`agents?source_ids->courted->>agent_id=in.(${grp.map(enc).join(',')})`, { title });
                    ok = true;
                } catch { /* retry */ }
            }
            if (ok) stamped += grp.length;
            else failed += grp.length;
        }
    }
    if (failed) console.error(`[stampCourtedTitles] ${failed} ids FAILED to stamp after retries (stamped ${stamped})`);
    return stamped;
}

export async function tagSourceUrls(rows) {
    if (!dbEnabled() || !Array.isArray(rows) || !rows.length) return 0;
    let tagged = 0;
    for (const row of rows) {
        const url = String(row['Zillow Profile URL'] || row['Realtor Profile URL'] || '').trim();
        if (!url) continue;
        const email = validEmail(row.Email) ? normEmail(row.Email) : '';
        const lic = licenseKey(row['License Number']);
        const ors = [];
        if (email) ors.push(`preferred_email.eq.${enc(email)}`, `enriched_email.eq.${enc(email)}`);
        if (lic) ors.push(`license_number.eq.${enc(lic)}`);
        ors.push(...phoneKeys(row));
        if (!ors.length) continue;                 // no safe identifier — skip
        try {
            await sbPatch(`agents?or=(${ors.join(',')})&source_url=is.null`, { source_url: url });
            tagged += 1;
        } catch { /* best-effort — a tag miss never fails the import */ }
    }
    return tagged;
}
