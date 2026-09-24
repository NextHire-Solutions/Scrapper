// app.js — frontend: kick off a search, stream results into live tables.

const SOURCES = ['courted', 'zillow', 'realtor'];

// Compact "key columns" view (toggle). The FULL column set is loaded from the
// server and is the default.
const KEY_COLS = {
    courted: [
        'Name', 'Office', 'Email', 'Phone', 'Years Of Experience',
        'LTM Sales Volume', 'Sales Volume Change %', 'LTM Closed Units',
        'Active Listings', 'Most Transacted City', 'MLS', 'State License',
    ],
    zillow: [
        'Name', 'Brokerage', 'Phone', 'Email', 'Rating', 'Review Count',
        'Total Sales Count', 'Average Price', 'For Sale Count', 'Location',
        'Zillow Profile URL',
    ],
    realtor: [
        'Name', 'Office', 'Phone', 'Mobile Phone', 'Rating', 'Review Count',
        'Years Of Experience', 'For Sale Count', 'Sold Count', 'Combined Price Range',
        'License Number', 'Served Areas', 'Realtor Profile URL',
    ],
};

// Full column lists from the server (fallback to KEY_COLS until loaded).
let ALL_COLS = {
    courted: [...KEY_COLS.courted], zillow: [...KEY_COLS.zillow], realtor: [...KEY_COLS.realtor],
};
let showAllCols = true; // default: show every column
const DISPLAY_COLS = () => (showAllCols ? ALL_COLS : KEY_COLS);

fetch('/api/columns')
    .then((r) => r.json())
    .then((cols) => { if (cols && cols.courted) ALL_COLS = cols; })
    .catch(() => {});

// Header status badge — what's connected.
fetch('/api/status')
    .then((r) => r.json())
    .then((s) => {
        const env = document.getElementById('env');
        if (!env) return;
        const ok = (label, on) => `<span class="${on ? 'ok' : 'bad'}">${on ? '●' : '○'} ${label}</span>`;
        const courtedLabel = s.courtedAccounts > 1 ? `Courted · ${s.courtedAccounts} accts` : 'Courted';
        env.innerHTML = `${ok(courtedLabel, s.courted)} &nbsp; ${ok(`Unblocker${s.unblocker ? ' · ' + s.unblocker : ''}`, !!s.unblocker)}`;
    })
    .catch(() => {});

const URL_COLS = new Set(['Zillow Profile URL', 'Courted Profile URL', 'Realtor Profile URL', 'Profile Photo URL', 'Website URL', 'Facebook URL', 'Instagram URL', 'LinkedIn URL', 'Twitter URL', 'YouTube URL', 'TikTok URL']);
const MONEY_COLS = new Set(['LTM Sales Volume', 'LTM Est GCI', 'LTM Avg Sale Price', 'YTD Sales Volume']);

const $ = (id) => document.getElementById(id);
let currentJob = null;
let pollTimer = null;
const totals = {};   // matched-count per source
const rowData = {};  // raw rows kept for re-render on toggle
const serverCount = {}; // server-side fetched count (full-sweep streams to DB, not the table)
for (const s of SOURCES) { totals[s] = null; rowData[s] = []; serverCount[s] = 0; }

let running = false;
$('searchBtn').addEventListener('click', () => (running ? stopSearch() : startSearch()));

function stopSearch() {
    if (currentJob) fetch(`/api/search/${currentJob}/stop`, { method: 'POST' }).catch(() => {});
    if (pollTimer) clearTimeout(pollTimer);
    running = false;
    $('searchBtn').textContent = 'Search';
    $('searchBtn').classList.remove('stopping');
    for (const s of SOURCES) {
        const pill = $(`status-${s}`);
        if (pill && /running|queued/.test(pill.textContent)) setStatus(s, 'done', 'stopped');
    }
}
$('showAll').addEventListener('change', (e) => {
    showAllCols = e.target.checked;
    for (const src of SOURCES) rerender(src);
});

// Rebuild a whole table (header + all rows) from stored data — used on toggle.
function rerender(source) {
    const cols = DISPLAY_COLS()[source];
    $(`table-${source}`).querySelector('thead').innerHTML =
        '<tr>' + cols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    const tbody = $(`table-${source}`).querySelector('tbody');
    tbody.innerHTML = rowData[source]
        .map((row) => '<tr>' + cols.map((c) => `<td title="${escapeAttr(row[c])}">${cell(c, row[c])}</td>`).join('') + '</tr>')
        .join('');
}
document.querySelectorAll('[data-export]').forEach((btn) => {
    btn.addEventListener('click', () => {
        if (currentJob) window.location = `/api/search/${currentJob}/export?source=${btn.dataset.export}`;
    });
});

