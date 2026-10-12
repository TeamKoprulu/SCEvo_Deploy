'use strict';
// Payload scanning helpers. Source discovery and ignore decisions live in
// catalog.js (deploy-catalog.json).

const fs = require('node:fs');
const path = require('node:path');
const { PAYLOAD_DIR, BETA_DIR } = require('./config');
const { hashOf } = require('./hashcache');
const { normalizeManifestPath } = require('./manifest');

const SC2_EXTS = ['.SC2Mod', '.SC2Map'];

// readdir reports a Windows junction as a symlink, NOT a directory, so a plain
// dirent.isDirectory() check silently skips it. The SC2 install uses junctions
// heavily, so follow them.
function isDirEntry(dirent, fullPath) {
  if (dirent.isDirectory()) return true;
  if (dirent.isSymbolicLink()) {
    try { return fs.statSync(fullPath).isDirectory(); } catch { return false; }
  }
  return false;
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
    out.push({ name: path.basename(f.abs), path: normalizeManifestPath(f.rel), size, hash, abs: f.abs, cached });
    done++;
  }
  if (onProgress) onProgress({ phase: 'done', done, total: found.length });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

module.exports = { scanPayload, walkArchives, countFiles, isDirEntry, SC2_EXTS };
