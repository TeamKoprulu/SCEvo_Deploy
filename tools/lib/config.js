'use strict';
// Shared paths + deploy-config.json access.
//
// Every write here is read-modify-write. The old deploy-to-r2.ps1 rebuilt the
// config from a string template containing only launcherRepoPath, which silently
// destroyed sc2InstallPath and showVersionDebug (plan B7).

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT   = path.resolve(__dirname, '..', '..');
const TOOLS_DIR   = path.join(REPO_ROOT, 'tools');
const CACHE_DIR   = path.join(TOOLS_DIR, '.cache');
const CONFIG_PATH = path.join(REPO_ROOT, 'deploy-config.json');
const VETO_PATH   = path.join(REPO_ROOT, 'sc2packager-ignored.json');
const MPQ_EDITOR  = path.join(REPO_ROOT, 'MPQEditor.exe');

const MANIFEST_DIR = path.join(REPO_ROOT, 'manifests');
const PAYLOAD_DIR  = path.join(REPO_ROOT, 'payload');
const BETA_DIR     = path.join(REPO_ROOT, 'betapayload');

const PUBLIC_MANIFEST = path.join(MANIFEST_DIR, 'update-manifest.json');
const BETA_MANIFEST   = path.join(MANIFEST_DIR, 'beta-manifest.json');
const NEWS_FEED       = path.join(MANIFEST_DIR, 'news-feed.json');
const LAUNCHER_VER    = path.join(MANIFEST_DIR, 'launcher-version.json');

// Must stay in sync with SERVERS[0] in sc-evo-launcher/electron/main.js.
const R2_BASE = 'https://pub-8a599b66a5cf440ab429113861fd1c21.r2.dev';
const BUCKET  = 'cf:evo-campaign';

const SCHEMA_VERSION = 1;

// Source folders inside the SC2 install that hold .SC2Map / .SC2Mod dev folders.
// Ported verbatim from build-sc2files.ps1:195-201.
const SOURCE_ROOTS = [
  { rel: 'Maps\\SCEvo\\LegacyLoomings',                    ext: '.SC2Map', mode: 'children' },
  { rel: 'Maps\\SCEvo\\LegacyRebelYell',                   ext: '.SC2Map', mode: 'children' },
  { rel: 'Maps\\SCEvo\\EvoCompleteLauncher.SC2Map',        ext: '.SC2Map', mode: 'single'   },
  { rel: 'Mods\\SC Evolution Complete',                    ext: '.SC2Mod', mode: 'children' },
  { rel: 'Mods\\SC Evolution Complete\\SCEvo_CampaignMods', ext: '.SC2Mod', mode: 'children' },
];

// Upload order matters: manifests MUST be last so the CDN never advertises
// bytes that aren't uploaded yet (plan B1).
const UPLOAD_FOLDERS = [
  { name: 'Payload',     local: 'payload'     },
  { name: 'BetaPayload', local: 'betapayload' },
  { name: 'Assets',      local: 'assets'      },
  { name: 'Launcher',    local: 'launcher'    },
  { name: 'Installer',   local: 'installer'   },
];
const MANIFEST_FOLDER = { name: 'Manifests', local: 'manifests' };

function readConfig() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const obj = JSON.parse(stripJunk(raw));
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
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
    .replace(/[​‌‍￾�]/g, '');
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
  REPO_ROOT, TOOLS_DIR, CACHE_DIR, CONFIG_PATH, VETO_PATH, MPQ_EDITOR,
  MANIFEST_DIR, PAYLOAD_DIR, BETA_DIR,
  PUBLIC_MANIFEST, BETA_MANIFEST, NEWS_FEED, LAUNCHER_VER,
  R2_BASE, BUCKET, SCHEMA_VERSION, SOURCE_ROOTS, UPLOAD_FOLDERS, MANIFEST_FOLDER,
  readConfig, updateConfig, stripJunk, writeJsonAtomic, writeTextAtomic, ensureCacheDir,
};