function startSearch() {
    // Split on NEW LINES / semicolons only — NOT commas (a "City, ST" has a comma).
    const locations = $('locations').value
        .split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
    const courtedAllAgents = $('courtedAllAgents').checked;
    if (!locations.length && !courtedAllAgents) { alert('Enter at least one location or ZIP (or tick Courted “All agents”).'); return; }

    const sources = SOURCES.filter((s) => $(`src-${s}`).checked);
    if (!sources.length) { alert('Select at least one source.'); return; }

    const body = {
        locations,
        sources,
        courtedMax: +$('courtedMax').value || 0,
        minSalesVolume: +$('minSalesVolume').value || 0,
        courtedEnrich: $('courtedEnrich').checked,
        courtedAllAgents,
        zillowMaxPages: +$('zillowMaxPages').value || 25,
        zillowConcurrency: +$('zillowConcurrency').value || 4,
        zillowEnrich: $('zillowEnrich').checked,
        realtorMax: +$('realtorMax').value || 0,
        realtorConcurrency: +$('realtorConcurrency').value || 3,
        realtorEnrich: $('realtorEnrich').checked,
    };

    resetUi(sources);
    running = true;
    $('searchBtn').textContent = 'Stop';
    $('searchBtn').classList.add('stopping');

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then((r) => r.json())
        .then((res) => {
            if (res.error) throw new Error(res.error);
            currentJob = res.jobId;
            openStream(res.jobId);
        })
        .catch((err) => {
            alert(err.message);
            running = false;
            $('searchBtn').textContent = 'Search';
            $('searchBtn').classList.remove('stopping');
        });
}

// Poll for results (robust — SSE/EventSource was dropping the realtor record
// burst after long fetches). Asks only for rows we haven't rendered yet.
function openStream(jobId) { poll(jobId); }

function poll(jobId) {
    const q = SOURCES.map((s) => `${s}=${rowData[s].length}`).join('&');
    fetch(`/api/search/${jobId}/results?${q}`)
        .then((r) => r.json())
        .then((d) => {
            if (d.error) { finishRun(); return; }
            for (const s of SOURCES) {
                const sc = d.sources[s];
                if (!sc) continue;
                if (sc.total != null) totals[s] = sc.total;
                if (sc.count != null) serverCount[s] = sc.count;
                for (const row of (sc.newRows || [])) addRow({ source: s, row });
                if (sc.status && sc.status !== 'pending') {
                    setStatus(s, sc.status, sc.message, sc.status === 'error');
                    if (sc.status === 'done' || sc.status === 'error') enableExport(s);
                }
                updateCount(s);
            }
            if (d.status !== 'running') { finishRun(); return; }
            if (running) pollTimer = setTimeout(() => poll(jobId), 1500);
        })
        .catch(() => { if (running) pollTimer = setTimeout(() => poll(jobId), 2000); });
}

function finishRun() {
    running = false;
    $('searchBtn').textContent = 'Search';
    $('searchBtn').classList.remove('stopping');
    $('stopAcctBtn').style.display = 'none'; // add-account sweep finished
    $('addAcctBtn').disabled = false;
    // Enable the master-list builder once a job has produced rows.
    const anyRows = SOURCES.some((s) => rowData[s].length);
    $('buildMaster').disabled = !(currentJob && anyRows);
}

// --- Master (deduplicated) list ---
let masterCols = [];
$('buildMaster').addEventListener('click', buildMaster);
$('exportMaster').addEventListener('click', () => {
    if (currentJob) window.location = `/api/search/${currentJob}/export?source=master`;
});

