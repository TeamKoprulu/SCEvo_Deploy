'use strict';
// Points the website's launcher download links at the R2 copies Deploy just published.
//
// Edits only the two string values in <siteRepoPath>/assets/js/site-links.js
// (launcher, launcherInstaller); the rest of the file, and anything uncommitted
// in that repo, is left as it is. Never touches git: you commit and push the site.

const fs = require('node:fs');
const path = require('node:path');
const { writeTextAtomic } = require('./config');

const LINKS_REL = path.join('assets', 'js', 'site-links.js');
const KEYS = ['launcher', 'launcherInstaller'];

const linksFile = (siteRepoPath) => path.join(siteRepoPath, LINKS_REL);
const siteValid = (siteRepoPath) => !!siteRepoPath && fs.existsSync(linksFile(siteRepoPath));

// `launcher: "…"` — the key at a word boundary, so "launcher" never matches "launcherInstaller".
const keyPattern = (key) => new RegExp(`(\\b${key}\\s*:\\s*)(["'])([^"']*)\\2`);

// "?v=<version>" changes the link with every launcher version, so no cache serves an old exe.
function withVersion(url, version) {
  const base = String(url).split('?')[0];
  return version ? `${base}?v=${encodeURIComponent(version)}` : base;
}

function updateSiteLinks({ siteRepoPath, version, portableUrl, installerUrl, dryRun = false }) {
  const file = linksFile(siteRepoPath || '');
  if (!siteRepoPath || !fs.existsSync(file)) throw new Error(`site-links.js not found at ${file}`);
  if (!portableUrl || !installerUrl) throw new Error('launcher-version.json has no portable/installer URL');
  const want = { launcher: withVersion(portableUrl, version), launcherInstaller: withVersion(installerUrl, version) };

  let text = fs.readFileSync(file, 'utf8');
  const before = {};
  for (const key of KEYS) {
    const m = keyPattern(key).exec(text);
    if (!m) throw new Error(`site-links.js has no "${key}" link to update`);
    before[key] = m[3];
    text = text.replace(keyPattern(key), (_all, head, quote) => `${head}${quote}${want[key]}${quote}`);
  }
  const changed = KEYS.some((k) => before[k] !== want[k]);
  if (changed && !dryRun) writeTextAtomic(file, text);
  return { changed, file, before, after: want };
}

module.exports = { updateSiteLinks, siteValid, withVersion, LINKS_REL };
