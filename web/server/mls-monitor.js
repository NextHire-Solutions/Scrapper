// mls-monitor.js — automatic ("Option B") MLS watch. On a schedule, log into
// EVERY configured Courted account, enumerate its MLS(s), and compare against the
// last-seen list stored server-side (Supabase table `mls_monitor_state`). Post a
// Slack alert when an account GAINS or LOSES an MLS — or when it fails to log in
// (a stale password would otherwise look like "everything removed"). A GAINED
// MLS is then auto-swept immediately (scoped to that MLS + account) so its
// agents land without waiting for the 15-day refresh turn. Fully env-gated and
// never throws into the caller.
//
// Env:
//   MLS_MONITOR_ENABLED=1            turn the scheduler on (default off)
//   MLS_MONITOR_AUTOSWEEP=0          disable the auto-sweep of newly-added MLSs (default on)
//   MLS_MONITOR_INTERVAL_HOURS=24    scan cadence (default 24)
//   SLACK_BOT_TOKEN / SLACK_CHANNEL_ID   where alerts go (until set, alerts log)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY   baseline store (from db.js)

import { login } from '../../courted/src/auth.js';
import { detectAccountMls } from '../../courted/src/mls.js';
import { readCourtedAccounts, runCourted } from './engines/courted.js';
import { createJob } from './jobs.js';

const STATE_TABLE = 'mls_monitor_state';

export function monitorEnabled() {
    return /^(1|true|yes|on)$/i.test(String(process.env.MLS_MONITOR_ENABLED || ''));
}
function dbEnabled() {
    return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}
function intervalMs() {
    const h = Number(process.env.MLS_MONITOR_INTERVAL_HOURS);
    return (Number.isFinite(h) && h > 0 ? h : 24) * 3600 * 1000;
}

// --- baseline store (Supabase PostgREST; one row per account) ----------------
async function sb(pathAndQuery, init = {}) {
    const base = process.env.SUPABASE_URL.replace(/\/+$/, '');
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const res = await fetch(`${base}/rest/v1/${pathAndQuery}`, {
        ...init,
        headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
    });
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res;
}

/** email(lowercased) -> { email, mls:[{code,name,count}], total, scanned_at } */
export async function loadBaseline() {
    if (!dbEnabled()) return {};
    const rows = await (await sb(`${STATE_TABLE}?select=email,mls,total,scanned_at`)).json();
    const out = {};
    for (const r of rows) out[String(r.email).toLowerCase()] = r;
    return out;
}

async function saveBaselineRow(email, total, mls) {
    if (!dbEnabled()) return;
    const now = new Date().toISOString();
    await sb(`${STATE_TABLE}?on_conflict=email`, {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify([{ email: email.toLowerCase(), total, mls, scanned_at: now, updated_at: now }]),
    });
}

function logStoreErr(err) {
    if (/mls_monitor_state.* does not exist|42P01/i.test(err.message)) {
        console.error('[mls-monitor] baseline table missing — run the mls_monitor_state block in web/server/schema.sql.');
    } else {
        console.error('[mls-monitor] store:', err.message);
    }
}

// --- diff + scan -------------------------------------------------------------
const codesOf = (mls) => new Set((mls || []).map((m) => m.code));

function diffAccount(baseRow, mls) {
    const before = codesOf(baseRow && baseRow.mls);
    const after = codesOf(mls);
    return {
        hadBaseline: Boolean(baseRow),
        added: [...after].filter((c) => !before.has(c)),
        removed: [...before].filter((c) => !after.has(c)),
    };
}

/**
 * Scan every account, diff vs baseline, alert on change / login-failure, then
 * persist the fresh baseline — but ONLY for accounts that scanned cleanly, so a
 * transient failure or stale password can never wipe an account's history or
 * fire a false "removed".
 */