function buildMaster() {
    if (!currentJob) return;
    $('buildMaster').disabled = true;
    $('masterStats').textContent = 'Analyzing & matching agents across platforms…';
    fetch(`/api/search/${currentJob}/master`)
        .then((r) => r.json())
        .then((d) => {
            if (d.error) throw new Error(d.error);
            masterCols = d.columns;
            renderMaster(d.rows);
            const s = d.stats;
            $('masterStats').innerHTML =
                `<b>${s.unique.toLocaleString()}</b> unique agents `
                + `&nbsp;·&nbsp; <b>${s.duplicatesRemoved.toLocaleString()}</b> duplicates merged `
                + `&nbsp;·&nbsp; <b>${s.multiPlatform.toLocaleString()}</b> found on 2+ platforms `
                + `&nbsp;<span class="hint">(from ${s.totalScraped.toLocaleString()} scraped — `
                + `Courted ${s.bySource.courted}, Zillow ${s.bySource.zillow}, Realtor ${s.bySource.realtor})</span>`;
            $('exportMaster').disabled = d.rows.length === 0;
            $('buildMaster').disabled = false;
            $('buildMaster').textContent = 'Rebuild master list';
        })
        .catch((err) => {
            $('masterStats').textContent = 'Master build failed: ' + err.message;
            $('buildMaster').disabled = false;
        });
}

function renderMaster(rows) {
    $('table-master').querySelector('thead').innerHTML =
        '<tr>' + masterCols.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    $('table-master').querySelector('tbody').innerHTML = rows.map((row) => {
        const pc = Number(row['Platform Count']) || 1;
        const cls = pc > 1 ? ' class="multi"' : '';
        return `<tr${cls}>` + masterCols.map((c) => `<td title="${escapeAttr(row[c])}">${cell(c, row[c])}</td>`).join('') + '</tr>';
    }).join('');
}

function resetUi(sources) {
    showAllCols = $('showAll').checked;
    for (const src of SOURCES) {
        totals[src] = null;
        rowData[src] = [];
        serverCount[src] = 0;
        const active = sources.includes(src);
        $(`panel-${src}`).style.opacity = active ? '1' : '0.4';
        $(`table-${src}`).querySelector('thead').innerHTML =
            '<tr>' + DISPLAY_COLS()[src].map((c) => `<th>${c}</th>`).join('') + '</tr>';
        $(`table-${src}`).querySelector('tbody').innerHTML = '';
        $(`count-${src}`).textContent = '0';
        $(`msg-${src}`).textContent = '';
        $(`msg-${src}`).classList.remove('error');
        setStatus(src, active ? 'queued' : 'idle', '');
        document.querySelector(`[data-export="${src}"]`).disabled = true;
    }
}

function addRow({ source, row }) {
    rowData[source].push(row);
    const tbody = $(`table-${source}`).querySelector('tbody');
    const cols = DISPLAY_COLS()[source];
    const tr = document.createElement('tr');
    tr.className = 'new';
    tr.innerHTML = cols.map((c) => `<td title="${escapeAttr(row[c])}">${cell(c, row[c])}</td>`).join('');
    tbody.appendChild(tr);
    updateCount(source);
    setTimeout(() => tr.classList.remove('new'), 1000);
}

// Count badge shows "fetched / total" once the matched total is known.
function updateCount(source) {
    const rendered = $(`table-${source}`).querySelector('tbody').children.length;
    const n = Math.max(rendered, serverCount[source] || 0); // full-sweep: rows go to DB, not the table
    const total = totals[source];
    $(`count-${source}`).textContent = (total != null && total !== n)
        ? `${n.toLocaleString()} / ${total.toLocaleString()}`
        : n.toLocaleString();
}

function cell(col, val) {
    if (val == null || val === '') return '';
    if (URL_COLS.has(col)) return `<a href="${escapeAttr(val)}" target="_blank">link</a>`;
    if (MONEY_COLS.has(col) && /^\d+$/.test(String(val))) return '$' + Number(val).toLocaleString();
    return escapeHtml(String(val));
}

function setStatus(source, status, message, isError) {
    const pill = $(`status-${source}`);
    if (pill) { pill.textContent = status; pill.className = `pill ${status}`; }
    if (message != null) {
        const m = $(`msg-${source}`);
        m.textContent = message;
        m.classList.toggle('error', !!isError);
    }
}

function enableExport(source) {
    const n = $(`table-${source}`).querySelector('tbody').children.length;
    document.querySelector(`[data-export="${source}"]`).disabled = n === 0;
}

