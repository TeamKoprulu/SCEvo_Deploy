'use strict';
// Persistent SHA-256 cache keyed on path + size + mtime.
//
// The old build-manifests.ps1 re-hashed all 1.1 GB on every run, including both
// ~500 MB assets, even when one small map changed. Verify, preflight and drift
// detection all call into this, so it has to be cheap.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CACHE_DIR, ensureCacheDir, writeJsonAtomic } = require('./config');

const CACHE_FILE = path.join(CACHE_DIR, 'hashes.json');

let cache = null;
let dirty = false;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (!cache || typeof cache !== 'object') cache = {};
  } catch {
    cache = {};
  }
  return cache;
}

function flush() {
  if (!dirty) return;
  ensureCacheDir();
  writeJsonAtomic(CACHE_FILE, load());
  dirty = false;
}

function keyFor(absPath, stat) {
  return `${absPath.toLowerCase()}|${stat.size}|${Math.round(stat.mtimeMs)}`;
}

function hashFileStream(absPath, onProgress) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const stream = fs.createReadStream(absPath, { highWaterMark: 1 << 20 });
    let read = 0;
    stream.on('data', (chunk) => {
      h.update(chunk);
      read += chunk.length;
      if (onProgress) onProgress(read);
    });
    stream.on('end', () => resolve(h.digest('hex')));
    stream.on('error', reject);
  });
}

// Returns { hash, size, mtimeMs, cached } for a file, hashing only on a miss.
async function hashOf(absPath, onProgress) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) throw new Error(`Is a directory: ${absPath}`);
  const c = load();
  const key = keyFor(absPath, stat);
  if (c[key]) {
    return { hash: c[key], size: stat.size, mtimeMs: stat.mtimeMs, cached: true };
  }
  const hash = await hashFileStream(absPath, onProgress);
  c[key] = hash;
  dirty = true;
  return { hash, size: stat.size, mtimeMs: stat.mtimeMs, cached: false };
}

// Drops entries whose file no longer exists or whose stat has moved on.
function prune() {
  const c = load();
  let removed = 0;
  for (const key of Object.keys(c)) {
    const [p, size, mtime] = key.split('|');
    try {
      const st = fs.statSync(p);
      if (st.size !== Number(size) || Math.round(st.mtimeMs) !== Number(mtime)) {
        delete c[key]; removed++;
      }
    } catch {
      delete c[key]; removed++;
    }
  }
  if (removed) { dirty = true; flush(); }
  return removed;
}

function stats() {
  return { entries: Object.keys(load()).length, file: CACHE_FILE };
}

module.exports = { hashOf, hashFileStream, flush, prune, stats };
