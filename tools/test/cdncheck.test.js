'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { cdnCheck, zoneOf } = require('../lib/cdncheck');

const MANIFEST = '{"versions":{}}';
const res = (status, body = '', headers = {}) => ({
  status, ok: status < 400,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => body, body: { cancel: async () => {} },
});

function fakeFetch({ cache = ['MISS', 'MISS'], range = 206, body = MANIFEST } = {}) {
  let manifestHits = 0;
  return async (url, init = {}) => {
    if (url.includes('r2.dev')) return res(200, MANIFEST);
    if (url.endsWith('/manifests/update-manifest.json')) return res(200, body, { server: 'cloudflare', 'cf-cache-status': cache[manifestHits++] });
    if (init.headers?.Range) return res(range);
    return res(404);
  };
}
const dnsOk = { resolveNs: async () => ['annabel.ns.cloudflare.com', 'javon.ns.cloudflare.com'], resolve4: async () => ['104.21.29.124'] };
const opts = (o = {}) => ({ dns: dnsOk, fetchImpl: fakeFetch(), r2Base: 'https://pub-x.r2.dev', sample: 'payload/Mods/x.SC2Mod', ...o });

test('ready: Cloudflare DNS, served by cloudflare, same as r2.dev, not cached, Range', async () => {
  const r = await cdnCheck('https://scevo.download/', opts());
  assert.equal(r.base, 'https://scevo.download');
  assert.equal(r.ready, true, JSON.stringify(r.checks));
});

test('not ready: the host does not resolve', async () => {
  const dns = { ...dnsOk, resolve4: async () => { const e = new Error('nope'); e.code = 'ENOTFOUND'; throw e; } };
  const r = await cdnCheck('https://cdn.example.com', opts({ dns }));
  assert.equal(r.ready, false);
  assert.match(r.checks.find((c) => /resolves/.test(c.name)).hint, /Custom Domains/);
});

test('cached manifests, a different bucket and no Range are reported', async () => {
  const r = await cdnCheck('https://scevo.download', opts({ fetchImpl: fakeFetch({ cache: ['MISS', 'HIT'], range: 200, body: '{}' }) }));
  const failed = r.checks.filter((c) => !c.ok).map((c) => c.name).sort();
  assert.deepEqual(failed, ['manifests not edge-cached', 'resumable downloads (Range)', 'same content as r2.dev']);
});

test('bad address and zone of a host', async () => {
  assert.equal((await cdnCheck('http://scevo.download', opts())).ready, false);
  assert.equal(zoneOf('cdn.scevo.download'), 'scevo.download');
  assert.equal(zoneOf('cdn.example.co.uk'), 'example.co.uk');
});