function escapeHtml(s) { return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

// --- Add a new Courted account, save it to Railway, then auto-sweep it ---
$('addAcctBtn').addEventListener('click', addAccount);
$('stopAcctBtn').addEventListener('click', () => {
    stopSearch();
    $('stopAcctBtn').style.display = 'none';
    $('addAcctBtn').disabled = false;
    setAcctMsg('Sweep stopped. Everything scraped so far is saved — you can re-add to resume.');
});

function setAcctMsg(text, isError) {
    const m = $('acctMsg');
    m.textContent = text;
    m.classList.toggle('error', !!isError);
}

// --- Detect the MLS(s) of an account so the user can import only some of them ---
$('detectMlsBtn').addEventListener('click', detectMls);

async function detectMls() {
    const email = $('acctEmail').value.trim();
    const password = $('acctPassword').value;
    if (!email || !password) { setAcctMsg('Enter the Courted email and password first.', true); return; }
    const btn = $('detectMlsBtn');
    const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Detecting…';
    setAcctMsg('Signing in and reading this account’s MLSs — a few seconds…');
    try {
        const r = await fetch('/api/courted/mls-list', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'request failed');
        renderMlsPicker(d);
        const n = (d.mls || []).length;
        setAcctMsg(`Found ${n} MLS${n === 1 ? '' : 's'}. Tick the one(s) to import, or keep “Whole account”.`);
    } catch (err) {
        setAcctMsg('Detect failed: ' + err.message, true);
    } finally {
        btn.disabled = false; btn.textContent = label;
    }
}

// An MLS with no name whose code is a Courted-internal CTD_ bucket isn't a real
// MLS — it's a custom/manually-added list inside Courted. Relabel it so it reads
// clearly instead of showing a raw hex code.
function mlsDisplayName(m) {
    const name = String(m.name || '').trim();
    if ((!name || name === m.code) && /^CTD_/i.test(m.code)) return 'Custom list (Courted)';
    return name || m.code;
}

// Render the "whole account vs specific MLS(s)" picker. Whole account and the
// per-MLS boxes are mutually exclusive; leaving it untouched = whole account.
function renderMlsPicker(d) {
    const picker = $('mlsPicker');
    const total = (d.total || 0).toLocaleString();
    const rows = (d.mls || []).map((m) =>
        `<label class="chk small mls-row"><input type="checkbox" class="mls-opt" data-code="${escapeAttr(m.code)}" /> <b>${escapeHtml(mlsDisplayName(m))}</b> <span class="hint">${escapeHtml(m.code)} · ${(m.count || 0).toLocaleString()} agents</span></label>`
    ).join('');
    picker.innerHTML =
        '<div class="mls-head">Choose what to import from this account:</div>' +
        `<label class="chk small mls-row"><input type="checkbox" id="mls-all" checked /> <b>Whole account</b> <span class="hint">${total} agents — everything</span></label>` +
        (rows || '<div class="hint">No individual MLSs detected — import the whole account.</div>');
    picker.style.display = '';

    const all = $('mls-all');
    const opts = [...picker.querySelectorAll('.mls-opt')];
    all.addEventListener('change', () => { if (all.checked) opts.forEach((o) => { o.checked = false; }); });
    opts.forEach((o) => o.addEventListener('change', () => {
        if (o.checked) all.checked = false;
        if (!opts.some((x) => x.checked)) all.checked = true; // never leave nothing selected
    }));
}

// [] = whole account (picker absent, or "Whole account" ticked); else the codes.
function getSelectedMlsCodes() {
    const picker = $('mlsPicker');
    if (!picker || picker.style.display === 'none') return [];
    if ($('mls-all')?.checked) return [];
    return [...picker.querySelectorAll('.mls-opt:checked')].map((c) => c.dataset.code).filter(Boolean);
}

async function addAccount() {
    const email = $('acctEmail').value.trim();
    const password = $('acctPassword').value;
    if (!email || !password) { setAcctMsg('Enter the Courted email and password.', true); return; }
    const mlsIds = getSelectedMlsCodes();

    $('addAcctBtn').disabled = true;
    setAcctMsg('Validating login & saving the account…');
    try {
        const r = await fetch('/api/courted/account', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password }),
        });
        const d = await r.json();
        if (!r.ok || d.error) throw new Error(d.error || 'request failed');

        // Existing account, password changed → new password validated & saved, but
        // Railway is redeploying to apply it. Don't start the sweep on the current
        // (about-to-restart) instance; ask the user to re-run once it's back.
        if (d.already && d.updated) {
            setAcctMsg(`Password updated ✓ for ${email}. The server is redeploying to apply it (~1–2 min). Once it’s back, click “Add account & start sweep” again to run the sweep.`);
            $('addAcctBtn').disabled = false;
            $('acctPassword').value = '';
            return;
        }
        if (d.already) {
            setAcctMsg('Account already saved (password unchanged) — starting the sweep…');
        } else {
            setAcctMsg(`Saved (account #${d.slot}). Restarting the service to load it — ~1–2 min…`);
            await waitForAccounts(d.accountsExpected);
            setAcctMsg('Service is back up. Starting the sweep…');
        }
        startAccountSweep(email, mlsIds);
    } catch (err) {
        setAcctMsg('Failed: ' + err.message, true);
        $('addAcctBtn').disabled = false;
    }
}

