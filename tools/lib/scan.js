'use strict';
// Source discovery, payload scanning, veto list, and beta<->public promotion.
//
// The veto list is plain JSON.stringify of an array. build-sc2files.ps1 lost
// entries because `return [string[]]$parsed` unrolls a one-element array to a
// scalar string, turning `$ignored += x` into string concatenation (plan B5).
// That class of bug cannot occur here.

const fs = require('node:fs');
const path = require('node:path');
const {
  VETO_PATH, PAYLOAD_DIR, BETA_DIR, SOURCE_ROOTS,
  stripJunk, writeJsonAtomic,
} = require('./config');
const { hashOf } = require('./hashcache');
const { normalizeManifestPath } = require('./manifest');

const SC2_EXTS = ['.SC2Mod', '.SC2Map'];

// readdir reports a Windows junction as a symlink, NOT a directory, so a plain
// dirent.isDirectory() check silently skips it. The SC2 install uses junctions
// heavily (SCEvo_Core/_Legacy/_Assets and SCEvo_CampaignMods all point into
// D:\test\SCEvoDev), and PowerShell's Get-ChildItem -Directory follows them —
// so anything that doesn't will quietly lose mods.
function isDirEntry(dirent, fullPath) {
  if (dirent.isDirectory()) return true;
  if (dirent.isSymbolicLink()) {
    try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
  }
  return false;
}

/* ── veto list ───────────────────────────────────────────────────────────── */

function loadVeto() {
  try {
    const parsed = JSON.parse(stripJunk(fs.readFileSync(VETO_PATH, 'utf8')));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s) => typeof s === 'string' && s.length > 0);
  } catch {
    return [];
  }
}

function saveVeto(list) {
  const unique = [...new Set((list || []).filter((s) => typeof s === 'string' && s))];
  writeJsonAtomic(VETO_PATH, unique);
  return unique;
}

const vetoKey = (rel) => String(rel).replace(/\//g, '\\').toLowerCase();

function isVetoed(rel, list) {
  const k = vetoKey(rel);
  return list.some((v) => vetoKey(v) === k);
}

function setVeto(rel, vetoed) {
  const list = loadVeto();
  const k = vetoKey(rel);
  const without = list.filter((v) => vetoKey(v) !== k);
  return saveVeto(vetoed ? [...without, rel] : without);
}

/* ── source discovery (SC2 install -> buildable dev folders) ─────────────── */

// Returns the .SC2Map / .SC2Mod *directories* under the SC2 install that this
// pipeline packages. Vetoed entries are returned too, flagged — the old script
// filtered them out entirely so they could never be un-vetoed from the UI.
function discoverSources(sc2Root) {
  const veto = loadVeto();
  const out = [];
  const missingRoots = [];

  for (const root of SOURCE_ROOTS) {
    const full = path.join(sc2Root, root.rel);
    if (!fs.existsSync(full)) { missingRoots.push(root.rel); continue; }

    if (root.mode === 'single') {
      if (fs.statSync(full).isDirectory()) out.push(makeSource(root.rel, full, veto));
      continue;
    }
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const child = path.join(full, entry.name);
      if (!isDirEntry(entry, child)) continue;
      if (!entry.name.toLowerCase().endsWith(root.ext.toLowerCase())) continue;
      out.push(makeSource(path.join(root.rel, entry.name), child, veto));
    }
  }
  return { sources: out, missingRoots };
}

function makeSource(relPath, sourceDir, veto) {
  const rel = relPath.replace(/\//g, '\\');
  let fileCount = 0;
  try { fileCount = countFiles(sourceDir); } catch {}
  return {
    relPath: rel,
    name: path.basename(rel),
    sourceDir,
    fileCount,
    inPayload:     fs.existsSync(path.join(PAYLOAD_DIR, rel)),
    inBetapayload: fs.existsSync(path.join(BETA_DIR, rel)),
    vetoed:        isVetoed(rel, veto),
  };
}

// Counts files the way MPQEditor's /r will see them — following junctions,
// with a realpath guard so a cyclic link can't spin forever.
function countFiles(dir, seen = new Set()) {
  let real;
  try { real = fs.realpathSync(dir).toLowerCase(); } catch { return 0; }
  if (seen.has(real)) return 0;
  seen.add(real);

  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (isDirEntry(e, full)) n += countFiles(full, seen);
    else n++;
  }
  return n;
}

/* ── payload scanning (built archives -> manifest entries) ───────────────── */

function walkArchives(dir, base = dir, acc = [], seen = new Set()) {
  if (!fs.existsSync(dir)) return acc;
  let real;
  try { real = fs.realpathSync(dir).toLowerCase(); } catch { return acc; }
  if (seen.has(real)) return acc;
  seen.add(real);

  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const isSc2Name = SC2_EXTS.some((ext) => e.name.toLowerCase().endsWith(ext.toLowerCase()));
    if (isDirEntry(e, full)) {
      // A dev folder (SCEvo_Core.SC2Mod as a directory) is a source, not a
      // built archive — don't emit it as a manifest entry.
      if (isSc2Name) continue;
      walkArchives(full, base, acc, seen);
    } else if (isSc2Name) {
      acc.push({ abs: full, rel: path.relative(base, full) });
    }
  }
  return acc;
}

// Hashes every built archive under payload/ (or betapayload/) and returns
// manifest-shaped entries. Hashing is cache-backed, so a rescan is near-free.
async function scanPayload(branch, onProgress) {
  const root = branch === 'beta' ? BETA_DIR : PAYLOAD_DIR;
  const found = walkArchives(root);
  const out = [];
  let done = 0;
  for (const f of found) {
    if (onProgress) onProgress({ phase: 'hashing', file: path.basename(f.abs), done, total: found.length });
    const { hash, size, cached } = await hashOf(f.abs);
    out.push({
      name: path.basename(f.abs),
      path: normalizeManifestPath(f.rel),
      size, hash, abs: f.abs, cached,
    });
    done++;
  }
  if (onProgress) onProgress({ phase: 'done', done, total: found.length });
  // Stable order so a rescan never reshuffles anything downstream.
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/* ── beta <-> public promotion ───────────────────────────────────────────── */

// Copies a built archive between betapayload/ and payload/. The manifest side
// of the promotion is handled by the caller so both halves stay in one action.
function promoteFile(manifestPath, direction) {
  const rel = manifestPath.replace(/\//g, path.sep);
  const from = path.join(direction === 'toPublic' ? BETA_DIR : PAYLOAD_DIR, rel);
  const to   = path.join(direction === 'toPublic' ? PAYLOAD_DIR : BETA_DIR, rel);
  if (!fs.existsSync(from)) throw new Error(`Source file not found: ${from}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  return { from, to, size: fs.statSync(to).size };
}

module.exports = {
  loadVeto, saveVeto, setVeto, isVetoed,
  discoverSources, scanPayload, walkArchives, promoteFile, countFiles,
  SC2_EXTS,
};
