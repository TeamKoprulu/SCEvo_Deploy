'use strict';
// Shared paths + deploy-config.json access.
//
// Every write here is read-modify-write. The old deploy-to-r2.ps1 rebuilt the
// config from a string template containing only launcherRepoPath, which silently
// destroyed sc2InstallPath and showVersionDebug (plan B7).

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT    = path.resolve(__dirname, '..', '..');
const TOOLS_DIR    = path.join(REPO_ROOT, 'tools');
const CACHE_DIR    = path.join(TOOLS_DIR, '.cache');
const CONFIG_PATH  = path.join(REPO_ROOT, 'deploy-config.json');
const CATALOG_PATH = path.join(REPO_ROOT, 'deploy-catalog.json');
const MPQ_EDITOR   = path.join(REPO_ROOT, 'MPQEditor.exe');

const MANIFEST_DIR = path.join(REPO_ROOT, 'manifests');
const HISTORY_DIR  = path.join(MANIFEST_DIR, '.history');
const PAYLOAD_DIR  = path.join(REPO_ROOT, 'payload');
const BETA_DIR     = path.join(REPO_ROOT, 'betapayload');
const MELEE_DIR    = path.join(REPO_ROOT, 'meleepayload');

const PUBLIC_MANIFEST = path.join(MANIFEST_DIR, 'update-manifest.json');
const BETA_MANIFEST   = path.join(MANIFEST_DIR, 'beta-manifest.json');
const MELEE_MANIFEST  = path.join(MANIFEST_DIR, 'melee-manifest.json');
const NEWS_FEED       = path.join(MANIFEST_DIR, 'news-feed.json');
const LAUNCHER_VER    = path.join(MANIFEST_DIR, 'launcher-version.json');

// Must stay in sync with SERVERS[0] in sc-evo-launcher/electron/main.js.
const R2_BASE = 'https://pub-8a599b66a5cf440ab429113861fd1c21.r2.dev';
const BUCKET  = 'cf:evo-campaign';

const SCHEMA_VERSION = 1;

// Roots for a brand-new catalog. The catalog's own "roots" list is what the tool
// actually scans, so edit roots in deploy-catalog.json (or the Catalog tab).
const DEFAULT_ROOTS = [
  { rel: 'Maps\\SCEvo\\LegacyLoomings', kind: 'map' },
  { rel: 'Maps\\SCEvo\\LegacyRebelYell', kind: 'map' },
  { rel: 'Maps\\SCEvo\\EvoCompleteLauncher.SC2Map', kind: 'map', single: true },
  { rel: 'Maps\\SCEvo_MPMaps', kind: 'map', depth: 2 },
  { rel: 'Mods\\SC Evolution Complete', kind: 'mod' },
  { rel: 'Mods\\SC Evolution Complete\\SCEvo_CampaignMods', kind: 'mod' },
];

// Where each package/channel's built files live. The folder name is also the
// R2 prefix the launcher downloads from.
const OUTPUT_DIRS = {
  campaign: { public: PAYLOAD_DIR, beta: BETA_DIR },
  melee:    { public: MELEE_DIR },
};

// Upload order matters: manifests MUST be last so the CDN never advertises
// bytes that aren't uploaded yet (plan B1).
const UPLOAD_FOLDERS = [
  { name: 'Payload',      local: 'payload',      package: 'campaign' },
  { name: 'BetaPayload',  local: 'betapayload',  package: 'campaign' },
  { name: 'MeleePayload', local: 'meleepayload', package: 'melee'    },
  { name: 'Assets',       local: 'assets',       package: 'campaign' },
  { name: 'Launcher',     local: 'launcher',     package: 'campaign' },
  { name: 'Installer',    local: 'installer',    package: 'campaign' },
];
const MANIFEST_FOLDER = { name: 'Manifests', local: 'manifests' };

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(stripJunk(raw));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw new Error(`deploy-config.json is not valid JSON: ${err.message}`);
  }
}

// Merges `patch` over the existing config, preserving every key we don't touch.
function updateConfig(patch) {
  const merged = { ...readConfig(), ...patch };
  for (const k of Object.keys(merged)) {
    if (merged[k] === undefined) delete merged[k];
  }
  writeJsonAtomic(CONFIG_PATH, merged);
  return merged;
}

// Strips a UTF-8 BOM and the zero-width characters that break JSON.parse.
// Ported from ConvertTo-CleanJson in build-manifests.ps1:70-79 — the launcher
// only guards against a leading BOM (main.js:330), so we scrub the rest here.
function stripJunk(text) {
  return String(text)
    .replace(/^﻿/, '')
    .replace(/[​‌‍﻿￾�]/g, '');
}

// Write via a temp file + rename so a crash can never leave a truncated JSON.
function writeJsonAtomic(file, obj) {
  writeTextAtomic(file, JSON.stringify(obj, null, 2) + '\n');
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  // UTF-8 without BOM — the launcher's JSON.parse chokes on one.
  fs.writeFileSync(tmp, text, { encoding: 'utf8' });
  fs.renameSync(tmp, file);
}

function ensureCacheDir() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}

module.exports = {
  REPO_ROOT, TOOLS_DIR, CACHE_DIR, CONFIG_PATH, CATALOG_PATH, MPQ_EDITOR,
  MANIFEST_DIR, HISTORY_DIR, PAYLOAD_DIR, BETA_DIR, MELEE_DIR, OUTPUT_DIRS,
  PUBLIC_MANIFEST, BETA_MANIFEST, MELEE_MANIFEST, NEWS_FEED, LAUNCHER_VER,
  R2_BASE, BUCKET, SCHEMA_VERSION, DEFAULT_ROOTS, UPLOAD_FOLDERS, MANIFEST_FOLDER,
  readConfig, updateConfig, stripJunk, writeJsonAtomic, writeTextAtomic, ensureCacheDir,
};