// Poll /api/status until the new account is loaded (survives the redeploy gap).
function waitForAccounts(expected) {
    return new Promise((resolve) => {
        const tick = () => fetch('/api/status', { cache: 'no-store' })
            .then((r) => r.json())
            .then((s) => {
                if ((s.courtedAccounts || 0) >= expected) resolve();
                else setTimeout(tick, 5000);
            })
            .catch(() => setTimeout(tick, 5000)); // container down mid-redeploy → retry
        setTimeout(tick, 10000); // let the redeploy start before first poll
    });
}

function startAccountSweep(email, mlsIds) {
    const codes = Array.isArray(mlsIds) ? mlsIds : [];
    // Whole account, or one server-side-filtered sweep per selected MLS code.
    const body = { sources: ['courted'], courtedOnly: [email], courtedAllAgents: true, courtedBanded: true };
    if (codes.length) body.courtedMlsIds = codes;

    resetUi(['courted']);
    running = true;
    $('searchBtn').textContent = 'Stop';
    $('searchBtn').classList.add('stopping');

    fetch('/api/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
        .then((r) => r.json())
        .then((res) => {
            if (res.error) throw new Error(res.error);
            currentJob = res.jobId;
            $('addAcctBtn').disabled = false;
            $('stopAcctBtn').style.display = '';
            $('acctPassword').value = '';
            setAcctMsg(`Sweep started ✓ for ${email}${codes.length ? ' · MLS ' + codes.join(', ') : ' · whole account'} — live progress in the Courted panel below.`);
            openStream(res.jobId);
        })
        .catch((err) => {
            setAcctMsg('Sweep failed to start: ' + err.message, true);
            $('addAcctBtn').disabled = false;
            running = false;
            $('searchBtn').textContent = 'Search';
            $('searchBtn').classList.remove('stopping');
        });
}

// --- MLS monitor: scan all accounts, diff against a saved baseline ----------
// The baseline lives in this browser (localStorage). Scan → save baseline →
// re-scan later to see MLSs added to / removed from each account.
const MLS_BASELINE_KEY = 'mlsBaseline_v1';
let mlsScanId = null;
let mlsScanTimer = null;
let mlsLastScan = null; // accounts[] from the latest completed scan (for "Save as baseline")

$('mlsScanBtn').addEventListener('click', startMlsMonitorScan);
$('mlsScanStopBtn').addEventListener('click', stopMlsMonitorScan);
$('mlsBaselineBtn').addEventListener('click', saveMlsBaseline);
showBaselineInfo();

function setMlsScanMsg(t, isError) { const m = $('mlsScanMsg'); m.textContent = t || ''; m.classList.toggle('error', !!isError); }

function loadMlsBaseline() {
    try { return JSON.parse(localStorage.getItem(MLS_BASELINE_KEY) || 'null'); } catch { return null; }
}
function showBaselineInfo() {
    const b = loadMlsBaseline();
    $('mlsBaselineInfo').textContent = b ? `Baseline saved ${new Date(b.savedAt).toLocaleString()}` : 'No baseline yet — scan, then save one.';
}
// accounts[] → { email: { total, codes: { code: {name,count} } } }
function indexScan(accounts) {
    const out = {};
    for (const a of (accounts || [])) {
        if (a.error) continue; // don't baseline a failed account (would look "removed")
        const codes = {};
        for (const m of (a.mls || [])) codes[m.code] = { name: m.name, count: m.count };
        out[a.email] = { total: a.total || 0, codes };
    }
    return out;
}
function saveMlsBaseline() {
    if (!mlsLastScan) return;
    localStorage.setItem(MLS_BASELINE_KEY, JSON.stringify({ savedAt: Date.now(), accounts: indexScan(mlsLastScan) }));
    showBaselineInfo();
    setMlsScanMsg('Baseline saved ✓ — re-scan later to see what changed.');
    renderMlsScan({ status: 'done', done: mlsLastScan.length, total: mlsLastScan.length, accounts: mlsLastScan });
}

function startMlsMonitorScan() {
    $('mlsScanBtn').disabled = true;
    $('mlsBaselineBtn').disabled = true;
    setMlsScanMsg('Starting scan — this logs into every saved account, ~1–3 min…');
    $('mlsScanResults').innerHTML = '';
    fetch('/api/courted/mls-scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
        .then((r) => r.json())
        .then((d) => {
            if (d.error) throw new Error(d.error);
            mlsScanId = d.scanId;
            $('mlsScanStopBtn').style.display = '';
            pollMlsScan();
        })
        .catch((err) => { setMlsScanMsg('Scan failed to start: ' + err.message, true); $('mlsScanBtn').disabled = false; });
}
function stopMlsMonitorScan() {
    if (!mlsScanId) return;
    fetch(`/api/courted/mls-scan/${mlsScanId}/stop`, { method: 'POST' }).catch(() => {});
    setMlsScanMsg('Stopping…');
}
function pollMlsScan() {
    clearTimeout(mlsScanTimer);
    fetch(`/api/courted/mls-scan/${mlsScanId}`, { cache: 'no-store' })
        .then((r) => r.json())
        .then((d) => {
            if (d.error) throw new Error(d.error);
            renderMlsScan(d);
            if (d.status === 'running') { mlsScanTimer = setTimeout(pollMlsScan, 2000); return; }
            mlsLastScan = d.accounts || [];
            $('mlsScanBtn').disabled = false;
            $('mlsScanStopBtn').style.display = 'none';
            $('mlsBaselineBtn').disabled = false;
            const b = loadMlsBaseline();
            setMlsScanMsg(b ? `${d.message} Changes vs baseline are highlighted below.` : `${d.message} No baseline yet — click “Save as baseline”.`);
        })
        .catch((err) => {
            setMlsScanMsg('Scan error: ' + err.message, true);
            $('mlsScanBtn').disabled = false; $('mlsScanStopBtn').style.display = 'none';
        });
}
function renderMlsScan(d) {
    const base = loadMlsBaseline();
    const baseAcc = (base && base.accounts) || {};
    const parts = [`<div class="mls-scan-head">${d.done}/${d.total} account(s) scanned${d.status === 'running' ? ' — scanning…' : ''}</div>`];
    for (const a of (d.accounts || [])) {
        if (a.error) {
            parts.push(`<div class="mls-acct"><div class="mls-acct-head">${escapeHtml(a.email)} <span class="mls-err">— ${escapeHtml(a.error)}</span></div></div>`);
            continue;
        }
        const bcodes = (baseAcc[a.email] && baseAcc[a.email].codes) || null;
        const curCodes = new Set((a.mls || []).map((m) => m.code));
        const rows = (a.mls || []).map((m) => {
            const isNew = bcodes && !(m.code in bcodes);
            return `<div class="mls-line">${isNew ? '<span class="mls-badge add">+ added</span>' : ''}<b>${escapeHtml(mlsDisplayName(m))}</b> <span class="hint">${escapeHtml(m.code)} · ${(m.count || 0).toLocaleString()}</span></div>`;
        });
        if (bcodes) for (const code of Object.keys(bcodes)) {
            if (!curCodes.has(code)) rows.push(`<div class="mls-line removed"><span class="mls-badge rem">− removed</span><b>${escapeHtml(mlsDisplayName({ code, name: bcodes[code].name }))}</b> <span class="hint">${escapeHtml(code)}</span></div>`);
        }
        const changed = bcodes && ([...curCodes].some((c) => !(c in bcodes)) || Object.keys(bcodes).some((c) => !curCodes.has(c)));
        const n = (a.mls || []).length;
        const meta = changed ? ' · <b class="chg">changed</b>' : (bcodes ? ' · no change' : '');
        parts.push(`<div class="mls-acct${changed ? ' changed' : ''}"><div class="mls-acct-head">${escapeHtml(a.email)} <span class="hint">${(a.total || 0).toLocaleString()} agents · ${n} MLS${n === 1 ? '' : 's'}${meta}</span></div>${rows.join('')}</div>`);
    }
    $('mlsScanResults').innerHTML = parts.join('');
}

// --- F1: Import Profile URLs (enrichment) -----------------------------------
// Self-contained flow: resolve a G-Sheet/CSV to profile URLs, scrape + enrich
// each via /api/enrich, and stream progress. Independent of the search job.
const IMPORT_COLS = ['Status', 'Source', 'Name', 'Phone', 'Email', 'License', 'Profile URL', 'Note'];
let importJob = null;
let importPollTimer = null;
let importRunning = false;
let importRendered = 0;
let importJobMessage = '';

$('importFile').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { $('importCsv').value = reader.result || ''; setImportMsg(`Loaded ${file.name} — click Detect URLs.`); };
    reader.onerror = () => setImportMsg('Could not read that file.', true);
    reader.readAsText(file);
});
$('importResolveBtn').addEventListener('click', resolveImport);
$('importStartBtn').addEventListener('click', () => { if (!importRunning) startImport(); });
$('importStopBtn').addEventListener('click', stopImport);

