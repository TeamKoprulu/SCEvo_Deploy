'use strict';
// lib/news.js is a copy of the launcher's electron/news/posts.js. They must
// resolve feeds identically, or the "cards" snapshot older launchers show would
// differ from what current launchers build. Skipped when the launcher repo
// isn't configured on this machine.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readConfig } = require('../lib/config');

const bodyOf = (text) => {
  const s = String(text).replace(/\r\n/g, '\n');
  return s.slice(s.indexOf('const SITE_BASE'));
};

test('lib/news.js matches the launcher\'s electron/news/posts.js', (t) => {
  const repo = readConfig().launcherRepoPath;
  const launcher = repo && path.join(repo, 'electron', 'news', 'posts.js');
  if (!launcher || !fs.existsSync(launcher)) return t.skip('launcher repo not configured');
  const ours = fs.readFileSync(path.join(__dirname, '..', 'lib', 'news.js'), 'utf8');
  assert.ok(bodyOf(ours) === bodyOf(fs.readFileSync(launcher, 'utf8')),
    `lib/news.js has drifted from ${launcher}. Copy the launcher's file over it (keep this file's header comment).`);
});
