// export-mls-csv.mjs — one-off: pull ONE MLS of ONE Courted account via the
// private agent_search API (NOT the Export-to-CSV feature) and write a CSV to
// ~/Downloads. Read-only against Courted; writes nothing to the DB.
//
// Env:
//   TARGET_EMAIL   which account (matched against COURTED_EMAIL / _2.._20)
//   MLS_MATCH      regex matched against each MLS name OR code (default 'har')
//   MLS_CODE       force an exact MLS code (skips matching) — used after detect
//   DETECT_ONLY=1  just list the account's MLS(s) + counts, then exit
//
// Run with the account creds injected (never printed):
//   DETECT_ONLY=1 TARGET_EMAIL=eddy@brokerstaffer.com \
//     railway run --service agent-search -- node courted/export-mls-csv.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { login } from './src/auth.js';
import { detectAccountMls } from './src/mls.js';
import { buildSegments } from './src/segments.js';
import { runScrape } from './src/scraper.js';
import { OUTPUT_COLUMNS } from './src/constants.js';

// --- accounts (same shape as web/server readCourtedAccounts) -----------------
function readAccounts() {
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
    for (let i = 2; i <= 20; i += 1) add(process.env[`COURTED_EMAIL_${i}`], process.env[`COURTED_PASSWORD_${i}`]);
    return out;
}

const TARGET_EMAIL = (process.env.TARGET_EMAIL || 'eddy@brokerstaffer.com').trim().toLowerCase();
const MLS_MATCH = process.env.MLS_MATCH || 'har';
const MLS_CODE = (process.env.MLS_CODE || '').trim();
const DETECT_ONLY = /^(1|true|yes|on)$/i.test(String(process.env.DETECT_ONLY || ''));

function csvCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
    const accounts = readAccounts();
    const acc = accounts.find((a) => a.email.toLowerCase().includes(TARGET_EMAIL))
        || accounts.find((a) => a.email.toLowerCase() === TARGET_EMAIL);
    if (!acc) {
        console.error(`No account matching "${TARGET_EMAIL}". Loaded ${accounts.length} account(s): ${accounts.map((a) => a.email).join(', ')}`);
        process.exit(1);
    }
    console.log(`Account: ${acc.email}`);
    const session = await login(acc.email, acc.password);
    console.log('Authenticated. Enumerating MLS(s)…');
    const { total, mls } = await detectAccountMls(session, { thorough: true });
    console.log(`Account total agents (any MLS): ${total.toLocaleString()} · ${mls.length} MLS(s):`);
    for (const m of mls) console.log(`   ${m.code.padEnd(16)} ${String(m.count).padStart(8)}  ${m.name}`);

    // Which MLS are we after?
    let target = null;
    if (MLS_CODE) {
        target = mls.find((m) => m.code.toLowerCase() === MLS_CODE.toLowerCase());
        if (!target) { console.error(`\nMLS_CODE "${MLS_CODE}" not on this account.`); process.exit(1); }
    } else {
        const re = new RegExp(MLS_MATCH, 'i');
        const hits = mls.filter((m) => re.test(m.name) || re.test(m.code));
        console.log(`\nCandidates matching /${MLS_MATCH}/i:`);
        for (const m of hits) console.log(`   ${m.code.padEnd(16)} ${String(m.count).padStart(8)}  ${m.name}`);
        if (hits.length === 1) target = hits[0];
        else if (hits.length > 1) { console.error('\nMultiple matches — re-run with MLS_CODE=<the exact code>.'); if (!DETECT_ONLY) process.exit(2); }
        else { console.error('\nNo match — widen MLS_MATCH or pass MLS_CODE.'); if (!DETECT_ONLY) process.exit(2); }
    }

    if (DETECT_ONLY) { if (target) console.log(`\nWould export: ${target.code} — ${target.name} (${target.count.toLocaleString()} agents)`); return; }

    // --- full scoped pull ----------------------------------------------------
    const code = target.code;
    const stamp = new Date().toISOString().slice(0, 10);
    const safeEmail = acc.email.replace(/[^a-z0-9]+/gi, '_');
    const out = path.join(os.homedir(), 'Downloads', `courted_${safeEmail}_${code}_${stamp}.csv`);
    const keysPath = `${out}.keys`; // sidecar: one dedupe key per line (resume-safe)
    console.log(`\nExporting MLS ${code} — ${target.name} (~${target.count.toLocaleString()} agents) → ${out}`);
    const extraParams = { mls_id: code };

    // Rows are streamed to disk as they arrive (header first), so a crash / teardown
    // never loses the whole pull. A sidecar .keys file lets a re-run RESUME: we load
    // the keys already captured and append only new agents (no duplicate rows).
    const seen = new Set();
    const keyOf = (r) => String(r['Courted Agent ID'] || r['Courted ID'] || r['Email'] || `${r['Name']}|${r['Office']}`).trim().toLowerCase();
    let resumed = 0;
    if (fs.existsSync(keysPath)) {
        for (const k of fs.readFileSync(keysPath, 'utf8').split('\n')) {
            const t = k.trim(); if (t) { seen.add(t); resumed += 1; }
        }
        if (resumed) console.log(`Resuming — ${resumed.toLocaleString()} agent(s) already captured; appending only new ones.`);
    }

    const segments = await buildSegments(session, {
        safeMax: Number(process.env.SEGMENT_MAX) || 15000,
        log: console,
        delayMs: Number(process.env.COURTED_DELAY_MS) || 350,
        extraParams,
    });
    console.log(`${segments.length} segment(s) planned.`);

    const fresh = !(fs.existsSync(out) && fs.statSync(out).size > 0);
    const ws = fs.createWriteStream(out, { encoding: 'utf8', flags: fresh ? 'w' : 'a' });
    const ks = fs.createWriteStream(keysPath, { encoding: 'utf8', flags: fresh ? 'w' : 'a' });
    if (fresh) ws.write(OUTPUT_COLUMNS.map(csvCell).join(',') + '\n');
    let n = resumed;
    const onRecord = (row) => {
        const k = keyOf(row);
        if (k && seen.has(k)) return;
        if (k) seen.add(k);
        ws.write(OUTPUT_COLUMNS.map((c) => csvCell(row[c])).join(',') + '\n');
        if (k) ks.write(k + '\n');
        n += 1;
        if (n % 1000 === 0) console.log(`   …${n.toLocaleString()} unique agents`);
    };
    await runScrape(
        {
            email: acc.email, password: acc.password, session,
            segments, locations: [], extraParams,
            maxRecords: 0, maxRecordsPerLocation: 0, minSalesVolume: 0,
            enrichProfiles: false,
            delayMs: Number(process.env.COURTED_DELAY_MS) || 350,
        },
        { log: console, shouldStop: () => false, onRecord, onMeta: () => {} },
    );
    await new Promise((res) => ws.end(res));
    await new Promise((res) => ks.end(res));
    console.log(`\n✅ ${n.toLocaleString()} unique agents → ${out}`);
}

main().catch((e) => { console.error('FAILED:', e.stack || e.message); process.exit(1); });
