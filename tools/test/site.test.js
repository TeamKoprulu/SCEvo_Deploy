'use strict';
// node --test tools/test   (works on a temp copy; the real website repo is never touched)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { updateSiteLinks, LINKS_REL } = require('../lib/site');

const SAMPLE = [
  '// Single source of truth for external URLs used across the site.',
  'window.SITE_LINKS = {',
  '  discord:    "https://discord.gg/x",',
  '  launcher:         "https://github.com/T/S/releases/download/Launcher-0_4/SC.Evo.Launcher.exe",',
  '  launcherInstaller: "https://github.com/T/S/releases/download/Launcher-0_4/SC.Evo.Launcher.Setup.exe" ',
  '};',
  '',
].join('\r\n');

function fakeSite(text = SAMPLE) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-site-'));
  fs.mkdirSync(path.dirname(path.join(root, LINKS_REL)), { recursive: true });
  fs.writeFileSync(path.join(root, LINKS_REL), text);
  return root;
}
const R2 = 'https://pub.r2.dev';
const args = (siteRepoPath, extra = {}) => ({
  siteRepoPath, version: '1.3.0',
  portableUrl: `${R2}/launcher/SC%20Evo%20Launcher.exe`, installerUrl: `${R2}/installer/SC%20Evo%20Launcher%20Setup.exe`, ...extra,
});

test('points both launcher links at R2 with the version, leaving everything else alone', () => {
  const root = fakeSite();
  const r = updateSiteLinks(args(root));
  assert.equal(r.changed, true);
  const text = fs.readFileSync(path.join(root, LINKS_REL), 'utf8');
  assert.match(text, /launcher: {9}"https:\/\/pub\.r2\.dev\/launcher\/SC%20Evo%20Launcher\.exe\?v=1\.3\.0",\r\n/);
  assert.match(text, /launcherInstaller: "https:\/\/pub\.r2\.dev\/installer\/SC%20Evo%20Launcher%20Setup\.exe\?v=1\.3\.0" \r\n/);
  assert.equal(text.replace(/"https:\/\/pub[^"]*"/g, '""'), SAMPLE.replace(/"https:\/\/github[^"]*"/g, '""'));
  assert.equal(updateSiteLinks(args(root)).changed, false, 'same version again changes nothing');
});

test('dry run reports the change without writing', () => {
  const root = fakeSite();
  const r = updateSiteLinks(args(root, { dryRun: true }));
  assert.equal(r.changed, true);
  assert.match(r.before.launcher, /github/);
  assert.equal(fs.readFileSync(path.join(root, LINKS_REL), 'utf8'), SAMPLE);
});

test('a missing key or file is an error, not a silent no-op', () => {
  assert.throws(() => updateSiteLinks(args(fakeSite(SAMPLE.replace(/ {2}launcherInstaller.*\r\n/, '')))), /launcherInstaller/);
  assert.throws(() => updateSiteLinks(args(path.join(os.tmpdir(), 'no-such-site'))), /not found/);
});