export async function runScan({ reason = 'scheduled' } = {}) {
    const accounts = readCourtedAccounts();
    if (!accounts.length) return { ok: false, message: 'No Courted accounts configured.' };

    let baseline = {};
    if (dbEnabled()) { try { baseline = await loadBaseline(); } catch (e) { logStoreErr(e); } }

    const results = [];
    const changes = [];   // { email, added, removed, count }
    const failures = [];  // { email, error }
    for (const acc of accounts) {
        const email = acc.email;
        try {
            const session = await login(acc.email, acc.password);
            const { total, mls } = await detectAccountMls(session, { thorough: true });
            const d = diffAccount(baseline[email.toLowerCase()], mls);
            results.push({ email, total, mls: mls.length, added: d.added, removed: d.removed });
            if (d.hadBaseline && (d.added.length || d.removed.length)) {
                changes.push({ email, added: d.added, removed: d.removed, count: mls.length });
            }
            try { await saveBaselineRow(email, total, mls); } catch (e) { logStoreErr(e); }
        } catch (err) {
            failures.push({ email, error: err.message });
            results.push({ email, error: err.message });
        }
    }

    let alerted = false;
    if (changes.length || failures.length) {
        try { alerted = (await notifySlack(formatAlert(changes, failures, reason))).delivered; }
        catch (e) { console.error('[mls-monitor] slack:', e.message); }
    }

    // Auto-sweep newly-ADDED MLSs right away (scoped to just that MLS on just
    // that account) so their agents land in the DB immediately instead of
    // waiting for the account's 15-day refresh turn. Detached + serial so the
    // scan/endpoint returns fast and sweeps never overlap each other. Set
    // MLS_MONITOR_AUTOSWEEP=0 to disable. Removed MLSs need no action (data is
    // additive; nothing is deleted).
    const toSweep = changes.filter((c) => c.added.length);
    if (toSweep.length && autosweepEnabled()) {
        (async () => {
            for (const c of toSweep) {
                const acc = accounts.find((a) => a.email.toLowerCase() === c.email.toLowerCase());
                if (!acc) continue;
                try {
                    const job = createJob({
                        sources: ['courted'],
                        courtedAllAgents: true,      // full sweep of the selected MLS(s)
                        courtedBanded: true,
                        courtedOnly: [acc.email],
                        courtedMlsIds: [...c.added],
                    });
                    job.pending = 1;
                    await runCourted(job);
                    const s = job.sources.courted || {};
                    const line = s.status === 'error'
                        ? `*Courted MLS monitor* — ⚠️ auto-sweep of new MLS ${c.added.join(', ')} (*${c.email}*) failed: ${s.message || 'unknown error'}`
                        : `*Courted MLS monitor* — ✅ auto-sweep of new MLS ${c.added.join(', ')} (*${c.email}*) done: ${(s.count || 0).toLocaleString()} agents captured.`;
                    await notifySlack(line).catch(() => {});
                } catch (e) {
                    await notifySlack(`*Courted MLS monitor* — ⚠️ auto-sweep of new MLS ${c.added.join(', ')} (*${c.email}*) failed: ${e.message}`).catch(() => {});
                }
            }
        })();
    }
    return { ok: true, scanned: accounts.length, changes: changes.length, failures: failures.length, alerted, autosweeping: autosweepEnabled() ? toSweep.length : 0, results };
}

function autosweepEnabled() {
    return !/^(0|false|no|off)$/i.test(String(process.env.MLS_MONITOR_AUTOSWEEP ?? '1'));
}

// --- Slack -------------------------------------------------------------------
function formatAlert(changes, failures, reason) {
    const when = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const L = [`*Courted MLS monitor* — ${reason}, ${when} UTC`];
    for (const c of changes) {
        const parts = [];
        if (c.added.length) parts.push(`➕ added ${c.added.join(', ')}`);
        if (c.removed.length) parts.push(`➖ removed ${c.removed.join(', ')}`);
        L.push(`• *${c.email}* — ${parts.join('   ')}  _(now ${c.count} MLS)_`);
    }
    for (const f of failures) {
        L.push(`• ⚠️ *${f.email}* — could not log in / scan: ${f.error}  _(baseline left unchanged)_`);
    }
    return L.join('\n');
}

export async function notifySlack(text) {
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = process.env.SLACK_CHANNEL_ID;
    if (!token || !channel) {
        console.log('[mls-monitor] ALERT (Slack not configured — set SLACK_BOT_TOKEN + SLACK_CHANNEL_ID):\n' + text);
        return { delivered: false };
    }
    const res = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel, text, mrkdwn: true }),
    });
    const data = await res.json().catch(() => ({}));
    if (!data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return { delivered: true, ts: data.ts };
}

// --- scheduler ---------------------------------------------------------------
let timer = null;
export function startMlsMonitor() {
    if (!monitorEnabled()) return { started: false, reason: 'MLS_MONITOR_ENABLED not set' };
    if (timer) return { started: true, already: true };
    if (!readCourtedAccounts().length) return { started: false, reason: 'no Courted accounts' };
    const every = intervalMs();
    const kick = () => runScan({ reason: 'scheduled' }).catch((e) => console.error('[mls-monitor] scan:', e.message));
    setTimeout(kick, 60 * 1000);          // first sweep a minute after boot
    timer = setInterval(kick, every);
    const slack = process.env.SLACK_CHANNEL_ID ? 'Slack configured' : 'Slack NOT configured yet (alerts will log)';
    console.log(`  MLS monitor:   ON — every ${every / 3600000}h · ${slack}`);
    return { started: true, everyHours: every / 3600000 };
}
