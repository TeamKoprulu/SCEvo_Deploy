'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../lib/config');
const r2 = require('../lib/r2');

const repo = cfg.readConfig().launcherRepoPath;
const noRepo = !repo || !fs.existsSync(path.join(repo, 'package.json'));
const watched = [cfg.LAUNCHER_VER, path.join(cfg.REPO_ROOT, 'launcher', r2.PORTABLE_EXE), path.join(cfg.REPO_ROOT, 'installer', r2.SETUP_EXE)];
const stamp = () => watched.map((f) => (fs.existsSync(f) ? `${fs.statSync(f).size}:${fs.statSync(f).mtimeMs}` : 'missing'));

test('a dry run stages and writes nothing', { skip: noRepo && 'launcherRepoPath not set' }, async () => {
  const before = stamp();
  const published = { version: '0.0.1', source: 'live' };
  const staged = await r2.stageLauncherArtifacts({ dryRun: true, published });
  const lv = await r2.writeLauncherVersion({ dryRun: true, published, files: staged.files });
  assert.deepEqual(stamp(), before);
  assert.equal(lv.ok, true);
  assert.equal(lv.previous, '0.0.1');
  assert.equal(lv.doc.version, JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version);
});

test('version not bumped: warns against the live version', { skip: noRepo && 'launcherRepoPath not set' }, async () => {
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version;
  const exe = path.join(repo, 'dist-electron', r2.PORTABLE_EXE);
  if (!fs.existsSync(exe)) return;
  // Live file has the same version but a different exe hash.
  const published = { version, source: 'live', portable: { sha256: 'not-this-build' } };
  const staged = await r2.stageLauncherArtifacts({ dryRun: true, published });
  assert.ok(staged.warnings.some((w) => /Bump "version"/.test(w)), staged.warnings.join('\n'));
});

test('the Windows 7 build gets its own "win7" section when it is built', { skip: noRepo && 'launcherRepoPath not set' }, async () => {
  const built = [r2.PORTABLE_EXE_WIN7, r2.SETUP_EXE_WIN7].every((e) => fs.existsSync(path.join(repo, 'dist-electron-win7', e)));
  const published = { version: '0.0.1', source: 'live' };
  const staged = await r2.stageLauncherArtifacts({ dryRun: true, published });
  const lv = await r2.writeLauncherVersion({ dryRun: true, published, files: staged.files });
  if (!built) return assert.equal(lv.doc.win7, undefined);
  assert.equal(lv.doc.win7.version, lv.doc.version);
  assert.ok(lv.doc.win7.portable.url.endsWith('/launcher/SC%20Evo%20Launcher%20Win7.exe'), lv.doc.win7.portable.url);
  assert.ok(lv.doc.win7.installer.url.endsWith('/installer/SC%20Evo%20Launcher%20Win7%20Setup.exe'), lv.doc.win7.installer.url);
  assert.ok(lv.doc.win7.portable.sha256 && lv.doc.win7.installer.size > 0);
  assert.notEqual(lv.doc.win7.portable.sha256, lv.doc.portable.sha256);
});

test('publishedLauncherVersion falls back to the local file when offline', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => { throw new Error('offline'); };
  try {
    const p = await r2.publishedLauncherVersion(500);
    if (fs.existsSync(cfg.LAUNCHER_VER)) assert.equal(p.source, 'local');
    else assert.equal(p, null);
  } finally { global.fetch = realFetch; }
});
