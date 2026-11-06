/* OpenHazard India - api.js
 * fetchJSON(url, {ttl, timeout, retries}): timeout via AbortController, exponential back-off on
 * 429/5xx/network errors, in-memory + localStorage cache with TTL, stale fallback when offline.
 */
(function (root) {
  'use strict';
  root.OH = root.OH || {};
  const MEM = new Map();
  const PREFIX = 'ohc:';
  const MAX_ITEM = 1.5e6; // characters; large archives stay in memory only

  function store(key, entry) {
    try {
      const s = JSON.stringify(entry);
      if (s.length > MAX_ITEM) return;
      localStorage.setItem(PREFIX + key, s);
    } catch (e) { // quota: evict oldest third and retry once
      try {
        const keys = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX))
          .map((k) => { try { return [k, JSON.parse(localStorage.getItem(k)).t]; } catch (_) { return [k, 0]; } })
          .sort((a, b) => a[1] - b[1]);
        keys.slice(0, Math.ceil(keys.length / 3)).forEach(([k]) => localStorage.removeItem(k));
        localStorage.setItem(PREFIX + key, JSON.stringify(entry));
      } catch (_) { /* give up silently: cache is an optimisation */ }
    }
  }
  function load(key) {
    if (MEM.has(key)) return MEM.get(key);
    try { const s = localStorage.getItem(PREFIX + key); if (s) { const e = JSON.parse(s); MEM.set(key, e); return e; } } catch (_) {}
    return null;
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchJSON(url, { ttl = 30 * 60e3, timeout = 30e3, retries = 2 } = {}) {
    const hit = load(url), now = Date.now();
    if (hit && now - hit.t < ttl) return { data: hit.d, fetched: hit.t, cached: true };
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), timeout);
      try {
        const r = await fetch(url, { signal: ctl.signal, headers: { Accept: 'application/json' } });
        clearTimeout(timer);
        if (r.status === 429 || r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { retry: true, status: r.status });
        if (!r.ok) {
          let msg = `HTTP ${r.status}`; try { const j = await r.json(); msg += ': ' + (j.reason || j.detail || j.message || JSON.stringify(j).slice(0, 160)); } catch (_) {}
          throw Object.assign(new Error(msg), { retry: false, status: r.status });
        }
        const d = await r.json();
        if (d && d.error === true) throw Object.assign(new Error(d.reason || 'API error'), { retry: false });
        const entry = { t: Date.now(), d };
        MEM.set(url, entry); store(url, entry);
        return { data: d, fetched: entry.t, cached: false };
      } catch (err) {
        clearTimeout(timer);
        lastErr = err.name === 'AbortError' ? Object.assign(new Error(`timed out after ${timeout / 1000} s`), { retry: true }) : err;
        if (err.retry === false || attempt === retries) break;
        await sleep(800 * Math.pow(2, attempt) + Math.random() * 300);
      }
    }
    if (hit) return { data: hit.d, fetched: hit.t, cached: true, stale: true, error: lastErr };
    throw lastErr;
  }

  const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .flatMap(([k, v]) => (Array.isArray(v) && k.endsWith('[]') ? v.map((x) => [k.slice(0, -2), x]) : [[k, v]]))
    .map(([k, v]) => `${encodeURIComponent(k)}=${Array.isArray(v) ? v.map(encodeURIComponent).join(',') : encodeURIComponent(v)}`).join('&');

  function clearCache() {
    MEM.clear();
    try { Object.keys(localStorage).filter((k) => k.startsWith(PREFIX)).forEach((k) => localStorage.removeItem(k)); } catch (_) {}
  }

  root.OH.api = { fetchJSON, qs, clearCache };
})(typeof self !== 'undefined' ? self : this);