function setImportMsg(text, isError) {
    const m = $('importMsg');
    m.textContent = text || '';
    m.classList.toggle('error', !!isError);
}
function importBody() {
    return { sheetUrl: $('importSheet').value.trim(), csv: $('importCsv').value };
}

function resolveImport() {
    const body = importBody();
    if (!body.sheetUrl && !body.csv.trim()) { setImportMsg('Paste a Google Sheet link or a CSV of profile URLs first.', true); return; }
    $('importResolveBtn').disabled = true;
    setImportMsg('Detecting profile URLs…');
    fetch('/api/enrich/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((r) => r.json())
        .then((d) => {
            $('importResolveBtn').disabled = false;
            if (d.error) throw new Error(d.error);
            if (!d.total) { setImportMsg('No Zillow or Realtor profile URLs found in that input.', true); $('importStartBtn').disabled = true; return; }
            $('importStartBtn').disabled = false;
            setImportMsg(`Found ${d.total.toLocaleString()} profile URLs — ${d.zillow.toLocaleString()} Zillow · ${d.realtor.toLocaleString()} Realtor · est. cost ~$${d.estCostUsd}. Click Start enrichment.`);
        })
        .catch((err) => { $('importResolveBtn').disabled = false; setImportMsg('Detect failed: ' + err.message, true); });
}

function startImport() {
    const body = importBody();
    body.concurrency = +$('importConcurrency').value || 4;
    if (!body.sheetUrl && !body.csv.trim()) { setImportMsg('Paste a Google Sheet link or a CSV of profile URLs first.', true); return; }

    resetImportUi();
    importRunning = true;
    $('importStartBtn').disabled = true;
    $('importResolveBtn').disabled = true;
    $('importStopBtn').style.display = '';
    setStatus('import', 'running', null);

    fetch('/api/enrich', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        .then((r) => r.json())
        .then((d) => {
            if (d.error) throw new Error(d.error);
            importJob = d.enrichId;
            const sched = $('importSchedule').checked
                ? ' Scheduled auto-runs will activate once the database connection is wired.' : '';
            setImportMsg(`Enriching ${d.total.toLocaleString()} profiles (${d.detected.zillow} Zillow · ${d.detected.realtor} Realtor) — est ~$${d.estCostUsd}.${sched}`);
            pollImport();
        })
        .catch((err) => { setImportMsg('Start failed: ' + err.message, true); finishImport('error'); });
}

function pollImport() {
    fetch(`/api/enrich/${importJob}?offset=${importRendered}`)
        .then((r) => r.json())
        .then((d) => {
            if (d.error) { finishImport('error'); return; }
            for (const row of (d.newRows || [])) addImportRow(row);
            importRendered += (d.newRows || []).length;
            updateImportProgress(d);
            importJobMessage = d.message || '';
            if (d.status !== 'running') { finishImport(d.status); return; }
            if (importRunning) importPollTimer = setTimeout(pollImport, 1500);
        })
        .catch(() => { if (importRunning) importPollTimer = setTimeout(pollImport, 2500); });
}

function updateImportProgress(d) {
    $('importProgress').style.display = '';
    const done = d.done || 0;
    const total = d.total || 0;
    const c = d.counts || {};
    $('importBarFill').style.width = (total ? Math.round((done / total) * 100) : 0) + '%';
    $('importStats').innerHTML =
        `<b>${done.toLocaleString()}</b> / ${total.toLocaleString()} processed &nbsp;·&nbsp; `
        + `<span class="tag">✓ scraped: <b>${(c.alive || 0).toLocaleString()}</b></span>`
        + (c.new ? `<span class="tag new">new: <b>${c.new.toLocaleString()}</b></span>` : '')
        + (c.enriched ? `<span class="tag enriched">enriched: <b>${c.enriched.toLocaleString()}</b></span>` : '')
        + (c.skipped ? `<span class="tag">skipped: <b>${c.skipped.toLocaleString()}</b></span>` : '')
        + `<span class="tag dead">dead: <b>${(c.dead || 0).toLocaleString()}</b></span>`
        + `<span class="tag error">blocked/err: <b>${((c.blocked || 0) + (c.error || 0)).toLocaleString()}</b></span>`
        + `&nbsp;·&nbsp; ~$${d.estCostUsd}`;
    if (importRunning) setStatus('import', 'running', null);
    $('count-import').textContent = done.toLocaleString();
}

// Human-readable reason for the rows that weren't written as new — so a blocked
// or errored URL explains itself in the table instead of only bumping a counter.
function importNote(r) {
    if (r.status === 'error') return r.message || 'scrape error';
    if (r.status === 'blocked') return 'blocked — page too small (likely CAPTCHA / anti-bot); retry later';
    if (r.status === 'dead') return 'no agent found on the page';
    if (r.status === 'skipped') {
        // Name the identifier AND the row it hit. "already in the database" on its
        // own can't be checked — and an agent who came in from Courted won't show
        // under the app's Zillow/Realtor tab, which reads as a false positive.
        const m = r.match;
        if (!m) return 'already in the database';
        const who = [m.name, (m.sources || []).join('/')].filter(Boolean).join(' · ');
        return `already in the database — matched ${m.by}${who ? ` → ${who}` : ''}`;
    }
    return r.message || '';
}

function importFields(r) {
    const row = r.row || {};
    const url = r.source === 'zillow' ? row['Zillow Profile URL'] : row['Realtor Profile URL'];
    return {
        Status: r.status,
        Source: r.source || '',
        Name: row['Name'] || '',
        Phone: row['Phone'] || row['Mobile Phone'] || '',
        Email: row['Email'] || '',
        License: row['License Number'] || '',
        'Profile URL': url || r.url || '',
        Note: importNote(r),
    };
}

function addImportRow(r) {
    $('panel-import').style.display = '';
    const f = importFields(r);
    const tbody = $('table-import').querySelector('tbody');
    const tr = document.createElement('tr');
    tr.className = 'new';
    tr.innerHTML = IMPORT_COLS.map((col) => {
        if (col === 'Status') return `<td class="st st-${escapeAttr(f.Status)}">${escapeHtml(String(f.Status))}</td>`;
        if (col === 'Profile URL') return f['Profile URL'] ? `<td><a href="${escapeAttr(f['Profile URL'])}" target="_blank">link</a></td>` : '<td></td>';
        const v = f[col] == null ? '' : String(f[col]);
        return `<td title="${escapeAttr(v)}">${escapeHtml(v)}</td>`;
    }).join('');
    tbody.appendChild(tr);
    setTimeout(() => tr.classList.remove('new'), 1000);
}

function resetImportUi() {
    importRendered = 0;
    $('panel-import').style.display = '';
    $('table-import').querySelector('thead').innerHTML =
        '<tr>' + IMPORT_COLS.map((c) => `<th>${c}</th>`).join('') + '</tr>';
    $('table-import').querySelector('tbody').innerHTML = '';
    $('count-import').textContent = '0';
    $('msg-import').textContent = '';
    $('importBarFill').style.width = '0%';
    $('importStats').innerHTML = '';
    $('importProgress').style.display = '';
}

function stopImport() {
    if (importJob) fetch(`/api/enrich/${importJob}/stop`, { method: 'POST' }).catch(() => {});
    setImportMsg('Stopping…');
}

function finishImport(status) {
    importRunning = false;
    if (importPollTimer) clearTimeout(importPollTimer);
    $('importStopBtn').style.display = 'none';
    $('importStartBtn').disabled = false;
    $('importResolveBtn').disabled = false;
    setStatus('import', status === 'error' ? 'error' : 'done', null);
    // The job's own message names the cause (e.g. an expired unblocker token) —
    // show it instead of a generic failure line.
    if (status === 'error') setImportMsg(importJobMessage || 'Enrichment stopped with an error — partial results are shown above.', true);
    else if (status === 'stopped') setImportMsg('Stopped. Everything processed so far is shown above.');
    else setImportMsg('Enrichment complete. ' + $('importStats').textContent.replace(/\s+/g, ' ').trim());
}
