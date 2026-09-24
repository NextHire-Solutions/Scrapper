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
// The dataset has no license column, so license isn't used to skip here. Name is
// NOT a match key either — but it IS a veto (see below). Chunked in.() queries
// scale with the dataset size, not the 1.1M-row table.
//
// ── Why a name veto (the "already in the database" false positives) ────────────
// An identifier is only as strong as it is personal. ~0.34% of the phones in
// `agents` are shared by two or more DIFFERENT agents — office and team lines
// (one 615 number carries 11 distinct names). A dataset row whose phone is the
// brokerage's main line would match a stranger's row and be dropped as "already
// in the database", losing a genuinely new agent. Office emails (info@…) do the
// same, just more rarely. So a hit is confirmed against the matched row's name:
//   • unique email hit                  → skip (a personal email is conclusive)
//   • shared identifier (>1 DB name)    → skip ONLY if the names agree
//   • phone-only hit, name unknown      → skip only when that phone is unique
//   • names positively disagree         → NOT a match; scrape it
// Every skip records WHICH identifier matched and WHOSE row it hit, so the UI can
// say "matched email · Tanya Spotts (courted)" instead of an unverifiable note.
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

// ── Name comparison (a veto on weak identifier hits, never a match key) ────────
// Names are compared loosely on purpose: the dataset and the DB spell the same
// person differently ("M. Denise Watts" / "Denise Watts", "Bob" / "Robert").
// Only a clear LAST-name conflict counts as a disagreement.
export function normName(v) {
    return String(v || '')
        .toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\b(jr|sr|ii|iii|iv|md|phd|realtor|abr|crs|gri|pa|llc|inc)\b/g, ' ')
        .replace(/[^a-z\s'-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
function lastName(v) {
    const parts = normName(v).split(' ').filter((p) => p.length > 1);
    return parts.length ? parts[parts.length - 1] : '';
}

/**
 * Do these two names plausibly belong to the same person?
 * @returns {boolean|null} true = agree, false = conflict, null = can't tell
 *   (either side blank / single-token), which callers treat as "not a veto".
 */
export function nameAgrees(a, b) {
    const na = normName(a);
    const nb = normName(b);
    if (!na || !nb) return null;
    if (na === nb) return true;
    const la = lastName(a);
    const lb = lastName(b);
    if (!la || !lb) return null;
    if (la === lb) return true;
    // One name contained in the other ("denise watts" ⊂ "m denise watts").
    if (na.includes(nb) || nb.includes(na)) return true;
    return false;
}

/** nameAgrees() against a set of candidate names: agreement with ANY wins. */
function nameAgreesAny(name, names) {
    let verdict = null;
    for (const n of names) {
        const v = nameAgrees(name, n);
        if (v === true) return true;
        if (v === false) verdict = false;
    }
    return verdict;
}

/**
 * Stricter test, used to CONFIRM a match on a shared identifier (an office line
 * that several agents answer). There, surnames alone prove nothing — a desk with
 * "Emily Williams" and "Clayton Williams" on it would otherwise swallow whichever
 * one is genuinely new. Requires the surname AND a compatible first name (equal,
 * an initial, or a prefix: "Kate"/"Katherine").
 * Being strict here is the cheap direction: a row we wrongly treat as new is
 * re-merged by the ingest webhook's own license→email→phone dedup, whereas a row
 * we wrongly skip is lost from the import entirely.
 */
export function nameMatchesStrict(a, b) {
    if (nameAgrees(a, b) !== true) return false;
    const fa = normName(a).split(' ')[0] || '';
    const fb = normName(b).split(' ')[0] || '';
    if (!fa || !fb) return false;
    if (fa === fb) return true;
    const [short, long] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
    if (short.length === 1) return long.startsWith(short);   // "k moore" / "kate moore"
    return long.startsWith(short);                           // "kate" / "katherine"
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

// Record one DB row against an identifier key. Several rows can carry the same
// key (a shared office line), so each key keeps the set of names behind it —
// that's what tells a personal identifier from a switchboard.
function register(hits, key, row) {
    let hit = hits.get(key);
    if (!hit) {
        hit = { rows: [], names: new Set() };
        hits.set(key, hit);
    }
    if (!hit.rows.some((r) => r.id === row.id)) {
        hit.rows.push({ id: row.id, name: row.full_name || '', sources: row.sources || [] });
    }
    if (row.full_name) hit.names.add(row.full_name);
    return hit;
}

// Which of the rows behind an identifier does this skip actually refer to? On a
// shared line that's the one whose name agrees — reporting the first row instead
// would name a stranger and make the skip look like the bug it isn't.
function bestRow(name, hit) {
    return hit.rows.find((r) => nameMatchesStrict(name, r.name))
        || hit.rows.find((r) => nameAgrees(name, r.name) === true)
        || hit.rows[0];
}

/**
 * Look up which of these normalized rows already exist in `agents`.
 * @returns {Promise<Map<string,{id,name,sources,names:Set<string>}>>} keyed by
 *   "e:<email>" / "p:<10digits>" — the matched row(s) behind each identifier.
 */
async function loadMatches(list) {
    const emails = [...new Set(list.map((x) => x._email).filter(Boolean))];
    const phones = [...new Set(list.map((x) => x._phoneE164).filter(Boolean))];
    const hits = new Map();
    const SELECT = 'id,full_name,sources';

    for (const grp of chunk(emails, CHUNK)) {
        const inList = grp.map(enc).join(',');
        const rows = await sbGet(
            `agents?or=(preferred_email.in.(${inList}),enriched_email.in.(${inList}))&select=${SELECT},preferred_email,enriched_email`,
        );
        for (const r of rows) {
            if (r.preferred_email) register(hits, `e:${normEmail(r.preferred_email)}`, r);
            if (r.enriched_email) register(hits, `e:${normEmail(r.enriched_email)}`, r);
        }
    }
    for (const grp of chunk(phones, CHUNK)) {
        const rows = await sbGet(`agents?preferred_phone=in.(${grp.map(enc).join(',')})&select=${SELECT},preferred_phone`);
        for (const r of rows) register(hits, `p:${normPhone(r.preferred_phone)}`, r);
    }
    // Also match the app's own `phone:<10 digits>` dedup key. The 1.1M rows do NOT
    // all store E.164 — a Realtor-sourced row keeps the display format
    // "(202) 253-1251", which the preferred_phone.in.() query above can't see. The
    // match_key is format-independent, so this catches the rows that would
    // otherwise be re-scraped and MERGED into (the additive-only rule's failure
    // mode), not just skipped.
    for (const grp of chunk(phones.map((p) => `phone:${normPhone(p)}`), CHUNK)) {
        const rows = await sbGet(`agents?match_key=in.(${grp.map(enc).join(',')})&select=${SELECT},match_key`);
        for (const r of rows) register(hits, `p:${String(r.match_key).slice(6)}`, r);
    }
    return hits;
}

/**
 * Confirm (or veto) an identifier hit against the matched row's name.
 * @param {string} name the dataset row's name ('' when the input is a bare URL)
 * @param {'email'|'phone'} by which identifier hit
 * @param {{names:Set<string>}} hit the DB row(s) behind that identifier
 * @returns {boolean} true = genuinely already in the DB
 */
function confirmHit(name, by, hit) {
    const unique = hit.names.size <= 1;
    if (by === 'email' && unique) return true;      // a personal email is conclusive
    if (!unique) {
        // Shared identifier — only a strict name match proves it's the same person.
        return [...hit.names].some((n) => nameMatchesStrict(name, n));
    }
    const agree = nameAgreesAny(name, hit.names);
    if (agree === true) return true;
    if (agree === false) return false;              // different person, same number
    return true;                                    // no name to judge by — trust a unique hit
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
        // Email first (the stronger identifier), then phone. The first hit the
        // name confirms wins and is recorded on the row for the UI.
        const candidates = [
            it._email ? ['email', hits.get(`e:${it._email}`)] : null,
            it._phone ? ['phone', hits.get(`p:${it._phone}`)] : null,
        ].filter((c) => c && c[1]);
        let match = null;
        for (const [by, hit] of candidates) {
            if (confirmHit(it.name, by, hit)) {
                const r = bestRow(it.name, hit);
                match = { by, id: r.id, name: r.name, sources: r.sources, shared: hit.names.size > 1 };
                break;
            }
        }
        if (match) skipped.push({ ...it, _match: match });
        else toScrape.push(it);
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
 * A phone-only hit is confirmed against the scraped NAME for the same reason the
 * pre-filter does it — the number may be the office's, not the agent's.
 * @param {object} row a scraped native Zillow/Realtor row
 * @returns {Promise<{by:string,id:string,name:string,sources:string[]}|null>}
 *   the matched existing row, or null if this agent is genuinely new
 */
export async function findExisting(row) {
    if (!dbEnabled() || !row) return null;
    const email = validEmail(row.Email) ? normEmail(row.Email) : '';
    const lic = licenseKey(row['License Number']);
    const phones = new Set();
    for (const raw of [row.Phone, row['Mobile Phone']]) {
        const d = normPhone(raw);
        if (validPhone10(d)) phones.add(d);
    }
    const ors = [];
    if (email) ors.push(`preferred_email.eq.${enc(email)}`, `enriched_email.eq.${enc(email)}`);
    if (lic) ors.push(`license_number.eq.${enc(lic)}`);
    ors.push(...phoneKeys(row));
    if (!ors.length) return null;

    let rows;
    try {
        rows = await sbGet(
            // The limit has to clear the biggest shared line in the table — one 615
            // number is on 580 rows — or the candidates truncate away the row whose
            // name agrees and a returning agent gets re-scraped as new.
            `agents?or=(${ors.join(',')})&select=id,full_name,sources,license_number,preferred_email,enriched_email,preferred_phone,match_key&limit=1000`,
        );
    } catch {
        return null;                   // a DB hiccup must never drop a real agent
    }
    if (!rows.length) return null;

    const name = row.Name;
    const phoneOnly = [];
    for (const r of rows) {
        // License is the DB app's own dedup key — an exact hit means re-sending
        // this agent would MERGE into that row, so it's conclusive.
        if (lic && normLicense(r.license_number) === normLicense(lic)) {
            return { by: 'license', id: r.id, name: r.full_name || '', sources: r.sources || [] };
        }
        if (email && (normEmail(r.preferred_email) === email || normEmail(r.enriched_email) === email)) {
            return { by: 'email', id: r.id, name: r.full_name || '', sources: r.sources || [] };
        }
        const mk = String(r.match_key || '');
        if (phones.has(normPhone(r.preferred_phone)) || (mk.startsWith('phone:') && phones.has(mk.slice(6)))) {
            phoneOnly.push(r);
        }
    }
    if (!phoneOnly.length) return null;
    // Phone-only: same rule as the pre-filter — a shared line needs the names to
    // agree, a unique one is trusted unless the names positively conflict.
    const hit = {
        names: new Set(phoneOnly.map((r) => r.full_name).filter(Boolean)),
        rows: phoneOnly.map((r) => ({ id: r.id, name: r.full_name || '', sources: r.sources || [] })),
    };
    if (!confirmHit(name, 'phone', hit)) return null;
    const best = bestRow(name, hit);
    return { by: 'phone', id: best.id, name: best.name, sources: best.sources };
}

/** Back-compat boolean wrapper around findExisting(). */
export async function isAlreadyPresent(row) {
    return Boolean(await findExisting(row));
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
export async function stampCourtedTitles(titleById, meta = null) {
    if (!dbEnabled() || !titleById) return 0;
    // Group ids by title so each PATCH sets a single value.
    const byTitle = new Map();
    const personByTitle = new Map();   // title -> [person-level courted_id]
    const emailByTitle = new Map();    // title -> [email]
    for (const [id, title] of titleById) {
        if (!id || !title) continue;
        if (!byTitle.has(title)) byTitle.set(title, []);
        byTitle.get(title).push(String(id));
        const info = meta && meta.get ? meta.get(id) : null;
        if (info && info.id) {
            if (!personByTitle.has(title)) personByTitle.set(title, []);
            personByTitle.get(title).push(String(info.id));
        }
        if (info && info.email) {
            if (!emailByTitle.has(title)) emailByTitle.set(title, []);
            emailByTitle.get(title).push(info.email);
        }
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

    // Fallback passes — a leader's row is often merged under ANOTHER MLS's (or
    // source's) key, so the per-MLS agent_id above can't reach it. Match by the
    // person-level courted_id, then by email. Both are UPGRADE-ONLY (they touch
    // only rows still Salesperson/null), so they can never downgrade a title
    // someone earned in a different MLS.
    stamped += await upgradeOnly(personByTitle, (grp) => `source_ids->courted->>id=in.(${grp.map(enc).join(',')})`);
    stamped += await upgradeOnly(emailByTitle, (grp) => `or=(preferred_email.in.(${grp.map(enc).join(',')}),enriched_email.in.(${grp.map(enc).join(',')}))`);
    return stamped;
}

// PATCH `title` on rows matching the built filter, but ONLY where the row has no
// real title yet. Chunked + retried; best-effort like the primary pass.
async function upgradeOnly(byTitle, buildFilter) {
    let n = 0;
    for (const [title, keys] of byTitle) {
        for (const grp of chunk([...new Set(keys)], 80)) {
            for (let t = 0; t < 3; t += 1) {
                if (t) await new Promise((r) => setTimeout(r, 1500 * t));
                try {
                    await sbPatch(`agents?${buildFilter(grp)}&or=(title.eq.Salesperson,title.is.null)`, { title });
                    n += grp.length;
                    break;
                } catch { /* retry, then give up on this chunk */ }
            }
        }
    }
    return n;
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
