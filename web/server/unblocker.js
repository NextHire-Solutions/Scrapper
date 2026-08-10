// unblocker.js — unified web-unblocker client for hard-blocked sites
// (realtor.com, Zillow profiles). Supports two providers, chosen via env:
//   - Bright Data Web Unlocker  (PAYG, ~$1.5/1k — cheapest; preferred)
//   - ZenRows Universal Scraper API  (subscription)
// Set UNBLOCKER_PROVIDER to force one, else it auto-detects from whichever
// credentials are present (Bright Data first).

const BD_ENDPOINT = 'https://api.brightdata.com/request';
const ZR_ENDPOINT = 'https://api.zenrows.com/v1/';

export function activeProvider() {
    const p = (process.env.UNBLOCKER_PROVIDER || '').toLowerCase();
    if (p === 'brightdata' || p === 'zenrows') return p;
    if (process.env.BRIGHTDATA_API_TOKEN) return 'brightdata';
    if (process.env.ZENROWS_API_KEY) return 'zenrows';
    return '';
}

// Global concurrency limiter — shared across ALL engines (Zillow + realtor) so
// one engine's burst can't starve the other and trip the provider's limits.
const MAX_CONCURRENT = Number(process.env.UNBLOCKER_MAX_CONCURRENT) || 8;
let active = 0;
const queue = [];
function drain() {
    while (active < MAX_CONCURRENT && queue.length) {
        active += 1;
        (queue.shift())();
    }
}
function acquire() {
    return new Promise((resolve) => { queue.push(resolve); drain(); });
}
function release() {
    if (active > 0) active -= 1;
    drain();
}

/** Fetch a page's HTML through the configured unblocker (globally rate-limited). */
export async function fetchUnblocked(targetUrl, opts = {}) {
    const provider = activeProvider();
    if (!provider) throw new Error('No unblocker configured (set BRIGHTDATA_API_TOKEN or ZENROWS_API_KEY).');
    await acquire();
    try {
        if (provider === 'brightdata') return await fetchBrightData(targetUrl, opts);
        return await fetchZenRows(targetUrl, opts);
    } finally {
        release();
    }
}

// --- Bright Data Web Unlocker (auto-renders; one flat call) ---
async function fetchBrightData(url, { timeoutMs = 120000, retries = 2 } = {}) {
    const token = process.env.BRIGHTDATA_API_TOKEN;
    const zone = process.env.BRIGHTDATA_ZONE || 'web_unlocker1';
    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
        const ctrl = new AbortController();
        // Timer stays armed until the BODY is fully read — a response whose body
        // stalls mid-stream would otherwise hang res.text() forever (stuck run).
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(BD_ENDPOINT, {
                method: 'POST',
                signal: ctrl.signal,
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ zone, url, format: 'raw' }),
            });
            const body = await res.text();
            clearTimeout(timer);
            if (res.ok) return body;
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`BrightData ${res.status}: ${body.slice(0, 140)}`);
            }
            lastErr = new Error(`BrightData ${res.status}: ${body.slice(0, 140)}`);
        } catch (err) {
            clearTimeout(timer);
            if (/BrightData 4\d\d/.test(err.message)) throw err;
            lastErr = err;
        }
        await sleep(2000 * (i + 1));
    }
    throw lastErr;
}

// --- ZenRows Universal Scraper API ---
async function fetchZenRows(url, { render = false, country = 'us', timeoutMs = 120000, retries = 2 } = {}) {
    const key = process.env.ZENROWS_API_KEY;
    const params = new URLSearchParams({ apikey: key, url });
    if (render) params.set('js_render', 'true');
    params.set('premium_proxy', 'true');
    if (country) params.set('proxy_country', country);
    const endpoint = `${ZR_ENDPOINT}?${params.toString()}`;
    let lastErr;
    for (let i = 0; i <= retries; i += 1) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(endpoint, { signal: ctrl.signal });
            const body = await res.text();     // timer stays armed through the body read
            clearTimeout(timer);
            if (res.ok) return body;
            if (res.status >= 400 && res.status < 500 && res.status !== 429) {
                throw new Error(`ZenRows ${res.status}: ${body.slice(0, 140)}`);
            }
            lastErr = new Error(`ZenRows ${res.status}`);
        } catch (err) {
            clearTimeout(timer);
            if (/ZenRows 4\d\d/.test(err.message)) throw err;
            lastErr = err;
        }
        await sleep(2000 * (i + 1));
    }
    throw lastErr;
}

/** Pull and parse the Next.js __NEXT_DATA__ JSON blob from a page's HTML. */
export function extractNextData(html) {
    const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
