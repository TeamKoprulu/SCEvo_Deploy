'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pendingPackages, assetsPending, describe } = require('../lib/pending');

function setup(local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-'));
  for (const [name, doc] of Object.entries(local)) fs.writeFileSync(path.join(dir, name), JSON.stringify(doc));
  return dir;
}
const fakeFetch = (live, offline = false) => async (url) => {
  if (offline) return { ok: false, error: 'timed out' };
  const name = url.split('/').pop();
  return name in live ? { ok: true, data: live[name] } : { ok: false, error: 'HTTP 404' };
};

const noLauncher = async () => ({ changed: false, details: [] });
const melee = { version: '1.21', lastUpdated: 'a', modules: [], maps: [{ id: 'm1', file: { path: 'maps/m1.evm', hash: 'h1' } }] };

test('same apart from lastUpdated: nothing pending', async () => {
  const dir = setup({ 'melee-manifest.json': melee });
  const r = await pendingPackages({ fetchJson: fakeFetch({ 'melee-manifest.json': { ...melee, lastUpdated: 'b' } }), base: 'x', manifestDir: dir, launcher: noLauncher, assets: noLauncher });
  assert.equal(r.packages.melee.changed, false);
  assert.equal(r.offline, false);
});

test('decals added and a map changed are reported', async () => {
  const local = { ...melee, maps: [{ id: 'm1', file: { path: 'maps/m1.evm', hash: 'h2' } }], decals: { list: { path: 'decals/decals.json', hash: 'd' }, files: [] } };
  const dir = setup({ 'melee-manifest.json': local });
  const r = await pendingPackages({ fetchJson: fakeFetch({ 'melee-manifest.json': melee }), base: 'x', manifestDir: dir, launcher: noLauncher, assets: noLauncher });
  assert.equal(r.packages.melee.changed, true);
  assert.deepEqual(r.packages.melee.details, ['decals added', '1 map changed']);
});

test('not on the CDN yet, and offline', async () => {
  const dir = setup({ 'melee-manifest.json': melee });
  const missing = await pendingPackages({ fetchJson: fakeFetch({}), base: 'x', manifestDir: dir, launcher: noLauncher, assets: noLauncher });
  assert.deepEqual(missing.packages.melee.details, ['melee-manifest.json: not on the CDN yet']);
  const off = await pendingPackages({ fetchJson: fakeFetch({}, true), base: 'x', manifestDir: dir, launcher: noLauncher, assets: noLauncher });
  assert.equal(off.offline, true);
  assert.equal(off.packages.melee.changed, false);
});

test('describe: version bump', () => {
  assert.deepEqual(describe('melee-manifest.json', { ...melee }, { ...melee, version: '1.22' }), ['version 1.21 → 1.22']);
});

const { launcherPending } = require('../lib/pending');
const fakeR2 = ({ live, version, sha = 'new', staged = [], warnings = [] }) => ({
  publishedLauncherVersion: async () => live,
  stageLauncherArtifacts: async () => ({ staged, warnings, files: {} }),
  writeLauncherVersion: async () => ({ ok: true, doc: { version, portable: { sha256: sha } } }),
});

test('launcher: a version bump is pending', async () => {
  const r = await launcherPending({ r2: fakeR2({ live: { version: '1.3.0' }, version: '1.3.1' }) });
  assert.deepEqual(r, { changed: true, details: ['launcher 1.3.0 → 1.3.1'] });
});

test('launcher: same version and exe is not pending; a rebuilt exe at the same version warns', async () => {
  const same = await launcherPending({ r2: fakeR2({ live: { version: '1.3.1', portable: { sha256: 'a' } }, version: '1.3.1', sha: 'a' }) });
  assert.equal(same.changed, false);
  const rebuilt = await launcherPending({ r2: fakeR2({ live: { version: '1.3.1', portable: { sha256: 'a' } }, version: '1.3.1', sha: 'b' }) });
  assert.equal(rebuilt.changed, true);
  assert.equal(rebuilt.warn, true);
  const noSha = await launcherPending({ r2: fakeR2({ live: { version: '1.3.1' }, version: '1.3.1', staged: ['SC Evo Launcher.exe'] }) });
  assert.equal(noSha.changed, true, 'without a live hash, a re-staged exe counts as rebuilt');
});

test('launcher: repo not set is not pending', async () => {
  const r = await launcherPending({ r2: fakeR2({ live: null, version: 'x', warnings: ['Launcher repo not configured or invalid: (unset)'] }) });
  assert.equal(r.changed, false);
});

test('the launcher ships as its own deploy package', () => {
  const { MANIFESTS, DEPLOY_PACKAGES } = require('../lib/deploy');
  const cfg = require('../lib/config');
  assert.deepEqual(DEPLOY_PACKAGES, ['campaign', 'melee', 'meleebeta', 'launcher', 'assets']);
  // assets/ goes up with a campaign deploy or on its own, never with a manifest of its own.
  const assets = cfg.UPLOAD_FOLDERS.find((f) => f.local === 'assets');
  assert.equal(assets.package, 'campaign');
  assert.deepEqual(assets.alsoWith, ['assets']);
  assert.deepEqual(MANIFESTS.assets, []);
  assert.deepEqual(MANIFESTS.launcher, ['launcher-version.json']);
  assert.ok(!MANIFESTS.campaign.includes('launcher-version.json'));
  assert.deepEqual(cfg.UPLOAD_FOLDERS.filter((f) => f.package === 'launcher').map((f) => f.local), ['launcher', 'installer']);
});

test('launcher: a new CDN address at the same version is pending', async () => {
  const r2 = {
    publishedLauncherVersion: async () => ({ version: '1.3.1', portable: { url: 'https://pub-x.r2.dev/launcher/a.exe', sha256: 'a' } }),
    stageLauncherArtifacts: async () => ({ staged: [], warnings: [], files: {} }),
    writeLauncherVersion: async () => ({ ok: true, doc: { version: '1.3.1', cdnBase: 'https://scevo.download', portable: { sha256: 'a' } } }),
  };
  assert.deepEqual(await launcherPending({ r2 }), { changed: true, details: ['CDN address → https://scevo.download'] });
});

test('assets: new and changed files summed per subfolder', async () => {
  const diff = async () => ({ ok: true, missing: ['replay-icons/a.png', 'replay-icons/b.png', 'launcher/public-1.webp'], differ: ['news/x.png'], same: 3 });
  assert.deepEqual(await assetsPending({ diff }), { changed: true, details: ['3 new (replay-icons 2, launcher 1)', '1 changed (news 1)'] });
  assert.deepEqual(await assetsPending({ diff: async () => ({ ok: true, missing: [], differ: [], same: 8 }) }), { changed: false, details: [] });
  assert.equal((await assetsPending({ diff: async () => ({ ok: false, error: 'no remote' }) })).changed, false);
});
