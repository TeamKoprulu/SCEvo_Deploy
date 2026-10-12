'use strict';
// Is a custom CDN address ready to replace r2.dev? Read-only checks, each { name, ok, detail, hint }.
// DNS and fetch are injectable so the checks can be tested without the network.

const fs = require('node:fs');
const cfg = require('./config');

async function fetchWithTimeout(fetchImpl, url, init = {}, ms = 15000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try { return await fetchImpl(url, { ...init, signal: ac.signal, cache: 'no-store' }); } finally { clearTimeout(timer); }
}

// Public resolvers first: Node's built-in resolver can't always reach the system DNS on Windows.
function defaultDns() {
  const { promises } = require('node:dns');
  const pub = new promises.Resolver();
  pub.setServers(['1.1.1.1', '8.8.8.8']);
  const either = (fn) => async (name) => { try { return await fn(pub, name); } catch { return fn(promises, name); } };
  return {
    resolveNs: either((r, n) => r.resolveNs(n)),
    resolve4: either((r, n) => r.resolve4(n)),
  };
}

// "cdn.example.co.uk" -> "example.co.uk"-ish: the last two labels, or three for two-letter SLD pairs.
function zoneOf(host) {
  const parts = host.split('.');
  const n = parts.length >= 3 && parts[parts.length - 2].length <= 3 && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

// A payload file the CDN should serve with Range support: the first file of the public manifest.
function samplePayloadPath() {
  try {
    const m = JSON.parse(fs.readFileSync(cfg.PUBLIC_MANIFEST, 'utf8').replace(/^﻿/, ''));
    const f = (m.modules || []).flatMap((x) => x.files || [])[0];
    return f ? `payload/${encodeURI(f.path)}` : null;
  } catch { return null; }
}

/**
 * base: "https://cdn.example.com". Returns { base, ready, checks: [{ name, ok, detail, hint }] }.
 */
async function cdnCheck(base, { dns = defaultDns(), fetchImpl = fetch, r2Base = cfg.R2_BASE, sample = samplePayloadPath() } = {}) {
  const checks = [];
  const add = (name, ok, detail, hint) => { checks.push({ name, ok, detail, hint: ok ? null : hint }); return ok; };
  let url;
  try { url = new URL(base); } catch { url = null; }
  if (!url || url.protocol !== 'https:') {
    add('address', false, String(base || '(empty)'), 'Use the full https:// address, e.g. https://cdn.example.com');
    return { base, ready: false, checks };
  }
  base = url.origin;
  const host = url.hostname;

  // 1. The domain's DNS is on Cloudflare (R2 custom domains require it).
  const zone = zoneOf(host);
  try {
    const ns = await dns.resolveNs(zone);
    add(`${zone} DNS on Cloudflare`, ns.some((n) => /\.ns\.cloudflare\.com$/i.test(n)), ns.join(', '),
      'R2 custom domains need the domain\'s DNS on Cloudflare. A domain bought in Cloudflare Registrar already is.');
  } catch (e) { add(`${zone} DNS on Cloudflare`, false, e.code || e.message, 'The domain isn\'t registered yet, or its DNS isn\'t set up.'); }

  // 2. The CDN host resolves.
  let resolves = false;
  try {
    const addrs = await dns.resolve4(host);
    resolves = add(`${host} resolves`, addrs.length > 0, addrs.join(', '), '');
  } catch (e) {
    add(`${host} resolves`, false, e.code || e.message, 'Connect it in R2 → evo-campaign → Settings → Custom Domains.');
  }

  // 3-5. The manifest comes from Cloudflare, matches r2.dev and isn't edge-cached.
  if (resolves) {
    try {
      const murl = `${base}/manifests/update-manifest.json`;
      const a = await fetchWithTimeout(fetchImpl, murl);
      const body = await a.text();
      const server = a.headers.get('server') || '';
      add('manifest served', a.status === 200 && /cloudflare/i.test(server), `HTTP ${a.status}, server ${server || '?'}`,
        'The bucket answers on this address only once it is connected in R2 → Custom Domains.');
      const r = await fetchWithTimeout(fetchImpl, `${r2Base}/manifests/update-manifest.json`);
      const same = (await r.text()) === body;
      add('same content as r2.dev', same, same ? 'identical' : 'differs', 'The address points at another bucket, or serves a stale cached copy.');
      const b = await fetchWithTimeout(fetchImpl, murl);
      await b.text();
      const second = b.headers.get('cf-cache-status') || '-';
      add('manifests not edge-cached', !/HIT/i.test(second), `cf-cache-status ${a.headers.get('cf-cache-status') || '-'} / ${second}`,
        'Add a Cache Rule: hostname equals this host and URI path starts with /manifests/ → Bypass cache.');
    } catch (e) { add('manifest served', false, e.message, 'The address doesn\'t answer over https yet (certificates can take a few minutes).'); }

    if (sample) {
      try {
        const res = await fetchWithTimeout(fetchImpl, `${base}/${sample}`, { headers: { Range: 'bytes=0-0' } });
        try { await res.body?.cancel(); } catch {}
        add('resumable downloads (Range)', res.status === 206, `HTTP ${res.status} for ${decodeURI(sample)}`,
          'Downloads would restart from zero after an interruption.');
      } catch (e) { add('resumable downloads (Range)', false, e.message, ''); }
    }
  }

  return { base, ready: checks.every((c) => c.ok), checks };
}

module.exports = { cdnCheck, zoneOf, samplePayloadPath };
