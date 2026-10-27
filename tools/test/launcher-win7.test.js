'use strict';
// The Windows 7 launcher build in launcher-version.json: published only when built at the
// launcher repo's version, otherwise the live "win7" section is kept, never invented.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const r2 = require('../lib/r2');
const site = require('../lib/site');

function fakeRepo({ version, normal, win7 }) {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'scevo-launcher-'));
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ version }));
  const build = (dist, v, exes) => {
    fs.mkdirSync(path.join(repo, dist), { recursive: true });
    fs.writeFileSync(path.join(repo, dist, 'latest.yml'), `version: ${v}\nfiles: []\n`);
    for (const e of exes) fs.writeFileSync(path.join(repo, dist, e), `${dist} ${v} ${e}`);
  };
  if (normal) build('dist-electron', normal, [r2.PORTABLE_EXE, r2.SETUP_EXE]);
  if (win7) build('dist-electron-win7', win7, [r2.PORTABLE_EXE_WIN7, r2.SETUP_EXE_WIN7]);
  return repo;
}
const liveWin7 = { version: '1.4.0', portable: { url: 'x/launcher/w7.exe', size: 1, sha256: 'live-p' }, installer: { url: 'x/installer/w7s.exe', size: 2, sha256: 'live-i' } };

test('builtVersion reads latest.yml', () => {
  const repo = fakeRepo({ version: '2.0.0', normal: '2.0.0', win7: '1.9.0' });
  try {
    assert.equal(r2.builtVersion(repo, 'dist-electron'), '2.0.0');
    assert.equal(r2.builtVersion(repo, 'dist-electron-win7'), '1.9.0');
    assert.equal(r2.builtVersion(repo, 'nope'), null);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a Windows 7 build at the repo version is published with that version', async () => {
  const repo = fakeRepo({ version: '2.0.0', normal: '2.0.0', win7: '2.0.0' });
  try {
    assert.equal(r2.win7Fresh(repo), true);
    const files = { launcherWin7: path.join(repo, 'dist-electron-win7', r2.PORTABLE_EXE_WIN7), installerWin7: path.join(repo, 'dist-electron-win7', r2.SETUP_EXE_WIN7) };
    const lv = await r2.writeLauncherVersion({ dryRun: true, published: { version: '1.4.0', win7: liveWin7 }, files, launcherRepoPath: repo });
    assert.equal(lv.win7Source, 'build');
    assert.equal(lv.doc.win7.version, '2.0.0');
    assert.ok(lv.doc.win7.portable.sha256 && lv.doc.win7.portable.sha256 !== 'live-p');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('a stale Windows 7 build keeps the live section unchanged', async () => {
  const repo = fakeRepo({ version: '2.0.0', normal: '2.0.0', win7: '1.9.0' });
  try {
    assert.equal(r2.win7Fresh(repo), false);
    const lv = await r2.writeLauncherVersion({ dryRun: true, published: { version: '1.4.0', win7: liveWin7 }, launcherRepoPath: repo });
    assert.equal(lv.win7Source, 'live');
    assert.deepEqual(lv.doc.win7, liveWin7);
    assert.equal(lv.doc.version, '2.0.0');
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('no Windows 7 build and none live: no section (today\'s launchers are unaffected)', async () => {
  const repo = fakeRepo({ version: '2.0.0', normal: '2.0.0' });
  try {
    const lv = await r2.writeLauncherVersion({ dryRun: true, published: { version: '1.4.0' }, launcherRepoPath: repo });
    assert.equal(lv.win7Source, null);
    assert.equal('win7' in lv.doc, false);
    assert.deepEqual(Object.keys(lv.doc).slice(0, 5), ['version', 'minWindows', 'cdnBase', 'portable', 'installer']);
  } finally { fs.rmSync(repo, { recursive: true, force: true }); }
});

test('the site copy of launcher-version.json is written only when it changes', () => {
  const siteRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'scevo-site-'));
  try {
    fs.mkdirSync(path.join(siteRepo, 'assets', 'data'), { recursive: true });
    const doc = { version: '2.0.0', portable: { url: 'p' }, installer: { url: 'i' }, win7: liveWin7 };
    assert.equal(site.updateSiteLauncherVersion({ siteRepoPath: siteRepo, doc, dryRun: true }).changed, true);
    assert.equal(fs.existsSync(path.join(siteRepo, site.DATA_REL)), false, 'dry run writes nothing');
    assert.equal(site.updateSiteLauncherVersion({ siteRepoPath: siteRepo, doc }).changed, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(siteRepo, site.DATA_REL), 'utf8')), doc);
    assert.equal(site.updateSiteLauncherVersion({ siteRepoPath: siteRepo, doc }).changed, false);
  } finally { fs.rmSync(siteRepo, { recursive: true, force: true }); }
});
