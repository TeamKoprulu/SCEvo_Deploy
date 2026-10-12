'use strict';
// Map metadata + thumbnails for the Catalog tab, read straight from the SC2
// install (folder or packed map) and cached by source fingerprint, so the map
// cards don't re-read 50 maps on every visit.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CACHE_DIR, ensureCacheDir, writeJsonAtomic } = require('./config');
const { readMapMeta } = require('./mapmeta');
const { fingerprint } = require('./build');

const META_FILE = path.join(CACHE_DIR, 'mapmeta.json');
const THUMB_DIR = path.join(CACHE_DIR, 'thumbs');

let cache = null;
const load = () => { if (cache) return cache; try { cache = JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { cache = {}; } return cache; };
const flush = () => { ensureCacheDir(); writeJsonAtomic(META_FILE, load()); };
const thumbFile = (key) => path.join(THUMB_DIR, `${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}.png`);

// abs: map in the SC2 install. Returns metadata (no thumbnail bytes) or { error }.
function metaFor(abs, sc2Root) {
  const c = load();
  let fp;
  try { fp = fingerprint(abs); } catch (err) { return { error: err.message }; }
  const key = abs.toLowerCase();
  if (c[key] && c[key].fp === fp) return c[key].meta;
  let meta;
  try {
    const { thumbnail, ...rest } = readMapMeta(abs, { sc2Root, thumbnailSize: 160 });
    meta = rest;
    fs.mkdirSync(THUMB_DIR, { recursive: true });
    if (thumbnail) fs.writeFileSync(thumbFile(key), thumbnail);
  } catch (err) {
    meta = { error: err.message };
  }
  c[key] = { fp, meta };
  flush();
  return meta;
}

function thumbFor(abs, sc2Root) {
  metaFor(abs, sc2Root);
  const f = thumbFile(abs.toLowerCase());
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}

module.exports = { metaFor, thumbFor };
